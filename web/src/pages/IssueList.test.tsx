import { fireEvent, render, screen, within } from '@testing-library/react'
import type { IssuePin, IssueSummary } from '../api/issues.ts'
import { originLabel } from '../api/issues.ts'
import { IssueList } from './IssueList.tsx'

const origin: IssuePin = {
  screenId: 'product-screen',
  screenName: '상품 상세',
  viewport: 'PC',
  asset: { id: 'product-photo', width: 1440, height: 900 },
  xRatio: 0.25,
  yRatio: 0.5,
}
const draftIssue: IssueSummary = {
  id: 'draft-issue',
  number: 14,
  title: '상품 이름을 크게 보여 주세요',
  status: 'OPEN',
  category: 'BUG',
  scope: 'IN_SCOPE',
  dueDate: null,
  authorName: '클라이언트',
  createdAt: '2026-11-10T00:00:00.000Z',
  commentCount: 2,
  originVersion: { id: 'draft-version', number: 0 },
  origin,
}
const unpinnedIssue: IssueSummary = {
  ...draftIssue,
  id: 'unpinned-issue',
  number: 15,
  title: '문구를 확인해 주세요',
  status: 'IN_PROGRESS',
  commentCount: 0,
  originVersion: { id: 'second-version', number: 2 },
  origin: null,
}
const mobileIssue: IssueSummary = {
  ...draftIssue,
  id: 'mobile-issue',
  number: 16,
  title: '모바일 버튼 간격을 넓혀 주세요',
  commentCount: 1,
  originVersion: { id: 'first-version', number: 1 },
  origin: { ...origin, screenId: 'mobile-screen', viewport: 'MOBILE' },
}
const issues = [mobileIssue, unpinnedIssue, draftIssue]

