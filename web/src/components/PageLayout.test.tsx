import { render, screen, within } from '@testing-library/react'
import { PageLayout } from './PageLayout.tsx'

describe('PageLayout', () => {
  it('머리말에 서비스 이름 Client Review를 표시한다', () => {
    render(<PageLayout><p>본문 내용</p></PageLayout>)

    const banner = screen.getByRole('banner')

    expect(within(banner).getByText('Client Review')).toBeDefined()
  })

  it('넘긴 children을 본문 안에 그린다', () => {
    render(<PageLayout><p>수정 요청 목록</p></PageLayout>)

    const main = screen.getByRole('main')

    expect(within(main).getByText('수정 요청 목록')).toBeDefined()
  })
})
