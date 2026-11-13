import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import type { BrowserContext, Locator, Page } from '@playwright/test'
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
  const project = await createProject(developer.id, '쪽지 검수 프로젝트')
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

const UNCONFIRMED = '저장됐는지 확인하지 못했어요. 쪽지에 바뀐 내용이 보이지 않으면 다시 보내 주세요.'
const STATE_CHANGED = '쪽지 상태가 바뀌었어요. 새로 불러왔어요.'
const READ_ONLY = '읽기 전용이에요. 쪽지와 댓글은 바꿀 수 없어요.'
const detailFor = (page: Page, number = 1) => page.getByRole('article', { name: `쪽지 #${number}`, exact: true })
const historyFor = (page: Page, number = 1) => detailFor(page, number).getByRole('region', { name: '고쳤어요 이력', exact: true })
const formFor = (page: Page, number = 1) => detailFor(page, number).getByRole('form', { name: '고쳤어요 보내기', exact: true })
const reviewFor = (page: Page) => page.getByRole('region', { name: '확인하기', exact: true })
const issueList = (page: Page) => page.getByRole('region', { name: '쪽지 목록', exact: true })
const statusFor = (page: Page, number = 1) => detailFor(page, number).locator('[data-status]')

const openIssue = async (page: Page, room: Room, issue: { id: string; number: number }, versionId?: string) => {
  const versionQuery = versionId ? `&version=${versionId}` : ''
  await page.goto(`/app/projects/${room.project.id}?issue=${issue.id}${versionQuery}`)
  await expect(detailFor(page, issue.number).getByRole('heading', { level: 2 })).toBeVisible()
  await expect(page.getByRole('img', { name: '메인 · PC', exact: true })).toBeVisible()
}

const waitForAction = (page: Page, issueId: string, action: string) => page.waitForResponse((response) =>
  new URL(response.url()).pathname === `/api/issues/${issueId}/${action}` && response.request().method() === 'POST',
)

const clickAction = async (page: Page, issueId: string, action: string, button: Locator, status = 200) => {
  const pending = waitForAction(page, issueId, action)
  await button.click()
  const response = await pending
  expect(response.status()).toBe(status)
  return response
}

const submitResolution = async (page: Page, issueId: string, summary: string) => {
  await formFor(page).getByLabel('고친 내용', { exact: true }).fill(summary)
  return clickAction(page, issueId, 'submit-resolution', formFor(page).getByRole('button', { name: '고쳤어요 보내기', exact: true }))
}

const sendReason = async (page: Page, issueId: string, action: '재요청' | '철회' | '다시 열기', reason: string) => {
  const fields = {
    재요청: { label: '재요청 사유', button: '재요청 보내기', path: 'reopen' },
    철회: { label: '철회 사유', button: '철회하기', path: 'withdraw' },
    '다시 열기': { label: '다시 여는 사유', button: '다시 열기', path: 'reopen' },
  }
  const field = fields[action]
  await reviewFor(page).getByRole('button', { name: action, exact: true }).click()
  await reviewFor(page).getByLabel(field.label, { exact: true }).fill(reason)
  return clickAction(page, issueId, field.path, reviewFor(page).getByRole('button', { name: field.button, exact: true }))
}

const refreshIssue = async (page: Page, issueId: string) => {
  const pending = page.waitForResponse((response) =>
    new URL(response.url()).pathname === `/api/issues/${issueId}` && response.request().method() === 'GET',
  )
  await page.clock.fastForward(15_000)
  expect((await pending).status()).toBe(200)
}

const seedAttempt = async (
  room: Room,
  issueId: string,
  version = room.version,
  summary = '버튼 색을 고쳤어요',
  versionScreenId: string | null = version.screens[0].id,
) => {
  const attempt = await db.resolutionAttempt.create({
    data: { issueId, versionId: version.id, versionScreenId, summary, submittedById: room.developer.id },
  })
  await db.issue.update({ where: { id: issueId }, data: { status: 'READY_FOR_REVIEW' } })
  return attempt
}

// 실패 안내가 새로 불러오기 직후 사라지므로 응답만 잠깐 잡아 두고, 안내를 확인한 뒤 놓는다.
const holdDetailRefresh = async (page: Page, issueId: string) => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  await page.route(`**/api/issues/${issueId}`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    const response = await route.fetch()
    await gate
    await route.fulfill({ response })
  }, { times: 1 })
  return { release }
}

test.beforeEach(async ({ page }) => {
  await resetDatabase()
  await page.clock.install({ time: new Date('2026-11-13T00:00:00Z') })
  await page.clock.pauseAt(new Date('2026-11-13T00:00:01Z'))
})

test('개발자가 고쳤어요를 보내면 클라이언트에게 확인 요청으로 보이고 확인 완료하면 개발자에게 확인 완료로 보인다', async ({ page, browser, baseURL, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  await loginAs(room.developer.id)
  await openIssue(page, room, issue)
  const clientContext = await browser.newContext({ baseURL })
  try {
    await loginContext(clientContext, baseURL!, room.client.id)
    const clientPage = await clientContext.newPage()
    await clientPage.clock.install()
    await openIssue(clientPage, room, issue)
    await expect(statusFor(clientPage)).toHaveText('접수')
    await expect(formFor(page).getByLabel('고친 화면', { exact: true })).toHaveValue(room.main.id)
    await expect(formFor(page).getByRole('option')).toHaveText(['화면을 골라 주세요', '메인 · PC', '상품 상세 · PC'])
    // 설명이 비거나 공백뿐이면 서버로 보내지 않는다.
    const requests: string[] = []
    page.on('request', (request) => {
      if (request.url().endsWith('/submit-resolution')) requests.push(request.url())
    })
    await formFor(page).getByLabel('고친 화면', { exact: true }).selectOption('')
    await formFor(page).getByLabel('고친 내용', { exact: true }).fill('화면을 먼저 골라야 해요')
    await formFor(page).getByRole('button', { name: '고쳤어요 보내기', exact: true }).click()
    await expect(formFor(page).getByText('고친 화면을 골라 주세요', { exact: true })).toBeVisible()
    expect(requests).toHaveLength(0)
    await formFor(page).getByLabel('고친 화면', { exact: true }).selectOption(room.main.id)
    for (const summary of ['', '   ']) {
      await formFor(page).getByLabel('고친 내용', { exact: true }).fill(summary)
      await formFor(page).getByRole('button', { name: '고쳤어요 보내기', exact: true }).click()
      await expect(formFor(page).getByText('고친 내용은 1~2,000자로 써 주세요', { exact: true })).toBeVisible()
    }
    expect(requests).toHaveLength(0)
    await submitResolution(page, issue.id, '  버튼 색을 파란색으로 고쳤어요  ')
    await expect(statusFor(page)).toHaveText('확인 요청')
    await expect(formFor(page)).toHaveCount(0)
    await expect(historyFor(page).getByRole('listitem')).toContainText('버튼 색을 파란색으로 고쳤어요')
    await refreshIssue(clientPage, issue.id)
    await expect(statusFor(clientPage)).toHaveText('확인 요청')
    await expect(historyFor(clientPage).getByRole('listitem')).toContainText('결과: 결과 없음')
    await clickAction(clientPage, issue.id, 'verify', reviewFor(clientPage).getByRole('button', { name: '확인 완료', exact: true }))
    await expect(statusFor(clientPage)).toHaveText('확인 완료')
    await expect(reviewFor(clientPage).getByRole('button')).toHaveText(['다시 열기'])
    await refreshIssue(page, issue.id)
    await expect(statusFor(page)).toHaveText('확인 완료')
    await expect(historyFor(page).getByRole('listitem')).toContainText('결과: 확인 완료 · 클라이언트 ·')
    await expect(detailFor(page).getByRole('textbox', { name: '댓글', exact: true })).toBeVisible()
    expect(await db.resolutionAttempt.findMany({ where: { issueId: issue.id } })).toMatchObject([
      { summary: '버튼 색을 파란색으로 고쳤어요', result: 'VERIFIED', reviewedById: room.client.id },
    ])
  } finally {
    await clientContext.close()
  }
})

test('재요청은 사유를 적어야 보내지고 취소하면 쪽지가 그대로다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  const attempt = await seedAttempt(room, issue.id)
  await loginAs(room.client.id)
  await openIssue(page, room, issue)
  const requests: string[] = []
  page.on('request', (request) => {
    if (request.url().endsWith('/reopen')) requests.push(request.url())
  })
  await reviewFor(page).getByRole('button', { name: '재요청', exact: true }).click()
  for (const reason of ['', '   ']) {
    await reviewFor(page).getByLabel('재요청 사유', { exact: true }).fill(reason)
    await reviewFor(page).getByRole('button', { name: '재요청 보내기', exact: true }).click()
    await expect(reviewFor(page).getByText('사유는 1~2,000자로 써 주세요', { exact: true })).toBeVisible()
  }
  await reviewFor(page).getByLabel('재요청 사유', { exact: true }).fill('취소할 사유')
  await reviewFor(page).getByRole('button', { name: '취소', exact: true }).click()
  await expect(reviewFor(page).getByLabel('재요청 사유', { exact: true })).toHaveCount(0)
  await expect(statusFor(page)).toHaveText('확인 요청')
  expect(requests).toHaveLength(0)
  expect(await db.resolutionAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).toEqual(attempt)
  expect(await db.comment.count({ where: { issueId: issue.id } })).toBe(0)
  expect(await db.activityEvent.count({ where: { projectId: room.project.id } })).toBe(0)
  await reviewFor(page).getByRole('button', { name: '재요청', exact: true }).click()
  await expect(reviewFor(page).getByLabel('재요청 사유', { exact: true })).toHaveValue('')
  await reviewFor(page).getByLabel('재요청 사유', { exact: true }).fill('  색이 아직 달라요  ')
  await clickAction(page, issue.id, 'reopen', reviewFor(page).getByRole('button', { name: '재요청 보내기', exact: true }))
  await expect(statusFor(page)).toHaveText('접수')
  await expect(historyFor(page).getByRole('listitem')).toContainText('결과: 재요청 · 클라이언트 ·')
  const comment = detailFor(page).getByRole('region', { name: '댓글', exact: true }).getByRole('listitem')
  await expect(comment).toContainText('클라이언트')
  await expect(comment).toContainText('재요청 사유: 색이 아직 달라요')
})

