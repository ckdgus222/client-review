import { useState, type ComponentProps } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import type { IssuePin, IssueSummary } from '../api/issues.ts'
import { NO_FILTER, originLabel } from '../api/issues.ts'
import { IssueList } from './IssueList.tsx'

const StatefulIssueList = (props: Omit<ComponentProps<typeof IssueList>, 'filter' | 'onFilterChange'>) => {
  const [filter, setFilter] = useState(NO_FILTER)
  return <IssueList {...props} filter={filter} onFilterChange={setFilter} />
}

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
    render(<StatefulIssueList issues={[...items]} onSelect={vi.fn()} />)

    const list = within(screen.getByRole('region', { name: '쪽지 목록' }))
    expect(list.getByRole('heading', { name: `쪽지 ${count}개` })).toBeTruthy()
    expect(list.getByText(`미해결 ${count}개`)).toBeTruthy()
  })

  it('줄마다 번호·제목·상태·처음 위치·댓글 수를 보여 준다', () => {
    render(<StatefulIssueList issues={issues} onSelect={vi.fn()} />)

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
    render(<StatefulIssueList issues={received} onSelect={vi.fn()} />)

    const rows = screen.getAllByRole('listitem')
    expect(rows.map((row) => within(row).getByText(/^#\d+$/).textContent)).toEqual(['#14', '#16', '#15'])
    expect(received.map((issue) => issue.id)).toEqual(['draft-issue', 'mobile-issue', 'unpinned-issue'])
  })

  it.each([true, false])('쓰기 가능이 %s여도 각 줄을 누르면 그 쪽지 id만 onSelect에 보낸다', (writable) => {
    const onSelect = vi.fn()
    const onCompose = vi.fn()
    render(<StatefulIssueList issues={issues} onSelect={onSelect} onCompose={writable ? onCompose : undefined} />)

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
    const { rerender } = render(<StatefulIssueList issues={issues} selectedId="draft-issue" onSelect={onSelect} />)

    expect(screen.getAllByRole('button', { pressed: true })).toEqual([screen.getByRole('button', { name: /#14/ })])
    expect(screen.getAllByRole('button', { pressed: false })).toHaveLength(2)

    rerender(<StatefulIssueList issues={issues} selectedId="unpinned-issue" onSelect={onSelect} />)

    expect(screen.getAllByRole('button', { pressed: true })).toEqual([screen.getByRole('button', { name: /#15/ })])
    expect(screen.getAllByRole('button', { pressed: false })).toHaveLength(2)

    rerender(<StatefulIssueList issues={issues} onSelect={onSelect} />)

    expect(screen.queryByRole('button', { pressed: true })).toBeNull()
    expect(screen.getAllByRole('button', { pressed: false })).toHaveLength(3)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('목록에 없는 selectedId는 어느 줄도 선택하지 않는다', () => {
    render(<StatefulIssueList issues={issues} selectedId="missing-issue" onSelect={vi.fn()} />)

    expect(screen.queryByRole('button', { pressed: true })).toBeNull()
    expect(screen.getAllByRole('button', { pressed: false })).toHaveLength(3)
  })

  it('onCompose가 있으면 쪽지 쓰기를 누를 때 한 번 부르고 쪽지를 선택하지 않는다', () => {
    const onSelect = vi.fn()
    const onCompose = vi.fn()
    render(<StatefulIssueList issues={issues} onSelect={onSelect} onCompose={onCompose} />)

    expect(onCompose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '쪽지 쓰기' }))

    expect(onCompose).toHaveBeenCalledTimes(1)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('onCompose가 없으면 쪽지 쓰기 버튼이 없고 권한이 바뀌면 버튼도 바뀐다', () => {
    const onSelect = vi.fn()
    const onCompose = vi.fn()
    const { rerender } = render(<StatefulIssueList issues={issues} onSelect={onSelect} />)

    expect(screen.queryByRole('button', { name: '쪽지 쓰기' })).toBeNull()

    rerender(<StatefulIssueList issues={issues} onSelect={onSelect} onCompose={onCompose} />)
    expect(screen.getByRole('button', { name: '쪽지 쓰기' })).toBeTruthy()

    rerender(<StatefulIssueList issues={issues} onSelect={onSelect} />)
    expect(screen.queryByRole('button', { name: '쪽지 쓰기' })).toBeNull()
    expect(onCompose).not.toHaveBeenCalled()
  })

  it('빈 목록에서 쓸 수 있으면 첫 쪽지 안내와 쓰기 버튼만 있고 ul은 없다', () => {
    const onCompose = vi.fn()
    const { container } = render(<StatefulIssueList issues={[]} onSelect={vi.fn()} onCompose={onCompose} />)

    expect(screen.getByRole('heading', { name: '쪽지 0개' })).toBeTruthy()
    expect(screen.getByText('미해결 0개')).toBeTruthy()
    expect(screen.getByText('아직 쪽지가 없어요. 사진에서 고칠 곳을 눌러 첫 쪽지를 남겨 주세요.')).toBeTruthy()
    expect(screen.queryByRole('list')).toBeNull()
    expect(container.querySelector('ul')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '쪽지 쓰기' }))
    expect(onCompose).toHaveBeenCalledTimes(1)
  })

  it('빈 목록이 읽기 전용이면 빈 안내만 있고 쓰기 안내·버튼·ul은 없다', () => {
    const { container } = render(<StatefulIssueList issues={[]} onSelect={vi.fn()} />)

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
    const { rerender } = render(
      <StatefulIssueList issues={[draftIssue]} selectedId="draft-issue" onSelect={onSelect} />,
    )

    rerender(
      <StatefulIssueList
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

    rerender(<StatefulIssueList issues={[]} selectedId="draft-issue" onSelect={onSelect} />)

    expect(screen.getByRole('heading', { name: '쪽지 0개' })).toBeTruthy()
    expect(screen.getByText('미해결 0개')).toBeTruthy()
    expect(screen.getByText('아직 쪽지가 없어요.')).toBeTruthy()
    expect(screen.queryByRole('list')).toBeNull()
  })

  it.each(['<script>alert(1)</script>', '<img src=x onerror=alert(1)>'])(
    '제목 %s는 글자 그대로 보이고 HTML 요소로 만들어지지 않는다',
    (title) => {
      const { container } = render(<StatefulIssueList issues={[{ ...draftIssue, title }]} onSelect={vi.fn()} />)

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

describe('IssueList 쪽지 정리', () => {
  const triageIssues: IssueSummary[] = [
    { ...draftIssue, dueDate: '2026-11-11' },
    { ...unpinnedIssue, category: 'COPY', scope: 'OUT_OF_SCOPE', dueDate: '2026-11-12' },
    { ...mobileIssue, category: 'DESIGN', scope: 'OUT_OF_SCOPE', dueDate: '2026-11-11' },
    { ...draftIssue, id: 'other-issue', number: 17, title: '기타 의견', category: 'OTHER' },
  ]
  const selectFor = (label: string) => screen.getByRole<HTMLSelectElement>('combobox', { name: label })
  const shownNumbers = () => screen.queryAllByRole('listitem').map((row) => within(row).getByText(/^#\d+$/).textContent)

  beforeEach(() => {
    vi.useFakeTimers()
    // 실행하는 컴퓨터의 시간대로 오늘을 고정한다.
    vi.setSystemTime(new Date(2026, 10, 12, 12))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([
    ['BUG', '버그'],
    ['DESIGN', '디자인'],
    ['COPY', '문구'],
    ['OTHER', '기타'],
  ] as const)('분류 %s의 꼬리표 %s를 상태 아래에 보여 주고 처음 위치와 댓글 수를 유지한다', (category, label) => {
    render(<StatefulIssueList issues={[{ ...draftIssue, category }]} onSelect={vi.fn()} />)

    const row = within(screen.getByRole('listitem'))
    const status = row.getByText('접수')
    const tags = row.getByText(label)
    const location = row.getByText('초안 · 상품 상세 · PC · 댓글 2개')
    expect(status.nextElementSibling).toBe(tags)
    expect(tags.nextElementSibling).toBe(location)
    expect(row.queryByText(/하자 수정|추가 요청|마감/)).toBeNull()
  })

  it.each([
    ['IN_SCOPE', null, '버그'],
    ['OUT_OF_SCOPE', null, '버그 · 추가 요청'],
    ['IN_SCOPE', '2026-11-15', '버그 · 마감 11월 15일'],
    ['OUT_OF_SCOPE', '2026-11-15', '버그 · 추가 요청 · 마감 11월 15일'],
    ['OUT_OF_SCOPE', '2026-11-11', '버그 · 추가 요청 · 마감 11월 11일 · 마감 지남'],
    ['IN_SCOPE', '2027-01-05', '버그 · 마감 2027년 1월 5일'],
    ['IN_SCOPE', '2025-12-31', '버그 · 마감 2025년 12월 31일 · 마감 지남'],
  ] as const)('범위 %s와 마감일 %s의 꼬리표는 %s다', (scope, dueDate, expected) => {
    render(<StatefulIssueList issues={[{ ...draftIssue, scope, dueDate }]} onSelect={vi.fn()} />)

    const row = within(screen.getByRole('listitem'))
    expect(row.getByText('접수').nextElementSibling!.textContent).toBe(expected)
    expect(row.getByText('초안 · 상품 상세 · PC · 댓글 2개')).toBeTruthy()
  })

  it.each([
    ['OPEN', '2026-11-11', true],
    ['IN_PROGRESS', '2026-11-11', true],
    ['OPEN', '2026-11-12', false],
    ['IN_PROGRESS', '2026-11-12', false],
    ['OPEN', '2026-11-13', false],
    ['IN_PROGRESS', null, false],
    ['VERIFIED', '2026-11-11', false],
    ['WITHDRAWN', '2026-11-11', false],
  ] as const)('상태 %s, 마감일 %s일 때 마감 지남 표시는 %s다', (status, dueDate, overdue) => {
    // 끝난 상태는 6번에서 타입에 들어온다. 접수·수정 중에만 지남을 표시해야 한다.
    render(
      <StatefulIssueList
        issues={[{ ...draftIssue, status: status as IssueSummary['status'], dueDate }]}
        onSelect={vi.fn()}
      />,
    )

    expect(screen.getByRole('listitem').textContent!.includes(' · 마감 지남')).toBe(overdue)
  })

  it.each([
    ['상태', 'OPEN', ['#14', '#16', '#17']],
    ['상태', 'IN_PROGRESS', ['#15']],
    ['화면', 'product-screen', ['#14', '#17']],
    ['화면', 'mobile-screen', ['#16']],
    ['화면', 'none', ['#15']],
    ['분류', 'BUG', ['#14']],
    ['분류', 'DESIGN', ['#16']],
    ['분류', 'COPY', ['#15']],
    ['분류', 'OTHER', ['#17']],
    ['범위', 'IN_SCOPE', ['#14', '#17']],
    ['범위', 'OUT_OF_SCOPE', ['#15', '#16']],
  ] as const)('%s에서 %s를 고르면 맞는 줄만 받은 순서로 보이고 전체로 되돌릴 수 있다', (label, value, numbers) => {
    const onSelect = vi.fn()
    render(<StatefulIssueList issues={triageIssues} onSelect={onSelect} />)

    expect(screen.getByRole('heading', { name: '쪽지 4개' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '필터 지우기' })).toBeNull()
    fireEvent.change(selectFor(label), { target: { value } })

    expect(shownNumbers()).toEqual(numbers)
    expect(screen.getByRole('heading', { name: `쪽지 ${numbers.length}개 / 전체 4개` })).toBeTruthy()
    expect(screen.getByText('미해결 4개')).toBeTruthy()
    expect(screen.getByRole('button', { name: '필터 지우기' })).toBeTruthy()
    expect(selectFor(label).value).toBe(value)

    fireEvent.change(selectFor(label), { target: { value: '' } })

    expect(shownNumbers()).toEqual(['#14', '#15', '#16', '#17'])
    expect(screen.getByRole('heading', { name: '쪽지 4개' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '필터 지우기' })).toBeNull()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('마감 지남만을 고르면 어제 마감인 접수·수정 중만 남고 체크를 풀면 모두 돌아온다', () => {
    const items: IssueSummary[] = [
      ...triageIssues,
      { ...unpinnedIssue, id: 'overdue-progress', number: 18, dueDate: '2026-11-11' },
      { ...draftIssue, id: 'future', number: 19, dueDate: '2026-11-13' },
      { ...draftIssue, id: 'done', number: 20, status: 'VERIFIED' as IssueSummary['status'], dueDate: '2026-11-11' },
    ]
    render(<StatefulIssueList issues={items} onSelect={vi.fn()} />)
    const checkbox = screen.getByRole<HTMLInputElement>('checkbox', { name: '마감 지남만' })

    fireEvent.click(checkbox)

    expect(checkbox.checked).toBe(true)
    expect(shownNumbers()).toEqual(['#14', '#16', '#18'])
    expect(screen.getByRole('heading', { name: '쪽지 3개 / 전체 7개' })).toBeTruthy()
    expect(screen.getByText('미해결 6개')).toBeTruthy()
    expect(screen.getByRole('button', { name: '필터 지우기' })).toBeTruthy()

    fireEvent.click(checkbox)

    expect(checkbox.checked).toBe(false)
    expect(shownNumbers()).toEqual(['#14', '#15', '#16', '#17', '#18', '#19', '#20'])
    expect(screen.getByRole('heading', { name: '쪽지 7개' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '필터 지우기' })).toBeNull()
  })

  it('다섯 조건을 모두 만족하는 줄만 남기고 지우면 모든 입력과 목록을 되돌린다', () => {
    const match: IssueSummary = { ...draftIssue, scope: 'OUT_OF_SCOPE', dueDate: '2026-11-11' }
    const items: IssueSummary[] = [
      match,
      { ...match, id: 'different-status', number: 20, status: 'IN_PROGRESS' },
      { ...match, id: 'different-screen', number: 21, origin: mobileIssue.origin },
      { ...match, id: 'different-category', number: 22, category: 'DESIGN' },
      { ...match, id: 'different-scope', number: 23, scope: 'IN_SCOPE' },
      { ...match, id: 'different-date', number: 24, dueDate: '2026-11-12' },
    ]
    render(<StatefulIssueList issues={items} onSelect={vi.fn()} />)

    fireEvent.change(selectFor('상태'), { target: { value: 'OPEN' } })
    fireEvent.change(selectFor('화면'), { target: { value: 'product-screen' } })
    fireEvent.change(selectFor('분류'), { target: { value: 'BUG' } })
    fireEvent.change(selectFor('범위'), { target: { value: 'OUT_OF_SCOPE' } })
    fireEvent.click(screen.getByRole('checkbox', { name: '마감 지남만' }))

    expect(shownNumbers()).toEqual(['#14'])
    expect(screen.getByRole('heading', { name: '쪽지 1개 / 전체 6개' })).toBeTruthy()
    expect(screen.getByText('미해결 6개')).toBeTruthy()
    expect(screen.getByRole('button', { name: '필터 5' })).toBeTruthy()
    // 다른 조건으로 줄이 빠져도 화면 선택지는 전체 목록에서 만든다.
    expect(within(selectFor('화면')).getByRole('option', { name: '상품 상세 · 모바일' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '필터 지우기' }))

    expect(shownNumbers()).toEqual(['#14', '#20', '#21', '#22', '#23', '#24'])
    expect(screen.getAllByRole<HTMLSelectElement>('combobox').map((select) => select.value)).toEqual(['', '', '', ''])
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: '마감 지남만' }).checked).toBe(false)
    expect(screen.getByRole('heading', { name: '쪽지 6개' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '필터' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '필터 지우기' })).toBeNull()
  })

  it('맞는 쪽지가 없으면 빈 결과 안내와 전체 미해결 수를 보여 주고 지우면 제목과 모든 줄이 돌아온다', () => {
    render(<StatefulIssueList issues={triageIssues.slice(0, 3)} onSelect={vi.fn()} />)
    fireEvent.change(selectFor('분류'), { target: { value: 'DESIGN' } })
    expect(screen.getByRole('heading', { name: '쪽지 1개 / 전체 3개' })).toBeTruthy()

    fireEvent.change(selectFor('상태'), { target: { value: 'IN_PROGRESS' } })

    expect(screen.getByText('조건에 맞는 쪽지가 없어요')).toBeTruthy()
    expect(screen.getByRole('heading', { name: '쪽지 0개 / 전체 3개' })).toBeTruthy()
    expect(screen.getByText('미해결 3개')).toBeTruthy()
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.queryByText(/아직 쪽지가 없어요/)).toBeNull()
    expect(screen.getAllByRole('combobox')).toHaveLength(4)

    fireEvent.click(screen.getByRole('button', { name: '필터 지우기' }))

    expect(shownNumbers()).toEqual(['#14', '#15', '#16'])
    expect(screen.getByRole('heading', { name: '쪽지 3개' })).toBeTruthy()
    expect(screen.queryByText('조건에 맞는 쪽지가 없어요')).toBeNull()
    expect(screen.queryByRole('button', { name: '필터 지우기' })).toBeNull()
  })

  it('새 목록을 받으면 고른 조건을 유지하고 바뀐 쪽지와 새 쪽지에 다시 적용한다', () => {
    const onSelect = vi.fn()
    const { rerender } = render(<StatefulIssueList issues={triageIssues} onSelect={onSelect} />)
    fireEvent.change(selectFor('분류'), { target: { value: 'DESIGN' } })
    fireEvent.change(selectFor('범위'), { target: { value: 'OUT_OF_SCOPE' } })
    expect(shownNumbers()).toEqual(['#16'])

    const refreshed: IssueSummary[] = [
      { ...triageIssues[2], scope: 'IN_SCOPE' },
      { ...draftIssue, category: 'DESIGN', scope: 'OUT_OF_SCOPE' },
      { ...unpinnedIssue, id: 'new-issue', number: 18, category: 'DESIGN', scope: 'OUT_OF_SCOPE' },
    ]
    rerender(<StatefulIssueList issues={refreshed} onSelect={onSelect} />)

    expect(selectFor('분류').value).toBe('DESIGN')
    expect(selectFor('범위').value).toBe('OUT_OF_SCOPE')
    expect(shownNumbers()).toEqual(['#14', '#18'])
    expect(screen.getByRole('heading', { name: '쪽지 2개 / 전체 3개' })).toBeTruthy()
    expect(screen.getByText('미해결 3개')).toBeTruthy()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('고른 화면의 쪽지가 모두 사라져도 조건이 남고 그 화면이 다시 오면 같은 조건으로 보인다', () => {
    const onSelect = vi.fn()
    const { rerender } = render(<StatefulIssueList issues={triageIssues} onSelect={onSelect} />)
    fireEvent.change(selectFor('화면'), { target: { value: 'mobile-screen' } })

    rerender(<StatefulIssueList issues={[draftIssue, unpinnedIssue]} onSelect={onSelect} />)

    expect(screen.getByText('조건에 맞는 쪽지가 없어요')).toBeTruthy()
    expect(screen.getByRole('heading', { name: '쪽지 0개 / 전체 2개' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '필터 1' })).toBeTruthy()
    fireEvent.change(selectFor('분류'), { target: { value: 'DESIGN' } })
    expect(shownNumbers()).toEqual([])

    rerender(<StatefulIssueList issues={triageIssues} onSelect={onSelect} />)

    expect(selectFor('화면').value).toBe('mobile-screen')
    expect(selectFor('분류').value).toBe('DESIGN')
    expect(shownNumbers()).toEqual(['#16'])
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('쪽지를 열고 닫아도 필터가 남고 고른 쪽지가 조건에서 빠져도 다른 쪽지를 자동 선택하지 않는다', () => {
    const onSelect = vi.fn()
    const { rerender } = render(<StatefulIssueList issues={triageIssues} onSelect={onSelect} />)
    fireEvent.change(selectFor('분류'), { target: { value: 'DESIGN' } })
    fireEvent.click(screen.getByRole('button', { name: /#16/ }))
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('mobile-issue')

    rerender(<StatefulIssueList issues={triageIssues} selectedId="mobile-issue" onSelect={onSelect} />)
    expect(shownNumbers()).toEqual(['#16'])
    expect(screen.getByRole('button', { name: /#16/, pressed: true })).toBeTruthy()

    rerender(<StatefulIssueList issues={triageIssues} onSelect={onSelect} />)
    expect(selectFor('분류').value).toBe('DESIGN')
    expect(shownNumbers()).toEqual(['#16'])
    expect(screen.queryByRole('button', { pressed: true })).toBeNull()

    rerender(<StatefulIssueList issues={triageIssues} selectedId="mobile-issue" onSelect={onSelect} />)
    fireEvent.change(selectFor('분류'), { target: { value: 'COPY' } })
    expect(shownNumbers()).toEqual(['#15'])
    expect(screen.queryByRole('button', { pressed: true })).toBeNull()
    expect(onSelect).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: '필터 지우기' }))
    expect(screen.getByRole('button', { name: /#16/, pressed: true })).toBeTruthy()
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it.each([true, false])('쓰기 가능이 %s여도 쪽지가 있으면 필터가 있고 빈 목록에는 필터가 없다', (writable) => {
    const onCompose = writable ? vi.fn() : undefined
    const onSelect = vi.fn()
    const { rerender } = render(<StatefulIssueList issues={[]} onSelect={onSelect} onCompose={onCompose} />)

    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.queryByRole('button', { name: '필터' })).toBeNull()
    expect(
      screen.getByText(
        writable ? '아직 쪽지가 없어요. 사진에서 고칠 곳을 눌러 첫 쪽지를 남겨 주세요.' : '아직 쪽지가 없어요.',
      ),
    ).toBeTruthy()

    rerender(<StatefulIssueList issues={[draftIssue]} onSelect={onSelect} onCompose={onCompose} />)

    expect(screen.getAllByRole('combobox')).toHaveLength(4)
    expect(screen.getByRole('checkbox', { name: '마감 지남만' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '필터' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: '쪽지 1개' })).toBeTruthy()
  })

  it('목록을 새로 열면 이전에 고른 조건이 풀린다', () => {
    const { unmount } = render(<StatefulIssueList issues={triageIssues} onSelect={vi.fn()} />)
    fireEvent.change(selectFor('분류'), { target: { value: 'COPY' } })
    expect(shownNumbers()).toEqual(['#15'])
    unmount()

    render(<StatefulIssueList issues={triageIssues} onSelect={vi.fn()} />)

    expect(selectFor('분류').value).toBe('')
    expect(shownNumbers()).toEqual(['#14', '#15', '#16', '#17'])
    expect(screen.getByRole('heading', { name: '쪽지 4개' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '필터 지우기' })).toBeNull()
  })
})

describe('IssueList 필터 prop', () => {
  it('받은 filter대로 거르고 새 prop을 받으면 입력과 목록을 함께 바꾼다', () => {
    const onFilterChange = vi.fn()
    const onSelect = vi.fn()
    const { rerender } = render(
      <IssueList
        issues={issues}
        filter={{ ...NO_FILTER, status: 'IN_PROGRESS' }}
        onFilterChange={onFilterChange}
        onSelect={onSelect}
      />,
    )

    expect(screen.getByRole('heading', { name: '쪽지 1개 / 전체 3개' })).toBeTruthy()
    expect(screen.getAllByRole('listitem').map((row) => within(row).getByText(/^#\d+$/).textContent)).toEqual(['#15'])
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '상태' }).value).toBe('IN_PROGRESS')

    rerender(
      <IssueList
        issues={issues}
        filter={{ ...NO_FILTER, status: 'OPEN' }}
        onFilterChange={onFilterChange}
        onSelect={onSelect}
      />,
    )

    expect(screen.getByRole('heading', { name: '쪽지 2개 / 전체 3개' })).toBeTruthy()
    expect(screen.getAllByRole('listitem').map((row) => within(row).getByText(/^#\d+$/).textContent)).toEqual([
      '#16',
      '#14',
    ])
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '상태' }).value).toBe('OPEN')
    expect(onFilterChange).not.toHaveBeenCalled()
  })

  it.each([
    ['상태', 'status', 'OPEN'],
    ['화면', 'screenId', 'mobile-screen'],
    ['분류', 'category', 'DESIGN'],
    ['범위', 'scope', 'OUT_OF_SCOPE'],
    ['마감 지남만', 'overdueOnly', true],
  ] as const)('%s를 바꾸면 다음 조건을 알리지만 prop이 그대로면 입력과 줄도 그대로다', (label, field, value) => {
    const filter = { ...NO_FILTER, status: 'IN_PROGRESS' as const, category: 'BUG' as const }
    const onFilterChange = vi.fn()
    render(<IssueList issues={issues} filter={filter} onFilterChange={onFilterChange} onSelect={vi.fn()} />)

    if (field === 'overdueOnly') {
      fireEvent.click(screen.getByRole('checkbox', { name: label }))
    } else {
      fireEvent.change(screen.getByRole('combobox', { name: label }), { target: { value } })
    }

    expect(onFilterChange).toHaveBeenCalledExactlyOnceWith({ ...filter, [field]: value })
    expect(screen.getAllByRole<HTMLSelectElement>('combobox').map((select) => select.value)).toEqual([
      'IN_PROGRESS',
      '',
      'BUG',
      '',
    ])
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: '마감 지남만' }).checked).toBe(false)
    expect(screen.getByRole('heading', { name: '쪽지 1개 / 전체 3개' })).toBeTruthy()
    expect(screen.getAllByRole('listitem').map((row) => within(row).getByText(/^#\d+$/).textContent)).toEqual(['#15'])
  })

  it('필터 지우기는 NO_FILTER를 알리고 부모가 prop을 바꿀 때까지 기존 줄을 유지한다', () => {
    const filter = { ...NO_FILTER, status: 'IN_PROGRESS' as const }
    const onFilterChange = vi.fn()
    const onSelect = vi.fn()
    const { rerender } = render(
      <IssueList issues={issues} filter={filter} onFilterChange={onFilterChange} onSelect={onSelect} />,
    )

    fireEvent.click(screen.getByRole('button', { name: '필터 지우기' }))

    expect(onFilterChange).toHaveBeenCalledExactlyOnceWith(NO_FILTER)
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '상태' }).value).toBe('IN_PROGRESS')
    expect(screen.getByRole('heading', { name: '쪽지 1개 / 전체 3개' })).toBeTruthy()
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    expect(within(screen.getByRole('listitem')).getByText(unpinnedIssue.title)).toBeTruthy()

    rerender(<IssueList issues={issues} filter={NO_FILTER} onFilterChange={onFilterChange} onSelect={onSelect} />)

    expect(screen.getByRole('heading', { name: '쪽지 3개' })).toBeTruthy()
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
    expect(screen.queryByRole('button', { name: '필터 지우기' })).toBeNull()
    expect(onFilterChange).toHaveBeenCalledTimes(1)
  })
})
