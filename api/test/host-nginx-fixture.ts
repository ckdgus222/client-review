import { execFile } from 'node:child_process';
import { createHash, createPublicKey, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

export const repo = path.resolve(import.meta.dirname, '../..');
export const domain = 'review.example.test';
export const neighbor = 'neighbor.example.test';
export const run = promisify(execFile);
export const renderArgs = [
  path.join(repo, 'nginx/host/render.py'),
  '--domain',
  domain,
  '--cert-name',
  'fixture',
  '--release-root',
  '/srv/review',
  '--acme-root',
  '/srv/acme',
  '--api-port',
  '4100',
  '--http-port',
  '18080',
  '--https-port',
  '18443',
];
export const render = async (mode: string) => (await run('python3', [...renderArgs, '--mode', mode])).stdout;
export const createSite = async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'review-host-site-')));
  const name = 'cr-host-fixture-' + randomUUID();
  const conf = path.join(directory, 'conf');
  const root = path.join(directory, 'www');
  const cert = path.join(directory, 'fullchain.pem');
  const key = path.join(directory, 'privkey.pem');
  const sandbox = path.join(directory, 'repo');
  await Promise.all([
    mkdir(conf),
    mkdir(path.join(root, 'releases'), { recursive: true }),
    mkdir(path.join(sandbox, 'deploy'), { recursive: true }),
  ]);
  await cp(path.join(repo, 'deploy/static-release.py'), path.join(sandbox, 'deploy/static-release.py'));
  await run('git', ['init', '-q', sandbox]);
  const git = async (...args: string[]) =>
    (
      await run('git', [
        '-C',
        sandbox,
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=test@example.test',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ])
    ).stdout.trim();
  let started = false;
  const release = async (command: string) => {
    const result = await run('python3', [path.join(sandbox, 'deploy/static-release.py'), command, root]);
    if (started && command !== 'prepare' && process.platform === 'darwin') {
      // VirtioFS can cache a renamed symlink until the Linux guest enumerates its parent.
      await run('docker', ['exec', name, 'ls', '-la', '/srv/review']);
    }
    return result;
  };
  const newRelease = async (label: string) => {
    await git('commit', '--allow-empty', '-qm', label);
    const id = await git('rev-parse', 'HEAD');
    const files = path.join(root, 'releases', id);
    await mkdir(path.join(files, 'app/assets'), { recursive: true });
    const home = '<title>client-review: 외주 작업 검수</title><link rel="stylesheet" href="/landing.css">';
    const app =
      '<meta charset="utf-8"><p id="revision"></p><script src="/app/assets/' +
      label +
      '.js"></script><link rel="stylesheet" href="/app/assets/' +
      label +
      '.css">';
    for (const file of ['index.html', 'terms.html', 'privacy.html', '404.html'])
      await writeFile(path.join(files, file), home);
    await writeFile(path.join(files, 'app/index.html'), app);
    await writeFile(path.join(files, 'landing.css'), 'body { color: black; }');
    await writeFile(path.join(files, 'app/assets', label + '.css'), '/* ' + label + ' */ body { color: black; }');
    await writeFile(
      path.join(files, 'app/assets', label + '.js'),
      'document.querySelector("#revision").textContent = ' + JSON.stringify(label),
    );
    return files;
  };
  let port = '';
  const getPort = async (container: string) =>
    (await run('docker', ['port', container, '18443/tcp'])).stdout.trim().split(':').at(-1)!;
  const url = (host = domain) => 'https://' + host + ':' + port;
  const http = async (route: string, args: string[] = [], host = domain) => {
    const raw = (
      await run(
        'curl',
        [
          '-q',
          '--silent',
          '--show-error',
          '--max-time',
          '20',
          '--noproxy',
          '*',
          '--resolve',
          host + ':' + port + ':127.0.0.1',
          '--cacert',
          cert,
          '-w',
          '\n%{http_code}',
          ...args,
          url(host) + route,
        ],
        { maxBuffer: 4 * 1024 * 1024 },
      )
    ).stdout;
    const line = raw.lastIndexOf('\n');
    return { status: Number(raw.slice(line + 1)), body: raw.slice(0, line) };
  };
  const waitStatus = async (status: number, route = '/') => {
    for (let i = 0; i < 80; i++) {
      if ((await http(route).catch(() => undefined))?.status === status) return;
      await delay(250);
    }
    throw Error('Expected HTTP ' + status + ' from ' + route);
  };
  const start = async (mode: string, networkContainer?: string) => {
    await run('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=' + domain,
      '-addext',
      'subjectAltName=DNS:' + domain + ',DNS:' + neighbor,
      '-keyout',
      key,
      '-out',
      cert,
    ]);
    await writeFile(path.join(conf, 'review.conf'), await render(mode));
    await writeFile(
      path.join(conf, 'neighbor.conf'),
      `server {
      listen 18443 ssl; server_name ${neighbor};
      ssl_certificate /etc/letsencrypt/live/fixture/fullchain.pem;
      ssl_certificate_key /etc/letsencrypt/live/fixture/privkey.pem;
      location / { return 200 'neighbor fixture'; }
    }`,
    );
    await run('docker', [
      'run',
      '-d',
      '--name',
      name,
      ...(networkContainer ? ['--network', 'container:' + networkContainer] : ['-p', '127.0.0.1::18443']),
      '-v',
      conf + ':/etc/nginx/conf.d:ro',
      '-v',
      cert + ':/etc/letsencrypt/live/fixture/fullchain.pem:ro',
      '-v',
      key + ':/etc/letsencrypt/live/fixture/privkey.pem:ro',
      '-v',
      root + ':/srv/review:ro',
      'nginx:1.30-alpine',
    ]);
    started = true;
    port = await getPort(networkContainer ?? name);
    await waitStatus(mode === 'maintenance' ? 503 : 200);
  };
  const reload = async (config: string) => {
    await writeFile(path.join(conf, 'review.conf'), config);
    await run('docker', ['exec', name, 'nginx', '-t']);
    await run('docker', ['exec', name, 'nginx', '-s', 'reload']);
  };
  const spki = async () =>
    createHash('sha256')
      .update(createPublicKey(await readFile(cert)).export({ type: 'spki', format: 'der' }))
      .digest('base64');
  const close = async () => {
    const owned = (await run('docker', ['ps', '-aq', '--filter', 'name=^/' + name + '$'])).stdout.trim();
    if (owned) await run('docker', ['rm', '-f', owned]);
    await rm(directory, { recursive: true, force: true });
  };
  return {
    directory,
    root,
    name,
    sandbox,
    cert,
    key,
    git,
    release,
    newRelease,
    start,
    reload,
    spki,
    url,
    http,
    waitStatus,
    close,
  };
};
