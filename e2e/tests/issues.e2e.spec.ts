import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import type { BrowserContext, Locator, Page, Request } from '@playwright/test'
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

const loadedPhoto = async (page: Page, name = '메인 · PC') => {
  const photo = page.getByRole('img', { name, exact: true })
  await expect(photo).toBeVisible()
  await expect.poll(() => photo.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true)
  return photo
}

const clickPhoto = async (page: Page, xRatio = 0.3, yRatio = 0.4, name = '메인 · PC') => {
  const photo = await loadedPhoto(page, name)
  await photo.scrollIntoViewIfNeeded()
  const box = await photo.boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.click(box!.x + box!.width * xRatio, box!.y + box!.height * yRatio)
  return box!
}

const expectPinPosition = async (photo: Locator, pin: Locator, xRatio: number, yRatio: number) => {
  await expect(pin).toBeVisible()
  // 퍼센트 CSS 문자열이 아니라 브라우저가 실제 그린 핀 중심을 사진과 비교한다.
  await expect.poll(async () => {
    const imageBox = await photo.boundingBox()
    const pinBox = await pin.boundingBox()
    if (!imageBox || !pinBox) return Infinity
    return Math.max(
      Math.abs(pinBox.x + pinBox.width / 2 - imageBox.x - imageBox.width * xRatio),
      Math.abs(pinBox.y + pinBox.height / 2 - imageBox.y - imageBox.height * yRatio),
    )
  }).toBeLessThanOrEqual(1)
}

const fillIssue = async (page: Page, title: string, body = '고쳐 주실 내용을 적어요.') => {
  await page.getByLabel('제목 (필수)', { exact: true }).fill(title)
  await page.getByLabel('내용', { exact: true }).fill(body)
}

const submit = async (page: Page, button: string, path: string, status = 201) => {
  const response = page.waitForResponse(
    (item) => new URL(item.url()).pathname === path && item.request().method() === 'POST',
  )
  await page.getByRole('button', { name: button, exact: true }).click()
  const received = await response
  expect(received.status()).toBe(status)
  return received
}

const expectLockedIssue = async (page: Page, title: string, body: string) => {
  await expect(page.getByRole('button', { name: '다시 보내기', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '취소', exact: true })).toBeVisible()
  await expect(page.getByLabel('제목 (필수)', { exact: true })).toHaveValue(title)
  await expect(page.getByLabel('제목 (필수)', { exact: true })).toHaveJSProperty('readOnly', true)
  await expect(page.getByLabel('제목 (필수)', { exact: true })).toBeEnabled()
  await expect(page.getByLabel('내용', { exact: true })).toHaveValue(body)
  await expect(page.getByLabel('내용', { exact: true })).toHaveJSProperty('readOnly', true)
  await expect(page.getByRole('button', { name: '위치 없이 쓰기', exact: true })).toHaveCount(0)
}

const expectLoginLink = async (page: Page) => {
  await expect(page.getByText('로그인이 끝났어요. 다른 탭에서 로그인한 뒤 다시 눌러 주세요', { exact: false })).toBeVisible()
  const link = page.getByRole('link', { name: '새 탭에서 로그인하기', exact: true })
  await expect(link).toHaveAttribute('target', '_blank')
  await expect(link).toHaveAttribute('href', '/app/login')
}

const uploadPhoto = async (page: Page, issueId: string) => {
  const buffer: Buffer = await sharp({ create: { width: 80, height: 60, channels: 3, background: 'green' } }).png().toBuffer()
  await expect(page.getByLabel('참고 사진 붙이기', { exact: true })).toBeEnabled()
  const response = page.waitForResponse(
    (item) => new URL(item.url()).pathname === `/api/issues/${issueId}/attachments` && item.request().method() === 'POST',
  )
  await page.getByLabel('참고 사진 붙이기', { exact: true }).setInputFiles({ name: 'reference.png', mimeType: 'image/png', buffer })
  expect((await response).status()).toBe(201)
}

test.beforeEach(async () => {
  await resetDatabase()
})

test('사진을 눌러 핀 쪽지를 남기고 위치 없는 쪽지와 댓글을 쓴다', async ({ page, browser, baseURL, loginAs }) => {
  const room = await prepareRoom()
  await loginAs(room.client.id)
  await page.goto(`/app/projects/${room.project.id}`)
  const box = await clickPhoto(page)
  await fillIssue(page, '핀으로 남긴 요청', '첫 줄\n둘째 줄')
  const created = await (await submit(page, '쪽지 남기기', `/api/projects/${room.project.id}/issues`)).json()
  await expect(page.getByRole('article', { name: '쪽지 #1', exact: true })).toContainText('핀으로 남긴 요청')
  const saved = await db.issue.findUniqueOrThrow({ where: { id: created.id } })
  expect(saved.originVersionScreenId).toBe(room.version.screens[0].id)
  expect(saved.originVersionId).toBe(room.version.id)
  expect(Math.abs(saved.xRatio! - 0.3) * box.width).toBeLessThanOrEqual(1)
  expect(Math.abs(saved.yRatio! - 0.4) * box.height).toBeLessThanOrEqual(1)
  await page.getByRole('button', { name: '쪽지 닫기', exact: true }).click()
  await page.getByRole('button', { name: '쪽지 쓰기', exact: true }).click()
  await fillIssue(page, '위치 없는 요청', '')
  const unpinned = await (await submit(page, '쪽지 남기기', `/api/projects/${room.project.id}/issues`)).json()
  expect(await db.issue.findUniqueOrThrow({ where: { id: unpinned.id } })).toMatchObject({
    number: 2, originVersionId: room.version.id, originVersionScreenId: null, xRatio: null, yRatio: null, body: '',
  })
  await expect(page.getByRole('article', { name: '쪽지 #2', exact: true })).toContainText('위치 없음')
  await expect(page.getByRole('region', { name: '쪽지 목록', exact: true }).getByRole('listitem')).toHaveText([
    /#2\s*위치 없는 요청/, /#1\s*핀으로 남긴 요청/,
  ])
  await expect(page.getByRole('heading', { name: '쪽지 2개', exact: true })).toBeVisible()
  await expect(page.getByText('미해결 2개', { exact: true })).toBeVisible()

  const developerContext = await browser.newContext({ baseURL })
  try {
    await loginContext(developerContext, baseURL!, room.developer.id)
    const developerPage = await developerContext.newPage()
    await developerPage.goto(`/app/projects/${room.project.id}?issue=${created.id}`)
    await developerPage.getByRole('textbox', { name: '댓글', exact: true }).fill('요청 확인했어요.\n수정하겠습니다.')
    await submit(developerPage, '댓글 남기기', `/api/issues/${created.id}/comments`)
    await submit(developerPage, '수정 시작', `/api/issues/${created.id}/start`, 200)
    await expect(developerPage.getByRole('article', { name: '쪽지 #1', exact: true })).toContainText('수정 중')
    await page.goto(`/app/projects/${room.project.id}?issue=${created.id}`)
    const detail = page.getByRole('article', { name: '쪽지 #1', exact: true })
    await expect(detail).toContainText('수정 중')
    await expect(detail.getByRole('region', { name: '댓글', exact: true })).toContainText('개발자')
    await expect(detail.getByText('요청 확인했어요.\n수정하겠습니다.', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '수정 시작', exact: true })).toHaveCount(0)
  } finally {
    await developerContext.close()
  }
})

test('개발자가 수정 시작을 누르면 수정 중이 되고 클라이언트에게는 그 버튼이 없다', async ({ page, browser, baseURL, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  await loginAs(room.developer.id)
  const clientContext = await browser.newContext({ baseURL })
  try {
    const clientPage = await clientContext.newPage()
    for (const user of [room.client, room.approver]) {
      await loginContext(clientContext, baseURL!, user.id)
      await clientPage.goto(`/app/projects/${room.project.id}?issue=${issue.id}`)
      await expect(clientPage.getByRole('article', { name: '쪽지 #1', exact: true })).toContainText('접수')
      await expect(clientPage.getByRole('button', { name: '수정 시작', exact: true })).toHaveCount(0)
    }
    await page.goto(`/app/projects/${room.project.id}?issue=${issue.id}`)
    await submit(page, '수정 시작', `/api/issues/${issue.id}/start`, 200)
    await expect(page.getByRole('article', { name: '쪽지 #1', exact: true })).toContainText('수정 중')
    await expect(page.getByRole('button', { name: '수정 시작', exact: true })).toHaveCount(0)
    expect(await db.issue.findUniqueOrThrow({ where: { id: issue.id } })).toMatchObject({ status: 'IN_PROGRESS' })
    expect(await db.activityEvent.count({ where: { issueId: issue.id, type: 'ISSUE_STARTED' } })).toBe(1)
  } finally {
    await clientContext.close()
  }
})

test('댓글을 쓰는 사이 새 버전이 올라오면 안내가 보이고 쓰던 글이 남으며 최신 버전에서 다시 보내면 저장된다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  await loginAs(room.client.id)
  await page.goto(`/app/projects/${room.project.id}?issue=${issue.id}`)
  await page.getByRole('textbox', { name: '댓글', exact: true }).fill('새 버전에서도 필요한 댓글')
  const latest = await publishVersion(room.project.id, [room.main.id, room.product.id], 1)
  await submit(page, '댓글 남기기', `/api/issues/${issue.id}/comments`, 409)
  await expect(page.getByText('새 버전이 올라왔어요. 쓰던 글은 그대로 남아 있어요.', { exact: false })).toBeVisible()
  await expect(page.getByRole('textbox', { name: '댓글', exact: true })).toHaveValue('새 버전에서도 필요한 댓글')
  await expect(page.getByRole('textbox', { name: '댓글', exact: true })).toBeEditable()
  expect(await db.comment.count({ where: { issueId: issue.id } })).toBe(0)
  await page.getByRole('button', { name: '최신 버전 보기', exact: true }).click()
  await expect(page.getByRole('combobox', { name: '버전', exact: true })).toHaveValue(latest.id)
  await expect(page.getByRole('textbox', { name: '댓글', exact: true })).toHaveValue('새 버전에서도 필요한 댓글')
  await submit(page, '댓글 남기기', `/api/issues/${issue.id}/comments`)
  await expect(page.getByRole('region', { name: '댓글', exact: true })).toContainText('새 버전에서도 필요한 댓글')
  expect(await db.comment.findMany({ where: { issueId: issue.id } })).toMatchObject([
    { body: '새 버전에서도 필요한 댓글', versionId: latest.id, authorId: room.client.id },
  ])
})

