import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import type { BrowserContext, Page } from '@playwright/test'
import { createSessionToken, hashSessionToken } from '../../api/src/auth/token.ts'
import { test, expect, db, resetDatabase, createUser, createProject } from './fixtures.ts'

const sharp = createRequire(new URL('../../api/package.json', import.meta.url))('sharp')

// 게시와 사진 업로드 화면은 다른 기능이다. 이 테스트는 검수할 사진이 있는 상태에서 시작한다.
const publishVersion = async (projectId: string, screenIds: string[], number: number) => {
  const version = await db.deliveryVersion.create({
    data: { projectId, number, status: 'IN_REVIEW', publishedAt: new Date() },
  })
  const screens = []
  await mkdir(new URL(`../.assets/${projectId}/`, import.meta.url), { recursive: true })
  for (const screenId of screenIds) {
    const storageKey = `${projectId}/${randomUUID()}.png`
    const photo: Buffer = await sharp({
      create: { width: 1200, height: 800, channels: 3, background: number === 0 ? '#d7e8ff' : '#ffe8cc' },
    }).png().toBuffer()
    await writeFile(new URL(`../.assets/${storageKey}`, import.meta.url), photo, { flag: 'wx' })
    const asset = await db.asset.create({
      data: { projectId, storageKey, mime: 'image/png', bytes: photo.length, width: 1200, height: 800 },
    })
    screens.push(await db.versionScreen.create({ data: { versionId: version.id, screenId, assetId: asset.id } }))
  }
  await db.project.update({ where: { id: projectId }, data: { currentVersionId: version.id } })
  await db.issue.updateMany({
    where: { projectId, status: 'READY_FOR_REVIEW' }, data: { status: 'IN_PROGRESS' },
  })
  return { ...version, screens }
}

const prepareRoom = async () => {
  const developer = await createUser('developer@example.com', '개발자')
  const client = await createUser('client@example.com', '클라이언트')
  const approver = await createUser('approver@example.com', '승인자')
  const project = await createProject(developer.id, '승인 검수 프로젝트')
  await db.projectMember.create({ data: { projectId: project.id, userId: client.id, role: 'CLIENT' } })
  const approverMember = await db.projectMember.create({
    data: { projectId: project.id, userId: approver.id, role: 'CLIENT' },
  })
  await db.project.update({ where: { id: project.id }, data: { approverMemberId: approverMember.id } })
  // 화면 목록은 만든 시각 순이다. 두 줄을 같은 밀리초에 만들면 순서가 뒤바뀔 수 있어서 시각을 다르게 적는다.
  const main = await db.screen.create({
    data: { projectId: project.id, name: '메인', viewport: 'PC', createdAt: new Date(Date.now() - 60_000) },
  })
  const product = await db.screen.create({ data: { projectId: project.id, name: '상품 상세', viewport: 'PC' } })
  const version = await publishVersion(project.id, [main.id, product.id], 0)
  return { developer, client, approver, project, main, product, version }
}

type Room = Awaited<ReturnType<typeof prepareRoom>>

const seedIssue = async (room: Room, title = '버튼 색을 바꿔 주세요', authorId = room.client.id, pin = true) =>
  db.issue.create({
    data: {
      projectId: room.project.id,
      originVersionId: room.version.id,
      originVersionScreenId: pin ? room.version.screens[0].id : null,
      xRatio: pin ? 0.3 : null,
      yRatio: pin ? 0.4 : null,
      authorId,
      number: await db.issue.count({ where: { projectId: room.project.id } }) + 1,
      title,
      body: '처음 남긴 요청 내용',
      requestId: randomUUID(),
    },
  })

