import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { StrictMode } from 'react'
import { Link, MemoryRouter, Route, Routes } from 'react-router'
import { getMe } from '../api/auth.ts'
import { ApiError } from '../api/client.ts'
import { createInvitation, type CreatedInvitation } from '../api/invitations.ts'
import { listMembers, revokeMember, setApprover, type Member, type MemberList } from '../api/members.ts'
import { getProject, listScreens, type Approver, type ProjectDetail } from '../api/projects.ts'
import { ProjectSettingsPage } from './ProjectSettingsPage.tsx'

vi.mock('../api/auth.ts', () => ({ getMe: vi.fn() }))
vi.mock('../api/members.ts', () => ({ listMembers: vi.fn(), revokeMember: vi.fn(), setApprover: vi.fn() }))
vi.mock('../api/invitations.ts', () => ({ createInvitation: vi.fn() }))
vi.mock('../api/projects.ts', async () => {
  const actual = await vi.importActual<typeof import('../api/projects.ts')>('../api/projects.ts')
  return { ...actual, getProject: vi.fn(), listScreens: vi.fn() }
})

const developer: Member = {
  id: '52ba2bc7-0ea0-4438-8c52-15ca0f4d1d01',
  name: '이개발',
  email: 'developer@example.com',
  role: 'DEVELOPER',
  lastSeenAt: null,
}
const firstClient: Member = {
  id: '52ba2bc7-0ea0-4438-8c52-15ca0f4d1d02',
  name: '하승인',
  email: 'first@example.com',
  role: 'CLIENT',
  lastSeenAt: '2026-11-09T03:00:00.000Z',
}
const secondClient: Member = {
  id: '52ba2bc7-0ea0-4438-8c52-15ca0f4d1d03',
  name: '강참여',
  email: 'second@example.com',
  role: 'CLIENT',
  lastSeenAt: null,
}
const project: ProjectDetail = {
  id: 'ebf058f0-dc9e-4a14-adcd-cb2712594e5a',
  name: '초대할 프로젝트',
  myRole: 'DEVELOPER',
  currentVersion: null,
  approver: { memberId: firstClient.id, name: firstClient.name },
}
const memberList: MemberList = { members: [developer, firstClient, secondClient], invitations: [] }
const invitation: CreatedInvitation = {
  email: 'invited@example.com',
  expiresAt: '2026-11-16T03:00:00.000Z',
  link: 'https://review.example.com/app/invite/example-invitation-link',
}

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const renderSettings = (strict = false) => {
  const app = (
    <MemoryRouter basename="/app" initialEntries={[`/app/projects/${project.id}/settings`]}>
      <Routes>
        <Route path="/projects/:id/settings" element={<ProjectSettingsPage />} />
        <Route path="/" element={<Link to={`/projects/${project.id}/settings`}>설정으로 돌아가기</Link>} />
        <Route path="/login" element={<h1>로그인</h1>} />
      </Routes>
    </MemoryRouter>
  )
  return render(strict ? <StrictMode>{app}</StrictMode> : app)
}

const memberRow = (name: string) => screen.getByText(name, { selector: 'strong' }).closest('li')!

