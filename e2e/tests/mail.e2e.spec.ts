import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { assertTestDatabaseUrl } from '../../api/test/test-database-url.ts'
import browserConfig from '../playwright.config.ts'
import { test, expect, db, resetDatabase, createUser, createProject } from './fixtures.ts'

const prepareFailedMailActivity = async () => {
  await resetDatabase()
  const developer = await createUser('developer@example.com', '개발자')
  const client = await createUser('a@b.com', '클라이언트')
  const otherClient = await createUser('c@d.com', '다른 클라이언트')
  const project = await createProject(developer.id, '알림 검수 프로젝트')
  await db.projectMember.createMany({
    data: [client, otherClient].map((user) => ({
      projectId: project.id,
      userId: user.id,
      role: 'CLIENT',
    })),
  })
  const version = await db.deliveryVersion.create({
    data: {
      projectId: project.id,
      number: 0,
      status: 'IN_REVIEW',
      publishedAt: new Date(),
    },
  })
  await db.project.update({
    where: { id: project.id },
    data: { currentVersionId: version.id },
  })
  const event = await db.activityEvent.create({
    data: {
      projectId: project.id,
      actorId: developer.id,
      type: 'VERSION_PUBLISHED',
      versionId: version.id,
    },
  })
  // 실제 재시도는 api e2e에서 확인한다. FAILED는 반복 발송기가 다시 보내지 않아 화면 검사 중에도 유지된다.
  await db.notificationDelivery.createMany({
    data: [otherClient, client].map((user) => ({
      eventId: event.id,
      toEmail: user.email,
      status: 'FAILED',
      attempts: 5,
    })),
  })
  await db.activityEvent.create({
    data: {
      projectId: project.id,
      actorId: developer.id,
      type: 'INVITATION_CREATED',
    },
  })
  return { developer, client, project }
}

test('메일이 다섯 번 실패한 사건은 개발자의 활동 일지에 메일 실패와 받는 주소가 보인다', async ({ page, loginAs }) => {
  const { developer, project } = await prepareFailedMailActivity()
  await loginAs(developer.id)
  await page.goto(`/app/projects/${project.id}/activity`)

  await expect(
    page.getByRole('heading', {
      name: `${project.name} 활동 일지`,
      exact: true,
    }),
  ).toBeVisible()
  const publishedRow = page.getByRole('listitem').filter({ hasText: '개발자님이 초안을 게시했어요' })
  await expect(publishedRow).toHaveCount(1)
  await expect(publishedRow.getByText('메일 실패: a@b.com, c@d.com', { exact: true })).toBeVisible()
  const invitationRow = page.getByRole('listitem').filter({ hasText: '개발자님이 클라이언트를 초대했어요' })
  await expect(invitationRow).toBeVisible()
  await expect(invitationRow.getByText(/메일 실패/)).toHaveCount(0)
})

test('클라이언트의 활동 일지에는 메일 실패가 보이지 않는다', async ({ page, context, loginAs }) => {
  const { developer, client, project } = await prepareFailedMailActivity()
  const activityPath = `/app/projects/${project.id}/activity`
  await loginAs(developer.id)
  await page.goto(activityPath)
  const publishedRow = page.getByRole('listitem').filter({ hasText: '개발자님이 초안을 게시했어요' })
  await expect(publishedRow.getByText('메일 실패: a@b.com, c@d.com', { exact: true })).toBeVisible()

  // 사건과 FAILED 줄을 그대로 둔 채 같은 주소를 클라이언트로 다시 연다.
  await context.clearCookies()
  await loginAs(client.id)
  await page.goto(activityPath)

  await expect(
    page.getByRole('heading', {
      name: `${project.name} 활동 일지`,
      exact: true,
    }),
  ).toBeVisible()
  await expect(publishedRow).toBeVisible()
  await expect(page.getByText(/메일 실패/)).toHaveCount(0)
  const activityList = page.getByRole('list')
  await expect(activityList.getByText(/a@b\.com|c@d\.com/)).toHaveCount(0)
})

