import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router'
import { getMe } from '../api/auth.ts'
import { ApiError } from '../api/client.ts'
import { createInvitation } from '../api/invitations.ts'
import { listMembers, revokeMember, setApprover } from '../api/members.ts'
import {
  archiveProject,
  createScreen,
  deleteProject,
  getProject,
  hideScreen,
  listScreens,
  type ProjectDetail,
  showScreen,
  unarchiveProject,
} from '../api/projects.ts'
import { ProjectSettingsPage } from './ProjectSettingsPage.tsx'

vi.mock('../api/auth.ts', () => ({ getMe: vi.fn() }))
vi.mock('../api/members.ts', () => ({ listMembers: vi.fn(), revokeMember: vi.fn(), setApprover: vi.fn() }))
vi.mock('../api/invitations.ts', () => ({ createInvitation: vi.fn() }))
vi.mock('../api/projects.ts', async () => {
  const actual = await vi.importActual<typeof import('../api/projects.ts')>('../api/projects.ts')
  return {
    ...actual,
    getProject: vi.fn(),
    listScreens: vi.fn(),
    createScreen: vi.fn(),
    hideScreen: vi.fn(),
    showScreen: vi.fn(),
    archiveProject: vi.fn(),
    unarchiveProject: vi.fn(),
    deleteProject: vi.fn(),
  }
})

const project: ProjectDetail = {
  id: 'ebf058f0-dc9e-4a14-adcd-cb2712594e5a',
  name: 'Review 프로젝트',
  status: 'ACTIVE',
  purgeAfter: null,
  myRole: 'DEVELOPER',
  currentVersion: null,
  isApprover: false,
  approver: null,
}
const confirmLabel = '지우려면 프로젝트 이름을 그대로 입력해 주세요'
const archivedNotice = '보관한 프로젝트예요. 읽기만 할 수 있어요'
const now = Date.parse('2026-11-14T12:00:00.000Z')

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const renderSettings = async (overrides: Partial<ProjectDetail> = {}) => {
  vi.mocked(getProject).mockResolvedValue({ ...project, ...overrides })
  render(
    <MemoryRouter basename="/app" initialEntries={[`/app/projects/${project.id}/settings`]}>
      <Routes>
        <Route path="/projects/:id/settings" element={<ProjectSettingsPage />} />
        <Route path="/" element={<h1>내 프로젝트</h1>} />
      </Routes>
    </MemoryRouter>,
  )
  await screen.findByRole('heading', { level: 1, name: project.name })
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.spyOn(Date, 'now').mockReturnValue(now)
  vi.mocked(getMe).mockResolvedValue({
    id: '5b3a934d-ef8e-4ce8-b26a-a9d1cdd4983f',
    email: 'developer@example.com',
    name: '개발자',
    canCreateProjects: true,
  })
  vi.mocked(listScreens).mockResolvedValue([])
  vi.mocked(listMembers).mockResolvedValue({ members: [], invitations: [] })
  vi.mocked(archiveProject).mockResolvedValue(undefined)
  vi.mocked(unarchiveProject).mockResolvedValue(undefined)
  vi.mocked(deleteProject).mockResolvedValue(undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ProjectSettingsPage 보관과 삭제 표시', () => {
  it('진행 중이면 띠가 없고 맨 아래에 보관과 지우기 절이 있다', async () => {
    await renderSettings()
    await screen.findByRole('heading', { name: '참여자와 승인자' })

    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getAllByRole('heading').at(-1)?.textContent).toBe('보관과 지우기')
    expect(screen.getByRole('button', { name: '보관하기' })).toBeDefined()
    expect(screen.getByLabelText(confirmLabel)).toBeDefined()
    expect(screen.getByRole('button', { name: '프로젝트 지우기' }).hasAttribute('disabled')).toBe(true)
  })

  it.each(['DEVELOPER', 'CLIENT'] as const)(
    '보관한 프로젝트의 %s에게 제목 바로 아래 읽기 전용 띠를 보인다',
    async (myRole) => {
      await renderSettings({ status: 'ARCHIVED', myRole })

      const notice = screen.getByRole('status')
      expect(notice.textContent).toBe(archivedNotice)
      expect(screen.getByRole('heading', { level: 1 }).nextElementSibling).toBe(notice)
    },
  )

  it.each(['ACTIVE', 'ARCHIVED'] as const)(
    '클라이언트에게 %s 프로젝트의 보관·삭제 칸을 보이지 않는다',
    async (status) => {
      await renderSettings({ status, myRole: 'CLIENT' })

      expect(screen.queryByRole('heading', { name: '보관과 지우기' })).toBeNull()
      expect(screen.queryByRole('button', { name: /보관하기|보관 풀기|프로젝트 지우기/ })).toBeNull()
      expect(screen.queryByLabelText(confirmLabel)).toBeNull()
      expect(archiveProject).not.toHaveBeenCalled()
      expect(unarchiveProject).not.toHaveBeenCalled()
      expect(deleteProject).not.toHaveBeenCalled()
    },
  )

  it.each([
    { purgeAfter: '2026-11-15T12:00:00.001Z', message: '2일 뒤 완전히 지워져요' },
    { purgeAfter: '2026-11-14T12:00:00.001Z', message: '1일 뒤 완전히 지워져요' },
    { purgeAfter: '2026-11-14T12:00:00.000Z', message: '곧 완전히 지워져요' },
    { purgeAfter: '2026-11-14T11:59:59.999Z', message: '곧 완전히 지워져요' },
  ])('삭제 대기 개발자에게 $purgeAfter의 남은 날을 보이고 보관·삭제 칸은 감춘다', async ({ purgeAfter, message }) => {
    await renderSettings({ status: 'DELETE_PENDING', purgeAfter })

    expect(screen.getByRole('status').textContent).toBe(`삭제 대기 중인 프로젝트예요. ${message}`)
    expect(screen.getByRole('heading', { level: 1 }).nextElementSibling).toBe(screen.getByRole('status'))
    expect(screen.queryByRole('heading', { name: '보관과 지우기' })).toBeNull()
    expect(screen.queryByLabelText(confirmLabel)).toBeNull()
    expect(screen.queryByRole('button', { name: /보관하기|보관 풀기|프로젝트 지우기/ })).toBeNull()
    // 기존 쓰기 버튼은 남기고 서버가 상태를 검사한다.
    expect(screen.getByRole('button', { name: '만들기' }).hasAttribute('disabled')).toBe(false)
  })
})

