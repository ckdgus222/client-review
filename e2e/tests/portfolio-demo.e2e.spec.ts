import { fileURLToPath } from 'node:url'
import type { Locator, Page } from '@playwright/test'
import { test, expect, db, resetDatabase, createUser, createProject } from './fixtures.ts'

const nginxOrigin = 'http://localhost:4103'
const noteTitle = '구매 버튼 간격을 넓혀 주세요'
const notes = (page: Page) => page.getByRole('list', { name: '쪽지 목록' })
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true })

const expectInitialDemo = async (page: Page) => {
  await expect(page.getByRole('heading', { name: '오브제 스토어 리뉴얼', exact: true })).toBeVisible()
  await expect(button(page, '고객(승인자)')).toHaveAttribute('aria-pressed', 'true')
  await expect(notes(page).getByRole('listitem')).toHaveCount(1)
  await expect(notes(page)).toContainText('배송 안내 문구 확인')
  await expect(notes(page)).toContainText('확인 완료')
  await expect(page.getByText('초안 · 상품 상세 · PC', { exact: true })).toBeVisible()
  await expect(page.getByLabel('제목 (필수)')).toHaveValue('')
  await expect(page.getByLabel('내용', { exact: true })).toHaveValue('')
  await expect(page.getByRole('img', { name: '새 쪽지 위치' })).toHaveCount(0)
  await expect(button(page, '쪽지 남기기')).toBeDisabled()
  await expect(button(page, '검수 확인서 보기')).toHaveCount(0)
}

const createNote = async (page: Page, title = noteTitle) => {
  await button(page, '구매 버튼 위치 선택').click()
  await page.getByLabel('제목 (필수)').fill(title)
  await page.getByLabel('내용', { exact: true }).fill('수량과 구매 버튼 사이 여백을 넓혀 주세요.')
  await button(page, '쪽지 남기기').click()
  await expect(notes(page).getByRole('listitem')).toHaveCount(2)
  await expect(notes(page).getByRole('listitem').filter({ hasText: title })).toContainText('접수')
}

const sendFix = async (page: Page) => {
  await button(page, '개발자').click()
  await button(page, '수정 시작').click()
  page.once('dialog', async (dialog) => {
    expect(dialog.type()).toBe('confirm')
    expect(dialog.message()).toContain('1차')
    await dialog.accept()
  })
  await button(page, '1차 게시').click()
  await button(page, '고쳤어요 보내기').click()
  await expect(notes(page).getByRole('listitem').nth(1)).toContainText('확인 요청')
}

const approveDemo = async (page: Page) => {
  await button(page, '고객(승인자)').click()
  await button(page, '비교해 보기').click()
  await button(page, '확인 완료').click()
  await button(page, '버전 승인').click()
  const approval = page.getByRole('dialog', { name: '버전 승인', exact: true })
  await expect(approval).toContainText('미해결 쪽지 0개 · 확인 완료 2개')
  await approval.getByRole('button', { name: '승인 확정', exact: true }).click()
  await expect(page.getByRole('heading', { name: '1차 승인 완료', exact: true })).toBeVisible()
}

// focus()로 건너뛰지 않고 실제 Tab 순서로 도달하는지 확인한다.
const tabTo = async (page: Page, target: Locator) => {
  await expect(target).toBeVisible()
  for (let count = 0; count < 50; count++) {
    if (await target.evaluate((element) => element === document.activeElement)) {
      await expect(target).toBeInViewport()
      const box = (await target.boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width)
      return
    }
    await page.keyboard.press('Tab')
  }
  await expect(target).toBeFocused()
}

const pressWithKeyboard = async (page: Page, target: Locator) => {
  await tabTo(page, target)
  await page.keyboard.press('Enter')
}

