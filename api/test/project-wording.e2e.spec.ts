import { readFile, readlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createSite, repo, run } from './host-nginx-fixture.js';

describe('서비스 소개 문구 전환', () => {
  it('새 커밋을 먼저 받은 뒤 새 제목을 배포하고 이전 화면으로 복원한다', async () => {
    const site = await createSite();
    const checkout = path.join(site.directory, 'repo');
    const remote = path.join(site.directory, 'remote');
    const oldTitle = '<title>client-review: 외주 작업 검수</title>';
    const newTitle = '<title>client-review: 웹사이트 화면 검수·승인</title>';
    const environment = {
      PATH: process.env.PATH,
      HOME: site.directory,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.test',
      GIT_COMMITTER_NAME: 'fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.test',
      COMPOSE_FILE: 'docker-compose.yml:docker-compose.host.yml',
      CURL_CA_BUNDLE: site.cert,
    };
    const git = async (...args: string[]) =>
      (await run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
        cwd: checkout, env: environment, timeout: 15_000,
      })).stdout.trim();

    try {
      // 이전 배포본의 제목 판정을 독립된 fixture로 보관해 얕은 Git 복제에서도 검사한다.
      const oldLib = `site_ready() {
        local body
        body=$(curl -q --noproxy '*' --silent --show-error --fail --max-time 5 \
          --resolve "\${PUBLIC_URL#https://}:127.0.0.1" "$PUBLIC_URL/") || return 1
        [[ "$body" == *'${oldTitle}'* ]]
      }`;
      const newLib = await readFile(path.join(repo, 'deploy/lib.sh'), 'utf8');
      const libFile = path.join(checkout, 'deploy/lib.sh');
      await writeFile(path.join(checkout, 'deploy/old-lib.sh'), oldLib);
      await writeFile(libFile, oldLib);
      await git('add', 'deploy/lib.sh', 'deploy/static-release.py');
      await site.newRelease('previous');
      const oldRevision = await git('rev-parse', 'HEAD');

      // 두 정적 릴리스와 배포 원격은 이 시험 전용 임시 폴더에만 만든다.
      await writeFile(libFile, newLib);
      await git('add', 'deploy/lib.sh');
      const folder = await site.newRelease('candidate');
      const approvedRevision = await git('rev-parse', 'HEAD');
      const candidate = path.join(folder, 'index.html');
      const html = await readFile(candidate, 'utf8');
      await writeFile(candidate, html.replace(oldTitle, newTitle));
      await git('clone', '--bare', checkout, remote);
      await git('remote', 'add', 'origin', remote);
      await git('checkout', '-q', '--detach', oldRevision);
      expect(await readFile(libFile, 'utf8')).toBe(oldLib);
      await site.release('prepare');
      await site.release('activate');
      const dockerHost =
        process.env.DOCKER_HOST ??
        (await run('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'])).stdout.trim();
      await site.start('preview');
      expect(await site.http('/')).toMatchObject({ status: 200, body: expect.stringContaining(oldTitle) });
      const env = { ...environment, PUBLIC_URL: site.url() };
      await run('bash', ['-ec', 'source deploy/lib.sh; site_ready'], { cwd: checkout, env });

      // macOS에서도 실제 OS 배타 잠금을 유지하며 새 셸과 배포 스크립트를 실행한다.
      const result = await run(
        'python3',
        [
          '-c',
          `
import fcntl
import subprocess
import sys
with open('.maintenance.lock', 'a') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    subprocess.run(['bash', '-eu', '-c', sys.argv[1]], check=True)
`,
          `
test ! -e .maintenance
test ! -e "$RELEASE_ROOT/.update-baseline"
test "$(git rev-parse HEAD)" = "$OLD_REVISION"
test "$(readlink "$RELEASE_ROOT/current")" = "releases/$OLD_REVISION"
test -z "$(git status --porcelain --untracked-files=no)"
git fetch -q origin "$APPROVED_REVISION"
test "$(git rev-parse FETCH_HEAD)" = "$APPROVED_REVISION"
git merge --ff-only "$APPROVED_REVISION"
test "$(git rev-parse HEAD)" = "$APPROVED_REVISION"
bash -ec 'source deploy/lib.sh; site_ready'
echo checked-old-with-new-lib
python3 deploy/static-release.py prepare "$RELEASE_ROOT"
test "$(readlink "$RELEASE_ROOT/current")" = "releases/$OLD_REVISION"
python3 deploy/static-release.py activate "$RELEASE_ROOT"
docker exec "$NGINX_CONTAINER" ls -la /srv/review >/dev/null
test "$(readlink "$RELEASE_ROOT/current")" = "releases/$APPROVED_REVISION"
test "$(readlink "$RELEASE_ROOT/previous")" = "releases/$OLD_REVISION"
if bash -ec 'source deploy/old-lib.sh; site_ready'; then
    echo 'old checker unexpectedly accepted the new title' >&2
    exit 1
fi
bash -ec 'source deploy/lib.sh; site_ready'
echo checked-new-with-new-lib
python3 deploy/static-release.py rollback "$RELEASE_ROOT" --to "$OLD_REVISION"
docker exec "$NGINX_CONTAINER" ls -la /srv/review >/dev/null
bash -ec 'source deploy/lib.sh; site_ready'
echo checked-restored-with-new-lib
`,
        ],
        {
          cwd: checkout,
          env: {
            ...env,
            OLD_REVISION: oldRevision,
            APPROVED_REVISION: approvedRevision,
            RELEASE_ROOT: site.root,
            NGINX_CONTAINER: site.name,
            DOCKER_HOST: dockerHost,
          },
          timeout: 30_000,
        },
      );
      expect(result.stdout.match(/^checked-.+$/gm)).toEqual([
        'checked-old-with-new-lib',
        'checked-new-with-new-lib',
        'checked-restored-with-new-lib',
      ]);
      expect(await git('rev-parse', 'HEAD')).toBe(approvedRevision);
      expect(await readlink(path.join(site.root, 'current'))).toBe(`releases/${oldRevision}`);
      expect(await readlink(path.join(site.root, 'previous'))).toBe(`releases/${approvedRevision}`);
      expect(await site.http('/')).toMatchObject({ status: 200, body: expect.stringContaining(oldTitle) });
    } catch (error) {
      // Docker 연결까지 막혔을 때 정리 오류가 원래 실패 원인을 덮지 않게 한다.
      await site.close().catch(() => undefined);
      throw error;
    }
    await site.close();
  }, 60_000);
});