describe.each([
  { status: 'ACTIVE' as const, button: '보관하기', nextButton: '보관 풀기', request: archiveProject },
  { status: 'ARCHIVED' as const, button: '보관 풀기', nextButton: '보관하기', request: unarchiveProject },
])('ProjectSettingsPage $button', ({ status, button, nextButton, request }) => {
  it('응답 전에는 상태를 유지하고 중복 요청을 막으며 성공하면 띠와 버튼을 바꾼다', async () => {
    const pending = deferred()
    vi.mocked(request).mockReturnValueOnce(pending.promise)
    await renderSettings({ status })
    fireEvent.change(screen.getByLabelText(confirmLabel), { target: { value: project.name } })
    expect(screen.getByRole('button', { name: '프로젝트 지우기' }).hasAttribute('disabled')).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: button }))

    expect(screen.getByRole('button', { name: button }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: '프로젝트 지우기' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByLabelText(confirmLabel).hasAttribute('disabled')).toBe(true)
    expect(screen.queryByRole('status')?.textContent ?? null).toBe(status === 'ARCHIVED' ? archivedNotice : null)
    fireEvent.click(screen.getByRole('button', { name: button }))
    fireEvent.click(screen.getByRole('button', { name: '프로젝트 지우기' }))
    expect(request).toHaveBeenCalledExactlyOnceWith(project.id)
    expect(deleteProject).not.toHaveBeenCalled()

    await act(async () => pending.resolve())

    expect(screen.getByRole('button', { name: nextButton }).hasAttribute('disabled')).toBe(false)
    expect(screen.queryByRole('status')?.textContent ?? null).toBe(status === 'ACTIVE' ? archivedNotice : null)
    expect(screen.getByRole('button', { name: '프로젝트 지우기' }).hasAttribute('disabled')).toBe(false)
    expect(screen.getByLabelText(confirmLabel).hasAttribute('disabled')).toBe(false)
    expect(screen.queryByRole('heading', { name: '내 프로젝트' })).toBeNull()
  })

  it('실패하면 상태를 바꾸지 않고 오류를 보이며 다시 시도할 수 있다', async () => {
    vi.mocked(request).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await renderSettings({ status })
    fireEvent.click(screen.getByRole('button', { name: button }))

    expect((await screen.findByRole('alert')).textContent).toBe('연결을 확인하고 다시 시도해 주세요')
    expect(screen.queryByRole('status')?.textContent ?? null).toBe(status === 'ARCHIVED' ? archivedNotice : null)
    expect(screen.getByRole('button', { name: button }).hasAttribute('disabled')).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: button }))

    await screen.findByRole('button', { name: nextButton })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(request).toHaveBeenCalledTimes(2)
  })
})

