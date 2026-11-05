import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import App from './App.tsx'
import { getMe } from './api/auth.ts'
import { listProjects } from './api/projects.ts'

vi.mock('./api/auth.ts', async () => {
  const actual = await vi.importActual<typeof import('./api/auth.ts')>('./api/auth.ts')
  return { ...actual, getMe: vi.fn() }
})

vi.mock('./api/projects.ts', async () => {
  const actual = await vi.importActual<typeof import('./api/projects.ts')>('./api/projects.ts')
  return { ...actual, listProjects: vi.fn() }
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
})

describe('App', () => {
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
