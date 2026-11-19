import { test, expect } from '@playwright/test'

test('로그인 파비콘은 앱 경로의 SVG이며 공개 파비콘과 바이트가 같다', async ({ page, request }) => {
  const nginxOrigin = 'http://localhost:4103'
  await page.goto(`${nginxOrigin}/app/login`)
  const icon = page.locator('link[rel~="icon"]')
  await expect(icon).toHaveCount(1)
  const iconUrl = await icon.evaluate((link: HTMLLinkElement) => link.href)
  expect(iconUrl).toBe(`${nginxOrigin}/app/favicon.svg`)

  const [appResponse, publicResponse] = await Promise.all([
    request.get(iconUrl, { maxRedirects: 0 }),
    request.get(`${nginxOrigin}/favicon.svg`, { maxRedirects: 0 }),
  ])
  for (const response of [appResponse, publicResponse]) {
    expect(response.status(), response.url()).toBe(200)
    expect(response.headers()['content-type'], response.url()).toMatch(/^image\/svg\+xml(?:;|$)/)
  }

  const appBody = await appResponse.body()
  expect(appBody.equals(await publicResponse.body())).toBe(true)
  const svg = await page.evaluate((source) => {
    const document = new DOMParser().parseFromString(source, 'image/svg+xml')
    return {
      root: document.documentElement.localName,
      namespace: document.documentElement.namespaceURI,
      errors: document.querySelectorAll('parsererror').length,
    }
  }, appBody.toString('utf8'))
  expect(svg).toEqual({ root: 'svg', namespace: 'http://www.w3.org/2000/svg', errors: 0 })
})

test('공개 페이지와 앱의 폰트 경로는 동일한 WOFF2 파일 5개를 정상 응답한다', async ({ request }) => {
  const nginxOrigin = 'http://localhost:4103'
  const fontFiles = [
    'Pretendard-Regular.subset.woff2',
    'Pretendard-SemiBold.subset.woff2',
    'Pretendard-Bold.subset.woff2',
    'gowun-batang-korean-400-normal.woff2',
    'gowun-batang-latin-400-normal.woff2',
  ]

  for (const file of fontFiles) {
    const [publicResponse, appResponse] = await Promise.all([
      request.get(`${nginxOrigin}/fonts/${file}`, { maxRedirects: 0 }),
      request.get(`${nginxOrigin}/app/fonts/${file}`, { maxRedirects: 0 }),
    ])

    for (const response of [publicResponse, appResponse]) {
      expect(response.status(), response.url()).toBe(200)
      const body = await response.body()

      // WOFF2의 48바이트 헤더와 파일 길이를 확인해 HTML 응답이나 잘린 파일을 구분한다.
      expect(body.length, response.url()).toBeGreaterThan(48)
      expect(body.subarray(0, 4).toString('ascii'), response.url()).toBe('wOF2')
      expect(body.readUInt32BE(8), response.url()).toBe(body.length)
    }

    expect((await publicResponse.body()).equals(await appResponse.body()), `${file}의 두 경로 파일 일치`).toBe(true)
  }
})
