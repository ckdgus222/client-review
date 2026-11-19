import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import type { Response } from '@playwright/test'
import { test, expect, db, resetDatabase, createUser, createProject, KNOWN_LOGIN_CODE, useKnownLoginCode } from './fixtures.ts'

const sharp = createRequire(new URL('../../api/package.json', import.meta.url))('sharp')

const publishVersion = async (projectId: string, screenIds: string[], number: number) => {
  const version = await db.deliveryVersion.create({
    data: { projectId, number, status: 'IN_REVIEW', publishedAt: new Date() },
  })
  const screens = []
  await mkdir(new URL(`../.assets/${projectId}/`, import.meta.url), { recursive: true })
  for (const screenId of screenIds) {
    const storageKey = `${projectId}/${randomUUID()}.png`
    const photo: Buffer = await sharp({
      create: { width: 1200, height: 800, channels: 3, background: '#ffffff' },
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

// 쪽지 생성은 분리해 빈 검수실과 상태가 섞인 검수실에서 같은 사진·참여자를 쓸 수 있게 한다.
const prepareRoom = async () => {
  const developer = await createUser('developer@example.com', '개발자')
  const client = await createUser('client@example.com', '클라이언트')
  const project = await createProject(developer.id, 'UI 검수 프로젝트')
  const clientMember = await db.projectMember.create({
    data: { projectId: project.id, userId: client.id, role: 'CLIENT' },
  })
  await db.project.update({ where: { id: project.id }, data: { approverMemberId: clientMember.id } })
  const main = await db.screen.create({ data: { projectId: project.id, name: '메인', viewport: 'PC' } })
  const version = await publishVersion(project.id, [main.id], 0)
  return { developer, client, project, main, version }
}

const issueStates = [
  { status: 'OPEN', label: '접수' },
  { status: 'IN_PROGRESS', label: '수정 중' },
  { status: 'READY_FOR_REVIEW', label: '확인 요청' },
  { status: 'VERIFIED', label: '확인 완료' },
  { status: 'WITHDRAWN', label: '철회' },
] as const

const seedIssue = async (
  room: Awaited<ReturnType<typeof prepareRoom>>,
  status: typeof issueStates[number]['status'] = 'OPEN',
) => db.issue.create({
  data: {
    projectId: room.project.id,
    originVersionId: room.version.id,
    originVersionScreenId: room.version.screens[0].id,
    xRatio: 0.3,
    yRatio: 0.4,
    authorId: room.client.id,
    number: await db.issue.count({ where: { projectId: room.project.id } }) + 1,
    title: `${status} 상태 쪽지`,
    body: '화면의 여백을 확인해 주세요.',
    status,
    requestId: randomUUID(),
  },
})

test('클라이언트의 프로젝트 목록에는 생성 폼과 삭제 대기 탐색이 없다', async ({ page, loginAs }) => {
  await resetDatabase()
  const developer = await createUser('developer@example.com', '개발자')
  const client = await createUser('client@example.com', '목록 확인 고객')
  const active = await createProject(developer.id, '진행하는 웹사이트')
  const archived = await createProject(developer.id, '보관한 웹사이트')
  const deleted = await createProject(developer.id, '삭제 대기 웹사이트')
  await db.projectMember.createMany({
    data: [active, archived, deleted].map(({ id }) => ({ projectId: id, userId: client.id, role: 'CLIENT' })),
  })
  const activeCreatedAt = new Date('2026-11-01T03:00:00.000Z')
  const archivedCreatedAt = new Date('2026-10-15T03:00:00.000Z')
  await db.$transaction([
    db.project.update({ where: { id: active.id }, data: { createdAt: activeCreatedAt } }),
    db.project.update({
      where: { id: archived.id },
      data: { status: 'ARCHIVED', createdAt: archivedCreatedAt },
    }),
    db.project.update({
      where: { id: deleted.id },
      data: { status: 'DELETE_PENDING', statusBeforeDelete: 'ACTIVE', deleteRequestedAt: new Date() },
    }),
  ])
  await loginAs(client.id)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/app/')

  const heading = page.getByRole('heading', { level: 1, name: '내 프로젝트', exact: true })
  const menu = page.getByRole('navigation', { name: '프로젝트 메뉴', exact: true, includeHidden: true })
  const groups = [
    { project: active, title: '진행 중', createdAt: activeCreatedAt, date: '2026. 11. 1.' },
    { project: archived, title: '보관함', createdAt: archivedCreatedAt, date: '2026. 10. 15.' },
  ]
  await expect(heading).toBeVisible()
  await expect(page.getByText('목록 확인 고객님', { exact: true })).toBeVisible()
  await expect(page.getByText('참여하고 있는 프로젝트 2개', { exact: true })).toBeVisible()
  await page.evaluate(() => document.fonts.ready.then(() => undefined))

  for (const width of [1440, 960, 959, 390]) {
    await page.setViewportSize({ width, height: 900 })
    await page.evaluate(() => window.scrollTo(0, 0))
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('link')).toHaveText(['내 프로젝트', '진행 중 1', '보관함 1'])
    const home = menu.getByRole('link', { name: '내 프로젝트', exact: true })
    await expect(home).toHaveAttribute('href', '/app')
    await expect(home).toHaveAttribute('aria-current', 'page')
    await expect(page.locator('form')).toHaveCount(0)
    await expect(page.getByRole('textbox', { name: '프로젝트 이름', exact: true, includeHidden: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '만들기', exact: true, includeHidden: true })).toHaveCount(0)
    await expect(page.getByRole('region', { name: '삭제 대기', exact: true, includeHidden: true })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: '삭제 대기', exact: true, includeHidden: true })).toHaveCount(0)
    await expect(page.getByRole('link', { name: /삭제 대기/, includeHidden: true })).toHaveCount(0)
    await expect(page.getByText(deleted.name, { exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '되살리기', exact: true, includeHidden: true })).toHaveCount(0)

    const menuBox = await menu.boundingBox()
    const headingBox = await heading.boundingBox()
    expect(menuBox).not.toBeNull()
    expect(headingBox).not.toBeNull()
    if (width >= 960) {
      expect(menuBox!.width).toBe(220)
      expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(headingBox!.x)
      expect(menuBox!.y).toBeLessThanOrEqual(headingBox!.y)
      expect(menuBox!.y + menuBox!.height).toBeGreaterThan(headingBox!.y)
    }
    if (width < 960) expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(headingBox!.y)

    for (const { project, title, createdAt, date } of groups) {
      const group = page.getByRole('region', { name: title, exact: true })
      const row = group.getByRole('listitem')
      await expect(group.getByRole('heading', { level: 2, name: title, exact: true })).toBeVisible()
      await expect(row).toHaveCount(1)
      await expect(row.getByText('클라이언트', { exact: true })).toBeVisible()
      await expect(row.getByText('개발자', { exact: true })).toHaveCount(0)
      await expect(row.locator('time')).toHaveAttribute('datetime', createdAt.toISOString())
      await expect(row.locator('time')).toHaveText(date)
      await expect(row.locator('time')).toBeVisible()
      await expect(row.getByText(title, { exact: true })).toBeVisible()
      const projectLink = row.getByRole('link', { name: project.name, exact: true })
      await expect(projectLink).toBeVisible()
      await expect(page.getByRole('link', { name: project.name, exact: true })).toHaveCount(1)
      await expect(projectLink).toHaveAttribute('href', `/app/projects/${project.id}`)
      await projectLink.click({ trial: true })

      const groupLink = menu.getByRole('link', { name: `${title} 1`, exact: true })
      await expect(groupLink).toHaveAttribute('href', `#${await group.getAttribute('id')}`)
      await groupLink.click()
      expect(new URL(page.url()).hash).toBe(`#${await group.getAttribute('id')}`)
      await expect(group.getByRole('heading', { name: title, exact: true })).toBeInViewport()
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
  }

  await page.emulateMedia({ media: 'print' })
  await expect(menu).toBeHidden()
  await expect(page.getByRole('banner', { includeHidden: true })).toBeHidden()
  await expect(heading).toBeVisible()
  await expect(page.getByRole('link', { name: active.name, exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: archived.name, exact: true })).toBeVisible()
  await page.emulateMedia({ media: 'screen' })
  await expect(menu).toBeVisible()

  for (const { project } of groups) {
    await page.getByRole('link', { name: project.name, exact: true }).click()
    await expect(page).toHaveURL(`/app/projects/${project.id}`)
    await expect(page.getByRole('heading', { level: 1, name: project.name, exact: true })).toBeVisible()
    await page.getByRole('link', { name: '프로젝트 목록', exact: true }).click()
    await expect(heading).toBeVisible()
  }
})

test('관리 메뉴는 화면 폭에 맞게 이동하고 권한이 있는 목적지로 연결된다', async ({ page, loginAs }) => {
  await resetDatabase()
  const room = await prepareRoom()
  const projectPath = `/app/projects/${room.project.id}`
  const activityTitle = `${room.project.name} 활동 일지`
  const menu = page.getByRole('navigation', { name: '프로젝트 메뉴', exact: true })
  const destinations = [
    { link: '내 프로젝트', path: '/app', heading: '내 프로젝트', active: '내 프로젝트' },
    { link: room.project.name, path: projectPath, heading: room.project.name },
    { link: '활동 일지', path: `${projectPath}/activity`, heading: activityTitle, active: '활동 일지' },
    { link: '버전 준비', path: `${projectPath}/draft`, heading: room.project.name, active: '버전 준비' },
    { link: '프로젝트 설정', path: `${projectPath}/settings`, heading: room.project.name, active: '프로젝트 설정' },
    { link: '검수실', path: projectPath, heading: room.project.name },
  ]

  await loginAs(room.developer.id)
  // 목록의 전체 폭·390px 검사는 위 사례에서 다루고, 여기서는 실제 이동과 배치 경계를 확인한다.
  for (const width of [960, 959]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(`${projectPath}/activity`)
    await expect(page.getByRole('heading', { level: 1, name: activityTitle, exact: true })).toBeVisible()
    await expect(menu.getByRole('link')).toHaveText(['내 프로젝트', '검수실', '버전 준비', '프로젝트 설정', '활동 일지'])

    for (const destination of destinations) {
      const link = page.getByRole('link', { name: destination.link, exact: true })
      await expect(link).toHaveCount(1)
      await expect(link).toHaveAttribute('href', destination.path)
      await link.click()
      await expect(page).toHaveURL(destination.path)
      const heading = page.getByRole('heading', { level: 1, name: destination.heading, exact: true })
      await expect(heading).toBeVisible()
      if (!destination.active) continue

      await expect(menu).toHaveCount(1)
      await expect(menu).toBeVisible()
      await expect(menu.locator('[aria-current="page"]')).toHaveText(destination.active)
      await page.evaluate(() => document.fonts.ready.then(() => undefined))
      const menuBox = await menu.boundingBox()
      const headingBox = await heading.boundingBox()
      expect(menuBox).not.toBeNull()
      expect(headingBox).not.toBeNull()
      // 넓으면 제목 왼쪽에서 같은 높이를 차지하고, 좁으면 제목 위에 놓인다.
      expect(width >= 960
        ? menuBox!.x + menuBox!.width <= headingBox!.x
          && menuBox!.y <= headingBox!.y
          && menuBox!.y + menuBox!.height > headingBox!.y
        : menuBox!.y + menuBox!.height <= headingBox!.y,
      ).toBe(true)
    }
  }

  await loginAs(room.client.id)
  await page.goto(`${projectPath}/activity`)
  await expect(page.getByRole('heading', { level: 1, name: activityTitle, exact: true })).toBeVisible()
  for (const width of [960, 959]) {
    await page.setViewportSize({ width, height: 900 })
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('link')).toHaveText(['내 프로젝트', '검수실', '활동 일지'])
    await expect(menu.getByRole('link', { name: '활동 일지', exact: true })).toHaveAttribute('aria-current', 'page')
    await expect(page.getByRole('link', { name: '버전 준비', exact: true, includeHidden: true })).toHaveCount(0)
    await expect(page.getByRole('link', { name: '프로젝트 설정', exact: true, includeHidden: true })).toHaveCount(0)
  }
})

test('보관과 삭제 대기 안내가 설정과 검수실 상단에 보인다', async ({ page, baseURL, loginAs }) => {
  await resetDatabase()
  const room = await prepareRoom()
  await loginAs(room.developer.id)
  const projectPath = `/api/projects/${room.project.id}`
  const headers = { Origin: new URL(baseURL!).origin }
  const views = [
    { suffix: '/settings', width: 1440, height: 900 },
    { suffix: '', width: 1440, height: 900 },
    { suffix: '/settings', width: 390, height: 844 },
    { suffix: '', width: 390, height: 844 },
  ]

  for (const { status, action, message } of [
    { status: 'ARCHIVED', action: 'archive', message: '보관한 프로젝트예요. 읽기만 할 수 있어요' },
    { status: 'DELETE_PENDING', action: 'delete', message: '삭제 대기 중인 프로젝트예요. 7일 뒤 완전히 지워져요' },
  ]) {
    const changed = await page.request.post(`${projectPath}/${action}`, {
      headers,
      data: action === 'delete' ? { name: room.project.name } : undefined,
    })
    expect(changed.status()).toBe(204)
    const response = await page.request.get(projectPath)
    expect(response.status()).toBe(200)
    expect(await response.json()).toMatchObject({ id: room.project.id, status, myRole: 'DEVELOPER' })

    for (const { suffix, width, height } of views) {
      await page.setViewportSize({ width, height })
      await page.goto(`/app/projects/${room.project.id}${suffix}`)
      const header = page.getByRole('banner')
      const heading = page.getByRole('heading', { level: 1, name: room.project.name, exact: true })
      const notice = page.getByRole('status').filter({ hasText: message })
      const content = suffix
        ? page.getByRole('heading', { level: 2, name: '화면 이름표', exact: true })
        : page.getByRole('img', { name: '메인 · PC', exact: true })
      await expect(heading).toBeVisible()
      await expect(notice).toHaveCount(1)
      await expect(notice).toHaveText(message)
      await expect(notice).toBeVisible()
      await expect(content).toBeVisible()
      await page.evaluate(() => document.fonts.ready.then(() => undefined))

      // 스크롤이나 자동 스크롤을 일으키는 조작 없이, 헤더·제목 다음에 안내 전체가 보여야 한다.
      expect(await page.evaluate(() => window.scrollY)).toBe(0)
      await expect(notice).toBeInViewport({ ratio: 1 })
      const headerBox = await header.boundingBox()
      const headingBox = await heading.boundingBox()
      const noticeBox = await notice.boundingBox()
      const contentBox = await content.boundingBox()
      expect(headerBox).not.toBeNull()
      expect(headingBox).not.toBeNull()
      expect(noticeBox).not.toBeNull()
      expect(contentBox).not.toBeNull()
      expect(noticeBox!.y).toBeGreaterThanOrEqual(headerBox!.y + headerBox!.height)
      expect(noticeBox!.y).toBeGreaterThanOrEqual(headingBox!.y + headingBox!.height)
      expect(noticeBox!.y + noticeBox!.height).toBeLessThanOrEqual(contentBox!.y)
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    }
  }

  // 삭제 대기 안내를 보려고 클라이언트의 기존 접근 제한을 풀어서는 안 된다.
  await loginAs(room.client.id)
  expect((await page.request.get(projectPath)).status()).toBe(404)
})

test('확인서 인쇄는 흰 종이에 본문만 남긴다', async ({ page, loginAs }) => {
  await resetDatabase()
  const room = await prepareRoom()
  const issue = await seedIssue(room, 'VERIFIED')
  const [approval] = await db.$transaction([
    db.approval.create({
      data: {
        versionId: room.version.id,
        approverId: room.client.id,
        approvedAt: new Date(),
        summary: {
          issues: [{
            number: issue.number,
            title: issue.title,
            category: issue.category,
            scope: issue.scope,
            status: issue.status,
          }],
        },
      },
    }),
    db.deliveryVersion.update({ where: { id: room.version.id }, data: { status: 'APPROVED' } }),
  ])
  await loginAs(room.developer.id)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/app/versions/${room.version.id}/certificate`)

  const heading = page.getByRole('heading', { level: 1, name: '검수 확인서', exact: true })
  const paper = page.getByRole('article').filter({ has: heading })
  const banner = page.getByRole('banner', { includeHidden: true })
  const save = page.getByRole('button', { name: 'PDF로 저장', exact: true, includeHidden: true })
  const back = page.getByRole('link', { name: '검수실로 돌아가기', exact: true, includeHidden: true })
  const toolbar = save.locator('..')
  await expect(heading).toBeVisible()
  await expect(banner).toBeVisible()
  await expect(save).toBeVisible()
  await expect(back).toBeVisible()
  await expect(toolbar).toBeVisible()
  await page.evaluate(() => document.fonts.ready.then(() => undefined))

  await page.emulateMedia({ media: 'print' })

  await expect(banner).toBeHidden()
  await expect(save).toBeHidden()
  await expect(back).toBeHidden()
  await expect(toolbar).toBeHidden()
  await expect(page.getByText("인쇄 창에서 'PDF로 저장'을 고르면 돼요", { exact: true })).toBeHidden()
  await expect(page.getByRole('navigation', { name: '프로젝트 메뉴', includeHidden: true })).toBeHidden()
  await expect(page.locator(
    'button:visible, a[href]:visible, input:visible, select:visible, textarea:visible, '
    + '[role="button"]:visible, [role="link"]:visible, [contenteditable="true"]:visible',
  )).toHaveCount(0)

  for (const surface of [page.locator('body'), paper]) {
    await expect(surface).toBeVisible()
    await expect(surface).toHaveCSS('background-color', 'rgb(255, 255, 255)')
    await expect(surface).toHaveCSS('background-image', 'none')
    await expect(surface).toHaveCSS('box-shadow', 'none')
    await expect(surface).toHaveCSS('opacity', '1')
  }
  await expect(heading).toBeVisible()
  await expect(paper.getByText(`확인서 번호 ${approval.id}`, { exact: true })).toBeVisible()
  await expect(paper.getByRole('definition')).toHaveText([
    room.project.name, '초안', /\d{4}\. \d{1,2}\. \d{1,2}\./, /\d{4}\. \d{1,2}\. \d{1,2}\./,
    room.client.name, room.developer.name,
  ])
  for (const fact of await paper.getByRole('definition').all()) await expect(fact).toBeVisible()
  await expect(paper.getByRole('listitem')).toHaveText(['메인 · PC'])
  await expect(paper.getByRole('row', { name: `#${issue.number} ${issue.title} 버그 확인 완료`, exact: true })).toBeVisible()
  await expect(paper.getByText('확인 완료 1건 · 철회 0건 · 범위 밖(추가 요청) 0건', { exact: true })).toBeVisible()

  // 제목뿐 아니라 날짜·항목 이름·쪽지·하단 안내도 흰 종이에서 4.5:1 이상으로 읽혀야 한다.
  const printedText = paper.locator('h1:visible, h2:visible, p:visible, dt:visible, dd:visible, li:visible, th:visible, td:visible')
  const contrast = await printedText.evaluateAll((elements) => elements.map((element) => {
    const style = getComputedStyle(element)
    const channels = style.color.match(/[\d.]+/g)!.map(Number)
    const [red, green, blue] = channels.slice(0, 3).map((channel) => {
      const value = channel / 255
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    })
    return {
      text: element.textContent,
      ratio: 1.05 / (0.2126 * red + 0.7152 * green + 0.0722 * blue + 0.05),
      alpha: channels[3] ?? 1,
      opacity: style.opacity,
      shadow: style.textShadow,
    }
  }))
  expect(contrast.length).toBeGreaterThan(0)
  for (const text of contrast) {
    expect(text.ratio, text.text ?? '').toBeGreaterThanOrEqual(4.5)
    expect(text.alpha, text.text ?? '').toBe(1)
    expect(text.opacity, text.text ?? '').toBe('1')
    expect(text.shadow, text.text ?? '').toBe('none')
  }
})

test('상태는 글자와 다섯 도형으로 구분되고 키보드 포커스가 보인다', async ({ page, loginAs }) => {
  await resetDatabase()
  const room = await prepareRoom()
  for (const { status } of issueStates) await seedIssue(room, status)
  await loginAs(room.client.id)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/app/projects/${room.project.id}`)
  await expect(page.getByRole('heading', { level: 1, name: room.project.name })).toBeVisible()
  const photo = page.getByRole('img', { name: '메인 · PC', exact: true })
  await expect(photo).toBeVisible()
  await expect.poll(() => photo.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1200)

  const list = page.getByRole('region', { name: '쪽지 목록', exact: true })
  await expect(list.getByRole('listitem')).toHaveCount(5)
  for (const { status, label } of issueStates) {
    const row = list.getByRole('button', { name: new RegExp(`${status} 상태 쪽지`) })
    const badge = row.locator(`[data-status="${status}"]`)
    const dot = badge.locator('[aria-hidden="true"]')
    await expect(row).toBeVisible()
    await expect(badge).toHaveText(label)
    await expect(badge).toHaveCSS('border-radius', '999px')
    await expect(dot).toHaveCount(1)
    await expect(dot).toBeVisible()
    await expect(dot).toHaveCSS('opacity', '1')

    const color = await badge.evaluate((element) => getComputedStyle(element).color)
    await expect(dot).toHaveCSS('border-top-color', color)
    await expect(dot).toHaveCSS('border-top-style', 'solid')
    await expect(dot).toHaveCSS('border-top-width', '1px')
    const shape = await dot.boundingBox()
    expect(shape).not.toBeNull()
    expect(shape!.width).toBeGreaterThan(0)

    if (status === 'WITHDRAWN') {
      // 철회는 사각형 테두리가 아니라 윗변 한 줄만 남아야 한다.
      await expect(dot).toHaveCSS('border-radius', '0px')
      for (const side of ['right', 'bottom', 'left']) await expect(dot).toHaveCSS(`border-${side}-width`, '0px')
      expect(shape!.height).toBe(1)
      expect(shape!.width).toBeGreaterThan(shape!.height)
      await expect(dot).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
      await expect(dot).toHaveCSS('background-image', 'none')
      continue
    }

    expect(shape!.height).toBe(shape!.width)
    await expect(dot).toHaveCSS('border-radius', status === 'VERIFIED' ? '0px' : '50%')
    for (const side of ['right', 'bottom', 'left']) {
      await expect(dot).toHaveCSS(`border-${side}-width`, '1px')
      await expect(dot).toHaveCSS(`border-${side}-style`, 'solid')
    }
    if (status === 'READY_FOR_REVIEW') {
      await expect(dot).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
      await expect(dot).toHaveCSS('background-image', `linear-gradient(to right, ${color} 50%, rgba(0, 0, 0, 0) 50%)`)
      continue
    }
    await expect(dot).toHaveCSS('background-image', 'none')
    await expect(dot).toHaveCSS('background-color', status === 'OPEN' ? 'rgba(0, 0, 0, 0)' : color)
  }

  // 배지는 표시용이다. 실제 조작하는 쓰기 버튼과 쪽지 버튼에 Tab으로 도달해 포커스를 검사한다.
  const compose = list.getByRole('button', { name: '쪽지 쓰기', exact: true })
  const openIssue = list.getByRole('button', { name: /OPEN 상태 쪽지/ })
  for (const target of [compose, openIssue]) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await page.keyboard.press('Tab')
      if (await target.evaluate((element) => element === document.activeElement)) break
    }
    await expect(target).toBeFocused()
    await expect(target).toHaveCSS('outline-style', 'solid')
    await expect(target).toHaveCSS('outline-width', '2px')
    await expect(target).toHaveCSS('outline-offset', '2px')
    await expect(target).toHaveCSS('outline-color', 'rgb(200, 78, 44)')
    expect(await target.evaluate((element) => element.matches(':focus-visible'))).toBe(true)
  }
  await page.keyboard.press('Enter')
  await expect(page.getByRole('article', { name: '쪽지 #1', exact: true })
    .getByRole('heading', { name: 'OPEN 상태 쪽지', exact: true })).toBeVisible()
})

test('로그인은 959px에서 한 칸이고 960px에서 두 칸이다', async ({ page }) => {
  await resetDatabase()
  await page.setViewportSize({ width: 959, height: 844 })
  await page.goto('/app/login')
  const heading = page.getByRole('heading', { level: 1, name: '로그인', exact: true })
  const form = page.locator('form').filter({ has: heading })
  const preview = page.getByRole('complementary', { name: '서비스 소개', includeHidden: true })
  const steps = page.getByRole('group', { name: '로그인 단계', exact: true })
  const email = page.getByRole('textbox', { name: '이메일', exact: true })
  const consent = page.getByRole('checkbox', { name: '개인정보 수집·이용에 동의해요(필수)', exact: true })
  const privacy = page.getByRole('link', { name: '개인정보처리방침 보기', exact: true })
  const code = page.getByRole('textbox', { name: '로그인 코드', exact: true })
  const name = page.getByRole('textbox', { name: '이름', exact: true })
  const back = page.getByRole('button', { name: '이메일 다시 입력', exact: true })
  const legal = page.getByRole('navigation', { name: '약관', exact: true })
  await expect(heading).toBeVisible()
  await page.evaluate(() => document.fonts.ready.then(() => undefined))

  const checkLayout = async (currentStep: string, controls: typeof email[]) => {
    await expect(steps.locator('span')).toHaveText(['1 이메일', '2 코드', '3 이름'])
    await expect(steps.locator('[aria-current]:not([aria-current="false"])')).toHaveCount(1)
    await expect(steps.locator('[aria-current="step"]')).toHaveText([currentStep])

    for (const width of [959, 960, 390]) {
      await page.setViewportSize({ width, height: 844 })
      await page.evaluate(() => window.scrollTo(0, 0))
      await expect(form).toBeVisible()
      await expect(steps).toBeVisible()
      const formBox = await form.boundingBox()
      expect(formBox).not.toBeNull()
      expect(formBox!.x).toBeGreaterThanOrEqual(0)
      expect(formBox!.x + formBox!.width).toBeLessThanOrEqual(width)

      if (width < 960) {
        await expect(preview).toBeHidden()
        expect(Math.abs(formBox!.x + formBox!.width / 2 - width / 2)).toBeLessThanOrEqual(2)
      }
      if (width === 960) {
        await expect(preview).toBeVisible()
        await expect(preview.getByRole('heading', { level: 2 })).toBeVisible()
        const previewBox = await preview.boundingBox()
        expect(previewBox).not.toBeNull()
        expect(previewBox!.x).toBeGreaterThanOrEqual(0)
        expect(previewBox!.width).toBeGreaterThan(0)
        expect(previewBox!.x + previewBox!.width).toBeLessThanOrEqual(formBox!.x)
        // 같은 행에서 소개가 왼쪽, 폼이 오른쪽에 있어야 한다.
        expect(previewBox!.y).toBeLessThan(formBox!.y + formBox!.height)
        expect(formBox!.y).toBeLessThan(previewBox!.y + previewBox!.height)
      }

      for (const control of [
        ...controls,
        legal.getByRole('link', { name: '개인정보처리방침', exact: true }),
        legal.getByRole('link', { name: '이용약관', exact: true }),
      ]) {
        await expect(control).toBeVisible()
        await expect(control).toBeEnabled()
        await control.scrollIntoViewIfNeeded()
        await expect(control).toBeInViewport()
        await control.click({ trial: true })
        await control.focus()
        await expect(control).toBeFocused()
        const box = await control.boundingBox()
        expect(box).not.toBeNull()
        expect(box!.x).toBeGreaterThanOrEqual(0)
        expect(box!.x + box!.width).toBeLessThanOrEqual(width)
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth))
        .toBeLessThanOrEqual(width)
      expect(await page.evaluate(() => window.scrollX)).toBe(0)
    }
  }

  const requestCode = page.getByRole('button', { name: '코드 받기', exact: true })
  await checkLayout('1 이메일', [email, consent, privacy, requestCode])

  // 인증 성공·실패는 기존 인증 e2e가 맡고, 여기서는 실제 단계 이동 후 새 UI만 확인한다.
  const address = 'login-layout@example.com'
  const developer = await createUser('developer@example.com', '개발자')
  const project = await createProject(developer.id, '로그인 화면 확인 프로젝트')
  await db.invitation.create({
    data: {
      projectId: project.id,
      email: address,
      tokenHash: randomUUID(),
      invitedById: developer.id,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  })
  await email.fill(address)
  await consent.check()
  await requestCode.click()
  await expect(code).toBeEditable()
  const login = page.getByRole('button', { name: '로그인', exact: true })
  await checkLayout('2 코드', [code, login, back])

  await useKnownLoginCode(address)
  await code.fill(KNOWN_LOGIN_CODE)
  await login.click()
  await expect(name).toBeEditable()
  await name.fill('화면 확인 사용자')
  await checkLayout('3 이름', [name, page.getByRole('button', { name: '시작하기', exact: true }), back])

  await back.click()
  await expect(email).toBeVisible()
  await expect(steps.locator('[aria-current="step"]')).toHaveText(['1 이메일'])
})

test('로그인 파비콘은 앱 경로의 SVG이며 공개 파비콘과 바이트가 같다', async ({ page, request }) => {
  const nginxOrigin = 'http://localhost:4103'
  await page.goto(`${nginxOrigin}/app/login`)
  const icon = page.locator('link[rel~="icon"]')
  await expect(icon).toHaveCount(1)
  const iconUrl = await icon.evaluate((link: HTMLLinkElement) => link.href)
  expect(iconUrl).toBe(`${nginxOrigin}/app/favicon.svg`)

  const [appResponse, publicResponse] = await Promise.all([
    request.get(iconUrl, { maxRedirects: 0 }),
    request.get(`${nginxOrigin}/favicon.svg`, { maxRedirects: 0 }),
  ])
  for (const response of [appResponse, publicResponse]) {
    expect(response.status(), response.url()).toBe(200)
    expect(response.headers()['content-type'], response.url()).toMatch(/^image\/svg\+xml(?:;|$)/)
  }

  const appBody = await appResponse.body()
  expect(appBody.equals(await publicResponse.body())).toBe(true)
  const svg = await page.evaluate((source) => {
    const document = new DOMParser().parseFromString(source, 'image/svg+xml')
    return {
      root: document.documentElement.localName,
      namespace: document.documentElement.namespaceURI,
      errors: document.querySelectorAll('parsererror').length,
    }
  }, appBody.toString('utf8'))
  expect(svg).toEqual({ root: 'svg', namespace: 'http://www.w3.org/2000/svg', errors: 0 })
})

test('공개 페이지와 앱의 폰트 경로는 동일한 WOFF2 파일 5개를 정상 응답한다', async ({ request }) => {
  const nginxOrigin = 'http://localhost:4103'
  const fontFiles = [
    'Pretendard-Regular.subset.woff2',
    'Pretendard-SemiBold.subset.woff2',
    'Pretendard-Bold.subset.woff2',
    'gowun-batang-korean-400-normal.woff2',
    'gowun-batang-latin-400-normal.woff2',
  ]

  for (const file of fontFiles) {
    const [publicResponse, appResponse] = await Promise.all([
      request.get(`${nginxOrigin}/fonts/${file}`, { maxRedirects: 0 }),
      request.get(`${nginxOrigin}/app/fonts/${file}`, { maxRedirects: 0 }),
    ])

    for (const response of [publicResponse, appResponse]) {
      expect(response.status(), response.url()).toBe(200)
      const body = await response.body()

      // WOFF2의 48바이트 헤더와 파일 길이를 확인해 HTML 응답이나 잘린 파일을 구분한다.
      expect(body.length, response.url()).toBeGreaterThan(48)
      expect(body.subarray(0, 4).toString('ascii'), response.url()).toBe('wOF2')
      expect(body.readUInt32BE(8), response.url()).toBe(body.length)
    }

    expect((await publicResponse.body()).equals(await appResponse.body()), `${file}의 두 경로 파일 일치`).toBe(true)
  }
})

test('앱 로그인은 자체 호스팅 Pretendard를 로드하고 크림 바탕과 테라코타 버튼을 쓴다', async ({ page }) => {
  const nginxOrigin = 'http://localhost:4103'
  const fontResponses: Response[] = []
  const externalFontRequests: string[] = []
  page.on('request', (request) => {
    if (!['font', 'stylesheet'].includes(request.resourceType())) return
    if (new URL(request.url()).origin !== nginxOrigin) externalFontRequests.push(request.url())
  })
  page.on('response', (response) => {
    if (response.request().resourceType() === 'font') fontResponses.push(response)
  })

  await page.goto(`${nginxOrigin}/app/login`)
  await expect(page.getByRole('heading', { name: '로그인', exact: true })).toBeVisible()
  const fonts = await page.evaluate(async () => {
    await document.fonts.ready
    return Array.from(document.fonts, (font) => ({
      family: font.family.replace(/["']/g, ''),
      weight: font.weight,
      status: font.status,
      display: font.display,
    }))
  })
  expect(fonts).toEqual(expect.arrayContaining([
    { family: 'Pretendard', weight: '400', status: 'loaded', display: 'swap' },
    { family: 'Pretendard', weight: '600', status: 'loaded', display: 'swap' },
  ]))
  expect(externalFontRequests).toEqual([])

  // 별도 HTTP 조회가 아니라, 이 화면을 그리면서 브라우저가 받은 응답을 검사한다.
  const pretendardResponses = fontResponses.filter((response) => new URL(response.url()).pathname.includes('Pretendard'))
  expect(pretendardResponses.length).toBeGreaterThanOrEqual(2)
  for (const response of pretendardResponses) {
    expect(response.url()).toMatch(/^http:\/\/localhost:4103\/app\/fonts\/Pretendard[^/]+\.woff2$/)
    expect(response.status(), response.url()).toBe(200)
    const body = await response.body()
    expect(body.subarray(0, 4).toString('ascii'), response.url()).toBe('wOF2')
  }

  const email = page.getByRole('textbox', { name: '이메일', exact: true })
  const submit = page.getByRole('button', { name: '코드 받기', exact: true })
  for (const element of [page.locator('body'), email, submit]) {
    await expect(element).toHaveCSS('font-family', /^"?Pretendard"?,/)
  }
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(251, 247, 242)')
  await expect(page.locator('body')).toHaveCSS('color', 'rgb(42, 31, 26)')
  await expect(submit).toHaveCSS('background-color', 'rgb(200, 78, 44)')
  await expect(submit).toHaveCSS('color', 'rgb(255, 255, 255)')

  for (const { width, height, minButtonHeight } of [
    { width: 1440, height: 900, minButtonHeight: 40 },
    { width: 390, height: 844, minButtonHeight: 44 },
  ]) {
    await page.setViewportSize({ width, height })
    await expect(submit).toBeVisible()
    await expect(submit).toHaveCSS('border-radius', '999px')
    await expect.poll(
      () => submit.evaluate((button) => button.getBoundingClientRect().height),
      { message: `${width}px 화면에서 버튼 높이는 ${minButtonHeight}px 이상이다` },
    ).toBeGreaterThanOrEqual(minButtonHeight)
  }
})

test('앱 로그인은 폰트 실패 뒤에도 대체 글꼴로 폼을 읽고 입력할 수 있다', async ({ page }) => {
  const blockedFonts: string[] = []
  await page.route('**/*', async (route) => {
    if (route.request().resourceType() !== 'font') return route.continue()
    blockedFonts.push(route.request().url())
    await route.abort('failed')
  })

  await page.goto('http://localhost:4103/app/login')
  await expect(page.getByRole('heading', { name: '로그인', exact: true })).toBeVisible()
  const pretendardFonts = await page.evaluate(async () => {
    await document.fonts.ready
    return Array.from(document.fonts)
      .filter((font) => font.family.replace(/["']/g, '') === 'Pretendard')
      .map((font) => ({ status: font.status, display: font.display }))
  })
  expect(blockedFonts.length).toBeGreaterThan(0)
  expect(pretendardFonts).toContainEqual({ status: 'error', display: 'swap' })
  expect(pretendardFonts.some((font) => font.status === 'loaded')).toBe(false)
  expect(pretendardFonts.every((font) => font.display === 'swap')).toBe(true)

  const email = page.getByRole('textbox', { name: '이메일', exact: true })
  const submit = page.getByRole('button', { name: '코드 받기', exact: true })
  for (const element of [page.locator('body'), email, submit]) {
    await expect(element).toHaveCSS('font-family', /(?:Apple SD Gothic Neo|Malgun Gothic).*sans-serif$/)
    await expect(element).toHaveCSS('opacity', '1')
  }
  await expect(page.getByText('이메일', { exact: true })).toBeVisible()
  await expect(email).toBeVisible()
  await expect(email).toBeEditable()
  await email.fill('font-fallback@example.test')
  await expect(email).toHaveValue('font-fallback@example.test')
  const consent = page.getByRole('checkbox', { name: '개인정보 수집·이용에 동의해요(필수)', exact: true })
  await consent.check()
  await expect(consent).toBeChecked()
  await expect(submit).toBeVisible()
  await expect(submit).toBeEnabled()
})

test('로그인 제목은 자체 Gowun Batang과 시스템 대체 글꼴을 쓰고 Tab 포커스가 보인다', async ({ page }) => {
  const fontResponse = page.waitForResponse('http://localhost:4103/app/fonts/gowun-batang-korean-400-normal.woff2')
  await page.goto('http://localhost:4103/app/login')
  expect((await fontResponse).status()).toBe(200)
  const heading = page.getByRole('heading', { level: 1, name: '로그인', exact: true })
  const session = await page.context().newCDPSession(page)
  await session.send('DOM.enable')
  await session.send('CSS.enable')

  for (const fontBlocked of [false, true]) {
    if (fontBlocked) {
      await page.route('**/fonts/gowun-batang-*.woff2', (route) => route.abort('failed'))
      await page.reload()
    }
    await expect(heading).toBeVisible()
    await expect(heading).toHaveCSS('font-family', /^"?Gowun Batang"?,\s*"?AppleMyungjo"?,\s*Georgia,\s*serif$/)
    await page.evaluate(() => document.fonts.ready.then(() => undefined))

    // CSS 선언뿐 아니라 제목의 글자를 실제로 그린 글꼴을 확인한다.
    const { root } = await session.send('DOM.getDocument')
    const { nodeId } = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'h1' })
    const { fonts } = await session.send('CSS.getPlatformFontsForNode', { nodeId })
    const renderedFonts = fonts.filter((font) => font.glyphCount > 0)
    expect(renderedFonts.length).toBeGreaterThan(0)
    if (fontBlocked) {
      expect(renderedFonts.every((font) => !font.isCustomFont)).toBe(true)
      continue
    }
    expect(renderedFonts).toEqual(expect.arrayContaining([
      expect.objectContaining({ familyName: 'Gowun Batang', isCustomFont: true }),
    ]))
  }
  await session.detach()

  // 첫 Tab의 목적지를 고정하지 않아 폼과 링크 순서가 조금 바뀌어도 검사한다.
  const focused = page.locator('input:focus-visible, a[href]:focus-visible')
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await page.keyboard.press('Tab')
    if (await focused.count()) break
  }
  await expect(focused).toHaveCount(1)
  await expect(focused).toBeFocused()
  await expect(focused).toHaveCSS('outline-style', 'solid')
  await expect(focused).toHaveCSS('outline-width', '2px')
  await expect(focused).toHaveCSS('outline-offset', '2px')
  await expect(focused).toHaveCSS('outline-color', 'rgb(200, 78, 44)')
})
