import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router'
import App from '../App.tsx'
import { getMe, logout, type Me } from '../api/auth.ts'
import { ApiError } from '../api/client.ts'
import { acceptInvitation, getInvitation, type InvitationPreview } from '../api/invitations.ts'
import { InvitePage } from './InvitePage.tsx'

vi.mock('../api/auth.ts', async () => {
  const actual = await vi.importActual<typeof import('../api/auth.ts')>('../api/auth.ts')
  return { ...actual, getMe: vi.fn(), logout: vi.fn() }
})

vi.mock('../api/invitations.ts', async () => {
  const actual = await vi.importActual<typeof import('../api/invitations.ts')>('../api/invitations.ts')
  return { ...actual, getInvitation: vi.fn(), acceptInvitation: vi.fn() }
})

const token = 'a'.repeat(41) + '_-'
const nextToken = 'B'.repeat(42) + '0'
const projectId = 'ebf058f0-dc9e-4a14-adcd-cb2712594e5a'
const loginPath = `/login?next=%2Finvite%2F${token}`
const preview: InvitationPreview = {
  projectName: '오브젝트 스토어',
  inviterName: '김개발',
  email: 'reader@example.com',
  status: 'PENDING',
}
const nextPreview: InvitationPreview = {
  projectName: '다음 프로젝트',
  inviterName: '이다음',
  email: 'next@example.com',
  status: 'PENDING',
}
const user: Me = {
  id: '5b3a934d-ef8e-4ce8-b26a-a9d1cdd4983f',
  email: preview.email,
  name: '김수정',
  canCreateProjects: false,
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

const InviteNavigation = () => {
  const location = useLocation()
  const navigate = useNavigate()
  return (
    <>
      <output aria-label="현재 주소">{location.pathname + location.search}</output>
      <button onClick={() => navigate(`/invite/${nextToken}`)}>다음 초대 열기</button>
    </>
  )
}

const renderInvite = (inviteToken = token) =>
  render(
    <MemoryRouter initialEntries={[`/invite/${encodeURIComponent(inviteToken)}`]}>
      <InviteNavigation />
      <Routes>
        <Route path="/invite/:token?" element={<InvitePage />} />
        <Route path="/login" element={<p>로그인 화면</p>} />
        <Route path="/" element={<p>프로젝트 목록 화면</p>} />
        <Route path="/projects/:id" element={<p>검수실 화면</p>} />
      </Routes>
    </MemoryRouter>,
  )

beforeEach(() => {
  vi.mocked(getInvitation).mockReset().mockResolvedValue(preview)
  vi.mocked(acceptInvitation).mockReset().mockResolvedValue({ projectId })
  vi.mocked(getMe).mockReset().mockResolvedValue(null)
  vi.mocked(logout).mockReset().mockResolvedValue(undefined)
})

describe('InvitePage 미리보기', () => {
  it.each(['', '.', '..', 'a'.repeat(42), 'a'.repeat(44), 'a'.repeat(42) + '!', 'a'.repeat(42) + '/'])(
    '토큰 모양이 틀리면 서버를 부르지 않는다: %j',
    async (invalidToken) => {
      renderInvite(invalidToken)

      await screen.findByRole('heading', { name: '초대 링크를 확인해 주세요' })
      expect(screen.getByRole('link', { name: '프로젝트 목록' }).getAttribute('href')).toBe('/')
      expect(getInvitation).not.toHaveBeenCalled()
      expect(getMe).not.toHaveBeenCalled()
      expect(acceptInvitation).not.toHaveBeenCalled()
      expect(screen.queryByRole('button', { name: '참여하기' })).toBeNull()
    },
  )

  it('미리보기가 끝날 때까지 참여 동작을 보여 주지 않는다', async () => {
    const pending = deferred<InvitationPreview>()
    vi.mocked(getInvitation).mockReturnValueOnce(pending.promise)
    renderInvite()

    expect(screen.getByText('불러오는 중이에요.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '참여하기' })).toBeNull()
    expect(screen.queryByRole('link', { name: '로그인하고 참여하기' })).toBeNull()
    expect(acceptInvitation).not.toHaveBeenCalled()

    await act(async () => pending.resolve(preview))
    await screen.findByRole('link', { name: '로그인하고 참여하기' })
    expect(screen.queryByText('불러오는 중이에요.')).toBeNull()
  })

  it('로그인 전에도 초대 정보와 초대로 돌아오는 로그인 링크를 보여 준다', async () => {
    renderInvite()

    const login = await screen.findByRole('link', { name: '로그인하고 참여하기' })
    expect(getInvitation).toHaveBeenCalledExactlyOnceWith(token)
    expect(screen.getByText(preview.projectName)).toBeTruthy()
    expect(screen.getByText(preview.inviterName)).toBeTruthy()
    expect(screen.getByText(preview.email)).toBeTruthy()
    expect(screen.getByText('클라이언트')).toBeTruthy()
    expect(login.getAttribute('href')).toBe(loginPath)
    expect(screen.queryByRole('button', { name: '참여하기' })).toBeNull()
    expect(acceptInvitation).not.toHaveBeenCalled()

    fireEvent.click(login)
    await screen.findByText('로그인 화면')
    expect(screen.getByLabelText('현재 주소').textContent).toBe(loginPath)
  })

  it.each([
    { status: 404, title: '초대 링크를 확인해 주세요' },
    { status: 410, title: '초대가 만료됐어요' },
  ])('미리보기 $status이면 $title 안내로 끝난다', async ({ status, title }) => {
    vi.mocked(getInvitation).mockRejectedValueOnce(new ApiError(status))
    renderInvite()

    await screen.findByRole('heading', { name: title })
    expect(screen.getByRole('link', { name: '프로젝트 목록' }).getAttribute('href')).toBe('/')
    expect(screen.queryByRole('link', { name: '로그인하고 참여하기' })).toBeNull()
    expect(screen.queryByRole('button', { name: /참여하기/ })).toBeNull()
    expect(acceptInvitation).not.toHaveBeenCalled()
  })

  it.each([
    { label: '로그인 전', me: null },
    { label: '같은 이메일', me: user },
    { label: '다른 이메일', me: { ...user, email: 'other@example.com' } },
  ])('수락된 초대는 $label에도 이미 수락했다는 안내와 목록 링크를 보여 준다', async ({ me }) => {
    vi.mocked(getMe).mockResolvedValue(me)
    vi.mocked(getInvitation).mockResolvedValueOnce({ ...preview, status: 'ACCEPTED' })
    renderInvite()

    await screen.findByRole('heading', { name: '이미 수락한 초대예요' })
    expect(screen.queryByRole('button', { name: /참여하기/ })).toBeNull()
    expect(screen.queryByRole('link', { name: '로그인하고 참여하기' })).toBeNull()
    expect(screen.queryByRole('link', { name: '검수실로 가기' })).toBeNull()
    expect(acceptInvitation).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('link', { name: '프로젝트 목록' }))
    await screen.findByText('프로젝트 목록 화면')
  })

  it.each([new TypeError('Failed to fetch'), new ApiError(500)])(
    '미리보기 연결 실패는 새로고침을 안내하고 참여를 막는다: %s',
    async (error) => {
      vi.mocked(getInvitation).mockRejectedValueOnce(error)
      renderInvite()

      await screen.findByText('연결을 확인하고 새로고침해 주세요')
      expect(screen.queryByRole('button', { name: /참여하기/ })).toBeNull()
      expect(screen.queryByRole('link', { name: '로그인하고 참여하기' })).toBeNull()
      expect(acceptInvitation).not.toHaveBeenCalled()
    },
  )

  it('App의 /app/invite/:token 주소에서 로그인 없이 초대 화면을 연다', async () => {
    render(
      <MemoryRouter basename="/app" initialEntries={[`/app/invite/${token}`]}>
        <App />
      </MemoryRouter>,
    )

    const login = await screen.findByRole('link', { name: '로그인하고 참여하기' })
    expect(screen.getByText(preview.projectName)).toBeTruthy()
    expect(login.getAttribute('href')).toBe(`/app${loginPath}`)
    expect(getInvitation).toHaveBeenCalledExactlyOnceWith(token)
  })
})

describe('InvitePage 로그인 확인과 계정 변경', () => {
  it('미리보기와 로그인 확인은 서로 끝나기를 기다리지 않고 함께 시작한다', async () => {
    const pendingPreview = deferred<InvitationPreview>()
    const pendingMe = deferred<Me | null>()
    vi.mocked(getInvitation).mockReturnValueOnce(pendingPreview.promise)
    vi.mocked(getMe).mockReturnValueOnce(pendingMe.promise)
    renderInvite()

    expect(getInvitation).toHaveBeenCalledExactlyOnceWith(token)
    expect(getMe).toHaveBeenCalledExactlyOnceWith()
    expect(screen.getByText('불러오는 중이에요.')).toBeTruthy()
    expect(acceptInvitation).not.toHaveBeenCalled()

    await act(async () => pendingMe.resolve(user))
    expect(screen.getByText('불러오는 중이에요.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '참여하기' })).toBeNull()

    await act(async () => pendingPreview.resolve(preview))
    await screen.findByRole('button', { name: '참여하기' })
    expect(screen.getByText(preview.projectName)).toBeTruthy()
  })

  it('로그인을 확인하는 동안 초대 정보만 보여 주고 참여를 막는다', async () => {
    const pending = deferred<Me | null>()
    vi.mocked(getMe).mockReturnValueOnce(pending.promise)
    renderInvite()

    await screen.findByText('확인하는 중이에요.')
    expect(screen.getByText(preview.projectName)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '참여하기' })).toBeNull()
    expect(screen.queryByRole('link', { name: '로그인하고 참여하기' })).toBeNull()
    expect(acceptInvitation).not.toHaveBeenCalled()

    await act(async () => pending.resolve(user))
    await screen.findByRole('button', { name: '참여하기' })
    expect(screen.queryByText('확인하는 중이에요.')).toBeNull()
  })

  it('로그인 확인 실패를 비로그인으로 취급하지 않고 새로고침을 안내한다', async () => {
    vi.mocked(getMe).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    renderInvite()

    await screen.findByText('불러오지 못했어요. 잠시 뒤 새로고침해 주세요')
    expect(screen.queryByText('확인하는 중이에요.')).toBeNull()
    expect(screen.queryByRole('button', { name: /참여하기/ })).toBeNull()
    expect(screen.queryByRole('link', { name: '로그인하고 참여하기' })).toBeNull()
    expect(acceptInvitation).not.toHaveBeenCalled()
  })

  it.each(['성공', '실패'])('다른 이메일은 참여할 수 없고 로그아웃 %s 후 로그인으로 이동한다', async (outcome) => {
    const pending = deferred<void>()
    vi.mocked(getMe).mockResolvedValueOnce({ ...user, email: 'other@example.com' })
    vi.mocked(logout).mockReturnValueOnce(pending.promise)
    renderInvite()

    const switchAccount = await screen.findByRole('button', { name: '다른 이메일로 로그인' })
    expect(screen.getByText(/지금 로그인한 이메일과 초대받은 이메일이 달라요/)).toBeTruthy()
    expect(screen.getByText('other@example.com')).toBeTruthy()
    expect(screen.getByText(preview.email)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '참여하기' })).toBeNull()
    expect(acceptInvitation).not.toHaveBeenCalled()
    expect(logout).not.toHaveBeenCalled()

    fireEvent.click(switchAccount)
    expect(logout).toHaveBeenCalledExactlyOnceWith()
    expect(screen.getByLabelText('현재 주소').textContent).toBe(`/invite/${token}`)
    await act(async () => {
      if (outcome === '성공') pending.resolve(undefined)
      if (outcome === '실패') pending.reject(new TypeError('Failed to fetch'))
    })

    await screen.findByText('로그인 화면')
    expect(screen.getByLabelText('현재 주소').textContent).toBe(loginPath)
    expect(acceptInvitation).not.toHaveBeenCalled()
  })
})