test('공개 화면과 앱의 파비콘은 하이브리드 시안 마크다', async ({ page, request }) => {
  // 기획의 원본 좌표다. 구현 SVG를 기대값으로 가져오면 잘못 바뀐 도형을 놓친다.
  const reference = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" fill="none">' +
    '<circle cx="14" cy="14" r="14" fill="#d45b38"/>' +
    '<svg x="6" y="6" width="16" height="16" viewBox="0 0 18 18">' +
    '<rect x="2" y="2.5" width="14" height="13" rx="2.5" stroke="#fff" stroke-width="1.8"/>' +
    '<line x1="6.5" y1="2.5" x2="6.5" y2="15.5" stroke="#fff" stroke-width="1.6"/>' +
    '<circle cx="11.5" cy="9" r="2.2" fill="#fff"/></svg></svg>'

  for (const [path, iconPath] of [['/', '/favicon.svg'], ['/app/login', '/app/favicon.svg']]) {
    await page.goto(`${nginxOrigin}${path}`)
    await expect(page.locator('link[rel~="icon"]')).toHaveAttribute('href', iconPath)
    const headerIcon = page.locator('header img').first()
    await expect(headerIcon).toHaveAttribute('src', iconPath)
    await expect(headerIcon).toBeVisible()
    await expect(headerIcon).toHaveJSProperty('complete', true)
    expect(await headerIcon.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)
    const box = await headerIcon.boundingBox()
    expect(box).toMatchObject({ width: 28, height: 28 })
    const response = await request.get(`${nginxOrigin}${iconPath}`)
    expect(response.status()).toBe(200)
    const actual = await response.text()
    const renders = await page.evaluate(async ({ actual, reference }) => {
      const pixels = async (source: string, size: number) => {
        const image = new Image()
        image.src = `data:image/svg+xml,${encodeURIComponent(source)}`
        await image.decode()
        const canvas = document.createElement('canvas')
        canvas.width = size
        canvas.height = size
        const context = canvas.getContext('2d')!
        context.drawImage(image, 0, 0, size, size)
        return Array.from(context.getImageData(0, 0, size, size).data)
      }
      const results = []
      for (const size of [16, 32]) {
        const [rendered, expected] = await Promise.all([pixels(actual, size), pixels(reference, size)])
        results.push({ size, matches: rendered.every((value, index) => value === expected[index]) })
      }
      return results
    }, { actual, reference })
    expect(renders).toEqual([{ size: 16, matches: true }, { size: 32, matches: true }])
  }
})

test('비로그인 방문자는 소개와 직접 링크에서 데모를 연다', async ({ page, context }) => {
  const apiRequests: string[] = []
  context.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/')) apiRequests.push(request.url())
  })
  await page.goto(`${nginxOrigin}/`)
  await expect(page.getByRole('link', { name: '시작하기', exact: true })).toHaveAttribute('href', '/app/login')
  await page.getByRole('link', { name: '데모 체험하기', exact: true }).click()
  await expect(page).toHaveURL(`${nginxOrigin}/app/demo`)
  await expectInitialDemo(page)
  await expect(page.getByText(/이 탭에서만 진행되며 새로고침하면 처음으로 돌아갑니다/)).toBeVisible()
  await page.getByText('실제 서비스 사용 가이드', { exact: true }).click()
  await expect(page.getByText(/이 데모는 여기까지 준비된 상태에서 시작해요/)).toBeVisible()
  await page.goto('/app/demo')
  await expectInitialDemo(page)
  expect((await context.cookies()).filter((cookie) => cookie.name === 'sid')).toEqual([])
  expect(apiRequests).toEqual([])
})

