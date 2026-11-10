import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router'
import { getMe, type Me } from '../api/auth.ts'
import { ApiError } from '../api/client.ts'
import { createInvitation } from '../api/invitations.ts'
import { listMembers, revokeMember, setApprover } from '../api/members.ts'
import {
  createScreen,
  getProject,
  hideScreen,
  listScreens,
  type ProjectDetail,
  type Screen,
  showScreen,
} from '../api/projects.ts'
import { ProjectSettingsPage } from './ProjectSettingsPage.tsx'

vi.mock('../api/auth.ts', async () => {
  const actual = await vi.importActual<typeof import('../api/auth.ts')>('../api/auth.ts')
  return { ...actual, getMe: vi.fn() }
})

vi.mock('../api/projects.ts', async () => {
  const actual = await vi.importActual<typeof import('../api/projects.ts')>('../api/projects.ts')
  return {
    ...actual,
    getProject: vi.fn(),
    listScreens: vi.fn(),
    createScreen: vi.fn(),
    hideScreen: vi.fn(),
    showScreen: vi.fn(),
  }
})

vi.mock('../api/members.ts', () => ({
  listMembers: vi.fn(),
  revokeMember: vi.fn(),
  setApprover: vi.fn(),
}))

vi.mock('../api/invitations.ts', () => ({ createInvitation: vi.fn() }))

const user: Me = {
  id: '5b3a934d-ef8e-4ce8-b26a-a9d1cdd4983f',
  email: 'reader@example.com',
  name: '김수정',
  canCreateProjects: false,
}

const project: ProjectDetail = {
  id: 'ebf058f0-dc9e-4a14-adcd-cb2712594e5a',
  name: '오브젝트 스토어',
  myRole: 'DEVELOPER',
  currentVersion: null,
  approver: null,
}

// 만든 순서 가운데 숨긴 화면을 넣어, 보이는 번호와 복원할 위치를 확인한다.
const screens: Screen[] = [
  { id: 'fdba89f1-38f6-4910-a5c7-6774a8e2f9ef', name: '메인', viewport: 'PC', hiddenAt: null },
  { id: 'd9e18ba9-4b1a-4b36-9bc4-609826ec1fa0', name: '소개', viewport: 'PC', hiddenAt: '2026-11-05T00:00:00.000Z' },
  { id: 'afb028f9-4966-4d5b-b13b-94e5636b5e75', name: '메인', viewport: 'MOBILE', hiddenAt: null },
]

const createdScreen: Screen = {
  id: '88a36f2d-1455-43ba-a3dc-d859646d763a',
  name: '상품 상세',
  viewport: 'MOBILE',
  hiddenAt: null,
}

const nextProject: ProjectDetail = {
  id: '6b62c564-585a-4f05-ae57-8d6b3bc5a47f',
  name: '다음 프로젝트',
  myRole: 'DEVELOPER',
  currentVersion: null,
  approver: null,
}

const nextScreens: Screen[] = [
  { id: 'c52b65fc-59fb-4b3a-8543-24be0f3b64ed', name: '문의', viewport: 'PC', hiddenAt: null },
]

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const CurrentPath = () => {
  const location = useLocation()
  return <output aria-label="현재 주소">{location.pathname}</output>
}

const BackButton = () => {
  const navigate = useNavigate()
  return <button onClick={() => navigate(-1)}>뒤로 가기</button>
}

const renderSettings = (basename = '/', id = project.id) => {
  const prefix = basename === '/' ? '' : basename
  return render(
    <MemoryRouter
      basename={basename}
      initialEntries={[`${prefix}/previous`, `${prefix}/projects/${id}/settings`]}
      initialIndex={1}
    >
      <CurrentPath />
      <BackButton />
      <Routes>
        <Route path="/previous" element={<p>이전 화면</p>} />
        <Route path="/" element={<h1>내 프로젝트</h1>} />
        <Route path="/projects/:id/settings" element={<ProjectSettingsPage />} />
        <Route path="/login" element={<h1>로그인</h1>} />
      </Routes>
    </MemoryRouter>,
  )
}