test('철회한 쪽지를 사유와 함께 다시 열면 접수로 돌아가고 사유 댓글이 차례로 남는다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  await loginAs(room.client.id)
  await openIssue(page, room, issue)
  const requests: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/(withdraw|reopen)$/.test(request.url())) requests.push(request.url())
  })
  await reviewFor(page).getByRole('button', { name: '철회', exact: true }).click()
  await reviewFor(page).getByRole('button', { name: '철회하기', exact: true }).click()
  await expect(reviewFor(page).getByText('사유는 1~2,000자로 써 주세요', { exact: true })).toBeVisible()
  await reviewFor(page).getByLabel('철회 사유', { exact: true }).fill('취소할 철회')
  await reviewFor(page).getByRole('button', { name: '취소', exact: true }).click()
  await expect(reviewFor(page).getByLabel('철회 사유', { exact: true })).toHaveCount(0)
  await expect(statusFor(page)).toHaveText('접수')
  expect(requests).toHaveLength(0)
  expect(await db.comment.count({ where: { issueId: issue.id } })).toBe(0)
  await sendReason(page, issue.id, '철회', '이 화면은 쓰지 않아요')
  await expect(statusFor(page)).toHaveText('철회')
  await expect(reviewFor(page).getByRole('button')).toHaveText(['다시 열기'])
  await expect(historyFor(page)).toHaveCount(0)
  await reviewFor(page).getByRole('button', { name: '다시 열기', exact: true }).click()
  await reviewFor(page).getByRole('button', { name: '다시 열기', exact: true }).click()
  await expect(reviewFor(page).getByText('사유는 1~2,000자로 써 주세요', { exact: true })).toBeVisible()
  await reviewFor(page).getByLabel('다시 여는 사유', { exact: true }).fill('취소할 다시 열기')
  await reviewFor(page).getByRole('button', { name: '취소', exact: true }).click()
  await expect(statusFor(page)).toHaveText('철회')
  expect(requests).toHaveLength(1)
  await sendReason(page, issue.id, '다시 열기', '다시 쓰기로 했어요')
  await expect(statusFor(page)).toHaveText('접수')
  const comments = detailFor(page).getByRole('region', { name: '댓글', exact: true }).getByRole('listitem')
  await expect(comments).toHaveCount(2)
  await expect(comments.nth(0)).toContainText('철회 사유: 이 화면은 쓰지 않아요')
  await expect(comments.nth(1)).toContainText('다시 연 사유: 다시 쓰기로 했어요')
  await expect(comments.nth(0)).toContainText('클라이언트')
  await expect(comments.nth(1)).toContainText('클라이언트')
  expect(await db.resolutionAttempt.count({ where: { issueId: issue.id } })).toBe(0)
  expect(await db.comment.findMany({ where: { issueId: issue.id }, orderBy: { createdAt: 'asc' } })).toMatchObject([
    { body: '철회 사유: 이 화면은 쓰지 않아요', authorId: room.client.id, versionId: room.version.id },
    { body: '다시 연 사유: 다시 쓰기로 했어요', authorId: room.client.id, versionId: room.version.id },
  ])
})

test('고쳤어요 보내기는 개발자에게만, 확인 버튼은 쓴 클라이언트와 승인자에게만 보인다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  const other = await createUser('other@example.com', '다른 클라이언트')
  await db.projectMember.create({ data: { projectId: room.project.id, userId: other.id, role: 'CLIENT' } })
  for (const user of [room.developer, room.client, room.approver, other]) {
    await loginAs(user.id)
    await openIssue(page, room, issue)
    await expect(statusFor(page)).toHaveText('접수')
    await expect(detailFor(page).getByRole('textbox', { name: '댓글', exact: true })).toBeVisible()
    await expect(formFor(page)).toHaveCount(user.id === room.developer.id ? 1 : 0)
    if (user.id === room.developer.id) await expect(formFor(page)).toBeVisible()
    await expect(reviewFor(page).getByRole('button', { name: '철회', exact: true })).toHaveCount(
      user.id === room.client.id || user.id === room.approver.id ? 1 : 0,
    )
    await expect(reviewFor(page).getByRole('button', { name: '확인 완료', exact: true })).toHaveCount(0)
  }
  await seedAttempt(room, issue.id)
  for (const user of [room.developer, room.client, room.approver, other]) {
    await loginAs(user.id)
    await openIssue(page, room, issue)
    await expect(statusFor(page)).toHaveText('확인 요청')
    await expect(historyFor(page).getByRole('listitem')).toHaveCount(1)
    await expect(formFor(page)).toHaveCount(0)
    const canReview = user.id === room.client.id || user.id === room.approver.id
    await expect(reviewFor(page)).toHaveCount(canReview ? 1 : 0)
    if (canReview) await expect(reviewFor(page)).toBeVisible()
    await expect(reviewFor(page).getByRole('button')).toHaveText(canReview ? ['재요청', '철회', '확인 완료'] : [])
  }
  // 개발자가 쓴 쪽지도 스스로 확인하지 못하고 승인자만 확인한다.
  const developerIssue = await seedIssue(room, '개발자가 남긴 요청', room.developer.id)
  await seedAttempt(room, developerIssue.id)
  for (const user of [room.developer, room.client, room.approver]) {
    await loginAs(user.id)
    await openIssue(page, room, developerIssue)
    await expect(historyFor(page, developerIssue.number).getByRole('listitem')).toHaveCount(1)
    await expect(reviewFor(page)).toHaveCount(user.id === room.approver.id ? 1 : 0)
  }
})

