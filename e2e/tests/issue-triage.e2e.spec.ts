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

const UNCONFIRMED = '저장됐는지 확인하지 못했어요. 쪽지에 바뀐 값이 보이지 않으면 다시 눌러 주세요.'
const SCOPE_COMMENT = '범위: 하자 수정 → 추가 요청'

const detailFor = (page: Page, number = 1) => page.getByRole('article', { name: `쪽지 #${number}`, exact: true })
const issueList = (page: Page) => page.getByRole('region', { name: '쪽지 목록', exact: true })
const triageFor = (page: Page, number = 1) => detailFor(page, number).getByRole('region', { name: '쪽지 정리', exact: true })
const detailValue = (detail: Locator, label: string) => detail.locator('dt').filter({
  hasText: new RegExp(`^${label}$`),
}).locator('xpath=following-sibling::dd[1]')

const openIssue = async (page: Page, room: Room, issueId: string) => {
  await page.goto(`/app/projects/${room.project.id}?issue=${issueId}`)
  await expect(page.getByRole('img', { name: '메인 · PC', exact: true })).toBeVisible()
  await expect(detailFor(page).getByRole('heading', { level: 2 })).toBeVisible()
  await expect(triageFor(page).getByRole('combobox', { name: '분류', exact: true })).toBeVisible()
}

const waitForPatch = (page: Page, issueId: string) => page.waitForResponse((response) =>
  new URL(response.url()).pathname === `/api/issues/${issueId}` && response.request().method() === 'PATCH',
)

const chooseScope = async (page: Page, accept = true) => {
  const dialogOpened = page.waitForEvent('dialog')
  page.once('dialog', async (dialog) => {
    if (!accept) return dialog.dismiss()
    await dialog.accept()
  })
  await triageFor(page).getByRole('combobox', { name: '범위', exact: true }).selectOption('OUT_OF_SCOPE')
  const dialog = await dialogOpened
  expect(dialog.type()).toBe('confirm')
  expect(dialog.message()).toBe("범위를 '추가 요청'으로 바꿀까요? 바꾼 기록이 댓글로 남아요.")
}

const saveDate = async (page: Page, issueId: string, button = '마감일 저장', status = 200) => {
  const response = waitForPatch(page, issueId)
  await triageFor(page).getByRole('button', { name: button, exact: true }).click()
  expect((await response).status()).toBe(status)
}

const postComment = async (page: Page, issueId: string, body: string) => {
  await page.getByRole('textbox', { name: '댓글', exact: true }).fill(body)
  const response = page.waitForResponse((item) =>
    new URL(item.url()).pathname === `/api/issues/${issueId}/comments` && item.request().method() === 'POST',
  )
  await page.getByRole('button', { name: '댓글 남기기', exact: true }).click()
  expect((await response).status()).toBe(201)
  await expect(page.getByRole('region', { name: '댓글', exact: true }).getByText(body, { exact: true })).toBeVisible()
}

// 댓글 수뿐 아니라 글·쓴 사람·버전도 함께 확인한다. 자동 댓글의 요청 번호는 비어 있어야 한다.
const expectSaved = async (
  issueId: string,
  fields: { category: string; scope: string; dueDate: Date | null },
  comments: { body: string; authorId: string; versionId: string; requestId?: null }[] = [],
) => {
  expect(await db.issue.findUniqueOrThrow({ where: { id: issueId } })).toMatchObject(fields)
  const savedComments = await db.comment.findMany({ where: { issueId }, orderBy: { createdAt: 'asc' } })
  expect(savedComments).toHaveLength(comments.length)
  expect(savedComments).toMatchObject(comments)
}

const automaticComment = (room: Room, body: string, versionId = room.version.id) => ({
  body, authorId: room.developer.id, versionId, requestId: null,
})

// 두 테스트에서 같은 경합을 만든다. 서버는 저장했지만 브라우저에는 아직 응답을 주지 않는다.
const holdPatchResponse = async (page: Page, issueId: string) => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let received!: () => void
  const saved = new Promise<void>((resolve) => { received = resolve })
  await page.route(`**/api/issues/${issueId}`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue()
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    received()
    await gate
    await route.fulfill({ response })
  })
  return { saved, release }
}

test.beforeEach(async ({ page }) => {
  await resetDatabase()
  // 날짜 표시를 해가 바뀐 뒤에도 똑같이 검사하고, 15초 갱신은 테스트가 직접 진행한다.
  await page.clock.install({ time: new Date('2026-11-12T00:00:00Z') })
  await page.clock.pauseAt(new Date('2026-11-12T00:00:01Z'))
})

test('클라이언트에게는 범위와 마감일 입력이 없고 자기 쪽지의 분류만 바꿀 수 있다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const own = await seedIssue(room)
  const other = await seedIssue(room, '개발자가 쓴 쪽지', room.developer.id)
  const approverOwn = await seedIssue(room, '승인자가 쓴 쪽지', room.approver.id)
  for (const [user, issue] of [[room.client, own], [room.approver, approverOwn]] as const) {
    await loginAs(user.id)
    await page.goto(`/app/projects/${room.project.id}?issue=${issue.id}`)
    const detail = detailFor(page, issue.number)
    const triage = triageFor(page, issue.number)
    await expect(triage.getByRole('combobox', { name: '분류', exact: true })).toHaveValue('BUG')
    await expect(triage.getByRole('combobox', { name: '범위', exact: true })).toHaveCount(0)
    await expect(triage.getByLabel('마감일', { exact: true })).toHaveCount(0)
    await expect(triage.getByRole('button', { name: /마감일/ })).toHaveCount(0)
    const response = waitForPatch(page, issue.id)
    await triage.getByRole('combobox', { name: '분류', exact: true }).selectOption('COPY')
    expect((await response).status()).toBe(200)
    await expect(detailValue(detail, '분류')).toHaveText('문구')
    await expectSaved(issue.id, { category: 'COPY', scope: 'IN_SCOPE', dueDate: null })
    await issueList(page).getByRole('button', { name: new RegExp(other.title) }).click()
    await expect(detailFor(page, other.number).getByRole('heading', { name: other.title })).toBeVisible()
    await expect(triageFor(page, other.number)).toHaveCount(0)
    await expect(detailValue(detailFor(page, other.number), '분류')).toHaveText('버그')
  }
  await expectSaved(other.id, { category: 'BUG', scope: 'IN_SCOPE', dueDate: null })
})