// fixture의 loginAs는 기본 context만 바꾸므로 다른 참여자의 창에는 별도 세션을 심는다.
const loginContext = async (context: BrowserContext, baseURL: string, userId: string) => {
  const token = createSessionToken()
  await db.session.create({
    data: { userId, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
  })
  await context.addCookies([{ name: 'sid', value: token, url: baseURL }])
}

const dialog = (page: Page) => page.getByRole('dialog')
const banner = (page: Page) => page.getByRole('region', { name: '승인 안내', exact: true })
const picker = (page: Page) => page.getByRole('combobox', { name: '버전', exact: true })
const photo = (page: Page, name = '메인 · PC') => page.getByRole('img', { name, exact: true })
const comment = (page: Page) => page.getByRole('textbox', { name: '댓글', exact: true })
const detail = (page: Page, number = 1) => page.getByRole('article', { name: `쪽지 #${number}`, exact: true })
const latestButton = (page: Page) => page.getByRole('button', { name: '최신 버전 보기', exact: true })
const UNKNOWN_APPROVAL = '승인됐는지 확인하지 못했어요. 승인 완료가 보이지 않으면 다시 눌러 주세요'

const openRoom = async (page: Page, room: Room, query = '') => {
  await page.goto(`/app/projects/${room.project.id}${query}`)
  await expect(photo(page)).toBeVisible()
}
const openApproval = async (page: Page) => {
  await page.getByRole('button', { name: '버전 승인', exact: true }).click()
  await expect(dialog(page)).toBeVisible()
  await expect(dialog(page).getByText('승인 검토를 불러오는 중이에요', { exact: true })).toHaveCount(0)
}
const confirmApproval = async (page: Page) => {
  await dialog(page).getByRole('button', { name: '승인하기', exact: true }).click()
  await expect(dialog(page).getByText('이 버전을 승인할까요? 승인하면 되돌릴 수 없어요.', { exact: true })).toBeVisible()
  await dialog(page).getByRole('button', { name: '승인 확정', exact: true }).click()
}
const approveAndWait = async (page: Page, versionId: string, status = 200) => {
  const pending = page.waitForResponse((response) =>
    new URL(response.url()).pathname === `/api/versions/${versionId}/approve` && response.request().method() === 'POST',
  )
  await confirmApproval(page)
  const response = await pending
  expect(response.status()).toBe(status)
  return response
}
const closeApproval = async (page: Page) => {
  await dialog(page).getByRole('button', { name: '닫기', exact: true }).last().click()
  await expect(dialog(page)).toHaveCount(0)
}
const pollVersion = async (page: Page, versionId: string) => {
  const pending = page.waitForResponse((response) =>
    new URL(response.url()).pathname === `/api/versions/${versionId}` && response.request().method() === 'GET',
  )
  await page.clock.fastForward(15_000)
  expect((await pending).status()).toBe(200)
}
const seedApproval = async (room: Room, versionId = room.version.id) => {
  const issues = await db.issue.findMany({ where: { projectId: room.project.id }, orderBy: { number: 'asc' },
    select: { number: true, title: true, category: true, scope: true, status: true } })
  await db.$transaction([
    db.deliveryVersion.update({ where: { id: versionId }, data: { status: 'APPROVED' } }),
    db.approval.create({ data: { versionId, approverId: room.approver.id, summary: { issues } } }),
  ])
}
const seedComment = async (room: Room, issueId: string, body: string) => db.comment.create({
  data: { issueId, versionId: room.version.id, authorId: room.developer.id, body, requestId: randomUUID() },
})
const fillIssue = async (page: Page) => {
  await page.getByRole('button', { name: '쪽지 쓰기', exact: true }).click()
  await page.getByLabel('제목 (필수)', { exact: true }).fill('남겨 둔 제목')
  await page.getByLabel('내용', { exact: true }).fill('남겨 둔 내용')
}
// 응답을 보류하되 요청과 응답 본문은 실제 서버의 것을 쓴다.
const holdResponse = async (page: Page, path: string) => {
  let release!: () => void
  let reached!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const received = new Promise<void>((resolve) => { reached = resolve })
  await page.route(`**/api/${path}`, async (route) => {
    const response = await route.fetch()
    reached()
    await gate
    await route.fulfill({ response })
  }, { times: 1 })
  return { release, received }
}

test.beforeEach(async ({ page }) => {
  await resetDatabase()
  await page.clock.install({ time: new Date('2026-11-13T00:00:00Z') })
  await page.clock.pauseAt(new Date('2026-11-13T00:00:01Z'))
})

test('버전 승인 버튼은 승인자에게만, 검수 중인 현재 버전에서만 보인다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  for (const user of [room.developer, room.client, room.approver]) {
    await loginAs(user.id)
    await openRoom(page, room)
    await expect(page.getByRole('button', { name: '버전 승인', exact: true })).toHaveCount(user === room.approver ? 1 : 0)
  }
  const latest = await publishVersion(room.project.id, [room.main.id, room.product.id], 1)
  await openRoom(page, room, `?version=${room.version.id}`)
  await expect(page.getByText('읽기 전용', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '버전 승인', exact: true })).toHaveCount(0)
  await picker(page).selectOption(latest.id)
  await expect(page.getByRole('button', { name: '버전 승인', exact: true })).toBeVisible()
  await seedApproval(room, latest.id)
  await pollVersion(page, latest.id)
  await expect(page.getByRole('button', { name: '버전 승인', exact: true })).toHaveCount(0)
  await expect(page.getByText('승인됨', { exact: true })).toBeVisible()
})

test('승인자가 승인하면 승인 완료 안내와 승인 띠가 보이고 개발자와 다른 클라이언트에게도 승인 띠와 읽기 전용이 보인다', async ({ page, browser, baseURL, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  await db.issue.update({ where: { id: issue.id }, data: { scope: 'OUT_OF_SCOPE' } })
  await loginAs(room.approver.id)
  await openRoom(page, room, `?issue=${issue.id}`)
  const contexts: BrowserContext[] = []
  try {
    const observers: Page[] = []
    for (const user of [room.developer, room.client]) {
      const context = await browser.newContext({ baseURL })
      contexts.push(context)
      await loginContext(context, baseURL!, user.id)
      const observer = await context.newPage()
      await observer.clock.install({ time: new Date('2026-11-13T00:00:00Z') })
      await observer.clock.pauseAt(new Date('2026-11-13T00:00:01Z'))
      await openRoom(observer, room, `?issue=${issue.id}`)
      await expect(comment(observer)).toBeVisible()
      await expect(banner(observer)).toHaveCount(0)
      observers.push(observer)
    }
    await openApproval(page)
    const response = await approveAndWait(page, room.version.id)
    const saved = await response.json()
    await expect(dialog(page)).toHaveAccessibleName('초안 승인 완료')
    await expect(dialog(page).getByText('초안이 승인됐어요', { exact: false })).toBeVisible()
    const approval = await db.approval.findUniqueOrThrow({ where: { versionId: room.version.id } })
    expect(saved.approval.approverName).toBe(room.approver.name)
    expect(saved.approval.approvedAt).toBe(approval.approvedAt.toISOString())
    await closeApproval(page)
    for (const observer of observers) await pollVersion(observer, room.version.id)
    for (const participant of [page, ...observers]) {
      const approvedAt = await participant.evaluate((value) => new Intl.DateTimeFormat('ko-KR', {
        dateStyle: 'medium', timeStyle: 'short',
      }).format(new Date(value)), saved.approval.approvedAt)
      await expect(banner(participant)).toContainText(`승인자 승인자 · ${approvedAt}`)
      await expect(banner(participant)).toContainText('이 버전은 읽기 전용이에요. 새 요청은 다음 차수에서 할 수 있어요.')
      await expect(participant.getByText('승인됨', { exact: true })).toBeVisible()
      await expect(comment(participant)).toHaveCount(0)
      await expect(participant.getByRole('button', { name: /^(쪽지 쓰기|고쳤어요 보내기|확인 완료)$/ })).toHaveCount(0)
    }
  } finally {
    for (const context of contexts) await context.close()
  }
})

test('끝나지 않은 쪽지가 있으면 승인 검토에 목록이 보이고 승인하기를 누를 수 없으며 쪽지를 확인 완료하면 승인된다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  await db.resolutionAttempt.create({ data: {
    issueId: issue.id, versionId: room.version.id, versionScreenId: room.version.screens[0].id,
    summary: '색을 고쳤어요', submittedById: room.developer.id,
  } })
  await db.issue.update({ where: { id: issue.id }, data: { status: 'READY_FOR_REVIEW' } })
  await loginAs(room.approver.id)
  await openRoom(page, room)
  await openApproval(page)
  await expect(dialog(page).getByText('아직 끝나지 않은 쪽지가 1개 있어요', { exact: true })).toBeVisible()
  await expect(dialog(page).getByText(issue.title, { exact: true })).toBeVisible()
  await expect(dialog(page).getByText('확인 요청', { exact: true })).toBeVisible()
  await expect(dialog(page).getByRole('button', { name: '승인하기', exact: true })).toBeDisabled()
  await dialog(page).getByRole('button', { name: '쪽지 #1 열기', exact: true }).click()
  await expect(dialog(page)).toHaveCount(0)
  await expect(detail(page)).toContainText(issue.title)
  await detail(page).getByRole('button', { name: '확인 완료', exact: true }).click()
  await expect(detail(page).locator('[data-status]')).toHaveText('확인 완료')
  await openApproval(page)
  await approveAndWait(page, room.version.id)
  await expect(dialog(page)).toHaveAccessibleName('초안 승인 완료')
})

