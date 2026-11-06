import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { ErrorText, SessionEnded } from './ErrorText.tsx'

describe('ErrorText', () => {
  it('오류 내용을 role=alert 문단으로 보여 준다', () => {
    render(<ErrorText message="잠시 뒤 다시 시도해 주세요" />)

    const alert = screen.getByRole('alert')
    expect(alert.tagName).toBe('P')
    expect(alert.textContent).toBe('잠시 뒤 다시 시도해 주세요')
  })

  it.each(['/', '/app'])('basename이 %s이면 세션 종료 문구와 로그인 링크를 함께 보여 준다', async (basename) => {
    const prefix = basename === '/' ? '' : basename
    render(
      <MemoryRouter basename={basename} initialEntries={[`${prefix}/`]}>
        <Routes>
          <Route path="/" element={<ErrorText message={<SessionEnded />} />} />
          <Route path="/login" element={<h1>로그인</h1>} />
        </Routes>
      </MemoryRouter>,
    )

    const alert = screen.getByRole('alert')
    expect(alert.tagName).toBe('P')
    expect(alert.textContent).toContain('로그인이 끝났어요. 다시 로그인해 주세요')
    const link = within(alert).getByRole('link', { name: '다시 로그인하기' })
    expect(link.getAttribute('href')).toBe(`${prefix}/login`)
    expect(screen.queryByRole('heading', { name: '로그인' })).toBeNull()

    fireEvent.click(link)

    expect(await screen.findByRole('heading', { name: '로그인' })).toBeDefined()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
