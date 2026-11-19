import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import type { Response } from '@playwright/test'
import { test, expect, db, resetDatabase, createUser, createProject } from './fixtures.ts'

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