test('분류를 골라 쪽지를 남기면 그 분류가 목록과 상세에 보인다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  await loginAs(room.client.id)
  await page.goto(`/app/projects/${room.project.id}`)
  await page.getByRole('button', { name: '쪽지 쓰기', exact: true }).click()
  const composer = page.locator('form').filter({ has: page.getByLabel('제목 (필수)', { exact: true }) })
  await expect(composer.getByRole('combobox', { name: '분류', exact: true })).toHaveValue('BUG')
  await composer.getByRole('combobox', { name: '분류', exact: true }).selectOption('DESIGN')
  await composer.getByLabel('제목 (필수)', { exact: true }).fill('여백을 넓혀 주세요')
  await composer.getByLabel('내용', { exact: true }).fill('제목과 본문 사이 여백')
  const response = page.waitForResponse((item) => item.request().method() === 'POST'
    && new URL(item.url()).pathname === `/api/projects/${room.project.id}/issues`)
  await composer.getByRole('button', { name: '쪽지 남기기', exact: true }).click()
  const received = await response
  expect(received.status()).toBe(201)
  const issue = await received.json()
  await expect(detailValue(detailFor(page), '분류')).toHaveText('디자인')
  await expect(detailValue(detailFor(page), '범위')).toHaveText('하자 수정')
  await expect(detailValue(detailFor(page), '마감일')).toHaveText('없음')
  await expect(issueList(page).getByRole('listitem')).toContainText('디자인')
  await expectSaved(issue.id, { category: 'DESIGN', scope: 'IN_SCOPE', dueDate: null })
})

test('개발자가 범위를 바꾸면 확인 창을 거쳐 자동 댓글이 보이고 클라이언트에게도 추가 요청으로 보인다', async ({ page, browser, baseURL, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  await loginAs(room.developer.id)
  await openIssue(page, room, issue.id)
  const clientContext = await browser.newContext({ baseURL })
  try {
    await loginContext(clientContext, baseURL!, room.client.id)
    const clientPage = await clientContext.newPage()
    await clientPage.clock.install()
    await openIssue(clientPage, room, issue.id)
    await expect(detailValue(detailFor(clientPage), '범위')).toHaveText('하자 수정')
    const response = waitForPatch(page, issue.id)
    await chooseScope(page)
    expect((await response).status()).toBe(200)
    await expect(detailValue(detailFor(page), '범위')).toHaveText('추가 요청')
    await expect(detailFor(page).getByText(SCOPE_COMMENT, { exact: true })).toBeVisible()
    await expect(detailFor(page).getByRole('region', { name: '댓글', exact: true }).getByRole('listitem')).toContainText('개발자')
    const refresh = clientPage.waitForResponse((item) => new URL(item.url()).pathname === `/api/issues/${issue.id}`)
    await clientPage.clock.fastForward(15_000)
    expect((await refresh).status()).toBe(200)
    await expect(detailValue(detailFor(clientPage), '범위')).toHaveText('추가 요청')
    await expect(detailFor(clientPage).getByText(SCOPE_COMMENT, { exact: true })).toBeVisible()
    await expect(issueList(clientPage).getByRole('listitem')).toContainText('추가 요청')
    await expectSaved(issue.id, { category: 'BUG', scope: 'OUT_OF_SCOPE', dueDate: null }, [automaticComment(room, SCOPE_COMMENT)])
  } finally {
    await clientContext.close()
  }
})

test('범위 확인 창에서 취소하면 범위와 댓글이 그대로다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  await loginAs(room.developer.id)
  await openIssue(page, room, issue.id)
  const patches: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'PATCH') patches.push(request.url())
  })
  await chooseScope(page, false)
  await expect(triageFor(page).getByRole('combobox', { name: '범위', exact: true })).toHaveValue('IN_SCOPE')
  await expect(detailValue(detailFor(page), '범위')).toHaveText('하자 수정')
  await expect(detailFor(page).getByRole('region', { name: '댓글', exact: true }).getByRole('listitem')).toHaveCount(0)
  expect(patches).toEqual([])
  await expectSaved(issue.id, { category: 'BUG', scope: 'IN_SCOPE', dueDate: null })
})