test('범위 밖 쪽지와 이번 차수의 댓글이 승인 검토에 보이고 승인된다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room, '다음에 추가할 요청')
  await db.issue.update({ where: { id: issue.id }, data: { scope: 'OUT_OF_SCOPE' } })
  await seedComment(room, issue.id, '다음 차수에서 진행해요')
  await loginAs(room.approver.id)
  await openRoom(page, room)
  await openApproval(page)
  await expect(dialog(page).getByText('범위 밖(추가 요청) 쪽지 1개는 이번 승인에서 빼요', { exact: true })).toBeVisible()
  await expect(dialog(page).getByRole('region', { name: '범위 밖 쪽지' })).toContainText(issue.title)
  const comments = dialog(page).getByRole('region', { name: '이번 차수의 댓글' })
  await expect(comments).toContainText(`#1 ${issue.title}`)
  await expect(comments).toContainText('개발자')
  await expect(comments).toContainText('다음 차수에서 진행해요')
  await approveAndWait(page, room.version.id)
  await expect(dialog(page)).toHaveAccessibleName('초안 승인 완료')
  expect((await db.issue.findUniqueOrThrow({ where: { id: issue.id } })).status).toBe('OPEN')
})

test('승인 검토를 연 뒤 새 댓글이 달리면 안내와 새 댓글이 보이고 다시 누르면 승인된다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  await db.issue.update({ where: { id: issue.id }, data: { status: 'VERIFIED' } })
  await loginAs(room.approver.id)
  await openRoom(page, room)
  await openApproval(page)
  await seedComment(room, issue.id, '방금 추가한 설명')
  const response = await approveAndWait(page, room.version.id, 409)
  expect((await response.json()).code).toBe('NEW_COMMENTS')
  await expect(dialog(page).getByText('새 댓글이 있어요. 확인 후 다시 승인해 주세요', { exact: true })).toBeVisible()
  await expect(dialog(page).getByText('방금 추가한 설명', { exact: true })).toBeVisible()
  expect(await db.approval.count()).toBe(0)
  await approveAndWait(page, room.version.id)
  await expect(dialog(page)).toHaveAccessibleName('초안 승인 완료')
})

test('승인 검토를 연 뒤 새 쪽지가 생기면 승인이 거절되고 그 쪽지가 목록에 보이며 승인하기가 잠긴다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  await loginAs(room.approver.id)
  await openRoom(page, room)
  await openApproval(page)
  const issue = await seedIssue(room, '방금 생긴 하자')
  const response = await approveAndWait(page, room.version.id, 409)
  expect((await response.json()).code).toBe('UNRESOLVED_ISSUES')
  await expect(dialog(page).getByText('아직 끝나지 않은 쪽지가 있어요', { exact: true })).toBeVisible()
  await expect(dialog(page).getByText(issue.title, { exact: true })).toBeVisible()
  await expect(dialog(page).getByRole('button', { name: '승인하기', exact: true })).toBeDisabled()
  expect(await db.approval.count()).toBe(0)
})

test('승인 검토를 연 뒤 승인자가 바뀌면 승인이 거절되고 승인하기와 버전 승인 버튼이 사라진다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  await loginAs(room.approver.id)
  await openRoom(page, room)
  await openApproval(page)
  const replacement = await db.projectMember.findUniqueOrThrow({ where: { projectId_userId: { projectId: room.project.id, userId: room.client.id } } })
  await db.project.update({ where: { id: room.project.id }, data: { approverMemberId: replacement.id } })
  await approveAndWait(page, room.version.id, 403)
  await expect(dialog(page).getByText('승인자만 할 수 있어요', { exact: true })).toBeVisible()
  await expect(dialog(page).getByRole('button', { name: '승인하기', exact: true })).toHaveCount(0)
  await closeApproval(page)
  await expect(page.getByRole('button', { name: '버전 승인', exact: true })).toHaveCount(0)
  expect(await db.approval.count()).toBe(0)
})

test('승인 검토를 불러오지 못하면 안내와 다시 불러오기가 보이고 다시 불러오면 승인할 수 있다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  await loginAs(room.approver.id)
  await openRoom(page, room)
  await page.route(`**/api/versions/${room.version.id}/approval-check`, async (route) => { await route.abort('failed') })
  await openApproval(page)
  await expect(dialog(page).getByText('승인 검토를 불러오지 못했어요. 연결을 확인하고 다시 불러와 주세요', { exact: true })).toBeVisible()
  await expect(dialog(page).getByRole('button', { name: '승인하기', exact: true })).toHaveCount(0)
  await page.unroute(`**/api/versions/${room.version.id}/approval-check`)
  await dialog(page).getByRole('button', { name: '다시 불러오기', exact: true }).click()
  await expect(dialog(page).getByRole('button', { name: '승인하기', exact: true })).toBeEnabled()
  await approveAndWait(page, room.version.id)
  await expect(dialog(page)).toHaveAccessibleName('초안 승인 완료')
})