// 목록 화면을 거치지 않고 같은 Route에서 A → B로 방문 기록을 이동한다.
const renderSettingsHistory = (basename = '/', id = project.id) => {
  const prefix = basename === '/' ? '' : basename
  return render(
    <MemoryRouter
      basename={basename}
      initialEntries={[
        `${prefix}/projects/${nextProject.id}/settings`,
        `${prefix}/projects/${id}/settings`,
      ]}
      initialIndex={1}
    >
      <CurrentPath />
      <BackButton />
      <Routes>
        <Route path="/projects/:id/settings" element={<ProjectSettingsPage />} />
        <Route path="/login" element={<h1>로그인</h1>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.mocked(listMembers).mockReset().mockResolvedValue({ members: [], invitations: [] })
  vi.mocked(revokeMember).mockReset()
  vi.mocked(setApprover).mockReset()
  vi.mocked(createInvitation).mockReset()
  vi.mocked(getMe).mockReset().mockResolvedValue(user)
  vi.mocked(getProject).mockReset().mockResolvedValue(project)
  vi.mocked(listScreens).mockReset().mockResolvedValue(screens)
  vi.mocked(createScreen).mockReset().mockResolvedValue(createdScreen)
  vi.mocked(hideScreen)
    .mockReset()
    .mockResolvedValue({ ...screens[0], hiddenAt: '2026-11-05T01:00:00.000Z' })
  vi.mocked(showScreen)
    .mockReset()
    .mockResolvedValue({ ...screens[1], hiddenAt: null })
})

describe('ProjectSettingsPage 로그인과 조회', () => {
  it('로그인 확인을 한 번 요청하고 응답 전에는 확인 중 문단만 보여 준다', async () => {
    const pending = deferred<Me>()
    vi.mocked(getMe).mockReturnValueOnce(pending.promise)
    renderSettings()

    await act(async () => {})
    expect(getMe).toHaveBeenCalledExactlyOnceWith()
    expect(screen.getByText('확인하는 중이에요.').tagName).toBe('P')
    expect(screen.queryByRole('heading')).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('list')).toBeNull()

    pending.resolve(user)

    expect(await screen.findByRole('heading', { level: 1, name: project.name })).toBeDefined()
    expect(screen.queryByText('확인하는 중이에요.')).toBeNull()
    expect(getMe).toHaveBeenCalledExactlyOnceWith()
  })

  it.each(['/', '/app'])(
    'basename이 %s일 때 비로그인은 로그인으로 교체하고 뒤로 가면 이전 화면으로 간다',
    async (basename) => {
      vi.mocked(getMe).mockResolvedValueOnce(null)
      renderSettings(basename)

      expect(await screen.findByRole('heading', { name: '로그인' })).toBeDefined()
      expect(screen.queryByRole('textbox')).toBeNull()
      expect(screen.getByLabelText('현재 주소').textContent).toBe('/login')

      fireEvent.click(screen.getByRole('button', { name: '뒤로 가기' }))

      expect(await screen.findByText('이전 화면')).toBeDefined()
      expect(screen.queryByRole('heading', { name: '로그인' })).toBeNull()
      expect(getMe).toHaveBeenCalledExactlyOnceWith()
    },
  )

  it.each([new TypeError('Failed to fetch'), new ApiError(500)])(
    '로그인 확인 오류 %s는 로그인으로 보내지 않는다',
    async (error) => {
      vi.mocked(getMe).mockRejectedValueOnce(error)
      renderSettings()

      expect(await screen.findByText('불러오지 못했어요. 잠시 뒤 새로고침해 주세요')).toBeDefined()
      expect(screen.queryByText('확인하는 중이에요.')).toBeNull()
      expect(screen.queryByRole('heading')).toBeNull()
      expect(screen.queryByRole('textbox')).toBeNull()
      expect(screen.getByLabelText('현재 주소').textContent).toBe(`/projects/${project.id}/settings`)
    },
  )

  it.each(['프로젝트', '화면 목록'])(
    '%s 응답이 늦으면 두 조회를 모두 시작하고 둘 다 올 때까지 불러오는 중이다',
    async (source) => {
      const pendingProject = deferred<ProjectDetail>()
      const pendingScreens = deferred<Screen[]>()
      vi.mocked(getProject).mockReturnValueOnce(pendingProject.promise)
      vi.mocked(listScreens).mockReturnValueOnce(pendingScreens.promise)
      renderSettings()

      expect(await screen.findByText('불러오는 중이에요.')).toBeDefined()
      expect(getProject).toHaveBeenCalledExactlyOnceWith(project.id)
      expect(listScreens).toHaveBeenCalledExactlyOnceWith(project.id)
      await act(async () => {
        if (source === '프로젝트') pendingScreens.resolve(screens)
        if (source === '화면 목록') pendingProject.resolve(project)
      })
      expect(screen.getByText('불러오는 중이에요.')).toBeDefined()
      expect(screen.queryByRole('heading')).toBeNull()
      expect(screen.queryByText('아직 화면이 없어요.')).toBeNull()

      pendingProject.resolve(project)
      pendingScreens.resolve(screens)

      expect(await screen.findByRole('heading', { name: project.name })).toBeDefined()
      expect(screen.queryByText('불러오는 중이에요.')).toBeNull()
    },
  )

  it.each([
    'abc',
    '.',
    '..',
    `${project.id}x`,
    `x${project.id}`,
    project.id.slice(0, -1),
    project.id.replaceAll('-', ''),
    project.id.replace('e', 'g'),
    '%2e%2e',
    'x%2F..%2Fauth%2Fme',
  ])('잘못된 id %s는 프로젝트 API를 호출하지 않고 없는 프로젝트로 보여 준다', async (id) => {
    renderSettings('/', id)

    expect(await screen.findByRole('heading', { name: '없는 프로젝트예요' })).toBeDefined()
    expect(screen.getByRole('link', { name: '프로젝트 목록' }).getAttribute('href')).toBe('/')
    expect(getProject).not.toHaveBeenCalled()
    expect(listScreens).not.toHaveBeenCalled()
    expect(createScreen).not.toHaveBeenCalled()
    expect(hideScreen).not.toHaveBeenCalled()
    expect(showScreen).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('대문자가 섞인 올바른 UUID는 서버에 조회한다', async () => {
    const id = project.id.toUpperCase()
    renderSettings('/', id)

    expect(await screen.findByRole('heading', { name: project.name })).toBeDefined()
    expect(getProject).toHaveBeenCalledExactlyOnceWith(id)
    expect(listScreens).toHaveBeenCalledExactlyOnceWith(id)
  })

  it.each([
    { source: '없는 프로젝트', fail: getProject },
    { source: '남의 프로젝트 화면 목록', fail: listScreens },
  ])('$source 조회의 404는 같은 안내와 목록 링크만 보여 준다', async ({ fail }) => {
    vi.mocked(fail).mockRejectedValueOnce(new ApiError(404))
    renderSettings()

    expect(await screen.findByRole('heading', { name: '없는 프로젝트예요' })).toBeDefined()
    expect(screen.getByRole('link', { name: '프로젝트 목록' }).getAttribute('href')).toBe('/')
    expect(screen.queryByRole('heading', { name: project.name })).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each([
    {
      source: '프로젝트 네트워크',
      fail: getProject,
      error: new TypeError('Failed to fetch'),
      message: '연결을 확인하고 다시 시도해 주세요',
    },
    { source: '프로젝트 서버', fail: getProject, error: new ApiError(500), message: '잠시 뒤 다시 시도해 주세요' },
    {
      source: '목록 네트워크',
      fail: listScreens,
      error: new TypeError('Failed to fetch'),
      message: '연결을 확인하고 다시 시도해 주세요',
    },
    { source: '목록 서버', fail: listScreens, error: new ApiError(500), message: '잠시 뒤 다시 시도해 주세요' },
  ])('$source 오류는 부분 목록 대신 오류 하나로 보여 준다', async ({ fail, error, message }) => {
    vi.mocked(fail).mockRejectedValueOnce(error)
    renderSettings()

    expect((await screen.findByRole('alert')).textContent).toBe(message)
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.queryByRole('heading')).toBeNull()
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByText('불러오는 중이에요.')).toBeNull()
    expect(screen.queryByText('아직 화면이 없어요.')).toBeNull()
    expect(screen.getByLabelText('현재 주소').textContent).toBe(`/projects/${project.id}/settings`)
  })

  it('두 조회가 모두 실패해도 오류 하나만 보여 준다', async () => {
    vi.mocked(getProject).mockRejectedValueOnce(new ApiError(500))
    vi.mocked(listScreens).mockRejectedValueOnce(new ApiError(500))
    renderSettings()

    expect((await screen.findByRole('alert')).textContent).toBe('잠시 뒤 다시 시도해 주세요')
    expect(screen.getAllByRole('alert')).toHaveLength(1)
  })

  it.each([
    { basename: '/', fail: getProject },
    { basename: '/app', fail: getProject },
    { basename: '/', fail: listScreens },
    { basename: '/app', fail: listScreens },
  ])('basename $basename의 조회 401은 자동 이동 없이 로그인 링크를 보여 준다', async ({ basename, fail }) => {
    vi.mocked(fail).mockRejectedValueOnce(new ApiError(401))
    renderSettings(basename)

    expect((await screen.findByRole('alert')).textContent).toContain('로그인이 끝났어요. 다시 로그인해 주세요')
    expect(screen.getByLabelText('현재 주소').textContent).toBe(`/projects/${project.id}/settings`)
    expect(screen.queryByRole('heading', { name: '로그인' })).toBeNull()
    const link = screen.getByRole('link', { name: '다시 로그인하기' })
    expect(link.getAttribute('href')).toBe(basename === '/' ? '/login' : '/app/login')

    fireEvent.click(link)

    expect(await screen.findByRole('heading', { name: '로그인' })).toBeDefined()
  })

  it.each([
    { basename: '/', id: project.id },
    { basename: '/app', id: project.id },
    { basename: '/', id: '..' },
    { basename: '/app', id: '..' },
  ])('basename $basename, id $id에서도 프로젝트 목록 링크로 돌아간다', async ({ basename, id }) => {
    renderSettings(basename, id)

    const link = await screen.findByRole('link', { name: '프로젝트 목록' })
    expect(link.getAttribute('href')).toMatch(basename === '/' ? /^\/$/ : /^\/app\/?$/)
    expect(screen.queryByRole('button', { name: '로그아웃' })).toBeNull()
    fireEvent.click(link)

    expect(await screen.findByRole('heading', { name: '내 프로젝트' })).toBeDefined()
  })
})

describe('ProjectSettingsPage 프로젝트 사이 이동', () => {
  it.each(['/', '/app'])(
    'basename %s에서 B로 이동하면 A의 제목·목록·오류·입력을 지우고 B에 화면을 만든다',
    async (basename) => {
      const pendingMe = deferred<Me>()
      const pendingProject = deferred<ProjectDetail>()
      const pendingScreens = deferred<Screen[]>()
      vi.mocked(getMe).mockResolvedValueOnce(user).mockReturnValueOnce(pendingMe.promise)
      vi.mocked(getProject).mockResolvedValueOnce(project).mockReturnValueOnce(pendingProject.promise)
      vi.mocked(listScreens).mockResolvedValueOnce(screens).mockReturnValueOnce(pendingScreens.promise)
      vi.mocked(createScreen).mockRejectedValueOnce(new ApiError(409, 'SCREEN_EXISTS'))
      renderSettingsHistory(basename)
      const input = await screen.findByRole<HTMLInputElement>('textbox', { name: '화면 이름' })
      fireEvent.change(input, { target: { value: '메인' } })
      fireEvent.change(screen.getByRole('combobox', { name: '기기' }), { target: { value: 'MOBILE' } })
      fireEvent.click(screen.getByRole('button', { name: '만들기' }))
      expect((await screen.findByRole('alert')).textContent).toBe('이미 있는 화면이에요')
      expect(input.value).toBe('메인')

      fireEvent.click(screen.getByRole('button', { name: '뒤로 가기' }))

      expect(screen.getByLabelText('현재 주소').textContent).toBe(`/projects/${nextProject.id}/settings`)
      expect(screen.getByText('확인하는 중이에요.')).toBeDefined()
      expect(screen.queryByRole('heading')).toBeNull()
      expect(screen.queryByRole('list')).toBeNull()
      expect(screen.queryByRole('alert')).toBeNull()
      expect(screen.queryByRole('textbox')).toBeNull()
      expect(getMe).toHaveBeenCalledTimes(2)
      expect(getProject).toHaveBeenNthCalledWith(2, nextProject.id)
      expect(listScreens).toHaveBeenNthCalledWith(2, nextProject.id)

      await act(async () => pendingMe.resolve(user))
      expect(screen.getByText('불러오는 중이에요.')).toBeDefined()
      expect(screen.queryByRole('heading')).toBeNull()
      expect(screen.queryByRole('list')).toBeNull()
      expect(screen.queryByRole('alert')).toBeNull()
      await act(async () => {
        pendingProject.resolve(nextProject)
        pendingScreens.resolve(nextScreens)
      })

      expect(screen.getByRole('heading', { name: nextProject.name })).toBeDefined()
      expect(screen.queryByRole('heading', { name: project.name })).toBeNull()
      expect(screen.getByRole('listitem').textContent).toBe('01문의 · PC숨기기')
      expect(screen.queryByRole('heading', { name: '숨긴 화면' })).toBeNull()
      expect(screen.queryByRole('alert')).toBeNull()
      const nextInput = screen.getByRole<HTMLInputElement>('textbox', { name: '화면 이름' })
      expect(nextInput.value).toBe('')
      expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '기기' }).value).toBe('PC')

      fireEvent.change(nextInput, { target: { value: '상품 상세' } })
      fireEvent.change(screen.getByRole('combobox', { name: '기기' }), { target: { value: 'MOBILE' } })
      fireEvent.click(screen.getByRole('button', { name: '만들기' }))

      expect(await screen.findByText('상품 상세 · 모바일')).toBeDefined()
      expect(createScreen).toHaveBeenCalledTimes(2)
      expect(createScreen).toHaveBeenLastCalledWith(nextProject.id, '상품 상세', 'MOBILE')
      expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
        '01문의 · PC숨기기',
        '02상품 상세 · 모바일숨기기',
      ])
    },
  )

  it.each(['프로젝트', '화면 목록', '둘 다'])(
    'A의 %s 응답이 B보다 늦게 와도 B의 제목·목록·역할을 덮지 않는다',
    async (source) => {
      const pendingProject = deferred<ProjectDetail>()
      const pendingScreens = deferred<Screen[]>()
      vi.mocked(getProject)
        .mockReturnValueOnce(pendingProject.promise)
        .mockResolvedValueOnce({ ...nextProject, myRole: 'CLIENT' })
      vi.mocked(listScreens).mockReturnValueOnce(pendingScreens.promise).mockResolvedValueOnce(nextScreens)
      renderSettingsHistory()
      await screen.findByText('불러오는 중이에요.')
      await act(async () => {
        if (source === '프로젝트') pendingScreens.resolve(screens)
        if (source === '화면 목록') pendingProject.resolve(project)
      })
      expect(getProject).toHaveBeenCalledExactlyOnceWith(project.id)
      expect(listScreens).toHaveBeenCalledExactlyOnceWith(project.id)

      fireEvent.click(screen.getByRole('button', { name: '뒤로 가기' }))
      await screen.findByRole('heading', { name: nextProject.name })
      expect(getProject).toHaveBeenNthCalledWith(2, nextProject.id)
      expect(listScreens).toHaveBeenNthCalledWith(2, nextProject.id)
      await act(async () => {
        pendingProject.resolve(project)
        pendingScreens.resolve(screens)
      })

      expect(screen.getByRole('heading', { name: nextProject.name })).toBeDefined()
      expect(screen.queryByRole('heading', { name: project.name })).toBeNull()
      expect(screen.getByRole('listitem').textContent).toBe('01문의 · PC')
      expect(screen.queryByRole('heading', { name: '숨긴 화면' })).toBeNull()
      expect(screen.queryByRole('textbox')).toBeNull()
      expect(screen.queryByRole('button', { name: /^(만들기|숨기기|다시 보이기)$/ })).toBeNull()
      expect(screen.queryByRole('alert')).toBeNull()
    },
  )

  it.each([
    { source: '프로젝트 404', fail: getProject, status: 404 },
    { source: '화면 목록 404', fail: listScreens, status: 404 },
    { source: '프로젝트 500', fail: getProject, status: 500 },
    { source: '화면 목록 401', fail: listScreens, status: 401 },
  ])('A의 $source 뒤 정상 B로 이동하면 오류 대신 정상 화면을 보여 준다', async ({ fail, status }) => {
    vi.mocked(getProject).mockResolvedValueOnce(project).mockResolvedValueOnce(nextProject)
    vi.mocked(listScreens).mockResolvedValueOnce(screens).mockResolvedValueOnce(nextScreens)
    // 첫 조회만 실패시키고 B의 응답은 그대로 둔다.
    vi.mocked(fail).mockReset().mockRejectedValueOnce(new ApiError(status))
    if (fail === getProject) vi.mocked(getProject).mockResolvedValueOnce(nextProject)
    if (fail === listScreens) vi.mocked(listScreens).mockResolvedValueOnce(nextScreens)
    renderSettingsHistory()
    if (status === 404) await screen.findByRole('heading', { name: '없는 프로젝트예요' })
    if (status !== 404) await screen.findByRole('alert')

    fireEvent.click(screen.getByRole('button', { name: '뒤로 가기' }))

    expect(await screen.findByRole('heading', { name: nextProject.name })).toBeDefined()
    expect(screen.getByRole('listitem').textContent).toBe('01문의 · PC숨기기')
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: '화면 이름' }).value).toBe('')
    expect(screen.queryByRole('heading', { name: '없는 프로젝트예요' })).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('link', { name: '다시 로그인하기' })).toBeNull()
  })

  it.each([
    { source: '프로젝트 404', fail: getProject, status: 404 },
    { source: '화면 목록 404', fail: listScreens, status: 404 },
    { source: '프로젝트 500', fail: getProject, status: 500 },
    { source: '화면 목록 401', fail: listScreens, status: 401 },
  ])('B를 연 뒤 늦게 온 A의 $source 오류는 B를 가리지 않는다', async ({ fail, status }) => {
    const pendingProject = deferred<ProjectDetail>()
    const pendingScreens = deferred<Screen[]>()
    vi.mocked(getProject).mockReturnValueOnce(pendingProject.promise).mockResolvedValueOnce(nextProject)
    vi.mocked(listScreens).mockReturnValueOnce(pendingScreens.promise).mockResolvedValueOnce(nextScreens)
    renderSettingsHistory()
    await screen.findByText('불러오는 중이에요.')
    fireEvent.click(screen.getByRole('button', { name: '뒤로 가기' }))
    await screen.findByRole('heading', { name: nextProject.name })

    await act(async () => {
      if (fail === getProject) pendingProject.reject(new ApiError(status))
      if (fail === listScreens) pendingScreens.reject(new ApiError(status))
      pendingProject.resolve(project)
      pendingScreens.resolve(screens)
    })

    expect(screen.getByRole('heading', { name: nextProject.name })).toBeDefined()
    expect(screen.getByRole('listitem').textContent).toBe('01문의 · PC숨기기')
    expect(screen.queryByRole('heading', { name: '없는 프로젝트예요' })).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('link', { name: '다시 로그인하기' })).toBeNull()
  })

  it('잘못된 id에서 정상 B로 이동하면 B만 조회하고 정상 화면을 보여 준다', async () => {
    vi.mocked(getProject).mockResolvedValueOnce(nextProject)
    vi.mocked(listScreens).mockResolvedValueOnce(nextScreens)
    renderSettingsHistory('/', 'abc')
    await screen.findByRole('heading', { name: '없는 프로젝트예요' })
    expect(getProject).not.toHaveBeenCalled()
    expect(listScreens).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '뒤로 가기' }))

    expect(await screen.findByRole('heading', { name: nextProject.name })).toBeDefined()
    expect(getProject).toHaveBeenCalledExactlyOnceWith(nextProject.id)
    expect(listScreens).toHaveBeenCalledExactlyOnceWith(nextProject.id)
    expect(screen.getByRole('listitem').textContent).toBe('01문의 · PC숨기기')
  })

  it.each([
    { action: '만들기', request: createScreen, outcome: '성공', updated: createdScreen },
    { action: '만들기', request: createScreen, outcome: '실패', updated: createdScreen },
    { action: '숨기기', request: hideScreen, outcome: '성공', updated: { ...screens[0], hiddenAt: '2026-11-06T00:00:00.000Z' } },
    { action: '숨기기', request: hideScreen, outcome: '실패', updated: screens[0] },
    { action: '다시 보이기', request: showScreen, outcome: '성공', updated: { ...screens[1], hiddenAt: null } },
    { action: '다시 보이기', request: showScreen, outcome: '실패', updated: screens[1] },
  ])('A의 $action 요청 중 B로 이동하면 잠금이 풀리고 늦은 $outcome 응답은 버린다', async ({ action, request, outcome, updated }) => {
    const pending = deferred<Screen>()
    vi.mocked(request).mockReturnValueOnce(pending.promise)
    vi.mocked(getProject).mockResolvedValueOnce(project).mockResolvedValueOnce(nextProject)
    vi.mocked(listScreens).mockResolvedValueOnce(screens).mockResolvedValueOnce(nextScreens)
    renderSettingsHistory()
    fireEvent.change(await screen.findByRole('textbox', { name: '화면 이름' }), { target: { value: '상품 상세' } })
    fireEvent.click(screen.getAllByRole('button', { name: action })[0])
    expect(request).toHaveBeenCalledTimes(1)
    expect(screen.getAllByRole<HTMLButtonElement>('button', { name: action })[0].disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: '뒤로 가기' }))
    await screen.findByRole('heading', { name: nextProject.name })
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: '화면 이름' })
    expect(input.value).toBe('')
    expect(input.disabled).toBe(false)
    expect(screen.getAllByRole<HTMLButtonElement>('button').every((button) => !button.disabled)).toBe(true)
    fireEvent.change(input, { target: { value: 'B에서 쓰던 이름' } })

    await act(async () => {
      if (outcome === '성공') pending.resolve(updated)
      if (outcome === '실패') pending.reject(new ApiError(401))
    })

    expect(screen.getByRole('heading', { name: nextProject.name })).toBeDefined()
    expect(screen.getByRole('listitem').textContent).toBe('01문의 · PC숨기기')
    expect(input.value).toBe('B에서 쓰던 이름')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('link', { name: '다시 로그인하기' })).toBeNull()
    expect(screen.getAllByRole<HTMLButtonElement>('button').every((button) => !button.disabled)).toBe(true)
  })
})