test('지난 버전에 남긴 쪽지를 고르면 처음 사진과 그 자리의 핀을 보여 준다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  const latest = await publishVersion(room.project.id, [room.main.id, room.product.id], 1)
  await db.screen.update({ where: { id: room.main.id }, data: { hiddenAt: new Date() } })
  await loginAs(room.client.id)
  await page.goto(`/app/projects/${room.project.id}`)
  await expect(await loadedPhoto(page)).toHaveAttribute('src', `/api/assets/${latest.screens[0].assetId}`)
  await page.getByRole('region', { name: '쪽지 목록', exact: true }).getByRole('button', { name: /버튼 색을 바꿔 주세요/ }).click()
  const photo = await loadedPhoto(page)
  await expect(photo).toHaveAttribute('src', `/api/assets/${room.version.screens[0].assetId}`)
  await expect(page.getByText('이 쪽지는 초안에 남긴 요청이에요. 처음 사진의 위치를 보여 드려요.', { exact: true })).toBeVisible()
  await expectPinPosition(photo, page.getByRole('button', { name: `쪽지 #1 ${issue.title}`, exact: true }), 0.3, 0.4)
  await expect(page.getByRole('combobox', { name: '버전', exact: true })).toHaveValue(latest.id)
})

test('지난 버전을 볼 때는 쪽지를 읽기만 하고 사진을 눌러도 쓰기 칸이 열리지 않는다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room, '지난 요청', room.developer.id)
  await publishVersion(room.project.id, [room.main.id, room.product.id], 1)
  await loginAs(room.developer.id)
  await page.goto(`/app/projects/${room.project.id}?issue=${issue.id}`)
  await page.getByRole('combobox', { name: '버전', exact: true }).selectOption(room.version.id)
  await expect(page.getByText('지난 버전이에요. 읽기만 할 수 있어요.', { exact: false })).toBeVisible()
  await clickPhoto(page, 0.7, 0.7)
  await expect(page.getByText('읽기 전용이에요. 쪽지와 댓글은 바꿀 수 없어요.', { exact: true })).toBeVisible()
  await expect(page.getByRole('article', { name: '쪽지 #1', exact: true })).toContainText(issue.title)
  await expect(page.getByRole('img', { name: '새 쪽지 위치', exact: true })).toHaveCount(0)
  await expect(page.getByLabel('제목 (필수)', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: '댓글', exact: true })).toHaveCount(0)
  await expect(page.getByLabel('참고 사진 붙이기', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^(쪽지 쓰기|댓글 남기기|수정 시작|지우기)$/ })).toHaveCount(0)
})

test('핀은 넓은 화면과 휴대폰 화면에서 사진의 같은 비율 자리에 보인다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  await loginAs(room.client.id)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/app/projects/${room.project.id}`)
  const clickedBox = await clickPhoto(page, 0.37, 0.61)
  await fillIssue(page, '크기가 달라도 같은 자리')
  const created = await (await submit(page, '쪽지 남기기', `/api/projects/${room.project.id}/issues`)).json()
  const saved = await db.issue.findUniqueOrThrow({ where: { id: created.id } })
  expect(Math.abs(saved.xRatio! - 0.37) * clickedBox.width).toBeLessThanOrEqual(1)
  expect(Math.abs(saved.yRatio! - 0.61) * clickedBox.height).toBeLessThanOrEqual(1)
  const widths = []
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport)
    const photo = await loadedPhoto(page)
    const pin = page.getByRole('button', { name: '쪽지 #1 크기가 달라도 같은 자리', exact: true })
    await expectPinPosition(photo, pin, saved.xRatio!, saved.yRatio!)
    const pinBox = await pin.boundingBox()
    expect(pinBox!.width).toBeGreaterThanOrEqual(44)
    expect(pinBox!.height).toBeGreaterThanOrEqual(44)
    widths.push((await photo.boundingBox())!.width)
    await pin.click()
    await expect(page.getByRole('article', { name: '쪽지 #1', exact: true })).toContainText('크기가 달라도 같은 자리')
  }
  expect(widths[1]).toBeLessThan(widths[0])
})

test('쪽지와 댓글의 HTML 태그는 실행되지 않고 글자 그대로 보인다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const html = '<script>window.__xss=1</script><img src=x onerror="window.__xss=1">'
  await loginAs(room.client.id)
  await page.goto(`/app/projects/${room.project.id}`)
  await page.getByRole('button', { name: '쪽지 쓰기', exact: true }).click()
  await fillIssue(page, html, `${html}\n둘째 줄`)
  const issue = await (await submit(page, '쪽지 남기기', `/api/projects/${room.project.id}/issues`)).json()
  await page.getByRole('textbox', { name: '댓글', exact: true }).fill(`${html}\n댓글 둘째 줄`)
  await submit(page, '댓글 남기기', `/api/issues/${issue.id}/comments`)
  // 저장된 값을 새로 받아 그릴 때도 HTML로 해석하지 않는다.
  await page.reload()
  const detail = page.getByRole('article', { name: '쪽지 #1', exact: true })
  await expect(detail.getByRole('heading', { name: html, exact: true })).toBeVisible()
  await expect(detail.getByText(`${html}\n둘째 줄`, { exact: true })).toBeVisible()
  await expect(detail.getByText(`${html}\n둘째 줄`, { exact: true })).toHaveCSS('white-space', 'pre-wrap')
  await expect(detail.getByText(`${html}\n댓글 둘째 줄`, { exact: true })).toBeVisible()
  await expect(detail.getByText(`${html}\n댓글 둘째 줄`, { exact: true })).toHaveCSS('white-space', 'pre-wrap')
  await expect(detail.locator('script, img[onerror]')).toHaveCount(0)
  expect(await page.evaluate(() => Reflect.get(window, '__xss'))).toBeUndefined()
})

test('쪽지가 저장된 뒤 응답이 끊기면 글과 핀이 남고 잠기며 다시 보내면 쪽지는 하나만 생긴다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  await loginAs(room.client.id)
  await page.goto(`/app/projects/${room.project.id}`)
  await clickPhoto(page)
  await fillIssue(page, '응답을 놓친 요청', '처음 보낸 내용')
  const path = `/api/projects/${room.project.id}/issues`
  const requests: unknown[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === path && request.method() === 'POST') requests.push(request.postDataJSON())
  })
  await page.route(`**${path}`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    expect((await route.fetch()).status()).toBe(201)
    await route.abort('failed')
  })
  await page.getByRole('button', { name: '쪽지 남기기', exact: true }).click()
  await expectLockedIssue(page, '응답을 놓친 요청', '처음 보낸 내용')
  await clickPhoto(page, 0.8, 0.8)
  await expectPinPosition(await loadedPhoto(page), page.getByRole('img', { name: '새 쪽지 위치', exact: true }), 0.3, 0.4)
  expect(await db.issue.count({ where: { projectId: room.project.id } })).toBe(1)
  // 저장 뒤 새 버전이 게시돼도 같은 요청은 처음 저장한 쪽지를 돌려받아야 한다.
  await publishVersion(room.project.id, [room.main.id, room.product.id], 1)
  await page.unroute(`**${path}`)
  await submit(page, '다시 보내기', path)
  await expect(page.getByRole('article', { name: '쪽지 #1', exact: true })).toContainText('처음 보낸 내용')
  expect(requests).toHaveLength(2)
  expect(requests[1]).toEqual(requests[0])
  expect(await db.issue.findMany({ where: { projectId: room.project.id } })).toMatchObject([
    { title: '응답을 놓친 요청', body: '처음 보낸 내용', originVersionId: room.version.id, originVersionScreenId: room.version.screens[0].id },
  ])
  expect(await db.activityEvent.count({ where: { projectId: room.project.id, type: 'ISSUE_CREATED' } })).toBe(1)
})

