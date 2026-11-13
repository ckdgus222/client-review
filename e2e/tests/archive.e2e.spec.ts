import { test, expect, db, resetDatabase, createUser, createProject } from './fixtures.ts'

test.beforeEach(async () => {
  await resetDatabase()
})

test('보관한 프로젝트에서 쪽지를 쓰려 하면 보관한 프로젝트라는 오류가 보인다', async ({
  page,
  baseURL,
  loginAs,
}) => {
  const developer = await createUser('archive-developer@example.com', '개발자')
  const project = await createProject(developer.id, '쪽지 보관 오류 프로젝트')
  // 사진에 핀을 꽂지 않는 쪽지이므로 게시된 버전만 준비한다.
  const version = await db.deliveryVersion.create({
    data: { projectId: project.id, number: 0, status: 'IN_REVIEW', publishedAt: new Date() },
  })
  await db.project.update({ where: { id: project.id }, data: { currentVersionId: version.id } })
  await loginAs(developer.id)
  await page.goto(`/app/projects/${project.id}`)
  await page.getByRole('button', { name: '쪽지 쓰기', exact: true }).click()
  await page.getByLabel('제목 (필수)', { exact: true }).fill('여백을 넓혀 주세요')
  await page.getByLabel('내용', { exact: true }).fill('제목과 본문 사이 여백을 늘려 주세요')
  const sendButton = page.getByRole('button', { name: '쪽지 남기기', exact: true })
  await expect(sendButton).toBeEnabled()

  const headers = { Origin: new URL(baseURL!).origin }
  const archiveResponse = await page.request.post(`/api/projects/${project.id}/archive`, { headers })
  expect(archiveResponse.status()).toBe(204)
  const rejectedRequest = page.waitForResponse((response) =>
    response.request().method() === 'POST'
    && new URL(response.url()).pathname === `/api/projects/${project.id}/issues`,
  )
  await sendButton.click()
  expect((await rejectedRequest).status()).toBe(409)

  await expect(page.getByRole('alert')).toHaveText('보관한 프로젝트예요. 보관을 풀어야 바꿀 수 있어요')
  await expect(page.getByLabel('제목 (필수)', { exact: true })).toHaveValue('여백을 넓혀 주세요')
  await expect(page.getByLabel('내용', { exact: true })).toHaveValue('제목과 본문 사이 여백을 늘려 주세요')
  await expect(sendButton).toBeEnabled()
  expect(await db.issue.count({ where: { projectId: project.id } })).toBe(0)

  const unarchiveResponse = await page.request.post(`/api/projects/${project.id}/unarchive`, { headers })
  expect(unarchiveResponse.status()).toBe(204)
  const acceptedRequest = page.waitForResponse((response) =>
    response.request().method() === 'POST'
    && new URL(response.url()).pathname === `/api/projects/${project.id}/issues`,
  )
  await sendButton.click()
  expect((await acceptedRequest).status()).toBe(201)
  await expect(page.getByRole('heading', { name: '여백을 넓혀 주세요', exact: true })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(await db.issue.count({ where: { projectId: project.id } })).toBe(1)
})

test('보관한 프로젝트에서 게시 전 버전을 만들려 하면 보관한 프로젝트라는 오류가 보인다', async ({
  page,
  baseURL,
  loginAs,
}) => {
  const developer = await createUser('archive-developer@example.com', '개발자')
  const project = await createProject(developer.id, '게시 전 버전 보관 오류 프로젝트')
  await loginAs(developer.id)
  await page.goto(`/app/projects/${project.id}/draft`)
  const startButton = page.getByRole('button', { name: '초안 준비 시작', exact: true })
  await expect(startButton).toBeEnabled()

  const headers = { Origin: new URL(baseURL!).origin }
  const archiveResponse = await page.request.post(`/api/projects/${project.id}/archive`, { headers })
  expect(archiveResponse.status()).toBe(204)
  const rejectedRequest = page.waitForResponse((response) =>
    response.request().method() === 'POST'
    && new URL(response.url()).pathname === `/api/projects/${project.id}/versions`,
  )
  await startButton.click()
  expect((await rejectedRequest).status()).toBe(409)

  await expect(page.getByRole('alert')).toHaveText('보관한 프로젝트예요. 보관을 풀어야 바꿀 수 있어요')
  await expect(startButton).toBeEnabled()
  await expect(page.getByRole('textbox', { name: '설명', exact: true })).toHaveCount(0)
  expect(await db.deliveryVersion.count({ where: { projectId: project.id } })).toBe(0)

  const unarchiveResponse = await page.request.post(`/api/projects/${project.id}/unarchive`, { headers })
  expect(unarchiveResponse.status()).toBe(204)
  await startButton.click()
  await expect(page.getByRole('textbox', { name: '설명', exact: true })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(await db.deliveryVersion.count({ where: { projectId: project.id, status: 'DRAFT' } })).toBe(1)
})

test('클라이언트 목록에는 지운 프로젝트가 보이지 않고 보관한 프로젝트는 보관함에 보인다', async ({
  page,
  baseURL,
  loginAs,
}) => {
  const developer = await createUser('archive-developer@example.com', '개발자')
  const client = await createUser('archive-client@example.com', '클라이언트')
  const active = await createProject(developer.id, '진행하는 프로젝트')
  const archived = await createProject(developer.id, '보관할 프로젝트')
  const deleted = await createProject(developer.id, '지울 프로젝트')
  await db.projectMember.createMany({
    data: [active, archived, deleted].map((project) => ({
      projectId: project.id,
      userId: client.id,
      role: 'CLIENT',
    })),
  })
  await loginAs(client.id)
  await page.goto('/app/')

  const activeGroup = page.getByRole('region', {
    name: '진행 중',
    exact: true,
  })
  await expect(activeGroup.getByRole('link')).toHaveCount(3)
  await expect(activeGroup.getByRole('link', { name: deleted.name, exact: true })).toBeVisible()
  await expect(activeGroup.getByRole('link', { name: archived.name, exact: true })).toBeVisible()

  // 설정 화면의 버튼은 다음 조각에서 검사한다. 여기서는 실제 API로 상태를 바꾼 뒤 클라이언트 목록을 확인한다.
  await loginAs(developer.id)
  const headers = { Origin: new URL(baseURL!).origin }
  const archiveResponse = await page.request.post(`/api/projects/${archived.id}/archive`, { headers })
  expect(archiveResponse.status()).toBe(204)
  const deleteResponse = await page.request.post(`/api/projects/${deleted.id}/delete`, {
    headers,
    data: { name: deleted.name },
  })
  expect(deleteResponse.status()).toBe(204)
  await loginAs(client.id)
  await page.reload()

  await expect(activeGroup.getByRole('link')).toHaveCount(1)
  await expect(activeGroup.getByRole('link', { name: active.name, exact: true })).toBeVisible()
  const archivedGroup = page.getByRole('region', {
    name: '보관함',
    exact: true,
  })
  await expect(archivedGroup.getByRole('heading', { name: '보관함', exact: true })).toBeVisible()
  await expect(archivedGroup.getByRole('link')).toHaveCount(1)
  await expect(archivedGroup.getByRole('link', { name: archived.name, exact: true })).toHaveAttribute(
    'href',
    `/app/projects/${archived.id}`,
  )
  await expect(page.getByRole('link', { name: deleted.name, exact: true })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: '삭제 대기', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '되살리기', exact: true })).toHaveCount(0)
  await expect(page.getByText('아직 프로젝트가 없어요.', { exact: true })).toHaveCount(0)
})

