import { test, expect, resetDatabase, createUser } from './fixtures.ts'

test.use({ baseURL: 'http://localhost:4103' })

test('소개와 공유 문구가 웹사이트 화면 검수·승인을 설명한다', async ({ page }) => {
  const response = await page.goto('/')

  expect(response?.status()).toBe(200)
  const title = 'client-review: 웹사이트 화면 검수·승인'
  await expect(page).toHaveTitle(title)
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', title)

  // 문장이나 구두점 대신 소개 본문과 검색·공유 설명 각각의 역할과 흐름을 확인한다.
  const workflow = [
    /웹사이트/,
    /개발자[\s\S]*화면[\s\S]*올/,
    /고객[\s\S]*(위치|고칠|수정할|자리)/,
    /비교/,
    /버전[\s\S]*승인/,
  ]
  const introduction = page.locator('main .lead')
  await expect(introduction).toBeVisible()
  for (const meaning of workflow) {
    await expect(introduction).toContainText(meaning)
  }
  for (const selector of ['meta[name="description"]', 'meta[property="og:description"]']) {
    const description = page.locator(selector)
    for (const meaning of [...workflow, /로그인\s*없이/, /데모|샘플\s*검수실/]) {
      await expect(description).toHaveAttribute('content', meaning)
    }
    await expect(description).not.toHaveAttribute('content', /외주\s*작업\s*검수/)
  }
  await expect(page.locator('main')).not.toContainText(/외주로\s*만든|외주\s*작업\s*검수/)
  const demo = page.getByRole('link', { name: /로그인\s*없이.*데모/ })
  await expect(demo).toBeVisible()
  await expect(demo).toHaveAttribute('href', '/app/demo')
})

test('방침과 약관에서 웹사이트 개발 계약과 검수 기록을 안내한다', async ({ page }) => {
  const privacyResponse = await page.goto('/privacy')

  expect(privacyResponse?.status()).toBe(200)
  await expect(page.getByRole('heading', { level: 1, name: '개인정보처리방침', exact: true })).toBeVisible()
  const introduction = page.locator('article .lead')
  await expect(introduction).toBeVisible()
  await expect(introduction).toContainText(/웹사이트[\s\S]*화면[\s\S]*검수[\s\S]*승인/)
  await expect(page.locator('article')).not.toContainText(/외주로\s*만든|외주\s*작업|외주\s*계약/)

  const records = page.getByRole('listitem').filter({ hasText: /^기록:/ })
  await expect(records).toContainText(/승인한\s*버전/)
  await expect(records).toContainText(/검수\s*확인서/)
  await expect(records).toContainText(/검수[\s\S]*(기록|근거)/)
  const basis = page.locator('p').filter({ hasText: /처리\s*근거/ })
  await expect(basis).toBeVisible()
  await expect(basis).toContainText(/로그인[\s\S]*동의[\s\S]*필수/)
  await expect(basis).toContainText(/초대[\s\S]*이메일[\s\S]*웹사이트\s*개발\s*계약[\s\S]*이행[\s\S]*개발자/)

  const termsResponse = await page.goto('/terms')

  expect(termsResponse?.status()).toBe(200)
  await expect(page.getByRole('heading', { level: 1, name: '이용약관', exact: true })).toBeVisible()
  const service = page.locator('#section-1 + p')
  await expect(service).toBeVisible()
  await expect(service).toContainText(/개발자[\s\S]*웹사이트\s*화면[\s\S]*버전[\s\S]*올/)
  await expect(service).toContainText(/고객[\s\S]*수정\s*요청/)
  await expect(service).toContainText(/지정[\s\S]*사람[\s\S]*버전[\s\S]*승인[\s\S]*기록/)
  await expect(page.locator('article')).not.toContainText(/외주\s*개발자|외주\s*작업|외주\s*계약/)

  const responsibility = page.locator('#section-7 + p')
  await expect(responsibility).toBeVisible()
  await expect(responsibility).toContainText(/서비스[\s\S]*검수\s*기록[\s\S]*도구/)
  await expect(responsibility).toContainText(/웹사이트\s*개발\s*계약[\s\S]*내용[\s\S]*이행[\s\S]*계약한\s*사람들\s*사이/)
  await expect(responsibility).toContainText(/서비스의\s*잘못\s*없이[\s\S]*손해[\s\S]*책임지지\s*않/)
})

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
    (response) =>
      response.url() === 'http://localhost:4103/api/auth/email-code' && response.request().method() === 'POST',
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
  const directives = (await robotsResponse.text())
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
  expect(directives.filter((line) => !line.startsWith('Allow:')))
    .toEqual(['User-agent: *', 'Disallow: /app/', 'Disallow: /api/'])
  expect(directives.filter((line) => line.startsWith('Allow:')).sort()).toEqual([
    'Allow: /app/demo$', 'Allow: /app/demo/$', 'Allow: /app/assets/', 'Allow: /app/fonts/',
    'Allow: /app/favicon.svg$', 'Allow: /app/apple-touch-icon.png$',
  ].sort())
})