test('쓴 사람이 참고 사진을 붙이면 다른 참여자도 그 사진을 본다', async ({ page, browser, baseURL, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  await loginAs(room.client.id)
  await page.goto(`/app/projects/${room.project.id}?issue=${issue.id}`)
  await uploadPhoto(page, issue.id)
  await loadedPhoto(page, '참고 사진 1')
  const otherContext = await browser.newContext({ baseURL })
  try {
    await loginContext(otherContext, baseURL!, room.approver.id)
    const otherPage = await otherContext.newPage()
    await otherPage.goto(`/app/projects/${room.project.id}?issue=${issue.id}`)
    const photo = await loadedPhoto(otherPage, '참고 사진 1')
    const attachment = await db.issueAttachment.findFirstOrThrow({ where: { issueId: issue.id } })
    await expect(photo).toHaveAttribute('src', `/api/assets/${attachment.assetId}`)
    const link = otherPage.getByRole('link').filter({ has: photo })
    await expect(link).toHaveAttribute('target', '_blank')
    await expect(link).toHaveAttribute('href', `/api/assets/${attachment.assetId}`)
    await expect(otherPage.getByLabel('참고 사진 붙이기', { exact: true })).toHaveCount(0)
    await expect(otherPage.getByRole('button', { name: '지우기', exact: true })).toHaveCount(0)
  } finally {
    await otherContext.close()
  }
})

test('다른 사람이 쓴 쪽지와 댓글이 새로고침 없이 보이고 쓰던 글은 그대로다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  await loginAs(room.client.id)
  await page.clock.install()
  await page.goto(`/app/projects/${room.project.id}?issue=${issue.id}`)
  await page.getByRole('textbox', { name: '댓글', exact: true }).fill('아직 보내지 않은 댓글')
  const otherIssue = await seedIssue(room, '다른 사람이 남긴 쪽지', room.developer.id, false)
  await db.comment.create({
    data: { issueId: issue.id, authorId: room.developer.id, versionId: room.version.id, body: '다른 사람이 쓴 댓글', requestId: randomUUID() },
  })
  const listResponse = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/projects/${room.project.id}/issues`)
  const detailResponse = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/issues/${issue.id}`)
  await page.clock.fastForward(15_000)
  expect((await listResponse).status()).toBe(200)
  expect((await detailResponse).status()).toBe(200)
  await expect(page.getByRole('region', { name: '쪽지 목록', exact: true })).toContainText(otherIssue.title)
  await expect(page.getByRole('region', { name: '댓글', exact: true })).toContainText('다른 사람이 쓴 댓글')
  await expect(page.getByRole('textbox', { name: '댓글', exact: true })).toHaveValue('아직 보내지 않은 댓글')
  await expect(page).toHaveURL((url) => url.searchParams.get('issue') === issue.id)

  await page.getByRole('button', { name: '쪽지 닫기', exact: true }).click()
  await clickPhoto(page, 0.7, 0.6)
  await fillIssue(page, '쓰는 중인 제목', '쓰는 중인 내용')
  const newest = await seedIssue(room, '쓰는 동안 생긴 쪽지', room.approver.id, false)
  const latest = await publishVersion(room.project.id, [room.main.id, room.product.id], 1)
  const nextList = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/projects/${room.project.id}/issues`)
  await page.clock.fastForward(15_000)
  expect((await nextList).status()).toBe(200)
  await expect(page.getByLabel('제목 (필수)', { exact: true })).toHaveValue('쓰는 중인 제목')
  await expect(page.getByLabel('내용', { exact: true })).toHaveValue('쓰는 중인 내용')
  await expectPinPosition(await loadedPhoto(page), page.getByRole('img', { name: '새 쪽지 위치', exact: true }), 0.7, 0.6)
  // 타이머는 버전을 바꾸지 않는다. 새 버전은 쓰기 요청의 409로 안내한다.
  await expect(page.getByRole('combobox', { name: '버전', exact: true })).toHaveValue(room.version.id)
  await expect(page.getByRole('combobox', { name: '버전', exact: true })).not.toHaveValue(latest.id)
  await page.getByRole('button', { name: '취소', exact: true }).click()
  await expect(page.getByRole('region', { name: '쪽지 목록', exact: true })).toContainText(newest.title)
})

test('활동 일지의 쪽지 문장을 누르면 그 쪽지가 열린 검수실로 간다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  await loginAs(room.developer.id)
  await page.goto(`/app/projects/${room.project.id}`)
  await page.getByRole('button', { name: '쪽지 쓰기', exact: true }).click()
  await fillIssue(page, '일지에서 찾아올 요청')
  const issue = await (await submit(page, '쪽지 남기기', `/api/projects/${room.project.id}/issues`)).json()
  await page.getByRole('textbox', { name: '댓글', exact: true }).fill('댓글은 일지에 남기지 않아요')
  await submit(page, '댓글 남기기', `/api/issues/${issue.id}/comments`)
  await submit(page, '수정 시작', `/api/issues/${issue.id}/start`, 200)
  for (const sentence of ['개발자님이 #1 쪽지를 남겼어요', '개발자님이 #1 쪽지 수정을 시작했어요']) {
    await page.getByRole('link', { name: '활동 일지', exact: true }).click()
    await expect(page.getByRole('heading', { name: `${room.project.name} 활동 일지`, exact: true })).toBeVisible()
    const link = page.getByRole('link', { name: new RegExp(sentence) })
    await expect(link).toHaveAttribute('href', `/app/projects/${room.project.id}?issue=${issue.id}`)
    await expect(page.getByRole('listitem')).toHaveCount(2)
    await expect(page.getByText('댓글은 일지에 남기지 않아요', { exact: true })).toHaveCount(0)
    await link.click()
    await expect(page).toHaveURL(`/app/projects/${room.project.id}?issue=${issue.id}`)
    await expect(page.getByRole('article', { name: '쪽지 #1', exact: true })).toContainText('일지에서 찾아올 요청')
  }
})

test('접근이 철회된 사람은 쪽지 주소를 알아도 없는 프로젝트 화면을 본다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  await loginAs(room.client.id)
  await db.projectMember.update({
    where: { projectId_userId: { projectId: room.project.id, userId: room.client.id } },
    data: { revokedAt: new Date() },
  })
  await page.goto(`/app/projects/${room.project.id}?issue=${issue.id}`)
  await expect(page.getByRole('heading', { name: '없는 프로젝트예요', exact: true })).toBeVisible()
  await expect(page.getByRole('article')).toHaveCount(0)
  await expect(page.getByText(issue.title, { exact: true })).toHaveCount(0)
  await expect(page.getByRole('link', { name: '프로젝트 목록', exact: true })).toBeVisible()
})

test('현재 버전이 승인되면 읽기 전용 안내가 보이고 쪽지·댓글·수정 시작·참고 사진 입력과 지우기가 모두 없다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room, '승인 뒤 읽을 요청', room.developer.id)
  await loginAs(room.developer.id)
  await page.goto(`/app/projects/${room.project.id}?issue=${issue.id}`)
  await uploadPhoto(page, issue.id)
  await expect(page.getByRole('button', { name: '지우기', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '수정 시작', exact: true })).toBeVisible()
  await db.$transaction([
    db.deliveryVersion.update({ where: { id: room.version.id }, data: { status: 'APPROVED' } }),
    db.approval.create({ data: { versionId: room.version.id, approverId: room.approver.id, summary: { issues: [] } } }),
  ])
  await page.reload()
  await expect(page.getByText('읽기 전용이에요. 쪽지와 댓글은 바꿀 수 없어요.', { exact: true })).toBeVisible()
  await loadedPhoto(page, '참고 사진 1')
  await expect(page.getByRole('textbox', { name: '댓글', exact: true })).toHaveCount(0)
  await expect(page.getByLabel('참고 사진 붙이기', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^(쪽지 쓰기|댓글 남기기|수정 시작|지우기)$/ })).toHaveCount(0)
  await clickPhoto(page, 0.8, 0.7)
  await expect(page.getByLabel('제목 (필수)', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('img', { name: '새 쪽지 위치', exact: true })).toHaveCount(0)
  expect(await db.issue.findUniqueOrThrow({ where: { id: issue.id } })).toMatchObject({ status: 'OPEN' })
  expect(await db.comment.count({ where: { issueId: issue.id } })).toBe(0)
  expect(await db.issueAttachment.count({ where: { issueId: issue.id } })).toBe(1)
})

test('지난 버전에 남긴 쪽지에도 댓글과 수정 시작은 되지만 그 처음 사진에는 새 핀이 생기지 않는다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  const latest = await publishVersion(room.project.id, [room.main.id, room.product.id], 1)
  await loginAs(room.developer.id)
  await page.goto(`/app/projects/${room.project.id}?issue=${issue.id}`)
  await expect(page.getByText('이 쪽지는 초안에 남긴 요청이에요. 처음 사진의 위치를 보여 드려요.', { exact: true })).toBeVisible()
  await expect(await loadedPhoto(page)).toHaveAttribute('src', `/api/assets/${room.version.screens[0].assetId}`)
  await clickPhoto(page, 0.8, 0.7)
  await expect(page.getByRole('img', { name: '새 쪽지 위치', exact: true })).toHaveCount(0)
  await expect(page.getByLabel('제목 (필수)', { exact: true })).toHaveCount(0)
  await page.getByRole('textbox', { name: '댓글', exact: true }).fill('이번 차수에서 고칠게요')
  const commentResponse = await submit(page, '댓글 남기기', `/api/issues/${issue.id}/comments`)
  expect(commentResponse.request().postDataJSON()).toMatchObject({ versionId: latest.id })
  const startResponse = await submit(page, '수정 시작', `/api/issues/${issue.id}/start`, 200)
  expect(startResponse.request().postDataJSON()).toEqual({ versionId: latest.id })
  await expect(page.getByRole('article', { name: '쪽지 #1', exact: true })).toContainText('수정 중')
  await expect(page.getByRole('region', { name: '댓글', exact: true })).toContainText('1차')
  expect(await db.comment.findFirstOrThrow({ where: { issueId: issue.id } })).toMatchObject({ versionId: latest.id, body: '이번 차수에서 고칠게요' })
  expect(await db.issue.findUniqueOrThrow({ where: { id: issue.id } })).toMatchObject({
    originVersionId: room.version.id, originVersionScreenId: room.version.screens[0].id, status: 'IN_PROGRESS',
  })
})

test('주소에 다른 프로젝트의 쪽지나 없는 쪽지를 넣으면 없는 쪽지 안내가 보이고 그 쪽지 내용은 보이지 않는다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const local = await seedIssue(room, '이 프로젝트의 요청')
  const otherProject = await createProject(room.developer.id, '다른 프로젝트')
  const otherScreen = await db.screen.create({ data: { projectId: otherProject.id, name: '다른 화면', viewport: 'PC' } })
  const otherVersion = await publishVersion(otherProject.id, [otherScreen.id], 0)
  const foreign = await db.issue.create({
    data: { projectId: otherProject.id, originVersionId: otherVersion.id, authorId: room.developer.id, number: 1,
      title: '다른 프로젝트의 비공개 제목', body: '다른 프로젝트의 본문', requestId: randomUUID() },
  })
  await loginAs(room.developer.id)
  const detailRequests: string[] = []
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (/^\/api\/issues\/[^/]+$/.test(path)) detailRequests.push(path)
  })
  for (const issueId of [foreign.id, randomUUID(), 'not-a-uuid']) {
    await page.goto(`/app/projects/${room.project.id}?issue=${issueId}`)
    await expect(page.getByText('없는 쪽지예요.', { exact: true })).toBeVisible()
    await expect(page.getByRole('region', { name: '쪽지 목록', exact: true })).toContainText(local.title)
    await expect(page.getByText(foreign.title, { exact: true })).toHaveCount(0)
    await expect(page.getByText(foreign.body, { exact: true })).toHaveCount(0)
    await expect(page.getByRole('article')).toHaveCount(0)
    await expect(page.getByLabel('참고 사진 붙이기', { exact: true })).toHaveCount(0)
  }
  expect(detailRequests).toEqual([])
})

test('핀 쪽지를 쓰는 사이 새 버전이 올라오면 글은 남고 핀은 지워지며 새 사진에서 다시 고른 자리에 저장된다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  await loginAs(room.client.id)
  await page.goto(`/app/projects/${room.project.id}`)
  await clickPhoto(page)
  await fillIssue(page, '버전이 바뀌어도 남길 제목', '버전이 바뀌어도 남길 내용')
  const latest = await publishVersion(room.project.id, [room.main.id, room.product.id], 1)
  await submit(page, '쪽지 남기기', `/api/projects/${room.project.id}/issues`, 409)
  await expect(page.getByText('새 버전이 올라왔어요. 쓰던 글은 그대로 남아 있어요.', { exact: false })).toBeVisible()
  await expect(page.getByLabel('제목 (필수)', { exact: true })).toBeEditable()
  await expect(page.getByLabel('내용', { exact: true })).toBeEditable()
  expect(await db.issue.count({ where: { projectId: room.project.id } })).toBe(0)
  await page.getByRole('button', { name: '최신 버전 보기', exact: true }).click()
  await expect(page.getByRole('combobox', { name: '버전', exact: true })).toHaveValue(latest.id)
  await expect(await loadedPhoto(page)).toHaveAttribute('src', `/api/assets/${latest.screens[0].assetId}`)
  await expect(page.getByRole('img', { name: '새 쪽지 위치', exact: true })).toHaveCount(0)
  await expect(page.getByLabel('제목 (필수)', { exact: true })).toHaveValue('버전이 바뀌어도 남길 제목')
  await expect(page.getByLabel('내용', { exact: true })).toHaveValue('버전이 바뀌어도 남길 내용')
  await expect(page.getByText('위치를 정하지 않은 쪽지예요. 사진을 누르면 그 자리에 남길 수 있어요.', { exact: true })).toBeVisible()
  const box = await clickPhoto(page, 0.7, 0.65)
  const issue = await (await submit(page, '쪽지 남기기', `/api/projects/${room.project.id}/issues`)).json()
  const saved = await db.issue.findUniqueOrThrow({ where: { id: issue.id } })
  expect(saved).toMatchObject({ originVersionId: latest.id, originVersionScreenId: latest.screens[0].id,
    title: '버전이 바뀌어도 남길 제목', body: '버전이 바뀌어도 남길 내용' })
  expect(Math.abs(saved.xRatio! - 0.7) * box.width).toBeLessThanOrEqual(1)
  expect(Math.abs(saved.yRatio! - 0.65) * box.height).toBeLessThanOrEqual(1)
})

test('핀을 찍고 다른 화면을 고르면 핀이 지워지고 글은 남으며 그대로 남기면 위치 없는 쪽지가 된다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  await loginAs(room.client.id)
  await page.goto(`/app/projects/${room.project.id}`)
  await clickPhoto(page)
  await fillIssue(page, '화면을 바꿔도 남는 제목', '화면을 바꿔도 남는 내용')
  await page.getByRole('button', { name: '상품 상세 · PC', exact: true }).click()
  await loadedPhoto(page, '상품 상세 · PC')
  await expect(page.getByRole('img', { name: '새 쪽지 위치', exact: true })).toHaveCount(0)
  await expect(page.getByLabel('제목 (필수)', { exact: true })).toHaveValue('화면을 바꿔도 남는 제목')
  await expect(page.getByLabel('내용', { exact: true })).toHaveValue('화면을 바꿔도 남는 내용')
  // 원래 사진으로 돌아와도 지운 임시 핀이 되살아나지 않는다.
  await page.getByRole('button', { name: '메인 · PC', exact: true }).click()
  await expect(page.getByRole('img', { name: '새 쪽지 위치', exact: true })).toHaveCount(0)
  const issue = await (await submit(page, '쪽지 남기기', `/api/projects/${room.project.id}/issues`)).json()
  expect(await db.issue.findUniqueOrThrow({ where: { id: issue.id } })).toMatchObject({
    title: '화면을 바꿔도 남는 제목', body: '화면을 바꿔도 남는 내용',
    originVersionId: room.version.id, originVersionScreenId: null, xRatio: null, yRatio: null,
  })
  await expect(page.getByRole('article', { name: '쪽지 #1', exact: true })).toContainText('위치 없음')
})

test('쓴 사람이 참고 사진을 지우면 다른 참여자에게도 사라지고 다시 붙일 수 있다', async ({ page, browser, baseURL, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  await loginAs(room.client.id)
  await page.goto(`/app/projects/${room.project.id}?issue=${issue.id}`)
  await uploadPhoto(page, issue.id)
  await uploadPhoto(page, issue.id)
  await uploadPhoto(page, issue.id)
  await expect(page.getByLabel('참고 사진 붙이기', { exact: true })).toHaveCount(0)
  const attachments = await db.issueAttachment.findMany({ where: { issueId: issue.id } })
  const otherContext = await browser.newContext({ baseURL })
  try {
    await loginContext(otherContext, baseURL!, room.developer.id)
    const otherPage = await otherContext.newPage()
    await otherPage.clock.install()
    await otherPage.goto(`/app/projects/${room.project.id}?issue=${issue.id}`)
    await loadedPhoto(otherPage, '참고 사진 3')
    // 개발자여도 남이 쓴 쪽지의 사진을 지울 수 없다.
    await expect(otherPage.getByRole('button', { name: '지우기', exact: true })).toHaveCount(0)
    await expect(otherPage.getByLabel('참고 사진 붙이기', { exact: true })).toHaveCount(0)
    const firstPhoto = page.getByRole('list', { name: '참고 사진', exact: true }).getByRole('listitem').first()
    const src = await firstPhoto.getByRole('img').getAttribute('src')
    const removed = attachments.find((attachment) => src === `/api/assets/${attachment.assetId}`)!
    expect(removed).toBeDefined()
    const dialogPromise = page.waitForEvent('dialog')
    page.once('dialog', (dialog) => dialog.accept())
    const deleted = page.waitForResponse((response) => response.request().method() === 'DELETE'
      && new URL(response.url()).pathname === `/api/issues/${issue.id}/attachments/${removed.id}`)
    await firstPhoto.getByRole('button', { name: '지우기', exact: true }).click()
    const dialog = await dialogPromise
    expect(dialog.type()).toBe('confirm')
    expect(dialog.message()).toBe('이 사진을 지울까요?')
    expect((await deleted).status()).toBe(200)
    await expect(page.getByRole('list', { name: '참고 사진', exact: true }).getByRole('img')).toHaveCount(2)
    await expect(page.getByLabel('참고 사진 붙이기', { exact: true })).toBeVisible()
    const refreshed = otherPage.waitForResponse((response) => new URL(response.url()).pathname === `/api/issues/${issue.id}`)
    await otherPage.clock.fastForward(15_000)
    expect((await refreshed).status()).toBe(200)
    await expect(otherPage.getByRole('list', { name: '참고 사진', exact: true }).getByRole('img')).toHaveCount(2)
    await expect(otherPage.locator(`img[src="${src}"]`)).toHaveCount(0)
    expect((await otherPage.request.get(src!)).status()).toBe(404)
    expect(await db.issueAttachment.findUnique({ where: { id: removed.id } })).toBeNull()
    await uploadPhoto(page, issue.id)
    await expect(page.getByRole('list', { name: '참고 사진', exact: true }).getByRole('img')).toHaveCount(3)
    await expect(page.getByLabel('참고 사진 붙이기', { exact: true })).toHaveCount(0)
    expect(await db.issueAttachment.count({ where: { issueId: issue.id } })).toBe(3)
    await otherPage.reload()
    await loadedPhoto(otherPage, '참고 사진 3')
  } finally {
    await otherContext.close()
  }
})

test('댓글이 저장된 뒤 응답이 끊기면 글이 남고 잠기며 다시 보내면 댓글은 하나만 생긴다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  const latest = await publishVersion(room.project.id, [room.main.id, room.product.id], 1)
  await loginAs(room.client.id)
  await page.goto(`/app/projects/${room.project.id}?issue=${issue.id}`)
  await page.getByRole('textbox', { name: '댓글', exact: true }).fill('응답을 놓친 댓글')
  const path = `/api/issues/${issue.id}/comments`
  const requests: unknown[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === path && request.method() === 'POST') requests.push(request.postDataJSON())
  })
  await page.route(`**${path}`, async (route) => {
    expect((await route.fetch()).status()).toBe(201)
    await route.abort('failed')
  })
  await page.getByRole('button', { name: '댓글 남기기', exact: true }).click()
  await expect(page.getByRole('button', { name: '다시 보내기', exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: '댓글', exact: true })).toHaveValue('응답을 놓친 댓글')
  await expect(page.getByRole('textbox', { name: '댓글', exact: true })).toHaveJSProperty('readOnly', true)
  await expect(page.getByRole('textbox', { name: '댓글', exact: true })).toBeEnabled()
  expect(await db.comment.count({ where: { issueId: issue.id } })).toBe(1)
  await page.getByRole('combobox', { name: '버전', exact: true }).selectOption(room.version.id)
  await expect(page.getByText('읽기 전용이에요. 쪽지와 댓글은 바꿀 수 없어요.', { exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: '댓글', exact: true })).toHaveValue('응답을 놓친 댓글')
  await expect(page.getByRole('textbox', { name: '댓글', exact: true })).toHaveJSProperty('readOnly', true)
  await expect(page.getByRole('button', { name: '다시 보내기', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '취소', exact: true })).toBeVisible()
  await page.unroute(`**${path}`)
  await submit(page, '다시 보내기', path)
  await expect(page.getByRole('region', { name: '댓글', exact: true })).toContainText('댓글 1개')
  await expect(page.getByRole('button', { name: '다시 보내기', exact: true })).toHaveCount(0)
  expect(requests).toHaveLength(2)
  expect(requests[1]).toEqual(requests[0])
  expect(await db.comment.findMany({ where: { issueId: issue.id } })).toMatchObject([
    { body: '응답을 놓친 댓글', versionId: latest.id, authorId: room.client.id },
  ])
})

test('응답이 끊긴 뒤 다시 보내기가 세션 만료로 실패해도 잠긴 채로 남고 다시 로그인해 보내면 쪽지는 하나만 생긴다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  await loginAs(room.client.id)
  await page.goto(`/app/projects/${room.project.id}`)
  await clickPhoto(page)
  await fillIssue(page, '로그인 뒤 다시 보낼 제목', '로그인 뒤 다시 보낼 내용')
  const path = `/api/projects/${room.project.id}/issues`
  const requests: unknown[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === path && request.method() === 'POST') requests.push(request.postDataJSON())
  })
  await page.route(`**${path}`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    expect((await route.fetch()).status()).toBe(201)
    await route.abort('failed')
  })
  await page.getByRole('button', { name: '쪽지 남기기', exact: true }).click()
  await expectLockedIssue(page, '로그인 뒤 다시 보낼 제목', '로그인 뒤 다시 보낼 내용')
  await page.unroute(`**${path}`)
  await db.session.deleteMany({ where: { userId: room.client.id } })
  await submit(page, '다시 보내기', path, 401)
  await expectLoginLink(page)
  await expectLockedIssue(page, '로그인 뒤 다시 보낼 제목', '로그인 뒤 다시 보낼 내용')
  await clickPhoto(page, 0.75, 0.75)
  await expectPinPosition(await loadedPhoto(page), page.getByRole('img', { name: '새 쪽지 위치', exact: true }), 0.3, 0.4)
  await loginAs(room.client.id)
  await submit(page, '다시 보내기', path)
  await expect(page.getByRole('article', { name: '쪽지 #1', exact: true })).toContainText('로그인 뒤 다시 보낼 내용')
  expect(requests).toHaveLength(3)
  expect(requests[1]).toEqual(requests[0])
  expect(requests[2]).toEqual(requests[0])
  expect(await db.issue.count({ where: { projectId: room.project.id } })).toBe(1)
  expect(await db.activityEvent.count({ where: { projectId: room.project.id, type: 'ISSUE_CREATED' } })).toBe(1)
})

test('응답이 끊겨 잠긴 뒤 다른 화면이나 지난 버전을 골라도 다시 보내기가 남아 있고 처음 찍은 화면과 자리에 쪽지가 저장된다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const latest = await publishVersion(room.project.id, [room.main.id, room.product.id], 1)
  await loginAs(room.client.id)
  await page.goto(`/app/projects/${room.project.id}`)
  const box = await clickPhoto(page, 0.35, 0.55)
  await fillIssue(page, '처음 사진에 남길 요청', '처음 자리와 함께 보낼 내용')
  const path = `/api/projects/${room.project.id}/issues`
  const requests: unknown[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === path && request.method() === 'POST') requests.push(request.postDataJSON())
  })
  await page.route(`**${path}`, (route) => route.request().method() === 'POST' ? route.abort('failed') : route.continue())
  await page.getByRole('button', { name: '쪽지 남기기', exact: true }).click()
  await expectLockedIssue(page, '처음 사진에 남길 요청', '처음 자리와 함께 보낼 내용')
  expect(await db.issue.count({ where: { projectId: room.project.id } })).toBe(0)
  await page.getByRole('button', { name: '상품 상세 · PC', exact: true }).click()
  await clickPhoto(page, 0.8, 0.8, '상품 상세 · PC')
  await expectLockedIssue(page, '처음 사진에 남길 요청', '처음 자리와 함께 보낼 내용')
  await expect(page.getByRole('img', { name: '새 쪽지 위치', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '메인 · PC', exact: true }).click()
  await expectPinPosition(await loadedPhoto(page), page.getByRole('img', { name: '새 쪽지 위치', exact: true }), 0.35, 0.55)
  await page.getByRole('combobox', { name: '버전', exact: true }).selectOption(room.version.id)
  await expect(page.getByText('지난 버전이에요. 읽기만 할 수 있어요.', { exact: false })).toBeVisible()
  await clickPhoto(page, 0.8, 0.8)
  await expectLockedIssue(page, '처음 사진에 남길 요청', '처음 자리와 함께 보낼 내용')
  await page.unroute(`**${path}`)
  const issue = await (await submit(page, '다시 보내기', path)).json()
  const saved = await db.issue.findUniqueOrThrow({ where: { id: issue.id } })
  expect(saved).toMatchObject({ originVersionId: latest.id, originVersionScreenId: latest.screens[0].id,
    title: '처음 사진에 남길 요청', body: '처음 자리와 함께 보낼 내용' })
  expect(Math.abs(saved.xRatio! - 0.35) * box.width).toBeLessThanOrEqual(1)
  expect(Math.abs(saved.yRatio! - 0.55) * box.height).toBeLessThanOrEqual(1)
  expect(requests).toHaveLength(2)
  expect(requests[1]).toEqual(requests[0])
  expect(await db.issue.count({ where: { projectId: room.project.id } })).toBe(1)
  await expect(page.getByRole('article', { name: '쪽지 #1', exact: true })).toContainText('처음 사진에 남길 요청')
})

test('쪽지를 보낼 때 로그인이 끝났으면 새 탭에서 로그인한 뒤 글을 다시 쓰지 않고 저장한다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  await loginAs(room.client.id)
  await page.goto(`/app/projects/${room.project.id}`)
  const box = await clickPhoto(page)
  await fillIssue(page, '세션이 끝나도 남을 제목', '세션이 끝나도 남을 내용')
  await db.session.deleteMany({ where: { userId: room.client.id } })
  await submit(page, '쪽지 남기기', `/api/projects/${room.project.id}/issues`, 401)
  await expectLoginLink(page)
  await expect(page.getByLabel('제목 (필수)', { exact: true })).toHaveValue('세션이 끝나도 남을 제목')
  await expect(page.getByLabel('내용', { exact: true })).toHaveValue('세션이 끝나도 남을 내용')
  await expect(page.getByLabel('제목 (필수)', { exact: true })).toBeEditable()
  await expect(page.getByLabel('내용', { exact: true })).toBeEditable()
  await expect(page.getByRole('button', { name: '다시 보내기', exact: true })).toHaveCount(0)
  await expectPinPosition(await loadedPhoto(page), page.getByRole('img', { name: '새 쪽지 위치', exact: true }), 0.3, 0.4)
  expect(await db.issue.count({ where: { projectId: room.project.id } })).toBe(0)
  await loginAs(room.client.id)
  const issue = await (await submit(page, '쪽지 남기기', `/api/projects/${room.project.id}/issues`)).json()
  await expect(page.getByRole('article', { name: '쪽지 #1', exact: true })).toContainText('세션이 끝나도 남을 내용')
  const saved = await db.issue.findUniqueOrThrow({ where: { id: issue.id } })
  expect(saved).toMatchObject({ title: '세션이 끝나도 남을 제목', body: '세션이 끝나도 남을 내용',
    originVersionId: room.version.id, originVersionScreenId: room.version.screens[0].id })
  expect(Math.abs(saved.xRatio! - 0.3) * box.width).toBeLessThanOrEqual(1)
  expect(Math.abs(saved.yRatio! - 0.4) * box.height).toBeLessThanOrEqual(1)
  expect(await db.issue.count({ where: { projectId: room.project.id } })).toBe(1)
})

test('댓글을 보낼 때 로그인이 끝났으면 새 탭에서 로그인한 뒤 글을 다시 쓰지 않고 저장한다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  await loginAs(room.approver.id)
  await page.goto(`/app/projects/${room.project.id}?issue=${issue.id}`)
  await page.getByRole('textbox', { name: '댓글', exact: true }).fill('세션이 끝나도 남을 댓글')
  await db.session.deleteMany({ where: { userId: room.approver.id } })
  await submit(page, '댓글 남기기', `/api/issues/${issue.id}/comments`, 401)
  await expectLoginLink(page)
  await expect(page.getByRole('textbox', { name: '댓글', exact: true })).toHaveValue('세션이 끝나도 남을 댓글')
  await expect(page.getByRole('textbox', { name: '댓글', exact: true })).toBeEditable()
  await expect(page.getByRole('button', { name: '다시 보내기', exact: true })).toHaveCount(0)
  expect(await db.comment.count({ where: { issueId: issue.id } })).toBe(0)
  await loginAs(room.approver.id)
  await submit(page, '댓글 남기기', `/api/issues/${issue.id}/comments`)
  await expect(page.getByRole('region', { name: '댓글', exact: true })).toContainText('세션이 끝나도 남을 댓글')
  await expect(page.getByRole('textbox', { name: '댓글', exact: true })).toHaveValue('')
  expect(await db.comment.findMany({ where: { issueId: issue.id } })).toMatchObject([
    { body: '세션이 끝나도 남을 댓글', authorId: room.approver.id, versionId: room.version.id },
  ])
})

test('응답이 끊겨 잠긴 글을 다시 보내 새 버전 안내를 받으면 잠금이 풀리고 최신 버전에서 저장된다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  await loginAs(room.client.id)
  await page.goto(`/app/projects/${room.project.id}?issue=${issue.id}`)
  await page.getByRole('textbox', { name: '댓글', exact: true }).fill('저장되지 않아 다시 보낼 댓글')
  const path = `/api/issues/${issue.id}/comments`
  await page.route(`**${path}`, (route) => route.abort('failed'))
  await page.getByRole('button', { name: '댓글 남기기', exact: true }).click()
  await expect(page.getByRole('button', { name: '다시 보내기', exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: '댓글', exact: true })).toHaveJSProperty('readOnly', true)
  expect(await db.comment.count({ where: { issueId: issue.id } })).toBe(0)
  const latest = await publishVersion(room.project.id, [room.main.id, room.product.id], 1)
  await page.unroute(`**${path}`)
  await submit(page, '다시 보내기', path, 409)
  await expect(page.getByText('새 버전이 올라왔어요. 쓰던 글은 그대로 남아 있어요.', { exact: false })).toBeVisible()
  await expect(page.getByRole('textbox', { name: '댓글', exact: true })).toHaveValue('저장되지 않아 다시 보낼 댓글')
  await expect(page.getByRole('textbox', { name: '댓글', exact: true })).toBeEditable()
  await expect(page.getByRole('button', { name: '다시 보내기', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '댓글 남기기', exact: true })).toBeVisible()
  expect(await db.comment.count({ where: { issueId: issue.id } })).toBe(0)
  await page.getByRole('button', { name: '최신 버전 보기', exact: true }).click()
  await expect(page.getByRole('combobox', { name: '버전', exact: true })).toHaveValue(latest.id)
  await expect(page.getByRole('textbox', { name: '댓글', exact: true })).toHaveValue('저장되지 않아 다시 보낼 댓글')
  await submit(page, '댓글 남기기', path)
  await expect(page.getByRole('region', { name: '댓글', exact: true })).toContainText('저장되지 않아 다시 보낼 댓글')
  expect(await db.comment.findMany({ where: { issueId: issue.id } })).toMatchObject([
    { body: '저장되지 않아 다시 보낼 댓글', versionId: latest.id },
  ])
})

// 기획 5장의 보존·취소 규칙 중 위 24개가 직접 확인하지 않는 흐름.
test('보내기 전 지난 버전으로 갔다 돌아오면 글은 남고 핀은 지워진 채 위치 없는 쪽지를 남긴다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const latest = await publishVersion(room.project.id, [room.main.id, room.product.id], 1)
  await loginAs(room.client.id)
  await page.goto(`/app/projects/${room.project.id}`)
  await clickPhoto(page)
  await fillIssue(page, '버전을 둘러보며 쓰는 제목', '버전을 둘러보며 쓰는 내용')
  await page.getByRole('combobox', { name: '버전', exact: true }).selectOption(room.version.id)
  await expect(page.getByText('읽기 전용인 버전을 보고 있어요. 검수 중인 최신 버전으로 돌아오면 남길 수 있어요.', { exact: true })).toBeVisible()
  await expect(page.getByLabel('제목 (필수)', { exact: true })).toHaveValue('버전을 둘러보며 쓰는 제목')
  await expect(page.getByLabel('내용', { exact: true })).toHaveValue('버전을 둘러보며 쓰는 내용')
  await expect(page.getByRole('button', { name: '쪽지 남기기', exact: true })).toHaveCount(0)
  await expect(page.getByRole('img', { name: '새 쪽지 위치', exact: true })).toHaveCount(0)
  await page.getByRole('combobox', { name: '버전', exact: true }).selectOption(latest.id)
  await expect(page.getByRole('button', { name: '쪽지 남기기', exact: true })).toBeVisible()
  await expect(page.getByRole('img', { name: '새 쪽지 위치', exact: true })).toHaveCount(0)
  const issue = await (await submit(page, '쪽지 남기기', `/api/projects/${room.project.id}/issues`)).json()
  expect(await db.issue.findUniqueOrThrow({ where: { id: issue.id } })).toMatchObject({
    title: '버전을 둘러보며 쓰는 제목', body: '버전을 둘러보며 쓰는 내용',
    originVersionId: latest.id, originVersionScreenId: null, xRatio: null, yRatio: null,
  })
})

test('최신 버전 불러오기에 실패하면 쓰던 글과 핀이 남고 다시 눌러 최신 버전으로 갈 수 있다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  await loginAs(room.client.id)
  await page.goto(`/app/projects/${room.project.id}`)
  await clickPhoto(page)
  await fillIssue(page, '불러오기 실패에도 남을 제목', '불러오기 실패에도 남을 내용')
  const latest = await publishVersion(room.project.id, [room.main.id, room.product.id], 1)
  await submit(page, '쪽지 남기기', `/api/projects/${room.project.id}/issues`, 409)
  const projectPath = `/api/projects/${room.project.id}`
  await page.route(`**${projectPath}`, (route) => route.abort('failed'))
  const failed = page.waitForEvent('requestfailed', (request) => new URL(request.url()).pathname === projectPath)
  await page.getByRole('button', { name: '최신 버전 보기', exact: true }).click()
  await failed
  await expect(page.getByRole('combobox', { name: '버전', exact: true })).toHaveValue(room.version.id)
  await expect(page.getByLabel('제목 (필수)', { exact: true })).toHaveValue('불러오기 실패에도 남을 제목')
  await expect(page.getByLabel('내용', { exact: true })).toHaveValue('불러오기 실패에도 남을 내용')
  await expectPinPosition(await loadedPhoto(page), page.getByRole('img', { name: '새 쪽지 위치', exact: true }), 0.3, 0.4)
  await page.unroute(`**${projectPath}`)
  await page.getByRole('button', { name: '최신 버전 보기', exact: true }).click()
  await expect(page.getByRole('combobox', { name: '버전', exact: true })).toHaveValue(latest.id)
  await expect(page.getByLabel('제목 (필수)', { exact: true })).toHaveValue('불러오기 실패에도 남을 제목')
  await expect(page.getByLabel('내용', { exact: true })).toHaveValue('불러오기 실패에도 남을 내용')
  await expect(page.getByRole('img', { name: '새 쪽지 위치', exact: true })).toHaveCount(0)
})

test('잠긴 쪽지와 댓글을 취소한 뒤 새 글은 새 요청 번호로 저장한다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  await loginAs(room.client.id)
  await page.goto(`/app/projects/${room.project.id}`)
  await clickPhoto(page)
  await fillIssue(page, '취소할 쪽지', '응답만 놓친 내용')
  const issuePath = `/api/projects/${room.project.id}/issues`
  await page.route(`**${issuePath}`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    expect((await route.fetch()).status()).toBe(201)
    await route.abort('failed')
  })
  await page.getByRole('button', { name: '쪽지 남기기', exact: true }).click()
  await expectLockedIssue(page, '취소할 쪽지', '응답만 놓친 내용')
  const firstIssue = await db.issue.findFirstOrThrow({ where: { projectId: room.project.id } })
  await page.unroute(`**${issuePath}`)
  await page.getByRole('button', { name: '취소', exact: true }).click()
  await expect(page.getByLabel('제목 (필수)', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('img', { name: '새 쪽지 위치', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '쪽지 쓰기', exact: true }).click()
  await expect(page.getByLabel('제목 (필수)', { exact: true })).toHaveValue('')
  await fillIssue(page, '취소 뒤 새 쪽지', '새 내용')
  const second = await (await submit(page, '쪽지 남기기', issuePath)).json()
  const secondIssue = await db.issue.findUniqueOrThrow({ where: { id: second.id } })
  expect(secondIssue.requestId).not.toBe(firstIssue.requestId)
  expect(secondIssue.title).toBe('취소 뒤 새 쪽지')

  const commentPath = `/api/issues/${second.id}/comments`
  await page.getByRole('textbox', { name: '댓글', exact: true }).fill('취소할 댓글')
  await page.route(`**${commentPath}`, async (route) => {
    expect((await route.fetch()).status()).toBe(201)
    await route.abort('failed')
  })
  await page.getByRole('button', { name: '댓글 남기기', exact: true }).click()
  await expect(page.getByRole('button', { name: '다시 보내기', exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: '댓글', exact: true })).toHaveJSProperty('readOnly', true)
  const firstComment = await db.comment.findFirstOrThrow({ where: { issueId: second.id } })
  await page.unroute(`**${commentPath}`)
  await page.getByRole('button', { name: '취소', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '댓글', exact: true })).toBeEditable()
  await expect(page.getByRole('button', { name: '다시 보내기', exact: true })).toHaveCount(0)
  await page.getByRole('textbox', { name: '댓글', exact: true }).fill('취소 뒤 새 댓글')
  await submit(page, '댓글 남기기', commentPath)
  const comments = await db.comment.findMany({ where: { issueId: second.id }, orderBy: { createdAt: 'asc' } })
  expect(comments).toHaveLength(2)
  expect(comments[1].requestId).not.toBe(firstComment.requestId)
  expect(comments.map((comment) => comment.body)).toEqual(['취소할 댓글', '취소 뒤 새 댓글'])
  await expect(page.getByRole('region', { name: '댓글', exact: true })).toContainText('댓글 2개')
})

test('댓글을 쓰다가 사진을 누르면 확인 창이 뜨고 취소하면 쓰던 댓글이 남으며 확인하면 새 쪽지 쓰기로 넘어간다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  await loginAs(room.client.id)
  await page.goto(`/app/projects/${room.project.id}?issue=${issue.id}`)
  const detail = page.getByRole('article', { name: '쪽지 #1', exact: true })
  const comment = page.getByRole('textbox', { name: '댓글', exact: true })
  await expect(detail).toBeVisible()
  await comment.fill('아직 저장하지 않은 댓글')
  const address = page.url()

  await Promise.all([
    page.waitForEvent('dialog').then(async (dialog) => {
      expect(dialog.type()).toBe('confirm')
      expect(dialog.message()).toBe('쓰던 글이 사라져요. 새 쪽지를 쓸까요?')
      await dialog.dismiss()
    }),
    clickPhoto(page, 0.65, 0.65),
  ])
  await expect(detail).toBeVisible()
  await expect(detail.getByRole('heading', { name: issue.title, exact: true })).toBeVisible()
  await expect(comment).toHaveValue('아직 저장하지 않은 댓글')
  await expect(page).toHaveURL(address)
  await expect(page.getByLabel('제목 (필수)', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('img', { name: '새 쪽지 위치', exact: true })).toHaveCount(0)

  await Promise.all([
    page.waitForEvent('dialog').then(async (dialog) => {
      expect(dialog.type()).toBe('confirm')
      expect(dialog.message()).toBe('쓰던 글이 사라져요. 새 쪽지를 쓸까요?')
      await dialog.accept()
    }),
    clickPhoto(page, 0.65, 0.65),
  ])
  await expect(page.getByLabel('제목 (필수)', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '쪽지 남기기', exact: true })).toBeVisible()
  await expect(page.getByRole('img', { name: '새 쪽지 위치', exact: true })).toBeVisible()
  await expect(detail).toHaveCount(0)
  expect(new URL(page.url()).searchParams.has('issue')).toBe(false)
})

test('버전 사진을 불러오지 못하면 열어 둔 쪽지에 읽기 전용 대신 아직 불러오지 못했다는 안내가 보이고 다시 시도하면 댓글을 쓸 수 있다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  await loginAs(room.client.id)
  const versionPath = `/api/versions/${room.version.id}`
  await page.route(`**${versionPath}`, (route) => route.fulfill({ status: 500, json: { message: 'test failure' } }), { times: 1 })
  await page.goto(`/app/projects/${room.project.id}?issue=${issue.id}`)

  const detail = page.getByRole('article', { name: '쪽지 #1', exact: true })
  const waiting = detail.getByText('아직 사진을 불러오지 못했어요. 지금은 쪽지와 댓글을 바꿀 수 없어요.', { exact: true })
  await expect(detail).toBeVisible()
  await expect(waiting).toBeVisible()
  await expect(page.getByText('잠시 뒤 다시 시도해 주세요', { exact: true })).toBeVisible()
  await expect(detail.getByText(/읽기 전용/)).toHaveCount(0)
  await expect(detail.getByRole('textbox', { name: '댓글', exact: true })).toHaveCount(0)
  await expect(detail.getByRole('button', { name: '댓글 남기기', exact: true })).toHaveCount(0)
  await expect(detail.getByLabel('참고 사진 붙이기', { exact: true })).toHaveCount(0)

  const retried = page.waitForResponse((response) => new URL(response.url()).pathname === versionPath)
  await page.getByRole('button', { name: '다시 시도', exact: true }).click()
  expect((await retried).status()).toBe(200)
  await loadedPhoto(page)
  await expect(waiting).toHaveCount(0)
  await expect(detail.getByText(/읽기 전용/)).toHaveCount(0)
  await detail.getByRole('textbox', { name: '댓글', exact: true }).fill('사진을 다시 불러온 뒤 남긴 댓글')
  await submit(page, '댓글 남기기', `/api/issues/${issue.id}/comments`)
  await expect(detail.getByText('사진을 다시 불러온 뒤 남긴 댓글', { exact: true })).toBeVisible()
  expect(await db.comment.count({ where: { issueId: issue.id, body: '사진을 다시 불러온 뒤 남긴 댓글' } })).toBe(1)
})

test('쪽지를 여는 동안 불러오는 중 표시가 보이고 내용이 오면 사라진다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  await loginAs(room.client.id)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.goto(`/app/projects/${room.project.id}`)
  await loadedPhoto(page)
  const panel = page.getByRole('complementary', { name: '쪽지', exact: true })
  await expect(panel.getByRole('status')).toHaveCount(0)

  let release!: () => void
  const responseGate = new Promise<void>((resolve) => { release = resolve })
  await page.route(`**/api/issues/${issue.id}`, async (route) => {
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    await responseGate
    await route.fulfill({ response })
  }, { times: 1 })
  try {
    await page.getByRole('region', { name: '쪽지 목록', exact: true }).getByRole('button', { name: new RegExp(issue.title) }).click()
    const loading = panel.getByRole('status')
    await expect(loading).toBeVisible()
    await expect(loading).toHaveText('쪽지를 불러오는 중이에요')
    await expect(panel.getByRole('article')).toHaveCount(0)
    // 장식은 읽어 주지 않고, 움직임 줄이기를 켜도 안내 글은 남긴다.
    const spinner = loading.locator('[aria-hidden="true"]')
    await expect(spinner).toHaveCount(1)
    await expect(spinner).not.toHaveCSS('animation-name', 'none')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect(spinner).toHaveCSS('animation-name', 'none')
    await expect(loading).toBeVisible()
    await expect(loading).toHaveText('쪽지를 불러오는 중이에요')

    release()
    const detail = panel.getByRole('article', { name: '쪽지 #1', exact: true })
    await expect(detail).toBeVisible()
    await expect(detail.getByRole('heading', { name: issue.title, exact: true })).toBeVisible()
    await expect(panel.getByRole('status')).toHaveCount(0)
    await expect(panel.getByText('쪽지를 불러오는 중이에요', { exact: true })).toHaveCount(0)
  } finally {
    release()
  }
})

test('휴대폰 화면에서 쪽지를 열면 목록이 숨고 쪽지를 닫으면 목록이 돌아온다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  await loginAs(room.client.id)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/app/projects/${room.project.id}`)
  await loadedPhoto(page)
  // 목록은 CSS로만 숨겨야 한다. 접근성 조회에서도 숨은 요소를 포함해 실제 존재와 표시 여부를 따로 확인한다.
  const list = page.getByRole('region', { name: '쪽지 목록', exact: true, includeHidden: true })
  const detail = page.getByRole('article', { name: '쪽지 #1', exact: true })
  await expect(list).toBeVisible()
  await list.getByRole('button', { name: new RegExp(issue.title) }).click()
  await expect(detail).toBeVisible()
  await expect(list).toHaveCount(1)
  await expect(list).toBeHidden()

  await page.setViewportSize({ width: 768, height: 844 })
  await expect(detail).toBeVisible()
  await expect(list).toBeHidden()
  await page.setViewportSize({ width: 769, height: 844 })
  await expect(detail).toBeVisible()
  await expect(list).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(list).toBeHidden()
  await detail.getByRole('button', { name: '쪽지 닫기', exact: true }).click()
  await expect(detail).toHaveCount(0)
  await expect(list).toBeVisible()
  expect(new URL(page.url()).searchParams.has('issue')).toBe(false)

  await page.setViewportSize({ width: 1280, height: 900 })
  await list.getByRole('button', { name: new RegExp(issue.title) }).click()
  await expect(detail).toBeVisible()
  await expect(list).toBeVisible()
  await expect(detail.getByRole('heading', { name: issue.title, exact: true })).toBeVisible()
  await detail.getByRole('button', { name: '쪽지 닫기', exact: true }).click()
  await expect(list).toBeVisible()
})