test('개발자가 프로젝트를 보관하면 목록의 보관함으로 가고 검수실에 보관 띠가 보이며 보관을 풀 수 있다', async ({
  page,
  loginAs,
}) => {
  const developer = await createUser('archive-developer@example.com', '개발자')
  const project = await createProject(developer.id, '보관할 프로젝트')
  await loginAs(developer.id)
  await page.goto(`/app/projects/${project.id}/settings`)
  await expect(page.getByRole('status')).toHaveCount(0)

  await page.getByRole('button', { name: '보관하기', exact: true }).click()

  await expect(page.getByRole('status')).toHaveText('보관한 프로젝트예요. 읽기만 할 수 있어요')
  await expect(page.getByRole('button', { name: '보관 풀기', exact: true })).toBeEnabled()
  await page.getByRole('link', { name: '프로젝트 목록', exact: true }).click()
  const archivedGroup = page.getByRole('region', {
    name: '보관함',
    exact: true,
  })
  await expect(archivedGroup.getByRole('link', { name: project.name, exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: '진행 중', exact: true })).toHaveCount(0)

  await archivedGroup.getByRole('link', { name: project.name, exact: true }).click()
  await expect(page).toHaveURL(`/app/projects/${project.id}`)
  await expect(page.getByRole('status')).toHaveText('보관한 프로젝트예요. 읽기만 할 수 있어요')
  await page.getByRole('link', { name: '설정', exact: true }).click()
  await page.getByRole('button', { name: '보관 풀기', exact: true }).click()

  await expect(page.getByRole('button', { name: '보관하기', exact: true })).toBeEnabled()
  await expect(page.getByRole('status')).toHaveCount(0)
  await page.getByRole('link', { name: '프로젝트 목록', exact: true }).click()
  const activeGroup = page.getByRole('region', {
    name: '진행 중',
    exact: true,
  })
  await expect(activeGroup.getByRole('link', { name: project.name, exact: true })).toBeVisible()
  await expect(archivedGroup).toHaveCount(0)
  await activeGroup.getByRole('link', { name: project.name, exact: true }).click()
  await expect(page.getByRole('heading', { name: project.name, exact: true })).toBeVisible()
  await expect(page.getByRole('status')).toHaveCount(0)
})

