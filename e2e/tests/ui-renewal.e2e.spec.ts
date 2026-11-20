import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import type { Locator, Page, Response } from '@playwright/test'
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

test('검수실 준비 링크와 버전 상태 글자가 충분한 대비를 유지한다', async ({ page, loginAs }) => {
  await resetDatabase()
  const room = await prepareRoom()
  const emptyProject = await createProject(room.developer.id, '아직 게시하지 않은 프로젝트')
  await loginAs(room.developer.id)
  await page.setViewportSize({ width: 1440, height: 900 })

  const expectTextContrast = async (locator: Locator, label: string) => {
    await expect(locator).toBeVisible()
    const ratio = await locator.evaluate((element) => {
      const foreground = getComputedStyle(element).color.match(/[\d.]+/g)!.map(Number)
      if ((foreground[3] ?? 1) !== 1) throw new Error('반투명 글자는 합성한 색으로 대비를 검사해야 해요.')

      let background: number[] | undefined
      let current: Element | null = element
      while (current) {
        const style = getComputedStyle(current)
        if (style.opacity !== '1') throw new Error('반투명 요소는 합성한 색으로 대비를 검사해야 해요.')
        if (!background) {
          if (style.backgroundImage !== 'none') throw new Error('배경 이미지는 글자 뒤의 색을 따로 검사해야 해요.')
          const channels = style.backgroundColor.match(/[\d.]+/g)!.map(Number)
          const alpha = channels[3] ?? 1
          if (alpha !== 0 && alpha !== 1) throw new Error('반투명 배경은 합성한 색으로 대비를 검사해야 해요.')
          if (alpha === 1) background = channels
        }
        current = current.parentElement
      }
      if (!background) throw new Error('글자 뒤의 불투명 배경을 찾지 못했어요.')

      // 인쇄 대비 검사와 같은 WCAG 상대 휘도 공식에 실제 전경·배경을 모두 넣는다.
      const luminance = (channels: number[]) => {
        const [red, green, blue] = channels.slice(0, 3).map((channel) => {
          const value = channel / 255
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
        })
        return 0.2126 * red + 0.7152 * green + 0.0722 * blue
      }
      const text = luminance(foreground)
      const surface = luminance(background)
      return (Math.max(text, surface) + 0.05) / (Math.min(text, surface) + 0.05)
    })
    expect(ratio, label).toBeGreaterThanOrEqual(4.5)
  }

  await page.goto(`/app/projects/${emptyProject.id}`)
  const emptyMessage = page.getByRole('heading', { name: '아직 게시한 버전이 없어요.', exact: true }).locator('..')
  const prepareLink = emptyMessage.getByRole('link', { name: '초안 준비', exact: true })
  await expect(prepareLink).toHaveAttribute('href', `/app/projects/${emptyProject.id}/draft`)
  await page.mouse.move(0, 0)
  await expectTextContrast(prepareLink, '빈 프로젝트 초안 준비 링크: 기본')
  await prepareLink.hover()
  expect(await prepareLink.evaluate((link) => link.matches(':hover'))).toBe(true)
  await expectTextContrast(prepareLink, '빈 프로젝트 초안 준비 링크: hover')

  await page.goto(`/app/projects/${room.project.id}`)
  await expectTextContrast(page.getByText('검수 중', { exact: true }), 'IN_REVIEW 버전 상태')
  await db.$transaction([
    db.approval.create({
      data: { versionId: room.version.id, approverId: room.client.id, summary: { issues: [] } },
    }),
    db.deliveryVersion.update({ where: { id: room.version.id }, data: { status: 'APPROVED' } }),
  ])
  await page.reload()
  await expectTextContrast(page.getByText('승인됨', { exact: true }), 'APPROVED 버전 상태')
})