beforeEach(() => {
  // 프로젝트 생성 권한과 이 프로젝트의 참여자 관리 권한은 별개다.
  vi.mocked(getMe).mockReset().mockResolvedValue({
    id: '5b3a934d-ef8e-4ce8-b26a-a9d1cdd4983f',
    email: 'reader@example.com',
    name: '사용자',
    canCreateProjects: false,
  })
  vi.mocked(getProject).mockReset().mockResolvedValue(project)
  vi.mocked(listScreens).mockReset().mockResolvedValue([])
  vi.mocked(listMembers).mockReset().mockResolvedValue(memberList)
  vi.mocked(revokeMember).mockReset().mockResolvedValue(undefined)
  vi.mocked(setApprover).mockReset().mockResolvedValue(project.approver)
  vi.mocked(createInvitation).mockReset().mockResolvedValue(invitation)
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('ProjectSettingsPage 참여자 조회', () => {
  it('개발자는 서버의 참여 순서대로 이름·이메일·역할을 보고 클라이언트만 철회할 수 있다', async () => {
    renderSettings()
    await screen.findByRole('heading', { name: '참여자와 승인자' })

    expect(listMembers).toHaveBeenCalledExactlyOnceWith(project.id)
    const rows = screen.getAllByRole('listitem')
    expect(rows.map((row) => within(row).getByText(/./, { selector: 'strong' }).textContent)).toEqual([
      developer.name,
      firstClient.name,
      secondClient.name,
    ])
    expect(memberRow(developer.name).textContent).toContain(developer.email)
    expect(memberRow(firstClient.name).textContent).toContain(firstClient.email)
    expect(memberRow(secondClient.name).textContent).toContain(secondClient.email)
    expect(within(rows[0]).getByText('개발자')).toBeDefined()
    expect(within(rows[1]).getByText('승인자')).toBeDefined()
    expect(within(rows[2]).getByText('클라이언트')).toBeDefined()
    expect(within(rows[0]).queryByRole('button')).toBeNull()
    expect(within(rows[1]).getByRole('button', { name: '접근 철회' })).toBeDefined()
    expect(within(rows[2]).getByRole('button', { name: '접근 철회' })).toBeDefined()
    expect(screen.getByText(/이 프로젝트를 본 시각은 아니에요/)).toBeDefined()
    expect(screen.queryByRole('heading', { name: '초대 대기' })).toBeNull()
  })

  it('클라이언트는 생성 권한이 있어도 참여자 API를 부르지 않고 이메일·접속·관리 칸을 보지 못한다', async () => {
    vi.mocked(getMe).mockResolvedValue({
      id: secondClient.id,
      name: secondClient.name,
      email: secondClient.email,
      canCreateProjects: true,
    })
    vi.mocked(getProject).mockResolvedValue({ ...project, myRole: 'CLIENT' })
    renderSettings()
    await screen.findByRole('heading', { name: project.name })

    expect(listMembers).not.toHaveBeenCalled()
    expect(screen.queryByRole('heading', { name: '참여자와 승인자' })).toBeNull()
    expect(screen.queryByRole('heading', { name: '초대 대기' })).toBeNull()
    expect(screen.queryByText(/마지막 접속/)).toBeNull()
    expect(screen.queryByText(firstClient.email, { exact: false })).toBeNull()
    expect(screen.queryByRole('combobox', { name: '승인자' })).toBeNull()
    expect(screen.queryByRole('textbox', { name: '클라이언트 초대 이메일' })).toBeNull()
    expect(screen.queryByRole('button', { name: /접근 철회|승인자 저장|초대 보내기|링크 복사/ })).toBeNull()
  })

  it.each([
    { elapsed: 0, label: '지금' },
    { elapsed: 1, label: '1분 전' },
    { elapsed: 59, label: '59분 전' },
    { elapsed: 60, label: '1시간 전' },
    { elapsed: 120, label: '2시간 전' },
    { elapsed: 23 * 60, label: '23시간 전' },
    { elapsed: 24 * 60, label: '어제' },
    { elapsed: 3 * 24 * 60, label: '3일 전' },
    { elapsed: null, label: '접속 기록 없음' },
  ])('시각을 고정했을 때 마지막 접속을 $label으로 보여 준다', async ({ elapsed, label }) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-09T03:00:00.000Z'))
    const lastSeenAt = elapsed === null ? null : new Date(Date.now() - elapsed * 60_000).toISOString()
    vi.mocked(listMembers).mockResolvedValue({ members: [{ ...firstClient, lastSeenAt }], invitations: [] })
    renderSettings()
    await screen.findByRole('heading', { name: '참여자와 승인자' })

    expect(memberRow(firstClient.name).textContent).toContain(`마지막 접속: ${label}`)
  })

  it('목록 응답 전에는 불러오는 중이고 관리 요청을 보낼 수 없다', async () => {
    const pending = deferred<MemberList>()
    vi.mocked(listMembers).mockReturnValueOnce(pending.promise)
    renderSettings()
    await screen.findByText('참여자를 불러오는 중이에요.')
    expect(screen.queryByRole('button', { name: /접근 철회|승인자 저장|초대 보내기/ })).toBeNull()

    await act(async () => pending.resolve(memberList))
    expect(screen.getByRole('heading', { name: '참여자와 승인자' })).toBeDefined()
    expect(screen.queryByText('참여자를 불러오는 중이에요.')).toBeNull()
  })

  it('초대 대기는 이메일·만료일만 보여 주며 철회·취소·승인자 선택 대상이 아니다', async () => {
    vi.mocked(listMembers).mockResolvedValue({ ...memberList, invitations: [invitation] })
    renderSettings()
    await screen.findByRole('heading', { name: '초대 대기' })
    const row = screen.getByText(invitation.email).closest('li')!
    expect(row.textContent).toContain('2026. 11. 16.까지')
    expect(within(row).queryByRole('button')).toBeNull()
    expect(
      within(screen.getByRole('combobox', { name: '승인자' })).queryByRole('option', { name: invitation.email }),
    ).toBeNull()
  })

  it.each([
    { error: new TypeError('offline'), message: '연결을 확인하고 다시 시도해 주세요' },
    { error: new ApiError(500), message: '잠시 뒤 다시 시도해 주세요' },
    { error: new ApiError(403), message: '잠시 뒤 다시 시도해 주세요' },
    { error: new ApiError(404), message: '잠시 뒤 다시 시도해 주세요' },
    { error: new ApiError(401), message: '로그인이 끝났어요. 다시 로그인해 주세요' },
  ])('참여자 목록 조회 실패 $error를 표시하고 관리 칸을 열지 않는다', async ({ error, message }) => {
    vi.mocked(listMembers).mockRejectedValueOnce(error)
    renderSettings()
    expect((await screen.findByRole('alert')).textContent).toContain(message)
    expect(screen.getByRole('heading', { name: project.name })).toBeDefined()
    expect(screen.queryByRole('button', { name: /접근 철회|승인자 저장|초대 보내기/ })).toBeNull()
    expect(screen.queryByText('참여자를 불러오는 중이에요.')).toBeNull()
    expect(createInvitation).not.toHaveBeenCalled()
  })

  it.each(['성공', '실패'])(
    'StrictMode에서 정리된 첫 목록 요청의 늦은 %s는 최신 목록을 덮지 않는다',
    async (result) => {
      const stale = deferred<MemberList>()
      vi.mocked(listMembers).mockReturnValueOnce(stale.promise).mockResolvedValue(memberList)
      renderSettings(true)
      await screen.findByRole('heading', { name: '참여자와 승인자' })
      expect(listMembers).toHaveBeenCalledTimes(2)

      await act(async () => {
        if (result === '실패') stale.reject(new ApiError(500))
        if (result === '성공') stale.resolve({ members: [{ ...firstClient, name: '오래된 참여자' }], invitations: [] })
      })
      expect(memberRow(firstClient.name)).toBeDefined()
      expect(memberRow(secondClient.name)).toBeDefined()
      expect(screen.queryByText('오래된 참여자')).toBeNull()
      expect(screen.queryByRole('alert')).toBeNull()
    },
  )
})

describe('ProjectSettingsPage 접근 철회와 승인자', () => {
  it.each([firstClient, secondClient])(
    '$name 철회 확인을 취소하면 요청하지 않고 승인자와 목록을 유지한다',
    async (member) => {
      vi.mocked(window.confirm).mockReturnValue(false)
      renderSettings()
      await screen.findByRole('heading', { name: '참여자와 승인자' })
      fireEvent.click(within(memberRow(member.name)).getByRole('button', { name: '접근 철회' }))

      expect(window.confirm).toHaveBeenCalledTimes(1)
      const message = vi.mocked(window.confirm).mock.calls[0][0]!
      expect(message).toContain(`${member.name}님의 접근을 철회할까요?`)
      expect(message).toContain('사진과 기록을 더 이상 볼 수 없어요')
      expect(message).toContain('쪽지와 댓글은 남아요')
      expect(message.includes('승인자가 비게 돼요. 새 승인자를 정해 주세요.')).toBe(member.id === firstClient.id)
      expect(revokeMember).not.toHaveBeenCalled()
      expect(listMembers).toHaveBeenCalledTimes(1)
      expect(screen.getByText(`${firstClient.name}님이 최종 버전을 승인해요.`, { exact: false })).toBeDefined()
    },
  )

  it.each([firstClient, secondClient])(
    '$name 철회 성공 뒤 목록을 갱신하고 승인자를 철회한 경우에만 비운다',
    async (member) => {
      vi.mocked(listMembers)
        .mockResolvedValueOnce(memberList)
        .mockResolvedValue({
          members: memberList.members.filter((item) => item.id !== member.id),
          invitations: [],
        })
      renderSettings()
      await screen.findByRole('heading', { name: '참여자와 승인자' })
      await act(async () => fireEvent.click(within(memberRow(member.name)).getByRole('button', { name: '접근 철회' })))

      expect(revokeMember).toHaveBeenCalledExactlyOnceWith(member.id)
      expect(listMembers).toHaveBeenCalledTimes(2)
      expect(listMembers).toHaveBeenLastCalledWith(project.id)
      expect(screen.queryByText(member.name, { selector: 'strong' })).toBeNull()
      const choice = screen.getByRole<HTMLSelectElement>('combobox', { name: '승인자' })
      expect(within(choice).queryByRole('option', { name: member.name })).toBeNull()
      expect(choice.value).toBe(member.id === firstClient.id ? '' : firstClient.id)
      const notice =
        member.id === firstClient.id ? '승인자를 정해 주세요.' : `${firstClient.name}님이 최종 버전을 승인해요.`
      expect(screen.getByText(notice, { exact: false })).toBeDefined()
      expect(setApprover).not.toHaveBeenCalled()
    },
  )

  it('승인자 후보는 서버가 준 활성 클라이언트와 지정하지 않음뿐이다', async () => {
    renderSettings()
    const choice = await screen.findByRole<HTMLSelectElement>('combobox', { name: '승인자' })
    expect(
      within(choice)
        .getAllByRole<HTMLOptionElement>('option')
        .map((option) => [option.value, option.textContent]),
    ).toEqual([
      [firstClient.id, firstClient.name],
      [secondClient.id, secondClient.name],
      ['', '지정하지 않음'],
    ])
    expect(choice.value).toBe(firstClient.id)
    expect(setApprover).not.toHaveBeenCalled()
  })

  it.each([
    {
      label: '다른 클라이언트',
      memberId: secondClient.id,
      response: { memberId: secondClient.id, name: '새 승인자 응답 이름' },
    },
    { label: '지정하지 않음', memberId: null, response: null },
  ])('$label 저장은 선택한 id 또는 null을 보내고 서버의 승인자 안내·역할로 바꾼다', async ({ memberId, response }) => {
    vi.mocked(setApprover).mockResolvedValueOnce(response)
    renderSettings()
    const choice = await screen.findByRole('combobox', { name: '승인자' })
    fireEvent.change(choice, { target: { value: memberId ?? '' } })
    expect(setApprover).not.toHaveBeenCalled()
    expect(screen.getByText(`${firstClient.name}님이 최종 버전을 승인해요.`, { exact: false })).toBeDefined()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '승인자 저장' })))

    expect(setApprover).toHaveBeenCalledExactlyOnceWith(project.id, memberId)
    expect(
      screen.getByText(response ? `${response.name}님이 최종 버전을 승인해요.` : '승인자를 정해 주세요.', {
        exact: false,
      }),
    ).toBeDefined()
    expect(within(memberRow(firstClient.name)).getByText('클라이언트')).toBeDefined()
    expect(within(memberRow(secondClient.name)).getByText(response ? '승인자' : '클라이언트')).toBeDefined()
  })

  it('새로 들어온 클라이언트가 있어도 승인자를 자동으로 고르거나 저장하지 않는다', async () => {
    vi.mocked(getProject).mockResolvedValue({ ...project, approver: null })
    renderSettings()
    const choice = await screen.findByRole<HTMLSelectElement>('combobox', { name: '승인자' })
    expect(choice.value).toBe('')
    expect(screen.getByText('승인자를 정해 주세요.', { exact: false })).toBeDefined()
    expect(within(memberRow(firstClient.name)).getByText('클라이언트')).toBeDefined()
    expect(setApprover).not.toHaveBeenCalled()
  })

  it('활성 클라이언트가 없으면 승인자 후보에는 지정하지 않음만 있다', async () => {
    vi.mocked(getProject).mockResolvedValue({ ...project, approver: null })
    vi.mocked(listMembers).mockResolvedValue({ members: [developer], invitations: [invitation] })
    renderSettings()
    const choice = await screen.findByRole<HTMLSelectElement>('combobox', { name: '승인자' })

    expect(
      within(choice)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['지정하지 않음'])
    expect(choice.value).toBe('')
    expect(setApprover).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: '접근 철회' })).toBeNull()
  })

  it('고르기만 한 클라이언트를 철회한 뒤 승인자 저장은 화면에 남은 선택값을 보낸다', async () => {
    vi.mocked(listMembers)
      .mockResolvedValueOnce(memberList)
      .mockResolvedValue({
        members: [developer, firstClient],
        invitations: [],
      })
    renderSettings()
    const choice = await screen.findByRole<HTMLSelectElement>('combobox', { name: '승인자' })
    fireEvent.change(choice, { target: { value: secondClient.id } })
    await act(async () =>
      fireEvent.click(within(memberRow(secondClient.name)).getByRole('button', { name: '접근 철회' })),
    )
    expect(within(choice).queryByRole('option', { name: secondClient.name })).toBeNull()

    const visibleChoice = choice.value || null
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '승인자 저장' })))
    expect(setApprover).toHaveBeenCalledExactlyOnceWith(project.id, visibleChoice)
  })

  it.each([
    { label: '지금 승인자', approver: project.approver },
    { label: '지정하지 않음', approver: null },
  ])('저장 전 고른 사람을 철회하면 $label으로 돌아가고 그 값을 저장한다', async ({ approver }) => {
    vi.mocked(getProject).mockResolvedValueOnce({ ...project, approver })
    vi.mocked(setApprover).mockResolvedValueOnce(approver)
    vi.mocked(listMembers)
      .mockResolvedValueOnce(memberList)
      .mockResolvedValue({ members: [developer, firstClient], invitations: [] })
    renderSettings()
    const choice = await screen.findByRole<HTMLSelectElement>('combobox', { name: '승인자' })
    fireEvent.change(choice, { target: { value: secondClient.id } })
    expect(choice.value).toBe(secondClient.id)

    await act(async () =>
      fireEvent.click(within(memberRow(secondClient.name)).getByRole('button', { name: '접근 철회' })),
    )

    expect(revokeMember).toHaveBeenCalledExactlyOnceWith(secondClient.id)
    expect(within(choice).queryByRole('option', { name: secondClient.name })).toBeNull()
    expect(choice.value).toBe(approver?.memberId ?? '')
    expect(setApprover).not.toHaveBeenCalled()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '승인자 저장' })))
    expect(setApprover).toHaveBeenCalledExactlyOnceWith(project.id, approver?.memberId ?? null)
  })

  it('승인자 저장 422는 이메일 안내 대신 활성 클라이언트만 지정할 수 있다는 안내를 보여 준다', async () => {
    vi.mocked(setApprover).mockRejectedValueOnce(new ApiError(422))
    renderSettings()
    const choice = await screen.findByRole('combobox', { name: '승인자' })
    fireEvent.change(choice, { target: { value: secondClient.id } })
    fireEvent.click(screen.getByRole('button', { name: '승인자 저장' }))

    expect((await screen.findByRole('alert')).textContent).toBe(
      '승인자는 이 프로젝트에 참여 중인 클라이언트만 될 수 있어요',
    )
    expect(setApprover).toHaveBeenCalledExactlyOnceWith(project.id, secondClient.id)
    expect(screen.queryByText('이메일 주소를 확인해 주세요')).toBeNull()
  })

  it.each([
    { action: '접근 철회', error: new ApiError(404) },
    { action: '승인자 저장', error: new ApiError(422) },
  ])('$action 실패는 기존 참여자와 승인자를 유지하며 다시 시도할 수 있다', async ({ action, error }) => {
    vi.mocked(revokeMember).mockRejectedValueOnce(error)
    vi.mocked(setApprover).mockRejectedValueOnce(error)
    renderSettings()
    await screen.findByRole('heading', { name: '참여자와 승인자' })
    fireEvent.change(screen.getByRole('combobox', { name: '승인자' }), { target: { value: secondClient.id } })
    fireEvent.click(screen.getAllByRole('button', { name: action })[0])
    await screen.findByRole('alert')

    expect(within(memberRow(firstClient.name)).getByText('승인자')).toBeDefined()
    expect(screen.getByText(`${firstClient.name}님이 최종 버전을 승인해요.`, { exact: false })).toBeDefined()
    expect(listMembers).toHaveBeenCalledTimes(1)
    expect(
      screen
        .getAllByRole<HTMLButtonElement>('button', { name: /접근 철회|승인자 저장|초대 보내기/ })
        .every((button) => !button.disabled),
    ).toBe(true)
  })
})