describe('InvitePage 참여', () => {
  beforeEach(() => {
    vi.mocked(getMe).mockResolvedValue(user)
  })

  it('같은 이메일로 참여하면 중복 클릭을 막고 응답의 프로젝트 검수실로 안내한다', async () => {
    const pending = deferred<{ projectId: string }>()
    vi.mocked(acceptInvitation).mockReturnValueOnce(pending.promise)
    renderInvite()

    const join = await screen.findByRole<HTMLButtonElement>('button', { name: '참여하기' })
    expect(screen.getByText(/reader@example.com로 로그인했어요/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '다른 이메일로 로그인' })).toBeNull()
    expect(screen.getByRole('link', { name: '나중에 하기' }).getAttribute('href')).toBe('/')
    expect(acceptInvitation).not.toHaveBeenCalled()
    expect(join.disabled).toBe(false)

    fireEvent.click(join)
    expect(join.disabled).toBe(true)
    fireEvent.click(join)
    expect(acceptInvitation).toHaveBeenCalledExactlyOnceWith(token)
    expect(screen.queryByRole('heading', { name: '프로젝트에 참여했어요' })).toBeNull()
    await act(async () => pending.resolve({ projectId }))

    await screen.findByRole('heading', { name: '프로젝트에 참여했어요' })
    expect(screen.queryByRole('button', { name: /참여하기/ })).toBeNull()
    const reviewRoom = screen.getByRole('link', { name: '검수실로 가기' })
    expect(reviewRoom.getAttribute('href')).toBe(`/projects/${projectId}`)
    fireEvent.click(reviewRoom)
    await screen.findByText('검수실 화면')
    expect(screen.getByLabelText('현재 주소').textContent).toBe(`/projects/${projectId}`)
  })

  it('나중에 하기를 누르면 수락하지 않고 목록으로 이동한다', async () => {
    renderInvite()
    fireEvent.click(await screen.findByRole('link', { name: '나중에 하기' }))

    await screen.findByText('프로젝트 목록 화면')
    expect(acceptInvitation).not.toHaveBeenCalled()
  })

  it.each([
    { status: 409, code: 'PROJECT_FULL', title: '참여할 수 있는 인원이 찼어요' },
    { status: 409, code: 'ALREADY_MEMBER', title: '이미 참여한 프로젝트예요' },
    { status: 410, code: undefined, title: '초대가 만료됐어요' },
    { status: 404, code: undefined, title: '초대 링크를 확인해 주세요' },
  ])('미리보기 후 참여가 $status $code로 거절되면 $title 안내로 끝난다', async ({ status, code, title }) => {
    vi.mocked(acceptInvitation).mockRejectedValueOnce(new ApiError(status, code))
    renderInvite()
    fireEvent.click(await screen.findByRole('button', { name: '참여하기' }))

    await screen.findByRole('heading', { name: title })
    expect(acceptInvitation).toHaveBeenCalledExactlyOnceWith(token)
    expect(screen.getByRole('link', { name: '프로젝트 목록' }).getAttribute('href')).toBe('/')
    expect(screen.queryByRole('button', { name: /참여하기/ })).toBeNull()
    expect(screen.queryByRole('link', { name: '검수실로 가기' })).toBeNull()
    expect(screen.queryByText('연결을 확인하고 다시 시도해 주세요')).toBeNull()
  })

  it('참여가 403 EMAIL_MISMATCH로 거절되면 초대받은 이메일로 로그인을 안내하고 다시 참여할 수 있다', async () => {
    vi.mocked(acceptInvitation).mockRejectedValueOnce(new ApiError(403, 'EMAIL_MISMATCH'))
    renderInvite()
    fireEvent.click(await screen.findByRole('button', { name: '참여하기' }))

    await screen.findByText('초대받은 이메일로 로그인해 주세요')
    expect(screen.getByText(preview.projectName)).toBeTruthy()
    expect(screen.queryByText('연결을 확인하고 다시 시도해 주세요')).toBeNull()
    const retry = screen.getByRole<HTMLButtonElement>('button', { name: '다시 참여하기' })
    expect(retry.disabled).toBe(false)
    expect(acceptInvitation).toHaveBeenCalledExactlyOnceWith(token)

    fireEvent.click(retry)
    await screen.findByRole('heading', { name: '프로젝트에 참여했어요' })
    expect(acceptInvitation).toHaveBeenCalledTimes(2)
    expect(acceptInvitation).toHaveBeenNthCalledWith(2, token)
    expect(screen.queryByText('초대받은 이메일로 로그인해 주세요')).toBeNull()
  })

  it('참여가 401로 거절되면 다시 참여하기와 초대로 돌아오는 로그인 링크를 보여 준다', async () => {
    vi.mocked(acceptInvitation).mockRejectedValueOnce(new ApiError(401))
    renderInvite()
    fireEvent.click(await screen.findByRole('button', { name: '참여하기' }))

    await screen.findByText('로그인이 끝났어요.')
    expect(screen.getByText(preview.projectName)).toBeTruthy()
    expect(screen.queryByText('연결을 확인하고 다시 시도해 주세요')).toBeNull()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '다시 참여하기' }).disabled).toBe(false)
    expect(acceptInvitation).toHaveBeenCalledExactlyOnceWith(token)
    const login = screen.getByRole('link', { name: '다시 로그인하기' })
    expect(login.getAttribute('href')).toBe(loginPath)

    fireEvent.click(login)
    await screen.findByText('로그인 화면')
    expect(screen.getByLabelText('현재 주소').textContent).toBe(loginPath)
  })

  it.each([
    { label: '네트워크 오류', error: new TypeError('Failed to fetch') },
    { label: '서버 오류', error: new ApiError(500) },
  ])('$label이면 연결 안내 후 같은 토큰으로 다시 참여할 수 있다', async ({ error }) => {
    const pending = deferred<{ projectId: string }>()
    vi.mocked(acceptInvitation).mockRejectedValueOnce(error).mockReturnValueOnce(pending.promise)
    renderInvite()
    fireEvent.click(await screen.findByRole('button', { name: '참여하기' }))

    await screen.findByText('연결을 확인하고 다시 시도해 주세요')
    expect(screen.getByText(preview.projectName)).toBeTruthy()
    const retry = screen.getByRole<HTMLButtonElement>('button', { name: '다시 참여하기' })
    expect(retry.disabled).toBe(false)
    fireEvent.click(retry)

    expect(screen.queryByText('연결을 확인하고 다시 시도해 주세요')).toBeNull()
    const joining = screen.getByRole<HTMLButtonElement>('button', { name: '참여하기' })
    expect(joining.disabled).toBe(true)
    fireEvent.click(joining)
    expect(acceptInvitation).toHaveBeenCalledTimes(2)
    expect(acceptInvitation).toHaveBeenNthCalledWith(1, token)
    expect(acceptInvitation).toHaveBeenNthCalledWith(2, token)

    await act(async () => pending.resolve({ projectId }))
    await screen.findByRole('heading', { name: '프로젝트에 참여했어요' })
    expect(screen.queryByRole('button', { name: /참여하기/ })).toBeNull()
  })
})

