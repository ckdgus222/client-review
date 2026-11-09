import {
  test,
  expect,
  resetDatabase,
  createUser,
  createProject,
  KNOWN_LOGIN_CODE,
  useKnownLoginCode,
} from './fixtures.ts'

test.beforeEach(async () => {
  // 앞선 테스트의 사용자와 세션이 다음 테스트의 로그인 상태에 영향을 주지 않게 한다.
  await resetDatabase()
})

test('로그인하지 않고 첫 화면에 가면 로그인 화면으로 간다', async ({ page }) => {
  await page.goto('/app/')

  await expect(page).toHaveURL('/app/login')
  await expect(page.getByRole('heading', { name: '로그인', exact: true })).toBeVisible()
  await expect(page.getByLabel('이메일', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '코드 받기', exact: true })).toBeVisible()
})

test('로그인 화면에서 이메일과 코드를 넣으면 프로젝트 목록이 보인다', async ({ page }) => {
  // 기존 사용자를 만들어 이름 등록 단계 없이 이메일과 코드만으로 로그인하는 흐름을 확인한다.
  const user = await createUser('smoke-login@example.com', '로그인 사용자')
  await page.goto('/app/login')
  await page.getByLabel('이메일', { exact: true }).fill(user.email)

  // 클릭 전에 응답 대기를 걸고 서버의 저장이 끝난 뒤 해시를 바꿔야 코드 생성과 충돌하지 않는다.
  const codeResponsePromise = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/auth/email-code' && response.request().method() === 'POST',
  )
  await page.getByRole('button', { name: '코드 받기', exact: true }).click()
  const codeResponse = await codeResponsePromise
  expect(codeResponse.ok()).toBe(true)
  await useKnownLoginCode(user.email)

  await page.getByLabel('로그인 코드', { exact: true }).fill(KNOWN_LOGIN_CODE)
  await page.getByRole('button', { name: '로그인', exact: true }).click()

  // 로그인 뒤 React Router는 첫 화면 주소를 /app으로 쓴다(nginx는 /app을 /app/로 보낸다). 둘 다 첫 화면이다.
  await expect(page).toHaveURL(/\/app\/?$/)
  await expect(page.getByRole('heading', { name: '내 프로젝트', exact: true })).toBeVisible()
  await expect(page.getByText('아직 프로젝트가 없어요.', { exact: true })).toBeVisible()
})

test('세션 쿠키를 심은 개발자는 테스트 DB에 만든 프로젝트를 목록에서 본다', async ({ page, loginAs }) => {
  const developer = await createUser('smoke-developer@example.com', '개발자')
  const project = await createProject(developer.id, '브라우저 연결 확인 프로젝트')

  // 로그인 화면에 의존하지 않아야 목록 조회와 테스트 DB 연결의 문제를 따로 찾을 수 있다.
  await loginAs(developer.id)
  await page.goto('/app/')

  await expect(page.getByRole('heading', { name: '내 프로젝트', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: project.name, exact: true })).toBeVisible()
})
