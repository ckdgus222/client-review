import { StrictMode } from 'react'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { Link, MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router'
import { type Me, getMe, logout } from '../api/auth.ts'
import { createProject, getProject, listProjects, listScreens, type MyProject } from '../api/projects.ts'
import App from '../App.tsx'
import { ApiError } from '../api/client.ts'
import styles from '../components/Button.module.css'
import { ProjectListPage } from './ProjectListPage.tsx'

vi.mock('../api/auth.ts', async () => {
  const actual = await vi.importActual<typeof import('../api/auth.ts')>('../api/auth.ts')
  return { ...actual, getMe: vi.fn(), logout: vi.fn() }
})

vi.mock('../api/projects.ts', async () => {
  const actual = await vi.importActual<typeof import('../api/projects.ts')>('../api/projects.ts')
  return { ...actual, listProjects: vi.fn(), createProject: vi.fn(), getProject: vi.fn(), listScreens: vi.fn() }
})

const user: Me = {
  canCreateProjects: true,
  id: '5b3a934d-ef8e-4ce8-b26a-a9d1cdd4983f',
  email: 'reader@example.com',
  name: '김수정',
}

const projects: MyProject[] = [
  {
    id: 'f0f3d1f8-68a4-4f55-99cc-d2c625451f43',
    name: '새 프로젝트',
    myRole: 'CLIENT',
    createdAt: '2026-11-05T00:00:00.000Z',
  },
  {
    id: 'ebf058f0-dc9e-4a14-adcd-cb2712594e5a',
    name: '이전 프로젝트',
    myRole: 'DEVELOPER',
    createdAt: '2026-11-04T00:00:00.000Z',
  },
]

const CurrentPath = () => {
  const location = useLocation()
  return <output aria-label="현재 주소">{location.pathname}</output>
}

const BackButton = () => {
  const navigate = useNavigate()
  return <button onClick={() => navigate(-1)}>뒤로 가기</button>
}

const renderProjectList = (basename = '/') => {
  const prefix = basename === '/' ? '' : basename
  return render(
    <MemoryRouter basename={basename} initialEntries={[`${prefix}/previous`, `${prefix}/`]} initialIndex={1}>
      <BackButton />
      <CurrentPath />
      <Routes>
        <Route path="/previous" element={<p>이전 화면</p>} />
        <Route path="/" element={<ProjectListPage />} />
        <Route path="/projects/:id" element={<h1>검수실</h1>} />
        <Route path="/projects/:id/settings" element={<h1>프로젝트 설정</h1>} />
        <Route path="/login" element={<h1>로그인</h1>} />
      </Routes>
    </MemoryRouter>,
  )
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

const renderApp = (basename = '/') =>
  render(
    <StrictMode>
      <MemoryRouter basename={basename} initialEntries={[basename]}>
        <CurrentPath />
        <Routes>
          <Route
            path="/projects/:id"
            element={
              <>
                <h1>검수실</h1>
                <Link to="/">프로젝트 목록</Link>
              </>
            }
          />
          <Route path="*" element={<App />} />
        </Routes>
      </MemoryRouter>
    </StrictMode>,
  )

beforeEach(() => {
  vi.mocked(getMe).mockReset().mockResolvedValue(user)
  vi.mocked(listProjects).mockReset().mockResolvedValue([])
  vi.mocked(createProject).mockReset().mockResolvedValue(projects[0])
  vi.mocked(logout).mockReset().mockResolvedValue(undefined)
  vi.mocked(getProject)
    .mockReset()
    .mockResolvedValue({ ...projects[1], currentVersion: null })
  vi.mocked(listScreens).mockReset().mockResolvedValue([])
})

describe('ProjectListPage', () => {
  it('사용자 확인을 한 번 요청하고 응답 전에는 확인 중 문단만 보여 준다', async () => {
    let resolveUser!: (value: Me) => void
    vi.mocked(getMe).mockImplementationOnce(
      () =>
        new Promise<Me>((resolve) => {
          resolveUser = resolve
        }),
    )
    renderProjectList()

    expect(getMe).toHaveBeenCalledExactlyOnceWith()
    expect(screen.getByText('확인하는 중이에요.').tagName).toBe('P')
    expect(screen.queryByRole('heading')).toBeNull()
    expect(screen.queryByRole('button', { name: '로그아웃' })).toBeNull()
    expect(logout).not.toHaveBeenCalled()

    resolveUser(user)

    expect(await screen.findByRole('heading', { level: 1, name: '내 프로젝트' })).toBeDefined()
    expect(screen.queryByText('확인하는 중이에요.')).toBeNull()
    expect(getMe).toHaveBeenCalledExactlyOnceWith()
  })

  it.each([user.name, '김', '가'.repeat(30)])('사용자 이름 %s와 secondary 로그아웃 버튼을 보여 준다', async (name) => {
    vi.mocked(getMe).mockResolvedValueOnce({ ...user, name })
    renderProjectList()

    expect(await screen.findByRole('heading', { level: 1, name: '내 프로젝트' })).toBeDefined()
    expect(screen.getByText(`${name}님`)).toBeDefined()
    const button = screen.getByRole<HTMLButtonElement>('button', { name: '로그아웃' })
    expect(button.classList.contains(styles.secondary)).toBe(true)
    expect(button.disabled).toBe(false)
    expect(screen.queryByText('확인하는 중이에요.')).toBeNull()
    expect(screen.queryByRole('heading', { name: '로그인' })).toBeNull()
    expect(getMe).toHaveBeenCalledExactlyOnceWith()
    expect(logout).not.toHaveBeenCalled()
  })

  it.each(['/', '/app'])(
    'basename이 %s일 때 로그인하지 않았으면 로그인 화면으로 바꾸고 뒤로 가도 다시 거치지 않는다',
    async (basename) => {
      vi.mocked(getMe).mockResolvedValueOnce(null)
      renderProjectList(basename)

      expect(await screen.findByRole('heading', { name: '로그인' })).toBeDefined()
      expect(screen.queryByText('확인하는 중이에요.')).toBeNull()
      expect(screen.queryByRole('heading', { name: '내 프로젝트' })).toBeNull()
      expect(screen.queryByRole('button', { name: '로그아웃' })).toBeNull()
      expect(logout).not.toHaveBeenCalled()

      fireEvent.click(screen.getByRole('button', { name: '뒤로 가기' }))

      expect(await screen.findByText('이전 화면')).toBeDefined()
      expect(screen.queryByRole('heading', { name: '로그인' })).toBeNull()
      expect(getMe).toHaveBeenCalledExactlyOnceWith()
    },
  )

  it.each([
    { reason: '네트워크 오류', error: new TypeError('Failed to fetch') },
    { reason: '서버 오류', error: new ApiError(500) },
  ])('사용자 확인 중 $reason가 나면 확인 중 문구를 오류로 바꾸고 로그인 화면으로 보내지 않는다', async ({ error }) => {
    vi.mocked(getMe).mockRejectedValueOnce(error)
    renderProjectList()

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
      renderProjectList(basename)
      const heading = await screen.findByRole('heading', { level: 1, name: '내 프로젝트' })

      fireEvent.click(screen.getByRole('button', { name: '로그아웃' }))

      expect(logout).toHaveBeenCalledExactlyOnceWith()
      expect(screen.getByRole('heading', { name: '내 프로젝트' })).toBe(heading)
      expect(screen.queryByRole('heading', { name: '로그인' })).toBeNull()

      resolveLogout()

      expect(await screen.findByRole('heading', { name: '로그인' })).toBeDefined()
      expect(screen.queryByRole('heading', { name: '내 프로젝트' })).toBeNull()
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
    renderProjectList()
    const heading = await screen.findByRole('heading', { level: 1, name: '내 프로젝트' })
    const button = screen.getByRole<HTMLButtonElement>('button', { name: '로그아웃' })

    fireEvent.click(button)

    const message = await screen.findByText('로그아웃하지 못했어요. 다시 눌러 주세요')
    expect(screen.getByRole('heading', { name: '내 프로젝트' })).toBe(heading)
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
    expect(screen.queryByRole('heading', { name: '내 프로젝트' })).toBeNull()
    expect(screen.queryByRole('button', { name: '로그아웃' })).toBeNull()
  })
})

describe('ProjectListPage 목록', () => {
  it.each(['/', '/app'])('basename이 %s일 때 받은 순서대로 프로젝트 이름과 설정 링크를 보여 준다', async (basename) => {
    vi.mocked(listProjects).mockResolvedValueOnce(projects)
    renderProjectList(basename)

    const list = await screen.findByRole('list')
    const links = within(list).getAllByRole('link')
    const prefix = basename === '/' ? '' : basename
    expect(links.map((link) => link.textContent)).toEqual(projects.map((project) => project.name))
    expect(links.map((link) => link.getAttribute('href'))).toEqual(
      projects.map((project) => `${prefix}/projects/${project.id}`),
    )
    expect(listProjects).toHaveBeenCalledExactlyOnceWith()
    expect(screen.queryByText('아직 프로젝트가 없어요.')).toBeNull()
    expect(screen.queryByText('불러오는 중이에요.')).toBeNull()

    fireEvent.click(links[0])

    expect(await screen.findByRole('heading', { name: '검수실' })).toBeDefined()
    expect(screen.getByLabelText('현재 주소').textContent).toBe(`/projects/${projects[0].id}`)
  })

  it('목록 응답을 기다리는 동안 불러오는 중 문구를 보여 주고 빈 목록과 구분한다', async () => {
    let resolveProjects!: (value: MyProject[]) => void
    vi.mocked(listProjects).mockImplementationOnce(
      () =>
        new Promise<MyProject[]>((resolve) => {
          resolveProjects = resolve
        }),
    )
    renderProjectList()

    expect(await screen.findByText('불러오는 중이에요.')).toBeDefined()
    expect(screen.getByRole('heading', { name: '내 프로젝트' })).toBeDefined()
    expect(screen.queryByText('아직 프로젝트가 없어요.')).toBeNull()
    expect(screen.queryByRole('list')).toBeNull()

    resolveProjects(projects)

    expect(await screen.findByRole('link', { name: projects[0].name })).toBeDefined()
    expect(screen.queryByText('불러오는 중이에요.')).toBeNull()
    expect(listProjects).toHaveBeenCalledExactlyOnceWith()
  })

  it('빈 목록이면 아직 프로젝트가 없다는 문구를 보여 준다', async () => {
    renderProjectList()

    expect(await screen.findByText('아직 프로젝트가 없어요.')).toBeDefined()
    expect(screen.queryByText('불러오는 중이에요.')).toBeNull()
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each([
    { reason: '네트워크 오류', error: new TypeError('Failed to fetch'), message: '연결을 확인하고 다시 시도해 주세요' },
    { reason: '서버 오류', error: new ApiError(500), message: '잠시 뒤 다시 시도해 주세요' },
  ])('목록의 $reason를 빈 목록과 구분하고 로그인 화면으로 보내지 않는다', async ({ error, message }) => {
    vi.mocked(listProjects).mockRejectedValueOnce(error)
    renderProjectList()

    expect((await screen.findByRole('alert')).textContent).toBe(message)
    expect(screen.getByRole('heading', { name: '내 프로젝트' })).toBeDefined()
    expect(screen.queryByText('불러오는 중이에요.')).toBeNull()
    expect(screen.queryByText('아직 프로젝트가 없어요.')).toBeNull()
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.queryByRole('link', { name: '다시 로그인하기' })).toBeNull()
    expect(screen.getByLabelText('현재 주소').textContent).toBe('/')
  })

  it.each(['/', '/app'])(
    'basename이 %s일 때 목록 401은 쓰던 이름을 보존하고 로그인 링크만 보여 준다',
    async (basename) => {
      let rejectProjects!: (reason: unknown) => void
      vi.mocked(listProjects).mockImplementationOnce(
        () =>
          new Promise<never>((_, reject) => {
            rejectProjects = reject
          }),
      )
      renderProjectList(basename)
      const input = await screen.findByLabelText<HTMLInputElement>('프로젝트 이름')
      fireEvent.change(input, { target: { value: '쓰던 프로젝트' } })

      rejectProjects(new ApiError(401))

      expect((await screen.findByRole('alert')).textContent).toContain('로그인이 끝났어요. 다시 로그인해 주세요')
      expect(input.value).toBe('쓰던 프로젝트')
      expect(screen.queryByRole('heading', { name: '로그인' })).toBeNull()
      expect(screen.queryByText('불러오는 중이에요.')).toBeNull()
      expect(screen.queryByText('아직 프로젝트가 없어요.')).toBeNull()
      expect(screen.getByLabelText('현재 주소').textContent).toBe('/')
      const link = screen.getByRole('link', { name: '다시 로그인하기' })
      expect(link.getAttribute('href')).toBe(basename === '/' ? '/login' : '/app/login')

      fireEvent.click(link)

      expect(await screen.findByRole('heading', { name: '로그인' })).toBeDefined()
      expect(screen.getByLabelText('현재 주소').textContent).toBe('/login')
    },
  )
})

describe('ProjectListPage 만들기 응답과 화면 이동', () => {
  it.each(['/', '/app'])(
    'basename이 %s일 때 검수실로 떠난 뒤 성공 응답이 와도 주소와 화면을 보존하고 다음 목록에서 만든 프로젝트를 보여 준다',
    async (basename) => {
      const pendingCreate = deferred<MyProject>()
      const createdProject: MyProject = { ...projects[0], name: '새 의뢰', myRole: 'DEVELOPER' }
      vi.mocked(createProject).mockReturnValueOnce(pendingCreate.promise)
      vi.mocked(listProjects).mockResolvedValue([projects[1]])
      renderApp(basename)
      fireEvent.change(await screen.findByLabelText('프로젝트 이름'), { target: { value: '새 의뢰' } })
      fireEvent.click(screen.getByRole('button', { name: '만들기' }))
      expect(createProject).toHaveBeenCalledExactlyOnceWith('새 의뢰')

      fireEvent.click(screen.getByRole('link', { name: projects[1].name }))
      const room = await screen.findByRole('heading', { name: '검수실' })
      expect(screen.getByLabelText('현재 주소').textContent).toBe(`/projects/${projects[1].id}`)

      await act(async () => {
        pendingCreate.resolve(createdProject)
        await pendingCreate.promise
      })

      expect(screen.getByLabelText('현재 주소').textContent).toBe(`/projects/${projects[1].id}`)
      expect(screen.getByRole('heading', { name: '검수실' })).toBe(room)
      expect(screen.queryByRole('alert')).toBeNull()

      vi.mocked(listProjects).mockResolvedValue([createdProject, projects[1]])
      fireEvent.click(screen.getByRole('link', { name: '프로젝트 목록' }))

      const createdLink = await screen.findByRole('link', { name: '새 의뢰' })
      const prefix = basename === '/' ? '' : basename
      expect(createdLink.getAttribute('href')).toBe(`${prefix}/projects/${createdProject.id}`)
      expect(screen.getByLabelText('현재 주소').textContent).toBe('/')
      expect(createProject).toHaveBeenCalledTimes(1)
    },
  )

  it.each([
    { reason: '세션 만료', error: new ApiError(401) },
    { reason: '서버 오류', error: new ApiError(500) },
    { reason: '네트워크 오류', error: new TypeError('Failed to fetch') },
  ])('검수실로 떠난 뒤 $reason가 와도 주소와 화면을 보존한다', async ({ error }) => {
    const pendingCreate = deferred<MyProject>()
    vi.mocked(createProject).mockReturnValueOnce(pendingCreate.promise)
    vi.mocked(listProjects).mockResolvedValue([projects[1]])
    renderApp()
    fireEvent.change(await screen.findByLabelText('프로젝트 이름'), { target: { value: '새 의뢰' } })
    fireEvent.click(screen.getByRole('button', { name: '만들기' }))
    expect(createProject).toHaveBeenCalledExactlyOnceWith('새 의뢰')

    fireEvent.click(screen.getByRole('link', { name: projects[1].name }))
    const room = await screen.findByRole('heading', { name: '검수실' })

    await act(async () => {
      pendingCreate.reject(error)
      await pendingCreate.promise.catch(() => undefined)
    })

    expect(screen.getByLabelText('현재 주소').textContent).toBe(`/projects/${projects[1].id}`)
    expect(screen.getByRole('heading', { name: '검수실' })).toBe(room)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('link', { name: '다시 로그인하기' })).toBeNull()
  })

  it('목록을 떠났다가 돌아온 뒤 이전 만들기 응답이 와도 새로 쓰던 이름과 목록 주소를 보존한다', async () => {
    const pendingCreate = deferred<MyProject>()
    vi.mocked(createProject).mockReturnValueOnce(pendingCreate.promise)
    vi.mocked(listProjects).mockResolvedValue([projects[1]])
    renderApp()
    fireEvent.change(await screen.findByLabelText('프로젝트 이름'), { target: { value: '첫 의뢰' } })
    fireEvent.click(screen.getByRole('button', { name: '만들기' }))
    expect(createProject).toHaveBeenCalledExactlyOnceWith('첫 의뢰')
    fireEvent.click(screen.getByRole('link', { name: projects[1].name }))
    expect(await screen.findByRole('heading', { name: '검수실' })).toBeDefined()

    fireEvent.click(screen.getByRole('link', { name: '프로젝트 목록' }))
    const input = await screen.findByLabelText<HTMLInputElement>('프로젝트 이름')
    fireEvent.change(input, { target: { value: '다음 의뢰' } })

    await act(async () => {
      pendingCreate.resolve({ ...projects[0], name: '첫 의뢰', myRole: 'DEVELOPER' })
      await pendingCreate.promise
    })

    expect(screen.getByLabelText('현재 주소').textContent).toBe('/')
    expect(screen.getByRole('heading', { name: '내 프로젝트' })).toBeDefined()
    expect(screen.getByLabelText<HTMLInputElement>('프로젝트 이름').value).toBe('다음 의뢰')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '만들기' }).disabled).toBe(false)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('StrictMode에서도 목록에 머물면 성공 응답 뒤 만든 프로젝트 설정으로 이동한다', async () => {
    const pendingCreate = deferred<MyProject>()
    const createdProject: MyProject = { ...projects[0], name: '새 의뢰', myRole: 'DEVELOPER' }
    vi.mocked(createProject).mockReturnValueOnce(pendingCreate.promise)
    vi.mocked(getProject).mockResolvedValue({ ...createdProject, currentVersion: null })
    renderApp()
    fireEvent.change(await screen.findByLabelText('프로젝트 이름'), { target: { value: '새 의뢰' } })
    fireEvent.click(screen.getByRole('button', { name: '만들기' }))
    expect(createProject).toHaveBeenCalledExactlyOnceWith('새 의뢰')
    expect(screen.getByLabelText('현재 주소').textContent).toBe('/')
    expect(screen.getByRole('heading', { name: '내 프로젝트' })).toBeDefined()

    await act(async () => {
      pendingCreate.resolve(createdProject)
      await pendingCreate.promise
    })

    expect(await screen.findByRole('heading', { name: '새 의뢰' })).toBeDefined()
    expect(screen.getByLabelText('현재 주소').textContent).toBe(`/projects/${createdProject.id}/settings`)
    expect(screen.getByLabelText<HTMLInputElement>('화면 이름').value).toBe('')
    expect(screen.queryByRole('heading', { name: '내 프로젝트' })).toBeNull()
  })
})

describe('ProjectListPage 만들기', () => {
  it('canCreateProjects가 true면 프로젝트 이름 칸과 만들기 버튼을 보여 준다', async () => {
    renderProjectList()

    const input = await screen.findByRole<HTMLInputElement>('textbox', { name: '프로젝트 이름' })
    expect(input.value).toBe('')
    expect(input.disabled).toBe(false)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '만들기' }).disabled).toBe(false)
    expect(createProject).not.toHaveBeenCalled()
  })

  it('canCreateProjects가 false면 기존 프로젝트의 개발자라도 만들기 칸과 버튼을 보여 주지 않는다', async () => {
    vi.mocked(getMe).mockResolvedValueOnce({ ...user, canCreateProjects: false })
    vi.mocked(listProjects).mockResolvedValueOnce(projects)
    renderProjectList()

    expect(await screen.findByRole('link', { name: projects[1].name })).toBeDefined()
    expect(screen.queryByRole('textbox', { name: '프로젝트 이름' })).toBeNull()
    expect(screen.queryByRole('button', { name: '만들기' })).toBeNull()
    expect(screen.getByRole('button', { name: '로그아웃' })).toBeDefined()
    expect(createProject).not.toHaveBeenCalled()
  })

  it.each(['/', '/app'])(
    'basename이 %s일 때 만드는 동안 칸과 버튼을 잠그고 성공 응답의 설정 주소로 이동한다',
    async (basename) => {
      let resolveProject!: (value: MyProject) => void
      vi.mocked(createProject).mockImplementationOnce(
        () =>
          new Promise<MyProject>((resolve) => {
            resolveProject = resolve
          }),
      )
      renderProjectList(basename)
      const input = await screen.findByLabelText<HTMLInputElement>('프로젝트 이름')
      const button = screen.getByRole<HTMLButtonElement>('button', { name: '만들기' })
      fireEvent.change(input, { target: { value: '새 의뢰' } })
      fireEvent.click(button)

      expect(createProject).toHaveBeenCalledExactlyOnceWith('새 의뢰')
      expect(input.disabled).toBe(true)
      expect(button.disabled).toBe(true)
      input.focus()
      expect(document.activeElement).not.toBe(input)
      expect(input.value).toBe('새 의뢰')
      expect(screen.getByLabelText('현재 주소').textContent).toBe('/')
      expect(screen.queryByRole('heading', { name: '프로젝트 설정' })).toBeNull()

      fireEvent.click(button)
      expect(createProject).toHaveBeenCalledTimes(1)

      resolveProject({ ...projects[0], name: '새 의뢰', myRole: 'DEVELOPER' })

      expect(await screen.findByRole('heading', { name: '프로젝트 설정' })).toBeDefined()
      expect(screen.getByLabelText('현재 주소').textContent).toBe(`/projects/${projects[0].id}/settings`)
      expect(screen.queryByRole('heading', { name: '내 프로젝트' })).toBeNull()
    },
  )

  it.each(['가', '가'.repeat(60)])('길이 경계의 이름 %s를 서버에 보내고 성공하면 이동한다', async (name) => {
    vi.mocked(createProject).mockResolvedValueOnce({ ...projects[0], name, myRole: 'DEVELOPER' })
    renderProjectList()
    const input = await screen.findByLabelText('프로젝트 이름')
    fireEvent.change(input, { target: { value: name } })
    fireEvent.click(screen.getByRole('button', { name: '만들기' }))

    expect(await screen.findByRole('heading', { name: '프로젝트 설정' })).toBeDefined()
    expect(createProject).toHaveBeenCalledExactlyOnceWith(name)
  })

  it.each([
    { reason: '빈 이름 422', name: '', error: new ApiError(422), message: '프로젝트 이름은 1~60자로 써 주세요' },
    { reason: '공백 이름 422', name: '   ', error: new ApiError(422), message: '프로젝트 이름은 1~60자로 써 주세요' },
    {
      reason: '61자 이름 422',
      name: '가'.repeat(61),
      error: new ApiError(422),
      message: '프로젝트 이름은 1~60자로 써 주세요',
    },
    {
      reason: '네트워크 오류',
      name: '새 의뢰',
      error: new TypeError('Failed to fetch'),
      message: '연결을 확인하고 다시 시도해 주세요',
    },
    { reason: '서버 오류', name: '새 의뢰', error: new ApiError(500), message: '잠시 뒤 다시 시도해 주세요' },
    { reason: '권한 거부', name: '새 의뢰', error: new ApiError(403), message: '잠시 뒤 다시 시도해 주세요' },
  ])('$reason이면 이름과 목록을 보존하고 잠금을 풀어 다시 시도할 수 있다', async ({ name, error, message }) => {
    vi.mocked(createProject).mockRejectedValueOnce(error)
    vi.mocked(listProjects).mockResolvedValueOnce(projects)
    renderProjectList()
    const input = await screen.findByLabelText<HTMLInputElement>('프로젝트 이름')
    const button = screen.getByRole<HTMLButtonElement>('button', { name: '만들기' })
    fireEvent.change(input, { target: { value: name } })
    fireEvent.click(button)

    expect((await screen.findByRole('alert')).textContent).toBe(message)
    expect(createProject).toHaveBeenCalledExactlyOnceWith(name)
    expect(input.value).toBe(name)
    expect(input.disabled).toBe(false)
    expect(button.disabled).toBe(false)
    expect(screen.getByRole('link', { name: projects[0].name })).toBeDefined()
    expect(screen.getByLabelText('현재 주소').textContent).toBe('/')
    expect(screen.queryByRole('link', { name: '다시 로그인하기' })).toBeNull()

    let resolveRetry!: (value: MyProject) => void
    vi.mocked(createProject).mockImplementationOnce(
      () =>
        new Promise<MyProject>((resolve) => {
          resolveRetry = resolve
        }),
    )
    fireEvent.change(input, { target: { value: '고친 이름' } })
    fireEvent.click(button)

    expect(screen.queryByRole('alert')).toBeNull()
    expect(createProject).toHaveBeenCalledTimes(2)
    expect(createProject).toHaveBeenLastCalledWith('고친 이름')
    expect(input.disabled).toBe(true)
    expect(button.disabled).toBe(true)

    resolveRetry({ ...projects[0], name: '고친 이름', myRole: 'DEVELOPER' })

    expect(await screen.findByRole('heading', { name: '프로젝트 설정' })).toBeDefined()
    expect(screen.getByLabelText('현재 주소').textContent).toBe(`/projects/${projects[0].id}/settings`)
  })

  it.each(['/', '/app'])(
    'basename이 %s일 때 만들기 401은 이름을 보존하고 링크를 눌러야 로그인으로 이동한다',
    async (basename) => {
      vi.mocked(createProject).mockRejectedValueOnce(new ApiError(401))
      renderProjectList(basename)
      const input = await screen.findByLabelText<HTMLInputElement>('프로젝트 이름')
      fireEvent.change(input, { target: { value: '쓰던 프로젝트' } })
      fireEvent.click(screen.getByRole('button', { name: '만들기' }))

      expect((await screen.findByRole('alert')).textContent).toContain('로그인이 끝났어요. 다시 로그인해 주세요')
      expect(createProject).toHaveBeenCalledExactlyOnceWith('쓰던 프로젝트')
      expect(input.value).toBe('쓰던 프로젝트')
      expect(input.disabled).toBe(false)
      expect(screen.getByRole<HTMLButtonElement>('button', { name: '만들기' }).disabled).toBe(false)
      expect(screen.getByRole('heading', { name: '내 프로젝트' })).toBeDefined()
      expect(screen.queryByRole('heading', { name: '로그인' })).toBeNull()
      expect(screen.getByLabelText('현재 주소').textContent).toBe('/')
      const link = screen.getByRole('link', { name: '다시 로그인하기' })
      expect(link.getAttribute('href')).toBe(basename === '/' ? '/login' : '/app/login')

      fireEvent.click(link)

      expect(await screen.findByRole('heading', { name: '로그인' })).toBeDefined()
      expect(screen.getByLabelText('현재 주소').textContent).toBe('/login')
    },
  )
})
