import { createRequire } from 'node:module'
import type { Page } from '@playwright/test'
import {
  test, expect, resetDatabase, createUser, createProject, db,
  KNOWN_LOGIN_CODE, useKnownLoginCode,
} from './fixtures.ts'

// api e2e와 같은 이미지 도구를 쓴다. e2e에 패키지를 따로 추가하지 않는다.
const sharp = createRequire(new URL('../../api/package.json', import.meta.url))('sharp')

const inviteFromSettings = async (page: Page, projectId: string, email: string) => {
  await page.goto(`/app/projects/${projectId}/settings`)
  await page.getByLabel('클라이언트 초대 이메일', { exact: true }).fill(email)
  await page.getByRole('button', { name: '초대 보내기', exact: true }).click()
  const link = page.locator('code').filter({ hasText: /^http:\/\/localhost:5174\/app\/invite\// })
  await expect(link).toBeVisible()
  await expect(page.getByRole('heading', { name: '초대 대기', exact: true })).toBeVisible()
  await expect(page.getByRole('listitem').filter({ hasText: email })).toContainText('까지')
  return (await link.innerText()).trim()
}

const submitLoginCode = async (page: Page, email: string) => {
  await page.getByLabel('이메일', { exact: true }).fill(email)
  const responsePromise = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/auth/email-code' && response.request().method() === 'POST',
  )
  await page.getByRole('button', { name: '코드 받기', exact: true }).click()
  expect((await responsePromise).status()).toBe(204)
  await useKnownLoginCode(email)
  await page.getByLabel('로그인 코드', { exact: true }).fill(KNOWN_LOGIN_CODE)
  await page.getByRole('button', { name: '로그인', exact: true }).click()
}

const joinAsNewClient = async (page: Page, link: string, email: string, name: string) => {
  await page.goto(link)
  await page.getByRole('link', { name: '로그인하고 참여하기', exact: true }).click()
  await submitLoginCode(page, email)
  await page.getByLabel('이름', { exact: true }).fill(name)
  await page.getByRole('button', { name: '시작하기', exact: true }).click()
  await expect(page).toHaveURL(link)
  await page.getByRole('button', { name: '참여하기', exact: true }).click()
  await expect(page.getByRole('heading', { name: '프로젝트에 참여했어요', exact: true })).toBeVisible()
}

const saveApprover = async (page: Page, name: string) => {
  await page.getByRole('combobox', { name: '승인자', exact: true }).selectOption({ label: name })
  await page.getByRole('button', { name: '승인자 저장', exact: true }).click()
  await expect(page.getByText(`${name}님이 최종 버전을 승인해요.`, { exact: false })).toBeVisible()
}

const revokeClient = async (page: Page, email: string, message: string) => {
  const dialogPromise = page.waitForEvent('dialog')
  page.once('dialog', (dialog) => dialog.accept())
  const row = page.getByRole('listitem').filter({ hasText: email })
  await row.getByRole('button', { name: '접근 철회', exact: true }).click()
  const dialog = await dialogPromise
  expect(dialog.type()).toBe('confirm')
  expect(dialog.message()).toBe(message)
  await expect(row).toHaveCount(0)
}

test.beforeEach(async () => {
  await resetDatabase()
})

test('초대받은 사람이 링크에서 로그인하고 참여하면 검수실에서 게시한 버전을 본다', async ({ page, browser, baseURL, loginAs }) => {
  const developer = await createUser('developer@example.com', '개발자')
  const project = await createProject(developer.id, '초대 검수 프로젝트')
  const email = 'invited@example.com'
  await loginAs(developer.id)
  const headers = { Origin: new URL(baseURL!).origin }
  const screenResponse = await page.request.post(`/api/projects/${project.id}/screens`, {
    headers, data: { name: '메인', viewport: 'PC' },
  })
  expect(screenResponse.status()).toBe(201)
  const screen = await screenResponse.json()
  const versionResponse = await page.request.post(`/api/projects/${project.id}/versions`, { headers })
  expect(versionResponse.status()).toBe(201)
  const version = await versionResponse.json()
  const photo: Buffer = await sharp({ create: { width: 32, height: 24, channels: 3, background: 'red' } }).png().toBuffer()
  const uploadResponse = await page.request.put(`/api/versions/${version.id}/screens/${screen.id}/asset`, {
    headers, multipart: { file: { name: 'screen.png', mimeType: 'image/png', buffer: photo } },
  })
  expect(uploadResponse.status()).toBe(200)
  const published = await page.request.post(`/api/versions/${version.id}/publish`, { headers })
  expect(published.status()).toBe(200)
  const draftResponse = await page.request.post(`/api/projects/${project.id}/versions`, { headers })
  expect(draftResponse.status()).toBe(201)
  const draft = await draftResponse.json()
  const draftUpload = await page.request.put(`/api/versions/${draft.id}/screens/${screen.id}/asset`, {
    headers, multipart: { file: { name: 'draft.png', mimeType: 'image/png', buffer: photo } },
  })
  expect(draftUpload.status()).toBe(200)
  const draftAssetId = (await draftUpload.json()).screens[0].asset.id
  const link = await inviteFromSettings(page, project.id, email)
  await page.reload()
  await expect(page.getByRole('heading', { name: '초대 대기', exact: true })).toBeVisible()
  await expect(page.locator('code').filter({ hasText: link })).toHaveCount(0)

  const clientContext = await browser.newContext({ baseURL })
  try {
    const client = await clientContext.newPage()
    await client.goto(link)
    await expect(client.getByRole('heading', { name: '프로젝트에 초대받았어요' })).toBeVisible()
    await expect(client.locator('dd')).toHaveText([project.name, developer.name, '클라이언트', email])
    await client.getByRole('link', { name: '로그인하고 참여하기', exact: true }).click()
    await expect(client).toHaveURL((url) => url.pathname === '/app/login' && url.searchParams.get('next') === new URL(link).pathname.slice(4))
    await submitLoginCode(client, email)
    await client.getByLabel('이름', { exact: true }).fill('초대 고객')
    await client.getByRole('button', { name: '시작하기', exact: true }).click()
    await expect(client).toHaveURL(link)
    await client.getByRole('button', { name: '참여하기', exact: true }).click()
    await expect(client.getByRole('heading', { name: '프로젝트에 참여했어요' })).toBeVisible()
    await client.getByRole('link', { name: '검수실로 가기', exact: true }).click()
    await expect(client).toHaveURL(`/app/projects/${project.id}`)
    const image = client.getByRole('img', { name: '메인 · PC', exact: true })
    await expect(image).toBeVisible()
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true)
    await expect(client.getByRole('combobox', { name: '버전', exact: true })).toHaveValue(version.id)
    await expect(client.getByRole('combobox', { name: '버전', exact: true }).locator('option')).toHaveCount(1)
    await expect(client.getByText('승인자를 정해 주세요.', { exact: false })).toHaveCount(0)
    await expect(client.getByRole('link', { name: /준비$/ })).toHaveCount(0)
    expect((await client.request.get(`/api/versions/${draft.id}`)).status()).toBe(404)
    expect((await client.request.get(`/api/assets/${draftAssetId}`)).status()).toBe(404)
    const detail = await client.request.get(`/api/projects/${project.id}`)
    expect(await detail.json()).toMatchObject({ myRole: 'CLIENT', approver: null })
    await page.goto(`/app/projects/${project.id}/settings`)
    const member = page.getByRole('listitem').filter({ hasText: email })
    await expect(member).toContainText('마지막 접속:')
    await expect(member).not.toContainText('접속 기록 없음')
    await expect(page.getByRole('heading', { name: '초대 대기', exact: true })).toHaveCount(0)
  } finally {
    await clientContext.close()
  }
})

