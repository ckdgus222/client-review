import { execFile, type ExecFileException } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const repositoryDirectory = path.resolve(import.meta.dirname, '../..');
const toolsImage = 'client-review-deploy-tools';
const execFileAsync = promisify(execFile);

type CommandResult = { code: number; stdout: string; stderr: string };
type Deployment = { directory: string; projectName: string };

// 종료 코드 1도 검사할 수 있게 명령 실패를 결과로 돌려준다.
const runCommand = async (args: string[], timeout = 60_000): Promise<CommandResult> => {
  try {
    const result = await execFileAsync('docker', args, {
      encoding: 'utf8',
      timeout,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { code: 0, ...result };
  } catch (error) {
    const failure = error as ExecFileException & { stdout: string; stderr: string };
    if (typeof failure.code !== 'number' || failure.killed) throw error;
    return { code: failure.code, stdout: failure.stdout, stderr: failure.stderr };
  }
};

const runInTools = (
  deployment: Deployment,
  args: string[],
  timeout?: number,
  environment: Record<string, string> = {},
  containerName?: string,
) =>
  runCommand(
    [
      'run',
      '--rm',
      ...(containerName ? ['--name', containerName] : []),
      '-v',
      '/var/run/docker.sock:/var/run/docker.sock',
      '-v',
      `${repositoryDirectory}:/repo:ro`,
      '-v',
      `${deployment.directory}:/work`,
      '-w',
      '/work',
      '-e',
      `COMPOSE_PROJECT_NAME=${deployment.projectName}`,
      '-e',
      'COMPOSE_FILE=/repo/deploy/test/compose.e2e.yml',
      '-e',
      'HEALTH_WAIT_SECONDS=10',
      ...Object.entries({
        BACKUP_DIR: '/work/backups',
        BACKUP_REMOTE: ':local:/work/remote',
        BACKUP_PASSPHRASE_FILE: '/work/passphrase',
        ...environment,
      }).flatMap(([name, value]) => ['-e', `${name}=${value}`]),
      toolsImage,
      ...args,
    ],
    timeout,
  );

const runCompose = (deployment: Deployment, args: string[], timeout?: number) =>
  runInTools(deployment, ['docker', 'compose', ...args], timeout);

const getHealth = (deployment: Deployment) =>
  runCompose(deployment, ['exec', '-T', 'nginx', 'wget', '-qO-', '-T', '5', 'http://127.0.0.1/api/health']);

const waitForHealthyApi = async (deployment: Deployment) => {
  const deadline = Date.now() + 60_000;
  let health: CommandResult;
  do {
    health = await getHealth(deployment);
    if (health.code === 0 && health.stdout.trim() === '{"status":"ok"}') return;
    await delay(1_000);
  } while (Date.now() < deadline);
  throw new Error(`nginx를 거친 api가 준비되지 않았어요: ${JSON.stringify(health)}`);
};

const runningServices = async (deployment: Deployment) => {
  const result = await runCompose(deployment, ['ps', '--status', 'running', '--services']);
  expect(result, '실행 중인 서비스 조회').toMatchObject({ code: 0 });
  return result.stdout.trim().split(/\s+/).filter(Boolean).sort();
};

const expectBackupAlert = (result: CommandResult, message: string) => {
  expect(result).toMatchObject({ code: 1 });
  // stderr의 실패 안내만으로는 메일 발송을 확인할 수 없다. log 발송기의 본문까지 본다.
  const lines = `${result.stdout}\n${result.stderr}`.split(/\r?\n/);
  const subjectLine = lines.findIndex((line) =>
    line.includes('[Client Review 알림] 운영 알림 → developer@example.com'),
  );
  expect(subjectLine, '개발자에게 보낸 운영 알림 메일').toBeGreaterThanOrEqual(0);
  expect(lines[subjectLine + 1]).toContain(message);
};

const expectSuccessfulBackup = async (deployment: Deployment, result: CommandResult) => {
  expect(result).toMatchObject({ code: 0 });
  const completed = result.stdout.match(
    /백업을 마쳤어요: \/work\/backups\/(client-review-\d{8}T\d{6}Z\.tar\.gpg) \(기준 시각 (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\)/,
  );
  expect(completed, '백업 파일 이름과 소수점 여섯 자리 UTC 기준 시각').not.toBeNull();
  const [, filename, snapshotTime] = completed!;
  const localBackup = await readFile(path.join(deployment.directory, 'backups', filename));
  expect(localBackup.length).toBeGreaterThan(0);
  expect(await readFile(path.join(deployment.directory, 'remote', filename))).toEqual(localBackup);
  expect(
    (await readdir(path.join(deployment.directory, 'backups'))).filter((name) => name.endsWith('.partial')),
  ).toEqual([]);
  await expect(stat(path.join(deployment.directory, '.backup-stopped-api'))).rejects.toMatchObject({ code: 'ENOENT' });
  return { filename, snapshotTime };
};

const seedOldBackups = async (deployment: Deployment) => {
  const hour = 60 * 60 * 1_000;
  const now = Date.now();
  const ages = [
    ['client-review-old.tar.gpg', 15 * 24 * hour],
    ['client-review-just-expired.tar.gpg', 14 * 24 * hour + 60_000],
    ['client-review-young.tar.gpg', 13 * 24 * hour],
    ['client-review-almost-14-days.tar.gpg', (13 * 24 + 23) * hour],
    ['other-file.txt', 15 * 24 * hour],
  ] as const;
  for (const directory of ['backups', 'remote']) {
    for (const [filename, age] of ages) {
      const file = path.join(deployment.directory, directory, filename);
      await writeFile(file, filename);
      const modifiedAt = new Date(now - age);
      await utimes(file, modifiedAt, modifiedAt);
    }
  }
};

describe('백업과 복원 (e2e)', () => {
  let deployment: Deployment | undefined;

  beforeAll(async () => {
    const build = await runCommand(
      ['build', '-q', '-t', toolsImage, path.join(repositoryDirectory, 'deploy/test')],
      540_000,
    );
    expect(build, '운영 스크립트 도구 이미지 빌드').toMatchObject({ code: 0 });
  }, 600_000);

  beforeEach(async () => {
    deployment = {
      directory: await mkdtemp(path.join(tmpdir(), 'cr-ops-')),
      projectName: `cr-ops-${randomUUID().slice(0, 8)}`,
    };
    await cp(path.join(repositoryDirectory, 'deploy'), path.join(deployment.directory, 'deploy'), {
      recursive: true,
    });
    await mkdir(path.join(deployment.directory, 'backups'));
    await mkdir(path.join(deployment.directory, 'remote'));
    await writeFile(path.join(deployment.directory, 'passphrase'), randomUUID(), { mode: 0o600 });
    const up = await runCompose(deployment, ['up', '-d', '--build'], 480_000);
    expect(up, '테스트 전용 db·api·nginx 시작').toMatchObject({ code: 0 });
    await waitForHealthyApi(deployment);
  }, 600_000);

  afterEach(async () => {
    if (!deployment) return;
    try {
      const down = await runCompose(deployment, ['down', '-v', '--remove-orphans'], 90_000);
      expect(down, '테스트 전용 컨테이너와 볼륨 정리').toMatchObject({ code: 0 });
    } finally {
      await rm(deployment.directory, { recursive: true, force: true });
      deployment = undefined;
    }
  }, 120_000);

  it('백업이 중간에 실패하면 api가 다시 켜지고 알림 메일이 간다', async () => {
    const current = deployment!;
    expect(await runCompose(current, ['stop', 'db'])).toMatchObject({ code: 0 });
    expect(await runningServices(current)).toEqual(['api', 'nginx']);

    const backup = await runInTools(current, ['/work/deploy/backup.sh'], 120_000);

    expectBackupAlert(backup, '백업 실패: 서버에서 deploy/backup.sh 를 돌려 원인을 확인해 주세요');
    expect(await readdir(path.join(current.directory, 'backups'))).toEqual([]);
    expect(await readdir(path.join(current.directory, 'remote'))).toEqual([]);
    await expect(stat(path.join(current.directory, '.backup-stopped-api'))).rejects.toMatchObject({ code: 'ENOENT' });
    await waitForHealthyApi(current);
    expect(await runningServices(current)).toEqual(['api', 'db', 'nginx']);
  }, 240_000);

  it('켤 때 백업은 db가 늦게 준비돼도 기다렸다가 백업한다', async () => {
    const current = deployment!;
    expect(await runCompose(current, ['stop', 'db', 'api'])).toMatchObject({ code: 0 });
    let finished = false;
    const pendingBackup = runInTools(current, ['/work/deploy/backup.sh', '--wait-ready'], 120_000, {
      BACKUP_WAIT_SECONDS: '60',
    }).finally(() => {
      finished = true;
    });

    // 명령을 기다리는 동안 실제 db를 뒤늦게 켠다. 실패해도 백업 종료 후 정리한다.
    try {
      await delay(3_000);
      expect(finished, 'db가 준비되기 전에 백업이 끝나면 안 된다').toBe(false);
      expect(await readdir(path.join(current.directory, 'backups'))).toEqual([]);
      expect(await runningServices(current)).toEqual(['nginx']);
      expect(await runCompose(current, ['start', 'db'])).toMatchObject({ code: 0 });
      await expectSuccessfulBackup(current, await pendingBackup);
      expect(await runningServices(current)).toEqual(['db', 'nginx']);
    } finally {
      await pendingBackup;
    }
  }, 240_000);

  it('켤 때 백업은 db가 끝내 준비되지 않으면 실패하고 알림 메일이 간다', async () => {
    const current = deployment!;
    expect(await runCompose(current, ['stop', 'db', 'api'])).toMatchObject({ code: 0 });
    const startedAt = Date.now();

    const backup = await runInTools(current, ['/work/deploy/backup.sh', '--wait-ready'], 60_000, {
      BACKUP_WAIT_SECONDS: '8',
    });

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(8_000);
    expectBackupAlert(backup, '백업 실패: db가 준비되지 않았어요');
    expect(await readdir(path.join(current.directory, 'backups'))).toEqual([]);
    expect(await readdir(path.join(current.directory, 'remote'))).toEqual([]);
    expect(await runningServices(current)).toEqual(['nginx']);
    await expect(stat(path.join(current.directory, '.backup-stopped-api'))).rejects.toMatchObject({ code: 'ENOENT' });
    const lock = await runInTools(current, ['flock', '-n', '/work/.maintenance.lock', 'true']);
    expect(lock, '준비 대기가 실패한 뒤에도 다른 스크립트가 잠금을 잡을 수 있다').toMatchObject({ code: 0 });
  }, 120_000);

  it('백업이 api를 멈춘 채 끊기면 다음 백업이 api를 켜고 백업한다', async () => {
    const current = deployment!;
    expect(await runCompose(current, ['stop', 'api'])).toMatchObject({ code: 0 });
    await writeFile(path.join(current.directory, '.backup-stopped-api'), '');

    const backup = await runInTools(current, ['/work/deploy/backup.sh'], 120_000);

    expect(backup.stdout).toContain('지난 백업이 api를 멈춘 채 끊겼어요');
    await expectSuccessfulBackup(current, backup);
    await waitForHealthyApi(current);
    expect(await runningServices(current)).toEqual(['api', 'db', 'nginx']);
  }, 240_000);

  it('백업이 강제로 끊겨 남은 암호화 전 재료는 다음 백업이 지운다', async () => {
    const current = deployment!;
    const containerName = `cr-backup-${randomUUID()}`;
    const workDirectory = path.join(current.directory, '.backup-work');
    const dumpFile = path.join(workDirectory, 'db.dump');
    expect(await runningServices(current)).toEqual(['api', 'db', 'nginx']);

    const pendingBackup = runInTools(current, ['/work/deploy/backup.sh'], 120_000, {}, containerName);
    try {
      // 맥에서 DB 덤프가 쓰인 순간을 잡아 EXIT 정리가 실행되지 않는 SIGKILL로 끊는다.
      await expect
        .poll(async () => (await stat(dumpFile)).size, {
          timeout: 60_000,
          interval: 20,
        })
        .toBeGreaterThan(0);
      expect(await runCommand(['kill', containerName])).toMatchObject({ code: 0 });

      const interruptedBackup = await pendingBackup;
      expect(interruptedBackup).toMatchObject({ code: 137 });
      expect((await stat(workDirectory)).isDirectory()).toBe(true);
      expect((await stat(dumpFile)).size).toBeGreaterThan(0);
      expect(
        (await readdir(path.join(current.directory, 'backups'))).filter((name) => name.endsWith('.tar.gpg')),
      ).toEqual([]);
      expect((await stat(path.join(current.directory, '.backup-stopped-api'))).isFile()).toBe(true);
      expect(await runningServices(current)).toEqual(['db', 'nginx']);

      const backup = await runInTools(current, ['/work/deploy/backup.sh'], 120_000);

      await expectSuccessfulBackup(current, backup);
      await expect(stat(workDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
      await waitForHealthyApi(current);
      expect(await runningServices(current)).toEqual(['api', 'db', 'nginx']);

      // 점검 표시 때문에 일찍 끝날 때도 남은 암호화 전 재료부터 지운다.
      await mkdir(workDirectory);
      await writeFile(dumpFile, 'unfinished database dump');
      const marker = path.join(current.directory, '.maintenance');
      await writeFile(marker, 'manual');

      const maintenanceBackup = await runInTools(current, ['/work/deploy/backup.sh'], 60_000);

      expectBackupAlert(maintenanceBackup, '백업 실패: 점검 중이라 백업하지 않았어요');
      await expect(stat(workDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(marker, 'utf8')).toBe('manual');
    } finally {
      // 폴링이나 검증이 실패해도 도구 컨테이너를 끝내고, compose의 잔여물은 afterEach에서 정리한다.
      await runCommand(['rm', '-f', containerName]);
      await pendingBackup;
    }
  }, 300_000);

  it('시작할 때 멈춰 있던 api는 백업 뒤에도 멈춰 있다', async () => {
    const current = deployment!;
    expect(await runCompose(current, ['stop', 'api'])).toMatchObject({ code: 0 });

    const backup = await runInTools(current, ['/work/deploy/backup.sh'], 120_000);

    const { filename, snapshotTime } = await expectSuccessfulBackup(current, backup);
    expect(await runningServices(current)).toEqual(['db', 'nginx']);
    expect((await getHealth(current)).code).not.toBe(0);

    // 도구 컨테이너에서 실제 암호를 풀어 세 재료와 DB 기준 시각을 확인한다.
    const archive = await runInTools(current, [
      'bash',
      '-o',
      'pipefail',
      '-c',
      'gpg --batch --pinentry-mode loopback --passphrase-file /work/passphrase -d "$1" | tar -tf -',
      'bash',
      `/work/backups/${filename}`,
    ]);
    expect(archive).toMatchObject({ code: 0 });
    expect(archive.stdout.trim().split('\n').sort()).toEqual(['assets.tar', 'db.dump', 'snapshot-time.txt']);
    const snapshot = await runInTools(current, [
      'bash',
      '-o',
      'pipefail',
      '-c',
      'gpg --batch --pinentry-mode loopback --passphrase-file /work/passphrase -d "$1" | tar -xOf - snapshot-time.txt',
      'bash',
      `/work/backups/${filename}`,
    ]);
    expect(snapshot).toMatchObject({ code: 0 });
    expect(snapshot.stdout.trim()).toBe(snapshotTime);

    await writeFile(path.join(current.directory, 'wrong-passphrase'), randomUUID(), { mode: 0o600 });
    const wrongPassphrase = await runInTools(current, [
      'gpg',
      '--batch',
      '--pinentry-mode',
      'loopback',
      '--passphrase-file',
      '/work/wrong-passphrase',
      '-d',
      `/work/backups/${filename}`,
    ]);
    expect(wrongPassphrase.code).not.toBe(0);
    expect(wrongPassphrase.stdout).toBe('');
  }, 240_000);

  it('14일 지난 백업은 서버와 바깥 보관 곳에서 지우고 그 안의 것은 남긴다', async () => {
    const current = deployment!;
    await seedOldBackups(current);

    const backup = await runInTools(current, ['/work/deploy/backup.sh'], 120_000);

    const { filename } = await expectSuccessfulBackup(current, backup);
    const retained = ['client-review-young.tar.gpg', 'client-review-almost-14-days.tar.gpg', 'other-file.txt'];
    for (const directory of ['backups', 'remote']) {
      expect((await readdir(path.join(current.directory, directory))).sort()).toEqual([...retained, filename].sort());
      for (const name of retained) {
        expect(await readFile(path.join(current.directory, directory, name), 'utf8')).toBe(name);
      }
    }
    await waitForHealthyApi(current);
    expect(await runningServices(current)).toEqual(['api', 'db', 'nginx']);
  }, 240_000);

  it('올리기가 실패해도 14일 지난 서버 백업은 지우고 그 안의 것은 남기며 알림 메일이 간다', async () => {
    const current = deployment!;
    await seedOldBackups(current);

    const backup = await runInTools(current, ['/work/deploy/backup.sh'], 120_000, {
      BACKUP_REMOTE: 'nosuchremote:dir',
    });

    expectBackupAlert(backup, '백업 실패: 서버에서 deploy/backup.sh 를 돌려 원인을 확인해 주세요');
    expect(`${backup.stdout}\n${backup.stderr}`).toContain('서버 밖의 14일 지난 백업을 지우지 못했어요');
    const retained = ['client-review-young.tar.gpg', 'client-review-almost-14-days.tar.gpg', 'other-file.txt'];
    const files = await readdir(path.join(current.directory, 'backups'));
    const created = files.filter((name) => !retained.includes(name));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatch(/^client-review-\d{8}T\d{6}Z\.tar\.gpg$/);
    expect((await stat(path.join(current.directory, 'backups', created[0]))).size).toBeGreaterThan(0);
    for (const name of retained) {
      expect(await readFile(path.join(current.directory, 'backups', name), 'utf8')).toBe(name);
    }
    await expect(stat(path.join(current.directory, '.backup-stopped-api'))).rejects.toMatchObject({ code: 'ENOENT' });
    await waitForHealthyApi(current);
    expect(await runningServices(current)).toEqual(['api', 'db', 'nginx']);
  }, 240_000);

  it('점검 표시가 있으면 백업과 업데이트는 아무것도 하지 않고 api도 켜지 않는다', async () => {
    const current = deployment!;
    expect(await runCompose(current, ['stop', 'api'])).toMatchObject({ code: 0 });
    const marker = path.join(current.directory, '.maintenance');
    const stoppedNote = path.join(current.directory, '.backup-stopped-api');
    // 지난 백업의 메모가 있어도 점검 표시가 우선이다.
    await writeFile(stoppedNote, '');

    for (const reason of ['manual', 'restore in-progress', 'restore done', 'update']) {
      await writeFile(marker, reason);
      for (const args of [[], ['--wait-ready']]) {
        const backup = await runInTools(current, ['/work/deploy/backup.sh', ...args], 60_000, {
          BACKUP_WAIT_SECONDS: '8',
        });
        expectBackupAlert(backup, '백업 실패: 점검 중이라 백업하지 않았어요');
        expect(`${backup.stdout}\n${backup.stderr}`).toContain(
          `백업 실패: 점검 중이라 백업하지 않았어요(표시: ${reason})`,
        );
        expect(await readFile(marker, 'utf8')).toBe(reason);
        expect(await readFile(stoppedNote, 'utf8')).toBe('');
        expect(await readdir(path.join(current.directory, 'backups'))).toEqual([]);
        expect(await readdir(path.join(current.directory, 'remote'))).toEqual([]);
        expect(await runningServices(current)).toEqual(['db', 'nginx']);
      }
    }
    // 업데이트 쪽은 조각 5에서 이 테스트에 더한다.
  }, 300_000);

  it('손작업 end가 api를 켜지 못하면 표시가 남고 다시 end하면 켜진다', async () => {
    const current = deployment!;
    const marker = path.join(current.directory, '.maintenance');
    expect(await runningServices(current)).toEqual(['api', 'db', 'nginx']);

    const start = await runInTools(current, ['/work/deploy/maintenance.sh', 'start']);
    expect(start).toMatchObject({ code: 0 });
    expect((await readFile(marker, 'utf8')).trim()).toBe('manual');
    expect(await runningServices(current)).toEqual(['db', 'nginx']);

    const duplicateStart = await runInTools(current, ['/work/deploy/maintenance.sh', 'start']);
    expect(duplicateStart).toMatchObject({ code: 1 });
    expect((await readFile(marker, 'utf8')).trim()).toBe('manual');
    expect(await runningServices(current)).toEqual(['db', 'nginx']);

    // db를 멈추면 compose start api가 함께 켜므로 인증 실패로 api 시작을 막는다.
    const breakDatabaseLogin = await runCompose(current, [
      'exec',
      '-T',
      'db',
      'psql',
      '-U',
      'client_review',
      '-d',
      'client_review',
      '-c',
      "ALTER USER client_review PASSWORD 'broken'",
    ]);
    expect(breakDatabaseLogin).toMatchObject({ code: 0 });

    const failedEnd = await runInTools(current, ['/work/deploy/maintenance.sh', 'end']);
    expect(failedEnd).toMatchObject({ code: 1 });
    expect(failedEnd.stderr).toContain('api가 응답하지 않아요');
    expect((await readFile(marker, 'utf8')).trim()).toBe('manual');
    expect((await getHealth(current)).code).not.toBe(0);
    // api가 완전히 꺼진 뒤에 고친다. 켜지는 중에 고치면 다시 end하기 전에 api가 저절로 떠서,
    // end가 api를 켜고 응답을 기다리는지 확인하지 못한다.
    await expect.poll(() => runningServices(current), { timeout: 30_000, interval: 1_000 }).toEqual(['db', 'nginx']);

    const repairDatabaseLogin = await runCompose(current, [
      'exec',
      '-T',
      'db',
      'psql',
      '-U',
      'client_review',
      '-d',
      'client_review',
      '-c',
      "ALTER USER client_review PASSWORD 'e2e'",
    ]);
    expect(repairDatabaseLogin).toMatchObject({ code: 0 });

    const retriedEnd = await runInTools(current, ['/work/deploy/maintenance.sh', 'end']);
    expect(retriedEnd).toMatchObject({ code: 0 });
    await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await runningServices(current)).toEqual(['api', 'db', 'nginx']);
    const healthy = await getHealth(current);
    expect(healthy).toMatchObject({ code: 0 });
    expect(JSON.parse(healthy.stdout)).toEqual({ status: 'ok' });

    // 표시 없는 end가 멈춘 api를 임의로 켜지 않는지도 같은 흐름에서 확인한다.
    expect(await runCompose(current, ['stop', 'api'])).toMatchObject({ code: 0 });
    const endWithoutMarker = await runInTools(current, ['/work/deploy/maintenance.sh', 'end']);
    expect(endWithoutMarker).toMatchObject({ code: 1 });
    await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await runningServices(current)).toEqual(['db', 'nginx']);
  }, 300_000);
});