describe('ProjectSettingsPage 목록과 역할', () => {
  it('보이는 화면만 만든 순서대로 01·02를 붙이고 PC·모바일과 숨긴 목록을 구분한다', async () => {
    renderSettings()
    await screen.findByRole('heading', { name: project.name })

    const [visible, hidden] = screen.getAllByRole('list')
    expect(
      within(visible)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['01메인 · PC숨기기', '02메인 · 모바일숨기기'])
    expect(
      within(hidden)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['소개 · PC다시 보이기'])
    expect(screen.getByRole('heading', { level: 2, name: '숨긴 화면' })).toBeDefined()
    expect(screen.queryByText('아직 화면이 없어요.')).toBeNull()
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '기기' }).value).toBe('PC')
    expect(
      within(screen.getByRole('combobox', { name: '기기' }))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['PC', '모바일'])
    // 프로젝트 생성 가능 여부가 아니라 이 프로젝트의 역할로 화면 관리 권한을 판단한다.
    expect(screen.getByRole('textbox', { name: '화면 이름' })).toBeDefined()
    expect(screen.getByRole('button', { name: '만들기' })).toBeDefined()
  })

  it.each([true, false])(
    'CLIENT는 canCreateProjects=%s여도 목록만 보고 관리 칸과 버튼은 볼 수 없다',
    async (canCreateProjects) => {
      vi.mocked(getMe).mockResolvedValueOnce({ ...user, canCreateProjects })
      vi.mocked(getProject).mockResolvedValueOnce({ ...project, myRole: 'CLIENT' })
      renderSettings()
      await screen.findByRole('heading', { name: project.name })

      expect(screen.getByText('메인 · PC')).toBeDefined()
      expect(screen.getByText('메인 · 모바일')).toBeDefined()
      expect(screen.getByText('소개 · PC')).toBeDefined()
      expect(screen.queryByRole('textbox')).toBeNull()
      expect(screen.queryByRole('combobox')).toBeNull()
      expect(screen.queryByRole('button', { name: '만들기' })).toBeNull()
      expect(screen.queryByRole('button', { name: '숨기기' })).toBeNull()
      expect(screen.queryByRole('button', { name: '다시 보이기' })).toBeNull()
      expect(createScreen).not.toHaveBeenCalled()
      expect(hideScreen).not.toHaveBeenCalled()
      expect(showScreen).not.toHaveBeenCalled()
    },
  )

  it.each(['DEVELOPER', 'CLIENT'] as const)('%s의 목록이 비면 안내만 보이고 숨긴 화면 칸은 없다', async (myRole) => {
    vi.mocked(getProject).mockResolvedValueOnce({ ...project, myRole })
    vi.mocked(listScreens).mockResolvedValueOnce([])
    renderSettings()

    expect(await screen.findByText('아직 화면이 없어요.')).toBeDefined()
    const membersHeading = screen.queryByRole('heading', { name: '참여자와 승인자' })
    // 참여자 칸보다 앞에 있는 화면 이름표 목록만 확인한다.
    const screenLists = screen
      .queryAllByRole('list')
      .filter(
        (list) =>
          !membersHeading || Boolean(list.compareDocumentPosition(membersHeading) & Node.DOCUMENT_POSITION_FOLLOWING),
      )
    expect(screenLists).toHaveLength(0)
    expect(screen.queryByRole('heading', { name: '숨긴 화면' })).toBeNull()
  })

  it('숨긴 화면만 있으면 빈 화면 안내와 숨긴 목록을 함께 보여 준다', async () => {
    vi.mocked(listScreens).mockResolvedValueOnce([screens[1]])
    renderSettings()

    expect(await screen.findByText('아직 화면이 없어요.')).toBeDefined()
    expect(screen.getByRole('heading', { name: '숨긴 화면' })).toBeDefined()
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    expect(screen.getByRole('button', { name: '다시 보이기' })).toBeDefined()
  })
})