describe('ProjectSettingsPage 프로젝트 지우기', () => {
  it('A의 지우기 요청 중 B로 이동하면 늦은 성공 응답이 목록으로 끌어내지 않는다', async () => {
    const pending = deferred()
    const nextProject = { ...project, id: '6b62c564-585a-4f05-ae57-8d6b3bc5a47f', name: '다음 프로젝트' }
    vi.mocked(deleteProject).mockReturnValueOnce(pending.promise)
    vi.mocked(getProject).mockResolvedValueOnce(project).mockResolvedValueOnce(nextProject)
    const HistoryControls = () => {
      const navigate = useNavigate()
      const location = useLocation()
      return (
        <>
          <button onClick={() => navigate(-1)}>뒤로 가기</button>
          <output aria-label="현재 주소">{location.pathname}</output>
        </>
      )
    }
    render(
      <MemoryRouter
        basename="/app"
        initialEntries={[`/app/projects/${nextProject.id}/settings`, `/app/projects/${project.id}/settings`]}
        initialIndex={1}
      >
        <HistoryControls />
        <Routes>
          <Route path="/projects/:id/settings" element={<ProjectSettingsPage />} />
          <Route path="/" element={<h1>내 프로젝트</h1>} />
        </Routes>
      </MemoryRouter>,
    )
    fireEvent.change(await screen.findByLabelText(confirmLabel), { target: { value: project.name } })
    fireEvent.click(screen.getByRole('button', { name: '프로젝트 지우기' }))
    expect(deleteProject).toHaveBeenCalledExactlyOnceWith(project.id, project.name)

    fireEvent.click(screen.getByRole('button', { name: '뒤로 가기' }))
    await screen.findByRole('heading', { name: nextProject.name })
    const input = screen.getByLabelText<HTMLInputElement>(confirmLabel)
    expect(input.value).toBe('')
    expect(input.disabled).toBe(false)
    fireEvent.change(input, { target: { value: nextProject.name } })

    await act(async () => pending.resolve())

    expect(screen.getByLabelText('현재 주소').textContent).toBe(`/projects/${nextProject.id}/settings`)
    expect(screen.getByRole('heading', { name: nextProject.name })).toBeDefined()
    expect(screen.queryByRole('heading', { name: '내 프로젝트' })).toBeNull()
    expect(input.value).toBe(nextProject.name)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '프로젝트 지우기' }).disabled).toBe(false)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each(['', '   ', '다른 이름', 'review 프로젝트', 'Review프로젝트', 'Review  프로젝트', 'Review 프로젝트!'])(
    '이름이 "%s"이면 지우기를 잠그고 요청하지 않는다',
    async (name) => {
      await renderSettings()
      // 일치한 입력을 다시 틀리게 고쳐도 잠겨야 한다.
      fireEvent.change(screen.getByLabelText(confirmLabel), { target: { value: project.name } })
      expect(screen.getByRole('button', { name: '프로젝트 지우기' }).hasAttribute('disabled')).toBe(false)
      fireEvent.change(screen.getByLabelText(confirmLabel), { target: { value: name } })

      const button = screen.getByRole('button', { name: '프로젝트 지우기' })
      expect(button.hasAttribute('disabled')).toBe(true)
      fireEvent.click(button)
      expect(deleteProject).not.toHaveBeenCalled()
    },
  )

  it.each([
    { status: 'ACTIVE' as const, name: project.name },
    { status: 'ARCHIVED' as const, name: `  ${project.name}  ` },
  ])('$status에서 이름 "$name"은 지울 수 있고 성공하면 목록으로 간다', async ({ status, name }) => {
    const pending = deferred()
    vi.mocked(deleteProject).mockReturnValueOnce(pending.promise)
    await renderSettings({ status })
    fireEvent.change(screen.getByLabelText(confirmLabel), { target: { value: name } })
    const button = screen.getByRole('button', { name: '프로젝트 지우기' })
    expect(button.hasAttribute('disabled')).toBe(false)

    fireEvent.click(button)

    expect(button.hasAttribute('disabled')).toBe(true)
    expect(screen.getByLabelText(confirmLabel).hasAttribute('disabled')).toBe(true)
    const archiveButton = screen.getByRole('button', { name: status === 'ACTIVE' ? '보관하기' : '보관 풀기' })
    expect(archiveButton.hasAttribute('disabled')).toBe(true)
    fireEvent.click(button)
    fireEvent.click(archiveButton)
    expect(deleteProject).toHaveBeenCalledExactlyOnceWith(project.id, name)
    expect(archiveProject).not.toHaveBeenCalled()
    expect(unarchiveProject).not.toHaveBeenCalled()
    expect(screen.queryByRole('heading', { name: '내 프로젝트' })).toBeNull()

    await act(async () => pending.resolve())

    expect(screen.getByRole('heading', { name: '내 프로젝트' })).toBeDefined()
    expect(screen.queryByRole('heading', { name: project.name })).toBeNull()
  })

  it.each([
    { error: new ApiError(422, 'PROJECT_NAME_MISMATCH'), message: '프로젝트 이름이 달라요' },
    { error: new TypeError('Failed to fetch'), message: '연결을 확인하고 다시 시도해 주세요' },
  ])('삭제 실패 $message는 설정과 입력을 유지하고 재시도할 수 있다', async ({ error, message }) => {
    vi.mocked(deleteProject).mockRejectedValueOnce(error)
    await renderSettings()
    fireEvent.change(screen.getByLabelText(confirmLabel), { target: { value: project.name } })
    fireEvent.click(screen.getByRole('button', { name: '프로젝트 지우기' }))

    expect((await screen.findByRole('alert')).textContent).toBe(message)
    expect(screen.getByRole('heading', { name: project.name })).toBeDefined()
    expect((screen.getByLabelText(confirmLabel) as HTMLInputElement).value).toBe(project.name)
    expect(screen.getByRole('button', { name: '프로젝트 지우기' }).hasAttribute('disabled')).toBe(false)
    expect(screen.getByRole('button', { name: '보관하기' }).hasAttribute('disabled')).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: '프로젝트 지우기' }))
    await screen.findByRole('heading', { name: '내 프로젝트' })
    expect(deleteProject).toHaveBeenCalledTimes(2)
  })
})