describe('ProjectSettingsPage 초대 만들기와 링크', () => {
  it('초대 성공은 이메일을 비우고 대기를 다시 읽으며 링크를 복사하고 재방문하면 링크를 지운다', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', Object.create(navigator, { clipboard: { value: { writeText } } }))
    vi.mocked(listMembers)
      .mockResolvedValueOnce(memberList)
      .mockResolvedValue({ ...memberList, invitations: [invitation] })
    renderSettings()
    const input = await screen.findByRole<HTMLInputElement>('textbox', { name: '클라이언트 초대 이메일' })
    expect(screen.queryByRole('button', { name: '링크 복사' })).toBeNull()
    fireEvent.change(input, { target: { value: invitation.email } })
    fireEvent.click(screen.getByRole('button', { name: '초대 보내기' }))

    expect(await screen.findByText(invitation.link)).toBeDefined()
    expect(createInvitation).toHaveBeenCalledExactlyOnceWith(project.id, invitation.email)
    expect(input.value).toBe('')
    expect(listMembers).toHaveBeenCalledTimes(2)
    expect(listMembers).toHaveBeenLastCalledWith(project.id)
    expect(screen.getByRole('heading', { name: '초대 대기' })).toBeDefined()
    expect(screen.getByText(/링크는 지금 한 번만 확인할 수 있어요/)).toBeDefined()
    expect(setApprover).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '링크 복사' }))
    expect(await screen.findByRole('button', { name: '복사했어요' })).toBeDefined()
    expect(writeText).toHaveBeenCalledExactlyOnceWith(invitation.link)

    fireEvent.click(screen.getByRole('link', { name: '프로젝트 목록' }))
    fireEvent.click(await screen.findByRole('link', { name: '설정으로 돌아가기' }))
    await screen.findByRole('heading', { name: '초대 대기' })
    expect(screen.queryByText(invitation.link)).toBeNull()
    expect(screen.queryByRole('button', { name: /링크 복사|복사했어요/ })).toBeNull()
    expect(createInvitation).toHaveBeenCalledTimes(1)
  })

  it('같은 이메일로 다시 초대하면 새 링크만 보이고 복사 완료 표시가 초기화된다', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', Object.create(navigator, { clipboard: { value: { writeText } } }))
    const renewed = { ...invitation, link: `${invitation.link}-renewed` }
    vi.mocked(createInvitation).mockResolvedValueOnce(invitation).mockResolvedValueOnce(renewed)
    renderSettings()
    const input = await screen.findByRole('textbox', { name: '클라이언트 초대 이메일' })
    fireEvent.change(input, { target: { value: invitation.email } })
    fireEvent.click(screen.getByRole('button', { name: '초대 보내기' }))
    fireEvent.click(await screen.findByRole('button', { name: '링크 복사' }))
    await screen.findByRole('button', { name: '복사했어요' })
    fireEvent.change(input, { target: { value: invitation.email } })
    fireEvent.click(screen.getByRole('button', { name: '초대 보내기' }))

    await screen.findByText(renewed.link)
    expect(screen.queryByText(invitation.link)).toBeNull()
    expect(screen.queryByRole('button', { name: '복사했어요' })).toBeNull()
    expect(createInvitation).toHaveBeenCalledTimes(2)
    expect(createInvitation).toHaveBeenLastCalledWith(project.id, invitation.email)
    expect(listMembers).toHaveBeenCalledTimes(3)
    fireEvent.click(screen.getByRole('button', { name: '링크 복사' }))
    await screen.findByRole('button', { name: '복사했어요' })
    expect(writeText).toHaveBeenLastCalledWith(renewed.link)
  })

  it('클립보드 복사가 거부되면 직접 복사 안내와 링크를 남긴다', async () => {
    const writeText = vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError'))
    vi.stubGlobal('navigator', Object.create(navigator, { clipboard: { value: { writeText } } }))
    renderSettings()
    fireEvent.change(await screen.findByRole('textbox', { name: '클라이언트 초대 이메일' }), {
      target: { value: invitation.email },
    })
    fireEvent.click(screen.getByRole('button', { name: '초대 보내기' }))
    fireEvent.click(await screen.findByRole('button', { name: '링크 복사' }))

    expect((await screen.findByRole('alert')).textContent).toBe('복사하지 못했어요. 링크를 직접 골라 복사해 주세요')
    expect(writeText).toHaveBeenCalledExactlyOnceWith(invitation.link)
    expect(screen.getByText(invitation.link)).toBeDefined()
    expect(screen.queryByRole('button', { name: '복사했어요' })).toBeNull()
  })

  it('클립보드 API가 없는 브라우저도 오류 대신 직접 복사 안내를 보여 준다', async () => {
    vi.stubGlobal('navigator', Object.create(navigator, { clipboard: { value: undefined } }))
    // 브라우저 전역 오류가 테스트 실행기를 중단하지 않게 하고, 사용자가 볼 안내를 검사한다.
    const preventUnhandledError = (event: ErrorEvent) => event.preventDefault()
    window.addEventListener('error', preventUnhandledError)
    try {
      renderSettings()
      fireEvent.change(await screen.findByRole('textbox', { name: '클라이언트 초대 이메일' }), {
        target: { value: invitation.email },
      })
      fireEvent.click(screen.getByRole('button', { name: '초대 보내기' }))
      fireEvent.click(await screen.findByRole('button', { name: '링크 복사' }))

      expect((await screen.findByRole('alert')).textContent).toBe('복사하지 못했어요. 링크를 직접 골라 복사해 주세요')
      expect(screen.getByText(invitation.link)).toBeDefined()
      expect(screen.queryByRole('button', { name: '복사했어요' })).toBeNull()
    } finally {
      window.removeEventListener('error', preventUnhandledError)
    }
  })

  it.each([
    { error: new ApiError(409, 'PROJECT_FULL'), message: '클라이언트는 5명까지 참여할 수 있어요' },
    { error: new ApiError(409, 'ALREADY_MEMBER'), message: '이미 참여한 사람이에요' },
    { error: new ApiError(422), message: '이메일 주소를 확인해 주세요' },
    { error: new ApiError(403), message: '잠시 뒤 다시 시도해 주세요' },
    { error: new ApiError(404), message: '잠시 뒤 다시 시도해 주세요' },
    { error: new ApiError(500), message: '잠시 뒤 다시 시도해 주세요' },
    { error: new TypeError('offline'), message: '연결을 확인하고 다시 시도해 주세요' },
  ])('초대 실패 $error는 안내·입력을 보존하고 다시 성공하면 이전 오류를 지운다', async ({ error, message }) => {
    vi.mocked(createInvitation).mockRejectedValueOnce(error)
    renderSettings()
    const input = await screen.findByRole<HTMLInputElement>('textbox', { name: '클라이언트 초대 이메일' })
    fireEvent.change(input, { target: { value: invitation.email } })
    fireEvent.click(screen.getByRole('button', { name: '초대 보내기' }))

    expect((await screen.findByRole('alert')).textContent).toBe(message)
    expect(input.value).toBe(invitation.email)
    expect(input.disabled).toBe(false)
    expect(screen.queryByText(invitation.link)).toBeNull()
    expect(screen.queryByRole('heading', { name: '초대 대기' })).toBeNull()
    expect(listMembers).toHaveBeenCalledTimes(1)
    expect(memberRow(firstClient.name)).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: '초대 보내기' }))
    expect(screen.queryByRole('alert')).toBeNull()
    await screen.findByText(invitation.link)
    expect(input.value).toBe('')
    expect(createInvitation).toHaveBeenCalledTimes(2)
  })
})

