import { cp, mkdir, readFile, readlink, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createSite, repo, run } from './host-nginx-fixture.js';

const canonical = (html: string) =>
  html.match(/<link\b(?=[^>]*\brel=["']canonical["'])[^>]*\bhref=["']([^"']+)["']/i)?.[1];

describe('공개 공유 릴리스', () => {
  let site: Awaited<ReturnType<typeof createSite>>;
  let sandbox: string;
  let startAttempted = false;
  // Ignore repository routing, signing and author settings inherited from the caller.
  const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(gitEnv, {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Public Sharing Fixture',
    GIT_AUTHOR_EMAIL: 'sharing@example.test',
    GIT_COMMITTER_NAME: 'Public Sharing Fixture',
    GIT_COMMITTER_EMAIL: 'sharing@example.test',
  });
  const git = async (...args: string[]) =>
    (
      await run('git', ['-C', sandbox, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
        env: gitEnv,
      })
    ).stdout.trim();
  const commit = async (message: string) => {
    await git('add', '--all');
    await git('commit', '--allow-empty', '-qm', message);
    return git('rev-parse', 'HEAD');
  };
  const release = async (command: 'prepare' | 'activate' | 'rollback', args: string[] = []) => {
    const result = await run('python3', [path.join(sandbox, 'deploy/static-release.py'), command, site.root, ...args], {
      env: gitEnv,
      timeout: 600_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (startAttempted && command !== 'prepare' && process.platform === 'darwin') {
      // Refresh VirtioFS after an atomic current/previous symlink replacement.
      await run('docker', ['exec', site.name, 'ls', '-la', '/srv/review']);
    }
    return result.stdout.trim();
  };
  const links = async () => ({
    current: await readlink(path.join(site.root, 'current')),
    previous: await readlink(path.join(site.root, 'previous')),
  });
  const published = async () => {
    const home = await site.http('/');
    const demo = await site.http('/app/demo');
    const imageFile = path.join(site.directory, 'response.jpg');
    const imageResponse = await run('curl', [
      '-q',
      '--silent',
      '--show-error',
      '--max-time',
      '20',
      '--noproxy',
      '*',
      '--resolve',
      new URL(site.url()).host + ':127.0.0.1',
      '--cacert',
      site.cert,
      '-o',
      imageFile,
      '-w',
      '%{http_code}\n%{content_type}',
      site.url() + '/share-review-v1.jpg',
    ]);
    expect(home.status).toBe(200);
    expect(demo.status).toBe(200);
    expect(imageResponse.stdout).toBe('200\nimage/jpeg');
    const image = await readFile(imageFile);
    expect(image.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    return { home: home.body, demo: demo.body, image };
  };

  beforeAll(async () => {
    site = await createSite();
    sandbox = path.join(site.directory, 'repo');
    // Copy current worktree bytes, including staged additions, without archiving stale HEAD.
    // Restrict the input to the real public build/deploy paths; never copy .env or the original .git.
    const tracked = await run('git', [
      '-C',
      repo,
      'ls-files',
      '--cached',
      '-z',
      '--',
      'web',
      'landing',
      'nginx',
      'deploy',
    ]);
    for (const relative of new Set(tracked.stdout.split('\0').filter(Boolean))) {
      const destination = path.join(sandbox, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(path.join(repo, relative), destination).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }, 120_000);

  afterAll(async () => {
    if (!site) return;
    try {
      if (startAttempted) await site.close();
    } finally {
      await rm(site.directory, { recursive: true, force: true });
    }
  }, 90_000);

  it('실제 빌드에서 공유 자산을 검증하고 누락 시 기존 공개 버전을 보존한다', async () => {
    const first = await commit('first public sharing release');
    // This invokes the actual git archive -> Docker public-site target -> validator pipeline.
    expect(await release('prepare')).toBe(first);
    const firstFolder = path.join(site.root, 'releases', first);
    const home = await readFile(path.join(firstFolder, 'index.html'), 'utf8');
    const homeUrl = canonical(home);
    expect(homeUrl).toMatch(/^https:\/\/[^/]+\/?$/);
    const preview = await readFile(path.join(firstFolder, 'preview-index.html'), 'utf8');
    const demo = await readFile(path.join(firstFolder, 'app/demo.html'), 'utf8');
    expect(canonical(preview)).toBe(homeUrl);
    expect(canonical(demo)).toBe(new URL('/app/demo', homeUrl).href);
    for (const html of [home, preview, demo]) {
      const imageUrl = html.match(/<meta\b(?=[^>]*\bproperty=["']og:image["'])[^>]*\bcontent=["']([^"']+)["']/i)?.[1];
      expect(imageUrl).toBe(new URL('/share-review-v1.jpg', homeUrl).href);
    }
    expect(home).toMatch(/href=["']\/app\/login["']/);
    expect(preview).not.toMatch(/href=["']\/app\/login["']/);
    for (const page of ['privacy', 'terms']) {
      const html = await readFile(path.join(firstFolder, page + '.html'), 'utf8');
      expect(canonical(html)).toBe(new URL('/' + page, homeUrl).href);
    }
    const image = await readFile(path.join(sandbox, 'landing/share-review-v1.jpg'));
    expect(await readFile(path.join(firstFolder, 'share-review-v1.jpg'))).toEqual(image);
    for (const asset of ['favicon.ico', 'apple-touch-icon.png', 'app/apple-touch-icon.png']) {
      expect((await readFile(path.join(firstFolder, asset))).length).toBeGreaterThan(0);
    }
    await expect(readlink(path.join(site.root, 'current'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await release('activate')).toBe(first);
    startAttempted = true;
    await site.start('preview');
    const firstPublished = await published();
    expect(firstPublished).toEqual({ home: preview, demo, image });

    // Make the next real build visibly different so rollback cannot pass on stale HTTP responses.
    const sourceHome = await readFile(path.join(sandbox, 'landing/index.html'), 'utf8');
    const secondSource = sourceHome.replace('</body>', '<p>public-sharing second release</p>\n</body>');
    expect(secondSource).not.toBe(sourceHome);
    await writeFile(path.join(sandbox, 'landing/index.html'), secondSource);
    const second = await commit('second public sharing release');
    expect(await release('prepare')).toBe(second);
    expect(await readlink(path.join(site.root, 'current'))).toBe('releases/' + first);
    expect(await published()).toEqual(firstPublished);
    expect(await release('activate')).toBe(second);
    const secondPublished = await published();
    expect(secondPublished.home).toContain('public-sharing second release');
    expect(secondPublished.home).not.toBe(firstPublished.home);
    expect(secondPublished.image).toEqual(image);
    const activeLinks = { current: 'releases/' + second, previous: 'releases/' + first };
    expect(await links()).toEqual(activeLinks);

    // Even a previously prepared directory must be revalidated before activation.
    const damaged = await commit('prepared release loses its sharing image');
    expect(await release('prepare')).toBe(damaged);
    await rm(path.join(site.root, 'releases', damaged, 'share-review-v1.jpg'));
    await expect(release('activate')).rejects.toMatchObject({ code: 1 });
    expect(await links()).toEqual(activeLinks);
    expect(await published()).toEqual(secondPublished);

    // A source omission must fail the real Docker build validation, not publish a partial release.
    await rm(path.join(sandbox, 'landing/share-review-v1.jpg'));
    const missing = await commit('source release omits its sharing image');
    await expect(release('prepare')).rejects.toMatchObject({ code: 1 });
    expect(await readdir(path.join(site.root, 'releases'))).not.toContain(missing);
    await expect(release('activate')).rejects.toMatchObject({ code: 1 });
    expect(await links()).toEqual(activeLinks);
    expect(await published()).toEqual(secondPublished);

    // Rollback must validate the requested old release even when HEAD points to the broken source.
    expect(await release('rollback')).toBe(first);
    expect(await links()).toEqual({ current: 'releases/' + first, previous: 'releases/' + second });
    expect(await published()).toEqual(firstPublished);
    expect(await release('rollback', ['--to', second])).toBe(second);
    expect(await links()).toEqual(activeLinks);
    expect(await published()).toEqual(secondPublished);
  }, 2_700_000);
});
