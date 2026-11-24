import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { domain, neighbor, renderArgs, repo, run, type createSite } from './host-nginx-fixture.js';

// systemd itself is unavailable in this isolated container. Its reload callback signals the real nginx master.
export const createAdmin = async (site: Awaited<ReturnType<typeof createSite>>) => {
  const name = site.name + '-admin';
  const donor = name + '-tools';
  const context = path.join(site.directory, 'admin');
  const active = '/etc/nginx/conf.d/review.conf';
  const candidate = '/etc/nginx/host-ops/review.conf';
  const exec = (...args: string[]) => run('docker', ['exec', name, ...args]);
  const copy = async (file: string, dst: string) => {
    await run('docker', ['cp', file, name + ':' + dst]);
    await exec('chown', '0:0', dst);
  };
  const render = async (mode: string) =>
    (await run('python3', [...renderArgs, '--http-port', '80', '--https-port', '443', '--mode', mode])).stdout;
  const apply = (...args: string[]) => exec('/bin/bash', '/apply.sh', ...args);
  const put = async (content: string, dst: string) => {
    const source = path.join(context, path.basename(dst));
    await writeFile(source, content);
    await copy(source, dst);
  };
  const start = async () => {
    await mkdir(context);
    await run('docker', ['build', '-q', '-t', donor, path.join(repo, 'deploy/test')], { timeout: 300_000 });
    await run('docker', ['create', '--name', donor, donor]);
    await run('docker', [
      'run',
      '-d',
      '--name',
      name,
      '--network',
      'none',
      '-e',
      'CURL_CA_BUNDLE=/etc/letsencrypt/live/fixture/fullchain.pem',
      'nginx:1.30-alpine',
      'sleep',
      '600',
    ]);
    for (const binary of ['/bin/bash', '/usr/lib/libreadline.so.8']) {
      const temp = path.join(context, path.basename(binary));
      await run('docker', ['cp', '-L', donor + ':' + binary, temp]);
      await copy(temp, binary);
    }
    await exec(
      'sh',
      '-ec',
      'mkdir -p /etc/nginx/host-ops /etc/letsencrypt/live/fixture /srv/review/current; rm /etc/nginx/conf.d/default.conf; echo ready > /srv/review/current/index.html',
    );
    await copy(site.cert, '/etc/letsencrypt/live/fixture/fullchain.pem');
    await copy(site.key, '/etc/letsencrypt/live/fixture/privkey.pem');
    await copy(path.join(repo, 'nginx/host/apply.sh'), '/apply.sh');
    await put(domain + '\n' + neighbor + '\n', '/etc/nginx/host-ops/domains');
    await put('#!/bin/sh\n[ "$*" = "reload nginx" ] || exit 2\nexec nginx -s reload\n', '/usr/bin/systemctl');
    await exec('chmod', '755', '/usr/bin/systemctl');
    await put(await render('preview'), active);
    await put(
      `server {
      listen 443 ssl; server_name ${neighbor};
      ssl_certificate /etc/letsencrypt/live/fixture/fullchain.pem;
      ssl_certificate_key /etc/letsencrypt/live/fixture/privkey.pem;
      location = /api/health { return 200 '{"status":"ok","db":"up"}'; }
      location / { return 200 'neighbor fixture'; }
    }
    server { listen 127.0.0.1:4100; location / { return 200 '{"status":"ok"}'; } }`,
      '/etc/nginx/conf.d/dogwalk.conf',
    );
    await exec('nginx');
  };
  const http = async (host: string, route = '/') =>
    (
      await exec(
        'curl',
        '-q',
        '--silent',
        '--show-error',
        '--noproxy',
        '*',
        '--resolve',
        host + ':443:127.0.0.1',
        '--cacert',
        '/etc/letsencrypt/live/fixture/fullchain.pem',
        '-w',
        '\n%{http_code}',
        'https://' + host + route,
      )
    ).stdout;
  const close = async () => {
    for (const container of [name, donor]) {
      const id = (await run('docker', ['ps', '-aq', '--filter', 'name=^/' + container + '$'])).stdout.trim();
      if (id) await run('docker', ['rm', '-f', id]);
    }
    if ((await run('docker', ['image', 'ls', '-q', donor])).stdout.trim()) await run('docker', ['image', 'rm', donor]);
  };
  return { start, close, apply, render, exec, http, put, active, candidate };
};