test('승인하기는 확인 단계에서 취소하거나 창을 닫으면 보내지 않는다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  await loginAs(room.approver.id)
  await openRoom(page, room)
  const requests: string[] = []
  page.on('request', (request) => { if (request.url().endsWith('/approve')) requests.push(request.url()) })
  await openApproval(page)
  await dialog(page).getByRole('button', { name: '승인하기', exact: true }).click()
  await dialog(page).getByRole('button', { name: '취소', exact: true }).click()
  await expect(dialog(page).getByRole('button', { name: '승인하기', exact: true })).toBeVisible()
  await dialog(page).getByRole('button', { name: '승인하기', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(dialog(page)).toHaveCount(0)
  await openApproval(page)
  await closeApproval(page)
  expect(requests).toHaveLength(0)
  expect(await db.approval.count()).toBe(0)
  expect((await db.deliveryVersion.findUniqueOrThrow({ where: { id: room.version.id } })).status).toBe('IN_REVIEW')
})

test('새 버전이 게시된 뒤 15초가 지나도 보던 버전과 쓰던 댓글과 열어 둔 승인 검토가 그대로이고 승인하면 새 버전 안내가 보인다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  await db.issue.update({ where: { id: issue.id }, data: { status: 'VERIFIED' } })
  await loginAs(room.approver.id)
  await openRoom(page, room, `?issue=${issue.id}`)
  await comment(page).fill('아직 보내지 않은 댓글')
  const imageUrl = await photo(page).getAttribute('src')
  await openApproval(page)
  const projects: string[] = []
  page.on('request', (request) => { if (new URL(request.url()).pathname === `/api/projects/${room.project.id}`) projects.push(request.url()) })
  await publishVersion(room.project.id, [room.main.id, room.product.id], 1)
  await pollVersion(page, room.version.id)
  await expect(picker(page)).toHaveValue(room.version.id)
  await expect(comment(page)).toHaveValue('아직 보내지 않은 댓글')
  await expect(photo(page)).toHaveAttribute('src', imageUrl!)
  await expect(dialog(page)).toHaveAccessibleName('초안 승인 검토')
  const response = await approveAndWait(page, room.version.id, 409)
  expect((await response.json()).code).toBe('VERSION_CHANGED')
  await expect(dialog(page).getByText(/새 버전이 올라왔어요/)).toBeVisible()
  expect(projects).toHaveLength(0)
  expect(await db.approval.count()).toBe(0)
})

test('승인하는 사이 새 버전이 올라오면 안내가 보이고 최신 버전에서 다시 승인한다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  await loginAs(room.approver.id)
  await openRoom(page, room)
  await openApproval(page)
  const next = await publishVersion(room.project.id, [room.main.id, room.product.id], 1)
  await approveAndWait(page, room.version.id, 409)
  await expect(dialog(page).getByText(/새 버전이 올라왔어요/)).toBeVisible()
  await dialog(page).getByRole('button', { name: '최신 버전 보기', exact: true }).click()
  await expect(dialog(page)).toHaveCount(0)
  await expect(picker(page)).toHaveValue(next.id)
  await openApproval(page)
  await expect(dialog(page)).toHaveAccessibleName('1차 승인 검토')
  await approveAndWait(page, next.id)
  await expect(dialog(page)).toHaveAccessibleName('1차 승인 완료')
  expect(await db.approval.findMany({ select: { versionId: true } })).toEqual([{ versionId: next.id }])
})

for (const publishNext of [false, true]) {
  test(publishNext
    ? '승인이 저장된 뒤 응답이 끊기고 그사이 새 버전이 게시돼도 승인했던 버전이 승인됨으로 보인다'
    : '승인이 저장된 뒤 응답이 끊기면 안내가 보이고 새로 불러오면 승인됨이 보인다', async ({ page, loginAs }) => {
    const room = await prepareRoom()
    await loginAs(room.approver.id)
    await openRoom(page, room)
    await openApproval(page)
    const held = await holdResponse(page, `versions/${room.version.id}`)
    const projectRequests: string[] = []
    page.on('request', (request) => { if (new URL(request.url()).pathname === `/api/projects/${room.project.id}`) projectRequests.push(request.url()) })
    await page.route(`**/api/versions/${room.version.id}/approve`, async (route) => {
      const response = await route.fetch()
      expect(response.status()).toBe(200)
      if (publishNext) await publishVersion(room.project.id, [room.main.id, room.product.id], 1)
      await route.abort('failed')
    }, { times: 1 })
    try {
      await confirmApproval(page)
      await expect(dialog(page).getByText(UNKNOWN_APPROVAL, { exact: true })).toBeVisible()
      await held.received
      expect(await db.approval.count({ where: { versionId: room.version.id } })).toBe(1)
      held.release()
      await expect(dialog(page)).toHaveAccessibleName('초안 승인 완료')
      await expect(dialog(page).getByText(UNKNOWN_APPROVAL, { exact: true })).toHaveCount(0)
      await closeApproval(page)
      await expect(banner(page)).toContainText('초안이 승인됐어요')
      await expect(picker(page)).toHaveValue(room.version.id)
      expect(projectRequests).toHaveLength(0)
    } finally {
      held.release()
    }
  })
}