test('재요청 뒤 다시 보낸 고쳤어요와 새 버전 게시로 결과 없이 남은 줄이 이력에 오래된 순으로 모두 보인다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  await publishVersion(room.project.id, [room.main.id, room.product.id], 2)
  await loginAs(room.developer.id)
  await openIssue(page, room, issue)
  await submitResolution(page, issue.id, '첫 번째 수정')
  await loginAs(room.client.id)
  await openIssue(page, room, issue)
  await sendReason(page, issue.id, '재요청', '글씨도 고쳐 주세요')
  const first = await db.resolutionAttempt.findFirstOrThrow({ where: { issueId: issue.id } })
  await loginAs(room.developer.id)
  await openIssue(page, room, issue)
  await submitResolution(page, issue.id, '두 번째 수정')
  const second = await db.resolutionAttempt.findFirstOrThrow({ where: { issueId: issue.id }, orderBy: { createdAt: 'desc' } })
  const latest = await publishVersion(room.project.id, [room.main.id, room.product.id], 3)
  await refreshIssue(page, issue.id)
  await expect(statusFor(page)).toHaveText('수정 중')
  await openIssue(page, room, issue, latest.id)
  await expect(page.getByRole('combobox', { name: '버전', exact: true })).toHaveValue(latest.id)
  await submitResolution(page, issue.id, '세 번째 수정')
  await expect(historyFor(page).getByRole('heading', { name: '고쳤어요 3번', exact: true })).toBeVisible()
  const rows = historyFor(page).getByRole('listitem')
  await expect(rows).toHaveCount(3)
  await expect(rows.nth(0)).toContainText('첫 번째 수정')
  await expect(rows.nth(0)).toContainText('2차')
  await expect(rows.nth(0)).toContainText(/결과: 재요청 · 클라이언트 · \d{4}\./)
  await expect(rows.nth(0)).toContainText(/2차 · \d{4}\./)
  await expect(rows.nth(1)).toContainText('두 번째 수정')
  await expect(rows.nth(1)).toContainText('2차')
  await expect(rows.nth(1)).toContainText('결과: 결과 없음')
  await expect(rows.nth(2)).toContainText('세 번째 수정')
  await expect(rows.nth(2)).toContainText('3차')
  await expect(rows.nth(2)).toContainText('화면: 메인 · PC')
  await expect(rows.nth(2)).toContainText('개발자')
  await expect(rows.nth(2)).toContainText('결과: 결과 없음')
  await expect(rows.nth(0).getByRole('link')).toHaveCount(0)
  await expect(rows.nth(1).getByRole('link')).toHaveCount(0)
  await expect(rows.nth(2).getByRole('link', { name: '비교해서 보기', exact: true })).toHaveAttribute('href', `/app/issues/${issue.id}/compare`)
  expect(await db.resolutionAttempt.findUniqueOrThrow({ where: { id: first.id } })).toEqual(first)
  expect(await db.resolutionAttempt.findUniqueOrThrow({ where: { id: second.id } })).toEqual(second)
})

test('비교 화면에 처음 사진과 핀, 고친 사진이 나란히 보이고 거기서 확인 완료한다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  const latest = await publishVersion(room.project.id, [room.main.id, room.product.id], 2)
  const attempt = await seedAttempt(room, issue.id, latest, '상품 화면에서 고쳤어요', latest.screens[1].id)
  await loginAs(room.client.id)
  await openIssue(page, room, issue)
  await historyFor(page).getByRole('link', { name: '비교해서 보기', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/app/issues/${issue.id}/compare$`))
  await expect(page.getByRole('heading', { name: `#1 ${issue.title}`, exact: true })).toBeVisible()
  await expect(page.getByText('고친 내용', { exact: true })).toBeVisible()
  await expect(page.getByText('상품 화면에서 고쳤어요', { exact: false })).toBeVisible()
  const before = page.getByRole('img', { name: '처음 사진 메인 · PC', exact: true })
  const after = page.getByRole('img', { name: '고친 사진 상품 상세 · PC', exact: true })
  await expect(before).toBeVisible()
  await expect(after).toBeVisible()
  await expect(before).toHaveAttribute('src', `/api/assets/${room.version.screens[0].assetId}`)
  await expect(after).toHaveAttribute('src', `/api/assets/${latest.screens[1].assetId}`)
  // 실제 사진도 내려오는지 확인한다. alt만 있는 깨진 이미지로 통과하지 않는다.
  await expect.poll(async () => before.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1200)
  await expect.poll(async () => after.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1200)
  const pin = page.getByRole('button', { name: `쪽지 #1 ${issue.title}`, exact: true })
  await expect(pin).toBeVisible()
  const beforeBox = (await before.boundingBox())!
  const afterBox = (await after.boundingBox())!
  const pinBox = (await pin.boundingBox())!
  expect(beforeBox.x + beforeBox.width).toBeLessThanOrEqual(afterBox.x)
  expect(Math.abs(beforeBox.y - afterBox.y)).toBeLessThan(2)
  expect(Math.abs(pinBox.x + pinBox.width / 2 - beforeBox.x - beforeBox.width * 0.3)).toBeLessThan(2)
  expect(Math.abs(pinBox.y + pinBox.height / 2 - beforeBox.y - beforeBox.height * 0.4)).toBeLessThan(2)
  await page.setViewportSize({ width: 768, height: 900 })
  const narrowBefore = (await before.boundingBox())!
  const narrowAfter = (await after.boundingBox())!
  expect(narrowAfter.y).toBeGreaterThan(narrowBefore.y + narrowBefore.height)
  await expect(reviewFor(page).getByRole('button')).toHaveText(['재요청', '확인 완료'])
  await expect(page.getByRole('combobox', { name: '버전', exact: true })).toHaveCount(0)
  const response = await clickAction(page, issue.id, 'verify', reviewFor(page).getByRole('button', { name: '확인 완료', exact: true }))
  expect(response.request().postDataJSON()).toEqual({ versionId: latest.id, attemptId: attempt.id })
  await expect(page.locator('[data-status]')).toHaveText('확인 완료')
  await expect(reviewFor(page)).toHaveCount(0)
  await page.getByRole('link', { name: '검수실로 돌아가기', exact: true }).click()
  await expect(statusFor(page)).toHaveText('확인 완료')
  await expect(historyFor(page).getByRole('listitem')).toContainText('결과: 확인 완료 · 클라이언트 ·')
})

test('화면 없이 보낸 고쳤어요는 비교 링크가 없고 비교 주소로 가면 안내가 보인다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room, '위치 없는 기능 요청', room.client.id, false)
  await loginAs(room.developer.id)
  await openIssue(page, room, issue)
  await expect(formFor(page).getByLabel('고친 화면', { exact: true })).toHaveValue('')
  await expect(formFor(page).getByRole('option', { name: '화면 없음', exact: true })).toHaveCount(1)
  await submitResolution(page, issue.id, '기능을 고쳤어요')
  await expect(statusFor(page)).toHaveText('확인 요청')
  await expect(historyFor(page).getByRole('listitem')).toContainText('화면: 없음')
  await expect(historyFor(page).getByRole('link', { name: '비교해서 보기', exact: true })).toHaveCount(0)
  expect(await db.resolutionAttempt.findFirstOrThrow({ where: { issueId: issue.id } })).toMatchObject({ versionScreenId: null })
  await page.goto(`/app/issues/${issue.id}/compare`)
  await expect(page.getByText('비교할 사진이 없어요.', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: `#1 ${issue.title}`, exact: true })).toBeVisible()
  await expect(page.getByRole('img', { name: /^(처음|고친) 사진/ })).toHaveCount(0)
  await expect(reviewFor(page)).toHaveCount(0)
  await page.getByRole('link', { name: '검수실로 돌아가기', exact: true }).click()
  await expect(statusFor(page)).toHaveText('확인 요청')
  const emptyIssue = await seedIssue(room, '아직 고쳤어요가 없는 쪽지')
  await page.goto(`/app/issues/${emptyIssue.id}/compare`)
  await expect(page.getByText('비교할 사진이 없어요.', { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: '검수실로 돌아가기', exact: true })).toBeVisible()
  for (const missingId of [randomUUID(), 'not-a-uuid']) {
    await page.goto(`/app/issues/${missingId}/compare`)
    await expect(page.getByRole('heading', { name: '없는 쪽지예요', exact: true })).toBeVisible()
    await expect(page.getByRole('img', { name: /^(처음|고친) 사진/ })).toHaveCount(0)
  }
  const outsider = await createUser('outsider@example.com', '외부인')
  await loginAs(outsider.id)
  await page.goto(`/app/issues/${issue.id}/compare`)
  await expect(page.getByRole('heading', { name: '없는 쪽지예요', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: `#1 ${issue.title}`, exact: true })).toHaveCount(0)
})