test('개인정보처리방침에 항목·보유 기간·권리·보호책임자 절이 있다', async ({ page }) => {
  const response = await page.goto('/privacy')

  expect(response?.status()).toBe(200)
  await expect(page.getByRole('heading', { level: 1, name: '개인정보처리방침', exact: true })).toBeVisible()
  for (const name of [
    '2. 모으는 항목과 모으는 때',
    '3. 보유 기간',
    '4. 파기 절차와 방법',
    '7. 정보주체의 권리와 요청 방법',
    '10. 개인정보 보호책임자',
  ]) {
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
  await expect(items.filter({ hasText: /^복구용 기록\(/ })).toHaveText(
    '복구용 기록(참여·철회 기록 메일의 이메일·이름): 30일 안에 지워요.',
  )
  await expect(page.locator('p').filter({ hasText: '탈퇴한 뒤에도' })).toContainText(
    '탈퇴한 뒤에도 이름과 이메일은 백업에 14일, 복구용 기록에 30일까지 남았다가 지워져요.',
  )
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

test('앱 밖의 없는 주소는 404 상태와 404 화면이고 소개 페이지로 돌아갈 수 있다', async ({ page }) => {
  const response = await page.goto('/abc')

  expect(response?.status()).toBe(404)
  await expect(page).toHaveURL('http://localhost:4103/abc')
  await expect(page.getByRole('heading', { level: 1, name: '찾을 수 없는 주소예요', exact: true })).toBeVisible()
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /\bnoindex\b/)
  await page.getByRole('link', { name: '처음으로', exact: true }).click()

  await expect(page).toHaveURL('http://localhost:4103/')
  await expect(page.getByRole('heading', { level: 1, name: 'client-review', exact: true })).toBeVisible()

  await page.goto('/abc')
  await page.getByRole('link', { name: '로그인', exact: true }).click()

  await expect(page).toHaveURL('http://localhost:4103/app/login')
  await expect(page.getByRole('heading', { level: 1, name: '로그인', exact: true })).toBeVisible()
})

test('앱 안의 없는 주소는 nginx의 404 화면 대신 React가 처리한다', async ({ page }) => {
  const response = await page.goto('/app/abc')

  expect(response?.status()).toBe(200)
  await expect(page).toHaveURL('http://localhost:4103/app/abc')
  await expect(page.getByRole('heading', { level: 1, name: '없는 화면이에요', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: '첫 화면으로 가기', exact: true })).toHaveAttribute('href', /^\/app\/?$/)
  await expect(page.getByRole('heading', { name: '찾을 수 없는 주소예요', exact: true })).toHaveCount(0)
})

test('api의 없는 주소는 nginx의 404 화면 대신 api의 JSON 404를 그대로 보낸다', async ({ request }) => {
  const response = await request.get('/api/abc')

  expect(response.status()).toBe(404)
  expect(response.headers()['content-type']).toContain('application/json')
  const body = await response.json()
  expect(body).toMatchObject({ statusCode: 404 })

  const apiResponse = await request.get('http://localhost:4101/api/abc')
  expect(apiResponse.status()).toBe(404)
  expect(body).toEqual(await apiResponse.json())
})

test('휴대폰 폭에서 소개·방침·약관·404가 옆으로 넘치지 않는다', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  for (const { path, heading, status } of [
    { path: '/', heading: 'client-review', status: 200 },
    { path: '/privacy', heading: '개인정보처리방침', status: 200 },
    { path: '/terms', heading: '이용약관', status: 200 },
    { path: '/abc', heading: '찾을 수 없는 주소예요', status: 404 },
  ]) {
    const response = await page.goto(path)
    expect(response?.status()).toBe(status)
    await expect(page.getByRole('heading', { level: 1, name: heading, exact: true })).toBeVisible()

    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }))
    expect(scrollWidth, `${path}의 가로 넘침`).toBeLessThanOrEqual(clientWidth)
  }
})
