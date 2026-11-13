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

test('개인정보처리방침에 항목·보유 기간·권리·보호책임자 절이 있다', async ({ page }) => {
  const response = await page.goto('/privacy')

  expect(response?.status()).toBe(200)
  await expect(page.getByRole('heading', { level: 1, name: '개인정보처리방침', exact: true })).toBeVisible()
  for (const name of ['2. 모으는 항목과 모으는 때', '3. 보유 기간', '7. 정보주체의 권리와 요청 방법', '10. 개인정보 보호책임자']) {
    await expect(page.getByRole('heading', { level: 2, name, exact: true })).toBeVisible()
  }

  const items = page.getByRole('listitem')
  await expect(items.filter({ hasText: /^계정\(/ })).toContainText('탈퇴를 요청할 때까지')
  await expect(items.filter({ hasText: /프로젝트 자료\(/ })).toContainText('지운 뒤 7일')
  await expect(items.filter({ hasText: /^로그인 세션:/ })).toContainText('끝난 지 30일')
  await expect(items.filter({ hasText: /^로그인 코드:/ })).toContainText('만료된 지 30일')
  await expect(items.filter({ hasText: /^초대:/ })).toContainText('수락·철회·만료로 끝난 지 30일')
  await expect(items.filter({ hasText: /^메일 발송 기록:/ })).toContainText('보내거나 마지막으로 시도한 지 30일')
  await expect(items.filter({ hasText: /^백업:/ })).toContainText('백업은 14일 동안')
})

test('로그인 화면에서 개인정보처리방침과 이용약관 링크를 눌러 그 글로 간다', async ({ page }) => {
  await page.goto('/app/login')
  await page.getByLabel('이메일', { exact: true }).fill('landing-policy@example.com')

  const privacyPagePromise = page.waitForEvent('popup')
  await page.getByRole('link', { name: '개인정보처리방침 보기', exact: true }).click()
  const privacyPage = await privacyPagePromise

  await expect(privacyPage).toHaveURL('http://localhost:4103/privacy')
  await expect(privacyPage.getByRole('heading', { level: 1, name: '개인정보처리방침', exact: true })).toBeVisible()
  await expect(page).toHaveURL('http://localhost:4103/app/login')
  await expect(page.getByLabel('이메일', { exact: true })).toHaveValue('landing-policy@example.com')
  await privacyPage.close()

  for (const { name, path } of [
    { name: '개인정보처리방침', path: '/privacy' },
    { name: '이용약관', path: '/terms' },
  ]) {
    await page.getByRole('navigation', { name: '약관', exact: true }).getByRole('link', { name, exact: true }).click()

    await expect(page).toHaveURL(`http://localhost:4103${path}`)
    await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible()
    await page.goBack()
    await expect(page.getByRole('heading', { name: '로그인', exact: true })).toBeVisible()
  }
})

test('소개 페이지에서 개인정보처리방침과 이용약관 링크를 눌러 그 글로 간다', async ({ page }) => {
  await page.goto('/')

  for (const { name, path } of [
    { name: '개인정보처리방침', path: '/privacy' },
    { name: '이용약관', path: '/terms' },
  ]) {
    await page.locator('footer').getByRole('link', { name, exact: true }).click()

    await expect(page).toHaveURL(`http://localhost:4103${path}`)
    await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible()
    await page.getByRole('link', { name: '처음으로', exact: true }).click()
    await expect(page).toHaveURL('http://localhost:4103/')
    await expect(page.getByRole('heading', { name: 'client-review', exact: true })).toBeVisible()
  }
})

test('휴대폰 폭에서 소개·방침·약관·404가 옆으로 넘치지 않는다', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  // 404는 조각 4에서 더한다.
  for (const { path, heading } of [
    { path: '/', heading: 'client-review' },
    { path: '/privacy', heading: '개인정보처리방침' },
    { path: '/terms', heading: '이용약관' },
  ]) {
    const response = await page.goto(path)
    expect(response?.status()).toBe(200)
    await expect(page.getByRole('heading', { level: 1, name: heading, exact: true })).toBeVisible()

    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }))
    expect(scrollWidth, `${path}의 가로 넘침`).toBeLessThanOrEqual(clientWidth)
  }
})