test('비교 화면에서 사유를 적어 재요청하면 접수로 돌아가고 검수실의 쪽지에 사유 댓글이 보인다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  const attempt = await seedAttempt(room, issue.id)
  await loginAs(room.client.id)
  await page.goto(`/app/issues/${issue.id}/compare`)
  await expect(page.getByRole('img', { name: '고친 사진 메인 · PC', exact: true })).toBeVisible()
  await expect(reviewFor(page).getByRole('button')).toHaveText(['재요청', '확인 완료'])
  const response = await sendReason(page, issue.id, '재요청', '글씨 색을 다시 확인해 주세요')
  expect(response.request().postDataJSON()).toEqual({ versionId: room.version.id, attemptId: attempt.id, reason: '글씨 색을 다시 확인해 주세요' })
  await expect(page.locator('[data-status]')).toHaveText('접수')
  await expect(reviewFor(page)).toHaveCount(0)
  await page.getByRole('link', { name: '검수실로 돌아가기', exact: true }).click()
  await expect(statusFor(page)).toHaveText('접수')
  await expect(historyFor(page).getByRole('listitem')).toContainText('결과: 재요청 · 클라이언트 ·')
  const comments = detailFor(page).getByRole('region', { name: '댓글', exact: true }).getByRole('listitem')
  await expect(comments).toHaveCount(1)
  await expect(comments).toContainText('재요청 사유: 글씨 색을 다시 확인해 주세요')
  await expect(comments).toContainText('클라이언트')
})

test('확인 완료를 누르는 사이 재요청되고 새 고쳤어요가 오면 안내가 보이고 새 내용을 보고 다시 확인한다', async ({ page, browser, baseURL, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  const first = await seedAttempt(room, issue.id)
  await loginAs(room.client.id)
  await openIssue(page, room, issue)
  const developerContext = await browser.newContext({ baseURL })
  try {
    await loginContext(developerContext, baseURL!, room.developer.id)
    await page.route(`**/api/issues/${issue.id}/verify`, async (route) => {
      expect(route.request().postDataJSON().attemptId).toBe(first.id)
      // 클릭한 요청만 잠깐 늦춘 사이에 다른 창에서 실제 재요청과 새 고쳤어요를 저장한다.
      const rejected = await page.request.post(`/api/issues/${issue.id}/reopen`, {
        headers: { Origin: baseURL! }, data: { versionId: room.version.id, attemptId: first.id, reason: '다시 고쳐 주세요' },
      })
      expect(rejected.status()).toBe(200)
      const submitted = await developerContext.request.post(`/api/issues/${issue.id}/submit-resolution`, {
        headers: { Origin: baseURL! }, data: { versionId: room.version.id, screenId: room.product.id, summary: '새로 고친 상품 화면' },
      })
      expect(submitted.status()).toBe(200)
      await route.continue()
    }, { times: 1 })
    const stale = await clickAction(page, issue.id, 'verify', reviewFor(page).getByRole('button', { name: '확인 완료', exact: true }), 409)
    expect(await stale.json()).toMatchObject({ code: 'ATTEMPT_CHANGED' })
    await expect(detailFor(page).getByText(STATE_CHANGED, { exact: true })).toBeVisible()
    await expect(historyFor(page).getByRole('listitem')).toHaveCount(2)
    await expect(historyFor(page).getByRole('listitem').nth(1)).toContainText('새로 고친 상품 화면')
    await expect(historyFor(page).getByRole('listitem').nth(1)).toContainText('결과: 결과 없음')
    const reviewed = await clickAction(page, issue.id, 'verify', reviewFor(page).getByRole('button', { name: '확인 완료', exact: true }))
    expect(reviewed.request().postDataJSON().attemptId).not.toBe(first.id)
    await expect(statusFor(page)).toHaveText('확인 완료')
    await expect(detailFor(page).getByText(STATE_CHANGED, { exact: true })).toHaveCount(0)
    expect(await db.resolutionAttempt.findMany({ where: { issueId: issue.id }, orderBy: { createdAt: 'asc' } })).toMatchObject([
      { id: first.id, result: 'REOPENED' }, { summary: '새로 고친 상품 화면', result: 'VERIFIED' },
    ])
  } finally {
    await developerContext.close()
  }
})

test('고쳤어요를 쓰는 사이 새 버전이 올라오면 안내가 보이고 쓰던 설명이 남아 최신 버전에서 보낸다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  await loginAs(room.developer.id)
  await openIssue(page, room, issue)
  await formFor(page).getByLabel('고친 내용', { exact: true }).fill('새 버전에서도 남을 설명')
  await formFor(page).getByLabel('고친 화면', { exact: true }).selectOption(room.product.id)
  const latest = await publishVersion(room.project.id, [room.main.id, room.product.id], 1)
  const response = await clickAction(page, issue.id, 'submit-resolution', formFor(page).getByRole('button', { name: '고쳤어요 보내기', exact: true }), 409)
  expect(await response.json()).toMatchObject({ code: 'VERSION_CHANGED' })
  await expect(detailFor(page).getByText('새 버전이 올라왔어요. 쓰던 글은 그대로 남아 있어요.', { exact: false })).toBeVisible()
  expect(await db.resolutionAttempt.count({ where: { issueId: issue.id } })).toBe(0)
  await page.getByRole('button', { name: '최신 버전 보기', exact: true }).click()
  await expect(page.getByRole('combobox', { name: '버전', exact: true })).toHaveValue(latest.id)
  await expect(formFor(page).getByLabel('고친 내용', { exact: true })).toHaveValue('새 버전에서도 남을 설명')
  await expect(formFor(page).getByLabel('고친 화면', { exact: true })).toHaveValue(room.product.id)
  await clickAction(page, issue.id, 'submit-resolution', formFor(page).getByRole('button', { name: '고쳤어요 보내기', exact: true }))
  await expect(statusFor(page)).toHaveText('확인 요청')
  expect(await db.resolutionAttempt.findMany({ where: { issueId: issue.id } })).toMatchObject([
    { summary: '새 버전에서도 남을 설명', versionId: latest.id, versionScreenId: latest.screens[1].id },
  ])
})