test('실제 신규 프로젝트에서 가이드 순서로 이름표를 만들고 초안 사진을 게시한다', async ({ page, loginAs }) => {
  await resetDatabase()
  const developerEmail = process.env.DEVELOPER_EMAIL?.trim().toLowerCase()
  expect(developerEmail, '실제 프로젝트 생성 권한을 가진 테스트 개발자 설정이 필요하다').toBeTruthy()
  const developer = await createUser(developerEmail!, '가이드 개발자')
  await loginAs(developer.id)
  await page.goto('/app/')
  await page.getByLabel('프로젝트 이름', { exact: true }).fill('가이드로 만든 새 프로젝트')
  await button(page, '만들기').click()
  await expect(page).toHaveURL(/\/app\/projects\/[^/]+\/settings$/)
  await page.getByLabel('화면 이름', { exact: true }).fill('상품 상세')
  await page.getByRole('combobox', { name: '기기', exact: true }).selectOption('PC')
  await button(page, '만들기').click()
  await expect(page.getByText('상품 상세 · PC', { exact: true })).toBeVisible()
  await page.getByRole('navigation', { name: '프로젝트 메뉴' }).getByRole('link', { name: '버전 준비', exact: true }).click()
  await button(page, '초안 준비 시작').click()
  await page.getByLabel('상품 상세 · PC 사진 선택', { exact: true }).setInputFiles(
    fileURLToPath(new URL('../../web/src/assets/demo-before.webp', import.meta.url)),
  )
  await expect(page.getByRole('img', { name: '상품 상세 · PC', exact: true })).toBeVisible()
  page.once('dialog', async (dialog) => {
    expect(dialog.type()).toBe('confirm')
    expect(dialog.message()).toContain('초안으로 게시할까요?')
    await dialog.accept()
  })
  await button(page, '초안 게시').click()
  await expect(page).toHaveURL(/\/app\/projects\/[^/]+$/)
  const projectId = new URL(page.url()).pathname.split('/').at(-1)!
  const project = await db.project.findUniqueOrThrow({ where: { id: projectId }, include: { currentVersion: true } })
  expect(project.currentVersion).toMatchObject({ number: 0, status: 'IN_REVIEW' })
  const photo = page.getByRole('img', { name: '상품 상세 · PC', exact: true })
  await expect(photo).toBeVisible()
  await expect(photo).toHaveJSProperty('complete', true)
  expect(await photo.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)
  await page.reload()
  await expect(photo).toBeVisible()
  await expect(page.getByText('가이드로 만든 새 프로젝트', { exact: true }).first()).toBeVisible()
})

test('데모의 쪽지와 승인은 다른 방문자와 실제 계정에 반영되지 않는다', async ({ page, context, browser, baseURL, loginAs }) => {
  await resetDatabase()
  const developer = await createUser('demo-isolation@example.com', '실제 개발자')
  const project = await createProject(developer.id, '실제 프로젝트 보존')
  await loginAs(developer.id)
  await page.goto('/app/')
  await expect(page.getByRole('link', { name: project.name, exact: true })).toBeVisible()
  const realProject = await db.project.findUniqueOrThrow({ where: { id: project.id } })
  const visitorContext = await browser.newContext({ baseURL })
  const apiRequests: string[] = []
  for (const session of [context, visitorContext]) {
    session.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/')) apiRequests.push(request.url())
    })
  }
  try {
    const visitor = await visitorContext.newPage()
    const otherTab = await visitorContext.newPage()
    await page.goto('/app/demo')
    await visitor.goto('/app/demo')
    await otherTab.goto('/app/demo')
    await createNote(page, '회원의 구매 버튼 간격 요청')
    await sendFix(page)
    await approveDemo(page)
    await expectInitialDemo(visitor)
    await expectInitialDemo(otherTab)
    await createNote(visitor, '손님의 배송 안내 위치 요청')
    await sendFix(visitor)
    await approveDemo(visitor)
    await button(visitor, '검수 확인서 보기').click()
    const visitorCertificate = visitor.getByRole('dialog', { name: '검수 확인서', exact: true })
    await expect(visitorCertificate.getByRole('listitem')).toHaveText(['#1 배송 안내 문구 확인', '#2 손님의 배송 안내 위치 요청'])
    await expect(visitorCertificate).not.toContainText('회원의 구매 버튼 간격 요청')
    await visitorCertificate.getByRole('button', { name: '닫기', exact: true }).click()
    await button(visitor, '처음부터').click()
    await expectInitialDemo(visitor)
    await button(page, '검수 확인서 보기').click()
    await expect(page.getByRole('dialog', { name: '검수 확인서', exact: true }).getByRole('listitem')).toHaveText(['#1 배송 안내 문구 확인', '#2 회원의 구매 버튼 간격 요청'])
    await expectInitialDemo(otherTab)
    expect(apiRequests).toEqual([])
    expect(await db.project.findUniqueOrThrow({ where: { id: project.id } })).toEqual(realProject)
    expect(await db.user.count()).toBe(1)
    expect(await db.project.count()).toBe(1)
    for (const count of await Promise.all([
      db.issue.count(), db.approval.count(), db.deliveryVersion.count(), db.asset.count(),
      db.invitation.count(), db.notificationDelivery.count(), db.loginCode.count(),
    ])) expect(count).toBe(0)
    await page.goto('/app/')
    await expect(page.getByRole('link', { name: project.name, exact: true })).toBeVisible()
  } finally {
    await visitorContext.close()
  }
})