test('쪽지 상세 응답이 15초보다 늦어도 그사이 다시 부르지 않고 응답이 오면 쪽지가 열린다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  await loginAs(room.client.id)
  await page.clock.install()
  await page.goto(`/app/projects/${room.project.id}`)
  await loadedPhoto(page)
  const detailPath = `/api/issues/${issue.id}`
  const listPath = `/api/projects/${room.project.id}/issues`
  let detailRequests = 0
  page.on('request', (request) => {
    if (request.method() === 'GET' && new URL(request.url()).pathname === detailPath) detailRequests += 1
  })
  let release!: () => void
  const responseGate = new Promise<void>((resolve) => { release = resolve })
  let received!: () => void
  const serverResponded = new Promise<void>((resolve) => { received = resolve })
  await page.route(`**${detailPath}`, async (route) => {
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    received()
    await responseGate
    await route.fulfill({ response })
  }, { times: 1 })
  try {
    await page.getByRole('region', { name: '쪽지 목록', exact: true }).getByRole('button', { name: new RegExp(issue.title) }).click()
    await serverResponded
    const panel = page.getByRole('complementary', { name: '쪽지', exact: true })
    for (let tick = 0; tick < 2; tick += 1) {
      const listResponse = page.waitForResponse((response) => new URL(response.url()).pathname === listPath)
      await page.clock.fastForward(15_000)
      expect((await listResponse).status()).toBe(200)
      await expect(panel.getByRole('status')).toHaveText('쪽지를 불러오는 중이에요')
      await expect(panel.getByRole('article')).toHaveCount(0)
      expect(detailRequests).toBe(1)
    }
    release()
    const detail = panel.getByRole('article', { name: '쪽지 #1', exact: true })
    await expect(detail).toBeVisible()
    await expect(detail.getByRole('heading', { name: issue.title, exact: true })).toBeVisible()
    await expect(detail).toContainText(issue.body)
    await expect(panel.getByRole('status')).toHaveCount(0)
    expect(detailRequests).toBe(1)
  } finally {
    release()
  }
})

