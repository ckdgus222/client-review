import { createHash, randomUUID } from 'node:crypto';
import { truncate, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createSite, domain, repo, run } from './host-nginx-fixture.js';

describe('호스트 배포', () => {
  let site: Awaited<ReturnType<typeof createSite>>;
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

});