test('다른 이메일로 로그인한 사람은 초대 화면에서 참여하기 대신 다른 이메일로 로그인 안내를 본다', async ({ page, browser, baseURL, loginAs }) => {
  const developer = await createUser('developer@example.com', '개발자')
  const other = await createUser('other@example.com', '다른 사람')
  const project = await createProject(developer.id, '이메일 확인')
  await loginAs(developer.id)
  const email = 'invited@example.com'
  const link = await inviteFromSettings(page, project.id, email)
  const clientContext = await browser.newContext({ baseURL })
  try {
    const client = await clientContext.newPage()
    await client.goto('/app/login')
    await submitLoginCode(client, other.email)
    await expect(client.getByRole('heading', { name: '내 프로젝트', exact: true })).toBeVisible()
    await client.goto(link)
    await expect(client.getByText('지금 로그인한 이메일과 초대받은 이메일이 달라요.', { exact: false })).toBeVisible()
    await expect(client.getByText(other.email, { exact: true })).toBeVisible()
    await expect(client.getByRole('button', { name: '참여하기', exact: true })).toHaveCount(0)
    await client.getByRole('button', { name: '다른 이메일로 로그인', exact: true }).click()
    await expect(client).toHaveURL((url) => url.pathname === '/app/login' && url.searchParams.get('next') === new URL(link).pathname.slice(4))
    await submitLoginCode(client, email)
    await client.getByLabel('이름', { exact: true }).fill('맞는 고객')
    await client.getByRole('button', { name: '시작하기', exact: true }).click()
    await expect(client).toHaveURL(link)
    await client.getByRole('button', { name: '참여하기', exact: true }).click()
    await expect(client.getByRole('heading', { name: '프로젝트에 참여했어요' })).toBeVisible()
  } finally {
    await clientContext.close()
  }
})