test('역할별 가이드를 따라 쪽지 작성부터 검수 확인서까지 체험한다', async ({ page }) => {
  await page.goto('/app/demo')
  await page.getByText('실제 서비스 사용 가이드', { exact: true }).click()
  const guide = page.locator('details')
  for (const action of ['초안 준비 시작', '사진 선택', '초안 게시', '쪽지 남기기', '수정 시작', '1차 게시', '고쳤어요 보내기', '비교해 보기', '버전 승인', '검수 확인서 보기']) {
    await expect(guide).toContainText(action)
  }
  await page.getByText('실제 서비스 사용 가이드', { exact: true }).click()
  const before = page.getByRole('img', { name: '수정 전 상품 상세 사진', exact: true })
  await expect(before).toHaveJSProperty('complete', true)
  const box = (await before.boundingBox())!
  await before.click({ position: { x: box.width * 0.76, y: box.height * 0.53 } })
  await expect(page.getByRole('img', { name: '새 쪽지 위치' })).toBeVisible()
  await page.getByLabel('제목 (필수)').fill(noteTitle)
  await page.getByLabel('내용', { exact: true }).fill('구매 버튼을 누르기 편하게 해 주세요.')
  await button(page, '쪽지 남기기').click()
  const pin = button(page, `쪽지 #2 ${noteTitle}`)
  await expect(pin).toBeVisible()
  const pinPosition = await pin.evaluate((element) => ({ x: (element as HTMLElement).style.left, y: (element as HTMLElement).style.top }))
  expect(parseFloat(pinPosition.x)).toBeCloseTo(76, 0)
  expect(parseFloat(pinPosition.y)).toBeCloseTo(53, 0)
  await expect(notes(page).getByRole('listitem').nth(1)).toContainText('접수')
  await sendFix(page)
  await button(page, '고객(승인자)').click()
  await button(page, '비교해 보기').click()
  const after = page.getByRole('img', { name: '구매 버튼 위 여백을 넓힌 상품 상세 사진', exact: true })
  for (const image of [before, after]) {
    await expect(image).toBeVisible()
    await expect(image).toHaveJSProperty('complete', true)
    expect(await image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0)
  }
  expect(await before.getAttribute('src')).not.toBe(await after.getAttribute('src'))
  // 핀이나 설명 글의 차이가 아니라 이미지 자체의 픽셀이 달라야 한다.
  const photoPixels = await before.or(after).evaluateAll((elements) =>
    elements.map((element) => {
      const image = element as HTMLImageElement
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext('2d')!
      context.drawImage(image, 0, 0)
      return canvas.toDataURL()
    }),
  )
  expect(photoPixels).toHaveLength(2)
  expect(photoPixels[0] === photoPixels[1]).toBe(false)
  await expect(pin).toBeVisible()
  await expect(page.getByText('처음 사진 · 초안', { exact: true })).toBeVisible()
  await expect(page.getByText('고친 사진 · 1차', { exact: true })).toBeVisible()
  await button(page, '확인 완료').click()
  await expect(notes(page).getByRole('listitem').nth(1)).toContainText('확인 완료')
  await button(page, '버전 승인').click()
  const approval = page.getByRole('dialog', { name: '버전 승인', exact: true })
  await expect(approval).toContainText('미해결 쪽지 0개 · 확인 완료 2개')
  await approval.getByRole('button', { name: '승인 확정', exact: true }).click()
  await button(page, '검수 확인서 보기').click()
  const certificate = page.getByRole('dialog', { name: '검수 확인서', exact: true })
  await expect(certificate).toContainText('오브제 스토어 리뉴얼 · 1차')
  await expect(certificate).toContainText('개발자 김서진 · 승인자 박지민')
  await expect(certificate).toContainText('승인 당시 확인 완료 2개')
  await expect(certificate.getByRole('listitem')).toHaveText(['#1 배송 안내 문구 확인', `#2 ${noteTitle}`])
})