describe('ProjectSettingsPage 보관과 승인자 동시 변경', () => {
  it('보관 요청 중 승인자를 바꾼 뒤 보관 응답이 와도 승인자가 옛 값으로 돌아가지 않는다', async () => {
    const pending = deferred()
    const previousApprover = { memberId: 'previous-client', name: '이전 승인자' }
    const nextApprover = { memberId: 'next-client', name: '새 승인자' }
    vi.mocked(archiveProject).mockReturnValueOnce(pending.promise)
    vi.mocked(setApprover).mockResolvedValueOnce(nextApprover)
    vi.mocked(listMembers).mockResolvedValue({
      members: [previousApprover, nextApprover].map(({ memberId, name }) => ({
        id: memberId,
        name,
        email: `${memberId}@example.com`,
        role: 'CLIENT',
        lastSeenAt: null,
      })),
      invitations: [],
    })
    await renderSettings({ approver: previousApprover })
    const choice = await screen.findByRole<HTMLSelectElement>('combobox', { name: '승인자' })
    fireEvent.click(screen.getByRole('button', { name: '보관하기' }))
    expect(archiveProject).toHaveBeenCalledExactlyOnceWith(project.id)
    fireEvent.change(choice, { target: { value: nextApprover.memberId } })
    fireEvent.click(screen.getByRole('button', { name: '승인자 저장' }))
    await screen.findByText(`${nextApprover.name}님이 최종 버전을 승인해요.`, { exact: false })
    expect(setApprover).toHaveBeenCalledExactlyOnceWith(project.id, nextApprover.memberId)
    expect(screen.queryByRole('status')).toBeNull()

    await act(async () => pending.resolve())

    expect(screen.getByRole('status').textContent).toBe(archivedNotice)
    expect(screen.getByRole('button', { name: '보관 풀기' })).toBeDefined()
    expect(screen.getByText(`${nextApprover.name}님이 최종 버전을 승인해요.`, { exact: false })).toBeDefined()
    expect(screen.queryByText(`${previousApprover.name}님이 최종 버전을 승인해요.`, { exact: false })).toBeNull()
    expect(choice.value).toBe(nextApprover.memberId)
  })
})