test('만료된 초대는 만료 안내를, 다시 초대해 무효가 된 예전 링크는 쓸 수 없는 초대 안내를 보여 준다', async ({ page, browser, baseURL, loginAs }) => {
  const developer = await createUser('developer@example.com', '개발자')
  const project = await createProject(developer.id, '초대 유효 기간')
  await loginAs(developer.id)
  const expiredLink = await inviteFromSettings(page, project.id, 'expired@example.com')
  await db.$executeRaw`UPDATE invitations SET expires_at = now() - interval '1 day' WHERE project_id = ${project.id}::uuid`
  const oldLink = await inviteFromSettings(page, project.id, 'reissued@example.com')
  const newLink = await inviteFromSettings(page, project.id, 'reissued@example.com')
  expect(newLink).not.toBe(oldLink)
  const clientContext = await browser.newContext({ baseURL })
  try {
    const client = await clientContext.newPage()
    await client.goto(expiredLink)
    await expect(client.getByRole('heading', { name: '초대가 만료됐어요', exact: true })).toBeVisible()
    await expect(client.getByText('개발자에게 새 초대 링크를 요청해 주세요.', { exact: true })).toBeVisible()
    for (const invalidLink of [oldLink, `${baseURL}/app/invite/${'a'.repeat(43)}`]) {
      await client.goto(invalidLink)
      await expect(client.getByRole('heading', { name: '초대 링크를 확인해 주세요', exact: true })).toBeVisible()
      await expect(client.getByText('사용할 수 없는 초대예요. 초대받은 링크가 맞는지 확인해 주세요.', { exact: true })).toBeVisible()
      await expect(client.getByRole('link', { name: '로그인하고 참여하기', exact: true })).toHaveCount(0)
    }
    await client.goto(newLink)
    await expect(client.getByRole('link', { name: '로그인하고 참여하기', exact: true })).toBeVisible()
  } finally {
    await clientContext.close()
  }
})