test('고쳤어요 설명을 쓰던 중 15초가 지나고 보내기가 연결 실패로 끝나도 쓰던 글이 남아 다시 보낸다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  await loginAs(room.developer.id)
  await openIssue(page, room, issue)
  await formFor(page).getByLabel('고친 내용', { exact: true }).fill('연결이 끊겨도 남을 설명')
  await refreshIssue(page, issue.id)
  await expect(formFor(page).getByLabel('고친 내용', { exact: true })).toHaveValue('연결이 끊겨도 남을 설명')
  await page.route(`**/api/issues/${issue.id}/submit-resolution`, async (route) => { await route.abort('failed') }, { times: 1 })
  const refresh = await holdDetailRefresh(page, issue.id)
  try {
    await formFor(page).getByRole('button', { name: '고쳤어요 보내기', exact: true }).click()
    await expect(detailFor(page).getByText(UNCONFIRMED, { exact: true })).toBeVisible()
    await expect(formFor(page).getByLabel('고친 내용', { exact: true })).toHaveValue('연결이 끊겨도 남을 설명')
    expect(await db.resolutionAttempt.count({ where: { issueId: issue.id } })).toBe(0)
    refresh.release()
    await expect(detailFor(page).getByText(UNCONFIRMED, { exact: true })).toHaveCount(0)
    await expect(statusFor(page)).toHaveText('접수')
    await expect(formFor(page).getByLabel('고친 내용', { exact: true })).toHaveValue('연결이 끊겨도 남을 설명')
    await clickAction(page, issue.id, 'submit-resolution', formFor(page).getByRole('button', { name: '고쳤어요 보내기', exact: true }))
    await expect(statusFor(page)).toHaveText('확인 요청')
    await expect(historyFor(page).getByRole('listitem')).toHaveCount(1)
    await expect(historyFor(page).getByRole('listitem')).toContainText('연결이 끊겨도 남을 설명')
  } finally {
    refresh.release()
  }
})

test('재요청 사유를 쓰던 중 15초가 지나고 보내기가 연결 실패로 끝나도 쓰던 사유가 남아 다시 보낸다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  const attempt = await seedAttempt(room, issue.id)
  await loginAs(room.client.id)
  await openIssue(page, room, issue)
  await reviewFor(page).getByRole('button', { name: '재요청', exact: true }).click()
  await reviewFor(page).getByLabel('재요청 사유', { exact: true }).fill('아직 글씨가 작아요')
  await refreshIssue(page, issue.id)
  await expect(reviewFor(page).getByLabel('재요청 사유', { exact: true })).toHaveValue('아직 글씨가 작아요')
  await page.route(`**/api/issues/${issue.id}/reopen`, async (route) => { await route.abort('failed') }, { times: 1 })
  const refresh = await holdDetailRefresh(page, issue.id)
  try {
    await reviewFor(page).getByRole('button', { name: '재요청 보내기', exact: true }).click()
    await expect(detailFor(page).getByText(UNCONFIRMED, { exact: true })).toBeVisible()
    await expect(reviewFor(page).getByLabel('재요청 사유', { exact: true })).toHaveValue('아직 글씨가 작아요')
    expect(await db.resolutionAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).toEqual(attempt)
    expect(await db.comment.count({ where: { issueId: issue.id } })).toBe(0)
    refresh.release()
    await expect(detailFor(page).getByText(UNCONFIRMED, { exact: true })).toHaveCount(0)
    await expect(statusFor(page)).toHaveText('확인 요청')
    await expect(reviewFor(page).getByLabel('재요청 사유', { exact: true })).toHaveValue('아직 글씨가 작아요')
    await clickAction(page, issue.id, 'reopen', reviewFor(page).getByRole('button', { name: '재요청 보내기', exact: true }))
    await expect(statusFor(page)).toHaveText('접수')
    await expect(detailFor(page).getByText('재요청 사유: 아직 글씨가 작아요', { exact: true })).toBeVisible()
    expect(await db.comment.count({ where: { issueId: issue.id } })).toBe(1)
  } finally {
    refresh.release()
  }
})

test('철회 사유를 쓰는 사이 새 버전이 올라오면 안내가 보이고 최신 버전으로 가도 쓰던 사유가 남아 철회한다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  await loginAs(room.client.id)
  await openIssue(page, room, issue)
  await reviewFor(page).getByRole('button', { name: '철회', exact: true }).click()
  await reviewFor(page).getByLabel('철회 사유', { exact: true }).fill('다음 작업으로 미뤄요')
  const latest = await publishVersion(room.project.id, [room.main.id, room.product.id], 1)
  await clickAction(page, issue.id, 'withdraw', reviewFor(page).getByRole('button', { name: '철회하기', exact: true }), 409)
  await expect(detailFor(page).getByText('새 버전이 올라왔어요. 쓰던 글은 그대로 남아 있어요.', { exact: false })).toBeVisible()
  expect(await db.comment.count({ where: { issueId: issue.id } })).toBe(0)
  await page.getByRole('button', { name: '최신 버전 보기', exact: true }).click()
  await expect(page.getByRole('combobox', { name: '버전', exact: true })).toHaveValue(latest.id)
  await expect(reviewFor(page).getByLabel('철회 사유', { exact: true })).toHaveValue('다음 작업으로 미뤄요')
  await clickAction(page, issue.id, 'withdraw', reviewFor(page).getByRole('button', { name: '철회하기', exact: true }))
  await expect(statusFor(page)).toHaveText('철회')
  await expect(detailFor(page).getByText('철회 사유: 다음 작업으로 미뤄요', { exact: true })).toBeVisible()
  expect(await db.comment.findMany({ where: { issueId: issue.id } })).toMatchObject([
    { body: '철회 사유: 다음 작업으로 미뤄요', versionId: latest.id, authorId: room.client.id },
  ])
})

test('고쳤어요가 저장된 뒤 응답이 끊기면 안내가 보이고 새로 불러오면 확인 요청과 이력 한 줄이 보인다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  await loginAs(room.developer.id)
  await openIssue(page, room, issue)
  await formFor(page).getByLabel('고친 내용', { exact: true }).fill('저장은 된 설명')
  await page.route(`**/api/issues/${issue.id}/submit-resolution`, async (route) => {
    expect((await route.fetch()).status()).toBe(200)
    await route.abort('failed')
  }, { times: 1 })
  const refresh = await holdDetailRefresh(page, issue.id)
  try {
    await formFor(page).getByRole('button', { name: '고쳤어요 보내기', exact: true }).click()
    await expect(detailFor(page).getByText(UNCONFIRMED, { exact: true })).toBeVisible()
    await expect(formFor(page).getByLabel('고친 내용', { exact: true })).toHaveValue('저장은 된 설명')
    expect(await db.resolutionAttempt.count({ where: { issueId: issue.id } })).toBe(1)
    // 아직 새 상태를 못 받은 동안 다시 눌러도 두 번째 줄이 생기지 않는다.
    await clickAction(page, issue.id, 'submit-resolution', formFor(page).getByRole('button', { name: '고쳤어요 보내기', exact: true }), 409)
    refresh.release()
    await expect(statusFor(page)).toHaveText('확인 요청')
    await expect(formFor(page)).toHaveCount(0)
    await expect(historyFor(page).getByRole('listitem')).toHaveCount(1)
    await expect(historyFor(page).getByRole('listitem')).toContainText('저장은 된 설명')
    await expect(historyFor(page).getByRole('listitem')).toContainText('결과: 결과 없음')
    await expect(detailFor(page).getByText(UNCONFIRMED, { exact: true })).toHaveCount(0)
    expect(await db.resolutionAttempt.count({ where: { issueId: issue.id } })).toBe(1)
    expect(await db.activityEvent.count({ where: { projectId: room.project.id, type: 'RESOLUTION_SUBMITTED' } })).toBe(1)
  } finally {
    refresh.release()
  }
})