describe('ProjectSettingsPage 만들기', () => {
  it('요청 동안 입력과 버튼을 잠그고 성공 응답을 끝에 붙인 뒤 이름만 비운다', async () => {
    const pending = deferred<Screen>()
    vi.mocked(createScreen).mockReturnValueOnce(pending.promise)
    renderSettings()
    const input = await screen.findByRole<HTMLInputElement>('textbox', { name: '화면 이름' })
    const viewport = screen.getByRole<HTMLSelectElement>('combobox', { name: '기기' })
    const button = screen.getByRole<HTMLButtonElement>('button', { name: '만들기' })
    fireEvent.change(input, { target: { value: '  상품 상세  ' } })
    fireEvent.change(viewport, { target: { value: 'MOBILE' } })
    fireEvent.click(button)

    expect(createScreen).toHaveBeenCalledExactlyOnceWith(project.id, '  상품 상세  ', 'MOBILE')
    expect(input.disabled).toBe(true)
    expect(viewport.disabled).toBe(true)
    expect(button.disabled).toBe(true)
    expect(screen.queryByText('상품 상세 · 모바일')).toBeNull()
    fireEvent.click(button)
    expect(createScreen).toHaveBeenCalledTimes(1)

    pending.resolve(createdScreen)

    expect(await screen.findByText('상품 상세 · 모바일')).toBeDefined()
    const [visible, hidden] = screen.getAllByRole('list')
    expect(
      within(visible)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['01메인 · PC숨기기', '02메인 · 모바일숨기기', '03상품 상세 · 모바일숨기기'])
    expect(within(hidden).getByText('소개 · PC')).toBeDefined()
    expect(input.value).toBe('')
    expect(viewport.value).toBe('MOBILE')
    expect(input.disabled).toBe(false)
    expect(viewport.disabled).toBe(false)
    expect(button.disabled).toBe(false)
  })

  it.each(['가', '가'.repeat(40)])('길이 경계 이름 %s는 PC로 만들고 빈 목록 안내를 없앤다', async (name) => {
    vi.mocked(listScreens).mockResolvedValueOnce([])
    vi.mocked(createScreen).mockResolvedValueOnce({ ...createdScreen, name, viewport: 'PC' })
    renderSettings()
    const input = await screen.findByRole('textbox', { name: '화면 이름' })
    expect(screen.getByText('아직 화면이 없어요.')).toBeDefined()
    fireEvent.change(input, { target: { value: name } })
    fireEvent.click(screen.getByRole('button', { name: '만들기' }))

    expect(await screen.findByText(`${name} · PC`)).toBeDefined()
    expect(createScreen).toHaveBeenCalledExactlyOnceWith(project.id, name, 'PC')
    expect(screen.queryByText('아직 화면이 없어요.')).toBeNull()
    expect(screen.queryByRole('heading', { name: '숨긴 화면' })).toBeNull()
  })

  it.each([
    {
      reason: '보이는 이름 중복',
      name: '메인',
      error: new ApiError(409, 'SCREEN_EXISTS'),
      message: '이미 있는 화면이에요',
    },
    {
      reason: '숨긴 이름 중복',
      name: '소개',
      error: new ApiError(409, 'SCREEN_EXISTS'),
      message: '이미 있는 화면이에요',
    },
    { reason: '빈 이름', name: '', error: new ApiError(422), message: '화면 이름은 1~40자로 써 주세요' },
    { reason: '공백 이름', name: '   ', error: new ApiError(422), message: '화면 이름은 1~40자로 써 주세요' },
    { reason: '41자 이름', name: '가'.repeat(41), error: new ApiError(422), message: '화면 이름은 1~40자로 써 주세요' },
    {
      reason: '네트워크',
      name: '상품',
      error: new TypeError('Failed to fetch'),
      message: '연결을 확인하고 다시 시도해 주세요',
    },
    { reason: '서버', name: '상품', error: new ApiError(500), message: '잠시 뒤 다시 시도해 주세요' },
    { reason: '권한 거부', name: '상품', error: new ApiError(403), message: '잠시 뒤 다시 시도해 주세요' },
    { reason: '프로젝트 없음', name: '상품', error: new ApiError(404), message: '잠시 뒤 다시 시도해 주세요' },
    {
      reason: '다른 충돌',
      name: '상품',
      error: new ApiError(409, 'OTHER_CONFLICT'),
      message: '잠시 뒤 다시 시도해 주세요',
    },
  ])('$reason 실패는 이름과 목록을 보존하고 잠금을 풀어 다시 시도할 수 있다', async ({ name, error, message }) => {
    vi.mocked(createScreen).mockRejectedValueOnce(error)
    renderSettings()
    const input = await screen.findByRole<HTMLInputElement>('textbox', { name: '화면 이름' })
    const viewport = screen.getByRole<HTMLSelectElement>('combobox', { name: '기기' })
    const button = screen.getByRole<HTMLButtonElement>('button', { name: '만들기' })
    fireEvent.change(input, { target: { value: name } })
    fireEvent.click(button)

    expect((await screen.findByRole('alert')).textContent).toBe(message)
    expect(createScreen).toHaveBeenCalledExactlyOnceWith(project.id, name, 'PC')
    expect(input.value).toBe(name)
    expect(viewport.value).toBe('PC')
    expect(input.disabled).toBe(false)
    expect(viewport.disabled).toBe(false)
    expect(button.disabled).toBe(false)
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
    expect(screen.queryByRole('link', { name: '다시 로그인하기' })).toBeNull()

    const retry = deferred<Screen>()
    vi.mocked(createScreen).mockReturnValueOnce(retry.promise)
    fireEvent.change(input, { target: { value: '상품 상세' } })
    fireEvent.change(viewport, { target: { value: 'MOBILE' } })
    fireEvent.click(button)

    expect(screen.queryByRole('alert')).toBeNull()
    expect(createScreen).toHaveBeenCalledTimes(2)
    expect(createScreen).toHaveBeenLastCalledWith(project.id, '상품 상세', 'MOBILE')
    retry.resolve(createdScreen)
    expect(await screen.findByText('상품 상세 · 모바일')).toBeDefined()
    expect(input.value).toBe('')
    expect(button.disabled).toBe(false)
  })

  it('같은 이름이라도 다른 기기는 별도 화면으로 목록에 붙인다', async () => {
    vi.mocked(listScreens).mockResolvedValueOnce([screens[0]])
    vi.mocked(createScreen).mockResolvedValueOnce(screens[2])
    renderSettings()
    const input = await screen.findByRole('textbox', { name: '화면 이름' })
    fireEvent.change(input, { target: { value: '메인' } })
    fireEvent.change(screen.getByRole('combobox', { name: '기기' }), { target: { value: 'MOBILE' } })
    fireEvent.click(screen.getByRole('button', { name: '만들기' }))

    expect(await screen.findByText('메인 · 모바일')).toBeDefined()
    expect(createScreen).toHaveBeenCalledExactlyOnceWith(project.id, '메인', 'MOBILE')
    expect(screen.getByText('메인 · PC')).toBeDefined()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
  })
})