test('역할과 미해결 쪽지가 승인을 제한하고 중복 클릭은 한 번만 반영된다', async ({ page }) => {
  await page.goto('/app/demo')
  const before = page.getByRole('img', { name: '수정 전 상품 상세 사진', exact: true })
  const after = page.getByRole('img', { name: '구매 버튼 위 여백을 넓힌 상품 상세 사진', exact: true })
  const draftCaption = page.getByText('초안 · 상품 상세 · PC', { exact: true })
  const previewCaption = page.getByText('1차 게시 전 미리보기 · 상품 상세 · PC', { exact: true })
  const publishedCaption = page.getByText('1차 · 상품 상세 · PC', { exact: true })
  await button(page, '개발자').click()
  await expect(page.getByRole('status')).toContainText('첫 쪽지는 고객이 남겨요')
  await expect(button(page, '쪽지 남기기')).toHaveCount(0)
  await expect(button(page, '버전 승인')).toHaveCount(0)
  await button(page, '고객(승인자)').click()
  await page.getByLabel('제목 (필수)').fill(noteTitle)
  await expect(button(page, '쪽지 남기기')).toBeDisabled()
  await button(page, '구매 버튼 위치 선택').click()
  await page.getByLabel('제목 (필수)').fill('   ')
  await expect(button(page, '쪽지 남기기')).toBeDisabled()
  await page.getByLabel('제목 (필수)').fill(noteTitle)
  // 같은 이벤트 루프에서 두 번 눌러 화면이 다시 그려지기 전의 연타도 확인한다.
  await button(page, '쪽지 남기기').evaluate((element: HTMLButtonElement) => { element.click(); element.click() })
  await expect(notes(page).getByRole('listitem')).toHaveCount(2)
  await expect(button(page, '수정 시작')).toBeDisabled()
  await expect(button(page, '버전 승인')).toHaveCount(0)
  await button(page, '개발자').click()
  await button(page, '수정 시작').evaluate((element: HTMLButtonElement) => { element.click(); element.click() })
  await expect(notes(page).getByRole('listitem').nth(1)).toContainText('수정 중')
  await expect(button(page, '고쳤어요 보내기')).toHaveCount(0)
  await expect(after).toBeVisible()
  await expect(before).toHaveCount(0)
  await expect(previewCaption).toBeVisible()
  await expect(draftCaption).toHaveCount(0)
  await expect(publishedCaption).toHaveCount(0)
  await button(page, '고객(승인자)').click()
  await expect(button(page, '1차 게시')).toBeDisabled()
  await expect(before).toBeVisible()
  await expect(after).toHaveCount(0)
  await expect(draftCaption).toBeVisible()
  await expect(previewCaption).toHaveCount(0)
  await expect(publishedCaption).toHaveCount(0)
  await button(page, '개발자').click()
  page.once('dialog', (dialog) => dialog.dismiss())
  await button(page, '1차 게시').click()
  await expect(button(page, '1차 게시')).toBeEnabled()
  await expect(button(page, '고쳤어요 보내기')).toHaveCount(0)
  await expect(after).toBeVisible()
  await expect(before).toHaveCount(0)
  await expect(previewCaption).toBeVisible()
  await expect(draftCaption).toHaveCount(0)
  await expect(publishedCaption).toHaveCount(0)
  await button(page, '고객(승인자)').click()
  await expect(button(page, '1차 게시')).toBeDisabled()
  await expect(before).toBeVisible()
  await expect(after).toHaveCount(0)
  await expect(draftCaption).toBeVisible()
  await expect(previewCaption).toHaveCount(0)
  await expect(publishedCaption).toHaveCount(0)
  await button(page, '개발자').click()
  page.once('dialog', (dialog) => dialog.accept())
  await button(page, '1차 게시').click()
  await expect(after).toBeVisible()
  await expect(before).toHaveCount(0)
  await expect(publishedCaption).toBeVisible()
  await expect(previewCaption).toHaveCount(0)
  await expect(draftCaption).toHaveCount(0)
  await button(page, '고객(승인자)').click()
  await expect(after).toBeVisible()
  await expect(before).toHaveCount(0)
  await expect(publishedCaption).toBeVisible()
  await expect(previewCaption).toHaveCount(0)
  await expect(draftCaption).toHaveCount(0)
  await expect(button(page, '고쳤어요 보내기')).toBeDisabled()
  await expect(button(page, '버전 승인')).toHaveCount(0)
  await button(page, '개발자').click()
  await button(page, '고쳤어요 보내기').evaluate((element: HTMLButtonElement) => { element.click(); element.click() })
  await expect(button(page, '비교해 보기')).toBeDisabled()
  await button(page, '고객(승인자)').click()
  await button(page, '비교해 보기').evaluate((element: HTMLButtonElement) => { element.click(); element.click() })
  await expect(notes(page).getByRole('listitem').nth(1)).toContainText('확인 요청')
  await expect(button(page, '버전 승인')).toHaveCount(0)
  await button(page, '개발자').click()
  await expect(button(page, '확인 완료')).toBeDisabled()
  await button(page, '고객(승인자)').click()
  await button(page, '확인 완료').evaluate((element: HTMLButtonElement) => { element.click(); element.click() })
  await expect(button(page, '검수 확인서 보기')).toHaveCount(0)
  await button(page, '개발자').click()
  await expect(button(page, '버전 승인')).toBeDisabled()
  await button(page, '고객(승인자)').click()
  await button(page, '버전 승인').click()
  await button(page, '취소').click()
  await expect(button(page, '검수 확인서 보기')).toHaveCount(0)
  await button(page, '버전 승인').click()
  await button(page, '승인 확정').evaluate((element: HTMLButtonElement) => { element.click(); element.click() })
  await expect(page.getByRole('heading', { name: '1차 승인 완료', exact: true })).toHaveCount(1)
  await expect(notes(page).getByRole('listitem')).toHaveCount(2)
  await button(page, '검수 확인서 보기').click()
  await expect(page.getByRole('dialog', { name: '검수 확인서', exact: true }).getByRole('listitem')).toHaveCount(2)
})

