import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { test, expect, db, resetDatabase, createUser, createProject } from './fixtures.ts'

const sharp = createRequire(new URL('../../api/package.json', import.meta.url))('sharp')
const issueTitle = '긴 쪽지를 읽으면서 사진의 여백을 확인해 주세요'

test.beforeEach(async ({ page, loginAs }) => {
  await resetDatabase()
  const developer = await createUser('developer@example.com', '개발자')
  const client = await createUser('client@example.com', '검수 고객')
  const project = await createProject(developer.id, 'CSS 마감 검수')
  await db.projectMember.create({ data: { projectId: project.id, userId: client.id, role: 'CLIENT' } })
  const screen = await db.screen.create({ data: { projectId: project.id, name: '메인', viewport: 'PC' } })
  const version = await db.deliveryVersion.create({
    data: { projectId: project.id, number: 0, status: 'IN_REVIEW', publishedAt: new Date() },
  })
  const storageKey = `${project.id}/${randomUUID()}.png`
  const photo: Buffer = await sharp({
    create: { width: 1200, height: 600, channels: 3, background: '#ffffff' },
  }).png().toBuffer()
  await mkdir(new URL(`../.assets/${project.id}/`, import.meta.url), { recursive: true })
  await writeFile(new URL(`../.assets/${storageKey}`, import.meta.url), photo, { flag: 'wx' })
  const asset = await db.asset.create({
    data: { projectId: project.id, storageKey, mime: 'image/png', bytes: photo.length, width: 1200, height: 600 },
  })
  const versionScreen = await db.versionScreen.create({
    data: { versionId: version.id, screenId: screen.id, assetId: asset.id },
  })
  await db.project.update({ where: { id: project.id }, data: { currentVersionId: version.id } })
  await db.issue.create({
    data: {
      projectId: project.id,
      originVersionId: version.id,
      originVersionScreenId: versionScreen.id,
      authorId: client.id,
      number: 1,
      title: issueTitle,
      // 실제 상세 내용으로 문서를 길게 만든다. CSS나 가짜 여백을 주입하지 않는다.
      body: Array.from({ length: 60 }, (_, index) => `${index + 1}. 사진과 비교하며 이 부분의 여백을 확인해 주세요.`).join('\n'),
      xRatio: 0.3,
      yRatio: 0.4,
      requestId: randomUUID(),
    },
  })
  await loginAs(client.id)
  await page.goto(`/app/projects/${project.id}`)
})