test('쪽지 목록 새로 부르기 응답이 15초보다 늦어도 그사이 다시 부르지 않고 응답이 오면 다른 사람의 쪽지가 보인다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  await loginAs(room.client.id)
  await page.clock.install()
  const listPath = `/api/projects/${room.project.id}/issues`
  const detailPath = `/api/issues/${issue.id}`
  let listRequests = 0
  page.on('request', (request) => {
    if (request.method() === 'GET' && new URL(request.url()).pathname === listPath) listRequests += 1
  })
  await page.goto(`/app/projects/${room.project.id}?issue=${issue.id}`)
  const comment = page.getByRole('textbox', { name: '댓글', exact: true })
  await comment.fill('목록을 기다리며 쓰던 댓글')
  // 개발 서버는 StrictMode라 처음 불러오기가 두 번 간다. 그래서 횟수는 처음 불러오기가 끝난 지금을 기준으로 센다.
  const loaded = listRequests
  const other = await seedIssue(room, '느린 목록에 담긴 새 쪽지', room.developer.id, false)
  let release!: () => void
  const responseGate = new Promise<void>((resolve) => { release = resolve })
  let received!: () => void
  const serverResponded = new Promise<void>((resolve) => { received = resolve })
  await page.route(`**${listPath}`, async (route) => {
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    received()
    await responseGate
    await route.fulfill({ response })
  }, { times: 1 })
  try {
    const firstDetail = page.waitForResponse((response) => new URL(response.url()).pathname === detailPath)
    await page.clock.fastForward(15_000)
    await serverResponded
    expect((await firstDetail).status()).toBe(200)
    expect(listRequests).toBe(loaded + 1)
    const nextDetail = page.waitForResponse((response) => new URL(response.url()).pathname === detailPath)
    await page.clock.fastForward(15_000)
    expect((await nextDetail).status()).toBe(200)
    const list = page.getByRole('region', { name: '쪽지 목록', exact: true })
    await expect(list.getByText(other.title, { exact: true })).toHaveCount(0)
    expect(listRequests).toBe(loaded + 1)
    await expect(comment).toHaveValue('목록을 기다리며 쓰던 댓글')

    release()
    await expect(list.getByText(other.title, { exact: true })).toBeVisible()
    expect(listRequests).toBe(loaded + 1)
    const nextList = page.waitForResponse((response) => new URL(response.url()).pathname === listPath)
    await page.clock.fastForward(15_000)
    expect((await nextList).status()).toBe(200)
    expect(listRequests).toBe(loaded + 2)
    await expect(list.getByText(other.title, { exact: true })).toBeVisible()
    await expect(comment).toHaveValue('목록을 기다리며 쓰던 댓글')
    await expect(page).toHaveURL((url) => url.searchParams.get('issue') === issue.id)
  } finally {
    release()
  }
})

