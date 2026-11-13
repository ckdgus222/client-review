import { test, expect, db, resetDatabase, createUser } from './fixtures.ts'

test.beforeEach(async () => {
  await resetDatabase()
})

test('동의를 체크하지 않으면 코드를 요청하지 않고 동의해 달라는 문구가 보인다', async ({ page }) => {
  const user = await createUser('login-consent@example.com', '동의 확인 사용자')
  const codeRequests: string[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/auth/email-code' && request.method() === 'POST') {
      codeRequests.push(request.url())
    }
  })
  await page.goto('/app/login')
  await page.getByLabel('이메일', { exact: true }).fill(user.email)
  const consent = page.getByRole('checkbox', { name: '개인정보 수집·이용에 동의해요(필수)', exact: true })
  const submit = page.getByRole('button', { name: '코드 받기', exact: true })
  await expect(consent).not.toBeChecked()
  await expect(submit).toBeEnabled()

  await submit.click()

  await expect(page.getByText('개인정보 수집·이용에 동의해 주세요', { exact: true })).toBeVisible()
  await expect(page.getByLabel('이메일', { exact: true })).toHaveValue(user.email)
  await expect(page.getByLabel('로그인 코드', { exact: true })).toHaveCount(0)
  expect(codeRequests).toEqual([])
  expect(await db.loginCode.count()).toBe(0)
  expect(await db.notificationDelivery.count()).toBe(0)
  expect(await db.session.count()).toBe(0)
  expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).privacyAgreedAt).toBeNull()

  // 같은 화면에서 동의하면 실제 요청이 한 번 전송되는 것까지 확인한다.
  await consent.check()
  await expect(page.getByText('개인정보 수집·이용에 동의해 주세요', { exact: true })).toHaveCount(0)
  const responsePromise = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/auth/email-code' && response.request().method() === 'POST',
  )
  await submit.click()
  const response = await responsePromise
  expect(response.status()).toBe(204)
  expect(response.request().postDataJSON()).toEqual({ email: user.email, privacyAgreed: true })
  await expect(page.getByLabel('로그인 코드', { exact: true })).toBeVisible()
  expect(codeRequests).toHaveLength(1)
  expect(await db.loginCode.findUniqueOrThrow({ where: { email: user.email } })).toMatchObject({ privacyAgreed: true })
})