test('새 버전을 게시하면 확인 요청 쪽지가 수정 중으로 보이고 지난 버전에서는 이력만 보인다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  const attempt = await seedAttempt(room, issue.id)
  await loginAs(room.developer.id)
  await openIssue(page, room, issue)
  await expect(statusFor(page)).toHaveText('확인 요청')
  const draft = await db.deliveryVersion.create({ data: { projectId: room.project.id } })
  await db.versionScreen.create({ data: {
    versionId: draft.id, screenId: room.main.id, assetId: room.version.screens[0].assetId,
  } })
  // 이 줄은 준비용 도우미가 아니라 실제 서버의 게시 처리를 지난다.
  const published = await page.request.post(`/api/versions/${draft.id}/publish`, {
    headers: { Origin: new URL(page.url()).origin },
  })
  expect(published.status()).toBe(200)
  await refreshIssue(page, issue.id)
  await expect(statusFor(page)).toHaveText('수정 중')
  await expect(historyFor(page).getByRole('listitem')).toContainText('결과: 결과 없음')
  // 정기 갱신은 쪽지만 읽는다. 지난 버전을 명시해 다시 열면 읽기 전용이다.
  await openIssue(page, room, issue, room.version.id)
  await expect(detailFor(page).getByText(READ_ONLY, { exact: true })).toBeVisible()
  await expect(formFor(page)).toHaveCount(0)
  await expect(reviewFor(page)).toHaveCount(0)
  expect(await db.resolutionAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).toEqual(attempt)
  expect(await db.activityEvent.findMany({ where: { projectId: room.project.id } })).toMatchObject([
    { type: 'VERSION_PUBLISHED', versionId: draft.id },
  ])
  await page.getByRole('combobox', { name: '버전', exact: true }).selectOption(draft.id)
  await expect(page.getByRole('combobox', { name: '버전', exact: true })).toHaveValue(draft.id)
  await expect(formFor(page)).toBeVisible()
  await page.getByRole('combobox', { name: '버전', exact: true }).selectOption(room.version.id)
  await expect(detailFor(page).getByText(READ_ONLY, { exact: true })).toBeVisible()
  await expect(formFor(page)).toHaveCount(0)
  await expect(historyFor(page).getByRole('listitem')).toHaveCount(1)
  // 클라이언트도 지난 버전에서는 수정 중 쪽지를 철회할 수 없다.
  await loginAs(room.client.id)
  await openIssue(page, room, issue, room.version.id)
  await expect(detailFor(page).getByText(READ_ONLY, { exact: true })).toBeVisible()
  await expect(reviewFor(page)).toHaveCount(0)
  await expect(historyFor(page).getByRole('listitem')).toContainText('결과: 결과 없음')
})

test('승인된 버전에서는 개발자에게 고쳤어요 보내기가 없고 클라이언트에게 확인 버튼이 없으며 이력은 보인다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  const attempt = await seedAttempt(room, issue.id)
  const open = await seedIssue(room, '아직 수정할 요청')
  await db.$transaction([
    db.deliveryVersion.update({ where: { id: room.version.id }, data: { status: 'APPROVED' } }),
    db.approval.create({ data: { versionId: room.version.id, approverId: room.approver.id, summary: { issues: [] } } }),
  ])
  await loginAs(room.developer.id)
  await openIssue(page, room, open)
  await expect(statusFor(page, open.number)).toHaveText('접수')
  await expect(detailFor(page, open.number).getByText(READ_ONLY, { exact: true })).toBeVisible()
  await expect(formFor(page, open.number)).toHaveCount(0)
  for (const user of [room.developer, room.client, room.approver]) {
    await loginAs(user.id)
    await openIssue(page, room, issue)
    await expect(statusFor(page)).toHaveText('확인 요청')
    await expect(detailFor(page).getByText(READ_ONLY, { exact: true })).toBeVisible()
    await expect(historyFor(page).getByRole('listitem')).toContainText(attempt.summary)
    await expect(historyFor(page).getByRole('listitem')).toContainText('결과: 결과 없음')
    await expect(formFor(page)).toHaveCount(0)
    await expect(reviewFor(page)).toHaveCount(0)
    await expect(detailFor(page).getByRole('textbox', { name: '댓글', exact: true })).toHaveCount(0)
  }
  expect(await db.resolutionAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).toEqual(attempt)
})

test('확인 완료와 철회는 미해결에서 빠지고 상태 필터로 골라 볼 수 있다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const open = await seedIssue(room, '접수된 쪽지')
  const progress = await seedIssue(room, '수정하는 쪽지')
  const ready = await seedIssue(room, '확인할 쪽지')
  const withdrawn = await seedIssue(room, '철회할 쪽지')
  await db.issue.update({ where: { id: progress.id }, data: { status: 'IN_PROGRESS' } })
  await seedAttempt(room, ready.id)
  await db.issue.updateMany({ where: { projectId: room.project.id }, data: { dueDate: new Date('2026-11-01T00:00:00Z') } })
  await loginAs(room.client.id)
  await openIssue(page, room, ready)
  const list = issueList(page)
  await expect(list.getByText('미해결 4개', { exact: true })).toBeVisible()
  await expect(list.getByRole('listitem').filter({ hasText: '마감 지남' })).toHaveCount(4)
  await clickAction(page, ready.id, 'verify', reviewFor(page).getByRole('button', { name: '확인 완료', exact: true }))
  await expect(statusFor(page, ready.number)).toHaveText('확인 완료')
  await expect(list.getByText('미해결 3개', { exact: true })).toBeVisible()
  await list.getByRole('button', { name: new RegExp(withdrawn.title) }).click()
  await sendReason(page, withdrawn.id, '철회', '요청이 필요 없어졌어요')
  await expect(statusFor(page, withdrawn.number)).toHaveText('철회')
  await expect(list.getByText('미해결 2개', { exact: true })).toBeVisible()
  await expect(list.getByRole('listitem').filter({ hasText: '마감 지남' })).toHaveCount(2)
  // 확인 요청은 완료가 아니라 미해결에 포함되어야 한다.
  const waiting = await seedIssue(room, '새 확인 요청')
  await seedAttempt(room, waiting.id)
  await refreshIssue(page, withdrawn.id)
  await expect(list.getByText('미해결 3개', { exact: true })).toBeVisible()
  const filter = list.getByRole('combobox', { name: '상태', exact: true })
  await expect(filter.getByRole('option')).toHaveText(['전체', '접수', '수정 중', '확인 요청', '확인 완료', '철회'])
  for (const [state, title] of [
    ['OPEN', open.title], ['IN_PROGRESS', progress.title], ['READY_FOR_REVIEW', waiting.title],
    ['VERIFIED', ready.title], ['WITHDRAWN', withdrawn.title],
  ]) {
    await filter.selectOption(state)
    await expect(list.getByRole('heading', { name: '쪽지 1개 / 전체 5개', exact: true })).toBeVisible()
    await expect(list.getByRole('listitem')).toHaveCount(1)
    await expect(list.getByRole('listitem')).toContainText(title)
    await expect(list.getByRole('listitem').filter({ hasText: '마감 지남' })).toHaveCount(
      state === 'OPEN' || state === 'IN_PROGRESS' ? 1 : 0,
    )
  }
  await list.getByRole('button', { name: '필터 지우기', exact: true }).click()
  await expect(list.getByRole('heading', { name: '쪽지 5개', exact: true })).toBeVisible()
  await expect(list.getByRole('listitem')).toHaveCount(5)
})