test('승인 후에는 읽기 전용이고 다시 시작하거나 새로고침하면 샘플로 돌아간다', async ({ page }) => {
  await page.goto('/app/demo')
  await createNote(page)
  await sendFix(page)
  await approveDemo(page)
  await button(page, '검수 확인서 보기').click()
  const certificate = page.getByRole('dialog', { name: '검수 확인서', exact: true })
  const approvedText = await certificate.innerText()
  await certificate.getByRole('button', { name: '닫기', exact: true }).click()
  for (const role of ['개발자', '고객(승인자)']) {
    await button(page, role).click()
    await page.getByRole('img', { name: '구매 버튼 위 여백을 넓힌 상품 상세 사진', exact: true }).click()
    await expect(page.getByRole('img', { name: '새 쪽지 위치' })).toHaveCount(0)
    await expect(page.getByRole('textbox')).toHaveCount(0)
    for (const name of ['쪽지 남기기', '수정 시작', '1차 게시', '고쳤어요 보내기', '확인 완료', '버전 승인']) {
      await expect(button(page, name)).toHaveCount(0)
    }
    await button(page, '검수 확인서 보기').click()
    await expect(certificate).toHaveText(approvedText, { useInnerText: true })
    await certificate.getByRole('button', { name: '닫기', exact: true }).click()
  }
  await button(page, '처음부터').click()
  await expectInitialDemo(page)
  await createNote(page, '재시작 뒤 새 쪽지')
  await expect(notes(page)).not.toContainText(noteTitle)
  await sendFix(page)
  await approveDemo(page)
  await button(page, '검수 확인서 보기').click()
  await expect(certificate).toContainText('재시작 뒤 새 쪽지')
  await expect(certificate).not.toContainText(noteTitle)
  await page.reload()
  await expectInitialDemo(page)
  await expect(certificate).toHaveCount(0)
  await createNote(page, '새로고침 뒤 새 쪽지')
  await expect(notes(page)).not.toContainText('재시작 뒤 새 쪽지')
})