test('승인된 버전에서는 쪽지 쓰기와 댓글 칸이 없고 다음 버전을 게시하면 다시 쓸 수 있다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  await db.issue.update({ where: { id: issue.id }, data: { scope: 'OUT_OF_SCOPE' } })
  await loginAs(room.approver.id)
  await openRoom(page, room, `?issue=${issue.id}`)
  await openApproval(page)
  await approveAndWait(page, room.version.id)
  await closeApproval(page)
  await expect(comment(page)).toHaveCount(0)
  await expect(page.getByRole('button', { name: '쪽지 쓰기', exact: true })).toHaveCount(0)
  const next = await publishVersion(room.project.id, [room.main.id, room.product.id], 1)
  await latestButton(page).click()
  await expect(picker(page)).toHaveValue(next.id)
  await expect(comment(page)).toBeVisible()
  await expect(page.getByRole('button', { name: '쪽지 쓰기', exact: true })).toBeVisible()
  await comment(page).fill('다음 차수에서 남기는 댓글')
  await page.getByRole('button', { name: '댓글 남기기', exact: true }).click()
  await expect(detail(page).getByText('다음 차수에서 남기는 댓글', { exact: true })).toBeVisible()
  // 댓글 칸이 비워진 뒤에(보내기가 끝난 뒤에) 쪽지 쓰기를 누른다. 댓글은 먼저 시작한 쪽지 새로 읽기의 응답으로
  // 보내기 응답보다 먼저 보일 수 있는데, 그때 누르면 "쓰던 댓글이 사라져요" 확인 창이 떠서 쓰기 칸이 열리지 않는다.
  await expect(comment(page)).toHaveValue('')
  await fillIssue(page)
  await page.getByRole('button', { name: '쪽지 남기기', exact: true }).click()
  await expect(detail(page, 2)).toContainText('남겨 둔 제목')
  expect((await db.issue.findFirstOrThrow({ where: { title: '남겨 둔 제목' } })).originVersionId).toBe(next.id)
})

test('다음 버전을 게시한 뒤 지난 승인된 버전을 보면 그 버전의 승인 띠가 보이고 새 버전에는 없다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  await loginAs(room.approver.id)
  await openRoom(page, room)
  await openApproval(page)
  await approveAndWait(page, room.version.id)
  await closeApproval(page)
  const text = await banner(page).textContent()
  const next = await publishVersion(room.project.id, [room.main.id, room.product.id], 1)
  await latestButton(page).click()
  await expect(picker(page)).toHaveValue(next.id)
  await expect(banner(page)).toHaveCount(0)
  await picker(page).selectOption(room.version.id)
  await expect(banner(page)).toContainText('초안이 승인됐어요')
  await expect(banner(page)).toContainText('승인자 승인자 ·')
  expect(text).toContain((await banner(page).textContent())!)
  await expect(banner(page).getByRole('button', { name: '최신 버전 보기', exact: true })).toHaveCount(0)
  await expect(latestButton(page)).toHaveCount(1)
  await expect(page.getByText('승인됨', { exact: true })).toBeVisible()
})

