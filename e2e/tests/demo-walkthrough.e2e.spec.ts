import type { Page } from '@playwright/test'
import { test, expect } from './fixtures.ts'

const noteTitle = '구매 버튼 간격을 넓혀 주세요'
const nextTask = (page: Page) => page.getByRole('region', { name: '지금 할 일', exact: true })
const guide = (page: Page) => page.getByRole('complementary', { name: '체험 가이드', exact: true })
const button = (page: Page, name: string) => guide(page).getByRole('button', { name, exact: true })

const expectLocationTask = async (page: Page) => {
  await expect(nextTask(page)).toContainText('1/3 · 수정 요청')
  await expect(nextTask(page)).toContainText('구매 버튼')
  await expect(nextTask(page)).toContainText(/위치|사진/)
  await expect(nextTask(page)).toContainText(/선택|고르|골라|누르|눌러/)
  await expect(nextTask(page)).not.toContainText('쪽지 남기기')
  await expect(button(page, '쪽지 남기기')).toBeDisabled()
}

const createNote = async (page: Page) => {
  await button(page, '구매 버튼 위치 선택').click()
  await guide(page).getByLabel('제목 (필수)').fill(noteTitle)
  await button(page, '쪽지 남기기').click()
  await expect(guide(page).getByRole('list', { name: '쪽지 목록' }).getByRole('listitem')).toHaveCount(2)
  await expect(nextTask(page)).toContainText('2/3 · 수정 반영')
}