describe.each([
  { code: 'PROJECT_ARCHIVED', message: '보관한 프로젝트예요. 보관을 풀어야 바꿀 수 있어요' },
  { code: 'PROJECT_DELETE_PENDING', message: '삭제 대기 중인 프로젝트예요. 되살려야 바꿀 수 있어요' },
])('ProjectSettingsPage $code 오류', ({ code, message }) => {
  it.each([
    { button: '만들기', request: createScreen },
    { button: '숨기기', request: hideScreen },
    { button: '다시 보이기', request: showScreen },
    { button: '초대 보내기', request: createInvitation },
    { button: '승인자 저장', request: setApprover },
    { button: '접근 철회', request: revokeMember },
    { button: '보관하기', request: archiveProject },
    { button: '프로젝트 지우기', request: deleteProject },
  ])('$button 요청에서 상태가 바뀌었으면 서버 오류 코드에 맞는 안내를 보인다', async ({ button, request }) => {
    vi.mocked(request).mockRejectedValueOnce(new ApiError(409, code))
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    vi.mocked(listScreens).mockResolvedValue([
      { id: 'visible-screen', name: '메인', viewport: 'PC', hiddenAt: null },
      { id: 'hidden-screen', name: '소개', viewport: 'PC', hiddenAt: '2026-11-13T00:00:00.000Z' },
    ])
    vi.mocked(listMembers).mockResolvedValue({
      members: [{ id: 'client-member', name: '참여자', email: 'client@example.com', role: 'CLIENT', lastSeenAt: null }],
      invitations: [],
    })
    // 화면을 연 뒤 다른 탭에서 상태가 바뀌어도 띠 유무와 관계없이 오류를 알려야 한다.
    await renderSettings()
    await screen.findByRole('heading', { name: '참여자와 승인자' })
    fireEvent.change(screen.getByLabelText('화면 이름'), { target: { value: '새 화면' } })
    fireEvent.change(screen.getByLabelText('클라이언트 초대 이메일'), { target: { value: 'invite@example.com' } })
    fireEvent.change(screen.getByLabelText(confirmLabel), { target: { value: project.name } })
    fireEvent.click(screen.getByRole('button', { name: button }))

    expect((await screen.findByRole('alert')).textContent).toBe(message)
    expect(request).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('heading', { name: project.name })).toBeDefined()
    expect(screen.getByRole('button', { name: button }).hasAttribute('disabled')).toBe(false)
  })
})
