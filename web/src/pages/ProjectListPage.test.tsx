import { StrictMode } from 'react'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { Link, MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router'
import { type Me, getMe, logout } from '../api/auth.ts'
import {
  createProject,
  getProject,
  listProjects,
  listScreens,
  restoreProject,
  type MyProject,
} from '../api/projects.ts'
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
  return {
    ...actual,
    listProjects: vi.fn(),
    createProject: vi.fn(),
    getProject: vi.fn(),
    listScreens: vi.fn(),
    restoreProject: vi.fn(),
  }
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
    status: 'ACTIVE',
    purgeAfter: null,
  },
  {
    id: 'ebf058f0-dc9e-4a14-adcd-cb2712594e5a',
    name: '이전 프로젝트',
    myRole: 'DEVELOPER',
    createdAt: '2026-11-04T00:00:00.000Z',
    status: 'ACTIVE',
    purgeAfter: null,
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
    .mockResolvedValue({ ...projects[1], currentVersion: null, isApprover: false, approver: null })
  vi.mocked(listScreens).mockReset().mockResolvedValue([])
  vi.mocked(restoreProject).mockReset().mockResolvedValue(undefined)
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

    const group = await screen.findByRole('region', { name: '진행 중' })
    const list = within(group).getByRole('list')
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
    expect(screen.queryByRole('heading', { name: '진행 중' })).toBeNull()
    expect(screen.queryByRole('heading', { name: '보관함' })).toBeNull()
    expect(screen.queryByRole('heading', { name: '삭제 대기' })).toBeNull()
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
    vi.mocked(getProject).mockResolvedValue({
      ...createdProject,
      currentVersion: null,
      isApprover: false,
      approver: null,
    })
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

describe('ProjectListPage 보관과 삭제', () => {
  const now = Date.parse('2026-11-14T00:00:00.000Z')
  const deletedProject: MyProject = {
    ...projects[1],
    name: '지운 프로젝트',
    status: 'DELETE_PENDING',
    purgeAfter: '2026-11-21T00:00:00.000Z',
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(now)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('서버 순서가 섞여 있어도 진행 중·보관함·삭제 대기 순서로 나누고 각 묶음 안의 순서와 링크를 지킨다', async () => {
    const archivedProject: MyProject = {
      ...projects[0],
      id: 'archived-project',
      name: '보관한 프로젝트',
      status: 'ARCHIVED',
    }
    const anotherActive: MyProject = { ...projects[0], id: 'another-active', name: '다른 진행 프로젝트' }
    vi.mocked(listProjects).mockResolvedValueOnce([deletedProject, projects[0], archivedProject, anotherActive])
    renderProjectList('/app')

    await screen.findByRole('region', { name: '삭제 대기' })
    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual([
      '진행 중',
      '보관함',
      '삭제 대기',
    ])
    const active = within(screen.getByRole('region', { name: '진행 중' }))
    expect(active.getAllByRole('link').map((link) => link.textContent)).toEqual([projects[0].name, anotherActive.name])
    const archived = within(screen.getByRole('region', { name: '보관함' }))
    expect(archived.getAllByRole('link').map((link) => link.textContent)).toEqual([archivedProject.name])
    expect(archived.getByRole('link').getAttribute('href')).toBe(`/app/projects/${archivedProject.id}`)
    const deleted = within(screen.getByRole('region', { name: '삭제 대기' }))
    expect(deleted.getAllByRole('link').map((link) => link.textContent)).toEqual([deletedProject.name])
    expect(deleted.getByRole('link').getAttribute('href')).toBe(`/app/projects/${deletedProject.id}`)
    expect(active.queryByRole('button', { name: '되살리기' })).toBeNull()
    expect(archived.queryByRole('button', { name: '되살리기' })).toBeNull()
    expect(deleted.getByRole('button', { name: '되살리기' })).toBeDefined()
    expect(screen.queryByText('아직 프로젝트가 없어요.')).toBeNull()

    fireEvent.click(deleted.getByRole('link'))

    expect(await screen.findByRole('heading', { name: '검수실' })).toBeDefined()
    expect(screen.getByLabelText('현재 주소').textContent).toBe(`/projects/${deletedProject.id}`)
  })

  it.each([
    { status: 'ACTIVE', title: '진행 중' },
    { status: 'ARCHIVED', title: '보관함' },
    { status: 'DELETE_PENDING', title: '삭제 대기' },
  ] as const)('$title에만 프로젝트가 있으면 빈 묶음의 제목과 목록을 만들지 않는다', async ({ status, title }) => {
    vi.mocked(listProjects).mockResolvedValueOnce([
      { ...deletedProject, status, purgeAfter: status === 'DELETE_PENDING' ? deletedProject.purgeAfter : null },
    ])
    renderProjectList()

    expect(await screen.findByRole('region', { name: title })).toBeDefined()
    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual([title])
    expect(screen.getAllByRole('list')).toHaveLength(1)
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    expect(screen.queryByText('아직 프로젝트가 없어요.')).toBeNull()
  })

  it.each([
    { remaining: 7 * 86_400_000, message: '7일 뒤 완전히 지워져요', canRestore: true },
    { remaining: 86_400_001, message: '2일 뒤 완전히 지워져요', canRestore: true },
    { remaining: 86_400_000, message: '1일 뒤 완전히 지워져요', canRestore: true },
    { remaining: 1, message: '1일 뒤 완전히 지워져요', canRestore: true },
    { remaining: 0, message: '곧 완전히 지워져요', canRestore: false },
    { remaining: -1, message: '곧 완전히 지워져요', canRestore: false },
    { remaining: -86_400_000, message: '곧 완전히 지워져요', canRestore: false },
  ])(
    '완전히 지울 때까지 $remaining ms면 "$message"를 보이고 되살리기 가능 여부는 $canRestore다',
    async ({ remaining, message, canRestore }) => {
      vi.mocked(listProjects).mockResolvedValueOnce([
        { ...deletedProject, purgeAfter: new Date(now + remaining).toISOString() },
      ])
      renderProjectList()

      const group = within(await screen.findByRole('region', { name: '삭제 대기' }))
      expect(group.getByText(message)).toBeDefined()
      expect(group.queryByRole('button', { name: '되살리기' }) !== null).toBe(canRestore)
      expect(group.getByRole('link', { name: deletedProject.name })).toBeDefined()
      expect(restoreProject).not.toHaveBeenCalled()
    },
  )

  it.each([
    { status: 'ACTIVE', title: '진행 중' },
    { status: 'ARCHIVED', title: '보관함' },
  ] as const)(
    '되살리는 동안 중복 클릭을 막고 성공 뒤 목록을 다시 불러와 서버가 준 $title 묶음으로 옮긴다',
    async ({ status, title }) => {
      const pendingRestore = deferred<void>()
      const refreshedList = deferred<MyProject[]>()
      vi.mocked(listProjects).mockResolvedValueOnce([deletedProject]).mockReturnValueOnce(refreshedList.promise)
      vi.mocked(restoreProject).mockReturnValueOnce(pendingRestore.promise)
      renderProjectList()
      const button = await screen.findByRole<HTMLButtonElement>('button', { name: '되살리기' })

      fireEvent.click(button)
      fireEvent.click(button)

      expect(button.disabled).toBe(true)
      expect(restoreProject).toHaveBeenCalledExactlyOnceWith(deletedProject.id)
      expect(listProjects).toHaveBeenCalledTimes(1)
      await act(async () => {
        pendingRestore.resolve(undefined)
        await pendingRestore.promise
      })
      expect(listProjects).toHaveBeenCalledTimes(2)
      expect(listProjects).toHaveBeenLastCalledWith()
      expect(screen.getByRole('region', { name: '삭제 대기' })).toBeDefined()
      refreshedList.resolve([{ ...deletedProject, status, purgeAfter: null }])

      const restored = within(await screen.findByRole('region', { name: title }))
      expect(restored.getByRole('link', { name: deletedProject.name })).toBeDefined()
      expect(screen.queryByRole('heading', { name: '삭제 대기' })).toBeNull()
      expect(screen.queryByRole('button', { name: '되살리기' })).toBeNull()
      expect(screen.queryByText('7일 뒤 완전히 지워져요')).toBeNull()
      expect(screen.getByLabelText('현재 주소').textContent).toBe('/')
    },
  )

  it('되살리기를 누르면 목록을 다시 받을 때까지 되살리기 버튼이 잠겨 있다', async () => {
    const refreshedList = deferred<MyProject[]>()
    vi.mocked(listProjects).mockResolvedValueOnce([deletedProject]).mockReturnValueOnce(refreshedList.promise)
    vi.mocked(restoreProject).mockResolvedValueOnce(undefined)
    renderProjectList()
    const button = await screen.findByRole<HTMLButtonElement>('button', { name: '되살리기' })

    await act(async () => {
      fireEvent.click(button)
    })

    expect(listProjects).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('button', { name: '되살리기' })).toBe(button)
    expect(button.disabled).toBe(true)
    expect(screen.queryByRole('region', { name: '진행 중' })).toBeNull()

    fireEvent.click(button)

    expect(restoreProject).toHaveBeenCalledExactlyOnceWith(deletedProject.id)
    expect(listProjects).toHaveBeenCalledTimes(2)

    refreshedList.resolve([{ ...deletedProject, status: 'ACTIVE', purgeAfter: null }])

    const restored = within(await screen.findByRole('region', { name: '진행 중' }))
    expect(restored.getByRole('link', { name: deletedProject.name })).toBeDefined()
    expect(screen.queryByRole('region', { name: '삭제 대기' })).toBeNull()
    expect(screen.queryByRole('button', { name: '되살리기' })).toBeNull()
    expect(restoreProject).toHaveBeenCalledExactlyOnceWith(deletedProject.id)
  })

  it.each([
    {
      reason: '복구 기한 만료',
      error: new ApiError(409, 'RESTORE_PERIOD_OVER'),
      message: '되살릴 수 있는 7일이 지났어요',
    },
    { reason: '서버 오류', error: new ApiError(500), message: '잠시 뒤 다시 시도해 주세요' },
    { reason: '네트워크 오류', error: new TypeError('Failed to fetch'), message: '연결을 확인하고 다시 시도해 주세요' },
  ])('되살리기 $reason는 해당 줄에 안내하고 목록을 보존하며 재시도 때 오류를 지운다', async ({ error, message }) => {
    const retry = deferred<void>()
    vi.mocked(listProjects).mockResolvedValueOnce([projects[0], deletedProject]).mockResolvedValueOnce(projects)
    vi.mocked(restoreProject).mockRejectedValueOnce(error).mockReturnValueOnce(retry.promise)
    renderProjectList()
    const button = await screen.findByRole<HTMLButtonElement>('button', { name: '되살리기' })
    fireEvent.click(button)

    const deleted = within(screen.getByRole('region', { name: '삭제 대기' }))
    expect((await deleted.findByRole('alert')).textContent).toBe(message)
    expect(deleted.getByRole('link', { name: deletedProject.name })).toBeDefined()
    expect(screen.getByRole('link', { name: projects[0].name })).toBeDefined()
    expect(listProjects).toHaveBeenCalledTimes(1)
    expect(button.disabled).toBe(false)
    expect(screen.getByLabelText('현재 주소').textContent).toBe('/')

    fireEvent.click(button)

    expect(deleted.queryByRole('alert')).toBeNull()
    expect(button.disabled).toBe(true)
    expect(restoreProject).toHaveBeenCalledTimes(2)
    expect(restoreProject).toHaveBeenLastCalledWith(deletedProject.id)
    await act(async () => {
      retry.resolve(undefined)
      await retry.promise
    })
    expect(screen.queryByRole('heading', { name: '삭제 대기' })).toBeNull()
    expect(listProjects).toHaveBeenCalledTimes(2)
  })

  it('되살리기 401은 해당 줄에 로그인 안내를 보이고 링크를 눌러야 로그인으로 이동한다', async () => {
    vi.mocked(listProjects).mockResolvedValueOnce([deletedProject])
    vi.mocked(restoreProject).mockRejectedValueOnce(new ApiError(401))
    renderProjectList('/app')
    fireEvent.click(await screen.findByRole('button', { name: '되살리기' }))

    const deleted = within(screen.getByRole('region', { name: '삭제 대기' }))
    expect((await deleted.findByRole('alert')).textContent).toContain('로그인이 끝났어요. 다시 로그인해 주세요')
    const login = deleted.getByRole('link', { name: '다시 로그인하기' })
    expect(login.getAttribute('href')).toBe('/app/login')
    expect(listProjects).toHaveBeenCalledTimes(1)
    expect(screen.getByLabelText('현재 주소').textContent).toBe('/')

    fireEvent.click(login)

    expect(await screen.findByRole('heading', { name: '로그인' })).toBeDefined()
  })

  it.each(['성공', '실패'] as const)(
    '두 삭제 대기 줄을 잇달아 되살린 뒤 앞 목록 요청의 늦은 %s 응답은 최신 목록을 덮지 않는다',
    async (outcome) => {
      const anotherDeleted: MyProject = { ...deletedProject, id: 'another-deleted', name: '두 번째 지운 프로젝트' }
      const firstReload = deferred<MyProject[]>()
      const lastReload = deferred<MyProject[]>()
      const restored: MyProject = { ...deletedProject, status: 'ACTIVE', purgeAfter: null }
      const anotherRestored: MyProject = { ...anotherDeleted, status: 'ARCHIVED', purgeAfter: null }
      vi.mocked(listProjects)
        .mockResolvedValueOnce([deletedProject, anotherDeleted])
        .mockReturnValueOnce(firstReload.promise)
        .mockReturnValueOnce(lastReload.promise)
      renderProjectList()
      const deleted = within(await screen.findByRole('region', { name: '삭제 대기' }))
      const buttons = deleted.getAllByRole<HTMLButtonElement>('button', { name: '되살리기' })

      await act(async () => fireEvent.click(buttons[0]))
      expect(listProjects).toHaveBeenCalledTimes(2)
      expect(buttons[0].disabled).toBe(true)
      expect(buttons[1].disabled).toBe(false)
      await act(async () => fireEvent.click(buttons[1]))
      expect(listProjects).toHaveBeenCalledTimes(3)
      expect(restoreProject).toHaveBeenNthCalledWith(1, deletedProject.id)
      expect(restoreProject).toHaveBeenNthCalledWith(2, anotherDeleted.id)

      await act(async () => lastReload.resolve([restored, anotherRestored]))
      expect(screen.queryByRole('region', { name: '삭제 대기' })).toBeNull()
      await act(async () => {
        if (outcome === '성공') firstReload.resolve([restored, anotherDeleted])
        if (outcome === '실패') firstReload.reject(new ApiError(500))
      })

      expect(
        within(screen.getByRole('region', { name: '진행 중' })).getByRole('link', { name: restored.name }),
      ).toBeDefined()
      expect(
        within(screen.getByRole('region', { name: '보관함' })).getByRole('link', { name: anotherRestored.name }),
      ).toBeDefined()
      expect(screen.queryByRole('region', { name: '삭제 대기' })).toBeNull()
      expect(screen.queryByRole('button', { name: '되살리기' })).toBeNull()
      expect(screen.queryByRole('alert')).toBeNull()
      expect(listProjects).toHaveBeenCalledTimes(3)
    },
  )

  it('되살린 뒤 목록 다시 받기가 한 번 실패해도 다음 요청이 성공하면 오류가 걷힌다', async () => {
    const anotherDeleted: MyProject = { ...deletedProject, id: 'another-deleted', name: '두 번째 지운 프로젝트' }
    const firstReload = deferred<MyProject[]>()
    const secondRestore = deferred<void>()
    const lastReload = deferred<MyProject[]>()
    vi.mocked(listProjects)
      .mockResolvedValueOnce([deletedProject, anotherDeleted])
      .mockReturnValueOnce(firstReload.promise)
      .mockReturnValueOnce(lastReload.promise)
    vi.mocked(restoreProject).mockResolvedValueOnce(undefined).mockReturnValueOnce(secondRestore.promise)
    renderProjectList()
    const deleted = within(await screen.findByRole('region', { name: '삭제 대기' }))
    const buttons = deleted.getAllByRole('button', { name: '되살리기' })
    await act(async () => fireEvent.click(buttons[0]))
    // 오류가 뜨기 전에 다른 줄의 되살리기도 시작해 둔다.
    fireEvent.click(buttons[1])
    expect(restoreProject).toHaveBeenNthCalledWith(2, anotherDeleted.id)
    expect(listProjects).toHaveBeenCalledTimes(2)

    await act(async () => firstReload.reject(new ApiError(500)))
    expect(screen.getByRole('alert').textContent).toBe('잠시 뒤 다시 시도해 주세요')
    expect(screen.queryByText('아직 프로젝트가 없어요.')).toBeNull()
    await act(async () => secondRestore.resolve(undefined))
    expect(listProjects).toHaveBeenCalledTimes(3)
    await act(async () =>
      lastReload.resolve([
        { ...deletedProject, status: 'ACTIVE', purgeAfter: null },
        { ...anotherDeleted, status: 'ARCHIVED', purgeAfter: null },
      ]),
    )

    expect(screen.queryByRole('alert')).toBeNull()
    expect(
      within(screen.getByRole('region', { name: '진행 중' })).getByRole('link', { name: deletedProject.name }),
    ).toBeDefined()
    expect(
      within(screen.getByRole('region', { name: '보관함' })).getByRole('link', { name: anotherDeleted.name }),
    ).toBeDefined()
    expect(screen.queryByRole('region', { name: '삭제 대기' })).toBeNull()
    expect(screen.getByLabelText('현재 주소').textContent).toBe('/')
  })

  it('되살린 뒤 목록 재조회가 실패하면 빈 목록으로 처리하지 않고 목록 오류를 보여 준다', async () => {
    vi.mocked(listProjects).mockResolvedValueOnce([deletedProject]).mockRejectedValueOnce(new ApiError(500))
    renderProjectList()
    fireEvent.click(await screen.findByRole('button', { name: '되살리기' }))

    expect((await screen.findByRole('alert')).textContent).toBe('잠시 뒤 다시 시도해 주세요')
    expect(restoreProject).toHaveBeenCalledExactlyOnceWith(deletedProject.id)
    expect(listProjects).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('아직 프로젝트가 없어요.')).toBeNull()
    expect(screen.getByRole('heading', { name: '내 프로젝트' })).toBeDefined()
  })
})