test('390px와 키보드에서 가이드와 필수 동작을 이용한다', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/app/demo')
  const guide = page.getByText('실제 서비스 사용 가이드', { exact: true })
  await pressWithKeyboard(page, guide)
  await expect(page.getByText(/이 데모는 여기까지 준비된 상태에서 시작해요/)).toBeVisible()
  await pressWithKeyboard(page, guide)
  await pressWithKeyboard(page, button(page, '구매 버튼 위치 선택'))
  const draftPin = page.getByRole('img', { name: '새 쪽지 위치' })
  await expect(draftPin).toBeVisible()
  expect(await draftPin.evaluate((element) => ({
    x: (element as HTMLElement).style.left,
    y: (element as HTMLElement).style.top,
  }))).toEqual({ x: '76%', y: '53%' })
  await tabTo(page, page.getByLabel('제목 (필수)'))
  await page.keyboard.insertText(noteTitle)
  await tabTo(page, page.getByLabel('내용', { exact: true }))
  await page.keyboard.insertText('휴대폰에서 구매 버튼 간격을 확인해 주세요.')
  await pressWithKeyboard(page, button(page, '쪽지 남기기'))
  await pressWithKeyboard(page, button(page, '개발자'))
  await pressWithKeyboard(page, button(page, '수정 시작'))
  await expect(page.getByText(/샘플 사진을 준비했어요/)).toBeVisible()
  page.once('dialog', (dialog) => dialog.accept())
  await pressWithKeyboard(page, button(page, '1차 게시'))
  await pressWithKeyboard(page, button(page, '고쳤어요 보내기'))
  await pressWithKeyboard(page, button(page, '고객(승인자)'))
  await pressWithKeyboard(page, button(page, '비교해 보기'))
  await expect(page.getByRole('img', { name: '수정 전 상품 상세 사진', exact: true })).toBeVisible()
  await expect(page.getByRole('img', { name: '구매 버튼 위 여백을 넓힌 상품 상세 사진', exact: true })).toBeVisible()
  await expect(button(page, `쪽지 #2 ${noteTitle}`)).toBeVisible()
  await testInfo.attach('390px-compare', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
  await pressWithKeyboard(page, button(page, '확인 완료'))
  await pressWithKeyboard(page, button(page, '버전 승인'))
  await pressWithKeyboard(page, button(page, '승인 확정'))
  await pressWithKeyboard(page, button(page, '검수 확인서 보기'))
  const certificate = page.getByRole('dialog', { name: '검수 확인서', exact: true })
  await expect(certificate).toContainText(noteTitle)
  await expect(certificate).toContainText('승인 당시 확인 완료 2개')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await testInfo.attach('390px-certificate', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
  await page.keyboard.press('Escape')
  await expect(certificate).toHaveCount(0)
  await pressWithKeyboard(page, button(page, '처음부터'))
  await expectInitialDemo(page)
})