test('고쳤어요, 재요청, 확인 완료, 철회가 활동 일지에 차례로 보인다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  await loginAs(room.developer.id)
  await openIssue(page, room, issue)
  await submitResolution(page, issue.id, '첫 수정')
  await loginAs(room.client.id)
  await openIssue(page, room, issue)
  await sendReason(page, issue.id, '재요청', '한 번 더 고쳐 주세요')
  await loginAs(room.developer.id)
  await openIssue(page, room, issue)
  await submitResolution(page, issue.id, '두 번째 수정')
  await loginAs(room.client.id)
  await openIssue(page, room, issue)
  await clickAction(page, issue.id, 'verify', reviewFor(page).getByRole('button', { name: '확인 완료', exact: true }))
  const verified = await db.resolutionAttempt.findMany({ where: { issueId: issue.id }, orderBy: { createdAt: 'asc' } })
  await sendReason(page, issue.id, '다시 열기', '요청을 더 확인할게요')
  await expect(statusFor(page)).toHaveText('접수')
  expect(await db.resolutionAttempt.findMany({ where: { issueId: issue.id }, orderBy: { createdAt: 'asc' } })).toEqual(verified)
  await sendReason(page, issue.id, '철회', '이 요청은 제외할게요')
  await expect(statusFor(page)).toHaveText('철회')
  await page.goto(`/app/projects/${room.project.id}/activity`)
  await expect(page.getByRole('heading', { name: `${room.project.name} 활동 일지`, exact: true })).toBeVisible()
  const rows = page.getByRole('listitem')
  await expect(rows).toHaveCount(6)
  const sentences = [
    '클라이언트님이 #1 쪽지를 철회했어요',
    '클라이언트님이 #1 쪽지를 다시 열었어요',
    '클라이언트님이 #1 쪽지를 확인 완료했어요',
    '개발자님이 #1 쪽지에 고쳤어요를 보냈어요',
    '클라이언트님이 #1 쪽지를 다시 열었어요',
    '개발자님이 #1 쪽지에 고쳤어요를 보냈어요',
  ]
  for (const [index, sentence] of sentences.entries()) {
    await expect(rows.nth(index)).toContainText(sentence)
    await expect(rows.nth(index).getByRole('link')).toHaveAttribute('href', `/app/projects/${room.project.id}?issue=${issue.id}`)
  }
  await rows.first().getByRole('link').click()
  await expect(statusFor(page)).toHaveText('철회')
  await expect(historyFor(page).getByRole('listitem')).toHaveCount(2)
})

// 5장 화면 규칙 중 표의 18개 제목에 따로 잡히지 않은 세 흐름도 확인한다.
test('승인자가 없는 개발자 쪽지는 안내가 보이고 누구에게도 확인 버튼이 없다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  await db.project.update({ where: { id: room.project.id }, data: { approverMemberId: null } })
  const issue = await seedIssue(room, '개발자가 쓴 쪽지', room.developer.id)
  await seedAttempt(room, issue.id)
  for (const user of [room.developer, room.client, room.approver]) {
    await loginAs(user.id)
    await openIssue(page, room, issue)
    await expect(statusFor(page)).toHaveText('확인 요청')
    await expect(historyFor(page).getByRole('listitem')).toHaveCount(1)
    await expect(detailFor(page).getByRole('textbox', { name: '댓글', exact: true })).toBeVisible()
    await expect(reviewFor(page)).toHaveCount(0)
    await expect(detailFor(page).getByText('승인자가 정해지면 확인할 수 있어요.', { exact: true })).toHaveCount(
      user.id === room.developer.id ? 1 : 0,
    )
  }
})

test('위치 없는 쪽지도 고친 화면을 고르면 비교 화면에 고친 사진과 위치 없음 안내가 보인다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room, '위치 없는 요청', room.client.id, false)
  await loginAs(room.developer.id)
  await openIssue(page, room, issue)
  await formFor(page).getByLabel('고친 화면', { exact: true }).selectOption(room.product.id)
  await submitResolution(page, issue.id, '상품 화면에 기능을 더했어요')
  await historyFor(page).getByRole('link', { name: '비교해서 보기', exact: true }).click()
  await expect(page.getByText('위치 없는 쪽지예요.', { exact: true })).toBeVisible()
  await expect(page.getByRole('img', { name: '고친 사진 상품 상세 · PC', exact: true })).toBeVisible()
  await expect(page.getByRole('img', { name: /^처음 사진/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^쪽지 #/ })).toHaveCount(0)
  await expect(reviewFor(page)).toHaveCount(0)
  await expect(page.getByRole('link', { name: '검수실로 돌아가기', exact: true })).toBeVisible()
})

test('비교 화면을 연 뒤 새 버전이 게시되면 확인 완료가 거절되고 검수실의 최신 버전으로 돌아간다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  const attempt = await seedAttempt(room, issue.id)
  await loginAs(room.client.id)
  await page.goto(`/app/issues/${issue.id}/compare`)
  await expect(reviewFor(page).getByRole('button', { name: '확인 완료', exact: true })).toBeVisible()
  const latest = await publishVersion(room.project.id, [room.main.id, room.product.id], 1)
  // 비교 화면은 정기 갱신하지 않아, 새 게시 뒤에도 누르기 전에는 보고 있던 사진과 상태를 유지한다.
  const detailRequests: string[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === `/api/issues/${issue.id}`) detailRequests.push(request.url())
  })
  await page.clock.fastForward(30_000)
  expect(detailRequests).toHaveLength(0)
  await expect(page.locator('[data-status]')).toHaveText('확인 요청')
  const response = await clickAction(page, issue.id, 'verify', reviewFor(page).getByRole('button', { name: '확인 완료', exact: true }), 409)
  expect(response.request().postDataJSON()).toEqual({ versionId: room.version.id, attemptId: attempt.id })
  expect(await response.json()).toMatchObject({ code: 'VERSION_CHANGED' })
  await expect(page.getByText('새 버전이 올라왔어요.', { exact: false })).toBeVisible()
  await expect(page.locator('[data-status]')).toHaveText('수정 중')
  await expect(reviewFor(page)).toHaveCount(0)
  expect(await db.resolutionAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).toEqual(attempt)
  await page.getByRole('link', { name: '검수실에서 최신 버전 보기', exact: true }).click()
  await expect(page.getByRole('combobox', { name: '버전', exact: true })).toHaveValue(latest.id)
  await expect(statusFor(page)).toHaveText('수정 중')
  await expect(historyFor(page).getByRole('listitem')).toContainText('결과: 결과 없음')
})

