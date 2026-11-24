import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repositoryDirectory = path.resolve(import.meta.dirname, '../..');
type CommandResult = { code: number; stdout: string; stderr: string };

describe('호스트 업데이트', () => {
  it('새 화면 확인 실패 시 기존 링크와 update 표시를 보존하고 retry 성공 후 표시를 지운다', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'review-host-update-'));
    const remote = path.join(directory, 'remote');
    const checkout = path.join(directory, 'checkout');
    const releases = path.join(directory, 'static');
    const bin = path.join(directory, 'bin');
    // 사용자 Git 설정·운영 환경·메일 설정을 물려받지 않는다. DB도 파일 기반 합성 데이터만 쓴다.
    const environment = {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: directory,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.test',
      GIT_COMMITTER_NAME: 'fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.test',
      COMPOSE_FILE: 'docker-compose.yml:docker-compose.host.yml',
      PUBLIC_URL: 'https://review.example.test',
      REVIEW_RELEASE_ROOT: releases,
      HEALTH_WAIT_SECONDS: '0',
      MAIL_MODE: 'log',
      FIXTURE_ROOT: directory,
    };
    const run = (command: string, args: string[], cwd = checkout, input?: string): Promise<CommandResult> =>
      new Promise((resolve, reject) => {
        const child = execFile(command, args, { cwd, env: environment, timeout: 15_000 }, (error, stdout, stderr) => {
          if (error && (typeof error.code !== 'number' || error.killed)) return reject(error);
          resolve({ code: error?.code ?? 0, stdout, stderr });
        });
        child.stdin!.on('error', reject);
        child.stdin!.end(input);
      });
    const git = async (args: string[], cwd = remote, input?: string) => {
      const result = await run('git', ['-c', 'core.hooksPath=/dev/null', ...args], cwd, input);
      expect(result, `fixture git ${args[0]}`).toMatchObject({ code: 0 });
      return result.stdout.trim();
    };

    try {
      await mkdir(remote);
      await mkdir(bin);
      await mkdir(path.join(releases, 'releases'), { recursive: true });
      await writeFile(path.join(directory, 'db.json'), '{"projects":[{"id":"synthetic-project"}]}');
      const databaseBefore = await readFile(path.join(directory, 'db.json'), 'utf8');

      // 임시 저장소의 합성 이력만 만든다. add·commit·push나 사용자 작업 트리는 쓰지 않는다.
      await git(['init', '-q', '--initial-branch=main']);
      const tree = await git(['mktree'], remote, '');
      const oldRevision = await git(['commit-tree', tree, '-m', 'old']);
      const failedRevision = await git(['commit-tree', tree, '-p', oldRevision, '-m', 'broken page']);
      const brokenRetryRevision = await git(['commit-tree', tree, '-p', failedRevision, '-m', 'broken retry page']);
      const fixedRevision = await git(['commit-tree', tree, '-p', brokenRetryRevision, '-m', 'fixed page']);
      await git(['update-ref', 'refs/heads/main', oldRevision]);
      await git(['clone', '-q', '--no-hardlinks', remote, checkout], directory);
      await mkdir(path.join(checkout, 'deploy'));
      for (const file of ['update.sh', 'lib.sh', 'static-release.py']) {
        await copyFile(path.join(repositoryDirectory, 'deploy', file), path.join(checkout, 'deploy', file));
      }

      // 빌드된 릴리스를 준비하고 실제 prepare 검사·activate·rollback을 실행한다.
      for (const [revision, title] of [
        [oldRevision, 'client-review: 외주 작업 검수'],
        [failedRevision, 'broken page'],
        [brokenRetryRevision, 'broken page'],
        [fixedRevision, 'client-review: 웹사이트 화면 검수·승인'],
      ]) {
        const site = path.join(releases, 'releases', revision);
        await mkdir(path.join(site, 'app/assets'), { recursive: true });
        const html = `<title>${title}</title><link rel="stylesheet" href="/landing.css"><p>${revision}</p>`;
        for (const file of ['index.html', 'privacy.html', 'terms.html', '404.html']) {
          await writeFile(path.join(site, file), html);
        }
        await writeFile(path.join(site, 'landing.css'), 'body { color: black; }');
        await writeFile(path.join(site, 'app/index.html'), '<script src="/app/assets/main.js"></script>');
        await writeFile(path.join(site, 'app/assets/main.js'), 'console.log("fixture");');
        await writeFile(path.join(site, 'app/assets/main.css'), 'body { color: black; }');
      }
      await symlink(`releases/${oldRevision}`, path.join(releases, 'current'));

      // Docker·curl 대역은 네트워크를 쓰지 않고 예상 밖 호출은 거부한다.
      // macOS에도 있는 Python의 OS 잠금으로 flock이 받는 파일 서술자 9를 잠근다.
      await writeFile(
        path.join(bin, 'fixture.py'),
        `#!/usr/bin/env python3
import fcntl
import json
import os
import sys
from pathlib import Path

root = Path(os.environ['FIXTURE_ROOT'])
args = sys.argv[1:]
command = Path(sys.argv[0]).name
if command == 'flock':
    assert args == ['-n', '9'], args
    fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)
    sys.exit(0)
if command == 'docker':
    with (root / 'docker.jsonl').open('a') as log:
        log.write(json.dumps(args) + '\\n')
    if args in [['compose', 'ps', '-q', '--status', 'running', service] for service in ['db', 'api']]:
        assert json.loads((root / 'db.json').read_text())['projects']
        print('fixture-' + args[-1])
        sys.exit(0)
    if args == ['compose', 'up', '-d', '--build']:
        sys.exit(0)
    if args[:9] == ['compose', 'run', '--rm', '--no-deps', '-T', 'api', 'npm', 'run', '--silent']:
        assert args[9:11] == ['send-alert', '--'], args
        with (root / 'alerts.txt').open('a') as log:
            log.write(args[11] + '\\n')
        sys.exit(0)
    raise RuntimeError('unexpected docker call: ' + repr(args))
if command == 'curl':
    assert args[:8] == ['-q', '--noproxy', '*', '--silent', '--show-error', '--fail', '--max-time', '5'], args
    assert args[8:11] == ['--resolve', 'review.example.test:443:127.0.0.1', '-D'], args
    url = args[-1]
    assert url in ['https://review.example.test/', 'https://review.example.test/api/health'], url
    current = Path(os.environ['REVIEW_RELEASE_ROOT']) / 'current'
    with (root / 'requests.jsonl').open('a') as log:
        log.write(json.dumps({'url': url, 'release': os.readlink(current)}) + '\\n')
    interrupted = root / 'interrupt-fixture-update.pid'
    if url.endswith('/') and interrupted.exists():
        pid = int(interrupted.read_text())
        interrupted.unlink()
        os.kill(pid, 9)
        sys.exit(1)
    Path(args[11]).write_text('HTTP/1.1 200 OK\\r\\nX-Client-Review-Site: client-review\\r\\n\\r\\n')
    print('{"status":"ok"}' if url.endswith('/api/health') else (current / 'index.html').read_text())
    sys.exit(0)
raise RuntimeError('unexpected fixture command')
`,
        { mode: 0o755 },
      );
      for (const command of ['docker', 'curl', 'flock']) {
        await symlink('fixture.py', path.join(bin, command));
      }

      await git(['update-ref', 'refs/heads/main', failedRevision]);
      const failed = await run('bash', ['deploy/update.sh']);

      expect(failed).toMatchObject({ code: 1 });
      expect(failed.stderr).toContain('새 정적 화면 확인 실패');
      expect(failed.stdout).not.toContain('업데이트를 마쳤어요');
      expect(await git(['rev-parse', 'HEAD'], checkout)).toBe(failedRevision);
      expect(await readlink(path.join(releases, 'current'))).toBe(`releases/${oldRevision}`);
      expect(await readFile(path.join(releases, 'current/index.html'), 'utf8')).toContain(oldRevision);
      expect(await readFile(path.join(checkout, '.maintenance'), 'utf8')).toBe('update\n');
      expect(await readFile(path.join(directory, 'alerts.txt'), 'utf8')).toContain('업데이트 실패:');
      const failedRequests = (await readFile(path.join(directory, 'requests.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(failedRequests).toEqual([
        { url: 'https://review.example.test/api/health', release: `releases/${oldRevision}` },
        { url: 'https://review.example.test/', release: `releases/${failedRevision}` },
      ]);

      // 복구된 옛 제목도 실제 사이트 점검을 통과해야 한다.
      const restored = await run('bash', ['-c', 'source deploy/lib.sh; site_ready']);
      expect(restored).toMatchObject({ code: 0 });

      const baselineFile = path.join(releases, '.update-baseline');
      expect((await readFile(baselineFile, 'utf8')).trim()).toBe(`releases/${oldRevision}`);
      // Stop our own isolated Bash process after the new 'current' is visible but before its health check returns.
      await expect(
        run('bash', [
          '-c',
          'echo "$$" > "$FIXTURE_ROOT/interrupt-fixture-update.pid"; exec bash deploy/update.sh --retry',
        ]),
      ).rejects.toMatchObject({ signal: 'SIGKILL' });
      expect(await readlink(path.join(releases, 'current'))).toBe(`releases/${failedRevision}`);
      expect((await readFile(baselineFile, 'utf8')).trim()).toBe(`releases/${oldRevision}`);
      expect(await readFile(path.join(checkout, '.maintenance'), 'utf8')).toBe('update\n');
      // The remote is intentionally unavailable on the first retry after interruption.
      // Even though git pull fails, the pre-update screen must already be back online.
      await git(['remote', 'set-url', 'origin', path.join(directory, 'unavailable-remote')], checkout);
      const unavailable = await run('bash', ['deploy/update.sh', '--retry']);
      expect(unavailable.code).not.toBe(0);
      expect(unavailable.stderr).toContain('unavailable-remote');
      expect(await git(['rev-parse', 'HEAD'], checkout)).toBe(failedRevision);
      expect(await readlink(path.join(releases, 'current'))).toBe(`releases/${oldRevision}`);
      expect((await readFile(baselineFile, 'utf8')).trim()).toBe(`releases/${oldRevision}`);
      expect(await readFile(path.join(checkout, '.maintenance'), 'utf8')).toBe('update\n');
      await git(['remote', 'set-url', 'origin', remote], checkout);
      // A second bad commit still rolls back to the same original release.
      await git(['update-ref', 'refs/heads/main', brokenRetryRevision]);
      const failedRetry = await run('bash', ['deploy/update.sh', '--retry']);
      expect(failedRetry).toMatchObject({ code: 1, stderr: expect.stringContaining('새 정적 화면 확인 실패') });
      expect(await git(['rev-parse', 'HEAD'], checkout)).toBe(brokenRetryRevision);
      expect(await readlink(path.join(releases, 'current'))).toBe(`releases/${oldRevision}`);
      expect((await readFile(baselineFile, 'utf8')).trim()).toBe(`releases/${oldRevision}`);
      expect(await readFile(path.join(checkout, '.maintenance'), 'utf8')).toBe('update\n');

      await git(['update-ref', 'refs/heads/main', fixedRevision]);
      const blocked = await run('bash', ['deploy/update.sh']);
      expect(blocked).toMatchObject({ code: 1 });
      expect(blocked.stderr).toContain('점검 중이라 업데이트하지 않아요(표시: update)');
      expect(await git(['rev-parse', 'HEAD'], checkout)).toBe(brokenRetryRevision);
      expect(await readlink(path.join(releases, 'current'))).toBe(`releases/${oldRevision}`);
      expect(await readFile(path.join(checkout, '.maintenance'), 'utf8')).toBe('update\n');

      const retry = await run('bash', ['deploy/update.sh', '--retry']);
      expect(retry).toMatchObject({ code: 0 });
      expect(retry.stdout).toContain('업데이트를 마쳤어요');
      expect(await git(['rev-parse', 'HEAD'], checkout)).toBe(fixedRevision);
      expect(await readlink(path.join(releases, 'current'))).toBe(`releases/${fixedRevision}`);
      expect(await readlink(path.join(releases, 'previous'))).toBe(`releases/${oldRevision}`);
      expect(await readFile(path.join(releases, 'current/index.html'), 'utf8')).toContain(fixedRevision);
      await expect(stat(path.join(checkout, '.maintenance'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(baselineFile)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(path.join(directory, 'db.json'), 'utf8')).toBe(databaseBefore);
      expect((await readFile(path.join(directory, 'alerts.txt'), 'utf8')).trim().split('\n')).toHaveLength(3);
      const requests = (await readFile(path.join(directory, 'requests.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(requests).toEqual([
        ...failedRequests,
        { url: 'https://review.example.test/', release: `releases/${oldRevision}` },
        { url: 'https://review.example.test/api/health', release: `releases/${oldRevision}` },
        { url: 'https://review.example.test/', release: `releases/${failedRevision}` },
        { url: 'https://review.example.test/api/health', release: `releases/${oldRevision}` },
        { url: 'https://review.example.test/', release: `releases/${brokenRetryRevision}` },
        { url: 'https://review.example.test/api/health', release: `releases/${oldRevision}` },
        { url: 'https://review.example.test/', release: `releases/${fixedRevision}` },
      ]);
      const dockerCalls = (await readFile(path.join(directory, 'docker.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(dockerCalls.filter((args) => args[1] === 'up')).toEqual([
        ['compose', 'up', '-d', '--build'],
        ['compose', 'up', '-d', '--build'],
        ['compose', 'up', '-d', '--build'],
        ['compose', 'up', '-d', '--build'],
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