describe('InvitePage 다른 초대로 이동', () => {
  it('이전 초대 정보와 참여 완료 상태를 지우고 새 초대를 불러온다', async () => {
    const pending = deferred<InvitationPreview>()
    vi.mocked(getMe).mockResolvedValueOnce(user)
    vi.mocked(getInvitation).mockResolvedValueOnce(preview).mockReturnValueOnce(pending.promise)
    renderInvite()
    fireEvent.click(await screen.findByRole('button', { name: '참여하기' }))
    await screen.findByRole('heading', { name: '프로젝트에 참여했어요' })

    fireEvent.click(screen.getByRole('button', { name: '다음 초대 열기' }))
    expect(screen.getByText('불러오는 중이에요.')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: '프로젝트에 참여했어요' })).toBeNull()
    expect(screen.queryByRole('link', { name: '검수실로 가기' })).toBeNull()
    await act(async () => pending.resolve(nextPreview))

    const login = await screen.findByRole('link', { name: '로그인하고 참여하기' })
    expect(screen.getByText(nextPreview.projectName)).toBeTruthy()
    expect(screen.getByText(nextPreview.inviterName)).toBeTruthy()
    expect(screen.getByText(nextPreview.email)).toBeTruthy()
    expect(screen.queryByText(preview.projectName)).toBeNull()
    expect(screen.queryByText(preview.inviterName)).toBeNull()
    expect(screen.queryByText(preview.email)).toBeNull()
    expect(login.getAttribute('href')).toBe(`/login?next=%2Finvite%2F${nextToken}`)
    expect(getInvitation).toHaveBeenNthCalledWith(2, nextToken)
  })

  it.each(['성공', '실패'])('이전 미리보기가 늦게 %s해도 새 초대 내용을 덮지 않는다', async (outcome) => {
    const pending = deferred<InvitationPreview>()
    vi.mocked(getInvitation).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(nextPreview)
    renderInvite()
    fireEvent.click(screen.getByRole('button', { name: '다음 초대 열기' }))
    await screen.findByRole('link', { name: '로그인하고 참여하기' })

    await act(async () => {
      if (outcome === '성공') pending.resolve(preview)
      if (outcome === '실패') pending.reject(new ApiError(410))
    })

    expect(screen.getByText(nextPreview.projectName)).toBeTruthy()
    expect(screen.getByText(nextPreview.email)).toBeTruthy()
    expect(screen.queryByText(preview.projectName)).toBeNull()
    expect(screen.queryByRole('heading', { name: '초대가 만료됐어요' })).toBeNull()
    expect(screen.getByRole('link', { name: '로그인하고 참여하기' }).getAttribute('href')).toBe(
      `/login?next=%2Finvite%2F${nextToken}`,
    )
  })

  it.each(['성공', '실패'])('이전 수락 요청이 늦게 %s해도 새 초대에서 참여할 수 있다', async (outcome) => {
    const pending = deferred<{ projectId: string }>()
    vi.mocked(getMe).mockResolvedValue(user)
    vi.mocked(getInvitation)
      .mockResolvedValueOnce(preview)
      .mockResolvedValueOnce({ ...nextPreview, email: user.email })
    vi.mocked(acceptInvitation).mockReturnValueOnce(pending.promise)
    renderInvite()
    fireEvent.click(await screen.findByRole('button', { name: '참여하기' }))
    fireEvent.click(screen.getByRole('button', { name: '다음 초대 열기' }))
    await screen.findByRole('button', { name: '참여하기' })

    await act(async () => {
      if (outcome === '성공') pending.resolve({ projectId })
      if (outcome === '실패') pending.reject(new ApiError(409, 'PROJECT_FULL'))
    })

    expect(screen.getByText(nextPreview.projectName)).toBeTruthy()
    expect(screen.queryByText(preview.projectName)).toBeNull()
    expect(screen.queryByRole('heading', { name: '프로젝트에 참여했어요' })).toBeNull()
    expect(screen.queryByRole('heading', { name: '참여할 수 있는 인원이 찼어요' })).toBeNull()
    const join = screen.getByRole<HTMLButtonElement>('button', { name: '참여하기' })
    expect(join.disabled).toBe(false)
    fireEvent.click(join)

    await screen.findByRole('heading', { name: '프로젝트에 참여했어요' })
    expect(acceptInvitation).toHaveBeenNthCalledWith(1, token)
    expect(acceptInvitation).toHaveBeenNthCalledWith(2, nextToken)
    expect(acceptInvitation).toHaveBeenCalledTimes(2)
  })
})