test('개발자 검수실의 승인자 알림은 클라이언트가 참여하면 보이고 승인자를 정하면 사라진다', async ({ page, browser, baseURL, loginAs }) => {
  const developer = await createUser('developer@example.com', '개발자')
  const project = await createProject(developer.id, '승인자 안내')
  await loginAs(developer.id)
  const link = await inviteFromSettings(page, project.id, 'invited@example.com')
  await page.goto(`/app/projects/${project.id}`)
  await expect(page.getByRole('heading', { name: '아직 게시한 버전이 없어요.' })).toBeVisible()
  await expect(page.getByText('승인자를 정해 주세요.', { exact: false })).toHaveCount(0)
  const clientContext = await browser.newContext({ baseURL })
  try {
    const client = await clientContext.newPage()
    await joinAsNewClient(client, link, 'invited@example.com', '승인 고객')
    await page.reload()
    await expect(page.getByText('승인자를 정해 주세요.', { exact: false })).toBeVisible()
    await page.getByRole('link', { name: '설정으로 가기', exact: true }).click()
    await expect(page.getByRole('combobox', { name: '승인자', exact: true })).toHaveValue('')
    await expect(page.getByRole('combobox', { name: '승인자', exact: true }).locator('option')).toHaveText(['승인 고객', '지정하지 않음'])
    await saveApprover(page, '승인 고객')
    await page.goto(`/app/projects/${project.id}`)
    await expect(page.getByRole('heading', { name: project.name, exact: true })).toBeVisible()
    await expect(page.getByText('승인자를 정해 주세요.', { exact: false })).toHaveCount(0)
    await page.goto(`/app/projects/${project.id}/settings`)
    await page.getByRole('combobox', { name: '승인자', exact: true }).selectOption('')
    await page.getByRole('button', { name: '승인자 저장', exact: true }).click()
    await expect(page.getByText('승인자를 정해 주세요.', { exact: false })).toBeVisible()
    await page.goto(`/app/projects/${project.id}`)
    await expect(page.getByRole('link', { name: '설정으로 가기', exact: true })).toBeVisible()
  } finally {
    await clientContext.close()
  }
})

test('접근을 철회하면 클라이언트의 검수실은 없는 프로젝트가 되고 예전 초대 링크는 프로젝트가 보인다고 약속하지 않는다', async ({ page, browser, baseURL, loginAs }) => {
  const developer = await createUser('developer@example.com', '개발자')
  const project = await createProject(developer.id, '접근 철회')
  const email = 'invited@example.com'
  await loginAs(developer.id)
  const link = await inviteFromSettings(page, project.id, email)
  const clientContext = await browser.newContext({ baseURL })
  try {
    const client = await clientContext.newPage()
    await joinAsNewClient(client, link, email, '철회 고객')
    await client.getByRole('link', { name: '검수실로 가기', exact: true }).click()
    await expect(client.getByRole('heading', { name: project.name, exact: true })).toBeVisible()
    await page.goto(`/app/projects/${project.id}/settings`)
    await saveApprover(page, '철회 고객')
    const memberId = await page.getByRole('combobox', { name: '승인자', exact: true }).inputValue()
    await revokeClient(page, email, '철회 고객님의 접근을 철회할까요? 사진과 기록을 더 이상 볼 수 없어요. 쪽지와 댓글은 남아요. 승인자가 비게 돼요. 새 승인자를 정해 주세요.')
    await expect(page.getByRole('combobox', { name: '승인자', exact: true })).toHaveValue('')
    await client.reload()
    await expect(client.getByRole('heading', { name: '없는 프로젝트예요', exact: true })).toBeVisible()
    await client.getByRole('link', { name: '프로젝트 목록', exact: true }).click()
    await expect(client.getByRole('heading', { name: '내 프로젝트', exact: true })).toBeVisible()
    await expect(client.getByRole('link', { name: project.name, exact: true })).toHaveCount(0)
    await client.goto(link)
    await expect(client.getByRole('heading', { name: '이미 수락한 초대예요', exact: true })).toBeVisible()
    await expect(client.getByText('프로젝트 목록에서 확인해 주세요.', { exact: true })).toBeVisible()
    await expect(client.getByText('볼 수 있어요', { exact: false })).toHaveCount(0)
    await expect(client.getByRole('button', { name: '참여하기', exact: true })).toHaveCount(0)
    await expect(client.getByRole('link', { name: '검수실로 가기', exact: true })).toHaveCount(0)
    const newLink = await inviteFromSettings(page, project.id, email)
    await client.goto(newLink)
    await client.getByRole('button', { name: '참여하기', exact: true }).click()
    await expect(client.getByRole('heading', { name: '프로젝트에 참여했어요' })).toBeVisible()
    await page.reload()
    await expect(page.getByRole('combobox', { name: '승인자', exact: true })).toHaveValue('')
    await expect(page.getByRole('combobox', { name: '승인자', exact: true }).locator('option').filter({ hasText: '철회 고객' })).toHaveAttribute('value', memberId)
  } finally {
    await clientContext.close()
  }
})