test('마감일은 저장을 눌러야 정해지고 바꾸고 지우면 자동 댓글이 차례로 쌓인다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  await loginAs(room.developer.id)
  await openIssue(page, room, issue.id)
  const triage = triageFor(page)
  const date = triage.getByLabel('마감일', { exact: true })
  const save = triage.getByRole('button', { name: '마감일 저장', exact: true })
  const patches: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'PATCH') patches.push(request.url())
  })
  await expect(save).toBeDisabled()
  await expect(triage.getByRole('button', { name: '마감일 지우기', exact: true })).toHaveCount(0)
  await date.fill('2026-11-20')
  await expect(save).toBeEnabled()
  await expect(detailValue(detailFor(page), '마감일')).toHaveText('없음')
  await expectSaved(issue.id, { category: 'BUG', scope: 'IN_SCOPE', dueDate: null })
  expect(patches).toHaveLength(0)
  await saveDate(page, issue.id)
  await expect(detailValue(detailFor(page), '마감일')).toHaveText('11월 20일')
  await expect(save).toBeDisabled()
  const first = automaticComment(room, '마감일: 없음 → 2026년 11월 20일')
  await expectSaved(issue.id, { category: 'BUG', scope: 'IN_SCOPE', dueDate: new Date('2026-11-20T00:00:00Z') }, [first])
  const original = await db.comment.findFirstOrThrow({ where: { issueId: issue.id } })
  await date.fill('2027-01-05')
  await expect(save).toBeEnabled()
  expect(patches).toHaveLength(1)
  await saveDate(page, issue.id)
  await expect(detailValue(detailFor(page), '마감일')).toHaveText('2027년 1월 5일')
  const second = automaticComment(room, '마감일: 2026년 11월 20일 → 2027년 1월 5일')
  await expectSaved(issue.id, { category: 'BUG', scope: 'IN_SCOPE', dueDate: new Date('2027-01-05T00:00:00Z') }, [first, second])
  await saveDate(page, issue.id, '마감일 지우기')
  await expect(detailValue(detailFor(page), '마감일')).toHaveText('없음')
  await expect(date).toHaveValue('')
  await expect(save).toBeDisabled()
  const third = automaticComment(room, '마감일: 2027년 1월 5일 → 없음')
  const comments = detailFor(page).getByRole('region', { name: '댓글', exact: true }).getByRole('listitem')
  await expect(comments).toHaveCount(3)
  for (const [index, comment] of [first, second, third].entries()) {
    await expect(comments.nth(index)).toContainText(comment.body)
    await expect(comments.nth(index)).toContainText('개발자')
  }
  await expectSaved(issue.id, { category: 'BUG', scope: 'IN_SCOPE', dueDate: null }, [first, second, third])
  expect(await db.comment.findUniqueOrThrow({ where: { id: original.id } })).toEqual(original)
})

test('마감일이 어제인 쪽지에는 마감 지남이 보이고 오늘인 쪽지에는 보이지 않는다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const yesterday = await seedIssue(room, '어제 마감한 요청')
  const today = await seedIssue(room, '오늘 마감하는 요청')
  const noDate = await seedIssue(room, '마감일 없는 요청')
  await db.issue.update({ where: { id: yesterday.id }, data: { scope: 'OUT_OF_SCOPE', dueDate: new Date('2026-11-20T00:00:00Z') } })
  await db.issue.update({ where: { id: today.id }, data: { status: 'IN_PROGRESS', dueDate: new Date('2026-11-21T00:00:00Z') } })
  await page.clock.setSystemTime(new Date('2026-11-21T12:00:00+09:00'))
  await loginAs(room.developer.id)
  await openIssue(page, room, yesterday.id)
  const list = issueList(page)
  await expect(list.getByRole('listitem').filter({ hasText: yesterday.title })).toContainText('버그 · 추가 요청 · 마감 11월 20일 · 마감 지남')
  await expect(detailValue(detailFor(page), '마감일')).toHaveText('11월 20일 · 마감 지남')
  await list.getByRole('button', { name: new RegExp(today.title) }).click()
  await expect(detailValue(detailFor(page, 2), '마감일')).toHaveText('11월 21일')
  await expect(list.getByRole('listitem').filter({ hasText: today.title })).not.toContainText('마감 지남')
  await list.getByRole('button', { name: new RegExp(noDate.title) }).click()
  await expect(detailValue(detailFor(page, 3), '마감일')).toHaveText('없음')
  await expect(list.getByRole('listitem').filter({ hasText: noDate.title })).not.toContainText('마감 지남')
  await expectSaved(yesterday.id, { category: 'BUG', scope: 'OUT_OF_SCOPE', dueDate: new Date('2026-11-20T00:00:00Z') })
  await expectSaved(today.id, { category: 'BUG', scope: 'IN_SCOPE', dueDate: new Date('2026-11-21T00:00:00Z') })
  await expectSaved(noDate.id, { category: 'BUG', scope: 'IN_SCOPE', dueDate: null })
})

