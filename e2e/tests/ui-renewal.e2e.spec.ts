import { test, expect, type Response } from '@playwright/test'

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

test('앱 로그인은 자체 호스팅 Pretendard를 로드하고 크림 바탕과 테라코타 버튼을 쓴다', async ({ page }) => {
  const nginxOrigin = 'http://localhost:4103'
  const fontResponses: Response[] = []
  const externalFontRequests: string[] = []
  page.on('request', (request) => {
    if (!['font', 'stylesheet'].includes(request.resourceType())) return
    if (new URL(request.url()).origin !== nginxOrigin) externalFontRequests.push(request.url())
  })
  page.on('response', (response) => {
    if (response.request().resourceType() === 'font') fontResponses.push(response)
  })

  await page.goto(`${nginxOrigin}/app/login`)
  await expect(page.getByRole('heading', { name: '로그인', exact: true })).toBeVisible()
  const fonts = await page.evaluate(async () => {
    await document.fonts.ready
    return Array.from(document.fonts, (font) => ({
      family: font.family.replace(/["']/g, ''),
      weight: font.weight,
      status: font.status,
      display: font.display,
    }))
  })
  expect(fonts).toEqual(expect.arrayContaining([
    { family: 'Pretendard', weight: '400', status: 'loaded', display: 'swap' },
    { family: 'Pretendard', weight: '600', status: 'loaded', display: 'swap' },
  ]))
  expect(externalFontRequests).toEqual([])

  // 별도 HTTP 조회가 아니라, 이 화면을 그리면서 브라우저가 받은 응답을 검사한다.
  const pretendardResponses = fontResponses.filter((response) => new URL(response.url()).pathname.includes('Pretendard'))
  expect(pretendardResponses.length).toBeGreaterThanOrEqual(2)
  for (const response of pretendardResponses) {
    expect(response.url()).toMatch(/^http:\/\/localhost:4103\/app\/fonts\/Pretendard[^/]+\.woff2$/)
    expect(response.status(), response.url()).toBe(200)
    const body = await response.body()
    expect(body.subarray(0, 4).toString('ascii'), response.url()).toBe('wOF2')
  }

  const email = page.getByRole('textbox', { name: '이메일', exact: true })
  const submit = page.getByRole('button', { name: '코드 받기', exact: true })
  for (const element of [page.locator('body'), email, submit]) {
    await expect(element).toHaveCSS('font-family', /^"?Pretendard"?,/)
  }
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(251, 247, 242)')
  await expect(page.locator('body')).toHaveCSS('color', 'rgb(42, 31, 26)')
  await expect(submit).toHaveCSS('background-color', 'rgb(200, 78, 44)')
  await expect(submit).toHaveCSS('color', 'rgb(255, 255, 255)')
})

test('앱 로그인은 폰트 실패 뒤에도 대체 글꼴로 폼을 읽고 입력할 수 있다', async ({ page }) => {
  const blockedFonts: string[] = []
  await page.route('**/*', async (route) => {
    if (route.request().resourceType() !== 'font') return route.continue()
    blockedFonts.push(route.request().url())
    await route.abort('failed')
  })

  await page.goto('http://localhost:4103/app/login')
  await expect(page.getByRole('heading', { name: '로그인', exact: true })).toBeVisible()
  const pretendardFonts = await page.evaluate(async () => {
    await document.fonts.ready
    return Array.from(document.fonts)
      .filter((font) => font.family.replace(/["']/g, '') === 'Pretendard')
      .map((font) => ({ status: font.status, display: font.display }))
  })
  expect(blockedFonts.length).toBeGreaterThan(0)
  expect(pretendardFonts).toContainEqual({ status: 'error', display: 'swap' })
  expect(pretendardFonts.some((font) => font.status === 'loaded')).toBe(false)
  expect(pretendardFonts.every((font) => font.display === 'swap')).toBe(true)

  const email = page.getByRole('textbox', { name: '이메일', exact: true })
  const submit = page.getByRole('button', { name: '코드 받기', exact: true })
  for (const element of [page.locator('body'), email, submit]) {
    await expect(element).toHaveCSS('font-family', /(?:Apple SD Gothic Neo|Malgun Gothic).*sans-serif$/)
    await expect(element).toHaveCSS('opacity', '1')
  }
  await expect(page.getByText('이메일', { exact: true })).toBeVisible()
  await expect(email).toBeVisible()
  await expect(email).toBeEditable()
  await email.fill('font-fallback@example.test')
  await expect(email).toHaveValue('font-fallback@example.test')
  const consent = page.getByRole('checkbox', { name: '개인정보 수집·이용에 동의해요(필수)', exact: true })
  await consent.check()
  await expect(consent).toBeChecked()
  await expect(submit).toBeVisible()
  await expect(submit).toBeEnabled()
})