test('로그인 뒤 돌아갈 주소가 바깥 사이트이면 첫 화면으로 간다', async ({ page, baseURL }) => {
  // 각 경우에 다른 이메일을 써서 60초 재발급 제한과 섞이지 않게 한다.
  const destinations = ['//evil.example.com', 'https://evil.example.com', '/\\evil.example.com']
  for (const [index, next] of destinations.entries()) {
    const user = await createUser(`redirect-${index}@example.com`, '로그인 고객')
    await page.context().clearCookies()
    await page.goto(`/app/login?next=${encodeURIComponent(next)}`)
    await submitLoginCode(page, user.email)
    await expect(page).toHaveURL((url) => url.origin === new URL(baseURL!).origin && /^\/app\/?$/.test(url.pathname))
    await expect(page.getByRole('heading', { name: '내 프로젝트', exact: true })).toBeVisible()
  }
})

test('활동 일지에 초대·참여·승인자 지정·접근 철회가 문장으로 보인다', async ({ page, browser, baseURL, loginAs }) => {
  const developer = await createUser('developer@example.com', '개발자')
  const project = await createProject(developer.id, '초대 활동 기록')
  const email = 'invited@example.com'
  await loginAs(developer.id)
  const link = await inviteFromSettings(page, project.id, email)
  const clientContext = await browser.newContext({ baseURL })
  try {
    const client = await clientContext.newPage()
    await joinAsNewClient(client, link, email, '일지 고객')
    await page.goto(`/app/projects/${project.id}/settings`)
    await saveApprover(page, '일지 고객')
    await revokeClient(page, email, '일지 고객님의 접근을 철회할까요? 사진과 기록을 더 이상 볼 수 없어요. 쪽지와 댓글은 남아요. 승인자가 비게 돼요. 새 승인자를 정해 주세요.')
    await page.goto(`/app/projects/${project.id}/activity`)
    await expect(page.getByRole('heading', { name: `${project.name} 활동 일지`, exact: true })).toBeVisible()
    for (const sentence of [
      '개발자님이 클라이언트를 초대했어요', '일지 고객님이 프로젝트에 참여했어요',
      '개발자님이 일지 고객님을 승인자로 정했어요', '개발자님이 일지 고객님의 접근을 철회했어요',
    ]) {
      await expect(page.getByText(sentence, { exact: true })).toBeVisible()
      await expect(page.getByText(sentence, { exact: true })).toHaveCount(1)
    }
  } finally {
    await clientContext.close()
  }
})

test('클라이언트의 설정 화면에는 참여자와 초대 칸이 없다', async ({ page, browser, baseURL, loginAs }) => {
  const developer = await createUser('developer@example.com', '개발자')
  const project = await createProject(developer.id, '설정 권한')
  await loginAs(developer.id)
  const link = await inviteFromSettings(page, project.id, 'invited@example.com')
  await inviteFromSettings(page, project.id, 'pending@example.com')
  const clientContext = await browser.newContext({ baseURL })
  try {
    const client = await clientContext.newPage()
    await joinAsNewClient(client, link, 'invited@example.com', '설정 고객')
    await client.goto(`/app/projects/${project.id}/settings`)
    await expect(client.getByRole('heading', { name: project.name, exact: true })).toBeVisible()
    await expect(client.getByRole('heading', { name: '참여자와 승인자', exact: true })).toHaveCount(0)
    await expect(client.getByRole('heading', { name: '초대 대기', exact: true })).toHaveCount(0)
    await expect(client.getByLabel('클라이언트 초대 이메일', { exact: true })).toHaveCount(0)
    await expect(client.getByRole('button', { name: '초대 보내기', exact: true })).toHaveCount(0)
    await expect(client.getByRole('combobox', { name: '승인자', exact: true })).toHaveCount(0)
    await expect(client.getByRole('button', { name: '접근 철회', exact: true })).toHaveCount(0)
    await expect(client.getByText('마지막 접속', { exact: false })).toHaveCount(0)
    await expect(client.getByText(developer.email, { exact: false })).toHaveCount(0)
    await expect(client.getByText('pending@example.com', { exact: false })).toHaveCount(0)
  } finally {
    await clientContext.close()
  }
})