test('상태·화면·분류·범위·마감 지남 필터를 고르면 맞는 쪽지만 보이고 필터를 지우면 모두 돌아온다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const main = await seedIssue(room, '메인의 지난 버그')
  const product = await seedIssue(room, '상품 디자인 수정')
  const noPlace = await seedIssue(room, '위치 없는 문구 수정', room.client.id, false)
  await db.issue.update({ where: { id: main.id }, data: { scope: 'OUT_OF_SCOPE', dueDate: new Date('2026-11-20T00:00:00Z') } })
  await db.issue.update({ where: { id: product.id }, data: {
    category: 'DESIGN', status: 'IN_PROGRESS', originVersionScreenId: room.version.screens[1].id,
    dueDate: new Date('2026-11-21T00:00:00Z'),
  } })
  await db.issue.update({ where: { id: noPlace.id }, data: { category: 'COPY' } })
  await page.clock.setSystemTime(new Date('2026-11-21T12:00:00+09:00'))
  await loginAs(room.developer.id)
  await page.goto(`/app/projects/${room.project.id}`)
  const list = issueList(page)
  await expect(list.getByRole('listitem')).toHaveCount(3)
  // 넓은 화면에서는 펴는 버튼을 감춘다. 감춰진 것까지 찾은 뒤 보이지 않는지 본다(그냥 찾으면 늘 통과한다).
  await expect(list.getByRole('button', { name: '필터', exact: true, includeHidden: true })).toBeHidden()
  // 각 조건을 단독으로 골라도 작동하는지 본다. 한 조건의 검사가 빠지면 이 줄에서 실패한다.
  for (const [label, option, title] of [
    ['상태', 'IN_PROGRESS', product.title],
    ['화면', room.main.id, main.title],
    ['화면', 'none', noPlace.title],
    ['분류', 'COPY', noPlace.title],
    ['범위', 'OUT_OF_SCOPE', main.title],
  ]) {
    await list.getByRole('combobox', { name: label, exact: true }).selectOption(option)
    await expect(list.getByRole('listitem')).toHaveCount(1)
    await expect(list.getByRole('listitem')).toContainText(title)
    await expect(list.getByRole('heading', { name: '쪽지 1개 / 전체 3개', exact: true })).toBeVisible()
    await list.getByRole('button', { name: '필터 지우기', exact: true }).click()
    await expect(list.getByRole('listitem')).toHaveCount(3)
  }
  await list.getByRole('checkbox', { name: '마감 지남만', exact: true }).check()
  await expect(list.getByRole('listitem')).toHaveCount(1)
  await expect(list.getByRole('listitem')).toContainText(main.title)
  await list.getByRole('combobox', { name: '상태', exact: true }).selectOption('OPEN')
  await list.getByRole('combobox', { name: '화면', exact: true }).selectOption(room.main.id)
  await list.getByRole('combobox', { name: '분류', exact: true }).selectOption('BUG')
  await list.getByRole('combobox', { name: '범위', exact: true }).selectOption('OUT_OF_SCOPE')
  await expect(list.getByRole('listitem')).toHaveCount(1)
  await expect(list.getByRole('listitem')).toContainText(main.title)
  await list.getByRole('combobox', { name: '분류', exact: true }).selectOption('DESIGN')
  await expect(list.getByRole('listitem')).toHaveCount(0)
  await expect(list.getByText('조건에 맞는 쪽지가 없어요', { exact: true })).toBeVisible()
  await expect(list.getByRole('heading', { name: '쪽지 0개 / 전체 3개', exact: true })).toBeVisible()
  await list.getByRole('button', { name: '필터 지우기', exact: true }).click()
  await expect(list.getByRole('listitem')).toHaveCount(3)
  await expect(list.getByRole('heading', { name: '쪽지 3개', exact: true })).toBeVisible()
  for (const label of ['상태', '화면', '분류', '범위']) {
    await expect(list.getByRole('combobox', { name: label, exact: true })).toHaveValue('')
  }
  await expect(list.getByRole('checkbox', { name: '마감 지남만', exact: true })).not.toBeChecked()
  await expectSaved(main.id, { category: 'BUG', scope: 'OUT_OF_SCOPE', dueDate: new Date('2026-11-20T00:00:00Z') })
  await expectSaved(product.id, { category: 'DESIGN', scope: 'IN_SCOPE', dueDate: new Date('2026-11-21T00:00:00Z') })
  await expectSaved(noPlace.id, { category: 'COPY', scope: 'IN_SCOPE', dueDate: null })
})

test('필터를 건 채 쪽지를 열어 범위를 바꿔 목록에서 빠져도 상세와 쓰던 댓글이 남고 필터는 유지된다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  await loginAs(room.developer.id)
  await page.goto(`/app/projects/${room.project.id}`)
  const list = issueList(page)
  const filter = list.getByRole('combobox', { name: '범위', exact: true })
  await filter.selectOption('IN_SCOPE')
  await list.getByRole('button', { name: new RegExp(issue.title) }).click()
  const comment = detailFor(page).getByRole('textbox', { name: '댓글', exact: true })
  await comment.fill('범위를 바꿔도 남아야 할 초안')
  await expect(filter).toHaveValue('IN_SCOPE')
  const response = waitForPatch(page, issue.id)
  await chooseScope(page)
  expect((await response).status()).toBe(200)
  await expect(list.getByText('조건에 맞는 쪽지가 없어요', { exact: true })).toBeVisible()
  await expect(detailValue(detailFor(page), '범위')).toHaveText('추가 요청')
  await expect(comment).toHaveValue('범위를 바꿔도 남아야 할 초안')
  const refreshed = page.waitForResponse((item) => new URL(item.url()).pathname === `/api/issues/${issue.id}`)
  await page.clock.fastForward(15_000)
  expect((await refreshed).status()).toBe(200)
  await expect(filter).toHaveValue('IN_SCOPE')
  await expect(list.getByRole('listitem')).toHaveCount(0)
  await expect(comment).toHaveValue('범위를 바꿔도 남아야 할 초안')
  await expect(detailFor(page).getByText(SCOPE_COMMENT, { exact: true })).toBeVisible()
  await expectSaved(issue.id, { category: 'BUG', scope: 'OUT_OF_SCOPE', dueDate: null }, [automaticComment(room, SCOPE_COMMENT)])
  await comment.fill('')
  await detailFor(page).getByRole('button', { name: '쪽지 닫기', exact: true }).click()
  await expect(detailFor(page)).toHaveCount(0)
  await expect(filter).toHaveValue('IN_SCOPE')
  await page.reload()
  await expect(issueList(page).getByRole('combobox', { name: '범위', exact: true })).toHaveValue('')
  await expect(issueList(page).getByRole('listitem')).toHaveCount(1)
})

