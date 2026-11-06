import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import App from './App.tsx'
import { getMe } from './api/auth.ts'
import { getProject, listProjects, listScreens } from './api/projects.ts'

vi.mock('./api/auth.ts', async () => {
  const actual = await vi.importActual<typeof import('./api/auth.ts')>('./api/auth.ts')
  return { ...actual, getMe: vi.fn() }
})

vi.mock('./api/projects.ts', async () => {
  const actual = await vi.importActual<typeof import('./api/projects.ts')>('./api/projects.ts')
  return { ...actual, listProjects: vi.fn(), getProject: vi.fn(), listScreens: vi.fn() }
})

const user = {
  canCreateProjects: false,
  id: '5b3a934d-ef8e-4ce8-b26a-a9d1cdd4983f',
  email: 'reader@example.com',
  name: '김수정',
}

beforeEach(() => {
  vi.mocked(getMe).mockReset()
  vi.mocked(listProjects).mockReset().mockResolvedValue([])
  vi.mocked(getProject).mockReset()
  vi.mocked(listScreens).mockReset().mockResolvedValue([])
})

describe('App', () => {
  it.each(['/', '/app'])('basename이 %s이면 프로젝트 설정 주소에 설정 화면을 그린다', async (basename) => {
    const project = {
      id: 'ebf058f0-dc9e-4a14-adcd-cb2712594e5a',
      name: '설정할 프로젝트',
      myRole: 'DEVELOPER' as const,
    }
    const prefix = basename === '/' ? '' : basename
    vi.mocked(getMe).mockResolvedValueOnce(user)
    vi.mocked(getProject).mockResolvedValueOnce(project)
    render(
      <MemoryRouter basename={basename} initialEntries={[`${prefix}/projects/${project.id}/settings`]}>
        <App />
      </MemoryRouter>,
    )

    const main = within(screen.getByRole('main'))
    expect(await main.findByRole('heading', { level: 1, name: project.name })).toBeDefined()
    expect(main.getByRole('textbox', { name: '화면 이름' })).toBeDefined()
    expect(main.getByRole('combobox', { name: '기기' })).toBeDefined()
    expect(main.getByText('아직 화면이 없어요.')).toBeDefined()
    expect(main.getByRole('link', { name: '프로젝트 목록' }).getAttribute('href')).toMatch(
      basename === '/' ? /^\/$/ : /^\/app\/?$/,
    )
    expect(screen.queryByRole('heading', { name: '없는 화면이에요' })).toBeNull()
    expect(within(screen.getByRole('banner')).getByText('Client Review')).toBeDefined()
    expect(getProject).toHaveBeenCalledExactlyOnceWith(project.id)
    expect(listScreens).toHaveBeenCalledExactlyOnceWith(project.id)
    expect(listProjects).not.toHaveBeenCalled()
  })

  it.each(['/', '/app'])('basename이 %s이면 목록과 설정을 오갈 때마다 로그인을 다시 확인한다', async (basename) => {
    const project = {
      id: 'ebf058f0-dc9e-4a14-adcd-cb2712594e5a',
      name: '이동할 프로젝트',
      myRole: 'DEVELOPER' as const,
    }
    const prefix = basename === '/' ? '' : basename
    vi.mocked(getMe).mockResolvedValueOnce(user)
    vi.mocked(listProjects).mockResolvedValue([{ ...project, createdAt: '2026-11-05T00:00:00.000Z' }])
    vi.mocked(getProject).mockResolvedValueOnce(project)
    render(
      <MemoryRouter basename={basename} initialEntries={[`${prefix}/`]}>
        <App />
      </MemoryRouter>,
    )
    const projectLink = await screen.findByRole('link', { name: project.name })
    let resolveSettingsUser!: (value: typeof user) => void
    vi.mocked(getMe).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSettingsUser = resolve
        }),
    )
    fireEvent.click(projectLink)

    expect(screen.getByText('확인하는 중이에요.')).toBeDefined()
    expect(getMe).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('textbox', { name: '화면 이름' })).toBeNull()
    resolveSettingsUser(user)
    expect(await screen.findByRole('heading', { name: project.name })).toBeDefined()

    let resolveListUser!: (value: typeof user) => void
    vi.mocked(getMe).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveListUser = resolve
        }),
    )
    fireEvent.click(screen.getByRole('link', { name: '프로젝트 목록' }))

    expect(screen.getByText('확인하는 중이에요.')).toBeDefined()
    expect(getMe).toHaveBeenCalledTimes(3)
    resolveListUser(user)
    expect(await screen.findByRole('heading', { name: '내 프로젝트' })).toBeDefined()
    expect(screen.queryByRole('heading', { name: project.name })).toBeNull()
  })

  it('첫 화면에는 내 프로젝트 제목을 표시하고 404 제목은 표시하지 않는다', async () => {
    vi.mocked(getMe).mockResolvedValueOnce(user)
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    )

    expect(
      await within(screen.getByRole('main')).findByRole('heading', { level: 1, name: '내 프로젝트' }),
    ).toBeDefined()
    expect(screen.queryByRole('heading', { name: '없는 화면이에요' })).toBeNull()
    expect(listProjects).toHaveBeenCalledExactlyOnceWith()
  })

  it.each(['/abc', '/abc/def', '/app/abc', '/abc?from=link#details'])(
    '없는 주소 %s에는 공통 머리말과 404 화면을 표시한다',
    (path) => {
      render(
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>,
      )

      const main = within(screen.getByRole('main'))

      expect(within(screen.getByRole('banner')).getByText('Client Review')).toBeDefined()
      expect(main.getByRole('heading', { level: 1, name: '없는 화면이에요' })).toBeDefined()
      expect(main.getByText('주소가 맞는지 확인해 주세요.')).toBeDefined()
      expect(main.getByRole('link', { name: '첫 화면으로 가기' })).toBeDefined()
      expect(screen.queryByText('준비 중이에요.')).toBeNull()
    },
  )

  it.each([
    { basename: '/', path: '/abc/def', homeHref: /^\/$/ },
    { basename: '/app', path: '/app/abc', homeHref: /^\/app\/?$/ },
  ])('basename이 $basename일 때 링크를 누르면 첫 화면으로 이동한다', async ({ basename, path, homeHref }) => {
    vi.mocked(getMe).mockResolvedValueOnce(user)
    render(
      <MemoryRouter basename={basename} initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    )

    expect(screen.getByRole('heading', { level: 1, name: '없는 화면이에요' })).toBeDefined()
    const homeLink = screen.getByRole('link', { name: '첫 화면으로 가기' })
    expect(homeLink.getAttribute('href')).toMatch(homeHref)

    fireEvent.click(homeLink)

    expect(await screen.findByRole('heading', { level: 1, name: '내 프로젝트' })).toBeDefined()
    expect(screen.queryByRole('heading', { name: '없는 화면이에요' })).toBeNull()
    expect(listProjects).toHaveBeenCalledExactlyOnceWith()
    expect(screen.queryByText('주소가 맞는지 확인해 주세요.')).toBeNull()
    expect(screen.queryByRole('link', { name: '첫 화면으로 가기' })).toBeNull()
    expect(within(screen.getByRole('banner')).getByText('Client Review')).toBeDefined()
  })
})