test('승인된 버전을 열어 둔 사이 다음 버전이 게시되면 승인 띠의 최신 버전 보기로 쓰던 글을 잃지 않고 새 버전에 간다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  await loginAs(room.approver.id)
  await openRoom(page, room)
  await fillIssue(page)
  await seedApproval(room)
  await pollVersion(page, room.version.id)
  await expect(banner(page)).toBeVisible()
  // 더 새 버전이 없을 때도 글과 버전을 보존한다.
  const refreshed = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/versions/${room.version.id}`)
  await banner(page).getByRole('button', { name: '최신 버전 보기', exact: true }).click()
  await refreshed
  await expect(picker(page)).toHaveValue(room.version.id)
  const next = await publishVersion(room.project.id, [room.main.id, room.product.id], 1)
  await banner(page).getByRole('button', { name: '최신 버전 보기', exact: true }).click()
  await expect(picker(page)).toHaveValue(next.id)
  await expect(page.getByLabel('제목 (필수)', { exact: true })).toHaveValue('남겨 둔 제목')
  await expect(page.getByLabel('내용', { exact: true })).toHaveValue('남겨 둔 내용')
  await expect(page.getByRole('button', { name: '쪽지 남기기', exact: true })).toBeEnabled()
})

test('승인 검토 창이 떠 있는 동안 뒤의 화면은 눌리지 않고 Esc로 닫으면 쓰던 댓글이 그대로다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  await db.issue.update({ where: { id: issue.id }, data: { scope: 'OUT_OF_SCOPE' } })
  await loginAs(room.approver.id)
  await openRoom(page, room, `?issue=${issue.id}`)
  await comment(page).fill('모달을 닫아도 남길 댓글')
  const background = page.getByRole('button', { name: '상품 상세 · PC' })
  const position = await background.boundingBox()
  expect(position).not.toBeNull()
  await openApproval(page)
  await expect.poll(() => dialog(page).evaluate((element) => element.contains(document.activeElement))).toBe(true)
  // 브라우저 주소창 차례에는 BODY가 된다. 댓글·화면·버전 고르기 등 뒤 요소로는 이동하지 않는다.
  for (const key of ['Tab', 'Shift+Tab']) {
    let focusedDialogButton = false
    for (let i = 0; i < 8; i += 1) {
      await page.keyboard.press(key)
      const focus = await dialog(page).evaluate((element) => ({
        insideDialog: element.contains(document.activeElement),
        onBody: document.activeElement === document.body,
        onButton: document.activeElement instanceof HTMLButtonElement,
      }))
      expect(focus.insideDialog || focus.onBody).toBe(true)
      focusedDialogButton ||= focus.insideDialog && focus.onButton
    }
    expect(focusedDialogButton).toBe(true)
  }
  // 프로그램으로 focus를 호출해도 뒤 입력으로 빠지지 않는다.
  await comment(page).evaluate((element: HTMLTextAreaElement) => element.focus())
  await expect(comment(page)).not.toBeFocused()
  // locator.click의 자동 재시도를 쓰지 않고 실제 포인터를 뒤 화면 자리로 보낸다.
  await page.mouse.click(position!.x + 5, position!.y + 5)
  await expect(dialog(page)).toBeVisible()
  await expect(photo(page)).toBeVisible()
  await expect(photo(page, '상품 상세 · PC')).toHaveCount(0)
  await expect(page.getByLabel('제목 (필수)', { exact: true })).toHaveCount(0)
  await page.mouse.click(2, 2)
  await expect(dialog(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog(page)).toHaveCount(0)
  await expect(comment(page)).toHaveValue('모달을 닫아도 남길 댓글')
  await expect(page.getByRole('button', { name: '버전 승인', exact: true })).toBeFocused()
})

test('승인을 보내는 동안에는 승인 검토 창이 닫히지 않는다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  await loginAs(room.approver.id)
  await openRoom(page, room)
  await openApproval(page)
  const held = await holdResponse(page, `versions/${room.version.id}/approve`)
  try {
    await confirmApproval(page)
    await held.received
    await expect(dialog(page).getByRole('button', { name: '승인 확정', exact: true })).toBeDisabled()
    await expect(dialog(page).getByRole('button', { name: '취소', exact: true })).toBeDisabled()
    await dialog(page).getByRole('button', { name: '닫기', exact: true }).click()
    await expect(dialog(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await expect(dialog(page)).toBeVisible()
    await expect.poll(() => dialog(page).evaluate((element) => element.matches(':modal'))).toBe(true)
    held.release()
    await expect(dialog(page)).toHaveAccessibleName('초안 승인 완료')
    await closeApproval(page)
  } finally {
    held.release()
  }
})

test('승인 요청의 응답이 30초 동안 오지 않으면 확인하지 못했다는 안내가 보이고 창을 닫을 수 있다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  await loginAs(room.approver.id)
  await openRoom(page, room)
  await openApproval(page)
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  await page.route(`**/api/versions/${room.version.id}/approve`, async (route) => {
    await gate
    await route.abort('failed')
  }, { times: 1 })
  const failed = page.waitForEvent('requestfailed', { predicate: (request) => request.url().endsWith(`/${room.version.id}/approve`) })
  const reads: string[] = []
  page.on('request', (request) => { if (new URL(request.url()).pathname === `/api/versions/${room.version.id}`) reads.push(request.url()) })
  try {
    await confirmApproval(page)
    await page.clock.fastForward(29_999)
    await expect(dialog(page).getByRole('button', { name: '승인 확정', exact: true })).toBeDisabled()
    await expect(dialog(page).getByText(UNKNOWN_APPROVAL, { exact: true })).toHaveCount(0)
    const beforeTimeout = reads.length
    await page.clock.fastForward(1)
    await failed
    await expect(dialog(page).getByText(UNKNOWN_APPROVAL, { exact: true })).toBeVisible()
    await expect.poll(() => reads.length).toBeGreaterThan(beforeTimeout)
    await expect(dialog(page).getByRole('button', { name: '승인하기', exact: true })).toBeEnabled()
    await page.keyboard.press('Escape')
    await expect(dialog(page)).toHaveCount(0)
    await expect(page.getByRole('button', { name: '쪽지 쓰기', exact: true })).toBeEnabled()
    expect(await db.approval.count()).toBe(0)
  } finally {
    release()
  }
})

test('새 쪽지를 쓰는 중에는 승인 검토의 쪽지 번호가 눌리지 않고 안내가 보이며 창을 닫으면 쓰던 글이 그대로다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  await seedIssue(room, '범위 안 요청')
  const outside = await seedIssue(room, '범위 밖 요청')
  await db.issue.update({ where: { id: outside.id }, data: { scope: 'OUT_OF_SCOPE' } })
  await loginAs(room.approver.id)
  await openRoom(page, room)
  await fillIssue(page)
  await openApproval(page)
  await expect(dialog(page).getByText('쓰던 쪽지를 보내거나 취소하면 열 수 있어요', { exact: true })).toBeVisible()
  await expect(dialog(page).getByRole('button', { name: /쪽지 #/ })).toHaveCount(0)
  await expect(dialog(page).getByText('#1', { exact: true })).toBeVisible()
  await expect(dialog(page).getByText('#2', { exact: true })).toBeVisible()
  await closeApproval(page)
  await expect(page.getByLabel('제목 (필수)', { exact: true })).toHaveValue('남겨 둔 제목')
  await expect(page.getByLabel('내용', { exact: true })).toHaveValue('남겨 둔 내용')
})

test('새 쪽지를 보내는 중이거나 응답이 끊겨 잠긴 동안에도 승인 검토의 쪽지 번호가 눌리지 않고 다시 보내기가 그대로다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  await seedIssue(room)
  await loginAs(room.approver.id)
  await openRoom(page, room)
  await fillIssue(page)
  let release!: () => void
  let reached!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const sent = new Promise<void>((resolve) => { reached = resolve })
  const bodies: unknown[] = []
  await page.route(`**/api/projects/${room.project.id}/issues`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    bodies.push(route.request().postDataJSON())
    if (bodies.length > 1) return route.continue()
    const response = await route.fetch()
    expect(response.status()).toBe(201)
    reached()
    await gate
    await route.abort('failed')
  })
  try {
    await page.getByRole('button', { name: '쪽지 남기기', exact: true }).click()
    await sent
    await openApproval(page)
    await expect(dialog(page).getByRole('button', { name: /쪽지 #/ })).toHaveCount(0)
    await expect(dialog(page).getByText('쓰던 쪽지를 보내거나 취소하면 열 수 있어요', { exact: true })).toBeVisible()
    await closeApproval(page)
    release()
    await expect(page.getByRole('button', { name: '다시 보내기', exact: true })).toBeVisible()
    await openApproval(page)
    await expect(dialog(page).getByRole('button', { name: /쪽지 #/ })).toHaveCount(0)
    await expect(dialog(page).getByText('쓰던 쪽지를 보내거나 취소하면 열 수 있어요', { exact: true })).toBeVisible()
    await closeApproval(page)
    await expect(page.getByLabel('제목 (필수)', { exact: true })).toHaveValue('남겨 둔 제목')
    await expect(page.getByLabel('내용', { exact: true })).toHaveValue('남겨 둔 내용')
    await page.getByRole('button', { name: '다시 보내기', exact: true }).click()
    await expect(detail(page, 2)).toContainText('남겨 둔 제목')
    expect(bodies).toHaveLength(2)
    expect(bodies[1]).toEqual(bodies[0])
    expect(await db.issue.count({ where: { projectId: room.project.id } })).toBe(2)
  } finally {
    release()
  }
})

test('지난 승인된 버전을 보는 사이 새 버전이 게시되면 최신 버전 보기 한 번으로 새 버전에 간다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  await seedApproval(room)
  await publishVersion(room.project.id, [room.main.id, room.product.id], 1)
  await loginAs(room.approver.id)
  await openRoom(page, room, `?version=${room.version.id}`)
  const next = await publishVersion(room.project.id, [room.main.id, room.product.id], 2)
  const requests: string[] = []
  page.on('request', (request) => { if (new URL(request.url()).pathname === `/api/projects/${room.project.id}`) requests.push(request.url()) })
  await latestButton(page).click()
  await expect(picker(page)).toHaveValue(next.id)
  await expect(page.getByText('검수 중', { exact: true })).toBeVisible()
  await expect(banner(page)).toHaveCount(0)
  expect(requests).toHaveLength(1)
})

test('지난 버전의 최신 버전 보기를 연속으로 두 번 눌러도 새 버전에 간다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  await publishVersion(room.project.id, [room.main.id, room.product.id], 1)
  await loginAs(room.approver.id)
  await openRoom(page, room, `?version=${room.version.id}`)
  const next = await publishVersion(room.project.id, [room.main.id, room.product.id], 2)
  const held = await holdResponse(page, `projects/${room.project.id}`)
  const requests: string[] = []
  page.on('request', (request) => { if (new URL(request.url()).pathname === `/api/projects/${room.project.id}`) requests.push(request.url()) })
  try {
    await latestButton(page).click()
    await held.received
    await latestButton(page).click()
    await expect(picker(page)).toHaveValue(room.version.id)
    expect(new URL(page.url()).searchParams.get('version')).toBe(room.version.id)
    expect(requests).toHaveLength(1)
    held.release()
    await expect(picker(page)).toHaveValue(next.id)
    expect(new URL(page.url()).searchParams.has('version')).toBe(false)
    expect(requests).toHaveLength(1)
  } finally {
    held.release()
  }
})

test('지난 버전의 최신 버전 보기가 프로젝트를 다시 읽지 못하면 보던 버전과 화면이 그대로이고 다시 누르면 간다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  await publishVersion(room.project.id, [room.main.id, room.product.id], 1)
  await loginAs(room.approver.id)
  await openRoom(page, room, `?version=${room.version.id}&keep=yes`)
  await page.getByRole('button', { name: '상품 상세 · PC' }).click()
  const oldUrl = page.url()
  const oldPhoto = await photo(page, '상품 상세 · PC').getAttribute('src')
  const next = await publishVersion(room.project.id, [room.main.id, room.product.id], 2)
  await page.route(`**/api/projects/${room.project.id}`, async (route) => { await route.fulfill({ status: 500, json: {} }) }, { times: 1 })
  const failed = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/projects/${room.project.id}`)
  await latestButton(page).click()
  expect((await failed).status()).toBe(500)
  await expect(picker(page)).toHaveValue(room.version.id)
  expect(page.url()).toBe(oldUrl)
  await expect(photo(page, '상품 상세 · PC')).toHaveAttribute('src', oldPhoto!)
  await latestButton(page).click()
  await expect(picker(page)).toHaveValue(next.id)
  await expect(photo(page, '상품 상세 · PC')).toHaveAttribute('src', `/api/assets/${next.screens[1].assetId}`)
  expect(new URL(page.url()).searchParams.get('keep')).toBe('yes')
})