test('필터로 목록에서 빠진 쪽지의 핀은 사진에 그대로 보인다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const first = await seedIssue(room, '버그 핀')
  const second = await seedIssue(room, '디자인 핀')
  await db.issue.update({ where: { id: second.id }, data: { category: 'DESIGN', xRatio: 0.7, yRatio: 0.6 } })
  await loginAs(room.developer.id)
  await page.goto(`/app/projects/${room.project.id}`)
  await expect(page.getByRole('button', { name: `쪽지 #1 ${first.title}`, exact: true })).toBeVisible()
  const hiddenRowPin = page.getByRole('button', { name: `쪽지 #2 ${second.title}`, exact: true })
  await expect(hiddenRowPin).toBeVisible()
  await issueList(page).getByRole('combobox', { name: '분류', exact: true }).selectOption('BUG')
  await expect(issueList(page).getByRole('listitem')).toHaveCount(1)
  await expect(issueList(page).getByRole('button', { name: new RegExp(second.title) })).toHaveCount(0)
  await expect(hiddenRowPin).toBeVisible()
  await hiddenRowPin.click()
  await expect(detailFor(page, 2).getByRole('heading', { name: second.title, exact: true })).toBeVisible()
  await expect(detailValue(detailFor(page, 2), '분류')).toHaveText('디자인')
  await expect(issueList(page).getByRole('combobox', { name: '분류', exact: true })).toHaveValue('BUG')
  await expectSaved(first.id, { category: 'BUG', scope: 'IN_SCOPE', dueDate: null })
  await expectSaved(second.id, { category: 'DESIGN', scope: 'IN_SCOPE', dueDate: null })
})

test('분류를 바꾸는 사이 새 버전이 올라오면 안내가 보이고 최신 버전에서 다시 바꾸면 저장된다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  await loginAs(room.developer.id)
  await openIssue(page, room, issue.id)
  const latest = await publishVersion(room.project.id, [room.main.id, room.product.id], 1)
  const response = waitForPatch(page, issue.id)
  await triageFor(page).getByRole('combobox', { name: '분류', exact: true }).selectOption('OTHER')
  expect((await response).status()).toBe(409)
  await expect(detailFor(page).getByText('새 버전이 올라왔어요', { exact: false })).toBeVisible()
  await expect(detailValue(detailFor(page), '분류')).toHaveText('버그')
  await expectSaved(issue.id, { category: 'BUG', scope: 'IN_SCOPE', dueDate: null })
  await page.getByRole('button', { name: '최신 버전 보기', exact: true }).click()
  await expect(page.getByRole('combobox', { name: '버전', exact: true })).toHaveValue(latest.id)
  const retried = waitForPatch(page, issue.id)
  await triageFor(page).getByRole('combobox', { name: '분류', exact: true }).selectOption('OTHER')
  expect((await retried).status()).toBe(200)
  await expect(detailValue(detailFor(page), '분류')).toHaveText('기타')
  await expect(issueList(page).getByRole('listitem')).toContainText('기타')
  await expectSaved(issue.id, { category: 'OTHER', scope: 'IN_SCOPE', dueDate: null })
})

test('지난 버전과 승인된 버전에서는 분류·범위·마감일 값만 보이고 입력이 없다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  await db.issue.update({ where: { id: issue.id }, data: {
    category: 'DESIGN', scope: 'OUT_OF_SCOPE', dueDate: new Date('2026-11-20T00:00:00Z'),
  } })
  const latest = await publishVersion(room.project.id, [room.main.id, room.product.id], 1)
  await loginAs(room.developer.id)
  await openIssue(page, room, issue.id)
  await page.getByRole('combobox', { name: '버전', exact: true }).selectOption(room.version.id)
  await expect(detailFor(page).getByText('읽기 전용이에요. 쪽지와 댓글은 바꿀 수 없어요.', { exact: true })).toBeVisible()
  await expect(triageFor(page)).toHaveCount(0)
  await expect(detailValue(detailFor(page), '분류')).toHaveText('디자인')
  await expect(detailValue(detailFor(page), '범위')).toHaveText('추가 요청')
  await expect(detailValue(detailFor(page), '마감일')).toHaveText('11월 20일')
  await db.deliveryVersion.update({ where: { id: latest.id }, data: { status: 'APPROVED' } })
  await page.goto(`/app/projects/${room.project.id}?issue=${issue.id}`)
  await expect(page.getByRole('combobox', { name: '버전', exact: true })).toHaveValue(latest.id)
  await expect(detailFor(page).getByText('읽기 전용이에요. 쪽지와 댓글은 바꿀 수 없어요.', { exact: true })).toBeVisible()
  await expect(triageFor(page)).toHaveCount(0)
  await expect(detailValue(detailFor(page), '분류')).toHaveText('디자인')
  await expect(detailValue(detailFor(page), '범위')).toHaveText('추가 요청')
  await expect(detailValue(detailFor(page), '마감일')).toHaveText('11월 20일')
  await expectSaved(issue.id, { category: 'DESIGN', scope: 'OUT_OF_SCOPE', dueDate: new Date('2026-11-20T00:00:00Z') })
})

