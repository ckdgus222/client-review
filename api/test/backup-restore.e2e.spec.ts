import { execFile, type ExecFileException } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
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

const runInTools = (deployment: Deployment, args: string[], timeout?: number) =>
  runCommand(
    [
      'run',
      '--rm',
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
