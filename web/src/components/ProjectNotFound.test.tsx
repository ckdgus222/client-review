import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { ProjectNotFound } from './ProjectNotFound.tsx'

describe('ProjectNotFound', () => {
  it('없는 프로젝트 안내를 제목으로 보여 준다', () => {
    render(
      <MemoryRouter>
        <ProjectNotFound />
      </MemoryRouter>,
    )

    expect(screen.getByRole('heading', { level: 1, name: '없는 프로젝트예요' })).toBeDefined()
  })

  it.each(['/', '/app'])('basename이 %s이면 프로젝트 목록 링크로 목록에 돌아간다', async (basename) => {
    const prefix = basename === '/' ? '' : basename
    render(
      <MemoryRouter basename={basename} initialEntries={[`${prefix}/projects/missing/settings`]}>
        <Routes>
          <Route path="/projects/:id/settings" element={<ProjectNotFound />} />
          <Route path="/" element={<h1>프로젝트 목록</h1>} />
        </Routes>
      </MemoryRouter>,
    )

    const link = screen.getByRole('link', { name: '프로젝트 목록' })
    expect(link.getAttribute('href')).toBe(basename)

    fireEvent.click(link)

    expect(await screen.findByRole('heading', { name: '프로젝트 목록' })).toBeDefined()
    expect(screen.queryByRole('heading', { name: '없는 프로젝트예요' })).toBeNull()
  })
})