describe('ProjectSettingsPage 숨기기와 다시 보이기', () => {
  it.each([
    {
      action: '숨기기',
      request: hideScreen,
      target: screens[0],
      updated: { ...screens[0], name: '메인 응답', hiddenAt: '2026-11-05T01:00:00.000Z' },
    },
    {
      action: '다시 보이기',
      request: showScreen,
      target: screens[1],
      updated: { ...screens[1], name: '소개 응답', hiddenAt: null },
    },
  ])(
    '$action 동안 모든 변경 버튼을 잠그고 서버 응답으로 해당 줄만 옮긴다',
    async ({ action, request, target, updated }) => {
      const pending = deferred<Screen>()
      vi.mocked(request).mockReturnValueOnce(pending.promise)
      renderSettings()
      await screen.findByRole('heading', { name: project.name })
      const buttons = screen.getAllByRole<HTMLButtonElement>('button', { name: /^(숨기기|다시 보이기)$/ })
      fireEvent.click(screen.getAllByRole('button', { name: action })[0])

      expect(request).toHaveBeenCalledExactlyOnceWith(target.id)
      expect(buttons.every((button) => button.disabled)).toBe(true)
      buttons.forEach((button) => fireEvent.click(button))
      expect(vi.mocked(hideScreen).mock.calls.length + vi.mocked(showScreen).mock.calls.length).toBe(1)
      expect(screen.getAllByRole('listitem')).toHaveLength(3)
      expect(screen.queryByText(`${updated.name} · PC`)).toBeNull()

      pending.resolve(updated)

      expect(await screen.findByText(`${updated.name} · PC`)).toBeDefined()
      expect(screen.queryByText(`${target.name} · PC`)).toBeNull()
      expect(screen.getAllByRole('listitem')).toHaveLength(3)
      expect(
        screen
          .getAllByRole<HTMLButtonElement>('button', { name: /^(숨기기|다시 보이기)$/ })
          .every((button) => !button.disabled),
      ).toBe(true)
      const visible = screen.getAllByRole('list')[0]
      if (action === '숨기기') {
        expect(
          within(visible)
            .getAllByRole('listitem')
            .map((item) => item.textContent),
        ).toEqual(['01메인 · 모바일숨기기'])
        expect(
          within(screen.getAllByRole('list')[1])
            .getAllByRole('listitem')
            .map((item) => item.textContent),
        ).toEqual(['메인 응답 · PC다시 보이기', '소개 · PC다시 보이기'])
      }
      if (action === '다시 보이기') {
        expect(
          within(visible)
            .getAllByRole('listitem')
            .map((item) => item.textContent),
        ).toEqual(['01메인 · PC숨기기', '02소개 응답 · PC숨기기', '03메인 · 모바일숨기기'])
        expect(screen.queryByRole('heading', { name: '숨긴 화면' })).toBeNull()
      }
    },
  )

  it('마지막 화면을 숨기면 빈 안내가 나오고 복원하면 다시 01로 보인다', async () => {
    vi.mocked(listScreens).mockResolvedValueOnce([screens[0]])
    vi.mocked(showScreen).mockResolvedValueOnce(screens[0])
    renderSettings()
    fireEvent.click(await screen.findByRole('button', { name: '숨기기' }))

    expect(await screen.findByText('아직 화면이 없어요.')).toBeDefined()
    expect(screen.getByRole('heading', { name: '숨긴 화면' })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: '다시 보이기' }))

    expect(await screen.findByRole('button', { name: '숨기기' })).toBeDefined()
    expect(showScreen).toHaveBeenCalledExactlyOnceWith(screens[0].id)
    expect(screen.getByRole('listitem').textContent).toBe('01메인 · PC숨기기')
    expect(screen.queryByText('아직 화면이 없어요.')).toBeNull()
    expect(screen.queryByRole('heading', { name: '숨긴 화면' })).toBeNull()
  })

  it.each([
    {
      action: '숨기기',
      request: hideScreen,
      error: new TypeError('Failed to fetch'),
      message: '연결을 확인하고 다시 시도해 주세요',
    },
    { action: '숨기기', request: hideScreen, error: new ApiError(500), message: '잠시 뒤 다시 시도해 주세요' },
    { action: '숨기기', request: hideScreen, error: new ApiError(403), message: '잠시 뒤 다시 시도해 주세요' },
    { action: '숨기기', request: hideScreen, error: new ApiError(404), message: '잠시 뒤 다시 시도해 주세요' },
    {
      action: '다시 보이기',
      request: showScreen,
      error: new TypeError('Failed to fetch'),
      message: '연결을 확인하고 다시 시도해 주세요',
    },
    { action: '다시 보이기', request: showScreen, error: new ApiError(500), message: '잠시 뒤 다시 시도해 주세요' },
    { action: '다시 보이기', request: showScreen, error: new ApiError(403), message: '잠시 뒤 다시 시도해 주세요' },
    { action: '다시 보이기', request: showScreen, error: new ApiError(404), message: '잠시 뒤 다시 시도해 주세요' },
  ])(
    '$action 오류 $error는 목록을 보존하고 모든 버튼을 풀어 다시 시도할 수 있다',
    async ({ action, request, error, message }) => {
      vi.mocked(request).mockRejectedValueOnce(error)
      renderSettings()
      await screen.findByRole('heading', { name: project.name })
      const originalItems = screen.getAllByRole('listitem').map((item) => item.textContent)
      fireEvent.click(screen.getAllByRole('button', { name: action })[0])

      expect((await screen.findByRole('alert')).textContent).toBe(message)
      expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual(originalItems)
      expect(
        screen
          .getAllByRole<HTMLButtonElement>('button', { name: /^(숨기기|다시 보이기)$/ })
          .every((button) => !button.disabled),
      ).toBe(true)
      const pending = deferred<Screen>()
      vi.mocked(request).mockReturnValueOnce(pending.promise)
      fireEvent.click(screen.getAllByRole('button', { name: action })[0])
      expect(screen.queryByRole('alert')).toBeNull()
      expect(request).toHaveBeenCalledTimes(2)

      await act(async () => {
        pending.resolve(
          action === '숨기기'
            ? { ...screens[0], hiddenAt: '2026-11-05T01:00:00.000Z' }
            : { ...screens[1], hiddenAt: null },
        )
      })
      expect(screen.getAllByRole('listitem').map((item) => item.textContent)).not.toEqual(originalItems)
      expect(
        screen
          .getAllByRole<HTMLButtonElement>('button', { name: /^(숨기기|다시 보이기)$/ })
          .every((button) => !button.disabled),
      ).toBe(true)
    },
  )
})