for (const viewport of [{ width: 960, height: 800 }, { width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  const behavior = viewport.width >= 960 ? '뷰포트에 붙어 있다' : '문서와 함께 스크롤된다'
  test(`${viewport.width}px에서 카드 줄 배치가 유지되고 긴 쪽지를 읽을 때 사진·필름스트립이 ${behavior}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    const photo = page.getByRole('img', { name: '메인 · PC', exact: true })
    await expect(photo).toBeVisible()
    await expect.poll(() => photo.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true)
    await page.evaluate(() => document.fonts.ready.then(() => undefined))

    const list = page.getByRole('region', { name: '쪽지 목록', exact: true })
    const card = list.getByRole('button', { name: new RegExp(issueTitle) })
    await card.scrollIntoViewIfNeeded()
    const number = (await card.getByText('#1', { exact: true }).boundingBox())!
    const status = (await card.locator('[data-status="OPEN"]').boundingBox())!
    const title = (await card.getByText(issueTitle, { exact: true }).boundingBox())!
    const category = (await card.getByText('버그', { exact: true }).boundingBox())!
    const origin = (await card.getByText(/댓글 0개/).boundingBox())!
    expect(Math.abs(number.y + number.height / 2 - status.y - status.height / 2)).toBeLessThanOrEqual(1)
    expect(number.x + number.width).toBeLessThanOrEqual(status.x)
    expect(title.y).toBeGreaterThanOrEqual(Math.max(number.y + number.height, status.y + status.height))
    expect(category.y).toBeGreaterThanOrEqual(title.y + title.height)
    expect(origin.y).toBeGreaterThanOrEqual(category.y + category.height)
    expect(Math.abs(title.x - number.x)).toBeLessThanOrEqual(1)
    expect(Math.abs(category.x - title.x)).toBeLessThanOrEqual(1)
    expect(Math.abs(origin.x - title.x)).toBeLessThanOrEqual(1)

    await card.click()
    const detail = page.getByRole('article', { name: '쪽지 #1', exact: true })
    await expect(detail.getByRole('heading', { name: issueTitle, exact: true })).toBeVisible()
    await expect(detail.getByText(/60\. 사진/)).toBeVisible()
    const toggle = page.getByRole('button', { name: /^(접기|펼치기)$/ })
    const strip = toggle.locator('..')

    for (const stripHeight of [82, 42]) {
      await page.evaluate(() => window.scrollTo(0, 0))
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
      if (stripHeight === 42) await toggle.click()
      await expect.poll(async () => (await strip.boundingBox())?.height).toBe(stripHeight)
      await expect(toggle).toHaveText(stripHeight === 82 ? '접기' : '펼치기')
      // click의 자동 스크롤 영향을 없앤 뒤 문서 스크롤만 비교한다.
      await page.evaluate(() => window.scrollTo(0, 0))
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
      const initialPhoto = (await photo.boundingBox())!
      const initialStrip = (await strip.boundingBox())!

      await page.evaluate(() => window.scrollTo(0, 400))
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(400)
      const firstPhoto = (await photo.boundingBox())!
      const firstStrip = (await strip.boundingBox())!
      const firstDetail = (await detail.boundingBox())!
      await page.evaluate(() => window.scrollTo(0, 800))
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(800)
      const nextPhoto = (await photo.boundingBox())!
      const nextStrip = (await strip.boundingBox())!
      const nextDetail = (await detail.boundingBox())!
      expect(Math.abs(firstDetail.y - nextDetail.y - 400)).toBeLessThanOrEqual(1)
      expect(nextStrip.height).toBe(stripHeight)

      if (viewport.width >= 960) {
        for (const box of [firstPhoto, nextPhoto, firstStrip, nextStrip]) {
          expect(box.y).toBeGreaterThanOrEqual(0)
          expect(box.y + box.height).toBeLessThanOrEqual(viewport.height)
          expect(box.x).toBeGreaterThanOrEqual(0)
          expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
        }
        expect(Math.abs(firstPhoto.y - nextPhoto.y)).toBeLessThanOrEqual(1)
        expect(Math.abs(firstStrip.y - nextStrip.y)).toBeLessThanOrEqual(1)
        expect(nextPhoto.y + nextPhoto.height).toBeLessThanOrEqual(nextStrip.y)
        continue
      }

      expect(Math.abs(initialPhoto.y - firstPhoto.y - 400)).toBeLessThanOrEqual(1)
      expect(Math.abs(initialStrip.y - firstStrip.y - 400)).toBeLessThanOrEqual(1)
      expect(Math.abs(firstPhoto.y - nextPhoto.y - 400)).toBeLessThanOrEqual(1)
      expect(Math.abs(firstStrip.y - nextStrip.y - 400)).toBeLessThanOrEqual(1)
      expect(nextPhoto.y + nextPhoto.height).toBeLessThan(0)
      expect(nextStrip.y + nextStrip.height).toBeLessThan(0)
    }
  })
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 1366, height: 768 }]) {
  test(`${viewport.width}×${viewport.height}에서 20줄 설명과 긴 쪽지를 함께 읽어도 사진과 필름스트립을 사용할 수 있다`, async ({ page }) => {
    await page.setViewportSize(viewport)
    const summaryText = Array.from({ length: 20 }, (_, index) => `${index + 1}. 이번 버전의 화면 여백과 글자 크기를 확인해 주세요.`).join('\n')
    // 설명의 허용 길이(1000자) 안에서 기존 긴 쪽지 픽스처와 함께 재현한다.
    expect(summaryText.length).toBeLessThanOrEqual(1000)
    const projectId = new URL(page.url()).pathname.split('/').at(-1)!
    const updated = await db.deliveryVersion.updateMany({
      where: { projectId, number: 0 },
      data: { summary: summaryText },
    })
    expect(updated.count).toBe(1)
    await page.reload()

    const summary = page.getByText(summaryText, { exact: true })
    const photo = page.getByRole('img', { name: '메인 · PC', exact: true })
    await expect(summary).toHaveText(summaryText)
    await expect(photo).toBeVisible()
    await expect.poll(() => photo.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true)
    await page.evaluate(() => document.fonts.ready.then(() => undefined))
    await page.getByRole('region', { name: '쪽지 목록', exact: true })
      .getByRole('button', { name: new RegExp(issueTitle) }).click()
    const detail = page.getByRole('article', { name: '쪽지 #1', exact: true })
    await expect(detail.getByRole('heading', { name: issueTitle, exact: true })).toBeVisible()
    await expect(detail.getByText(/60\. 사진/)).toBeVisible()
    const toggle = page.getByRole('button', { name: /^(접기|펼치기)$/ })
    const strip = toggle.locator('..')

    for (const stripHeight of [82, 42]) {
      await page.evaluate(() => window.scrollTo(0, 800))
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(800)
      await expect(photo).toBeInViewport()
      await expect(strip).toBeInViewport({ ratio: 1 })
      const stripBox = (await strip.boundingBox())!
      expect(stripBox.height).toBe(stripHeight)
      expect(stripBox.x).toBeGreaterThanOrEqual(0)
      expect(stripBox.x + stripBox.width).toBeLessThanOrEqual(viewport.width)
      expect(stripBox.y).toBeGreaterThanOrEqual(0)
      expect(stripBox.y + stripBox.height).toBeLessThanOrEqual(viewport.height)
      await expect(toggle).toHaveText(stripHeight === 82 ? '접기' : '펼치기')

      // locator.click의 자동 스크롤 없이 현재 보이는 버튼을 실제로 누른다.
      await expect(toggle).toBeInViewport({ ratio: 1 })
      const toggleBox = (await toggle.boundingBox())!
      await page.mouse.click(toggleBox.x + toggleBox.width / 2, toggleBox.y + toggleBox.height / 2)
      await expect(toggle).toHaveText(stripHeight === 82 ? '펼치기' : '접기')
      await expect(toggle).toHaveAttribute('aria-expanded', stripHeight === 82 ? 'false' : 'true')
      await expect.poll(async () => (await strip.boundingBox())?.height).toBe(stripHeight === 82 ? 42 : 82)
      await expect(strip).toBeInViewport({ ratio: 1 })
      await expect(photo).toBeInViewport()
    }

    // 글자가 DOM에 있는지만 보지 않고, 휠로 마지막 줄까지 읽을 수 있는지 확인한다.
    await summary.hover()
    await page.mouse.wheel(0, 1000)
    await expect.poll(() => summary.evaluate((element) => {
      const text = element.firstChild!
      const range = document.createRange()
      range.selectNodeContents(element)
      range.setStart(text, text.textContent!.lastIndexOf('\n') + 1)
      const line = range.getBoundingClientRect()
      const box = element.getBoundingClientRect()
      const hit = document.elementFromPoint(line.x + line.width / 2, line.y + line.height / 2)
      return line.height > 0 && line.top >= Math.max(0, box.top)
        && line.bottom <= Math.min(window.innerHeight, box.bottom)
        && line.left >= 0 && line.right <= window.innerWidth
        && hit !== null && element.contains(hit)
    })).toBe(true)
  })
}