describe('ProjectSettingsPage 참여자 작업 잠금과 세션', () => {
  it.each(['초대 보내기', '접근 철회'])(
    '%s 성공 뒤 목록 새로 읽기가 실패하면 오류를 알리고 잠금을 푼다',
    async (action) => {
      vi.mocked(listMembers).mockResolvedValueOnce(memberList).mockRejectedValueOnce(new TypeError('offline'))
      renderSettings()
      const input = await screen.findByRole<HTMLInputElement>('textbox', { name: '클라이언트 초대 이메일' })
      fireEvent.change(input, { target: { value: invitation.email } })
      fireEvent.click(screen.getAllByRole('button', { name: action })[0])

      expect((await screen.findByRole('alert')).textContent).toBe('연결을 확인하고 다시 시도해 주세요')
      expect(listMembers).toHaveBeenCalledTimes(2)
      expect(
        screen
          .getAllByRole<HTMLButtonElement>('button', { name: /접근 철회|승인자 저장|초대 보내기/ })
          .every((button) => !button.disabled),
      ).toBe(true)
      expect(input.disabled).toBe(false)
      if (action === '초대 보내기') {
        expect(createInvitation).toHaveBeenCalledExactlyOnceWith(project.id, invitation.email)
        expect(screen.getByText(invitation.link)).toBeDefined()
        expect(input.value).toBe('')
      }
      if (action === '접근 철회') {
        expect(revokeMember).toHaveBeenCalledExactlyOnceWith(firstClient.id)
        expect(screen.getByText('승인자를 정해 주세요.', { exact: false })).toBeDefined()
      }
    },
  )

  it.each(['초대 보내기', '접근 철회', '승인자 저장'])(
    '%s 처리 중에는 모든 참여자 변경을 잠그고 중복 요청하지 않는다',
    async (action) => {
      const invite = deferred<CreatedInvitation>()
      const revoke = deferred<void>()
      const approver = deferred<Approver>()
      const reload = deferred<MemberList>()
      vi.mocked(createInvitation).mockReturnValueOnce(invite.promise)
      vi.mocked(revokeMember).mockReturnValueOnce(revoke.promise)
      vi.mocked(setApprover).mockReturnValueOnce(approver.promise)
      vi.mocked(listMembers).mockResolvedValueOnce(memberList).mockReturnValueOnce(reload.promise)
      renderSettings()
      const input = await screen.findByRole<HTMLInputElement>('textbox', { name: '클라이언트 초대 이메일' })
      const choice = screen.getByRole<HTMLSelectElement>('combobox', { name: '승인자' })
      fireEvent.change(input, { target: { value: invitation.email } })
      fireEvent.click(screen.getAllByRole('button', { name: action })[0])

      const buttons = screen.getAllByRole<HTMLButtonElement>('button', { name: /접근 철회|승인자 저장|초대 보내기/ })
      expect(buttons.every((button) => button.disabled)).toBe(true)
      expect(input.disabled).toBe(true)
      expect(choice.disabled).toBe(true)
      buttons.forEach((button) => fireEvent.click(button))
      expect(
        vi.mocked(createInvitation).mock.calls.length +
          vi.mocked(revokeMember).mock.calls.length +
          vi.mocked(setApprover).mock.calls.length,
      ).toBe(1)

      await act(async () => {
        invite.resolve(invitation)
        revoke.resolve(undefined)
        approver.resolve(project.approver)
      })
      if (action !== '승인자 저장') {
        expect(listMembers).toHaveBeenCalledTimes(2)
        expect(buttons.every((button) => button.disabled)).toBe(true)
      }
      await act(async () => reload.resolve(memberList))
      expect(buttons.every((button) => !button.disabled)).toBe(true)
      expect(input.disabled).toBe(false)
      expect(choice.disabled).toBe(false)
    },
  )

  it.each(['초대 보내기', '접근 철회', '승인자 저장'])(
    '%s의 401은 입력·목록을 보존하고 로그인 링크만 제공한다',
    async (action) => {
      vi.mocked(createInvitation).mockRejectedValueOnce(new ApiError(401))
      vi.mocked(revokeMember).mockRejectedValueOnce(new ApiError(401))
      vi.mocked(setApprover).mockRejectedValueOnce(new ApiError(401))
      renderSettings()
      const input = await screen.findByRole<HTMLInputElement>('textbox', { name: '클라이언트 초대 이메일' })
      fireEvent.change(input, { target: { value: invitation.email } })
      fireEvent.click(screen.getAllByRole('button', { name: action })[0])

      expect((await screen.findByRole('alert')).textContent).toContain('로그인이 끝났어요. 다시 로그인해 주세요')
      expect(input.value).toBe(invitation.email)
      expect(input.disabled).toBe(false)
      expect(memberRow(firstClient.name)).toBeDefined()
      expect(screen.queryByRole('heading', { name: '로그인' })).toBeNull()
      const link = screen.getByRole('link', { name: '다시 로그인하기' })
      expect(link.getAttribute('href')).toBe('/app/login')
      fireEvent.click(link)
      expect(await screen.findByRole('heading', { name: '로그인' })).toBeDefined()
    },
  )
})
