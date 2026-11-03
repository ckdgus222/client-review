import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { NotFoundPage } from './NotFoundPage.tsx'

describe('NotFoundPage', () => {
  it('404 제목과 안내 문구, 첫 화면으로 가는 링크를 표시한다', () => {
    render(
      <MemoryRouter initialEntries={['/abc']}>
        <NotFoundPage />
      </MemoryRouter>,
    )

    expect(screen.getByRole('heading', { level: 1, name: '없는 화면이에요' })).toBeDefined()
    expect(screen.getByText('주소가 맞는지 확인해 주세요.')).toBeDefined()
    expect(screen.getByRole('link', { name: '첫 화면으로 가기' }).getAttribute('href')).toBe('/')
  })
})