test('범위 응답을 기다리는 사이 다른 쪽지를 열면 늦은 응답이 와도 그 쪽지와 쓰던 댓글이 남는다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const first = await seedIssue(room, '범위를 바꿀 쪽지')
  const second = await seedIssue(room, '계속 작성할 쪽지')
  await loginAs(room.developer.id)
  await openIssue(page, room, first.id)
  const pending = await holdPatchResponse(page, first.id)
  try {
    await chooseScope(page)
    await pending.saved
    const triage = triageFor(page)
    await expect(triage.getByRole('combobox', { name: '분류', exact: true })).toBeDisabled()
    await expect(triage.getByRole('combobox', { name: '범위', exact: true })).toBeDisabled()
    await expect(triage.getByLabel('마감일', { exact: true })).toBeDisabled()
    await expect(triage.getByRole('button', { name: '마감일 저장', exact: true })).toBeDisabled()
    await issueList(page).getByRole('button', { name: new RegExp(second.title) }).click()
    const detail = detailFor(page, 2)
    const comment = detail.getByRole('textbox', { name: '댓글', exact: true })
    await comment.fill('두 번째 쪽지에서 쓰던 댓글')
    const listRefreshed = page.waitForResponse((item) => new URL(item.url()).pathname === `/api/projects/${room.project.id}/issues`)
    pending.release()
    expect((await listRefreshed).status()).toBe(200)
    await page.clock.runFor(100)
    await expect(detail.getByRole('heading', { name: second.title, exact: true })).toBeVisible()
    await expect(detailFor(page)).toHaveCount(0)
    await expect(detailValue(detail, '범위')).toHaveText('하자 수정')
    await expect(comment).toHaveValue('두 번째 쪽지에서 쓰던 댓글')
    await expect(page).toHaveURL((url) => url.searchParams.get('issue') === second.id)
    await expectSaved(first.id, { category: 'BUG', scope: 'OUT_OF_SCOPE', dueDate: null }, [automaticComment(room, SCOPE_COMMENT)])
    await expectSaved(second.id, { category: 'BUG', scope: 'IN_SCOPE', dueDate: null })
  } finally {
    pending.release()
  }
})

test('범위 응답을 기다리는 사이 같은 쪽지에 댓글을 남기면 늦은 응답이 와도 새 댓글과 바뀐 범위가 함께 보인다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  await loginAs(room.developer.id)
  await openIssue(page, room, issue.id)
  const pending = await holdPatchResponse(page, issue.id)
  try {
    await chooseScope(page)
    await pending.saved
    const refresh = page.waitForResponse((item) => new URL(item.url()).pathname === `/api/issues/${issue.id}` && item.request().method() === 'GET')
    await postComment(page, issue.id, '범위를 바꾼 뒤 추가 설명')
    expect((await refresh).status()).toBe(200)
    await expect(detailValue(detailFor(page), '범위')).toHaveText('추가 요청')
    await expect(detailFor(page).getByText(SCOPE_COMMENT, { exact: true })).toBeVisible()
    // 늦은 PATCH 응답에는 새 댓글이 없다. 화면은 그 응답을 버리고 상세를 다시 받아야 한다.
    const refreshedAgain = page.waitForResponse((item) => new URL(item.url()).pathname === `/api/issues/${issue.id}` && item.request().method() === 'GET')
    pending.release()
    expect((await refreshedAgain).status()).toBe(200)
    await expect(triageFor(page).getByRole('combobox', { name: '범위', exact: true })).toBeEnabled()
    await expect(detailValue(detailFor(page), '범위')).toHaveText('추가 요청')
    const comments = detailFor(page).getByRole('region', { name: '댓글', exact: true })
    await expect(comments.getByText(SCOPE_COMMENT, { exact: true })).toHaveCount(1)
    await expect(comments.getByText('범위를 바꾼 뒤 추가 설명', { exact: true })).toHaveCount(1)
    await expect(comments.getByRole('textbox', { name: '댓글', exact: true })).toHaveValue('')
    await expectSaved(issue.id, { category: 'BUG', scope: 'OUT_OF_SCOPE', dueDate: null }, [
      automaticComment(room, SCOPE_COMMENT),
      { body: '범위를 바꾼 뒤 추가 설명', authorId: room.developer.id, versionId: room.version.id },
    ])
  } finally {
    pending.release()
  }
})

test('마감일을 치던 중 15초가 지나고 저장이 연결 실패로 끝나도 치던 날짜가 남아 다시 눌러 저장한다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  await loginAs(room.developer.id)
  await openIssue(page, room, issue.id)
  const date = triageFor(page).getByLabel('마감일', { exact: true })
  await date.fill('2026-11-20')
  const refresh = page.waitForResponse((item) => new URL(item.url()).pathname === `/api/issues/${issue.id}`)
  await page.clock.fastForward(15_000)
  expect((await refresh).status()).toBe(200)
  await expect(date).toHaveValue('2026-11-20')
  let failedOnce = false
  await page.route(`**/api/issues/${issue.id}`, async (route) => {
    if (route.request().method() !== 'PATCH' || failedOnce) return route.continue()
    failedOnce = true
    await route.abort('failed')
  })
  const refreshedAfterFailure = page.waitForResponse((item) => new URL(item.url()).pathname === `/api/issues/${issue.id}` && item.request().method() === 'GET')
  await triageFor(page).getByRole('button', { name: '마감일 저장', exact: true }).click()
  expect((await refreshedAfterFailure).status()).toBe(200)
  await expect(date).toHaveValue('2026-11-20')
  await expect(date).toBeEnabled()
  await expect(detailValue(detailFor(page), '마감일')).toHaveText('없음')
  await expectSaved(issue.id, { category: 'BUG', scope: 'IN_SCOPE', dueDate: null })
  await saveDate(page, issue.id)
  await expect(detailValue(detailFor(page), '마감일')).toHaveText('11월 20일')
  await expect(detailFor(page).getByText('마감일: 없음 → 2026년 11월 20일', { exact: true })).toBeVisible()
  await expectSaved(issue.id, { category: 'BUG', scope: 'IN_SCOPE', dueDate: new Date('2026-11-20T00:00:00Z') }, [
    automaticComment(room, '마감일: 없음 → 2026년 11월 20일'),
  ])
})

