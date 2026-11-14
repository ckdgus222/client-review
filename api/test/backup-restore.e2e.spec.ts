import { execFile, type ExecFileException } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const repositoryDirectory = path.resolve(import.meta.dirname, '../..');
const toolsImage = 'client-review-deploy-tools';
const execFileAsync = promisify(execFile);

type CommandResult = { code: number; stdout: string; stderr: string };
type Deployment = {
  directory: string;
  projectName: string;
  workdir: string;
  composeFile: string;
};

// git 쓰기는 테스트가 만든 임시 저장소에서만 한다. 사용자의 커밋 훅은 실행하지 않는다.
const runGit = async (directory: string, args: string[]) => {
  const result = await execFileAsync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: directory,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return result.stdout.trim();
};

// 종료 코드 1도 검사할 수 있게 명령 실패를 결과로 돌려준다.
const runCommand = async (args: string[], timeout = 60_000, input?: string): Promise<CommandResult> => {
  try {
    const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const child = execFile(
        'docker',
        args,
        {
          encoding: 'utf8',
          timeout,
          maxBuffer: 10 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (error) return reject(Object.assign(error, { stdout, stderr }));
          resolve({ stdout, stderr });
        },
      );
      child.stdin!.on('error', (error: NodeJS.ErrnoException) => {
        // 잠금 충돌처럼 입력을 읽기 전에 끝나도 명령의 종료 코드를 검사한다.
        if (error.code !== 'EPIPE') reject(error);
      });
      child.stdin!.end(input);
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
  input?: string,
) =>
  runCommand(
    [
      'run',
      '--rm',
      ...(input === undefined ? [] : ['-i']),
      ...(containerName ? ['--name', containerName] : []),
      '-v',
      '/var/run/docker.sock:/var/run/docker.sock',
      '-v',
      `${repositoryDirectory}:/repo:ro`,
      '-v',
      `${deployment.directory}:/work`,
      '-w',
      deployment.workdir,
      '-e',
      `COMPOSE_PROJECT_NAME=${deployment.projectName}`,
      '-e',
      `COMPOSE_FILE=${deployment.composeFile}`,
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
    input,
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

const prepareDeployment = async (deployment: Deployment, cloneRepository = false) => {
  if (cloneRepository) {
    const clone = path.join(deployment.directory, 'clone');
    // 같은 디스크의 저장소를 복제하면 git이 개체 파일을 하드링크로 나눠 쓴다. 테스트가 프로젝트 저장소의 개체 파일을
    // 건드리지 않고, 도구 컨테이너가 그 파일을 못 열어 pull이 실패하지 않게 모두 복사한다.
    await runGit(deployment.directory, ['clone', '-q', '--no-hardlinks', repositoryDirectory, 'clone']);
    await cp(path.join(repositoryDirectory, 'deploy'), path.join(clone, 'deploy'), { recursive: true });
    await runGit(clone, ['add', '-A']);
    const changes = await runGit(clone, ['diff', '--cached', '--name-only']);
    if (changes) {
      await runGit(clone, [
        '-c',
        'user.name=test',
        '-c',
        'user.email=test@example.com',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-qm',
        'overlay',
      ]);
    }
    await runGit(deployment.directory, ['clone', '-q', '--no-hardlinks', '--bare', 'clone', 'remote.git']);
    await runGit(clone, ['remote', 'set-url', 'origin', '/work/remote.git']);
    await runGit(deployment.directory, [
      'clone',
      '-q',
      '--no-hardlinks',
      path.join(deployment.directory, 'remote.git'),
      'pusher',
    ]);
    deployment.workdir = '/work/clone';
    deployment.composeFile = '/work/clone/deploy/test/compose.e2e.yml';
  }
  const up = await runCompose(deployment, ['up', '-d', '--build'], 480_000);
  expect(up, '테스트 전용 db·api·nginx 시작').toMatchObject({ code: 0 });
  await waitForHealthyApi(deployment);
  return deployment;
};

const pushUpdate = async (deployment: Deployment, files: Record<string, string>) => {
  const pusher = path.join(deployment.directory, 'pusher');
  for (const [filename, contents] of Object.entries(files)) {
    await writeFile(path.join(pusher, filename), contents);
  }
  await runGit(pusher, ['add', '-A']);
  await runGit(pusher, [
    '-c',
    'user.name=test',
    '-c',
    'user.email=test@example.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'update fixture',
  ]);
  await runGit(pusher, ['push', '-q', 'origin', 'HEAD']);
};

const runUpdate = (deployment: Deployment, retry = false) =>
  runInTools(deployment, ['/work/clone/deploy/update.sh', ...(retry ? ['--retry'] : [])], 180_000);

const expectSuccessfulUpdate = async (deployment: Deployment, result: CommandResult) => {
  expect(result).toMatchObject({ code: 0 });
  expect(result.stdout.trim().endsWith('업데이트를 마쳤어요')).toBe(true);
  expect(`${result.stdout}\n${result.stderr}`).not.toContain('[Client Review 알림]');
  await expect(stat(path.join(deployment.directory, 'clone/.maintenance'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await runningServices(deployment)).toEqual(['api', 'db', 'nginx']);
  expect(await getHealth(deployment)).toMatchObject({ code: 0, stdout: '{"status":"ok"}' });
  const landing = await runCompose(deployment, ['exec', '-T', 'nginx', 'wget', '-qO-', 'http://127.0.0.1/']);
  expect(landing).toMatchObject({ code: 0 });
  expect(landing.stdout).toContain('<html');
  expect(await runGit(path.join(deployment.directory, 'clone'), ['rev-parse', 'HEAD'])).toBe(
    await runGit(path.join(deployment.directory, 'remote.git'), ['rev-parse', 'HEAD']),
  );
};

const expectOperationalAlert = (result: CommandResult, message: string) => {
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

const runSql = async (deployment: Deployment, sql: string) => {
  const result = await runCompose(deployment, [
    'exec',
    '-T',
    'db',
    'psql',
    '-U',
    'client_review',
    '-d',
    'client_review',
    '-v',
    'ON_ERROR_STOP=1',
    '-At',
    '-c',
    sql,
  ]);
  expect(result, '테스트 전용 DB 준비·조회').toMatchObject({ code: 0 });
  return result.stdout.trim();
};

const createSession = async (deployment: Deployment, userId: string) => {
  const token = randomUUID();
  const hash = createHash('sha256').update(token).digest('hex');
  await runSql(
    deployment,
    `INSERT INTO sessions (user_id, token_hash, expires_at)
    VALUES ('${userId}', '${hash}', now() + interval '1 day')`,
  );
  return `sid=${token}`;
};

const requestApi = async (deployment: Deployment, url: string, cookie = '', body?: Record<string, unknown>) =>
  runCompose(deployment, [
    'exec',
    '-T',
    'nginx',
    'wget',
    '-S',
    '-O',
    '-',
    '-T',
    '10',
    '--header',
    'Origin: http://localhost',
    '--header',
    `Cookie: ${cookie}`,
    ...(body === undefined ? [] : ['--header', 'Content-Type: application/json', '--post-data', JSON.stringify(body)]),
    `http://127.0.0.1${url}`,
  ]);

const seedProjectAndPhoto = async (deployment: Deployment) => {
  const projectId = randomUUID();
  const developerId = randomUUID();
  const assetId = randomUUID();
  const storageKey = `${assetId}.png`;
  const photo = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=';
  await runSql(
    deployment,
    `
    INSERT INTO users (id, email, name) VALUES ('${developerId}', 'developer@example.com', '개발자');
    INSERT INTO projects (id, name) VALUES ('${projectId}', '복원할 프로젝트');
    INSERT INTO project_members (project_id, user_id, role) VALUES ('${projectId}', '${developerId}', 'DEVELOPER');
    INSERT INTO assets (id, project_id, storage_key, mime, bytes, width, height)
      VALUES ('${assetId}', '${projectId}', '${storageKey}', 'image/png', ${Buffer.from(photo, 'base64').length}, 1, 1);
  `,
  );
  expect(
    await runCompose(deployment, [
      'exec',
      '-T',
      'api',
      'sh',
      '-c',
      'printf "%s" "$1" | base64 -d > "/data/assets/$2"',
      'sh',
      photo,
      storageKey,
    ]),
  ).toMatchObject({ code: 0 });
  return { projectId, developerId, storageKey, photo };
};

const readProjectAndPhotos = async (deployment: Deployment) => {
  const rows = await runSql(
    deployment,
    `SELECT json_build_object(
    'projects', (SELECT json_agg(p ORDER BY id) FROM projects p),
    'assets', (SELECT json_agg(a ORDER BY id) FROM assets a))`,
  );
  const photos = await runCompose(deployment, [
    'run',
    '--rm',
    '--no-deps',
    '-T',
    'api',
    'sh',
    '-c',
    'cd /data/assets && find . -type f -exec sha256sum {} \\; | sort',
  ]);
  expect(photos).toMatchObject({ code: 0 });
  return { rows: JSON.parse(rows) as unknown, photos: photos.stdout.trim() };
};

const runRestore = (deployment: Deployment, filename: string, answer = 'restore', environment = {}) =>
  runInTools(
    deployment,
    ['/work/deploy/restore.sh', `/work/backups/${filename}`],
    180_000,
    environment,
    undefined,
    `${answer}\n`,
  );

const expectRestoredAndStopped = async (deployment: Deployment, result: CommandResult, snapshotTime: string) => {
  expect(result).toMatchObject({ code: 0 });
  expect(result.stdout).toContain(`기준 시각: ${snapshotTime}`);
  expect((await readFile(path.join(deployment.directory, '.maintenance'), 'utf8')).trim()).toBe('restore done');
  expect(await runningServices(deployment)).toEqual(['db', 'nginx']);
  expect((await getHealth(deployment)).code).not.toBe(0);
};

const finishRestore = async (deployment: Deployment) => {
  const result = await runInTools(deployment, ['/work/deploy/restore.sh', '--finish']);
  expect(result).toMatchObject({ code: 0 });
  expect(await getHealth(deployment)).toMatchObject({ code: 0, stdout: '{"status":"ok"}' });
  await expect(stat(path.join(deployment.directory, '.maintenance'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await runningServices(deployment)).toEqual(['api', 'db', 'nginx']);
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
      workdir: '/work',
      composeFile: '/repo/deploy/test/compose.e2e.yml',
    };
    await cp(path.join(repositoryDirectory, 'deploy'), path.join(deployment.directory, 'deploy'), {
      recursive: true,
    });
    await mkdir(path.join(deployment.directory, 'backups'));
    await mkdir(path.join(deployment.directory, 'remote'));
    await writeFile(path.join(deployment.directory, 'passphrase'), randomUUID(), { mode: 0o600 });
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

  it('백업한 뒤 빈 묶음에 복원하면 프로젝트와 사진이 그대로다', async () => {
    const source = await prepareDeployment(deployment!);
    await seedProjectAndPhoto(source);
    const before = await readProjectAndPhotos(source);
    const container = await runCompose(source, ['ps', '-q', 'api']);
    expect(container).toMatchObject({ code: 0 });
    const { filename, snapshotTime } = await expectSuccessfulBackup(
      source,
      await runInTools(source, ['/work/deploy/backup.sh'], 120_000),
    );
    const state = await runCommand(['inspect', '--format', '{{json .State}}', container.stdout.trim()]);
    expect(state).toMatchObject({ code: 0 });
    const { FinishedAt, StartedAt } = JSON.parse(state.stdout) as { FinishedAt: string; StartedAt: string };
    // Docker는 나노초, 백업은 마이크로초다. 자릿수를 맞춰 천분의 1초 아래도 비교한다.
    const [stoppedAt, snapshotAt, restartedAt] = [FinishedAt, snapshotTime, StartedAt].map((value) =>
      value.replace(/\.(\d+)Z$/, (_, digits: string) => `.${digits.padEnd(9, '0')}Z`),
    );
    expect(stoppedAt <= snapshotAt, 'api가 멈춘 뒤의 기준 시각').toBe(true);
    expect(snapshotAt <= restartedAt, '기준 시각 뒤에 api를 다시 켠다').toBe(true);
    expect(FinishedAt).not.toMatch(/^0001-/);

    const target: Deployment = {
      directory: await mkdtemp(path.join(tmpdir(), 'cr-restore-')),
      projectName: `cr-restore-${randomUUID().slice(0, 8)}`,
      workdir: '/work',
      composeFile: '/repo/deploy/test/compose.e2e.yml',
    };
    try {
      // 원본 DB·볼륨·설정은 옮기지 않는다. 복구용 파일과 서버 밖 암호 보관본만 옮긴다.
      await mkdir(path.join(target.directory, 'backups'));
      await cp(path.join(source.directory, 'backups', filename), path.join(target.directory, 'backups', filename));
      await cp(path.join(source.directory, 'passphrase'), path.join(target.directory, 'passphrase'));
      await cp(path.join(repositoryDirectory, 'deploy'), path.join(target.directory, 'deploy'), { recursive: true });
      expect(await runCompose(target, ['up', '-d', '--wait', 'db'], 120_000)).toMatchObject({ code: 0 });
      expect(await runCompose(target, ['create', '--no-recreate', 'api'])).toMatchObject({ code: 0 });
      expect(await runCompose(target, ['up', '-d', '--no-deps', 'nginx'])).toMatchObject({ code: 0 });
      expect(await runSql(target, "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")).toBe(
        '0',
      );
      const emptyPhotos = await runCompose(target, [
        'run',
        '--rm',
        '--no-deps',
        '-T',
        'api',
        'find',
        '/data/assets',
        '-type',
        'f',
      ]);
      expect(emptyPhotos).toMatchObject({ code: 0, stdout: '' });

      await expectRestoredAndStopped(target, await runRestore(target, filename), snapshotTime);
      expect(await readProjectAndPhotos(target)).toEqual(before);
      await finishRestore(target);
      expect(await readProjectAndPhotos(target)).toEqual(before);
    } finally {
      const down = await runCompose(target, ['down', '-v', '--remove-orphans'], 90_000);
      await rm(target.directory, { recursive: true, force: true });
      expect(down, '복원 대상 묶음 정리').toMatchObject({ code: 0 });
    }
  }, 600_000);

  it('다른 운영 스크립트가 잠금을 잡고 있으면 백업·업데이트·복원은 바로 실패한다', async () => {
    const current = await prepareDeployment(deployment!);
    await seedProjectAndPhoto(current);
    const before = await readProjectAndPhotos(current);
    const { filename } = await expectSuccessfulBackup(
      current,
      await runInTools(current, ['/work/deploy/backup.sh'], 120_000),
    );
    await waitForHealthyApi(current);
    const marker = path.join(current.directory, '.maintenance');
    await writeFile(marker, 'restore done\n');
    const lockName = `cr-lock-${randomUUID()}`;
    const pendingLock = runInTools(
      current,
      ['bash', '-c', 'exec 9>/work/.maintenance.lock; flock -n 9 || exit 1; touch /work/lock-ready; sleep 120'],
      150_000,
      {},
      lockName,
    );
    try {
      await expect
        .poll(async () => (await stat(path.join(current.directory, 'lock-ready'))).isFile(), {
          timeout: 30_000,
        })
        .toBe(true);
      for (const args of [
        ['/work/deploy/backup.sh'],
        ['/work/deploy/update.sh'],
        ['/work/deploy/restore.sh', `/work/backups/${filename}`],
      ]) {
        const result = await runInTools(current, args, 15_000, {}, undefined, 'restore\n');
        expect(result).toMatchObject({ code: 1 });
        expect(result.stderr).toContain('다른 운영 스크립트');
        expect(await readFile(marker, 'utf8')).toBe('restore done\n');
        expect(await runningServices(current)).toEqual(['api', 'db', 'nginx']);
      }
      expect(await readProjectAndPhotos(current)).toEqual(before);
      expect(await readdir(path.join(current.directory, 'backups'))).toEqual([filename]);
      expect(await getHealth(current)).toMatchObject({ code: 0, stdout: '{"status":"ok"}' });
    } finally {
      await runCommand(['rm', '-f', lockName]);
      await pendingLock;
    }
  }, 360_000);

  it('복원 뒤에는 백업 때의 쿠키와 로그인 코드로 들어갈 수 없다', async () => {
    const current = await prepareDeployment(deployment!);
    const { developerId } = await seedProjectAndPhoto(current);
    const cookie = await createSession(current, developerId);
    expect(await requestApi(current, '/api/auth/me', cookie)).toMatchObject({ code: 0 });
    const codeRequest = await requestApi(current, '/api/auth/email-code', '', {
      email: 'developer@example.com',
      privacyAgreed: true,
    });
    expect(codeRequest.stderr).toMatch(/HTTP\/1\.1 204\b/);
    const logs = await runCompose(current, ['logs', '--no-color', '--no-log-prefix', 'api']);
    expect(logs).toMatchObject({ code: 0 });
    const code = logs.stdout.match(/로그인 코드는 (\d{6})예요/)?.[1];
    expect(code).toMatch(/^\d{6}$/);
    expect(await runSql(current, 'SELECT count(*) FROM sessions')).toBe('1');
    expect(await runSql(current, 'SELECT count(*) FROM login_codes WHERE used_at IS NULL')).toBe('1');
    const { filename, snapshotTime } = await expectSuccessfulBackup(
      current,
      await runInTools(current, ['/work/deploy/backup.sh'], 120_000),
    );
    await waitForHealthyApi(current);
    expect((await requestApi(current, '/api/auth/logout', cookie, {})).stderr).toMatch(/HTTP\/1\.1 204\b/);
    expect(
      (await requestApi(current, '/api/auth/verify-code', '', { email: 'developer@example.com', code })).stderr,
    ).toMatch(/HTTP\/1\.1 200\b/);

    await expectRestoredAndStopped(current, await runRestore(current, filename), snapshotTime);
    expect(await runSql(current, 'SELECT count(*) FROM sessions')).toBe('0');
    expect(await runSql(current, 'SELECT count(*) FROM login_codes')).toBe('0');
    await finishRestore(current);
    expect((await requestApi(current, '/api/auth/me', cookie)).stderr).toMatch(/HTTP\/1\.1 401\b/);
    expect(
      (await requestApi(current, '/api/auth/verify-code', '', { email: 'developer@example.com', code })).stderr,
    ).toMatch(/HTTP\/1\.1 422\b/);
    expect(await runSql(current, 'SELECT count(*) FROM sessions')).toBe('0');
  }, 420_000);

  it('백업을 올리는 동안 생긴 철회도 기준 시각 뒤라서 복원 뒤 다시 적용된다', async () => {
    const current = await prepareDeployment(deployment!);
    const { projectId, developerId } = await seedProjectAndPhoto(current);
    const clientId = randomUUID();
    const memberId = randomUUID();
    await runSql(
      current,
      `
      INSERT INTO users (id, email, name) VALUES ('${clientId}', 'client@example.com', '클라이언트');
      INSERT INTO project_members (id, project_id, user_id, role)
        VALUES ('${memberId}', '${projectId}', '${clientId}', 'CLIENT');
      UPDATE projects SET approver_member_id = '${memberId}' WHERE id = '${projectId}';
    `,
    );
    const cookie = await createSession(current, developerId);
    // 압축해도 줄지 않는 파일과 전송 제한으로 HTTP 철회가 일어날 시간을 확보한다.
    expect(
      await runCompose(current, [
        'exec',
        '-T',
        'api',
        'sh',
        '-c',
        'dd if=/dev/urandom of=/data/assets/upload-window.bin bs=1048576 count=4',
      ]),
    ).toMatchObject({ code: 0 });
    const backupName = `cr-slow-backup-${randomUUID()}`;
    let finished = false;
    const pendingBackup = runInTools(
      current,
      ['/work/deploy/backup.sh'],
      300_000,
      {
        RCLONE_BWLIMIT: '32k',
        // 로컬 대상 파일을 미리 전체 크기로 늘리면 업로드 중간 크기를 관찰할 수 없다.
        RCLONE_LOCAL_NO_PREALLOCATE: 'true',
      },
      backupName,
    ).finally(() => {
      finished = true;
    });
    let record = '';
    let eventTime = '';
    let savedBackup: { filename: string; snapshotTime: string };
    try {
      // 원격 파일에 실제 바이트가 도착했고 아직 전체를 올리지 못한 때를 기다린다.
      await expect
        .poll(
          async () => {
            const files = await readdir(path.join(current.directory, 'remote'));
            const sizes = await Promise.all(
              files.map(async (name) => (await stat(path.join(current.directory, 'remote', name))).size),
            );
            return sizes.some((size) => size > 0 && size < 4 * 1024 * 1024);
          },
          { timeout: 90_000, interval: 500 },
        )
        .toBe(true);
      await waitForHealthyApi(current);
      expect(finished).toBe(false);
      const revoke = await requestApi(current, `/api/members/${memberId}/revoke`, cookie, {});
      expect(revoke.stderr).toMatch(/HTTP\/1\.1 204\b/);
      expect(finished, '철회 요청이 끝났을 때도 백업 업로드 중이다').toBe(false);
      await expect
        .poll(
          async () => {
            const logs = await runCompose(current, ['logs', '--no-color', '--no-log-prefix', 'api']);
            expect(logs).toMatchObject({ code: 0 });
            const text = logs.stdout.replace(/\u001b\[[0-9;]*m/g, '');
            const subject = text.indexOf('[Client Review 기록] MEMBER_REVOKED → developer@example.com');
            if (subject < 0) return '';
            record = text
              .slice(text.indexOf('사건: MEMBER_REVOKED', subject))
              .split(/\r?\n/)
              .slice(0, 10)
              .join('\n')
              .trim();
            return record;
          },
          { timeout: 45_000, interval: 1_000 },
        )
        .toContain(`대상 멤버 id: ${memberId}`);
      eventTime = await runSql(
        current,
        `SELECT to_char(created_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') FROM activity_events
        WHERE type = 'MEMBER_REVOKED' AND member_id = '${memberId}'`,
      );
      expect(record).toContain(`시각: ${eventTime}`);
      savedBackup = await expectSuccessfulBackup(current, await pendingBackup);
    } finally {
      if (!finished) await runCommand(['rm', '-f', backupName]);
      await pendingBackup;
    }
    expect(savedBackup.snapshotTime < eventTime, '백업 기준 시각 뒤에 생긴 철회').toBe(true);
    await writeFile(path.join(current.directory, 'records.txt'), `${record}\n`);
    await expectRestoredAndStopped(current, await runRestore(current, savedBackup.filename), savedBackup.snapshotTime);
    expect(await runSql(current, `SELECT revoked_at IS NULL FROM project_members WHERE id = '${memberId}'`)).toBe('t');
    expect(await runSql(current, `SELECT approver_member_id FROM projects WHERE id = '${projectId}'`)).toBe(memberId);
    const replay = await runCompose(
      current,
      [
        'run',
        '--rm',
        '--no-deps',
        '-T',
        '-v',
        `${current.directory}/records.txt:/records.txt:ro`,
        'api',
        'npm',
        'run',
        '--silent',
        'replay-records',
        '--',
        '/records.txt',
        '--since',
        savedBackup.snapshotTime,
      ],
      120_000,
    );
    expect(replay).toMatchObject({ code: 0 });
    expect(await runSql(current, `SELECT revoked_at IS NOT NULL FROM project_members WHERE id = '${memberId}'`)).toBe(
      't',
    );
    expect(await runSql(current, `SELECT approver_member_id IS NULL FROM projects WHERE id = '${projectId}'`)).toBe(
      't',
    );
    expect(await runningServices(current)).toEqual(['db', 'nginx']);
    await finishRestore(current);
    const freshCookie = await createSession(current, clientId);
    expect((await requestApi(current, `/api/projects/${projectId}`, freshCookie)).stderr).toMatch(/HTTP\/1\.1 404\b/);
  }, 600_000);

  it('복원 뒤에는 수락하지 않은 옛 초대가 남지 않아 그 초대로 참여할 수 없다', async () => {
    const current = await prepareDeployment(deployment!);
    const { developerId, projectId } = await seedProjectAndPhoto(current);
    const clientId = randomUUID();
    const acceptedId = randomUUID();
    await runSql(
      current,
      `
      INSERT INTO users (id, email, name) VALUES ('${clientId}', 'client@example.com', '클라이언트');
      INSERT INTO invitations (id, project_id, email, token_hash, invited_by_id, expires_at, accepted_at)
        VALUES ('${acceptedId}', '${projectId}', 'accepted@example.com', '${randomUUID()}',
          '${developerId}', now() + interval '1 day', now());
    `,
    );
    const developerCookie = await createSession(current, developerId);
    const invitation = await requestApi(current, `/api/projects/${projectId}/invitations`, developerCookie, {
      email: 'client@example.com',
    });
    expect(invitation.stderr).toMatch(/HTTP\/1\.1 201\b/);
    const token = (JSON.parse(invitation.stdout) as { link: string }).link.split('/').at(-1)!;
    const clientCookie = await createSession(current, clientId);
    const { filename, snapshotTime } = await expectSuccessfulBackup(
      current,
      await runInTools(current, ['/work/deploy/backup.sh'], 120_000),
    );
    await waitForHealthyApi(current);
    expect((await requestApi(current, '/api/invitations/accept', clientCookie, { token })).stderr).toMatch(
      /HTTP\/1\.1 200\b/,
    );
    const memberId = await runSql(current, `SELECT id FROM project_members WHERE user_id = '${clientId}'`);
    expect((await requestApi(current, `/api/members/${memberId}/revoke`, developerCookie, {})).stderr).toMatch(
      /HTTP\/1\.1 204\b/,
    );

    await expectRestoredAndStopped(current, await runRestore(current, filename), snapshotTime);
    expect(await runSql(current, 'SELECT count(*) FROM invitations WHERE accepted_at IS NULL')).toBe('0');
    expect(await runSql(current, 'SELECT id FROM invitations')).toBe(acceptedId);
    await finishRestore(current);
    // 새 세션으로 묻는다. 복원이 세션을 지운 탓에 401인 것을 초대 거부로 오인하지 않는다.
    const freshCookie = await createSession(current, clientId);
    expect((await requestApi(current, '/api/auth/me', freshCookie)).stderr).toMatch(/HTTP\/1\.1 200\b/);
    expect((await requestApi(current, `/api/invitations/${token}`)).stderr).toMatch(/HTTP\/1\.1 404\b/);
    expect((await requestApi(current, '/api/invitations/accept', freshCookie, { token })).stderr).toMatch(
      /HTTP\/1\.1 404\b/,
    );
    expect(await runSql(current, `SELECT count(*) FROM project_members WHERE user_id = '${clientId}'`)).toBe('0');
  }, 420_000);

  it('틀린 암호나 깨진 파일로 복원하면 DB와 사진이 그대로다', async () => {
    const current = await prepareDeployment(deployment!);
    const { projectId, storageKey } = await seedProjectAndPhoto(current);
    const { filename } = await expectSuccessfulBackup(
      current,
      await runInTools(current, ['/work/deploy/backup.sh'], 120_000),
    );
    await waitForHealthyApi(current);
    await runSql(current, `UPDATE projects SET name = '백업 뒤 수정한 프로젝트' WHERE id = '${projectId}'`);
    expect(
      await runCompose(current, [
        'exec',
        '-T',
        'api',
        'sh',
        '-c',
        'printf changed > "/data/assets/$1"',
        'sh',
        storageKey,
      ]),
    ).toMatchObject({ code: 0 });
    const before = await readProjectAndPhotos(current);
    const apiId = await runCompose(current, ['ps', '-q', 'api']);
    expect(apiId).toMatchObject({ code: 0 });
    const startedBefore = await runCommand(['inspect', '--format', '{{.State.StartedAt}}', apiId.stdout.trim()]);
    expect(startedBefore).toMatchObject({ code: 0 });
    await writeFile(path.join(current.directory, 'wrong-passphrase'), randomUUID(), { mode: 0o600 });
    const encrypted = await readFile(path.join(current.directory, 'backups', filename));
    await writeFile(path.join(current.directory, 'backups/truncated.tar.gpg'), encrypted.subarray(0, 128));

    const invalidBackups = [
      { filename: 'invalid-db.tar.gpg', damagedFile: 'db.dump', contents: 'not a PostgreSQL dump' },
      { filename: 'invalid-assets.tar.gpg', damagedFile: 'assets.tar', contents: 'not a tar archive' },
      // 파일이 없으면 뒤의 cat도 실패하므로, 빈 파일로 비어 있는지 확인하는 검사를 따로 검증한다.
      { filename: 'empty-snapshot.tar.gpg', damagedFile: 'snapshot-time.txt', contents: '' },
    ];
    for (const backup of invalidBackups) {
      const repacked = await runInTools(current, [
        'bash',
        '-e',
        '-o',
        'pipefail',
        '-c',
        `
        mkdir /work/repack
        gpg --batch --pinentry-mode loopback --passphrase-file /work/passphrase -d "$1" | tar -xf - -C /work/repack
        printf '%s' "$3" > "/work/repack/$2"
        tar -cf - -C /work/repack snapshot-time.txt db.dump assets.tar |
          gpg --batch --pinentry-mode loopback --passphrase-file /work/passphrase --symmetric --cipher-algo AES256 \
            -o "/work/backups/$4"
        rm -rf /work/repack
      `,
        'bash',
        `/work/backups/${filename}`,
        backup.damagedFile,
        backup.contents,
        backup.filename,
      ]);
      expect(repacked, `${backup.damagedFile} 내용이 잘못된 백업 암호화`).toMatchObject({ code: 0 });
    }

    for (const attempt of [
      { filename, environment: { BACKUP_PASSPHRASE_FILE: '/work/wrong-passphrase' } },
      { filename: 'truncated.tar.gpg', environment: {} },
      ...invalidBackups.map(({ filename }) => ({ filename, environment: {} })),
    ]) {
      const result = await runRestore(current, attempt.filename, 'restore', attempt.environment);
      expect(result.code).not.toBe(0);
      await expect(stat(path.join(current.directory, '.backup-work'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(path.join(current.directory, '.maintenance'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readProjectAndPhotos(current)).toEqual(before);
      expect(await runningServices(current)).toEqual(['api', 'db', 'nginx']);
      expect(await getHealth(current)).toMatchObject({ code: 0, stdout: '{"status":"ok"}' });
      expect(await runCommand(['inspect', '--format', '{{.State.StartedAt}}', apiId.stdout.trim()])).toEqual(
        startedBefore,
      );
    }
  }, 420_000);

  it('손작업 표시 중에는 복원이 실패하고 end를 해야 api가 켜진다', async () => {
    const current = await prepareDeployment(deployment!);
    await seedProjectAndPhoto(current);
    const { filename } = await expectSuccessfulBackup(
      current,
      await runInTools(current, ['/work/deploy/backup.sh'], 120_000),
    );
    await waitForHealthyApi(current);
    const before = await readProjectAndPhotos(current);
    expect(await runInTools(current, ['/work/deploy/maintenance.sh', 'start'])).toMatchObject({ code: 0 });
    const marker = path.join(current.directory, '.maintenance');
    const restore = await runRestore(current, filename);
    expect(restore).toMatchObject({ code: 1 });
    expect(restore.stderr).toContain('점검 중이라 복원하지 않아요');
    expect(await runInTools(current, ['/work/deploy/restore.sh', '--finish'])).toMatchObject({ code: 1 });
    expect((await readFile(marker, 'utf8')).trim()).toBe('manual');
    expect(await runningServices(current)).toEqual(['db', 'nginx']);
    expect(await readProjectAndPhotos(current)).toEqual(before);
    expect((await getHealth(current)).code).not.toBe(0);

    expect(await runInTools(current, ['/work/deploy/maintenance.sh', 'end'])).toMatchObject({ code: 0 });
    expect(await getHealth(current)).toMatchObject({ code: 0, stdout: '{"status":"ok"}' });
    await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await runningServices(current)).toEqual(['api', 'db', 'nginx']);
  }, 360_000);

  it('복원은 api를 멈춘 채 끝나고 finish를 해야 켜진다', async () => {
    const current = await prepareDeployment(deployment!);
    const { projectId, storageKey } = await seedProjectAndPhoto(current);
    const original = await readProjectAndPhotos(current);
    const { filename, snapshotTime } = await expectSuccessfulBackup(
      current,
      await runInTools(current, ['/work/deploy/backup.sh'], 120_000),
    );
    await waitForHealthyApi(current);
    await runSql(current, `UPDATE projects SET name = '백업 뒤 바꿈' WHERE id = '${projectId}'`);
    expect(
      await runCompose(current, [
        'exec',
        '-T',
        'api',
        'sh',
        '-c',
        'printf changed > "/data/assets/$1"; printf extra > /data/assets/extra.png',
        'sh',
        storageKey,
      ]),
    ).toMatchObject({ code: 0 });
    const changed = await readProjectAndPhotos(current);
    expect(changed).not.toEqual(original);
    const cancelled = await runRestore(current, filename, 'yes');
    expect(cancelled).toMatchObject({ code: 1 });
    expect(cancelled.stderr).toContain('복원하지 않았어요');
    await expect(stat(path.join(current.directory, '.backup-work'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readProjectAndPhotos(current)).toEqual(changed);
    await expect(stat(path.join(current.directory, '.maintenance'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await getHealth(current)).toMatchObject({ code: 0, stdout: '{"status":"ok"}' });

    await expectRestoredAndStopped(current, await runRestore(current, filename), snapshotTime);
    await expect(stat(path.join(current.directory, '.backup-work'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readProjectAndPhotos(current)).toEqual(original);
    expect(await runInTools(current, ['/work/deploy/maintenance.sh', 'end'])).toMatchObject({ code: 1 });
    expect((await readFile(path.join(current.directory, '.maintenance'), 'utf8')).trim()).toBe('restore done');
    expect(await runningServices(current)).toEqual(['db', 'nginx']);
    await finishRestore(current);
    expect(await readProjectAndPhotos(current)).toEqual(original);
    expect(await runCompose(current, ['stop', 'api'])).toMatchObject({ code: 0 });
    expect(await runInTools(current, ['/work/deploy/restore.sh', '--finish'])).toMatchObject({ code: 1 });
    expect(await runningServices(current)).toEqual(['db', 'nginx']);
    await expect(stat(path.join(current.directory, '.maintenance'))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 420_000);

  it('옛 DB 구조의 백업을 복원하면 api를 켜지 않은 채 지금 구조로 맞춘다', async () => {
    const current = await prepareDeployment(deployment!);
    await seedProjectAndPhoto(current);
    const before = await readProjectAndPhotos(current);
    expect(await runCompose(current, ['stop', 'api'])).toMatchObject({ code: 0 });
    const migration = '20261114130000_add_privacy_consent';
    await runSql(
      current,
      `
      ALTER TABLE login_codes DROP COLUMN privacy_agreed;
      ALTER TABLE users DROP COLUMN privacy_agreed_at;
      DELETE FROM _prisma_migrations WHERE migration_name = '${migration}';
    `,
    );
    const columns = `SELECT table_name || '.' || column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND
        ((table_name = 'login_codes' AND column_name = 'privacy_agreed') OR
         (table_name = 'users' AND column_name = 'privacy_agreed_at')) ORDER BY table_name`;
    expect(await runSql(current, columns)).toBe('');
    const apiId = await runCompose(current, ['ps', '-aq', 'api']);
    expect(apiId).toMatchObject({ code: 0 });
    const startedBefore = await runCommand(['inspect', '--format', '{{.State.StartedAt}}', apiId.stdout.trim()]);
    expect(startedBefore).toMatchObject({ code: 0 });
    const { filename, snapshotTime } = await expectSuccessfulBackup(
      current,
      await runInTools(current, ['/work/deploy/backup.sh'], 120_000),
    );

    await expectRestoredAndStopped(current, await runRestore(current, filename), snapshotTime);
    expect(await runSql(current, columns)).toBe('login_codes.privacy_agreed\nusers.privacy_agreed_at');
    expect(
      await runSql(
        current,
        `SELECT count(*) FROM _prisma_migrations WHERE migration_name = '${migration}'
      AND finished_at IS NOT NULL AND rolled_back_at IS NULL`,
      ),
    ).toBe('1');
    expect(await runCommand(['inspect', '--format', '{{.State.StartedAt}}', apiId.stdout.trim()])).toEqual(
      startedBefore,
    );
    expect(await readProjectAndPhotos(current)).toEqual(before);
  }, 420_000);

  it('DB를 지운 뒤 복원이 실패하면 표시가 남고 api는 멈춰 있고 finish가 거부되며 다시 복원할 수 있다', async () => {
    const current = await prepareDeployment(deployment!);
    const { projectId } = await seedProjectAndPhoto(current);
    const before = await readProjectAndPhotos(current);
    const { filename, snapshotTime } = await expectSuccessfulBackup(
      current,
      await runInTools(current, ['/work/deploy/backup.sh'], 120_000),
    );
    // 일반 파일 x 뒤에 x/y가 오는 tar: 목록 검사는 되지만 실제 디스크에는 풀 수 없다.
    const corrupt = await runInTools(current, [
      'bash',
      '-e',
      '-o',
      'pipefail',
      '-c',
      `
      mkdir /work/repack /work/tar-file /work/tar-child
      gpg --batch --pinentry-mode loopback --passphrase-file /work/passphrase -d "$1" | tar -xf - -C /work/repack
      printf x > /work/tar-file/x
      mkdir /work/tar-child/x
      printf y > /work/tar-child/x/y
      tar -cf /work/repack/assets.tar -C /work/tar-file x
      tar -rf /work/repack/assets.tar -C /work/tar-child x/y
      tar -tf /work/repack/assets.tar
      tar -cf - -C /work/repack snapshot-time.txt db.dump assets.tar |
        gpg --batch --pinentry-mode loopback --passphrase-file /work/passphrase --symmetric --cipher-algo AES256 \
          -o /work/backups/bad-assets.tar.gpg
    `,
      'bash',
      `/work/backups/${filename}`,
    ]);
    expect(corrupt).toMatchObject({ code: 0 });
    expect(corrupt.stdout.trim().split('\n')).toEqual(['x', 'x/y']);
    await runSql(current, `UPDATE projects SET name = '복원 전에 바꾼 이름' WHERE id = '${projectId}'`);

    const failedRestore = await runRestore(current, 'bad-assets.tar.gpg');
    expect(failedRestore.code).not.toBe(0);
    expect(failedRestore.stdout).not.toContain('복원을 마쳤어요');
    // DB가 실제로 이전 값으로 바뀌었다. 사전 검사에서 실패한 것을 중간 실패로 오인하지 않는다.
    expect(await runSql(current, `SELECT name FROM projects WHERE id = '${projectId}'`)).toBe('복원할 프로젝트');
    const marker = path.join(current.directory, '.maintenance');
    expect((await readFile(marker, 'utf8')).trim()).toBe('restore in-progress');
    expect(await runningServices(current)).toEqual(['db', 'nginx']);
    expect((await getHealth(current)).code).not.toBe(0);
    expect(await runInTools(current, ['/work/deploy/restore.sh', '--finish'])).toMatchObject({ code: 1 });
    expect((await readFile(marker, 'utf8')).trim()).toBe('restore in-progress');
    expect(await runningServices(current)).toEqual(['db', 'nginx']);

    await expectRestoredAndStopped(current, await runRestore(current, filename), snapshotTime);
    expect(await readProjectAndPhotos(current)).toEqual(before);
    await finishRestore(current);
  }, 480_000);

  it('finish가 api를 켜지 못하면 표시가 남고 다시 finish하면 켜진다', async () => {
    const current = await prepareDeployment(deployment!);
    await seedProjectAndPhoto(current);
    const { filename, snapshotTime } = await expectSuccessfulBackup(
      current,
      await runInTools(current, ['/work/deploy/backup.sh'], 120_000),
    );
    await expectRestoredAndStopped(current, await runRestore(current, filename), snapshotTime);
    await runSql(current, "ALTER USER client_review PASSWORD 'broken'");
    const failedFinish = await runInTools(current, ['/work/deploy/restore.sh', '--finish']);
    expect(failedFinish).toMatchObject({ code: 1 });
    expect(failedFinish.stderr).toContain('api가 응답하지 않아요');
    expect((await readFile(path.join(current.directory, '.maintenance'), 'utf8')).trim()).toBe('restore done');
    expect((await getHealth(current)).code).not.toBe(0);
    await expect.poll(() => runningServices(current), { timeout: 30_000, interval: 1_000 }).toEqual(['db', 'nginx']);
    await runSql(current, "ALTER USER client_review PASSWORD 'e2e'");

    await finishRestore(current);
  }, 420_000);

  it('백업이 중간에 실패하면 api가 다시 켜지고 알림 메일이 간다', async () => {
    const current = await prepareDeployment(deployment!);
    expect(await runCompose(current, ['stop', 'db'])).toMatchObject({ code: 0 });
    expect(await runningServices(current)).toEqual(['api', 'nginx']);

    const backup = await runInTools(current, ['/work/deploy/backup.sh'], 120_000);

    expectOperationalAlert(backup, '백업 실패: 서버에서 deploy/backup.sh 를 돌려 원인을 확인해 주세요');
    expect(await readdir(path.join(current.directory, 'backups'))).toEqual([]);
    expect(await readdir(path.join(current.directory, 'remote'))).toEqual([]);
    await expect(stat(path.join(current.directory, '.backup-stopped-api'))).rejects.toMatchObject({ code: 'ENOENT' });
    await waitForHealthyApi(current);
    expect(await runningServices(current)).toEqual(['api', 'db', 'nginx']);
  }, 240_000);

  it('켤 때 백업은 db가 늦게 준비돼도 기다렸다가 백업한다', async () => {
    const current = await prepareDeployment(deployment!);
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
    const current = await prepareDeployment(deployment!);
    expect(await runCompose(current, ['stop', 'db', 'api'])).toMatchObject({ code: 0 });
    const startedAt = Date.now();

    const backup = await runInTools(current, ['/work/deploy/backup.sh', '--wait-ready'], 60_000, {
      BACKUP_WAIT_SECONDS: '8',
    });

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(8_000);
    expectOperationalAlert(backup, '백업 실패: db가 준비되지 않았어요');
    expect(await readdir(path.join(current.directory, 'backups'))).toEqual([]);
    expect(await readdir(path.join(current.directory, 'remote'))).toEqual([]);
    expect(await runningServices(current)).toEqual(['nginx']);
    await expect(stat(path.join(current.directory, '.backup-stopped-api'))).rejects.toMatchObject({ code: 'ENOENT' });
    const lock = await runInTools(current, ['flock', '-n', '/work/.maintenance.lock', 'true']);
    expect(lock, '준비 대기가 실패한 뒤에도 다른 스크립트가 잠금을 잡을 수 있다').toMatchObject({ code: 0 });
  }, 120_000);

  it('백업이 api를 멈춘 채 끊기면 다음 백업이 api를 켜고 백업한다', async () => {
    const current = await prepareDeployment(deployment!);
    expect(await runCompose(current, ['stop', 'api'])).toMatchObject({ code: 0 });
    await writeFile(path.join(current.directory, '.backup-stopped-api'), '');

    const backup = await runInTools(current, ['/work/deploy/backup.sh'], 120_000);

    expect(backup.stdout).toContain('지난 백업이 api를 멈춘 채 끊겼어요');
    await expectSuccessfulBackup(current, backup);
    await waitForHealthyApi(current);
    expect(await runningServices(current)).toEqual(['api', 'db', 'nginx']);
  }, 240_000);

  it('백업이 강제로 끊겨 남은 암호화 전 재료는 다음 백업이 지운다', async () => {
    const current = await prepareDeployment(deployment!);
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

      expectOperationalAlert(maintenanceBackup, '백업 실패: 점검 중이라 백업하지 않았어요');
      await expect(stat(workDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(marker, 'utf8')).toBe('manual');
    } finally {
      // 폴링이나 검증이 실패해도 도구 컨테이너를 끝내고, compose의 잔여물은 afterEach에서 정리한다.
      await runCommand(['rm', '-f', containerName]);
      await pendingBackup;
    }
  }, 300_000);

  it('백업 파일과 강제로 끊겨 남은 재료는 주인만 읽을 수 있다', async () => {
    const current = await prepareDeployment(deployment!);
    await seedProjectAndPhoto(current);
    const backup = await runInTools(current, ['/work/deploy/backup.sh'], 120_000);
    const { filename } = await expectSuccessfulBackup(current, backup);
    const backupModes = await runInTools(current, [
      'stat',
      '-c',
      '%a',
      `/work/backups/${filename}`,
      `/work/remote/${filename}`,
    ]);
    expect(backupModes).toMatchObject({ code: 0, stdout: '600\n600\n' });

    const workDirectory = path.join(current.directory, '.backup-work');
    const expectPrivateWork = async () => {
      const directoryMode = await runInTools(current, ['stat', '-c', '%a', '/work/.backup-work']);
      expect(directoryMode).toMatchObject({ code: 0, stdout: '700\n' });
      const fileModes = await runInTools(current, [
        'find',
        '/work/.backup-work',
        '-type',
        'f',
        '-exec',
        'stat',
        '-c',
        '%a %n',
        '{}',
        ';',
      ]);
      expect(fileModes).toMatchObject({ code: 0 });
      const lines = fileModes.stdout.trim().split('\n');
      expect(lines).toContain('600 /work/.backup-work/db.dump');
      expect(lines).toContain('600 /work/.backup-work/snapshot-time.txt');
      for (const line of lines) expect(line).toMatch(/^600 /);
    };

    const backupContainer = `cr-backup-${randomUUID()}`;
    const pendingBackup = runInTools(current, ['/work/deploy/backup.sh'], 120_000, {}, backupContainer);
    try {
      await expect
        .poll(async () => (await stat(path.join(workDirectory, 'db.dump'))).size, {
          timeout: 60_000,
          interval: 20,
        })
        .toBeGreaterThan(0);
      expect(await runCommand(['kill', backupContainer])).toMatchObject({ code: 0 });
      expect(await pendingBackup).toMatchObject({ code: 137 });
      await expectPrivateWork();
    } finally {
      await runCommand(['rm', '-f', backupContainer]);
      await pendingBackup;
    }

    const restoreContainer = `cr-restore-${randomUUID()}`;
    // 이름 있는 파이프를 읽기·쓰기로 열어 입력도 EOF도 보내지 않고 확인 질문에서 기다린다.
    const pendingRestore = runInTools(
      current,
      [
        'bash',
        '-c',
        'mkfifo /work/restore-input; exec 3<>/work/restore-input; exec /work/deploy/restore.sh "$1" <&3',
        'bash',
        `/work/backups/${filename}`,
      ],
      120_000,
      {},
      restoreContainer,
    );
    try {
      await expect
        .poll(
          async () => {
            const logs = await runCommand(['logs', restoreContainer]);
            return logs.stdout;
          },
          { timeout: 60_000, interval: 200 },
        )
        .toContain('의 백업으로 DB와 사진을 모두 바꿔요');
      for (const name of ['snapshot-time.txt', 'db.dump', 'assets.tar']) {
        expect((await stat(path.join(workDirectory, name))).size).toBeGreaterThan(0);
      }
      expect(await runCommand(['kill', restoreContainer])).toMatchObject({ code: 0 });
      expect(await pendingRestore).toMatchObject({ code: 137 });
      await expectPrivateWork();
      const assetsMode = await runInTools(current, ['stat', '-c', '%a', '/work/.backup-work/assets.tar']);
      expect(assetsMode).toMatchObject({ code: 0, stdout: '600\n' });
    } finally {
      await runCommand(['rm', '-f', restoreContainer]);
      await pendingRestore;
    }
  }, 420_000);

  it('시작할 때 멈춰 있던 api는 백업 뒤에도 멈춰 있다', async () => {
    const current = await prepareDeployment(deployment!);
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

  it('다시 시작을 되풀이하던 api도 백업이 멈춘 뒤 뜨고 끝에 다시 켠다', async () => {
    const current = deployment!;
    await writeFile(
      path.join(current.directory, 'restarting.yml'),
      'services:\n  api:\n    restart: unless-stopped\n    command: ["sh", "-c", "exit 1"]\n',
    );
    current.composeFile += ':/work/restarting.yml';
    expect(await runCompose(current, ['up', '-d', '--wait', 'db'], 120_000)).toMatchObject({ code: 0 });
    expect(await runCompose(current, ['up', '-d', '--build', 'api'], 480_000)).toMatchObject({ code: 0 });
    const container = await runCompose(current, ['ps', '-a', '-q', 'api']);
    expect(container).toMatchObject({ code: 0 });
    const containerId = container.stdout.trim();
    expect(containerId).not.toBe('');

    // 다시 시작 간격이 길어질 때까지 기다려 백업이 restarting 상태를 보게 한다.
    await expect
      .poll(
        async () => {
          const state = await runCommand(['inspect', '--format', '{{.State.Status}} {{.RestartCount}}', containerId]);
          expect(state).toMatchObject({ code: 0 });
          const [status, restartCount] = state.stdout.trim().split(/\s+/);
          return status === 'restarting' && Number(restartCount) >= 6;
        },
        { timeout: 60_000, interval: 200 },
      )
      .toBe(true);
    expect(await runCompose(current, ['ps', '-q', '--status', 'running', 'api'])).toMatchObject({
      code: 0,
      stdout: '',
    });
    const restarting = await runCompose(current, ['ps', '-q', '--status', 'restarting', 'api']);
    expect(restarting).toMatchObject({ code: 0 });
    expect(restarting.stdout.trim()).toBe(containerId);

    const backupStartedAt = Math.floor(Date.now() / 1_000);
    const backup = await runInTools(current, ['/work/deploy/backup.sh'], 120_000);
    const backupFinishedAt = Math.ceil(Date.now() / 1_000);

    await expectSuccessfulBackup(current, backup);
    // 자동 재시작의 die·start와 구별한다. stop은 백업이 실제로 멈췄을 때만 남는다.
    const stopped = await runCommand([
      'events',
      '--since',
      String(backupStartedAt),
      '--until',
      String(backupFinishedAt),
      '--filter',
      `container=${containerId}`,
      '--filter',
      'event=stop',
      '--format',
      '{{.Action}}',
    ]);
    expect(stopped).toMatchObject({ code: 0 });
    expect(stopped.stdout.trim().split(/\r?\n/)).toContain('stop');
    const state = await runCommand(['inspect', '--format', '{{.State.Status}}', containerId]);
    expect(state).toMatchObject({ code: 0 });
    expect(['running', 'restarting']).toContain(state.stdout.trim());
  }, 600_000);

  it('14일 지난 백업은 서버와 바깥 보관 곳에서 지우고 그 안의 것은 남긴다', async () => {
    const current = await prepareDeployment(deployment!);
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
    const current = await prepareDeployment(deployment!);
    await seedOldBackups(current);

    const backup = await runInTools(current, ['/work/deploy/backup.sh'], 120_000, {
      BACKUP_REMOTE: 'nosuchremote:dir',
    });

    expectOperationalAlert(backup, '백업 실패: 서버에서 deploy/backup.sh 를 돌려 원인을 확인해 주세요');
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

  it('점검 표시가 있어도 14일 지난 백업은 두 곳에서 지우고 새 백업은 만들지 않으며 api는 멈춘 채다', async () => {
    const current = await prepareDeployment(deployment!);
    expect(await runInTools(current, ['/work/deploy/maintenance.sh', 'start'])).toMatchObject({ code: 0 });
    const marker = path.join(current.directory, '.maintenance');
    expect((await readFile(marker, 'utf8')).trim()).toBe('manual');
    expect(await runningServices(current)).toEqual(['db', 'nginx']);
    await seedOldBackups(current);

    const backup = await runInTools(current, ['/work/deploy/backup.sh'], 120_000);

    expectOperationalAlert(backup, '백업 실패: 점검 중이라 백업하지 않았어요(표시: manual)');
    expect(`${backup.stdout}\n${backup.stderr}`).not.toContain('지우지 못했어요');
    const retained = ['client-review-young.tar.gpg', 'client-review-almost-14-days.tar.gpg', 'other-file.txt'];
    for (const directory of ['backups', 'remote']) {
      expect((await readdir(path.join(current.directory, directory))).sort()).toEqual([...retained].sort());
      for (const name of retained) {
        expect(await readFile(path.join(current.directory, directory, name), 'utf8')).toBe(name);
      }
    }
    expect(await runningServices(current)).toEqual(['db', 'nginx']);
    expect((await readFile(marker, 'utf8')).trim()).toBe('manual');
  }, 240_000);

  it('점검 표시가 있으면 백업과 업데이트는 아무것도 하지 않고 api도 켜지 않는다', async () => {
    const current = await prepareDeployment(deployment!, true);
    expect(await runCompose(current, ['stop', 'api'])).toMatchObject({ code: 0 });
    const marker = path.join(current.directory, 'clone/.maintenance');
    const stoppedNote = path.join(current.directory, 'clone/.backup-stopped-api');
    // 지난 백업의 메모가 있어도 점검 표시가 우선이다.
    await writeFile(stoppedNote, '');

    for (const reason of ['manual', 'restore in-progress', 'restore done', 'update']) {
      await writeFile(marker, reason);
      for (const args of [[], ['--wait-ready']]) {
        const backup = await runInTools(current, ['/work/clone/deploy/backup.sh', ...args], 60_000, {
          BACKUP_WAIT_SECONDS: '8',
        });
        expectOperationalAlert(backup, '백업 실패: 점검 중이라 백업하지 않았어요');
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
    const clone = path.join(current.directory, 'clone');
    const originalHead = await runGit(clone, ['rev-parse', 'HEAD']);
    await pushUpdate(current, { 'landing/update-check.txt': randomUUID() });
    for (const reason of ['manual', 'restore in-progress', 'restore done', 'update']) {
      await writeFile(marker, reason);
      for (const retry of reason === 'update' ? [false] : [false, true]) {
        const update = await runUpdate(current, retry);
        expect(update).toMatchObject({ code: 1 });
        expect(update.stderr).toContain(
          retry ? `실패한 업데이트가 없어요(표시: ${reason})` : `점검 중이라 업데이트하지 않아요(표시: ${reason})`,
        );
        expect(`${update.stdout}\n${update.stderr}`).not.toContain('[Client Review 알림]');
        expect(await readFile(marker, 'utf8')).toBe(reason);
        expect(await readFile(stoppedNote, 'utf8')).toBe('');
        expect(await runningServices(current)).toEqual(['db', 'nginx']);
        expect(await runGit(clone, ['rev-parse', 'HEAD'])).toBe(originalHead);
      }
    }
  }, 420_000);

  it('api가 멈춰 있으면 업데이트는 아무것도 하지 않고 실패한다', async () => {
    const current = await prepareDeployment(deployment!, true);
    const clone = path.join(current.directory, 'clone');
    const originalHead = await runGit(clone, ['rev-parse', 'HEAD']);
    await pushUpdate(current, { 'landing/update-check.txt': randomUUID() });

    for (const service of ['api', 'db', 'nginx']) {
      expect(await runCompose(current, ['stop', service])).toMatchObject({ code: 0 });
      const servicesBefore = await runningServices(current);

      const update = await runUpdate(current);

      expect(update).toMatchObject({ code: 1 });
      expect(update.stderr).toContain(`꺼진 서비스가 있어 업데이트하지 않아요: ${service}`);
      expect(`${update.stdout}\n${update.stderr}`).not.toContain('[Client Review 알림]');
      await expect(stat(path.join(clone, '.maintenance'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await runGit(clone, ['rev-parse', 'HEAD'])).toBe(originalHead);
      expect(await runningServices(current)).toEqual(servicesBefore);
      expect(servicesBefore).not.toContain(service);
      expect(await runCompose(current, ['start', service])).toMatchObject({ code: 0 });
      await waitForHealthyApi(current);
    }
  }, 420_000);

  it('업데이트는 새 커밋을 받아 다시 만들고 nginx를 거친 응답을 확인한다', async () => {
    const current = await prepareDeployment(deployment!, true);
    const content = randomUUID();
    const script = await readFile(path.join(current.directory, 'pusher/deploy/update.sh'), 'utf8');
    const comments = Array.from({ length: 200 }, (_, index) => `# update fixture ${index}`).join('\n');
    const updatedScript = script.replace('\n', `\n${comments}\n`);
    await pushUpdate(current, {
      'landing/update-check.txt': content,
      'deploy/update.sh': updatedScript,
    });

    const update = await runUpdate(current);

    await expectSuccessfulUpdate(current, update);
    expect(await readFile(path.join(current.directory, 'clone/deploy/update.sh'), 'utf8')).toBe(updatedScript);
    const page = await runCompose(current, [
      'exec',
      '-T',
      'nginx',
      'wget',
      '-qO-',
      'http://127.0.0.1/update-check.txt',
    ]);
    expect(page).toMatchObject({ code: 0, stdout: content });
  }, 420_000);

  it('업데이트 뒤 api가 뜨지 않으면 실패하고 알림 메일이 간다', async () => {
    const current = await prepareDeployment(deployment!, true);
    const compose = await readFile(path.join(current.directory, 'pusher/deploy/test/compose.e2e.yml'), 'utf8');
    await pushUpdate(current, {
      'deploy/test/compose.e2e.yml': compose.replace('  api:\n', '  api:\n    command: ["sh", "-c", "exit 1"]\n'),
    });

    const update = await runUpdate(current);

    expectOperationalAlert(update, '업데이트 실패: 원인을 고친 커밋을 올린 뒤 deploy/update.sh --retry 를 돌려 주세요');
    expect(update.stderr).toContain('응답 확인에 실패했어요');
    expect((await readFile(path.join(current.directory, 'clone/.maintenance'), 'utf8')).trim()).toBe('update');
    expect(await runningServices(current)).toEqual(['db', 'nginx']);
    expect((await getHealth(current)).code).not.toBe(0);
    expect(update.stdout).not.toContain('업데이트를 마쳤어요');
  }, 420_000);

  it('실패한 업데이트 표시가 있어도 복원할 수 있고 고친 코드로 다시 만든 뒤 finish하면 켜진다', async () => {
    const current = await prepareDeployment(deployment!, true);
    const clone = path.join(current.directory, 'clone');
    const marker = path.join(clone, '.maintenance');
    const { projectId } = await seedProjectAndPhoto(current);
    const before = await readProjectAndPhotos(current);
    const backup = await runInTools(current, ['/work/clone/deploy/backup.sh'], 120_000);
    const { filename, snapshotTime } = await expectSuccessfulBackup(current, backup);
    await waitForHealthyApi(current);
    await runSql(current, `UPDATE projects SET name = '백업 뒤 바뀐 이름' WHERE id = '${projectId}'`);
    const compose = await readFile(path.join(current.directory, 'pusher/deploy/test/compose.e2e.yml'), 'utf8');
    await pushUpdate(current, {
      'deploy/test/compose.e2e.yml': compose.replace('  api:\n', '  api:\n    command: ["sh", "-c", "exit 1"]\n'),
    });
    const failedUpdate = await runUpdate(current);
    expectOperationalAlert(
      failedUpdate,
      '업데이트 실패: 원인을 고친 커밋을 올린 뒤 deploy/update.sh --retry 를 돌려 주세요',
    );
    expect(failedUpdate.stderr).toContain('응답 확인에 실패했어요');
    expect((await readFile(marker, 'utf8')).trim()).toBe('update');
    expect(await runningServices(current)).toEqual(['db', 'nginx']);

    // 운영 문서처럼 고친 이미지를 먼저 만들되, 복원과 다시 적용 전에는 api를 켜지 않는다.
    await pushUpdate(current, { 'deploy/test/compose.e2e.yml': compose });
    expect(await runInTools(current, ['git', 'pull', '--ff-only'])).toMatchObject({ code: 0 });
    expect(await runCompose(current, ['build', 'api', 'nginx'], 480_000)).toMatchObject({ code: 0 });
    expect((await readFile(marker, 'utf8')).trim()).toBe('update');
    expect(await runSql(current, `SELECT name FROM projects WHERE id = '${projectId}'`)).toBe('백업 뒤 바뀐 이름');

    const restore = await runInTools(
      current,
      ['/work/clone/deploy/restore.sh', `/work/backups/${filename}`],
      180_000,
      {},
      undefined,
      'restore\n',
    );
    expect(restore).toMatchObject({ code: 0 });
    expect(restore.stdout).toContain(`기준 시각: ${snapshotTime}`);
    expect((await readFile(marker, 'utf8')).trim()).toBe('restore done');
    expect(await readProjectAndPhotos(current)).toEqual(before);
    expect(await runningServices(current)).toEqual(['db', 'nginx']);
    expect((await getHealth(current)).code).not.toBe(0);

    // restore 표시를 update 재시도로 덮어써서 다시 적용 전에 열 수 없어야 한다.
    const retryBeforeFinish = await runUpdate(current, true);
    expect(retryBeforeFinish).toMatchObject({ code: 1 });
    expect(retryBeforeFinish.stderr).toContain('실패한 업데이트가 없어요(표시: restore done)');
    expect((await readFile(marker, 'utf8')).trim()).toBe('restore done');
    expect(await runningServices(current)).toEqual(['db', 'nginx']);

    expect(await runCompose(current, ['create', '--force-recreate', 'api'])).toMatchObject({ code: 0 });
    expect(await runCompose(current, ['up', '-d', '--no-deps', 'nginx'])).toMatchObject({ code: 0 });
    expect(await runningServices(current)).toEqual(['db', 'nginx']);
    const finish = await runInTools(current, ['/work/clone/deploy/restore.sh', '--finish']);
    expect(finish).toMatchObject({ code: 0 });
    expect(await getHealth(current)).toMatchObject({ code: 0, stdout: '{"status":"ok"}' });
    await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await runningServices(current)).toEqual(['api', 'db', 'nginx']);

    const retry = await runUpdate(current, true);
    expect(retry).toMatchObject({ code: 1 });
    expect(retry.stderr).toContain('실패한 업데이트가 없어요(표시: 없음)');
    await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 600_000);

  it('운영 nginx 설정은 믿는 앞단이 아닌 곳에서 온 X-Forwarded-For를 믿지 않는다', async () => {
    const current = await prepareDeployment(deployment!);
    // 맥의 게시 포트를 거치지 않고 같은 망의 api에서 운영 nginx로 직접 보낸다.
    const requests = await runCompose(current, [
      'exec',
      '-T',
      'api',
      'node',
      '--input-type=module',
      '-e',
      `const results = [];
      const startedAt = Date.now();
      for (let index = 1; index <= 7; index++) {
        const response = await fetch('http://nginx/api/auth/email-code', {
          method: 'POST',
          headers: {
            Origin: 'http://localhost',
            'Content-Type': 'application/json',
            'X-Forwarded-For': '10.0.0.' + index,
          },
          body: JSON.stringify({ email: 'untrusted' + index + '@example.com', privacyAgreed: true }),
        });
        results.push({ status: response.status, body: await response.text() });
      }
      console.log(JSON.stringify({ results, elapsed: Date.now() - startedAt }));`,
    ]);
    expect(requests).toMatchObject({ code: 0 });
    const { results, elapsed } = JSON.parse(requests.stdout) as {
      results: { status: number; body: string }[];
      elapsed: number;
    };
    expect(elapsed, '요청 제한이 한 번 채워지는 6초 안에 일곱 번 보낸다').toBeLessThan(6_000);
    expect(results.map((result) => result.status)).toEqual([204, 204, 204, 204, 204, 204, 429]);
    expect(JSON.parse(results[6].body)).toMatchObject({ code: 'IP_RATE_LIMITED' });
  }, 240_000);

  it('업데이트 뒤 소개 페이지가 응답하지 않으면 실패하고 알림 메일이 간다', async () => {
    const current = await prepareDeployment(deployment!, true);
    const landing = await readFile(path.join(current.directory, 'pusher/nginx/landing.conf'), 'utf8');
    await pushUpdate(current, {
      'nginx/landing.conf': landing.replace('try_files /index.html =404;', 'return 503;'),
    });

    const update = await runUpdate(current);

    expectOperationalAlert(update, '업데이트 실패: 원인을 고친 커밋을 올린 뒤 deploy/update.sh --retry 를 돌려 주세요');
    expect(update.stderr).toContain('응답 확인에 실패했어요');
    expect((await readFile(path.join(current.directory, 'clone/.maintenance'), 'utf8')).trim()).toBe('update');
    expect(await runningServices(current)).toEqual(['api', 'db', 'nginx']);
    expect(await getHealth(current)).toMatchObject({ code: 0, stdout: '{"status":"ok"}' });
    const page = await runCompose(current, ['exec', '-T', 'nginx', 'wget', '-qO-', 'http://127.0.0.1/']);
    expect(page.code).not.toBe(0);
    expect(update.stdout).not.toContain('업데이트를 마쳤어요');
  }, 420_000);

  it('실패한 업데이트는 고친 커밋을 올리고 retry하면 서비스가 돌아오고 표시가 지워진다', async () => {
    const current = await prepareDeployment(deployment!, true);
    const clone = path.join(current.directory, 'clone');
    const marker = path.join(clone, '.maintenance');
    const compose = await readFile(path.join(current.directory, 'pusher/deploy/test/compose.e2e.yml'), 'utf8');
    await pushUpdate(current, {
      'deploy/test/compose.e2e.yml': compose.replace('  api:\n', '  api:\n    command: ["sh", "-c", "exit 1"]\n'),
    });
    const failedUpdate = await runUpdate(current);
    expectOperationalAlert(
      failedUpdate,
      '업데이트 실패: 원인을 고친 커밋을 올린 뒤 deploy/update.sh --retry 를 돌려 주세요',
    );
    expect(failedUpdate.stderr).toContain('응답 확인에 실패했어요');
    const failedMarker = await readFile(marker, 'utf8');
    expect(failedMarker.trim()).toBe('update');
    expect(await runningServices(current)).toEqual(['db', 'nginx']);
    const failedHead = await runGit(clone, ['rev-parse', 'HEAD']);
    await pushUpdate(current, { 'deploy/test/compose.e2e.yml': compose });

    const withoutRetry = await runUpdate(current);

    expect(withoutRetry).toMatchObject({ code: 1 });
    expect(withoutRetry.stderr).toContain('점검 중이라 업데이트하지 않아요(표시: update)');
    expect(`${withoutRetry.stdout}\n${withoutRetry.stderr}`).not.toContain('[Client Review 알림]');
    expect(await readFile(marker, 'utf8')).toBe(failedMarker);
    expect(await runGit(clone, ['rev-parse', 'HEAD'])).toBe(failedHead);
    expect(await runningServices(current)).toEqual(['db', 'nginx']);

    await expectSuccessfulUpdate(current, await runUpdate(current, true));
  }, 420_000);

  it('컨테이너를 다시 만들다 실패한 업데이트도 고친 커밋을 올리고 retry하면 서비스가 돌아온다', async () => {
    const current = await prepareDeployment(deployment!, true);
    const dockerfile = await readFile(path.join(current.directory, 'pusher/api/Dockerfile'), 'utf8');
    await pushUpdate(current, { 'api/Dockerfile': `${dockerfile}\nRUN false\n` });

    const failedUpdate = await runUpdate(current);

    expectOperationalAlert(
      failedUpdate,
      '업데이트 실패: 원인을 고친 커밋을 올린 뒤 deploy/update.sh --retry 를 돌려 주세요',
    );
    expect(`${failedUpdate.stdout}\n${failedUpdate.stderr}`).toMatch(/(?:RUN false|\/bin\/sh -c false)/);
    expect(failedUpdate.stderr).not.toContain('응답 확인에 실패했어요');
    expect(failedUpdate.stdout).not.toContain('업데이트를 마쳤어요');
    expect((await readFile(path.join(current.directory, 'clone/.maintenance'), 'utf8')).trim()).toBe('update');
    await pushUpdate(current, { 'api/Dockerfile': dockerfile });

    await expectSuccessfulUpdate(current, await runUpdate(current, true));
  }, 420_000);

  it('업데이트 표시가 없으면 retry는 거부된다', async () => {
    const current = await prepareDeployment(deployment!, true);
    const clone = path.join(current.directory, 'clone');
    const originalHead = await runGit(clone, ['rev-parse', 'HEAD']);
    await pushUpdate(current, { 'landing/update-check.txt': randomUUID() });

    // 서비스 실행 여부와 관계없이 update 표시가 없으면 재시도를 허용하지 않는다.
    for (const stopApi of [false, true]) {
      if (stopApi) expect(await runCompose(current, ['stop', 'api'])).toMatchObject({ code: 0 });
      const servicesBefore = await runningServices(current);

      const retry = await runUpdate(current, true);

      expect(retry).toMatchObject({ code: 1 });
      expect(retry.stderr).toContain('실패한 업데이트가 없어요(표시: 없음)');
      expect(`${retry.stdout}\n${retry.stderr}`).not.toContain('[Client Review 알림]');
      await expect(stat(path.join(clone, '.maintenance'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await runGit(clone, ['rev-parse', 'HEAD'])).toBe(originalHead);
      expect(await runningServices(current)).toEqual(servicesBefore);
    }
  }, 420_000);

  it('손작업 end가 api를 켜지 못하면 표시가 남고 다시 end하면 켜진다', async () => {
    const current = await prepareDeployment(deployment!);
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