test('개발자가 이름을 입력해 프로젝트를 지우면 삭제 대기 묶음에 남은 날짜와 함께 보이고 되살릴 수 있다', async ({
  page,
  loginAs,
}) => {
  const developer = await createUser('archive-developer@example.com', '개발자')
  const project = await createProject(developer.id, '지울 프로젝트')
  await loginAs(developer.id)
  await page.goto(`/app/projects/${project.id}/settings`)
  await page
    .getByLabel('지우려면 프로젝트 이름을 그대로 입력해 주세요', {
      exact: true,
    })
    .fill(`  ${project.name}  `)
  await expect(page.getByRole('button', { name: '프로젝트 지우기', exact: true })).toBeEnabled()

  await page.getByRole('button', { name: '프로젝트 지우기', exact: true }).click()

  // 목록 주소는 /app과 /app/ 둘 다 같은 화면이다(smoke·invitations e2e와 같은 확인).
  await expect(page).toHaveURL(/\/app\/?$/)
  const deletedGroup = page.getByRole('region', {
    name: '삭제 대기',
    exact: true,
  })
  await expect(deletedGroup.getByRole('link', { name: project.name, exact: true })).toBeVisible()
  await expect(deletedGroup.getByText('7일 뒤 완전히 지워져요', { exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: '진행 중', exact: true })).toHaveCount(0)
  await deletedGroup.getByRole('link', { name: project.name, exact: true }).click()
  await expect(page.getByRole('status')).toHaveText('삭제 대기 중인 프로젝트예요. 7일 뒤 완전히 지워져요')
  await page.getByRole('link', { name: '설정', exact: true }).click()
  await expect(page.getByRole('status')).toHaveText('삭제 대기 중인 프로젝트예요. 7일 뒤 완전히 지워져요')
  await expect(page.getByRole('heading', { name: '보관과 지우기', exact: true })).toHaveCount(0)
  await page.getByRole('link', { name: '프로젝트 목록', exact: true }).click()

  await deletedGroup.getByRole('button', { name: '되살리기', exact: true }).click()

  const activeGroup = page.getByRole('region', {
    name: '진행 중',
    exact: true,
  })
  await expect(activeGroup.getByRole('link', { name: project.name, exact: true })).toBeVisible()
  await expect(deletedGroup).toHaveCount(0)
  await activeGroup.getByRole('link', { name: project.name, exact: true }).click()
  await expect(page.getByRole('heading', { name: project.name, exact: true })).toBeVisible()
  await expect(page.getByRole('status')).toHaveCount(0)
  await page.getByRole('link', { name: '설정', exact: true }).click()
  await expect(page.getByRole('button', { name: '보관하기', exact: true })).toBeEnabled()
})

