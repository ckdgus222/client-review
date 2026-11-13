import { test, expect, resetDatabase, createUser } from './fixtures.ts'

test.use({ baseURL: 'http://localhost:4103' })

test('소개 페이지가 뜨고 시작하기를 누르면 로그인 화면이 열린다', async ({ page }) => {
  await resetDatabase()
  const user = await createUser('landing-login@example.com', '소개 페이지 사용자')
  const response = await page.goto('/')

  expect(response?.status()).toBe(200)
  await expect(page).toHaveURL('http://localhost:4103/')
  await expect(page.getByRole('heading', { name: 'client-review', exact: true })).toBeVisible()
  await page.getByRole('link', { name: '시작하기', exact: true }).click()

  await expect(page).toHaveURL('http://localhost:4103/app/login')
  await expect(page.getByRole('heading', { name: '로그인', exact: true })).toBeVisible()
  await page.getByLabel('이메일', { exact: true }).fill(user.email)
  await page.getByRole('checkbox', { name: '개인정보 수집·이용에 동의해요(필수)', exact: true }).check()

  const codeResponsePromise = page.waitForResponse(
    (response) => response.url() === 'http://localhost:4103/api/auth/email-code' && response.request().method() === 'POST',
  )
  await page.getByRole('button', { name: '코드 받기', exact: true }).click()
  const codeResponse = await codeResponsePromise

  expect(await codeResponse.request().headerValue('origin')).toBe('http://localhost:4103')
  expect(codeResponse.status()).toBe(204)
  await expect(page.getByLabel('로그인 코드', { exact: true })).toBeVisible()
})

test('robots.txt가 앱과 api를 막고 소개 페이지에 제목과 설명 태그가 있다', async ({ page, request }) => {
  await page.goto('/')

  await expect(page).toHaveTitle(/client-review/)
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko')
  await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', /\S/)
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', /client-review/)
  await expect(page.locator('meta[property="og:description"]')).toHaveAttribute('content', /\S/)

  const robotsResponse = await request.get('/robots.txt')
  expect(robotsResponse.status()).toBe(200)
  const directives = (await robotsResponse.text()).trim().split(/\r?\n/).map((line) => line.trim())
  expect(directives).toEqual(['User-agent: *', 'Disallow: /app/', 'Disallow: /api/'])
})

test('휴대폰 폭에서 소개·방침·약관·404가 옆으로 넘치지 않는다', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  // 조각 2에서는 소개 페이지만 확인한다. 방침·약관은 조각 3, 404는 조각 4에서 더한다.
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'client-review', exact: true })).toBeVisible()

  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth)
})