test('다른 화면을 고른 뒤 쪽지를 열어 그 쪽지의 화면을 보다가 최신 버전 보기를 누르면 새 버전에서도 보던 화면이 보인다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room, '상품 화면 요청')
  await db.issue.update({ where: { id: issue.id }, data: { originVersionScreenId: room.version.screens[1].id } })
  await publishVersion(room.project.id, [room.main.id, room.product.id], 1)
  await loginAs(room.approver.id)
  await openRoom(page, room, `?version=${room.version.id}`)
  await page.getByRole('button', { name: '메인 · PC' }).click()
  await page.getByRole('region', { name: '쪽지 목록', exact: true }).getByRole('button', { name: new RegExp(issue.title) }).click()
  await expect(photo(page, '상품 상세 · PC')).toBeVisible()
  const next = await publishVersion(room.project.id, [room.main.id, room.product.id], 2)
  await latestButton(page).click()
  await expect(picker(page)).toHaveValue(next.id)
  await expect(photo(page, '상품 상세 · PC')).toHaveAttribute('src', `/api/assets/${next.screens[1].assetId}`)
  await expect(detail(page)).toContainText(issue.title)
  expect(new URL(page.url()).searchParams.get('issue')).toBe(issue.id)
})

test('최신 버전 보기의 응답을 기다리는 사이 다른 화면을 고르면 새 버전에서 그 화면이 보인다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  await publishVersion(room.project.id, [room.main.id, room.product.id], 1)
  await loginAs(room.approver.id)
  await openRoom(page, room, `?version=${room.version.id}`)
  const next = await publishVersion(room.project.id, [room.main.id, room.product.id], 2)
  const held = await holdResponse(page, `projects/${room.project.id}`)
  try {
    await latestButton(page).click()
    await held.received
    await page.getByRole('button', { name: '상품 상세 · PC' }).click()
    await expect(photo(page, '상품 상세 · PC')).toHaveAttribute('src', `/api/assets/${room.version.screens[1].assetId}`)
    held.release()
    await expect(picker(page)).toHaveValue(next.id)
    await expect(photo(page, '상품 상세 · PC')).toHaveAttribute('src', `/api/assets/${next.screens[1].assetId}`)
  } finally {
    held.release()
  }
})