test('댓글 응답을 기다리는 사이 다른 쪽지를 열어 쓰던 댓글은 늦은 응답이 와도 그대로 남는다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const first = await seedIssue(room, '댓글을 보낼 A 쪽지')
  const second = await seedIssue(room, '계속 작성할 B 쪽지')
  await loginAs(room.client.id)
  await page.clock.install()
  await page.goto(`/app/projects/${room.project.id}?issue=${first.id}`)
  await page.getByRole('textbox', { name: '댓글', exact: true }).fill('A에 저장된 댓글')
  const commentPath = `/api/issues/${first.id}/comments`
  const listPath = `/api/projects/${room.project.id}/issues`
  const detailRequests: string[] = []
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (request.method() === 'GET' && /^\/api\/issues\/[^/]+$/.test(path)) detailRequests.push(path)
  })
  let release!: () => void
  const responseGate = new Promise<void>((resolve) => { release = resolve })
  let received!: () => void
  const serverResponded = new Promise<void>((resolve) => { received = resolve })
  await page.route(`**${commentPath}`, async (route) => {
    const response = await route.fetch()
    expect(response.status()).toBe(201)
    received()
    await responseGate
    await route.fulfill({ response })
  }, { times: 1 })
  try {
    await page.getByRole('button', { name: '댓글 남기기', exact: true }).click()
    await serverResponded
    await page.getByRole('region', { name: '쪽지 목록', exact: true }).getByRole('button', { name: new RegExp(second.title) }).click()
    const detail = page.getByRole('article', { name: '쪽지 #2', exact: true })
    const comment = detail.getByRole('textbox', { name: '댓글', exact: true })
    await comment.fill('B에 아직 보내지 않은 댓글')
    expect(detailRequests).toEqual([`/api/issues/${second.id}`])
    const refreshedList = page.waitForResponse((response) => new URL(response.url()).pathname === listPath)
    release()
    expect((await refreshedList).status()).toBe(200)
    await expect(detail.getByRole('heading', { name: second.title, exact: true })).toBeVisible()
    await expect(comment).toHaveValue('B에 아직 보내지 않은 댓글')
    await expect(page).toHaveURL((url) => url.searchParams.get('issue') === second.id)
    expect(detailRequests).toEqual([`/api/issues/${second.id}`])
    expect(await db.comment.count({ where: { issueId: first.id, body: 'A에 저장된 댓글' } })).toBe(1)
    expect(await db.comment.count({ where: { issueId: second.id } })).toBe(0)

    const nextDetail = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/issues/${second.id}`)
    await page.clock.fastForward(15_000)
    expect((await nextDetail).status()).toBe(200)
    await expect(comment).toHaveValue('B에 아직 보내지 않은 댓글')
    expect(detailRequests).toEqual([`/api/issues/${second.id}`, `/api/issues/${second.id}`])
  } finally {
    release()
  }
})

test('댓글이 저장된 뒤 쪽지 다시 부르기가 실패해도 저장된 댓글이 보이고 입력칸이 비워진다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  await loginAs(room.client.id)
  await page.clock.install()
  await page.goto(`/app/projects/${room.project.id}?issue=${issue.id}`)
  const detail = page.getByRole('article', { name: '쪽지 #1', exact: true })
  const comment = detail.getByRole('textbox', { name: '댓글', exact: true })
  const body = '다시 불러오기가 실패해도 보일 댓글'
  await comment.fill(body)
  const detailPath = `/api/issues/${issue.id}`
  await page.route(`**${detailPath}`, (route) => route.fulfill({ status: 500, json: { message: 'test failure' } }), { times: 1 })
  const refresh = page.waitForResponse((response) => new URL(response.url()).pathname === detailPath)
  await submit(page, '댓글 남기기', `/api/issues/${issue.id}/comments`)
  expect((await refresh).status()).toBe(500)
  await expect(detail.getByRole('heading', { name: issue.title, exact: true })).toBeVisible()
  await expect(detail.getByText(body, { exact: true })).toBeVisible()
  await expect(detail.getByText(body, { exact: true })).toHaveCount(1)
  await expect(comment).toHaveValue('')
  await expect(comment).toBeEditable()
  await expect(page.getByText('잠시 뒤 다시 시도해 주세요', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '다시 보내기', exact: true })).toHaveCount(0)
  expect(await db.comment.count({ where: { issueId: issue.id, body } })).toBe(1)

  const recovered = page.waitForResponse((response) => new URL(response.url()).pathname === detailPath)
  await page.clock.fastForward(15_000)
  expect((await recovered).status()).toBe(200)
  await expect(detail.getByText(body, { exact: true })).toHaveCount(1)
  await expect(comment).toHaveValue('')
})

test('쪽지 상세 응답이 1분이 되도록 없으면 다시 불러 쪽지를 열고 늦게 온 앞 응답은 버린다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  await loginAs(room.client.id)
  // 실제 실행 시간이 섞이지 않게 멈춰 두고, 요청 시작부터 정확히 45초·60초를 넘긴다.
  await page.clock.install({ time: new Date('2026-11-12T00:00:00Z') })
  await page.clock.pauseAt(new Date('2026-11-12T00:00:01Z'))
  const detailPath = `/api/issues/${issue.id}`
  const listPath = `/api/projects/${room.project.id}/issues`
  let detailRequests = 0
  page.on('request', (request) => {
    if (request.method() === 'GET' && new URL(request.url()).pathname === detailPath) detailRequests += 1
  })
  await page.goto(`/app/projects/${room.project.id}`)
  await loadedPhoto(page)
  const loaded = detailRequests
  const staleTitle = '늦게 도착한 다른 쪽지 제목'
  let holdResponses = true
  const heldRequests: Request[] = []
  let release!: () => void
  const responseGate = new Promise<void>((resolve) => { release = resolve })
  let received!: () => void
  const serverResponded = new Promise<void>((resolve) => { received = resolve })
  await page.route(`**${detailPath}`, async (route) => {
    // StrictMode로 처음 상세 요청이 두 번 가도, 재요청을 허용하기 전에 시작한 것은 모두 붙잡는다.
    if (!holdResponses) return route.continue()
    heldRequests.push(route.request())
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    const staleDetail = { ...await response.json(), title: staleTitle }
    received()
    await responseGate
    await route.fulfill({ response, json: staleDetail })
  })
  try {
    await page.getByRole('region', { name: '쪽지 목록', exact: true }).getByRole('button', { name: new RegExp(issue.title) }).click()
    await serverResponded
    const panel = page.getByRole('complementary', { name: '쪽지', exact: true })
    await expect(panel.getByRole('status')).toHaveText('쪽지를 불러오는 중이에요')
    const waiting = detailRequests
    expect(waiting).toBeGreaterThan(loaded)
    for (let tick = 0; tick < 3; tick += 1) {
      const listResponse = page.waitForResponse((response) => new URL(response.url()).pathname === listPath)
      await page.clock.fastForward(15_000)
      expect((await listResponse).status()).toBe(200)
      expect(detailRequests).toBe(waiting)
      await expect(panel.getByRole('status')).toHaveText('쪽지를 불러오는 중이에요')
      await expect(panel.getByRole('article')).toHaveCount(0)
    }

    holdResponses = false
    const recovered = page.waitForResponse((response) => new URL(response.url()).pathname === detailPath)
    await page.clock.fastForward(15_000)
    expect((await recovered).status()).toBe(200)
    const detail = panel.getByRole('article', { name: '쪽지 #1', exact: true })
    await expect(detail.getByRole('heading', { name: issue.title, exact: true })).toBeVisible()
    await expect(detail).toContainText(issue.body)
    await expect(panel.getByRole('status')).toHaveCount(0)
    expect(detailRequests).toBe(waiting + 1)

    const lateResponses = Promise.all(heldRequests.map((request) =>
      page.waitForResponse((response) => response.request() === request),
    ))
    release()
    for (const response of await lateResponses) {
      await response.finished()
      expect(await response.json()).toMatchObject({ title: staleTitle })
    }
    // 늦은 응답 본문을 받은 뒤 화면에 반영할 시간도 준다. 다음 15초 갱신은 아직 오지 않는다.
    await page.clock.runFor(100)
    await expect(detail.getByRole('heading', { name: issue.title, exact: true })).toBeVisible()
    await expect(detail).toContainText(issue.body)
    await expect(panel.getByText(staleTitle, { exact: true })).toHaveCount(0)
    await expect(panel.getByRole('status')).toHaveCount(0)
    await expect(page).toHaveURL((url) => url.searchParams.get('issue') === issue.id)
    expect(detailRequests).toBe(waiting + 1)
  } finally {
    release()
  }
})

test('쪽지 목록 새로 부르기 응답이 1분이 되도록 없으면 다시 불러 새 쪽지를 보여 주고 늦게 온 앞 응답은 버린다', async ({ page, loginAs }) => {
  const room = await prepareRoom()
  const issue = await seedIssue(room)
  await loginAs(room.client.id)
  await page.clock.install({ time: new Date('2026-11-12T00:00:00Z') })
  await page.clock.pauseAt(new Date('2026-11-12T00:00:01Z'))
  const listPath = `/api/projects/${room.project.id}/issues`
  const detailPath = `/api/issues/${issue.id}`
  let listRequests = 0
  page.on('request', (request) => {
    if (request.method() === 'GET' && new URL(request.url()).pathname === listPath) listRequests += 1
  })
  await page.goto(`/app/projects/${room.project.id}?issue=${issue.id}`)
  const detail = page.getByRole('article', { name: '쪽지 #1', exact: true })
  const comment = detail.getByRole('textbox', { name: '댓글', exact: true })
  await comment.fill('멈춘 목록을 기다리며 쓰던 댓글')
  // 처음 불러오기의 StrictMode 중복 요청은 세지 않는다.
  const loaded = listRequests
  let holdResponses = true
  const heldRequests: Request[] = []
  let release!: () => void
  const responseGate = new Promise<void>((resolve) => { release = resolve })
  let received!: () => void
  const serverResponded = new Promise<void>((resolve) => { received = resolve })
  await page.route(`**${listPath}`, async (route) => {
    if (!holdResponses) return route.continue()
    heldRequests.push(route.request())
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    received()
    await responseGate
    await route.fulfill({ response })
  })
  try {
    const firstDetail = page.waitForResponse((response) => new URL(response.url()).pathname === detailPath)
    await page.clock.fastForward(15_000)
    await serverResponded
    expect((await firstDetail).status()).toBe(200)
    expect(listRequests).toBe(loaded + 1)
    // 앞 응답이 새 쪽지를 담지 않도록 서버 응답을 먼저 받아 둔 뒤 추가한다.
    const other = await seedIssue(room, '연결이 돌아온 뒤 보일 새 쪽지', room.developer.id, false)
    const list = page.getByRole('region', { name: '쪽지 목록', exact: true })
    for (let tick = 0; tick < 3; tick += 1) {
      const nextDetail = page.waitForResponse((response) => new URL(response.url()).pathname === detailPath)
      await page.clock.fastForward(15_000)
      expect((await nextDetail).status()).toBe(200)
      expect(listRequests).toBe(loaded + 1)
      await expect(list.getByText(other.title, { exact: true })).toHaveCount(0)
      await expect(detail.getByRole('heading', { name: issue.title, exact: true })).toBeVisible()
      await expect(comment).toHaveValue('멈춘 목록을 기다리며 쓰던 댓글')
    }

    // 첫 목록 갱신은 입장 15초 뒤 시작했다. 그 요청부터 60초(입장부터 75초)에 다시 부른다.
    holdResponses = false
    const recovered = page.waitForResponse((response) => new URL(response.url()).pathname === listPath)
    await page.clock.fastForward(15_000)
    expect((await recovered).status()).toBe(200)
    await expect(list.getByText(other.title, { exact: true })).toBeVisible()
    expect(listRequests).toBe(loaded + 2)
    await expect(comment).toHaveValue('멈춘 목록을 기다리며 쓰던 댓글')

    const lateResponses = Promise.all(heldRequests.map((request) =>
      page.waitForResponse((response) => response.request() === request),
    ))
    release()
    for (const response of await lateResponses) {
      await response.finished()
      expect(await response.json()).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: other.id })]))
    }
    await page.clock.runFor(100)
    await expect(list.getByText(other.title, { exact: true })).toBeVisible()
    await expect(detail.getByRole('heading', { name: issue.title, exact: true })).toBeVisible()
    await expect(comment).toHaveValue('멈춘 목록을 기다리며 쓰던 댓글')
    await expect(comment).toBeEditable()
    await expect(page).toHaveURL((url) => url.searchParams.get('issue') === issue.id)
    expect(listRequests).toBe(loaded + 2)
  } finally {
    release()
  }
})