test('프로젝트 이름을 다르게 입력하면 지우기 버튼이 눌리지 않는다', async ({ page, loginAs }) => {
  const developer = await createUser('archive-developer@example.com', '개발자')
  const project = await createProject(developer.id, 'Review 프로젝트')
  await loginAs(developer.id)
  await page.goto(`/app/projects/${project.id}/settings`)
  const nameInput = page.getByLabel('지우려면 프로젝트 이름을 그대로 입력해 주세요', { exact: true })
  const deleteButton = page.getByRole('button', {
    name: '프로젝트 지우기',
    exact: true,
  })
  await expect(deleteButton).toBeDisabled()

  for (const name of ['다른 이름', 'review 프로젝트', 'Review프로젝트', 'Review  프로젝트', '   ']) {
    await nameInput.fill(name)
    await expect(deleteButton).toBeDisabled()
  }

  await nameInput.fill(project.name)
  await expect(deleteButton).toBeEnabled()
  await nameInput.fill(`  ${project.name}  `)
  await expect(deleteButton).toBeEnabled()
  await nameInput.fill(`${project.name}!`)
  await expect(deleteButton).toBeDisabled()
  await nameInput.press('Enter')
  await expect(page).toHaveURL(`/app/projects/${project.id}/settings`)
  await page.getByRole('link', { name: '프로젝트 목록', exact: true }).click()
  await expect(
    page.getByRole('region', { name: '진행 중', exact: true }).getByRole('link', { name: project.name, exact: true }),
  ).toBeVisible()
  await expect(page.getByRole('region', { name: '삭제 대기', exact: true })).toHaveCount(0)
})

test('보관한 프로젝트에서 화면을 만들려 하면 보관한 프로젝트라는 오류가 보인다', async ({ page, loginAs }) => {
  const developer = await createUser('archive-developer@example.com', '개발자')
  const project = await createProject(developer.id, '읽기 전용 프로젝트')
  await loginAs(developer.id)
  await page.goto(`/app/projects/${project.id}/settings`)
  await page.getByRole('button', { name: '보관하기', exact: true }).click()
  await expect(page.getByRole('status')).toHaveText('보관한 프로젝트예요. 읽기만 할 수 있어요')
  await page.getByLabel('화면 이름', { exact: true }).fill('메인')
  await expect(page.getByRole('button', { name: '만들기', exact: true })).toBeEnabled()

  await page.getByRole('button', { name: '만들기', exact: true }).click()

  await expect(page.getByRole('alert')).toHaveText('보관한 프로젝트예요. 보관을 풀어야 바꿀 수 있어요')
  await expect(page.getByText('메인 · PC', { exact: true })).toHaveCount(0)
  expect(await db.screen.count({ where: { projectId: project.id } })).toBe(0)
  await page.getByRole('button', { name: '보관 풀기', exact: true }).click()
  await expect(page.getByRole('button', { name: '보관하기', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '만들기', exact: true }).click()

  await expect(page.getByText('메인 · PC', { exact: true })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(await db.screen.count({ where: { projectId: project.id } })).toBe(1)
})

test('개발자는 삭제 대기 프로젝트의 활동 일지에서 기록 메일 실패를 본다', async ({ page, baseURL, loginAs }) => {
  const developer = await createUser('archive-developer@example.com', '개발자')
  const project = await createProject(developer.id, '삭제 기록 확인 프로젝트')
  await loginAs(developer.id)
  const deleteResponse = await page.request.post(`/api/projects/${project.id}/delete`, {
    headers: { Origin: new URL(baseURL!).origin },
    data: { name: project.name },
  })
  expect(deleteResponse.status()).toBe(204)

  // 실제 API가 만든 기록 메일을 실패 상태로 바꾼다. 다섯 번 재시도하는 동작은 api e2e에서 확인한다.
  const failedMail = await db.notificationDelivery.updateMany({
    where: {
      event: { projectId: project.id, type: 'PROJECT_DELETE_REQUESTED' },
      toEmail: developer.email,
    },
    data: { status: 'FAILED', attempts: 5, sentAt: null },
  })
  expect(failedMail.count).toBe(1)

  await page.goto('/app/')
  await page
    .getByRole('region', { name: '삭제 대기', exact: true })
    .getByRole('link', { name: project.name, exact: true })
    .click()
  await expect(page.getByRole('status')).toHaveText('삭제 대기 중인 프로젝트예요. 7일 뒤 완전히 지워져요')
  await page.getByRole('link', { name: '활동 일지', exact: true }).click()

  await expect(page).toHaveURL(`/app/projects/${project.id}/activity`)
  await expect(page.getByRole('heading', { name: `${project.name} 활동 일지`, exact: true })).toBeVisible()
  const deleteMessage = '개발자님이 프로젝트를 지웠어요(7일 뒤 완전히 지워져요)'
  const deletedRow = page.getByRole('listitem').filter({ hasText: deleteMessage })
  await expect(deletedRow).toHaveCount(1)
  await expect(deletedRow.getByText(deleteMessage, { exact: true })).toBeVisible()
  await expect(deletedRow.getByText(`메일 실패: ${developer.email}`, { exact: true })).toBeVisible()
  await expect(deletedRow.getByRole('link')).toHaveCount(0)
})