test('승인 검토에 먼저 나타난 다른 사람의 새 쪽지 번호를 누르면 검수실 목록이 새로 불러와져 그 쪽지의 상세가 열린다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  await loginAs(room.approver.id)
  await openRoom(page, room)
  const issue = await seedIssue(room, '다른 사람이 방금 쓴 쪽지')
  await expect(page.getByRole('region', { name: '쪽지 목록', exact: true })).not.toContainText(issue.title)
  await openApproval(page)
  await expect(dialog(page)).toContainText(issue.title)
  const held = await holdResponse(page, `projects/${room.project.id}/issues`)
  try {
    await dialog(page).getByRole('button', { name: '쪽지 #1 열기', exact: true }).click()
    await expect(dialog(page)).toHaveCount(0)
    await expect(page.getByText('쪽지를 불러오는 중이에요', { exact: true })).toBeVisible()
    await expect(page.getByText('없는 쪽지예요.', { exact: true })).toHaveCount(0)
    expect(new URL(page.url()).searchParams.get('issue')).toBe(issue.id)
    await held.received
    held.release()
    await expect(detail(page)).toContainText(issue.title)
    await expect(page.getByText('쪽지를 불러오는 중이에요', { exact: true })).toHaveCount(0)
  } finally {
    held.release()
  }
})

test('승인 검토에서 고른 새 쪽지 목록이 실패하면 없는 쪽지라 하지 않고 다음 15초에 상세를 연다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  await loginAs(room.approver.id)
  await openRoom(page, room)
  const issue = await seedIssue(room)
  await openApproval(page)
  await page.route(`**/api/projects/${room.project.id}/issues`, async (route) => { await route.fulfill({ status: 500, json: {} }) }, { times: 1 })
  await dialog(page).getByRole('button', { name: '쪽지 #1 열기', exact: true }).click()
  await expect(page.getByText('쪽지를 불러오지 못했어요', { exact: true })).toBeVisible()
  await expect(page.getByText('없는 쪽지예요.', { exact: true })).toHaveCount(0)
  await pollVersion(page, room.version.id)
  await expect(detail(page)).toContainText(issue.title)
})

test('승인 검토에서 고른 새 쪽지 목록을 기다리다 다른 쪽지를 열면 선택과 쓰던 댓글이 남는다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const old = await seedIssue(room, '원래 있던 쪽지')
  await loginAs(room.approver.id)
  await openRoom(page, room)
  await seedIssue(room, '나중에 생긴 쪽지')
  await openApproval(page)
  const held = await holdResponse(page, `projects/${room.project.id}/issues`)
  try {
    await dialog(page).getByRole('button', { name: '쪽지 #2 열기', exact: true }).click()
    await held.received
    await page.getByRole('region', { name: '쪽지 목록', exact: true }).getByRole('button', { name: new RegExp(old.title) }).click()
    await comment(page).fill('목록 응답이 와도 남길 댓글')
    held.release()
    await expect(page.getByRole('region', { name: '쪽지 목록', exact: true })).toContainText('나중에 생긴 쪽지')
    await expect(detail(page)).toContainText(old.title)
    await expect(comment(page)).toHaveValue('목록 응답이 와도 남길 댓글')
    expect(new URL(page.url()).searchParams.get('issue')).toBe(old.id)
  } finally {
    held.release()
  }
})

test('승인 검토에서 고른 새 쪽지가 다시 받은 목록에도 없을 때만 없는 쪽지라고 알린다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  await loginAs(room.approver.id)
  await openRoom(page, room)
  const issue = await seedIssue(room)
  await openApproval(page)
  await db.issue.delete({ where: { id: issue.id } })
  await dialog(page).getByRole('button', { name: '쪽지 #1 열기', exact: true }).click()
  await expect(page.getByText('없는 쪽지예요.', { exact: true })).toBeVisible()
  await expect(page.getByText('쪽지를 불러오지 못했어요', { exact: true })).toHaveCount(0)
  await expect(detail(page)).toHaveCount(0)
})

test('브라우저 뒤로 가기로 버전이 바뀌면 열어 둔 승인 검토가 닫힌다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const next = await publishVersion(room.project.id, [room.main.id, room.product.id], 1)
  await loginAs(room.approver.id)
  await openRoom(page, room, `?version=${room.version.id}`)
  await picker(page).selectOption(next.id)
  await openApproval(page)
  await page.goBack()
  await expect(picker(page)).toHaveValue(room.version.id)
  await expect(dialog(page)).toHaveCount(0)
  expect(await db.approval.count()).toBe(0)
})

test('승인 전에 시작한 버전 조회가 늦게 끝나도 승인 완료와 읽기 전용이 검수 중으로 돌아가지 않는다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  await loginAs(room.approver.id)
  await openRoom(page, room)
  const held = await holdResponse(page, `versions/${room.version.id}`)
  try {
    await page.clock.fastForward(15_000)
    await held.received
    await openApproval(page)
    await approveAndWait(page, room.version.id)
    await expect(dialog(page)).toHaveAccessibleName('초안 승인 완료')
    const response = page.waitForResponse((item) => new URL(item.url()).pathname === `/api/versions/${room.version.id}`)
    held.release()
    await response
    await expect(dialog(page)).toHaveAccessibleName('초안 승인 완료')
    await closeApproval(page)
    await expect(banner(page)).toBeVisible()
    await expect(page.getByText('승인됨', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: /^(쪽지 쓰기|버전 승인)$/ })).toHaveCount(0)
  } finally {
    held.release()
  }
})

test('15초 버전 조회가 실패해도 보던 사진과 쓰던 댓글은 그대로다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  await loginAs(room.approver.id)
  await openRoom(page, room, `?issue=${issue.id}`)
  await comment(page).fill('연결이 끊겨도 남길 글')
  const image = await photo(page).getAttribute('src')
  const address = page.url()
  await page.route(`**/api/versions/${room.version.id}`, async (route) => { await route.fulfill({ status: 500, json: {} }) }, { times: 1 })
  const response = page.waitForResponse((item) => new URL(item.url()).pathname === `/api/versions/${room.version.id}`)
  await page.clock.fastForward(15_000)
  expect((await response).status()).toBe(500)
  await expect(photo(page)).toHaveAttribute('src', image!)
  await expect(comment(page)).toHaveValue('연결이 끊겨도 남길 글')
  await expect(page.getByText('검수 중', { exact: true })).toBeVisible()
  expect(page.url()).toBe(address)
})