test('진행률은 전체 쪽지 기준이며 필터와 무관하고 상태 변경을 반영한다', async ({ page, loginAs }) => {
  await resetDatabase()
  const room = await prepareRoom()
  const issues = []
  for (const { status } of issueStates) issues.push(await seedIssue(room, status))
  const openIssue = issues[0]
  await loginAs(room.client.id)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/app/projects/${room.project.id}`)

  const list = page.getByRole('region', { name: '쪽지 목록', exact: true })
  const progress = list.getByRole('progressbar', { name: /검수 진행률/ })
  const statusFilter = list.getByRole('combobox', { name: '상태', exact: true })
  await expect(list.getByRole('listitem')).toHaveCount(5)
  await expect(progress).toBeVisible()
  await expect(progress).toHaveAttribute('max', '5')
  await expect(progress).toHaveAttribute('value', '2')
  await expect(list.getByText('2 / 5', { exact: true })).toBeVisible()

  for (const { status } of issueStates) {
    await statusFilter.selectOption(status)
    await expect(list.getByRole('listitem')).toHaveCount(1)
    await expect(list.getByRole('listitem')).toContainText(`${status} 상태 쪽지`)
    await expect(progress).toHaveAttribute('max', '5')
    await expect(progress).toHaveAttribute('value', '2')
    await expect(list.getByText('2 / 5', { exact: true })).toBeVisible()
  }

  // 필터 결과가 0개여도 프로젝트 전체 쪽지가 없는 것은 아니다.
  await list.getByRole('checkbox', { name: '마감 지남만', exact: true }).check()
  await expect(list.getByRole('listitem')).toHaveCount(0)
  await expect(list.getByText('조건에 맞는 쪽지가 없어요', { exact: true })).toBeVisible()
  await expect(progress).toBeVisible()
  await expect(progress).toHaveAttribute('max', '5')
  await expect(progress).toHaveAttribute('value', '2')
  await expect(list.getByText('2 / 5', { exact: true })).toBeVisible()
  await expect(list.getByText('쪽지 없음', { exact: true })).toHaveCount(0)
  await list.getByRole('button', { name: '필터 지우기', exact: true }).click()
  await expect(list.getByRole('listitem')).toHaveCount(5)

  await statusFilter.selectOption('OPEN')
  await list.getByRole('listitem').getByRole('button').click()
  const review = page.getByRole('region', { name: '확인하기', exact: true })
  await review.getByRole('button', { name: '철회', exact: true }).click()
  await review.getByLabel('철회 사유', { exact: true }).fill('이 요청은 필요 없어졌어요')
  const withdrawn = page.waitForResponse((response) =>
    new URL(response.url()).pathname === `/api/issues/${openIssue.id}/withdraw`
    && response.request().method() === 'POST',
  )
  await review.getByRole('button', { name: '철회하기', exact: true }).click()
  const response = await withdrawn
  expect(response.status()).toBe(200)
  expect(await response.json()).toMatchObject({ id: openIssue.id, status: 'WITHDRAWN' })

  // 페이지를 다시 열거나 주기 갱신을 기다리지 않고 상태 변경 응답을 반영한다.
  await expect(progress).toHaveAttribute('value', '3')
  await expect(progress).toHaveAttribute('max', '5')
  await expect(list.getByText('3 / 5', { exact: true })).toBeVisible()
  await expect(statusFilter).toHaveValue('OPEN')
  await expect(list.getByRole('listitem')).toHaveCount(0)
  await expect(list.getByText('조건에 맞는 쪽지가 없어요', { exact: true })).toBeVisible()
  await expect(list.getByText('쪽지 없음', { exact: true })).toHaveCount(0)
  expect(await db.issue.findUniqueOrThrow({ where: { id: openIssue.id } })).toMatchObject({ status: 'WITHDRAWN' })
})

test('빈 프로젝트는 진행률 대신 쪽지 없음을 표시한다', async ({ page, loginAs }) => {
  await resetDatabase()
  const room = await prepareRoom()
  await loginAs(room.client.id)
  await page.goto(`/app/projects/${room.project.id}`)

  const list = page.getByRole('region', { name: '쪽지 목록', exact: true })
  await expect(list.getByRole('heading', { name: '쪽지 0개', exact: true })).toBeVisible()
  await expect(list.getByText('쪽지 없음', { exact: true })).toBeVisible()
  await expect(list.getByRole('listitem')).toHaveCount(0)
  await expect(list.getByRole('progressbar', { includeHidden: true })).toHaveCount(0)
  await expect(list).not.toContainText(/NaN|Infinity|%|\d+\s*\/\s*0/)
  await expect(list.getByRole('button', { name: '쪽지 쓰기', exact: true })).toBeVisible()
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

test('공개 페이지와 앱은 자체 호스팅 글꼴을 사용하고 폰트 실패 뒤에도 본문이 보인다', async ({ browser }) => {
  const nginxOrigin = 'http://localhost:4103'
  const views = [
    { path: '/', heading: 'client-review', fontPath: '/fonts/' },
    { path: '/privacy', heading: '개인정보처리방침', fontPath: '/fonts/' },
    { path: '/app/login', heading: '로그인', fontPath: '/app/fonts/' },
  ]
  const scenarios = views.flatMap((view) => [false, true].map((blocked) => ({ ...view, blocked })))

  for (const { path, heading, fontPath, blocked } of scenarios) {
    // 성공한 폰트가 메모리·HTTP 캐시에 남지 않도록 실패 사례도 새 컨텍스트에서 시작한다.
    const context = await browser.newContext({ serviceWorkers: 'block' })
    const page = await context.newPage()
    const externalRequests: string[] = []
    const blockedFonts: string[] = []
    const fontResponses: Response[] = []
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url())
      if (url.origin !== nginxOrigin) {
        externalRequests.push(url.href)
        return route.abort('blockedbyclient')
      }
      if (blocked && url.pathname.endsWith('.woff2')) {
        blockedFonts.push(url.pathname)
        return route.abort('failed')
      }
      await route.continue()
    })
    page.on('response', (response) => {
      if (response.request().resourceType() === 'font') fontResponses.push(response)
    })

    try {
      expect((await page.goto(`${nginxOrigin}${path}`))?.status()).toBe(200)
      const title = page.getByRole('heading', { level: 1, name: heading, exact: true })
      await expect(title).toBeVisible()
      const fonts = await page.evaluate(async () => {
        await document.fonts.ready
        return Array.from(document.fonts, (font) => ({
          family: font.family.replace(/["']/g, ''),
          status: font.status,
          display: font.display,
        }))
      })
      await expect(page.locator('body')).toHaveCSS('font-family', /^"?Pretendard"?,.*sans-serif$/)
      // 소개의 h1은 브랜드다. 공개 명조 제목은 개편 전후 동일한 방침 h1에서 확인한다.
      if (path !== '/') await expect(title).toHaveCSS('font-family', /^"?Gowun Batang"?,.*serif$/)
      for (const family of ['Pretendard', 'Gowun Batang']) {
        const faces = fonts.filter((font) => font.family === family)
        expect(faces.length, `${path}: ${family} 선언`).toBeGreaterThan(0)
        expect(faces.every((font) => font.display === 'swap'), `${path}: ${family} swap`).toBe(true)
      }
      const usedFamilies = path === '/' ? ['Pretendard'] : ['Pretendard', 'Gowun Batang']
      for (const family of usedFamilies) {
        expect(fonts, `${path}: ${family} ${blocked ? '실패' : '로드'}`).toContainEqual({
          family, status: blocked ? 'error' : 'loaded', display: 'swap',
        })
      }

      if (blocked) {
        expect(blockedFonts.length, path).toBeGreaterThan(0)
        expect(blockedFonts.every((url) => url.startsWith(fontPath)), path).toBe(true)
        expect(fonts.some((font) => font.status === 'loaded'), path).toBe(false)
      }
      if (!blocked) {
        // 파일 서명·내용 일치는 위의 정적 파일 테스트가 담당한다. 여기서는 실제 로드 응답을 본다.
        expect(fontResponses.length, path).toBeGreaterThan(0)
        for (const response of fontResponses) {
          const url = new URL(response.url())
          expect(url.origin).toBe(nginxOrigin)
          expect(url.pathname.startsWith(fontPath), response.url()).toBe(true)
          expect(url.pathname.endsWith('.woff2'), response.url()).toBe(true)
          expect(response.status(), response.url()).toBe(200)
        }
      }

      const bodyText = path === '/app/login'
        ? page.locator('label').filter({ hasText: '개인정보 수집·이용에 동의해요(필수)' })
        : page.locator('main p').first()
      for (const element of [page.locator('body'), bodyText, title]) {
        await expect(element).toBeVisible()
        await expect(element).toHaveCSS('opacity', '1')
      }
      if (path === '/') {
        const start = page.getByRole('link', { name: '시작하기', exact: true })
        await expect(start).toBeVisible()
        await expect(start).toHaveAttribute('href', '/app/login')
        await start.click({ trial: true })
      }
      if (path === '/app/login') {
        const email = page.getByRole('textbox', { name: '이메일', exact: true })
        await expect(email).toBeVisible()
        await email.fill('font-fallback@example.test')
        await expect(email).toHaveValue('font-fallback@example.test')
        await expect(page.getByRole('button', { name: '코드 받기', exact: true })).toBeVisible()
        await expect(page.getByRole('button', { name: '코드 받기', exact: true })).toBeEnabled()
      }
      expect(externalRequests, `${path}: 외부 요청`).toEqual([])
    } finally {
      await context.close()
    }
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

// 기존 참여자·실제 PNG 준비를 재사용한다. 생성 시각을 달리해 마지막 화면의 순서를 고정한다.
const prepareFilmstrip = async (count: number) => {
  const room = await prepareRoom()
  const screens = [room.main]
  for (let index = 1; index < count; index += 1) {
    screens.push(await db.screen.create({
      data: {
        projectId: room.project.id,
        name: `화면 ${index + 1}`,
        viewport: 'PC',
        createdAt: new Date(room.main.createdAt.getTime() + index * 1000),
      },
    }))
  }
  const version = await publishVersion(room.project.id, screens.map(({ id }) => id), 1)
  return { ...room, version, screens }
}

const expectLoadedPhoto = async (photo: Locator) => {
  await expect(photo).toBeVisible()
  await expect.poll(() => photo.evaluate((image: HTMLImageElement) =>
    image.complete && image.naturalWidth === 1200 && image.naturalHeight === 800,
  )).toBe(true)
}

const expectMat = async (page: Page, selected: '어두운 매트' | '밝은 매트') => {
  const picker = page.getByRole('group', { name: '사진 배경', exact: true })
  await expect(picker.getByRole('button', { name: '어두운 매트', exact: true }))
    .toHaveAttribute('aria-pressed', String(selected === '어두운 매트'))
  await expect(picker.getByRole('button', { name: '밝은 매트', exact: true }))
    .toHaveAttribute('aria-pressed', String(selected === '밝은 매트'))
  const photo = page.getByRole('img', { name: '메인 · PC', exact: true })
  await expectLoadedPhoto(photo)
  // 클래스·저장 키 대신 사진을 감싼 첫 불투명 배경의 실제 색을 읽는다.
  await expect.poll(() => photo.evaluate((image) => {
    let parent = image.parentElement
    while (parent) {
      const color = getComputedStyle(parent).backgroundColor
      if (color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') return color
      parent = parent.parentElement
    }
    return null
  })).toBe(selected === '어두운 매트' ? 'rgb(35, 30, 27)' : 'rgb(234, 226, 215)')
}

const expectNoHorizontalOverflow = async (page: Page, width: number) => {
  await expect.poll(() => page.evaluate(() => Math.max(
    document.documentElement.scrollWidth,
    document.body.scrollWidth,
  ))).toBeLessThanOrEqual(width)
}

test('이전 스타일을 저장한 브라우저에서도 공개 페이지가 새 배치로 열린다', {
  annotation: {
    type: '재현 방식',
    description: '실제 HTTP 캐시를 데우는 대신 기존 /landing.css URL만 구버전 구별용 CSS로 대체한다. 버전 쿼리가 있는 새 URL과 HTML은 실제 테스트 nginx(4103) 응답을 사용한다.',
  },
}, async ({ page }) => {
  const nginxOrigin = 'http://localhost:4103'
  let oldStylesheetRequests = 0
  // route는 HTTP 캐시를 끈다. 캐시 저장 자체가 아니라 예전 URL만 오래된 응답을 주는 상황을 재현한다.
  await page.route((url) => url.href === `${nginxOrigin}/landing.css`, async (route) => {
    oldStylesheetRequests += 1
    await route.fulfill({
      contentType: 'text/css',
      body: 'body { background: rgb(255, 0, 255); } .hero, .review-example, .steps { display: block; }',
    })
  })

  await page.setViewportSize({ width: 390, height: 844 })
  for (const { path, status, heading } of [
    { path: '/', status: 200, heading: 'client-review' },
    { path: '/privacy', status: 200, heading: '개인정보처리방침' },
    { path: '/terms', status: 200, heading: '이용약관' },
    { path: '/404', status: 404, heading: '찾을 수 없는 주소예요' },
  ]) {
    const stylesheetResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === '/landing.css'
      && response.request().resourceType() === 'stylesheet',
    )
    expect((await page.goto(`${nginxOrigin}${path}`))?.status(), path).toBe(status)
    const response = await stylesheetResponse
    expect(response.status(), path).toBe(200)
    expect(response.headers()['content-type'], path).toContain('text/css')
    // 로컬 파일이나 고정 해시가 아니라 브라우저에 전송된 CSS 바이트로 버전을 계산한다.
    const version = createHash('sha256').update(await response.body()).digest('hex').slice(0, 12)
    const stylesheet = page.locator('link[rel="stylesheet"]')
    await expect(stylesheet).toHaveCount(1)
    await expect(stylesheet).toHaveAttribute('href', `/landing.css?v=${version}`)
    expect(response.url(), path).toBe(`${nginxOrigin}/landing.css?v=${version}`)
    await expect(page.getByRole('heading', { level: 1, name: heading, exact: true })).toBeVisible()
    await page.evaluate(() => document.fonts.ready.then(() => undefined))
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(251, 247, 242)')
    await expectNoHorizontalOverflow(page, 390)
  }

  await page.goto(`${nginxOrigin}/`)
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  const title = page.getByRole('heading', { level: 2, name: '화면을 크게 펼치고, 깔끔하게 승인해요.', exact: true })
  const copy = page.locator('.hero-copy')
  const example = page.getByRole('figure', { name: '상품 상세 화면을 검수하는 예시', exact: true })
  const photo = example.getByRole('img', { name: '핀으로 수정할 위치를 표시한 쇼핑몰 상품 화면', exact: true })
  const checklist = example.locator('figcaption')
  const progress = checklist.getByRole('progressbar', { name: '예시 검수 진행률', exact: true })
  const steps = page.getByRole('list', { name: '진행 방식', exact: true }).getByRole('listitem')
  await expect(steps).toHaveCount(3)
  await expect(checklist).toContainText('검수 체크리스트')
  await expect(checklist).toContainText('확인 완료 1 / 3')
  await expect(progress).toHaveAttribute('value', '1')
  await expect(progress).toHaveAttribute('max', '3')
  expect(await progress.evaluate((element: HTMLProgressElement) => element.position)).toBeCloseTo(1 / 3, 5)
  await expect.poll(() => photo.evaluate((image: HTMLImageElement) =>
    image.complete && image.naturalWidth > 0,
  )).toBe(true)
  const naturalRatio = await photo.evaluate(async (image: HTMLImageElement) => {
    await image.decode()
    return image.naturalWidth / image.naturalHeight
  })
  // 파일명·고정 해상도 대신 디코딩된 이미지가 정사각형에서 10% 이내인지 확인한다.
  expect(naturalRatio).toBeGreaterThanOrEqual(0.9)
  expect(naturalRatio).toBeLessThanOrEqual(1.1)

  for (const { expectedHeroGap, ...viewport } of [
    { width: 1728, height: 997, expectedHeroGap: 176 },
    { width: 1440, height: 900, expectedHeroGap: 176 },
    { width: 390, height: 844, expectedHeroGap: 76 },
  ]) {
    await page.setViewportSize(viewport)
    for (const element of [title, example, photo, checklist, progress, ...await steps.all()]) {
      await expect(element).toBeVisible()
    }
    const titleBox = (await title.boundingBox())!
    const copyBox = (await copy.boundingBox())!
    const exampleBox = (await example.boundingBox())!
    const photoBox = (await photo.boundingBox())!
    const checklistBox = (await checklist.boundingBox())!
    const headerBox = (await page.getByRole('banner').boundingBox())!
    const heroBox = (await page.locator('.hero').boundingBox())!
    const headerHeroGap = heroBox.y - (headerBox.y + headerBox.height)
    expect(Math.abs(headerHeroGap - expectedHeroGap), `${viewport.width}px에서 헤더와 hero 사이 여백`)
      .toBeLessThanOrEqual(2)
    const stepBoxes = await steps.evaluateAll((items) => items.map((item) => {
      const { x, y, width, height } = item.getBoundingClientRect()
      return { x, y, width, height }
    }))
    await expectNoHorizontalOverflow(page, viewport.width)
    const displayedRatio = photoBox.width / photoBox.height
    expect(displayedRatio).toBeGreaterThanOrEqual(0.9)
    expect(displayedRatio).toBeLessThanOrEqual(1.1)
    expect(Math.abs(photoBox.height - photoBox.width / naturalRatio), '원본 비율을 유지하며 표시한다')
      .toBeLessThanOrEqual(1)
    expect(photoBox.x).toBeGreaterThanOrEqual(exampleBox.x)
    expect(photoBox.x + photoBox.width).toBeLessThanOrEqual(exampleBox.x + exampleBox.width)
    expect(photoBox.y).toBeGreaterThanOrEqual(exampleBox.y)
    expect(photoBox.y + photoBox.height).toBeLessThanOrEqual(exampleBox.y + exampleBox.height)

    if (viewport.width === 390) {
      expect(copyBox.y + copyBox.height).toBeLessThanOrEqual(exampleBox.y)
      expect(exampleBox.y + exampleBox.height).toBeLessThanOrEqual(stepBoxes[0].y)
      expect(stepBoxes[0].y + stepBoxes[0].height).toBeLessThanOrEqual(stepBoxes[1].y)
      expect(stepBoxes[1].y + stepBoxes[1].height).toBeLessThanOrEqual(stepBoxes[2].y)
      continue
    }
    // 높이/line-height나 <br> 개수가 아니라 실제 한글 텍스트 조각의 줄 위치를 센다.
    await expect.poll(() => title.evaluate((heading) => {
      const walker = document.createTreeWalker(heading, NodeFilter.SHOW_TEXT)
      const lineTops: number[] = []
      let node = walker.nextNode()
      while (node) {
        const range = document.createRange()
        range.selectNodeContents(node)
        const textRects = node.textContent?.trim() ? Array.from(range.getClientRects()) : []
        for (const rect of textRects) {
          if (rect.width > 0 && !lineTops.some((top) => Math.abs(top - rect.top) <= 1)) lineTops.push(rect.top)
        }
        node = walker.nextNode()
      }
      return lineTops.length
    }), { message: `${viewport.width}px에서 한글 제목은 실제 두 줄로 보인다` }).toBe(2)
    expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(exampleBox.x)
    expect(copyBox.y).toBeLessThan(exampleBox.y + exampleBox.height)
    expect(exampleBox.y).toBeLessThan(copyBox.y + copyBox.height)
    expect(photoBox.x + photoBox.width).toBeLessThanOrEqual(checklistBox.x)
    expect(photoBox.y).toBeLessThan(checklistBox.y + checklistBox.height)
    expect(checklistBox.y).toBeLessThan(photoBox.y + photoBox.height)
    expect(stepBoxes[0].x + stepBoxes[0].width).toBeLessThanOrEqual(stepBoxes[1].x)
    expect(stepBoxes[1].x + stepBoxes[1].width).toBeLessThanOrEqual(stepBoxes[2].x)
    expect(Math.abs(stepBoxes[0].y - stepBoxes[1].y)).toBeLessThanOrEqual(1)
    expect(Math.abs(stepBoxes[1].y - stepBoxes[2].y)).toBeLessThanOrEqual(1)
  }
  expect(oldStylesheetRequests, '공개 페이지는 이전 CSS URL을 다시 사용하지 않는다').toBe(0)
})

test('매트는 기본이 어둡고 밝은 선택이 다시 열어도 유지된다', async ({ page, loginAs }) => {
  await resetDatabase()
  const room = await prepareRoom()
  await loginAs(room.client.id)
  const roomPath = `/app/projects/${room.project.id}`
  await page.goto(roomPath)
  await expectMat(page, '어두운 매트')

  await page.getByRole('button', { name: '밝은 매트', exact: true }).click()
  await expectMat(page, '밝은 매트')
  await page.reload()
  await expectMat(page, '밝은 매트')
  await page.getByRole('link', { name: '프로젝트 목록', exact: true }).click()
  await expect(page.getByRole('heading', { name: '내 프로젝트', exact: true })).toBeVisible()
  await page.getByRole('link', { name: room.project.name, exact: true }).click()
  await expect(page).toHaveURL(roomPath)
  await expectMat(page, '밝은 매트')

  await page.getByRole('button', { name: '어두운 매트', exact: true }).click()
  await expectMat(page, '어두운 매트')
  await page.reload()
  await expectMat(page, '어두운 매트')
})

test('저장소를 사용할 수 없어도 매트를 바꿀 수 있다', async ({ page, loginAs }) => {
  await resetDatabase()
  const room = await prepareRoom()
  await loginAs(room.client.id)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.addInitScript(() => {
    for (const method of ['getItem', 'setItem']) {
      Object.defineProperty(Storage.prototype, method, {
        configurable: true,
        value: () => { throw new DOMException('저장소 접근 차단', 'SecurityError') },
      })
    }
  })
  await page.goto(`/app/projects/${room.project.id}`)
  await expectMat(page, '어두운 매트')
  await page.getByRole('button', { name: '밝은 매트', exact: true }).click()
  await expectMat(page, '밝은 매트')
  await page.getByRole('button', { name: '어두운 매트', exact: true }).click()
  await expectMat(page, '어두운 매트')
  await page.getByRole('button', { name: '밝은 매트', exact: true }).click()
  await expectMat(page, '밝은 매트')
  // 저장하지 못한 값은 새로 열 때 기본값으로 돌아가며 화면은 계속 사용할 수 있다.
  await page.reload()
  await expectMat(page, '어두운 매트')
  await page.getByRole('button', { name: '밝은 매트', exact: true }).click()
  await expectMat(page, '밝은 매트')
  expect(errors).toEqual([])
})

test('필름스트립을 접고 펼쳐도 고른 화면과 사진이 유지된다', async ({ page, loginAs }) => {
  await resetDatabase()
  const room = await prepareFilmstrip(2)
  await loginAs(room.client.id)
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/app/projects/${room.project.id}`)
  const selected = page.getByRole('button', { name: '화면 2 · PC', exact: true })
  await selected.click()
  const photo = page.getByRole('img', { name: '화면 2 · PC', exact: true })
  await expectLoadedPhoto(photo)
  const photoUrl = `/api/assets/${room.version.screens[1].assetId}`
  await expect(photo).toHaveAttribute('src', photoUrl)
  await expect(selected).toHaveAttribute('aria-pressed', 'true')

  const toggle = page.getByRole('button', { name: /^(접기|펼치기)$/ })
  const strip = toggle.locator('..')
  await expect(toggle).toHaveText('접기')
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect.poll(async () => (await strip.boundingBox())?.height).toBe(82)
  await toggle.click()
  await expect(toggle).toHaveText('펼치기')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect.poll(async () => (await strip.boundingBox())?.height).toBe(42)
  await expect(strip.getByRole('list', { includeHidden: true })).toBeHidden()
  await expect(strip.getByText('화면 2개', { exact: true })).toBeVisible()
  await expectLoadedPhoto(photo)
  await expect(photo).toHaveAttribute('src', photoUrl)
  await expect(page.getByText('사진 2 / 2', { exact: true })).toBeVisible()

  await toggle.click()
  await expect(toggle).toHaveText('접기')
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect.poll(async () => (await strip.boundingBox())?.height).toBe(82)
  await expect(selected).toBeVisible()
  await expect(selected).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('button', { name: '메인 · PC', exact: true })).toHaveAttribute('aria-pressed', 'false')
  await expectLoadedPhoto(photo)
  await expect(photo).toHaveAttribute('src', photoUrl)
  await expect(page.getByText('사진 2 / 2', { exact: true })).toBeVisible()
})