describe('IssueList', () => {
  it.each([
    ['접수만', [draftIssue], 1],
    ['수정 중만', [unpinnedIssue], 1],
    ['접수와 수정 중', issues, 3],
  ] as const)('%s인 목록의 전체 수와 미해결 수를 머리에 보여 준다', (_label, items, count) => {
    render(<IssueList issues={[...items]} onSelect={vi.fn()} />)

    const list = within(screen.getByRole('region', { name: '쪽지 목록' }))
    expect(list.getByRole('heading', { name: `쪽지 ${count}개` })).toBeTruthy()
    expect(list.getByText(`미해결 ${count}개`)).toBeTruthy()
  })

  it('줄마다 번호·제목·상태·처음 위치·댓글 수를 보여 준다', () => {
    render(<IssueList issues={issues} onSelect={vi.fn()} />)

    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(3)
    const mobileRow = within(rows[0])
    expect(mobileRow.getByText('#16')).toBeTruthy()
    expect(mobileRow.getByText(mobileIssue.title)).toBeTruthy()
    expect(mobileRow.getByText('접수')).toBeTruthy()
    expect(mobileRow.getByText('1차 · 상품 상세 · 모바일 · 댓글 1개')).toBeTruthy()

    const unpinnedRow = within(rows[1])
    expect(unpinnedRow.getByText('#15')).toBeTruthy()
    expect(unpinnedRow.getByText(unpinnedIssue.title)).toBeTruthy()
    expect(unpinnedRow.getByText('수정 중')).toBeTruthy()
    expect(unpinnedRow.getByText('2차 · 위치 없음 · 댓글 0개')).toBeTruthy()

    const draftRow = within(rows[2])
    expect(draftRow.getByText('#14')).toBeTruthy()
    expect(draftRow.getByText(draftIssue.title)).toBeTruthy()
    expect(draftRow.getByText('접수')).toBeTruthy()
    expect(draftRow.getByText('초안 · 상품 상세 · PC · 댓글 2개')).toBeTruthy()
    expect(screen.queryByText(/아직 쪽지가 없어요/)).toBeNull()
  })

  it('번호나 버전으로 다시 정렬하지 않고 받은 순서 그대로 보여 준다', () => {
    const received = [draftIssue, mobileIssue, unpinnedIssue]
    render(<IssueList issues={received} onSelect={vi.fn()} />)

    const rows = screen.getAllByRole('listitem')
    expect(rows.map((row) => within(row).getByText(/^#\d+$/).textContent)).toEqual(['#14', '#16', '#15'])
    expect(received.map((issue) => issue.id)).toEqual(['draft-issue', 'mobile-issue', 'unpinned-issue'])
  })

  it.each([true, false])('쓰기 가능이 %s여도 각 줄을 누르면 그 쪽지 id만 onSelect에 보낸다', (writable) => {
    const onSelect = vi.fn()
    const onCompose = vi.fn()
    render(<IssueList issues={issues} onSelect={onSelect} onCompose={writable ? onCompose : undefined} />)

    const buttons = within(screen.getByRole('list')).getAllByRole('button')
    buttons.forEach((button) => fireEvent.click(button))

    expect(onSelect).toHaveBeenCalledTimes(3)
    expect(onSelect).toHaveBeenNthCalledWith(1, 'mobile-issue')
    expect(onSelect).toHaveBeenNthCalledWith(2, 'unpinned-issue')
    expect(onSelect).toHaveBeenNthCalledWith(3, 'draft-issue')
    expect(onCompose).not.toHaveBeenCalled()
  })

  it('selectedId와 같은 줄만 선택되고 선택을 바꾸거나 없애면 표시도 바뀐다', () => {
    const onSelect = vi.fn()
    const { rerender } = render(<IssueList issues={issues} selectedId="draft-issue" onSelect={onSelect} />)

    expect(screen.getAllByRole('button', { pressed: true })).toEqual([screen.getByRole('button', { name: /#14/ })])
    expect(screen.getAllByRole('button', { pressed: false })).toHaveLength(2)

    rerender(<IssueList issues={issues} selectedId="unpinned-issue" onSelect={onSelect} />)

    expect(screen.getAllByRole('button', { pressed: true })).toEqual([screen.getByRole('button', { name: /#15/ })])
    expect(screen.getAllByRole('button', { pressed: false })).toHaveLength(2)

    rerender(<IssueList issues={issues} onSelect={onSelect} />)

    expect(screen.queryByRole('button', { pressed: true })).toBeNull()
    expect(screen.getAllByRole('button', { pressed: false })).toHaveLength(3)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('목록에 없는 selectedId는 어느 줄도 선택하지 않는다', () => {
    render(<IssueList issues={issues} selectedId="missing-issue" onSelect={vi.fn()} />)

    expect(screen.queryByRole('button', { pressed: true })).toBeNull()
    expect(screen.getAllByRole('button', { pressed: false })).toHaveLength(3)
  })

  it('onCompose가 있으면 쪽지 쓰기를 누를 때 한 번 부르고 쪽지를 선택하지 않는다', () => {
    const onSelect = vi.fn()
    const onCompose = vi.fn()
    render(<IssueList issues={issues} onSelect={onSelect} onCompose={onCompose} />)

    expect(onCompose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '쪽지 쓰기' }))

    expect(onCompose).toHaveBeenCalledTimes(1)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('onCompose가 없으면 쪽지 쓰기 버튼이 없고 권한이 바뀌면 버튼도 바뀐다', () => {
    const onSelect = vi.fn()
    const onCompose = vi.fn()
    const { rerender } = render(<IssueList issues={issues} onSelect={onSelect} />)

    expect(screen.queryByRole('button', { name: '쪽지 쓰기' })).toBeNull()

    rerender(<IssueList issues={issues} onSelect={onSelect} onCompose={onCompose} />)
    expect(screen.getByRole('button', { name: '쪽지 쓰기' })).toBeTruthy()

    rerender(<IssueList issues={issues} onSelect={onSelect} />)
    expect(screen.queryByRole('button', { name: '쪽지 쓰기' })).toBeNull()
    expect(onCompose).not.toHaveBeenCalled()
  })

  it('빈 목록에서 쓸 수 있으면 첫 쪽지 안내와 쓰기 버튼만 있고 ul은 없다', () => {
    const onCompose = vi.fn()
    const { container } = render(<IssueList issues={[]} onSelect={vi.fn()} onCompose={onCompose} />)

    expect(screen.getByRole('heading', { name: '쪽지 0개' })).toBeTruthy()
    expect(screen.getByText('미해결 0개')).toBeTruthy()
    expect(screen.getByText('아직 쪽지가 없어요. 사진에서 고칠 곳을 눌러 첫 쪽지를 남겨 주세요.')).toBeTruthy()
    expect(screen.queryByRole('list')).toBeNull()
    expect(container.querySelector('ul')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '쪽지 쓰기' }))
    expect(onCompose).toHaveBeenCalledTimes(1)
  })

  it('빈 목록이 읽기 전용이면 빈 안내만 있고 쓰기 안내·버튼·ul은 없다', () => {
    const { container } = render(<IssueList issues={[]} onSelect={vi.fn()} />)

    expect(screen.getByRole('heading', { name: '쪽지 0개' })).toBeTruthy()
    expect(screen.getByText('미해결 0개')).toBeTruthy()
    expect(screen.getByText('아직 쪽지가 없어요.')).toBeTruthy()
    expect(screen.queryByText(/사진에서 고칠 곳을 눌러 첫 쪽지를 남겨 주세요/)).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('list')).toBeNull()
    expect(container.querySelector('ul')).toBeNull()
  })

  it('목록을 새로 받으면 개수·상태·댓글 수를 갱신하고 고른 쪽지를 유지한다', () => {
    const onSelect = vi.fn()
    const { rerender } = render(<IssueList issues={[draftIssue]} selectedId="draft-issue" onSelect={onSelect} />)

    rerender(
      <IssueList
        issues={[mobileIssue, { ...draftIssue, status: 'IN_PROGRESS', commentCount: 3 }]}
        selectedId="draft-issue"
        onSelect={onSelect}
      />,
    )

    expect(screen.getByRole('heading', { name: '쪽지 2개' })).toBeTruthy()
    expect(screen.getByText('미해결 2개')).toBeTruthy()
    const selected = screen.getByRole('button', { pressed: true })
    expect(within(selected).getByText('#14')).toBeTruthy()
    expect(within(selected).getByText('수정 중')).toBeTruthy()
    expect(within(selected).getByText('초안 · 상품 상세 · PC · 댓글 3개')).toBeTruthy()
    expect(screen.queryByText('초안 · 상품 상세 · PC · 댓글 2개')).toBeNull()
    expect(onSelect).not.toHaveBeenCalled()

    rerender(<IssueList issues={[]} selectedId="draft-issue" onSelect={onSelect} />)

    expect(screen.getByRole('heading', { name: '쪽지 0개' })).toBeTruthy()
    expect(screen.getByText('미해결 0개')).toBeTruthy()
    expect(screen.getByText('아직 쪽지가 없어요.')).toBeTruthy()
    expect(screen.queryByRole('list')).toBeNull()
  })

  it.each(['<script>alert(1)</script>', '<img src=x onerror=alert(1)>'])(
    '제목 %s는 글자 그대로 보이고 HTML 요소로 만들어지지 않는다',
    (title) => {
      const { container } = render(<IssueList issues={[{ ...draftIssue, title }]} onSelect={vi.fn()} />)

      expect(screen.getByText(title).textContent).toBe(title)
      expect(container.querySelector('script, img, [onerror]')).toBeNull()
    },
  )
})

describe('originLabel', () => {
  it.each([
    [0, 'PC', '초안 · 상품 상세 · PC'],
    [0, 'MOBILE', '초안 · 상품 상세 · 모바일'],
    [2, 'PC', '2차 · 상품 상세 · PC'],
    [2, 'MOBILE', '2차 · 상품 상세 · 모바일'],
  ] as const)('핀의 버전 %s·화면 %s를 %s로 보여 준다', (number, viewport, expected) => {
    expect(originLabel({ originVersion: { id: 'version', number }, origin: { ...origin, viewport } })).toBe(expected)
  })

  it.each([
    [0, '초안 · 위치 없음'],
    [2, '2차 · 위치 없음'],
  ])('핀이 없어도 버전 %s를 포함한 %s를 보여 준다', (number, expected) => {
    expect(originLabel({ originVersion: { id: 'version', number }, origin: null })).toBe(expected)
  })
})