test('마감일을 저장하는 사이 새 버전이 올라오면 안내가 보이고 최신 버전으로 가도 치던 날짜가 남아 다시 저장한다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  await loginAs(room.developer.id)
  await openIssue(page, room, issue.id)
  await triageFor(page).getByLabel('마감일', { exact: true }).fill('2026-11-20')
  const latest = await publishVersion(room.project.id, [room.main.id, room.product.id], 1)
  await saveDate(page, issue.id, '마감일 저장', 409)
  await expect(detailFor(page).getByText('새 버전이 올라왔어요', { exact: false })).toBeVisible()
  await expect(triageFor(page).getByLabel('마감일', { exact: true })).toHaveValue('2026-11-20')
  await expectSaved(issue.id, { category: 'BUG', scope: 'IN_SCOPE', dueDate: null })
  await page.getByRole('button', { name: '최신 버전 보기', exact: true }).click()
  await expect(page.getByRole('combobox', { name: '버전', exact: true })).toHaveValue(latest.id)
  await expect(triageFor(page).getByLabel('마감일', { exact: true })).toHaveValue('2026-11-20')
  await saveDate(page, issue.id)
  await expect(detailValue(detailFor(page), '마감일')).toHaveText('11월 20일')
  await expect(detailFor(page).getByText('마감일: 없음 → 2026년 11월 20일', { exact: true })).toBeVisible()
  await expectSaved(issue.id, { category: 'BUG', scope: 'IN_SCOPE', dueDate: new Date('2026-11-20T00:00:00Z') }, [
    automaticComment(room, '마감일: 없음 → 2026년 11월 20일', latest.id),
  ])
})

test('범위가 저장된 뒤 응답이 끊기면 확인하지 못했다는 안내가 보이고 쪽지를 다시 불러오면 안내가 사라지며 바뀐 범위와 자동 댓글이 보인다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  await loginAs(room.developer.id)
  await openIssue(page, room, issue.id)
  let release!: () => void
  const refreshGate = new Promise<void>((resolve) => { release = resolve })
  let received!: () => void
  const refreshStarted = new Promise<void>((resolve) => { received = resolve })
  await page.route(`**/api/issues/${issue.id}`, async (route) => {
    if (route.request().method() === 'PATCH') {
      expect((await route.fetch()).status()).toBe(200)
      await route.abort('failed')
      return
    }
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    received()
    await refreshGate
    await route.fulfill({ response })
  })
  try {
    await chooseScope(page)
    await refreshStarted
    await expect(triageFor(page).getByText(UNCONFIRMED, { exact: true })).toBeVisible()
    await expect(detailValue(detailFor(page), '범위')).toHaveText('하자 수정')
    await expect(triageFor(page).getByRole('combobox', { name: '범위', exact: true })).toHaveValue('IN_SCOPE')
    await expect(triageFor(page).getByRole('combobox', { name: '범위', exact: true })).toBeEnabled()
    await expectSaved(issue.id, { category: 'BUG', scope: 'OUT_OF_SCOPE', dueDate: null }, [automaticComment(room, SCOPE_COMMENT)])
    const refreshed = page.waitForResponse((item) => new URL(item.url()).pathname === `/api/issues/${issue.id}` && item.request().method() === 'GET')
    release()
    expect((await refreshed).status()).toBe(200)
    await expect(triageFor(page).getByText(UNCONFIRMED, { exact: true })).toHaveCount(0)
    await expect(detailValue(detailFor(page), '범위')).toHaveText('추가 요청')
    await expect(triageFor(page).getByRole('combobox', { name: '범위', exact: true })).toHaveValue('OUT_OF_SCOPE')
    await expect(detailFor(page).getByText(SCOPE_COMMENT, { exact: true })).toBeVisible()
    await expectSaved(issue.id, { category: 'BUG', scope: 'OUT_OF_SCOPE', dueDate: null }, [automaticComment(room, SCOPE_COMMENT)])
  } finally {
    release()
  }
})

test('범위가 저장된 뒤 응답이 끊기고 다시 불러오기도 실패하면 안내와 옛 값이 남고 다시 눌러도 자동 댓글은 하나만 남는다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  await loginAs(room.developer.id)
  await openIssue(page, room, issue.id)
  let patches = 0
  await page.route(`**/api/issues/${issue.id}`, async (route) => {
    if (route.request().method() === 'GET') return route.abort('failed')
    patches += 1
    if (patches > 1) return route.continue()
    expect((await route.fetch()).status()).toBe(200)
    await route.abort('failed')
  })
  const failedRefresh = page.waitForEvent('requestfailed', (request) =>
    new URL(request.url()).pathname === `/api/issues/${issue.id}` && request.method() === 'GET',
  )
  await chooseScope(page)
  await failedRefresh
  const triage = triageFor(page)
  await expect(triage.getByText(UNCONFIRMED, { exact: true })).toBeVisible()
  await expect(detailValue(detailFor(page), '범위')).toHaveText('하자 수정')
  await expect(triage.getByRole('combobox', { name: '범위', exact: true })).toHaveValue('IN_SCOPE')
  await expect(triage.getByRole('combobox', { name: '범위', exact: true })).toBeEnabled()
  await expect(detailFor(page).getByText(SCOPE_COMMENT, { exact: true })).toHaveCount(0)
  await expectSaved(issue.id, { category: 'BUG', scope: 'OUT_OF_SCOPE', dueDate: null }, [automaticComment(room, SCOPE_COMMENT)])
  const response = waitForPatch(page, issue.id)
  await chooseScope(page)
  expect((await response).status()).toBe(200)
  expect(patches).toBe(2)
  await expect(triage.getByText(UNCONFIRMED, { exact: true })).toHaveCount(0)
  await expect(detailValue(detailFor(page), '범위')).toHaveText('추가 요청')
  await expect(detailFor(page).getByText(SCOPE_COMMENT, { exact: true })).toHaveCount(1)
  await expectSaved(issue.id, { category: 'BUG', scope: 'OUT_OF_SCOPE', dueDate: null }, [automaticComment(room, SCOPE_COMMENT)])
})

