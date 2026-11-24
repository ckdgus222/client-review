import { test, expect, type HostResponse } from './host-nginx-fixtures.ts'
import { createSite, domain, run as runFixtureCommand } from '../../api/test/host-nginx-fixture';
import { readlink, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';

const expectIpLimited = (response: HostResponse) => {
  expect(response.status).toBe(429)
  expect(response.headers['content-type']).toContain('application/json')
  expect(JSON.parse(response.body)).toEqual({ statusCode: 429, code: 'IP_RATE_LIMITED' })
}

test.describe('공용 nginx', () => {
  test.setTimeout(180_000)

  test('공개 데모에 직접 접속하고 역할을 전환한다', async ({ page, hostNginx }) => {
    const assets: Promise<{ url: string; status: number; contentType: string; body: Buffer }>[] = []
    const revalidated = new Set<string>()
    const apiRequests: string[] = []
    const failures: string[] = []
    page.on('response', (response) => {
      if (/\.(js|css|webp|woff2)(\?|$)/.test(response.url())) {
        if (response.status() === 304) {
          revalidated.add(response.url())
          return
        }
        assets.push(response.body().then((body) => ({
          url: response.url(), status: response.status(), contentType: response.headers()['content-type'], body,
        })))
      }
    })
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/')) apiRequests.push(request.url())
    })
    page.on('requestfailed', (request) => failures.push(request.url()))
    page.on('pageerror', (error) => failures.push(error.message))

    const home = await page.goto(hostNginx.previewOrigin)
    expect(home?.status()).toBe(200)
    expect(await home?.securityDetails()).toMatchObject({ issuer: 'Client Review e2e CA', subjectName: 'review.example.test' })
    await expect(page.getByRole('heading', { name: 'client-review', exact: true })).toBeVisible()
    await page.waitForLoadState('networkidle')
    await page.getByRole('link', { name: '로그인 없이 데모 체험하기', exact: true }).click()
    await expect(page).toHaveURL(`${hostNginx.previewOrigin}/app/demo`)
    await expect(page.getByRole('heading', { name: '오브제 스토어 리뉴얼', exact: true })).toBeVisible()
    await page.waitForLoadState('networkidle')

    for (const pathname of ['/app/demo', '/app/demo/']) {
      expect((await page.goto(`${hostNginx.previewOrigin}${pathname}`))?.status()).toBe(200)
      await expect(page.getByRole('button', { name: '고객(승인자)', exact: true })).toHaveAttribute('aria-pressed', 'true')
      await page.waitForLoadState('networkidle')
    }
    await page.getByRole('button', { name: '구매 버튼 위치 선택', exact: true }).click()
    await page.getByLabel('제목 (필수)').fill('버튼 간격을 넓혀 주세요')
    await page.getByRole('button', { name: '쪽지 남기기', exact: true }).click()
    const note = page.getByRole('list', { name: '쪽지 목록' }).getByRole('listitem').filter({ hasText: '버튼 간격을 넓혀 주세요' })
    await expect(note).toContainText('접수')
    await expect(page.getByRole('button', { name: '수정 시작', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: '개발자', exact: true }).click()
    await expect(page.getByRole('button', { name: '개발자', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('button', { name: '수정 시작', exact: true }).click()
    await expect(note).toContainText('수정 중')
    await page.getByRole('button', { name: '고객(승인자)', exact: true }).click()
    await expect(page.getByRole('button', { name: '1차 게시', exact: true })).toBeDisabled()

    await page.evaluate(() => document.fonts.ready)
    await page.waitForLoadState('networkidle')
    expect(await page.evaluate(() => [...document.fonts].some((font) => font.status === 'loaded'))).toBe(true)
    const images = page.locator('img')
    expect(await images.count()).toBeGreaterThan(0)
    for (const image of await images.all()) {
      await expect(image).toHaveJSProperty('complete', true)
      expect(await image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0)
    }
    const loadedAssets = await Promise.all(assets)
    for (const url of revalidated) {
      expect(loadedAssets.some((asset) => asset.url === url && asset.status === 200), url).toBe(true)
    }
    for (const extension of ['js', 'css', 'webp', 'woff2']) {
      expect(loadedAssets.some((asset) => new URL(asset.url).pathname.endsWith(`.${extension}`)), extension).toBe(true)
    }
    for (const asset of loadedAssets) {
      expect(asset.status, asset.url).toBe(200)
      const body = asset.body
      const extension = new URL(asset.url).pathname.split('.').at(-1)!
      const types: Record<string, RegExp> = {
        js: /(?:javascript|ecmascript)/, css: /text\/css/,
        webp: /image\/webp/, woff2: /(?:font\/woff2|application\/font-woff2)/,
      }
      expect(asset.contentType, asset.url).toMatch(types[extension])
      expect(body.length).toBeGreaterThan(0)
      expect(body.subarray(0, 100).toString()).not.toMatch(/<!doctype html|<html/i)
      if (extension === 'webp') expect(body.subarray(8, 12).toString()).toBe('WEBP')
      if (extension === 'woff2') expect(body.subarray(0, 4).toString()).toBe('wOF2')
    }
    expect(apiRequests).toEqual([])
    expect(failures).toEqual([])
    expect((await page.context().cookies()).filter((cookie) => cookie.name === 'sid')).toEqual([])
  })

  test('공개 문서와 상태 확인만 허용하고 로그인과 쓰기를 보류한다', async ({ hostNginx }) => {
    const allowed = ['/', '/privacy', '/terms', '/app/demo', '/app/demo/', '/robots.txt', '/favicon.svg', '/landing.css', '/api/health']
    for (const method of ['GET', 'HEAD']) {
      const responses = await hostNginx.request(allowed.map((path) => ({ port: 8443, method, path })))
      for (const [index, response] of responses.entries()) {
        expect(response.status, `${method} ${allowed[index]}`).toBe(200)
        expect(response.headers['x-client-review-site']).toBe('client-review')
        if (method === 'HEAD') expect(response.body).toBe('')
      }
      if (method === 'GET') {
        expect(responses[1].body).toContain('개인정보처리방침')
        expect(responses[2].body).toContain('이용약관')
        expect(JSON.parse(responses.at(-1)!.body)).toEqual({ status: 'ok' })
      }
    }
    const blocked = ['/app', '/app/', '/app/login', '/app/projects', '/api/auth/me', '/api/auth/email-code',
      '/api/projects', '/api/assets/example', '/uploads/example.webp', '/api/health/']
    for (const method of ['GET', 'HEAD']) {
      const responses = await hostNginx.request(blocked.map((path) => ({ port: 8443, method, path })))
      expect(responses.map((response) => response.status), method).toEqual(blocked.map(() => 503))
    }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const responses = await hostNginx.request([...allowed, '/api/auth/email-code', '/api/projects'].map((path) => ({
        port: 8443, path, method, body: '{}', headers: { 'Content-Type': 'application/json' },
      })))
      expect(responses.map((response) => response.status), method).toEqual(responses.map(() => 503))
    }
  })

  test('정식 모드의 로그인 요청 제한은 실제 고객 IP별로 적용된다', async ({ hostNginx }) => {
    const firstIp = '127.0.0.2'
    const secondIp = '127.0.0.3'
    const loginRequest = (ip: string, path = '/api/auth/email-code', attempt = 0) => ({
      port: 8444, ip, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: hostNginx.liveOrigin,
        'X-Forwarded-For': `198.51.100.${attempt + 1}`, 'X-Real-IP': '203.0.113.99', 'X-Forwarded-Proto': 'http' },
      body: JSON.stringify({ email: `host-${attempt}@example.test`, privacyAgreed: true }),
    })
    // 여섯 요청은 실제로 동시에 연결한다. 머리글만 바꾸는 방식으로 고객을 나누지 않는다.
    const first = await hostNginx.request(Array.from({ length: 6 }, (_, index) => loginRequest(firstIp, undefined, index)))
    expect(first.map((response) => response.status)).toEqual([204, 204, 204, 204, 204, 204])
    for (const response of first) {
      expect(response.headers).toMatchObject({
        'x-test-client-ip': firstIp, 'x-test-real-ip': firstIp,
        'x-test-host': 'review.example.test', 'x-test-proto': 'https',
      })
    }
    const aliases = ['/api/auth/email-code', '/api/auth/EMAIL-CODE', '/api/auth/email-code/',
      '/api//auth/email-code', '/api/auth/email%2Dcode']
    const limited = await hostNginx.request(aliases.map((path, index) => loginRequest(firstIp, path, index + 10)))
    limited.forEach(expectIpLimited)

    const second = await hostNginx.request(Array.from({ length: 6 }, (_, index) => loginRequest(secondIp, undefined, index + 20)))
    expect(second.map((response) => response.status)).toEqual([204, 204, 204, 204, 204, 204])
    for (const response of second) expect(response.headers['x-test-client-ip']).toBe(secondIp)
    const bothLimited = await hostNginx.request([loginRequest(firstIp), loginRequest(secondIp)])
    bothLimited.forEach(expectIpLimited)

    const health = await hostNginx.request(Array.from({ length: 8 }, () => ({ port: 8444, ip: firstIp, path: '/api/health' })))
    for (const response of health) {
      expect(response.status).toBe(200)
      expect(JSON.parse(response.body)).toEqual({ status: 'ok' })
    }
    // 이 요청은 합성 응답이 아니라 기존 세션 가드가 있는 실제 테스트 API까지 간다.
    const privateResponses = await hostNginx.request(['/api/auth/me', '/api/projects'].map((path) => ({
      port: 8444, ip: firstIp, path,
    })))
    for (const response of privateResponses) expect(response.status).toBe(401)
  })
})

test.describe('공용 nginx', () => {
  test('릴리스 전환과 실패 뒤에도 올바른 정적 자산을 받는다', async () => {
    const site = await createSite();
    try {
      await site.newRelease('first');
      await site.release('activate');
      await site.start('preview');
      const browser = await chromium.launch({args: [
        '--host-resolver-rules=MAP ' + domain + ' 127.0.0.1',
        '--ignore-certificate-errors-spki-list=' + await site.spki(), '--no-proxy-server',
      ]});
      try {
        const page = await browser.newPage();
        const checkPage = async (label: string) => {
          // Docker Desktop may take a moment to propagate a host-side symlink replacement.
          await expect.poll(async () => (await site.http('/app/demo')).body).toContain('/app/assets/' + label + '.js');
          await page.goto(site.url() + '/app/demo');
          await expect(page.locator('#revision')).toHaveText(label);
        };
        const asset = (name: string) => page.evaluate(async (name) => {
          const res = await fetch('/app/assets/' + name, {cache: 'no-store'});
          return {status: res.status, type: res.headers.get('content-type'), body: await res.text()};
        }, name);
        await checkPage('first');
        await site.newRelease('second');
        await site.release('activate');
        await checkPage('second');
        expect(await asset('first.js')).toMatchObject({status: 200, body: expect.stringContaining('first')});
        expect(await asset('first.css')).toMatchObject({status: 200, type: expect.stringContaining('text/css')});
        // Model interruption between the current-link swap and publication of the previous link.
        const previous = path.join(site.root, 'previous');
        const pending = path.join(site.root, '.prior');
        await rename(previous, pending);
        const priorTarget = await readlink(pending);
        await expect.poll(async () => {
          const { stdout } = await runFixtureCommand('docker', ['exec', site.name, 'ls', '-la', '/srv/review']);
          return stdout.includes('.prior -> ' + priorTarget) && !stdout.includes('previous ->');
        }).toBe(true);
        await expect(readlink(previous)).rejects.toMatchObject({code: 'ENOENT'});
        expect(await asset('first.js')).toMatchObject({status: 200, body: expect.stringContaining('first')});
        expect((await asset('never-published.js')).status).toBe(404);
        await site.release('prepare');
        expect(await readlink(previous)).toBe(priorTarget);
        await expect(readlink(pending)).rejects.toMatchObject({code: 'ENOENT'});
        await checkPage('second');
        expect(await asset('first.css')).toMatchObject({status: 200, type: expect.stringContaining('text/css')});
        const broken = await site.newRelease('third');
        await rm(path.join(broken, 'app/assets/third.js'));
        await expect(site.release('activate')).rejects.toThrow();
        await checkPage('second');
        expect((await asset('third.js')).status).toBe(404);
        expect((await asset('missing.css')).status).toBe(404);
        await site.release('rollback');
        await checkPage('first');
        expect((await asset('second.js')).status).toBe(200);
      } finally {
        await browser.close();
      }
    } finally {
      await site.close();
    }
  });
});
