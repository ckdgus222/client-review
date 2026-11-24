import { createHash, randomUUID } from 'node:crypto';
import { readlink, rm, truncate, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createAdmin } from './host-nginx-admin.js';
import { createSite, domain, neighbor, renderArgs, repo, run } from './host-nginx-fixture.js';

describe('호스트 배포', () => {
  let site: Awaited<ReturnType<typeof createSite>>;
  let admin: Awaited<ReturnType<typeof createAdmin>>;
  let api: string;
  let db: string;
  let override: string;
  let drill: string;
  const project = 'cr-host-' + randomUUID();
  const env = {
    ...process.env,
    PUBLIC_URL: 'https://' + domain,
    POSTGRES_PASSWORD: 'fixture',
    DEVELOPER_EMAIL: 'member@example.test',
    SMTP_HOST: '',
    SMTP_PORT: '',
    SMTP_USER: '',
    SMTP_PASS: '',
    MAIL_FROM: '',
    REVIEW_API_PORT: '0',
    COMPOSE_PROFILES: '',
  };
  const compose = (args: string[], host = true) =>
    run(
      'docker',
      [
        'compose',
        '--env-file',
        '/dev/null',
        '-p',
        project,
        '-f',
        path.join(repo, 'docker-compose.yml'),
        ...(host ? ['-f', path.join(repo, 'docker-compose.host.yml')] : []),
        '-f',
        override,
        ...args,
      ],
      { env, timeout: 400_000, maxBuffer: 16 * 1024 * 1024 },
    );
  const sql = async (statement: string) =>
    (
      await run('docker', ['exec', db, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'client_review', '-Atc', statement])
    ).stdout.trim();
  const health = async (command: 'site_ready' | 'api_ready', files: string, host = domain, extra = {}) =>
    run('bash', ['-c', 'source "$1" && ' + command, 'health-test', path.join(repo, 'deploy/lib.sh')], {
      env: {
        ...env,
        PUBLIC_URL: site.url(host),
        CURL_CA_BUNDLE: site.cert,
        COMPOSE_PROJECT_NAME: project + '-drill',
        COMPOSE_FILE: files,
        ...extra,
      },
    });
  const startAdmin = async () => {
    if (!admin) {
      admin = await createAdmin(site);
      await admin.start();
    }
  };
  beforeAll(async () => {
    site = await createSite();
    override = path.join(site.directory, 'test-override.yml');
    drill = path.join(site.directory, 'drill.yml');
    await writeFile(
      override,
      `services:
  db:
    ports: !reset []
  api:
    image: ${project}-api
    environment:
      MAIL_MODE: log
    ports:
      - "127.0.0.1::18443"
`,
    );
    await writeFile(drill, 'services:\n  nginx:\n    image: nginx:1.30-alpine\n');
    await compose(['up', '-d', '--build', 'db', 'api'], false);
    db = (await compose(['ps', '-q', 'db'], false)).stdout.trim();
    const oldApi = (await compose(['ps', '-q', 'api'], false)).stdout.trim();
    const upstream =
      "fetch('http://127.0.0.1:4100/api/health').then(async r => { if (r.status !== 200 || (await r.json()).status !== 'ok') process.exit(1) })";
    for (let attempt = 0; attempt < 80; attempt++) {
      if (
        await run('docker', ['exec', oldApi, 'node', '-e', upstream]).then(
          () => true,
          () => false,
        )
      )
        break;
      await delay(250);
    }
    await run('docker', ['exec', oldApi, 'node', '-e', upstream]);
    await sql("create table host_fixture(marker text); insert into host_fixture values ('before-switch')");
    await run('docker', ['exec', oldApi, 'sh', '-c', 'printf fixture-photo > /data/assets/host-fixture.png']);
    await compose(['up', '-d', '--no-build']);
    api = (await compose(['ps', '-q', 'api'])).stdout.trim();
    db = (await compose(['ps', '-q', 'db'])).stdout.trim();
    await site.newRelease('original');
    await site.release('activate');
    await site.start('live', api);
    await site.waitStatus(200, '/api/health').catch(async (error) => {
      const logs = await run('docker', ['logs', '--tail', '22', api]);
      throw Error(String(error) + '\n' + logs.stdout + '\n' + logs.stderr);
    });
  }, 480_000);

  afterAll(async () => {
    if (!site) return;
    try {
      if (admin) await admin.close();
      if (drill) await run('docker', ['compose', '-p', project + '-drill', '-f', drill, 'down', '-v']);
      await site.close();
    } finally {
      // Select only resources bearing this run’s unique Compose project label.
      const ids = (await run('docker', ['ps', '-aq', '--filter', 'label=com.docker.compose.project=' + project])).stdout
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      if (ids.length) await run('docker', ['rm', '-f', ...ids]);
      for (const kind of ['network', 'volume']) {
        const owned = (
          await run('docker', [kind, 'ls', '-q', '--filter', 'label=com.docker.compose.project=' + project])
        ).stdout
          .trim()
          .split(/\s+/)
          .filter(Boolean);
        if (owned.length) await run('docker', [kind, 'rm', ...owned]);
      }
      const image = (await run('docker', ['image', 'ls', '-q', project + '-api'])).stdout.trim();
      if (image) await run('docker', ['image', 'rm', project + '-api']);
    }
  }, 90_000);

  it('정식 모드의 첨부 권한과 업로드 크기 경계를 지킨다', async () => {
    const owner = randomUUID(),
      outsider = randomUUID(),
      projectId = randomUUID(),
      asset = randomUUID();
    const ownerSid = randomUUID(),
      outsiderSid = randomUUID();
    const hash = (token: string) => createHash('sha256').update(token).digest('hex');
    await sql(`insert into users(id,email,name) values ('${owner}','member@example.test','member'), ('${outsider}','other@example.test','other');
      insert into sessions(user_id,token_hash,expires_at) values ('${owner}','${hash(ownerSid)}',now()+interval '1 hour'), ('${outsider}','${hash(outsiderSid)}',now()+interval '1 hour');
      insert into projects(id,name) values ('${projectId}','isolated');
      insert into project_members(project_id,user_id,role) values ('${projectId}','${owner}','DEVELOPER');
      insert into assets(id,project_id,storage_key,mime,bytes,width,height) values ('${asset}','${projectId}','host-fixture.png','image/png',13,1,1)`);
    const route = '/api/assets/' + asset;
    expect(await site.http(route, ['-b', 'sid=' + ownerSid])).toEqual({ status: 200, body: 'fixture-photo' });
    expect((await site.http(route, ['-b', 'sid=' + outsiderSid])).status).toBe(404);
    expect((await site.http(route)).status).toBe(401);
    const file = path.join(site.directory, 'body.bin');
    await writeFile(file, '');
    const send = () =>
      site.http('/api/issues/' + randomUUID() + '/attachments', [
        '-H',
        'Expect:',
        '-H',
        'Origin: https://' + domain,
        '-H',
        'Content-Type: application/octet-stream',
        '--data-binary',
        '@' + file,
      ]);
    await truncate(file, 21 * 1024 ** 2);
    expect((await send()).status).toBe(401);
    await truncate(file, 21 * 1024 ** 2 + 1);
    expect((await send()).status).toBe(413);
  }, 90_000);

  it('기존 볼륨을 보존하고 백엔드를 루프백에만 연결한다', async () => {
    const mount = async (id: string) => JSON.parse((await run('docker', ['inspect', id])).stdout)[0];
    const apiInfo = await mount(api);
    const dbInfo = await mount(db);
    expect(apiInfo.NetworkSettings.Ports['4100/tcp']).toEqual([
      { HostIp: '127.0.0.1', HostPort: expect.stringMatching(/^\d+$/) },
    ]);
    expect(apiInfo.Mounts).toContainEqual(
      expect.objectContaining({ Name: project + '_assets-data', Destination: '/data/assets' }),
    );
    expect(dbInfo.Mounts).toContainEqual(
      expect.objectContaining({ Name: project + '_db-data', Destination: '/var/lib/postgresql/data' }),
    );
    expect((await compose(['ps', '--status', 'running', '--services'])).stdout.trim().split(/\s+/).sort()).toEqual([
      'api',
      'db',
    ]);
    expect(await sql('select marker from host_fixture')).toBe('before-switch');
    expect((await run('docker', ['exec', api, 'cat', '/data/assets/host-fixture.png'])).stdout).toBe('fixture-photo');
    const config = JSON.parse(
      (
        await run(
          'docker',
          [
            'compose',
            '--env-file',
            '/dev/null',
            '-f',
            path.join(repo, 'docker-compose.yml'),
            '-f',
            path.join(repo, 'docker-compose.host.yml'),
            'config',
            '--format',
            'json',
          ],
          { env: { ...env, REVIEW_API_PORT: '', COMPOSE_PROJECT_NAME: '' } },
        )
      ).stdout,
    );
    expect(config.name).toBe('client-review');
    expect(config.services.api.ports).toEqual([
      expect.objectContaining({ host_ip: '127.0.0.1', target: 4100, published: '14100' }),
    ]);
    expect(config.services.db.ports.every((port: { host_ip: string }) => port.host_ip === '127.0.0.1')).toBe(true);
  });

  it('운영과 복원 연습이 서로의 상태 응답을 사용하지 않는다', async () => {
    const host = 'docker-compose.yml:docker-compose.host.yml';
    await health('site_ready', host);
    await health('api_ready', host);
    await expect(health('api_ready', host, neighbor)).rejects.toThrow();
    await expect(health('site_ready', host, neighbor)).rejects.toThrow();
    await expect(health('api_ready', host, domain, { CURL_CA_BUNDLE: '/no-such-fixture-ca' })).rejects.toThrow();
    // The host is healthy, but a rehearsal without its own gateway must fail.
    await expect(health('site_ready', drill)).rejects.toThrow();
    await run('docker', ['compose', '-p', project + '-drill', '-f', drill, 'up', '-d']);
    const drillGateway = (
      await run('docker', ['compose', '-p', project + '-drill', '-f', drill, 'ps', '-q', 'nginx'])
    ).stdout.trim();
    await run('docker', [
      'exec',
      drillGateway,
      'sh',
      '-c',
      'mkdir -p /usr/share/nginx/html/api; printf drill > /usr/share/nginx/html/api/health',
    ]);
    await health('site_ready', drill, neighbor);
    await health('api_ready', drill, neighbor);
  }, 60_000);

  it('한 사이트의 점검과 실패가 다른 사이트를 중지하지 않는다', async () => {
    await startAdmin();
    await admin.apply('reload');
    const healthy = async () => expect(await admin.http(neighbor)).toBe('neighbor fixture\n200');
    await healthy();
    const maintenance = await admin.render('maintenance');
    await admin.put(maintenance, admin.candidate);
    await admin.exec('chmod', '666', admin.candidate);
    await expect(admin.apply('apply', 'review')).rejects.toMatchObject({
      stderr: expect.stringContaining('root-owned'),
    });
    expect(await admin.http(domain, '/api/health')).toBe('{"status":"ok"}\n200');
    await admin.exec('chmod', '644', admin.candidate);
    await admin.apply('apply', 'review');
    expect(await admin.http(domain)).toMatch(/\n503$/);
    await healthy();

    await admin.put('not_valid_nginx_directive;', admin.candidate);
    await expect(admin.apply('apply', 'review')).rejects.toThrow();
    expect((await admin.exec('cat', admin.active)).stdout).toBe(maintenance);
    expect(await admin.http(domain)).toMatch(/\n503$/);
    await healthy();
    const preview = await admin.render('preview');
    await admin.put(preview, admin.candidate);
    await admin.apply('apply', 'review');
    expect(await admin.http(domain, '/api/health')).toBe('{"status":"ok"}\n200');
    // Model the signal asynchronously returning before nginx accepts the new configuration.
    // A healthy response from the previous workers must not validate a broken upstream.
    await admin.put(
      '#!/bin/sh\n[ "$*" = "reload nginx" ] || exit 2\n(sleep 0.5; nginx -s reload) </dev/null >/dev/null 2>&1 &\n',
      '/usr/bin/systemctl',
    );
    await admin.exec('chmod', '755', '/usr/bin/systemctl');
    const brokenUpstream = preview.replaceAll('127.0.0.1:4100', '127.0.0.1:4101');
    await admin.put(brokenUpstream, admin.candidate);
    await expect(admin.apply('apply', 'review')).rejects.toThrow();
    expect((await admin.exec('cat', admin.active)).stdout).toBe(preview);
    expect(await admin.http(domain, '/api/health')).toBe('{"status":"ok"}\n200');
    await healthy();

    // Simulate power loss after replacing the file but before retiring the rollback journal.
    const pending = '/etc/nginx/host-ops/pending';
    await admin.exec('mkdir', pending);
    await admin.put('review\n', pending + '/site');
    await admin.put(preview, pending + '/previous.conf');
    await admin.put('not_valid_nginx_directive;', admin.active);
    await admin.apply('recover');
    await admin.apply('recover');
    expect((await admin.exec('cat', admin.active)).stdout).toBe(preview);
    await admin.exec('nginx', '-t');
    await admin.apply('reload');
    expect(await admin.http(domain, '/api/health')).toBe('{"status":"ok"}\n200');
    await healthy();
  }, 420_000);

  it('겹친 작업은 이전 릴리스와 잠금 상태를 보존한다', async () => {
    // The certificate callback must share the same lock as site configuration changes.
    // Wait until the callback has reached its blocking flock child before releasing the holder.
    await startAdmin();
    await admin.exec(
      'bash',
      '-ec',
      `mkdir -p /run/host-nginx
      exec 8>/run/host-nginx/apply.lock
      flock -x 8
      /bin/bash /apply.sh reload 8>&- &
      worker=$!
      trap 'flock -u 8' EXIT
      queued=false
      for i in {1..100}; do
        for child in $(cat /proc/$worker/task/$worker/children); do
          if [ "$(cat /proc/$child/comm 2>/dev/null)" = flock ]; then queued=true; break 2; fi
        done
        sleep .05
      done
      "$queued"
      kill -0 "$worker"
      flock -u 8
      wait "$worker"`,
    );
    const original = await readlink(path.join(site.root, 'current'));
    const result = await run('docker', [
      'run',
      '--rm',
      '--network',
      'none',
      '-v',
      path.join(repo, 'deploy') + ':/source:ro',
      '-v',
      site.root + ':/srv/review:ro',
      '-e',
      'COMPOSE_FILE=docker-compose.yml:docker-compose.host.yml',
      '-e',
      'REVIEW_RELEASE_ROOT=/srv/review',
      'node:24-bookworm-slim',
      'bash',
      '-ec',
      `mkdir -p /work/deploy
      cp /source/lib.sh /source/update.sh /work/deploy/
      cd /work
      echo 'restore in-progress' > .maintenance
      source deploy/lib.sh
      take_lock
      if bash deploy/update.sh 9>&- >/tmp/update-result 2>&1; then exit 1; fi
      cat /tmp/update-result
      cat .maintenance
      readlink /srv/review/current
      flock -u 9
      bash -ec 'source /work/deploy/lib.sh; take_lock'`,
    ]);
    expect(result.stdout).toContain('다른 운영 스크립트');
    expect(result.stdout.trim().split('\n').slice(-2)).toEqual(['restore in-progress', original]);
  }, 60_000);

  it('유효하지 않은 설정과 비공개 파일을 배포하지 않는다', async () => {
    for (const [flag, value] of [
      ['--domain', 'bad domain'],
      ['--cert-name', '../lineage'],
      ['--api-port', '65536'],
      ['--api-port', '80'],
      ['--release-root', '/etc/example'],
      ['--acme-root', '/home/example'],
      ['--release-root', '/srv/acme'],
      ['--release-root', 'relative/path'],
    ]) {
      await expect(run('python3', [...renderArgs, flag, value])).rejects.toThrow();
    }
    const original = await readlink(path.join(site.root, 'current'));
    const files = await site.newRelease('not-public');
    for (const suffix of ['js', 'css', 'woff2']) {
      const missing = await site.http('/app/missing.' + suffix);
      expect(missing.status).toBe(404);
      expect(missing.body).not.toContain('/app/assets/original.js');
    }
    for (const relative of ['.env', 'app/assets/backup.json']) {
      const file = path.join(files, relative);
      await writeFile(file, 'synthetic private marker');
      await expect(site.release('activate')).rejects.toThrow();
      expect(await readlink(path.join(site.root, 'current'))).toBe(original);
      const response = await site.http('/' + relative);
      expect(response.status).toBe(404);
      expect(response.body).not.toContain('synthetic private marker');
      await rm(file);
    }
  });

  it('빌드 산출물을 nginx 실행 계정이 읽을 수 있다', async () => {
    const before = await site.http('/app/demo');
    expect(before.status).toBe(200);
    const previous = await readlink(path.join(site.root, 'current'));
    const build = await site.newRelease('restricted');
    await run('find', [build, '-type', 'd', '-exec', 'chmod', '0700', '{}', '+']);
    await run('find', [build, '-type', 'f', '-exec', 'chmod', '0600', '{}', '+']);
    // Check access on native Linux inodes as well as the live bind mount used by Docker Desktop.
    const readAsWorker = async (destination: string) => {
      await run('docker', ['cp', build, site.name + ':' + destination]);
      return run('docker', ['exec', '--user', 'nginx', site.name, 'cat', destination + '/app/index.html']);
    };
    await expect(readAsWorker('/tmp/release-before-prepare')).rejects.toMatchObject({
      stderr: expect.stringContaining('Permission denied'),
    });
    await site.release('prepare');
    expect((await readAsWorker('/tmp/release-after-prepare')).stdout).toContain('/app/assets/restricted.js');
    expect(await readlink(path.join(site.root, 'current'))).toBe(previous);
    await site.release('activate');
    try {
      const demo = await site.http('/app/demo');
      expect(demo.status).toBe(200);
      expect(demo.body).toContain('/app/assets/restricted.js');
      expect(demo.body).toContain('/app/assets/restricted.css');
      expect(await site.http('/app/assets/restricted.js')).toMatchObject({
        status: 200, body: expect.stringContaining('textContent = "restricted"'),
      });
      expect(await site.http('/app/assets/restricted.css')).toMatchObject({
        status: 200, body: expect.stringContaining('/* restricted */'),
      });
    } finally {
      await site.release('rollback');
    }
    expect(await readlink(path.join(site.root, 'current'))).toBe(previous);
    expect(await site.http('/app/demo')).toEqual(before);
  }, 30_000);
});