test('범위 응답이 끊기고 다시 불러오기가 실패한 뒤 댓글을 저장해도 다시 불러오기가 성공하기 전에는 확인하지 못했다는 안내가 남는다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  await loginAs(room.developer.id)
  await openIssue(page, room, issue.id)
  let failRefresh = true
  await page.route(`**/api/issues/${issue.id}`, async (route) => {
    if (route.request().method() === 'PATCH') {
      expect((await route.fetch()).status()).toBe(200)
      await route.abort('failed')
      return
    }
    if (failRefresh) return route.abort('failed')
    await route.continue()
  })
  const failedRefresh = page.waitForEvent('requestfailed', (request) =>
    new URL(request.url()).pathname === `/api/issues/${issue.id}` && request.method() === 'GET',
  )
  await chooseScope(page)
  await failedRefresh
  const triage = triageFor(page)
  await expect(triage.getByText(UNCONFIRMED, { exact: true })).toBeVisible()
  const failedAfterComment = page.waitForEvent('requestfailed', (request) =>
    new URL(request.url()).pathname === `/api/issues/${issue.id}` && request.method() === 'GET',
  )
  await postComment(page, issue.id, '저장 여부와 별개로 남기는 설명')
  await failedAfterComment
  await expect(triage.getByText(UNCONFIRMED, { exact: true })).toBeVisible()
  await expect(detailValue(detailFor(page), '범위')).toHaveText('하자 수정')
  await expect(detailFor(page).getByText(SCOPE_COMMENT, { exact: true })).toHaveCount(0)
  await expectSaved(issue.id, { category: 'BUG', scope: 'OUT_OF_SCOPE', dueDate: null }, [
    automaticComment(room, SCOPE_COMMENT),
    { body: '저장 여부와 별개로 남기는 설명', authorId: room.developer.id, versionId: room.version.id },
  ])
  failRefresh = false
  const refreshed = page.waitForResponse((item) => new URL(item.url()).pathname === `/api/issues/${issue.id}` && item.request().method() === 'GET')
  await page.clock.fastForward(15_000)
  expect((await refreshed).status()).toBe(200)
  await expect(triage.getByText(UNCONFIRMED, { exact: true })).toHaveCount(0)
  await expect(detailValue(detailFor(page), '범위')).toHaveText('추가 요청')
  await expect(detailFor(page).getByText(SCOPE_COMMENT, { exact: true })).toHaveCount(1)
  await expect(detailFor(page).getByText('저장 여부와 별개로 남기는 설명', { exact: true })).toHaveCount(1)
})

test('휴대폰 화면에서는 필터가 접혀 있고 펴서 고르면 맞는 쪽지만 보인다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const bug = await seedIssue(room, '추가 요청 버그')
  const design = await seedIssue(room, '추가 요청 디자인')
  const inScope = await seedIssue(room, '하자 수정 버그')
  await db.issue.update({ where: { id: bug.id }, data: { scope: 'OUT_OF_SCOPE' } })
  await db.issue.update({ where: { id: design.id }, data: { category: 'DESIGN', scope: 'OUT_OF_SCOPE' } })
  await page.setViewportSize({ width: 390, height: 844 })
  await loginAs(room.client.id)
  await page.goto(`/app/projects/${room.project.id}`)
  const list = issueList(page)
  const toggle = list.getByRole('button', { name: '필터', exact: true })
  await expect(toggle).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  // 접힌 칸은 화면에 없는 것으로 쳐서 보통의 찾기로는 잡히지 않는다. 그러면 "안 보인다"가 늘 통과한다.
  // 감춰진 것까지 찾은 뒤(includeHidden) 보이지 않는지 본다.
  for (const label of ['상태', '화면', '분류', '범위']) {
    await expect(list.getByRole('combobox', { name: label, exact: true, includeHidden: true })).toBeHidden()
  }
  await expect(list.getByRole('listitem')).toHaveCount(3)
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await list.getByRole('combobox', { name: '분류', exact: true }).selectOption('BUG')
  await list.getByRole('combobox', { name: '범위', exact: true }).selectOption('OUT_OF_SCOPE')
  await expect(list.getByRole('heading', { name: '쪽지 1개 / 전체 3개', exact: true })).toBeVisible()
  await expect(list.getByRole('listitem')).toHaveCount(1)
  await expect(list.getByRole('listitem')).toContainText(bug.title)
  const selectedToggle = list.getByRole('button', { name: '필터 2', exact: true })
  await selectedToggle.click()
  await expect(selectedToggle).toHaveAttribute('aria-expanded', 'false')
  await expect(list.getByRole('combobox', { name: '분류', exact: true, includeHidden: true })).toBeHidden()
  await expect(list.getByRole('listitem')).toBeVisible()
  await list.getByRole('button', { name: '필터 지우기', exact: true }).click()
  await expect(list.getByRole('listitem')).toHaveCount(3)
  await expect(list.getByRole('button', { name: '필터', exact: true })).toBeVisible()
  await expectSaved(bug.id, { category: 'BUG', scope: 'OUT_OF_SCOPE', dueDate: null })
  await expectSaved(design.id, { category: 'DESIGN', scope: 'OUT_OF_SCOPE', dueDate: null })
  await expectSaved(inScope.id, { category: 'BUG', scope: 'IN_SCOPE', dueDate: null })
})
