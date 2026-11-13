import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { SubmitError } from '../hooks/useLockedSubmit.ts'
import { SubmitErrorText } from './SubmitErrorText.tsx'

describe('SubmitErrorText', () => {
  it.each([
    ['PROJECT_ARCHIVED', '보관한 프로젝트예요. 보관을 풀어야 바꿀 수 있어요'],
    ['PROJECT_DELETE_PENDING', '삭제 대기 중인 프로젝트예요. 되살려야 바꿀 수 있어요'],
  ])('%s 충돌은 프로젝트 상태 안내만 보여 준다', (code, message) => {
    const onGoLatest = vi.fn()
    render(<SubmitErrorText error={{ kind: 'conflict', code }} locked={false} onGoLatest={onGoLatest} />, {
      wrapper: MemoryRouter,
    })

    expect(screen.getByRole('alert').textContent).toBe(message)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
    expect(onGoLatest).not.toHaveBeenCalled()
  })

  it.each([
    ['연결 실패', { kind: 'unknown' }, false, '연결을 확인하고 다시 시도해 주세요'],
    [
      '잠긴 연결 실패',
      { kind: 'unknown' },
      true,
      '연결을 확인하고 다시 보내 주세요. 저장됐는지 확인하지 못해서, 같은 글을 다시 보낼 때까지 고칠 수 없어요.',
    ],
    ['승인된 버전', { kind: 'conflict', code: 'VERSION_NOT_IN_REVIEW' }, false, '승인된 버전이라 더 쓸 수 없어요.'],
    ['입력 오류', { kind: 'rejected', status: 422 }, false, '입력한 내용을 확인해 주세요'],
    ['없는 대상', { kind: 'rejected', status: 404 }, false, '찾을 수 없어요. 화면을 새로 고쳐 주세요'],
    ['권한 거절', { kind: 'rejected', status: 403 }, true, '잠시 뒤 다시 시도해 주세요'],
    ['그 밖의 거절', { kind: 'rejected', status: 400 }, false, '잠시 뒤 다시 시도해 주세요'],
    ['이미 쓰인 요청 번호', { kind: 'conflict', code: 'REQUEST_ID_REUSED' }, false, '잠시 뒤 다시 시도해 주세요'],
    ['코드 없는 충돌', { kind: 'conflict' }, false, '잠시 뒤 다시 시도해 주세요'],
  ] satisfies [string, SubmitError, boolean, string][])(
    '%s는 alert로 문구를 보여 준다',
    (_label, error, locked, message) => {
      render(<SubmitErrorText error={error} locked={locked} onGoLatest={vi.fn()} />, { wrapper: MemoryRouter })

      expect(screen.getByRole('alert').textContent).toBe(message)
      expect(screen.queryByRole('link')).toBeNull()
      expect(screen.queryByRole('button')).toBeNull()
    },
  )

  it.each([false, true])('잠금이 %s여도 세션 만료는 로그인 링크를 새 탭으로 연다', (locked) => {
    render(<SubmitErrorText error={{ kind: 'session' }} locked={locked} onGoLatest={vi.fn()} />, {
      wrapper: MemoryRouter,
    })

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('로그인이 끝났어요. 다른 탭에서 로그인한 뒤 다시 눌러 주세요')
    const link = within(alert).getByRole('link', { name: '새 탭에서 로그인하기' })
    expect(link.getAttribute('href')).toBe('/login')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('VERSION_CHANGED는 글 보존 안내와 최신 버전 보기 버튼을 보여 주고 누를 때만 알린다', () => {
    const onGoLatest = vi.fn()
    render(
      <SubmitErrorText error={{ kind: 'conflict', code: 'VERSION_CHANGED' }} locked={false} onGoLatest={onGoLatest} />,
      { wrapper: MemoryRouter },
    )

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('새 버전이 올라왔어요. 쓰던 글은 그대로 남아 있어요.')
    const button = within(alert).getByRole('button', { name: '최신 버전 보기' })
    expect(button.getAttribute('type')).toBe('button')
    expect(onGoLatest).not.toHaveBeenCalled()
    fireEvent.click(button)
    expect(onGoLatest).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('link')).toBeNull()
  })
})