test.describe('데모 사용법', () => {
  test('PC와 모바일 첫 화면에서 사진보다 먼저 할 일을 본다', async ({ page, context }) => {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport)
      await page.goto('/app/demo')
      const task = nextTask(page)
      const intro = page.getByText(/이 탭에서만 진행되며 새로고침하면 처음으로 돌아갑니다/)
      const photo = page.getByRole('img', { name: '수정 전 상품 상세 사진', exact: true })
      await expect(photo).toHaveJSProperty('complete', true)
      expect(await photo.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)
      await expectLocationTask(page)
      await expect(task).toBeInViewport({ ratio: 1 })
      const taskBox = (await task.boundingBox())!
      const introBox = (await intro.boundingBox())!
      const photoBox = (await photo.boundingBox())!
      expect(taskBox.y).toBeGreaterThanOrEqual(introBox.y + introBox.height)
      expect(taskBox.y + taskBox.height).toBeLessThanOrEqual(photoBox.y)
      expect(taskBox.x).toBeGreaterThanOrEqual(0)
      expect(taskBox.x + taskBox.width).toBeLessThanOrEqual(viewport.width)
      expect(await intro.evaluate((element, taskElement) =>
        Boolean(element.compareDocumentPosition(taskElement!) & Node.DOCUMENT_POSITION_FOLLOWING),
      await task.elementHandle())).toBe(true)
      expect(await task.evaluate((element, photoElement) =>
        Boolean(element.compareDocumentPosition(photoElement!) & Node.DOCUMENT_POSITION_FOLLOWING),
      await photo.elementHandle())).toBe(true)
      expect(await page.evaluate(() => window.scrollY)).toBe(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width)
      expect((await context.cookies()).filter((cookie) => cookie.name === 'sid')).toEqual([])
    }
  })

  test('위치와 필수 제목에 맞춰 다음 행동을 안내한다', async ({ page }) => {
    await page.goto('/app/demo')
    const title = guide(page).getByLabel('제목 (필수)')
    const body = guide(page).getByLabel('내용', { exact: true })
    const draftPin = page.getByRole('img', { name: '새 쪽지 위치' })
    await expectLocationTask(page)

    // 제목이나 예시 쪽지를 먼저 골라도 새 위치를 선택한 것은 아니다.
    await title.fill(noteTitle)
    await expectLocationTask(page)
    await page.getByRole('button', { name: '쪽지 #1 배송 안내 문구 확인', exact: true }).click()
    await expect(guide(page)).toContainText('#1은 고객이 배송 안내를 확인한 예시 쪽지')
    await expect(draftPin).toHaveCount(0)
    await expectLocationTask(page)

    await title.fill('   ')
    await expectLocationTask(page)
    await button(page, '구매 버튼 위치 선택').click()
    await expect(draftPin).toBeVisible()
    await expect(nextTask(page)).toContainText('1/3 · 수정 요청')
    await expect(nextTask(page)).toContainText('제목')
    await expect(nextTask(page)).toContainText(/입력|적|써|쓰/)
    await expect(nextTask(page)).not.toContainText('쪽지 남기기')
    await expect(button(page, '쪽지 남기기')).toBeDisabled()

    await title.fill(`  ${noteTitle}  `)
    await expect(nextTask(page)).toContainText('쪽지 남기기')
    await expect(button(page, '쪽지 남기기')).toBeEnabled()
    await title.fill('')
    await expect(nextTask(page)).toContainText('제목')
    await expect(nextTask(page)).not.toContainText('쪽지 남기기')
    await expect(button(page, '쪽지 남기기')).toBeDisabled()
    await title.fill(noteTitle)
    await expect(nextTask(page)).toContainText('쪽지 남기기')
    await expect(body).toHaveValue('')
    await button(page, '쪽지 남기기').click()
    await expect(nextTask(page)).toContainText('2/3 · 수정 반영')
    await expect(guide(page).getByRole('list', { name: '쪽지 목록' })).toContainText(noteTitle)

    // 대체 버튼뿐 아니라 사진의 구매 버튼 자리를 눌러도 같은 안내를 따른다.
    await page.getByRole('button', { name: '처음부터', exact: true }).click()
    await expectLocationTask(page)
    const photo = page.getByRole('img', { name: '수정 전 상품 상세 사진', exact: true })
    await expect(photo).toHaveJSProperty('complete', true)
    const photoBox = (await photo.boundingBox())!
    await photo.click({ position: { x: photoBox.width * 0.76, y: photoBox.height * 0.53 } })
    await expect(draftPin).toBeVisible()
    await expect(nextTask(page)).toContainText('제목')
    await expect(nextTask(page)).not.toContainText('쪽지 남기기')
    await expect(button(page, '쪽지 남기기')).toBeDisabled()
    await title.fill(noteTitle)
    await expect(nextTask(page)).toContainText('쪽지 남기기')
    await expect(button(page, '쪽지 남기기')).toBeEnabled()
    await button(page, '쪽지 남기기').click()
    await expect(nextTask(page)).toContainText('2/3 · 수정 반영')
  })

  test('역할 전환과 게시 취소를 실제 수정 단계에 맞춰 안내한다', async ({ page }) => {
    await page.goto('/app/demo')
    await button(page, '개발자').click()
    await expect(nextTask(page)).toContainText('1/3 · 수정 요청')
    await expect(nextTask(page)).toContainText('내 역할')
    await expect(nextTask(page)).toContainText('고객(승인자)')
    await expect(nextTask(page)).toContainText(/선택|바꾸|전환/)
    await expect(button(page, '쪽지 남기기')).toHaveCount(0)
    await button(page, '고객(승인자)').click()
    await createNote(page)

    for (const action of ['수정 시작', '1차 게시', '고쳤어요 보내기']) {
      await expect(nextTask(page)).toContainText('2/3 · 수정 반영')
      await expect(nextTask(page)).toContainText('내 역할')
      await expect(nextTask(page)).toContainText('개발자')
      await expect(nextTask(page)).toContainText(/선택|바꾸|전환/)
      await expect(button(page, action)).toBeDisabled()
      await button(page, '개발자').click()
      await expect(button(page, '개발자')).toHaveAttribute('aria-pressed', 'true')
      await expect(nextTask(page)).toContainText(action)
      await expect(button(page, action)).toBeEnabled()
      if (action === '1차 게시') {
        page.once('dialog', async (dialog) => {
          expect(dialog.type()).toBe('confirm')
          expect(dialog.message()).toContain('1차')
          await dialog.dismiss()
        })
        await button(page, action).click()
        await expect(nextTask(page)).toContainText('2/3 · 수정 반영')
        await expect(nextTask(page)).toContainText('1차 게시')
        await expect(nextTask(page)).not.toContainText('고쳤어요 보내기')
        await expect(button(page, '1차 게시')).toBeEnabled()
        await expect(button(page, '고쳤어요 보내기')).toHaveCount(0)
        await expect(page.getByText('1차 게시 전 미리보기 · 상품 상세 · PC', { exact: true })).toBeVisible()
        page.once('dialog', (dialog) => dialog.accept())
      }
      await button(page, action).click()
      if (action !== '고쳤어요 보내기') await button(page, '고객(승인자)').click()
    }
    await expect(nextTask(page)).toContainText('3/3 · 비교와 승인')
    await expect(nextTask(page)).toContainText('내 역할')
    await expect(nextTask(page)).toContainText('고객(승인자)')
    await expect(button(page, '비교해 보기')).toBeDisabled()
    await button(page, '고객(승인자)').click()
    await expect(nextTask(page)).toContainText('비교해 보기')
    await expect(button(page, '비교해 보기')).toBeEnabled()
  })

  test('비교와 승인부터 확인서와 초기화까지 안내가 이어진다', async ({ page }) => {
    await page.goto('/app/demo')
    await createNote(page)
    await button(page, '개발자').click()
    await button(page, '수정 시작').click()
    page.once('dialog', (dialog) => dialog.accept())
    await button(page, '1차 게시').click()
    await button(page, '고쳤어요 보내기').click()
    await button(page, '고객(승인자)').click()
    await expect(nextTask(page)).toContainText('3/3 · 비교와 승인')
    await expect(nextTask(page)).toContainText('비교해 보기')
    await button(page, '비교해 보기').click()
    await expect(nextTask(page)).toContainText('3/3 · 비교와 승인')
    await expect(nextTask(page)).toContainText('구매 버튼')
    await expect(nextTask(page)).toContainText(/여백|간격/)
    await expect(nextTask(page)).toContainText(/비교/)
    await expect(nextTask(page)).toContainText('확인 완료')
    await expect(page.getByRole('img', { name: '수정 전 상품 상세 사진', exact: true })).toBeVisible()
    await expect(page.getByRole('img', { name: '구매 버튼 위 여백을 넓힌 상품 상세 사진', exact: true })).toBeVisible()

    for (const action of ['확인 완료', '버전 승인']) {
      await button(page, '개발자').click()
      await expect(nextTask(page)).toContainText('3/3 · 비교와 승인')
      await expect(nextTask(page)).toContainText('내 역할')
      await expect(nextTask(page)).toContainText('고객(승인자)')
      await expect(nextTask(page)).toContainText(/선택|바꾸|전환/)
      await expect(button(page, action)).toBeDisabled()
      await button(page, '고객(승인자)').click()
      await expect(nextTask(page)).toContainText(action)
      await expect(button(page, action)).toBeEnabled()
      await button(page, action).click()
    }
    const approval = page.getByRole('dialog', { name: '버전 승인', exact: true })
    await expect(approval).toContainText('미해결 쪽지 0개 · 확인 완료 2개')
    await approval.getByRole('button', { name: '취소', exact: true }).click()
    await expect(approval).toHaveCount(0)
    await expect(nextTask(page)).toContainText('3/3 · 비교와 승인')
    await expect(nextTask(page)).toContainText('버전 승인')
    await expect(nextTask(page)).not.toContainText('체험 완료')
    await expect(nextTask(page)).not.toContainText('검수 확인서 보기')
    await expect(button(page, '버전 승인')).toBeEnabled()
    await expect(button(page, '검수 확인서 보기')).toHaveCount(0)
    await button(page, '버전 승인').click()
    await approval.getByRole('button', { name: '승인 확정', exact: true }).click()
    await expect(approval).toHaveCount(0)
    await expect(nextTask(page)).toContainText('체험 완료')
    await expect(nextTask(page)).toContainText('검수 확인서 보기')
    await expect(nextTask(page)).not.toContainText('3/3 · 비교와 승인')
    await expect(button(page, '검수 확인서 보기')).toBeEnabled()
    await button(page, '검수 확인서 보기').click()
    const certificate = page.getByRole('dialog', { name: '검수 확인서', exact: true })
    await expect(certificate).toContainText('승인 당시 확인 완료 2개')
    await expect(certificate.getByRole('listitem')).toHaveText(['#1 배송 안내 문구 확인', `#2 ${noteTitle}`])
    await certificate.getByRole('button', { name: '닫기', exact: true }).click()
    await expect(nextTask(page)).toContainText('체험 완료')
    await expect(nextTask(page)).toContainText('검수 확인서 보기')

    await page.getByRole('button', { name: '처음부터', exact: true }).click()
    await expectLocationTask(page)
    await expect(nextTask(page)).not.toContainText('체험 완료')
    await expect(button(page, '고객(승인자)')).toHaveAttribute('aria-pressed', 'true')
    await expect(guide(page).getByLabel('제목 (필수)')).toHaveValue('')
    await expect(page.getByRole('img', { name: '새 쪽지 위치' })).toHaveCount(0)
    await expect(guide(page).getByRole('list', { name: '쪽지 목록' }).getByRole('listitem')).toHaveCount(1)
    await expect(button(page, '검수 확인서 보기')).toHaveCount(0)

    // 진행한 뒤 새로고침해야 초기 안내가 그대로 남은 경우와 구별할 수 있다.
    await createNote(page)
    await page.reload()
    await expectLocationTask(page)
    await expect(nextTask(page)).not.toContainText('2/3 · 수정 반영')
    await expect(guide(page).getByLabel('제목 (필수)')).toHaveValue('')
    await expect(page.getByRole('img', { name: '새 쪽지 위치' })).toHaveCount(0)
    await expect(guide(page).getByRole('list', { name: '쪽지 목록' }).getByRole('listitem')).toHaveCount(1)
    await expect(certificate).toHaveCount(0)
  })
})