test('MAIL_MODE가 smtp인데 SMTP 설정이 빠지면 api가 켜지지 않고 빠진 값을 알린다', () => {
  test.setTimeout(90_000)
  const apiDirectory = fileURLToPath(new URL('../../api/', import.meta.url))
  const password = 'fake-unique-smtp-password-for-startup-test'
  const env = {
    ...process.env,
    // 0은 OS가 빈 포트를 고르게 하므로 이미 켜진 서버의 포트와 부딪치지 않는다.
    PORT: '0',
    DATABASE_URL: assertTestDatabaseUrl(process.env.TEST_DATABASE_URL),
    MAIL_MODE: 'smtp',
    SMTP_HOST: '',
    SMTP_PORT: '',
    SMTP_USER: '',
    SMTP_PASS: password,
    MAIL_FROM: '',
  }

  if (!existsSync(new URL('../../api/dist/main.js', import.meta.url))) {
    // Nest의 데코레이터와 .js import를 처리해야 해서 빌드가 없으면 기존 build 명령을 쓴다.
    // start 명령은 .env를 다시 읽으므로, 빌드 뒤 node로 시험용 환경만 전달한다.
    const build = spawnSync('npm', ['run', 'build'], {
      cwd: apiDirectory, env, encoding: 'utf8', timeout: 60_000,
    })
    expect(build.error).toBeUndefined()
    expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0)
  }

  const result = spawnSync(process.execPath, ['dist/main.js'], {
    cwd: apiDirectory, env, encoding: 'utf8', timeout: 20_000,
  })
  const output = `${result.stdout}\n${result.stderr}`

  // 실행 실패·시간 초과·다른 초기화 오류를 설정 검사 성공으로 세지 않는다.
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  expect(result.status).not.toBeNull()
  expect(result.status).not.toBe(0)
  expect(output).toContain('MAIL_MODE=smtp에 필요한 값이 비어 있어요')
  for (const name of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'MAIL_FROM']) {
    expect(output).toContain(name)
  }
  expect(output).not.toContain(password)
  expect(output).not.toContain('Nest application successfully started')
})

test('Docker의 api 컨테이너는 루트 .env의 메일 설정을 넘겨받는다', () => {
  const rootDirectory = fileURLToPath(new URL('../../', import.meta.url))
  const mailEnv = {
    MAIL_MODE: 'smtp',
    SMTP_HOST: 'smtp.compose-test.example.com',
    SMTP_PORT: '2465',
    SMTP_USER: 'compose-test-user',
    SMTP_PASS: 'fake-password-for-compose-mail-test',
    MAIL_FROM: 'Compose Test <mail@example.com>',
  }
  const env = {
    ...process.env,
    POSTGRES_PASSWORD: 'fake-password-for-compose-db-test',
    DEVELOPER_EMAIL: 'developer@example.com',
    ...mailEnv,
  }
  // compose의 변수 치환을 검사한다. 실제 .env의 비밀값을 출력하지 않도록 시험용 환경만 쓴다.
  const args = ['compose', '--env-file', '/dev/null', 'config', '--format', 'json']
  const result = spawnSync('docker', args, {
    cwd: rootDirectory, env, encoding: 'utf8', timeout: 10_000,
  })

  // docker가 없거나 compose가 실패해도 건너뛰지 않는다.
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
  const config = JSON.parse(result.stdout)
  expect(config.services.api.environment).toMatchObject(mailEnv)

  for (const mode of [undefined, '']) {
    const defaultEnv: NodeJS.ProcessEnv = { ...env, MAIL_MODE: mode }
    if (mode === undefined) delete defaultEnv.MAIL_MODE
    const defaults = spawnSync('docker', args, {
      cwd: rootDirectory, env: defaultEnv, encoding: 'utf8', timeout: 10_000,
    })
    expect(defaults.error).toBeUndefined()
    expect(defaults.status, defaults.stderr).toBe(0)
    expect(JSON.parse(defaults.stdout).services.api.environment.MAIL_MODE).toBe('log')
  }
})

test('브라우저 테스트의 api와 api 테스트는 메일을 log 모드로 돌린다', () => {
  const servers = Array.isArray(browserConfig.webServer) ? browserConfig.webServer : [browserConfig.webServer]
  const apiServer = servers.find((server) => server?.url?.endsWith('/api/health'))
  expect(apiServer).toBeDefined()
  expect(apiServer?.env?.MAIL_MODE).toBe('log')

  // 다른 설정 파일이 이미 log로 바꾼 값에 기대지 않게 새 프로세스에 smtp를 준다.
  // Vitest가 쓰는 Vite 설정 로더로 실제 설정을 가져오되 DB 준비나 테스트는 실행하지 않는다.
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { loadConfigFromFile } from 'vite'
    const loaded = await loadConfigFromFile({ command: 'serve', mode: 'test' }, 'vitest.config.ts')
    if (!loaded) throw new Error('api 테스트 설정을 읽지 못했어요')
    const mode = loaded.config.test?.env?.MAIL_MODE ?? process.env.MAIL_MODE
    process.stdout.write(JSON.stringify({ mailMode: mode }))
  `], {
    cwd: fileURLToPath(new URL('../../api/', import.meta.url)),
    env: { ...process.env, MAIL_MODE: 'smtp' },
    encoding: 'utf8',
    timeout: 20_000,
  })

  expect(result.error).toBeUndefined()
  expect(result.status).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({ mailMode: 'log' })
})