test('초대받지 않은 이메일은 맞는 코드를 넣어도 가입할 수 없다', async ({ page }) => {
  const email = 'unknown@example.com'
  await page.goto('/app/login')
  await submitLoginCode(page, email)
  await expect(page.getByText('코드가 맞지 않아요', { exact: true })).toBeVisible()
  await expect(page.getByLabel('이름', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '시작하기', exact: true })).toHaveCount(0)
  await expect(page).toHaveURL('/app/login')
  expect(await db.user.findUnique({ where: { email } })).toBeNull()
})

test('클라이언트가 5명이면 설정 화면은 초대를 거절하고 초대받은 사람의 화면은 인원이 찼다고 알린다', async ({ page, browser, baseURL, loginAs }) => {
  const developer = await createUser('developer@example.com', '개발자')
  const project = await createProject(developer.id, '참여 정원')
  await loginAs(developer.id)
  for (let index = 0; index < 4; index += 1) {
    const client = await createUser(`member-${index}@example.com`, `기존 고객 ${index}`)
    await db.projectMember.create({ data: { projectId: project.id, userId: client.id, role: 'CLIENT' } })
  }
  const email = 'invited@example.com'
  const link = await inviteFromSettings(page, project.id, email)
  const fifth = await createUser('fifth@example.com', '다섯 번째 고객')
  const fifthMember = await db.projectMember.create({ data: { projectId: project.id, userId: fifth.id, role: 'CLIENT' } })
  await page.reload()
  await page.getByLabel('클라이언트 초대 이메일', { exact: true }).fill('overflow@example.com')
  await page.getByRole('button', { name: '초대 보내기', exact: true }).click()
  await expect(page.getByText('클라이언트는 5명까지 참여할 수 있어요', { exact: true })).toBeVisible()
  await expect(page.locator('code')).toHaveCount(0)
  const clientContext = await browser.newContext({ baseURL })
  try {
    const client = await clientContext.newPage()
    await client.goto(link)
    await client.getByRole('link', { name: '로그인하고 참여하기', exact: true }).click()
    await submitLoginCode(client, email)
    await client.getByLabel('이름', { exact: true }).fill('정원 고객')
    await client.getByRole('button', { name: '시작하기', exact: true }).click()
    await expect(client).toHaveURL(link)
    await client.getByRole('button', { name: '참여하기', exact: true }).click()
    await expect(client.getByRole('heading', { name: '참여할 수 있는 인원이 찼어요', exact: true })).toBeVisible()
    await expect(client.getByText('클라이언트는 5명까지 참여할 수 있어요. 개발자에게 알려 주세요.', { exact: true })).toBeVisible()
    await expect(client.getByRole('link', { name: '검수실로 가기', exact: true })).toHaveCount(0)
    // 정원 때문에 실패한 초대는 쓰이지 않아, 자리가 나면 같은 링크로 참여할 수 있다.
    await db.projectMember.update({ where: { id: fifthMember.id }, data: { revokedAt: new Date() } })
    await client.reload()
    await client.getByRole('button', { name: '참여하기', exact: true }).click()
    await expect(client.getByRole('heading', { name: '프로젝트에 참여했어요' })).toBeVisible()
  } finally {
    await clientContext.close()
  }
})