test('다른 동작의 사유 칸을 펴면 앞 동작에 쓰던 사유가 딸려 오지 않는다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  await loginAs(room.client.id)
  await openIssue(page, room, issue)
  await reviewFor(page).getByRole('button', { name: '철회', exact: true }).click()
  await reviewFor(page).getByLabel('철회 사유', { exact: true }).fill('이 화면은 쓰지 않아요')
  await page.route(`**/api/issues/${issue.id}/withdraw`, async (route) => {
    expect((await route.fetch()).status()).toBe(200)
    await route.abort('failed')
  }, { times: 1 })
  const refresh = await holdDetailRefresh(page, issue.id)
  try {
    await reviewFor(page).getByRole('button', { name: '철회하기', exact: true }).click()
    await expect(detailFor(page).getByText(UNCONFIRMED, { exact: true })).toBeVisible()
    expect((await db.issue.findUniqueOrThrow({ where: { id: issue.id } })).status).toBe('WITHDRAWN')
    refresh.release()
    await expect(statusFor(page)).toHaveText('철회')
    await expect(reviewFor(page).getByLabel('철회 사유', { exact: true })).toHaveCount(0)
    await reviewFor(page).getByRole('button', { name: '다시 열기', exact: true }).click()
    await expect(reviewFor(page).getByLabel('다시 여는 사유', { exact: true })).toHaveValue('')
    await reviewFor(page).getByLabel('다시 여는 사유', { exact: true }).fill('다시 쓰기로 했어요')
    await clickAction(page, issue.id, 'reopen', reviewFor(page).getByRole('button', { name: '다시 열기', exact: true }))
    await expect(statusFor(page)).toHaveText('접수')
    const comments = detailFor(page).getByRole('region', { name: '댓글', exact: true }).getByRole('listitem')
    await expect(comments).toHaveCount(2)
    await expect(comments.nth(0)).toContainText('철회 사유: 이 화면은 쓰지 않아요')
    await expect(comments.nth(1)).toContainText('다시 연 사유: 다시 쓰기로 했어요')
    expect(await db.comment.findMany({ where: { issueId: issue.id }, orderBy: { createdAt: 'asc' } })).toMatchObject([
      { body: '철회 사유: 이 화면은 쓰지 않아요', authorId: room.client.id },
      { body: '다시 연 사유: 다시 쓰기로 했어요', authorId: room.client.id },
    ])
  } finally {
    refresh.release()
  }
})

test('재요청 사유를 쓰는 사이 새 고쳤어요가 오면 사유 칸이 닫히고 다시 펴야 새 고쳤어요를 돌려보낸다', async ({ page, browser, baseURL, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  const first = await seedAttempt(room, issue.id)
  await loginAs(room.client.id)
  await openIssue(page, room, issue)
  await reviewFor(page).getByRole('button', { name: '재요청', exact: true }).click()
  await reviewFor(page).getByLabel('재요청 사유', { exact: true }).fill('아직 글씨가 작아요')
  const developerContext = await browser.newContext({ baseURL })
  try {
    await loginContext(developerContext, baseURL!, room.developer.id)
    const rejected = await page.request.post(`/api/issues/${issue.id}/reopen`, {
      headers: { Origin: baseURL! },
      data: { versionId: room.version.id, attemptId: first.id, reason: '다른 창에서 먼저 재요청했어요' },
    })
    expect(rejected.status()).toBe(200)
    const reviewedFirst = await db.resolutionAttempt.findUniqueOrThrow({ where: { id: first.id } })
    expect(reviewedFirst.result).toBe('REOPENED')
    const submitted = await developerContext.request.post(`/api/issues/${issue.id}/submit-resolution`, {
      headers: { Origin: baseURL! },
      data: { versionId: room.version.id, screenId: room.product.id, summary: '새로 고친 상품 화면' },
    })
    expect(submitted.status()).toBe(200)
    const newest = await db.resolutionAttempt.findFirstOrThrow({ where: { issueId: issue.id }, orderBy: { createdAt: 'desc' } })
    expect(newest.id).not.toBe(first.id)
    expect(newest.result).toBeNull()

    await refreshIssue(page, issue.id)

    await expect(reviewFor(page).getByLabel('재요청 사유', { exact: true })).toHaveCount(0)
    await expect(reviewFor(page).getByRole('button')).toHaveText(['재요청', '철회', '확인 완료'])
    const history = historyFor(page).getByRole('listitem')
    await expect(history).toHaveCount(2)
    await expect(history.nth(0)).toContainText('결과: 재요청')
    await expect(history.nth(1)).toContainText('새로 고친 상품 화면')
    await expect(history.nth(1)).toContainText('결과: 결과 없음')
    expect(await db.resolutionAttempt.findUniqueOrThrow({ where: { id: newest.id } })).toEqual(newest)
    await reviewFor(page).getByRole('button', { name: '재요청', exact: true }).click()
    await expect(reviewFor(page).getByLabel('재요청 사유', { exact: true })).toHaveValue('아직 글씨가 작아요')
    const response = await clickAction(page, issue.id, 'reopen', reviewFor(page).getByRole('button', { name: '재요청 보내기', exact: true }))
    expect(response.request().postDataJSON()).toEqual({
      versionId: room.version.id, attemptId: newest.id, reason: '아직 글씨가 작아요',
    })
    await expect(statusFor(page)).toHaveText('접수')
    await expect(history.nth(1)).toContainText('결과: 재요청')
    await expect(detailFor(page).getByText('재요청 사유: 아직 글씨가 작아요', { exact: true })).toBeVisible()
    expect(await db.resolutionAttempt.findUniqueOrThrow({ where: { id: first.id } })).toEqual(reviewedFirst)
    expect(await db.resolutionAttempt.findUniqueOrThrow({ where: { id: newest.id } })).toMatchObject({
      result: 'REOPENED', reviewedById: room.client.id,
    })
    expect(await db.resolutionAttempt.count({ where: { issueId: issue.id } })).toBe(2)
  } finally {
    await developerContext.close()
  }
})

test('비교 화면을 연 뒤 승인자가 바뀌면 확인 완료가 거절되고 버튼이 사라진다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  const attempt = await seedAttempt(room, issue.id)
  await loginAs(room.approver.id)
  await page.goto(`/app/issues/${issue.id}/compare`)
  await expect(reviewFor(page).getByRole('button', { name: '확인 완료', exact: true })).toBeVisible()
  const nextApprover = await db.projectMember.findFirstOrThrow({
    where: { projectId: room.project.id, userId: room.client.id },
  })
  await db.project.update({ where: { id: room.project.id }, data: { approverMemberId: nextApprover.id } })
  const refresh = page.waitForResponse((response) =>
    new URL(response.url()).pathname === `/api/issues/${issue.id}` && response.request().method() === 'GET',
  )

  await clickAction(page, issue.id, 'verify', reviewFor(page).getByRole('button', { name: '확인 완료', exact: true }), 403)

  const refreshed = await refresh
  expect(refreshed.status()).toBe(200)
  expect(await refreshed.json()).toMatchObject({ canReview: false, status: 'READY_FOR_REVIEW' })
  await expect(page.getByRole('button', { name: '확인 완료', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '재요청', exact: true })).toHaveCount(0)
  await expect(page.getByRole('alert')).toHaveText('잠시 뒤 다시 시도해 주세요')
  await expect(page.locator('[data-status]')).toHaveText('확인 요청')
  expect((await db.issue.findUniqueOrThrow({ where: { id: issue.id } })).status).toBe('READY_FOR_REVIEW')
  expect(await db.resolutionAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).toEqual(attempt)
  expect(await db.activityEvent.count({ where: { projectId: room.project.id, type: 'ISSUE_VERIFIED' } })).toBe(0)
})