test('화면 20개를 필름스트립 안에서 가로로 탐색하고 마지막 사진을 고른다', async ({ page, loginAs }) => {
  await resetDatabase()
  const room = await prepareFilmstrip(20)
  await loginAs(room.client.id)
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/app/projects/${room.project.id}`)
  await expectLoadedPhoto(page.getByRole('img', { name: '메인 · PC', exact: true }))
  const strip = page.getByRole('button', { name: '접기', exact: true }).locator('..')
  const list = strip.getByRole('list')
  const buttons = list.getByRole('button')
  await expect(buttons).toHaveCount(20)
  await expect(buttons.nth(19)).toHaveAccessibleName('화면 20 · PC')
  await expect.poll(() => list.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true)
  await expect(list).toHaveCSS('overflow-x', 'auto')
  await expect(list).toHaveCSS('min-width', '0px')
  await expectNoHorizontalOverflow(page, 1280)
  expect(await list.evaluate((element) => element.scrollLeft)).toBe(0)
  const firstBox = (await buttons.first().boundingBox())!
  const lastBox = (await buttons.nth(19).boundingBox())!
  const listBox = (await list.boundingBox())!
  expect(lastBox.x).toBeGreaterThanOrEqual(listBox.x + listBox.width)
  expect(Math.abs(lastBox.y - firstBox.y)).toBeLessThanOrEqual(1)

  // 실제 화면 선택 버튼을 스크롤해서 누르고, 서버에서 받은 마지막 사진인지 확인한다.
  await buttons.nth(19).scrollIntoViewIfNeeded()
  await buttons.nth(19).click()
  await expect.poll(() => list.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
  await expect(buttons.nth(19)).toHaveAttribute('aria-pressed', 'true')
  await expect(buttons.first()).toHaveAttribute('aria-pressed', 'false')
  const lastPhoto = page.getByRole('img', { name: '화면 20 · PC', exact: true })
  await expectLoadedPhoto(lastPhoto)
  await expect(lastPhoto).toHaveAttribute('src', `/api/assets/${room.version.screens[19].assetId}`)
  await expect(page.getByText('사진 20 / 20', { exact: true })).toBeVisible()
  const visibleLastBox = (await buttons.nth(19).boundingBox())!
  const scrolledListBox = (await list.boundingBox())!
  expect(visibleLastBox.x).toBeGreaterThanOrEqual(scrolledListBox.x)
  expect(visibleLastBox.x + visibleLastBox.width).toBeLessThanOrEqual(scrolledListBox.x + scrolledListBox.width)
  await expectNoHorizontalOverflow(page, 1280)
})

test('390px에서 검수실과 비교 화면은 가로로 넘치지 않는다', async ({ page, loginAs }) => {
  await resetDatabase()
  const room = await prepareRoom()
  const issue = await seedIssue(room, 'READY_FOR_REVIEW')
  const latest = await publishVersion(room.project.id, [room.main.id], 1)
  await db.resolutionAttempt.create({
    data: {
      issueId: issue.id,
      versionId: latest.id,
      versionScreenId: latest.screens[0].id,
      summary: '사진의 여백을 고쳤어요.',
      submittedById: room.developer.id,
    },
  })
  await loginAs(room.client.id)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/app/projects/${room.project.id}`)
  const photo = page.getByRole('img', { name: '메인 · PC', exact: true })
  const strip = page.getByRole('button', { name: '접기', exact: true }).locator('..')
  const panel = page.getByRole('complementary', { name: '쪽지', exact: true })
  await expectLoadedPhoto(photo)
  await expect(panel.getByRole('region', { name: '쪽지 목록', exact: true })).toBeVisible()
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  const photoBox = (await photo.boundingBox())!
  const stripBox = (await strip.boundingBox())!
  const panelBox = (await panel.boundingBox())!
  expect(photoBox.y + photoBox.height).toBeLessThanOrEqual(stripBox.y)
  expect(stripBox.y + stripBox.height).toBeLessThanOrEqual(panelBox.y)
  await expectNoHorizontalOverflow(page, 390)

  // 실제 쪽지 이력의 링크로 이동해 비교 경로와 양쪽 사진을 함께 확인한다.
  await panel.getByRole('region', { name: '쪽지 목록', exact: true }).getByRole('button', { name: /READY_FOR_REVIEW 상태 쪽지/ }).click()
  await page.getByRole('link', { name: '비교해서 보기', exact: true }).click()
  await expect(page).toHaveURL(`/app/issues/${issue.id}/compare`)
  const before = page.getByRole('img', { name: '처음 사진 메인 · PC', exact: true })
  const after = page.getByRole('img', { name: '고친 사진 메인 · PC', exact: true })
  await expectLoadedPhoto(before)
  await expectLoadedPhoto(after)
  await expect(before).toHaveAttribute('src', `/api/assets/${room.version.screens[0].assetId}`)
  await expect(after).toHaveAttribute('src', `/api/assets/${latest.screens[0].assetId}`)
  await expect(page.getByRole('button', { name: `쪽지 #${issue.number} ${issue.title}`, exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '재요청', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '확인 완료', exact: true })).toBeVisible()

  for (const width of [390, 959, 960, 1440]) {
    await page.setViewportSize({ width, height: 844 })
    const beforeBox = (await before.boundingBox())!
    const afterBox = (await after.boundingBox())!
    if (width < 960) {
      expect(beforeBox.y + beforeBox.height).toBeLessThanOrEqual(afterBox.y)
      expect(Math.abs(beforeBox.x - afterBox.x)).toBeLessThanOrEqual(1)
    }
    if (width >= 960) {
      expect(beforeBox.x + beforeBox.width).toBeLessThanOrEqual(afterBox.x)
      expect(Math.abs(beforeBox.y - afterBox.y)).toBeLessThanOrEqual(1)
    }
    await expectNoHorizontalOverflow(page, width)
  }
})