describe('ProjectSettingsPage 작업 사이 오류 초기화', () => {
  it.each([
    {
      action: '숨기기',
      request: hideScreen,
      target: screens[0],
      updated: { ...screens[0], hiddenAt: '2026-11-05T01:00:00.000Z' },
      nextButton: '다시 보이기',
    },
    {
      action: '다시 보이기',
      request: showScreen,
      target: screens[1],
      updated: { ...screens[1], hiddenAt: null },
      nextButton: '숨기기',
    },
  ])(
    '만들기 409 뒤 $action 시작 즉시 오류를 지우고 성공 뒤에도 오류가 없다',
    async ({ action, request, target, updated, nextButton }) => {
      vi.mocked(createScreen).mockRejectedValueOnce(new ApiError(409, 'SCREEN_EXISTS'))
      const pending = deferred<Screen>()
      vi.mocked(request).mockReturnValueOnce(pending.promise)
      renderSettings()
      const input = await screen.findByRole<HTMLInputElement>('textbox', { name: '화면 이름' })
      fireEvent.change(input, { target: { value: '메인' } })
      fireEvent.click(screen.getByRole('button', { name: '만들기' }))
      expect((await screen.findByRole('alert')).textContent).toBe('이미 있는 화면이에요')

      fireEvent.click(screen.getAllByRole('button', { name: action })[0])

      expect(request).toHaveBeenCalledExactlyOnceWith(target.id)
      expect(screen.queryByRole('alert')).toBeNull()
      expect(screen.queryByText('이미 있는 화면이에요')).toBeNull()
      await act(async () => {
        pending.resolve(updated)
      })

      const item = screen.getAllByRole('listitem').find((item) => within(item).queryByText(`${target.name} · PC`))!
      expect(within(item).getByRole('button', { name: nextButton })).toBeDefined()
      expect(screen.queryByRole('alert')).toBeNull()
      expect(input.value).toBe('메인')
    },
  )

  it.each([
    { action: '숨기기', request: hideScreen },
    { action: '다시 보이기', request: showScreen },
  ])('$action 실패 뒤 만들기 시작 즉시 오류를 지우고 성공 뒤에도 오류가 없다', async ({ action, request }) => {
    vi.mocked(request).mockRejectedValueOnce(new ApiError(500))
    const pending = deferred<Screen>()
    vi.mocked(createScreen).mockReturnValueOnce(pending.promise)
    renderSettings()
    const input = await screen.findByRole<HTMLInputElement>('textbox', { name: '화면 이름' })
    fireEvent.change(input, { target: { value: '상품 상세' } })
    fireEvent.change(screen.getByRole('combobox', { name: '기기' }), { target: { value: 'MOBILE' } })
    fireEvent.click(screen.getAllByRole('button', { name: action })[0])
    expect((await screen.findByRole('alert')).textContent).toBe('잠시 뒤 다시 시도해 주세요')

    fireEvent.click(screen.getByRole('button', { name: '만들기' }))

    expect(createScreen).toHaveBeenCalledExactlyOnceWith(project.id, '상품 상세', 'MOBILE')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText('잠시 뒤 다시 시도해 주세요')).toBeNull()
    await act(async () => {
      pending.resolve(createdScreen)
    })

    expect(screen.getByText('상품 상세 · 모바일')).toBeDefined()
    expect(screen.getAllByRole('listitem')).toHaveLength(4)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(input.value).toBe('')
  })

  it.each([
    { action: '숨기기', request: hideScreen, target: screens[0] },
    { action: '다시 보이기', request: showScreen, target: screens[1] },
  ])('만들기 409 뒤 $action도 실패하면 새 오류 하나만 보여 준다', async ({ action, request, target }) => {
    vi.mocked(createScreen).mockRejectedValueOnce(new ApiError(409, 'SCREEN_EXISTS'))
    const pending = deferred<Screen>()
    vi.mocked(request).mockReturnValueOnce(pending.promise)
    renderSettings()
    const input = await screen.findByRole<HTMLInputElement>('textbox', { name: '화면 이름' })
    const originalItems = screen.getAllByRole('listitem').map((item) => item.textContent)
    fireEvent.change(input, { target: { value: '메인' } })
    fireEvent.click(screen.getByRole('button', { name: '만들기' }))
    expect((await screen.findByRole('alert')).textContent).toBe('이미 있는 화면이에요')

    fireEvent.click(screen.getAllByRole('button', { name: action })[0])

    expect(request).toHaveBeenCalledExactlyOnceWith(target.id)
    expect(screen.queryByRole('alert')).toBeNull()
    await act(async () => {
      pending.reject(new ApiError(500))
    })

    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getByRole('alert').textContent).toBe('잠시 뒤 다시 시도해 주세요')
    expect(screen.queryByText('이미 있는 화면이에요')).toBeNull()
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual(originalItems)
    expect(input.value).toBe('메인')
  })

  it.each([
    {
      failedAction: '숨기기',
      failedRequest: hideScreen,
      nextAction: '다시 보이기',
      nextRequest: showScreen,
      target: screens[1],
    },
    {
      failedAction: '다시 보이기',
      failedRequest: showScreen,
      nextAction: '숨기기',
      nextRequest: hideScreen,
      target: screens[0],
    },
  ])(
    '$failedAction 401 뒤 $nextAction을 시작하면 로그인 안내와 링크도 지운다',
    async ({ failedAction, failedRequest, nextAction, nextRequest, target }) => {
      vi.mocked(failedRequest).mockRejectedValueOnce(new ApiError(401))
      const pending = deferred<Screen>()
      vi.mocked(nextRequest).mockReturnValueOnce(pending.promise)
      renderSettings()
      await screen.findByRole('heading', { name: project.name })
      fireEvent.click(screen.getAllByRole('button', { name: failedAction })[0])
      expect((await screen.findByRole('alert')).textContent).toContain('로그인이 끝났어요. 다시 로그인해 주세요')
      expect(screen.getByRole('link', { name: '다시 로그인하기' })).toBeDefined()

      fireEvent.click(screen.getAllByRole('button', { name: nextAction })[0])

      expect(nextRequest).toHaveBeenCalledExactlyOnceWith(target.id)
      expect(screen.queryByRole('alert')).toBeNull()
      expect(screen.queryByRole('link', { name: '다시 로그인하기' })).toBeNull()
      await act(async () => {
        pending.reject(new TypeError('Failed to fetch'))
      })

      expect(screen.getAllByRole('alert')).toHaveLength(1)
      expect(screen.getByRole('alert').textContent).toBe('연결을 확인하고 다시 시도해 주세요')
      expect(screen.queryByRole('link', { name: '다시 로그인하기' })).toBeNull()
      expect(screen.getByLabelText('현재 주소').textContent).toBe(`/projects/${project.id}/settings`)
    },
  )
})

