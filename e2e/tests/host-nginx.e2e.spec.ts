import { test, expect, type HostResponse } from './host-nginx-fixtures.ts'
import { createSite, domain, repo, run as runFixtureCommand } from '../../api/test/host-nginx-fixture';
import { readFile, readlink, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { chromium, type Page } from '@playwright/test';

const sharingOrigin = 'https://review.changhyon.dev'
const sharingImage = `${sharingOrigin}/share-review-v1.jpg`
const crawlerHeaders = { 'User-Agent': 'facebookexternalhit/1.1; kakaotalk-scrap/1.0' }

const expectSharingMetadata = async (page: Page, html: string, pathname: string) => {
  // DOMParser는 응답 원문만 읽는다. 앱 JavaScript가 태그를 채워도 이 검사는 통과하지 않는다.
  const metadata = await page.evaluate((html) => {
    const document = new DOMParser().parseFromString(html, 'text/html')
    const values = (selector: string, attribute: string) =>
      [...document.querySelectorAll(selector)].map((element) => element.getAttribute(attribute))
    return {
      lang: document.documentElement.lang,
      title: document.title,
      canonical: values('link[rel="canonical"]', 'href'),
      description: values('meta[name="description"]', 'content'),
      og: Object.fromEntries(['title', 'description', 'type', 'site_name', 'locale', 'url',
        'image', 'image:width', 'image:height', 'image:alt'].map((name) =>
        [name, values(`meta[property="og:${name}"]`, 'content')])),
      card: values('meta[name="twitter:card"]', 'content'),
      assets: values('link[href]:not([rel="canonical"])', 'href')
        .concat(values('script[src], img[src]', 'src')),
    }
  }, html)
  expect(metadata.lang).toBe('ko')
  expect(metadata.title).toMatch(/client[- ]review/i)
  expect(metadata.description).toEqual([expect.stringMatching(/\S/)])
  expect(metadata.canonical).toEqual([`${sharingOrigin}${pathname}`])
  expect(metadata.og).toMatchObject({
    title: [expect.stringMatching(/\S/)], description: [expect.stringMatching(/\S/)],
    type: ['website'], site_name: [expect.stringMatching(/client[- ]review/i)], locale: ['ko_KR'],
    url: [`${sharingOrigin}${pathname}`], image: [sharingImage],
    'image:width': ['1200'], 'image:height': ['630'], 'image:alt': [expect.stringMatching(/\S/)],
  })
  expect(metadata.card).toEqual(['summary_large_image'])
  for (const asset of metadata.assets) expect(asset).toMatch(/^\/(?!\/)/)
}

const readPublicImage = async (page: Page, pathname: string) => {
  const response = await page.evaluate(async (pathname) => {
    const response = await fetch(pathname, { credentials: 'omit', cache: 'no-store' })
    const blob = await response.blob()
    const url = URL.createObjectURL(blob)
    try {
      const image = new Image()
      image.src = url
      await image.decode()
      return {
        status: response.status, contentType: response.headers.get('content-type'),
        width: image.naturalWidth, height: image.naturalHeight,
        bytes: Array.from(new Uint8Array(await blob.arrayBuffer())),
      }
    } finally {
      URL.revokeObjectURL(url)
    }
  }, pathname)
  expect(response.status, pathname).toBe(200)
  return { ...response, body: Buffer.from(response.bytes) }
}

const expectIpLimited = (response: HostResponse) => {
  expect(response.status).toBe(429)
  expect(response.headers['content-type']).toContain('application/json')
  expect(JSON.parse(response.body)).toEqual({ statusCode: 429, code: 'IP_RATE_LIMITED' })
}

test.describe('공용 nginx', () => {
  test.setTimeout(180_000)

  test('비로그인 공유 크롤러가 소개와 데모의 메타데이터와 대표 이미지를 읽는다', async ({ page, hostNginx }) => {
    for (const port of [8443, 8444]) {
      const paths = ['/', '/app/demo', '/app/demo/']
      const responses = await hostNginx.request(paths.map((path) => ({ port, path, headers: crawlerHeaders })))
      for (const [index, response] of responses.entries()) {
        expect(response.status, `${port} ${paths[index]}`).toBe(200)
        expect(response.headers['content-type']).toContain('text/html')
        expect(response.headers['set-cookie']).toBeUndefined()
        await expectSharingMetadata(page, response.body, index === 0 ? '/' : '/app/demo')
      }
      const [image] = await hostNginx.request([
        { port, path: '/share-review-v1.jpg', method: 'HEAD', headers: crawlerHeaders },
      ])
      expect(image.status).toBe(200)
      expect(image.headers['content-type']).toContain('image/jpeg')
      expect(Number(image.headers['content-length'])).toBeGreaterThan(0)
    }

    await page.goto(hostNginx.previewOrigin)
    const image = await readPublicImage(page, '/share-review-v1.jpg')
    expect(image.contentType).toMatch(/^image\/jpeg(?:;|$)/)
    expect(image.body.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]))
    expect(image.body.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]))
    expect({ width: image.width, height: image.height }).toEqual({ width: 1200, height: 630 })
    expect(await page.context().cookies()).toEqual([])
  })

  test('공개 파비콘과 터치 아이콘만 제공하고 비공개 경로는 차단한다', async ({ page, hostNginx }) => {
    await page.goto(hostNginx.previewOrigin)
    await expect(page.locator('link[rel~="icon"]')).toHaveAttribute('href', '/favicon.svg')
    await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', '/apple-touch-icon.png')
    const svg = await readPublicImage(page, '/favicon.svg')
    const appSvg = await readPublicImage(page, '/app/favicon.svg')
    for (const image of [svg, appSvg]) {
      expect(image.contentType).toMatch(/^image\/svg\+xml(?:;|$)/)
      expect(image.body.toString()).toMatch(/<svg\b/)
      expect(image.width).toBeGreaterThan(0)
      expect(image.height).toBeGreaterThan(0)
    }
    expect(appSvg.body).toEqual(svg.body)

    const ico = await readPublicImage(page, '/favicon.ico')
    expect(ico.contentType).toMatch(/^image\/(?:x-icon|vnd\.microsoft\.icon)(?:;|$)/)
    expect(ico.body.subarray(0, 4)).toEqual(Buffer.from([0, 0, 1, 0]))
    expect(ico.body.readUInt16LE(4)).toBe(3)
    const dimensions = Array.from({ length: 3 }, (_, index) => {
      const offset = 6 + index * 16
      const size = ico.body.readUInt32LE(offset + 8)
      const start = ico.body.readUInt32LE(offset + 12)
      expect(size).toBeGreaterThan(0)
      expect(start).toBeGreaterThanOrEqual(54)
      expect(start + size).toBeLessThanOrEqual(ico.body.length)
      return [ico.body[offset], ico.body[offset + 1]]
    })
    expect(dimensions.sort((first, second) => first[0] - second[0])).toEqual([[16, 16], [32, 32], [48, 48]])

    const touch = await readPublicImage(page, '/apple-touch-icon.png')
    const appTouch = await readPublicImage(page, '/app/apple-touch-icon.png')
    for (const image of [touch, appTouch]) {
      expect(image.contentType).toMatch(/^image\/png(?:;|$)/)
      expect(image.body.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      expect({ width: image.width, height: image.height }).toEqual({ width: 180, height: 180 })
    }
    expect(appTouch.body).toEqual(touch.body)

    // 파일이 실제로 있어도 지정한 공개 이름 외에는 열리지 않아야 한다.
    const current = path.join(hostNginx.directory, 'releases/current')
    await writeFile(path.join(current, 'private-preview.jpg'), await readFile(path.join(current, 'share-review-v1.jpg')))
    await writeFile(path.join(current, 'private-icon.png'), touch.body)
    await writeFile(path.join(current, 'private.ico'), ico.body)
    await writeFile(path.join(current, 'app/private-icon.png'), appTouch.body)
    const blocked = ['/private-preview.jpg', '/private-icon.png', '/private.ico', '/app/private-icon.png',
      '/share-review-v2.jpg', '/share-review-v1.jpg/extra', '/apple-touch-icon.png.bak',
      '/app/apple-touch-icon.png/extra', '/app/demo/private', '/app/login', '/app/projects',
      '/api/auth/me', '/api/assets/example', '/uploads/example.webp', '/.env']
    const responses = await page.evaluate(async (paths) => Promise.all(paths.map(async (path) => {
      const response = await fetch(path, { credentials: 'omit', redirect: 'manual' })
      return { path, status: response.status }
    })), blocked)
    for (const response of responses) expect(response.status, response.path).toBe(503)
  })

  test('공개 안내는 데모로 연결하고 정식 안내는 회원 입구를 유지한다', async ({ page, hostNginx }) => {
    for (const pathname of ['/', '/privacy', '/terms']) {
      const response = await page.goto(`${hostNginx.previewOrigin}${pathname}`)
      expect(response?.status()).toBe(200)
      await expect(page.locator('.quiet-link[href="/app/login"]')).toHaveCount(0)
      await expect(page.locator('a[href="/app/login"]')).toHaveCount(0)
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    }
    await page.goto(hostNginx.previewOrigin)
    await expect(page.getByRole('link', { name: '검수실 예시 보기', exact: true })).toHaveAttribute('href', '#review-example')
    await page.getByRole('link', { name: '로그인 없이 데모 체험하기', exact: true }).click()
    await expect(page).toHaveURL(`${hostNginx.previewOrigin}/app/demo`)
    await expect(page.getByRole('heading', { name: '오브제 스토어 리뉴얼', exact: true })).toBeVisible()

    for (const pathname of ['/', '/privacy', '/terms']) {
      expect((await page.goto(`${hostNginx.liveOrigin}${pathname}`))?.status()).toBe(200)
      await expect(page.getByRole('link', { name: '로그인', exact: true })).toHaveAttribute('href', '/app/login')
    }
    await page.goto(hostNginx.liveOrigin)
    await expect(page.getByRole('link', { name: '로그인 없이 데모 체험하기', exact: true })).toHaveAttribute('href', '/app/demo')
    await page.getByRole('link', { name: '시작하기', exact: true }).click()
    await expect(page).toHaveURL(`${hostNginx.liveOrigin}/app/login`)
    await expect(page.getByRole('heading', { name: '로그인', exact: true })).toBeVisible()
    await expect(page.locator('link[rel~="icon"]')).toHaveAttribute('href', '/app/favicon.svg')
    await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', '/app/apple-touch-icon.png')
    const [memberPage] = await hostNginx.request([{ port: 8444, path: '/app/projects/example', headers: crawlerHeaders }])
    expect(memberPage.status).toBe(200)
    const fixedSharingUrls = await page.evaluate((html) =>
      new DOMParser().parseFromString(html, 'text/html').querySelectorAll('link[rel="canonical"], meta[property="og:url"]').length,
    memberPage.body)
    expect(fixedSharingUrls).toBe(0)
  })

  test('공개 문서 주소와 데모 크롤링 범위 및 이전 릴리스 폴백을 유지한다', async ({ page, hostNginx }) => {
    for (const port of [8443, 8444]) {
      const documents = await hostNginx.request(['/privacy', '/terms'].map((path) => ({ port, path, headers: crawlerHeaders })))
      for (const [index, response] of documents.entries()) {
        expect(response.status).toBe(200)
        expect(response.headers['content-type']).toContain('text/html')
        await expectSharingMetadata(page, response.body, index === 0 ? '/privacy' : '/terms')
      }
      const [robots] = await hostNginx.request([{ port, path: '/robots.txt', headers: crawlerHeaders }])
      expect(robots.status).toBe(200)
      expect(robots.headers['content-type']).toContain('text/plain')
      const directives = robots.body.trim().split(/\r?\n/).map((line) => line.trim())
      expect(directives.filter((line) => !line.startsWith('Allow:')))
        .toEqual(['User-agent: *', 'Disallow: /app/', 'Disallow: /api/'])
      expect(directives.filter((line) => line.startsWith('Allow:')).sort()).toEqual([
        'Allow: /app/demo$', 'Allow: /app/demo/$', 'Allow: /app/assets/', 'Allow: /app/fonts/',
        'Allow: /app/favicon.svg$', 'Allow: /app/apple-touch-icon.png$',
      ].sort())
    }

    const current = path.join(hostNginx.directory, 'releases/current')
    const validateRelease = () => runFixtureCommand('python3', ['-c',
      "import runpy, sys; from pathlib import Path; runpy.run_path(sys.argv[1])['validate'](Path(sys.argv[2]))",
      path.join(repo, 'deploy/static-release.py'), current])
    await validateRelease()
    for (const filename of ['preview-index.html', 'preview-privacy.html', 'preview-terms.html', 'app/demo.html']) {
      await rm(path.join(current, filename))
    }
    // 파생 HTML이 없던 릴리스도 검사와 HTTP 응답을 모두 유지한다.
    await validateRelease()
    const fallbackPages = [
      ['/', 'index.html'], ['/privacy', 'privacy.html'], ['/terms', 'terms.html'],
      ['/app/demo', 'app/index.html'], ['/app/demo/', 'app/index.html'],
    ]
    for (const [pathname, filename] of fallbackPages) {
      const original = await readFile(path.join(current, filename), 'utf8')
      await expect.poll(async () => {
        const responses = await hostNginx.request([8443, 8444].map((port) => ({ port, path: pathname, headers: crawlerHeaders })))
        return responses.map((response) => ({ status: response.status, body: response.body }))
      }).toEqual([{ status: 200, body: original }, { status: 200, body: original }])
    }
    expect((await page.goto(`${hostNginx.previewOrigin}/app/demo`))?.status()).toBe(200)
    await expect(page.getByRole('heading', { name: '오브제 스토어 리뉴얼', exact: true })).toBeVisible()
    await page.goto(hostNginx.liveOrigin)
    await page.getByRole('link', { name: '시작하기', exact: true }).click()
    await expect(page.getByRole('heading', { name: '로그인', exact: true })).toBeVisible()

    const home = path.join(current, 'index.html')
    const original = await readFile(home, 'utf8')
    try {
      for (const externalAsset of [
        '<link rel="stylesheet" href="https://assets.example.test/unexpected.css">',
        '<script src="https://assets.example.test/unexpected.js"></script>',
        '<img src="https://assets.example.test/unexpected.png">',
      ]) {
        await writeFile(home, original.replace('</head>', `${externalAsset}</head>`))
        await expect(validateRelease()).rejects.toThrow()
      }
    } finally {
      await writeFile(home, original)
    }
  })

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
      const first = await site.newRelease('first');
      const oldCSS = 'body { color: brown; }';
      const cssHash = createHash('sha256').update(oldCSS).digest('hex').slice(0, 12);
      await writeFile(path.join(first, 'landing.css'), oldCSS);
      await writeFile(path.join(first, 'shop-example-aabbcc.webp'), Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64'));
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
        expect(await site.http('/landing.css?v=' + cssHash)).toEqual({status: 200, body: oldCSS});
        expect((await site.http('/shop-example-aabbcc.webp')).status).toBe(200);
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
