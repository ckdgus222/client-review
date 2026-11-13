import { test, expect, db, resetDatabase, createUser, createProject } from './fixtures.ts'

test.beforeEach(async () => {
  await resetDatabase()
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