describe('ProjectSettingsPage 작업 중 세션 종료', () => {
  it.each([
    { basename: '/', action: '만들기', request: createScreen },
    { basename: '/app', action: '만들기', request: createScreen },
    { basename: '/', action: '숨기기', request: hideScreen },
    { basename: '/app', action: '숨기기', request: hideScreen },
    { basename: '/', action: '다시 보이기', request: showScreen },
    { basename: '/app', action: '다시 보이기', request: showScreen },
  ])(
    'basename $basename에서 $action 401은 쓰던 이름·기기·목록을 보존하고 링크로만 이동한다',
    async ({ basename, action, request }) => {
      vi.mocked(request).mockRejectedValueOnce(new ApiError(401))
      renderSettings(basename)
      const input = await screen.findByRole<HTMLInputElement>('textbox', { name: '화면 이름' })
      const viewport = screen.getByRole<HTMLSelectElement>('combobox', { name: '기기' })
      fireEvent.change(input, { target: { value: '쓰던 화면 이름' } })
      fireEvent.change(viewport, { target: { value: 'MOBILE' } })
      const originalItems = screen.getAllByRole('listitem').map((item) => item.textContent)
      fireEvent.click(screen.getAllByRole('button', { name: action })[0])

      expect((await screen.findByRole('alert')).textContent).toContain('로그인이 끝났어요. 다시 로그인해 주세요')
      expect(input.value).toBe('쓰던 화면 이름')
      expect(viewport.value).toBe('MOBILE')
      expect(input.disabled).toBe(false)
      expect(viewport.disabled).toBe(false)
      expect(screen.getAllByRole<HTMLButtonElement>('button').every((button) => !button.disabled)).toBe(true)
      expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual(originalItems)
      expect(screen.getByLabelText('현재 주소').textContent).toBe(`/projects/${project.id}/settings`)
      expect(screen.queryByRole('heading', { name: '로그인' })).toBeNull()
      const link = screen.getByRole('link', { name: '다시 로그인하기' })
      expect(link.getAttribute('href')).toBe(basename === '/' ? '/login' : '/app/login')

      fireEvent.click(link)

      expect(await screen.findByRole('heading', { name: '로그인' })).toBeDefined()
    },
  )
})
