import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { ProjectDetail } from '../api/projects.ts'
import { ManagementLayout, PageLayout } from './PageLayout.tsx'

describe('PageLayout', () => {
  it('머리말에 서비스 이름 Client Review를 표시한다', () => {
    render(
      <PageLayout>
        <p>본문 내용</p>
      </PageLayout>,
    )

    const banner = screen.getByRole('banner')

    expect(within(banner).getByText('Client Review')).toBeDefined()
  })

  it('넘긴 children을 본문 안에 그린다', () => {
    render(
      <PageLayout>
        <p>수정 요청 목록</p>
      </PageLayout>,
    )

    const main = screen.getByRole('main')

    expect(within(main).getByText('수정 요청 목록')).toBeDefined()
  })
})

describe('ManagementLayout', () => {
  const project: ProjectDetail = {
    id: 'ebf058f0-dc9e-4a14-adcd-cb2712594e5a',
    name: '오브젝트 스토어',
    myRole: 'DEVELOPER',
    currentVersion: null,
    approver: null,
    isApprover: false,
    status: 'ACTIVE',
    purgeAfter: null,
  }

  it.each([
    ['projects', '내 프로젝트'],
    ['draft', '버전 준비'],
    ['settings', '프로젝트 설정'],
    ['activity', '활동 일지'],
  ] as const)('%s 화면에서는 %s 링크만 현재 페이지로 표시한다', (active, title) => {
    render(
      <MemoryRouter>
        <PageLayout>
          <ManagementLayout active={active} project={project}>
            <h1>관리 화면 본문</h1>
          </ManagementLayout>
        </PageLayout>
      </MemoryRouter>,
    )

    const menu = within(screen.getByRole('navigation', { name: '프로젝트 메뉴' }))
    const currentLink = menu.getByRole('link', { name: title, current: 'page' })

    expect(menu.getAllByRole('link', { current: 'page' })).toEqual([currentLink])
    for (const link of menu.getAllByRole('link').filter((link) => link !== currentLink)) {
      expect(link.getAttribute('aria-current')).toBeNull()
    }
    expect(within(screen.getByRole('main')).getByRole('heading', { name: '관리 화면 본문' })).toBeDefined()
  })

  it.each(['DEVELOPER', 'CLIENT'] as const)('%s 역할에 허용된 링크를 정확한 목적지로 한 번씩 표시한다', (myRole) => {
    render(
      <MemoryRouter>
        <ManagementLayout active="activity" project={{ ...project, myRole }}>
          <p>활동 내용</p>
        </ManagementLayout>
      </MemoryRouter>,
    )

    const menu = within(screen.getByRole('navigation', { name: '프로젝트 메뉴' }))
    const projectPath = `/projects/${project.id}`

    expect(menu.getByRole('link', { name: '내 프로젝트' }).getAttribute('href')).toBe('/')
    expect(menu.getByRole('link', { name: '검수실' }).getAttribute('href')).toBe(projectPath)
    expect(menu.getByRole('link', { name: '활동 일지', current: 'page' }).getAttribute('href')).toBe(`${projectPath}/activity`)

    if (myRole === 'CLIENT') {
      expect(menu.queryByRole('link', { name: '버전 준비' })).toBeNull()
      expect(menu.queryByRole('link', { name: '프로젝트 설정' })).toBeNull()
      expect(menu.getAllByRole('link')).toHaveLength(3)
      return
    }

    expect(menu.getByRole('link', { name: '버전 준비' }).getAttribute('href')).toBe(`${projectPath}/draft`)
    expect(menu.getByRole('link', { name: '프로젝트 설정' }).getAttribute('href')).toBe(`${projectPath}/settings`)
    expect(menu.getAllByRole('link')).toHaveLength(5)
  })

  it('프로젝트와 그룹을 넘기지 않으면 내 프로젝트 링크만 표시한다', () => {
    render(
      <MemoryRouter>
        <ManagementLayout active="projects">
          <p>프로젝트 목록</p>
        </ManagementLayout>
      </MemoryRouter>,
    )

    const menu = within(screen.getByRole('navigation', { name: '프로젝트 메뉴' }))

    expect(menu.getAllByRole('link')).toEqual([
      menu.getByRole('link', { name: '내 프로젝트', current: 'page' }),
    ])
    expect(screen.getByText('프로젝트 목록')).toBeDefined()
  })

  it('건수가 있는 그룹의 이동 링크와 건수만 표시하고 빈 그룹은 숨긴다', () => {
    render(
      <MemoryRouter>
        <ManagementLayout
          active="projects"
          sections={[
            { id: 'active', title: '진행 중', count: 2 },
            { id: 'archived', title: '보관함', count: 1 },
            { id: 'delete-pending', title: '삭제 대기', count: 0 },
          ]}
        >
          <p>프로젝트 목록</p>
        </ManagementLayout>
      </MemoryRouter>,
    )

    const menu = within(screen.getByRole('navigation', { name: '프로젝트 메뉴' }))

    expect(menu.getByRole('link', { name: '진행 중 2' }).getAttribute('href')).toBe('#active')
    expect(menu.getByRole('link', { name: '보관함 1' }).getAttribute('href')).toBe('#archived')
    expect(menu.queryByRole('link', { name: /삭제 대기/ })).toBeNull()
    expect(menu.queryByText('삭제 대기')).toBeNull()
    expect(menu.getAllByRole('link')).toHaveLength(3)
  })
})
