import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router'
import { ApiError, type AuthUser, getMe, logout } from '../api/auth.ts'
import styles from '../components/Button.module.css'
import { HomePage } from './HomePage.tsx'

vi.mock('../api/auth.ts', async () => {
  const actual = await vi.importActual<typeof import('../api/auth.ts')>('../api/auth.ts')
  return { ...actual, getMe: vi.fn(), logout: vi.fn() }
})

const user = { id: '5b3a934d-ef8e-4ce8-b26a-a9d1cdd4983f', email: 'reader@example.com', name: '김수정' }

const BackButton = () => {
  const navigate = useNavigate()
  return <button onClick={() => navigate(-1)}>뒤로 가기</button>
}

const renderHome = (basename = '/') => {
  const prefix = basename === '/' ? '' : basename
  return render(
    <MemoryRouter basename={basename} initialEntries={[`${prefix}/previous`, `${prefix}/`]} initialIndex={1}>
      <BackButton />
      <Routes>
        <Route path="/previous" element={<p>이전 화면</p>} />
        <Route path="/" element={<HomePage />} />
        <Route path="/login" element={<h1>로그인</h1>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.mocked(getMe).mockReset().mockResolvedValue(user)
  vi.mocked(logout).mockReset().mockResolvedValue(undefined)
})

describe('HomePage', () => {
  it('사용자 확인을 한 번 요청하고 응답 전에는 확인 중 문단만 보여 준다', async () => {
    let resolveUser!: (value: AuthUser) => void
    vi.mocked(getMe).mockImplementationOnce(
      () =>
        new Promise<AuthUser>((resolve) => {
          resolveUser = resolve
        }),
    )
    renderHome()

    expect(getMe).toHaveBeenCalledExactlyOnceWith()
    expect(screen.getByText('확인하는 중이에요.').tagName).toBe('P')
    expect(screen.queryByRole('heading')).toBeNull()
    expect(screen.queryByRole('button', { name: '로그아웃' })).toBeNull()
    expect(logout).not.toHaveBeenCalled()

    resolveUser(user)

    expect(await screen.findByRole('heading', { level: 1, name: `${user.name}님, 안녕하세요` })).toBeDefined()
    expect(screen.queryByText('확인하는 중이에요.')).toBeNull()
    expect(getMe).toHaveBeenCalledExactlyOnceWith()
  })

  it.each([user.name, '김', '가'.repeat(30)])('사용자 이름 %s와 secondary 로그아웃 버튼을 보여 준다', async (name) => {
    vi.mocked(getMe).mockResolvedValueOnce({ ...user, name })
    renderHome()

    expect(await screen.findByRole('heading', { level: 1, name: `${name}님, 안녕하세요` })).toBeDefined()
    const button = screen.getByRole<HTMLButtonElement>('button', { name: '로그아웃' })
    expect(button.classList.contains(styles.secondary)).toBe(true)
    expect(button.disabled).toBe(false)
    expect(screen.queryByText('확인하는 중이에요.')).toBeNull()
    expect(screen.queryByRole('heading', { name: '로그인' })).toBeNull()
    expect(getMe).toHaveBeenCalledExactlyOnceWith()
    expect(logout).not.toHaveBeenCalled()
  })

  it('로그인하지 않았으면 로그인 화면으로 바꾸고 뒤로 가도 첫 화면을 다시 거치지 않는다', async () => {
    vi.mocked(getMe).mockResolvedValueOnce(null)
    renderHome()

    expect(await screen.findByRole('heading', { name: '로그인' })).toBeDefined()
    expect(screen.queryByText('확인하는 중이에요.')).toBeNull()
    expect(screen.queryByRole('heading', { name: `${user.name}님, 안녕하세요` })).toBeNull()
    expect(screen.queryByRole('button', { name: '로그아웃' })).toBeNull()
    expect(logout).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '뒤로 가기' }))

    expect(await screen.findByText('이전 화면')).toBeDefined()
    expect(screen.queryByRole('heading', { name: '로그인' })).toBeNull()
    expect(getMe).toHaveBeenCalledExactlyOnceWith()
  })

  it.each([
    { reason: '네트워크 오류', error: new TypeError('Failed to fetch') },
    { reason: '서버 오류', error: new ApiError(500) },
  ])('사용자 확인 중 $reason가 나면 확인 중 문구를 오류로 바꾸고 로그인 화면으로 보내지 않는다', async ({ error }) => {
    vi.mocked(getMe).mockRejectedValueOnce(error)
    renderHome()

    expect(screen.getByText('확인하는 중이에요.')).toBeDefined()
    expect((await screen.findByText('불러오지 못했어요. 잠시 뒤 새로고침해 주세요')).tagName).toBe('P')
    expect(screen.queryByText('확인하는 중이에요.')).toBeNull()
    expect(screen.queryByRole('heading')).toBeNull()
    expect(screen.queryByRole('button', { name: '로그아웃' })).toBeNull()
    expect(getMe).toHaveBeenCalledExactlyOnceWith()
    expect(logout).not.toHaveBeenCalled()
  })

  it.each(['/', '/app'])(
    'basename이 %s일 때 로그아웃 응답을 기다린 뒤 로그인 화면으로 바꾸고 뒤로 가면 이전 화면이 나온다',
    async (basename) => {
      let resolveLogout!: () => void
      vi.mocked(logout).mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveLogout = resolve
          }),
      )
      renderHome(basename)
      const heading = await screen.findByRole('heading', { level: 1, name: `${user.name}님, 안녕하세요` })

      fireEvent.click(screen.getByRole('button', { name: '로그아웃' }))

      expect(logout).toHaveBeenCalledExactlyOnceWith()
      expect(screen.getByRole('heading', { name: `${user.name}님, 안녕하세요` })).toBe(heading)
      expect(screen.queryByRole('heading', { name: '로그인' })).toBeNull()

      resolveLogout()

      expect(await screen.findByRole('heading', { name: '로그인' })).toBeDefined()
      expect(screen.queryByRole('heading', { name: `${user.name}님, 안녕하세요` })).toBeNull()
      expect(screen.queryByRole('button', { name: '로그아웃' })).toBeNull()

      fireEvent.click(screen.getByRole('button', { name: '뒤로 가기' }))

      expect(await screen.findByText('이전 화면')).toBeDefined()
      expect(screen.queryByRole('heading', { name: '로그인' })).toBeNull()
      expect(getMe).toHaveBeenCalledExactlyOnceWith()
      expect(logout).toHaveBeenCalledExactlyOnceWith()
    },
  )

  it.each([
    { reason: '네트워크 오류', error: new TypeError('Failed to fetch') },
    { reason: '서버 오류', error: new ApiError(500) },
  ])('로그아웃 중 $reason가 나면 제목과 버튼 아래에 오류를 보여 주고 다시 시도할 수 있다', async ({ error }) => {
    vi.mocked(logout).mockRejectedValueOnce(error)
    renderHome()
    const heading = await screen.findByRole('heading', { level: 1, name: `${user.name}님, 안녕하세요` })
    const button = screen.getByRole<HTMLButtonElement>('button', { name: '로그아웃' })

    fireEvent.click(button)

    const message = await screen.findByText('로그아웃하지 못했어요. 다시 눌러 주세요')
    expect(screen.getByRole('heading', { name: `${user.name}님, 안녕하세요` })).toBe(heading)
    expect(screen.getByRole('button', { name: '로그아웃' })).toBe(button)
    expect(button.disabled).toBe(false)
    expect(button.compareDocumentPosition(message) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    expect(screen.queryByRole('heading', { name: '로그인' })).toBeNull()
    expect(logout).toHaveBeenCalledExactlyOnceWith()
    expect(getMe).toHaveBeenCalledExactlyOnceWith()

    fireEvent.click(button)

    expect(await screen.findByRole('heading', { name: '로그인' })).toBeDefined()
    expect(logout).toHaveBeenCalledTimes(2)
    expect(logout).toHaveBeenLastCalledWith()
    expect(screen.queryByText('로그아웃하지 못했어요. 다시 눌러 주세요')).toBeNull()
    expect(screen.queryByRole('heading', { name: `${user.name}님, 안녕하세요` })).toBeNull()
    expect(screen.queryByRole('button', { name: '로그아웃' })).toBeNull()
  })
})
