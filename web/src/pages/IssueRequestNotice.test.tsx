import { fireEvent, render, screen, within } from '@testing-library/react'
import { Link, MemoryRouter } from 'react-router'
import type { SubmitError } from '../hooks/useLockedSubmit.ts'
import { IssueRequestNotice } from './IssueRequestNotice.tsx'

const unconfirmedMessage = '저장됐는지 확인하지 못했어요. 쪽지에 바뀐 내용이 보이지 않으면 다시 보내 주세요.'
const staleMessage = '쪽지 상태가 바뀌었어요. 새로 불러왔어요.'
const versionChangedNotice = (
  <>
    새 버전이 올라왔어요. <Link to="/projects/project-1/review">검수실로 돌아가기</Link>
  </>
)

describe('IssueRequestNotice', () => {
  it('실패가 없으면 대체 안내를 넘겨도 아무것도 그리지 않는다', () => {
    const { container } = render(
      <IssueRequestNotice
        unconfirmed={false}
        stale={false}
        onGoLatest={vi.fn()}
        versionChangedNotice={versionChangedNotice}
      />,
      { wrapper: MemoryRouter },
    )

    expect(container.innerHTML).toBe('')
  })

  it.each([
    ['저장 여부 모름', true, false, undefined, unconfirmedMessage],
    ['쪽지 상태 변경', false, true, undefined, staleMessage],
    ['저장 여부 안내가 오류보다 먼저', true, false, { kind: 'conflict', code: 'VERSION_CHANGED' }, unconfirmedMessage],
    ['상태 변경 안내가 오류보다 먼저', false, true, { kind: 'conflict', code: 'VERSION_CHANGED' }, staleMessage],
    ['저장 여부 안내가 상태 변경 안내보다 먼저', true, true, { kind: 'rejected', status: 422 }, unconfirmedMessage],
  ] satisfies [string, boolean, boolean, SubmitError | undefined, string][])(
    '%s인 경우 alert 하나로 해당 안내만 보여 준다',
    (_, unconfirmed, stale, error, message) => {
      const onGoLatest = vi.fn()
      render(
        <IssueRequestNotice
          error={error}
          unconfirmed={unconfirmed}
          stale={stale}
          onGoLatest={onGoLatest}
          versionChangedNotice={versionChangedNotice}
        />,
        { wrapper: MemoryRouter },
      )

      expect(screen.getAllByRole('alert')).toHaveLength(1)
      expect(screen.getByRole('alert').textContent).toBe(message)
      expect(screen.queryByRole('button')).toBeNull()
      expect(screen.queryByRole('link')).toBeNull()
      expect(onGoLatest).not.toHaveBeenCalled()
    },
  )

  it.each([
    ['입력 오류', { kind: 'rejected', status: 422 }, '입력한 내용을 확인해 주세요'],
    ['없는 대상', { kind: 'rejected', status: 404 }, '찾을 수 없어요. 화면을 새로 고쳐 주세요'],
    ['권한 거절', { kind: 'rejected', status: 403 }, '잠시 뒤 다시 시도해 주세요'],
    ['승인된 버전', { kind: 'conflict', code: 'VERSION_NOT_IN_REVIEW' }, '승인된 버전이라 더 쓸 수 없어요.'],
    ['코드 없는 충돌', { kind: 'conflict' }, '잠시 뒤 다시 시도해 주세요'],
    ['연결 오류', { kind: 'unknown' }, '연결을 확인하고 다시 시도해 주세요'],
  ] satisfies [string, SubmitError, string][])(
    '%s는 SubmitErrorText 문구를 쓰고 새 버전 대체 안내의 영향을 받지 않는다',
    (_, error, message) => {
      render(
        <IssueRequestNotice
          error={error}
          unconfirmed={false}
          stale={false}
          onGoLatest={vi.fn()}
          versionChangedNotice={versionChangedNotice}
        />,
        { wrapper: MemoryRouter },
      )

      expect(screen.getByRole('alert').textContent).toBe(message)
      expect(screen.queryByRole('button')).toBeNull()
      expect(screen.queryByRole('link')).toBeNull()
    },
  )

  it('VERSION_CHANGED 코드가 있어도 conflict가 아니면 대체 안내를 쓰지 않는다', () => {
    const error = { kind: 'rejected', status: 422, code: 'VERSION_CHANGED' } as const
    render(
      <IssueRequestNotice
        error={error}
        unconfirmed={false}
        stale={false}
        onGoLatest={vi.fn()}
        versionChangedNotice={versionChangedNotice}
      />,
      { wrapper: MemoryRouter },
    )

    expect(screen.getByRole('alert').textContent).toBe('입력한 내용을 확인해 주세요')
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('세션이 끝나면 글을 보존하도록 새 탭 로그인 링크를 보여 준다', () => {
    render(
      <IssueRequestNotice
        error={{ kind: 'session' }}
        unconfirmed={false}
        stale={false}
        onGoLatest={vi.fn()}
        versionChangedNotice={versionChangedNotice}
      />,
      { wrapper: MemoryRouter },
    )

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('로그인이 끝났어요. 다른 탭에서 로그인한 뒤 다시 눌러 주세요')
    const link = within(alert).getByRole('link', { name: '새 탭에서 로그인하기' })
    expect(link.getAttribute('href')).toBe('/login')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('link', { name: '검수실로 돌아가기' })).toBeNull()
  })

  it('VERSION_CHANGED는 글 보존 안내와 최신 버전 보기 버튼을 보여 주고 누를 때만 알린다', () => {
    const onGoLatest = vi.fn()
    render(
      <IssueRequestNotice
        error={{ kind: 'conflict', code: 'VERSION_CHANGED' }}
        unconfirmed={false}
        stale={false}
        onGoLatest={onGoLatest}
      />,
      { wrapper: MemoryRouter },
    )

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('새 버전이 올라왔어요. 쓰던 글은 그대로 남아 있어요.')
    const button = within(alert).getByRole('button', { name: '최신 버전 보기' })
    expect(button.getAttribute('type')).toBe('button')
    expect(onGoLatest).not.toHaveBeenCalled()
    fireEvent.click(button)
    expect(onGoLatest).toHaveBeenCalledTimes(1)
  })

  it('VERSION_CHANGED에 대체 안내를 넘기면 그 내용만 보여 주고 최신 버전 버튼은 없다', () => {
    const onGoLatest = vi.fn()
    render(
      <IssueRequestNotice
        error={{ kind: 'conflict', code: 'VERSION_CHANGED' }}
        unconfirmed={false}
        stale={false}
        onGoLatest={onGoLatest}
        versionChangedNotice={versionChangedNotice}
      />,
      { wrapper: MemoryRouter },
    )

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toBe('새 버전이 올라왔어요. 검수실로 돌아가기')
    expect(within(alert).getByRole('link', { name: '검수실로 돌아가기' }).getAttribute('href')).toBe(
      '/projects/project-1/review',
    )
    expect(screen.queryByRole('button')).toBeNull()
    expect(onGoLatest).not.toHaveBeenCalled()
  })

  it('실패 상태가 바뀌면 이전 안내를 거두고 현재 안내만 보여 준다', () => {
    const onGoLatest = vi.fn()
    const { container, rerender } = render(
      <IssueRequestNotice unconfirmed={true} stale={false} onGoLatest={onGoLatest} />,
      { wrapper: MemoryRouter },
    )
    expect(screen.getByRole('alert').textContent).toBe(unconfirmedMessage)

    rerender(<IssueRequestNotice unconfirmed={false} stale={true} onGoLatest={onGoLatest} />)
    expect(screen.getByRole('alert').textContent).toBe(staleMessage)

    rerender(
      <IssueRequestNotice
        error={{ kind: 'rejected', status: 422 }}
        unconfirmed={false}
        stale={false}
        onGoLatest={onGoLatest}
      />,
    )
    expect(screen.getByRole('alert').textContent).toBe('입력한 내용을 확인해 주세요')

    rerender(<IssueRequestNotice unconfirmed={false} stale={false} onGoLatest={onGoLatest} />)
    expect(container.innerHTML).toBe('')
  })
})
