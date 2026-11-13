import { fireEvent, render, screen, within } from '@testing-library/react'
import { NO_FILTER, NO_PLACE, type IssueFilter, type IssuePin, type IssueSummary } from '../api/issues.ts'
import { IssueFilters } from './IssueFilters.tsx'

const origin: IssuePin = {
  screenId: 'product-pc',
  screenName: '상품 상세',
  viewport: 'PC',
  asset: { id: 'product-photo', width: 1440, height: 900 },
  xRatio: 0.25,
  yRatio: 0.5,
}
const issue: IssueSummary = {
  id: 'product-issue',
  number: 3,
  title: '상품 사진을 크게 보여 주세요',
  status: 'OPEN',
  category: 'BUG',
  scope: 'IN_SCOPE',
  dueDate: null,
  authorName: '클라이언트',
  createdAt: '2026-11-10T00:00:00.000Z',
  commentCount: 0,
  originVersion: { id: 'draft-version', number: 0 },
  origin,
}
const mobileIssue: IssueSummary = {
  ...issue,
  id: 'mobile-issue',
  origin: { ...origin, screenId: 'product-mobile', viewport: 'MOBILE' },
}
const issues: IssueSummary[] = [
  issue,
  { ...issue, id: 'no-place', origin: null },
  mobileIssue,
  { ...issue, id: 'same-screen', originVersion: { id: 'second-version', number: 2 } },
]
const activeFilter: IssueFilter = {
  status: 'IN_PROGRESS',
  screenId: 'product-pc',
  category: 'DESIGN',
  scope: 'OUT_OF_SCOPE',
  overdueOnly: true,
}

const selectFor = (label: string) => screen.getByRole('combobox', { name: label }) as HTMLSelectElement
const overdueCheckbox = () => screen.getByRole('checkbox', { name: '마감 지남만' }) as HTMLInputElement

// jsdom은 반응형 CSS를 적용하지 않는다. 실제 768px 경계와 보임 여부는 조각 11의 브라우저 e2e에서 확인한다.
describe('IssueFilters', () => {
  it('상태·화면·분류·범위 순서와 각 선택지의 글자를 보여 주고 처음에는 전체다', () => {
    render(<IssueFilters issues={issues} filter={NO_FILTER} onChange={vi.fn()} />)

    expect(screen.getAllByRole('combobox')).toEqual([
      selectFor('상태'),
      selectFor('화면'),
      selectFor('분류'),
      selectFor('범위'),
    ])
    expect(
      within(selectFor('상태'))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['전체', '접수', '수정 중', '확인 요청', '확인 완료', '철회'])
    expect(
      within(selectFor('화면'))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['전체', '상품 상세 · PC', '상품 상세 · 모바일', '위치 없음'])
    expect(
      within(selectFor('분류'))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['전체', '버그', '디자인', '문구', '기타'])
    expect(
      within(selectFor('범위'))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['전체', '하자 수정', '추가 요청'])
    expect(screen.getAllByRole('combobox').map((select) => (select as HTMLSelectElement).value)).toEqual([
      '',
      '',
      '',
      '',
    ])
    expect(overdueCheckbox().checked).toBe(false)
  })

  it('같은 화면은 버전이 달라도 한 번만 넣고 이름이 같아도 id가 다른 화면은 따로 넣는다', () => {
    const sameName: IssueSummary = { ...issue, id: 'same-name', origin: { ...origin, screenId: 'other-pc' } }
    render(<IssueFilters issues={[...issues, sameName]} filter={NO_FILTER} onChange={vi.fn()} />)

    const options = within(selectFor('화면')).getAllByRole('option') as HTMLOptionElement[]
    expect(options.map((option) => option.value)).toEqual(['', 'product-pc', 'product-mobile', 'other-pc', NO_PLACE])
    expect(within(selectFor('화면')).getAllByRole('option', { name: '상품 상세 · PC' })).toHaveLength(2)
  })

  it.each([
    { name: '빈 목록', items: [] },
    { name: '위치 없는 쪽지만 있는 목록', items: [{ ...issue, origin: null }] },
    { name: '위치 있는 쪽지만 있는 목록', items: [issue] },
  ])('$name에서도 위치 없음은 늘 있고 목록에 없는 화면은 선택지에 없다', ({ items }) => {
    render(<IssueFilters issues={items} filter={NO_FILTER} onChange={vi.fn()} />)

    const options = within(selectFor('화면')).getAllByRole('option') as HTMLOptionElement[]
    expect(options.map((option) => option.value)).toEqual(
      items.some((item) => item.origin) ? ['', 'product-pc', NO_PLACE] : ['', NO_PLACE],
    )
    expect(within(selectFor('화면')).getByRole('option', { name: '위치 없음' }).getAttribute('value')).toBe(NO_PLACE)
  })

  it.each([
    { label: '상태', field: 'status', value: 'OPEN' },
    { label: '상태', field: 'status', value: 'IN_PROGRESS' },
    { label: '화면', field: 'screenId', value: 'product-pc' },
    { label: '화면', field: 'screenId', value: 'product-mobile' },
    { label: '화면', field: 'screenId', value: NO_PLACE },
    { label: '분류', field: 'category', value: 'BUG' },
    { label: '분류', field: 'category', value: 'DESIGN' },
    { label: '분류', field: 'category', value: 'COPY' },
    { label: '분류', field: 'category', value: 'OTHER' },
    { label: '범위', field: 'scope', value: 'IN_SCOPE' },
    { label: '범위', field: 'scope', value: 'OUT_OF_SCOPE' },
  ] as const)('$label에서 $value를 고르면 그 조건만 바꾼 전체 조건을 보낸다', ({ label, field, value }) => {
    const filter: IssueFilter = { ...activeFilter, [field]: '' }
    const before = { ...filter }
    const onChange = vi.fn()
    render(<IssueFilters issues={issues} filter={filter} onChange={onChange} />)

    fireEvent.change(selectFor(label), { target: { value } })

    expect(onChange).toHaveBeenCalledExactlyOnceWith({ ...before, [field]: value })
    expect(filter).toEqual(before)
    // 부모가 새 조건을 보내기 전에는 이 부품이 고른 값을 자체 저장하지 않는다.
    expect(selectFor(label).value).toBe('')
  })

  it.each([
    { label: '상태', field: 'status' },
    { label: '화면', field: 'screenId' },
    { label: '분류', field: 'category' },
    { label: '범위', field: 'scope' },
  ] as const)('$label을 전체로 되돌리면 해당 조건만 빈 값으로 보낸다', ({ label, field }) => {
    const onChange = vi.fn()
    render(<IssueFilters issues={issues} filter={activeFilter} onChange={onChange} />)

    fireEvent.change(selectFor(label), { target: { value: '' } })

    expect(onChange).toHaveBeenCalledExactlyOnceWith({ ...activeFilter, [field]: '' })
  })

  it('위치 없음을 전체로 되돌리면 화면 조건을 빈 값으로 보낸다', () => {
    const onChange = vi.fn()
    render(<IssueFilters issues={issues} filter={{ ...NO_FILTER, screenId: NO_PLACE }} onChange={onChange} />)

    fireEvent.change(selectFor('화면'), { target: { value: '' } })

    expect(onChange).toHaveBeenCalledExactlyOnceWith(NO_FILTER)
  })

  it.each([false, true])('마감 지남만이 %s일 때 누르면 그 조건만 반대로 보낸다', (overdueOnly) => {
    const filter = { ...activeFilter, overdueOnly }
    const onChange = vi.fn()
    render(<IssueFilters issues={issues} filter={filter} onChange={onChange} />)

    fireEvent.click(overdueCheckbox())

    expect(onChange).toHaveBeenCalledExactlyOnceWith({ ...activeFilter, overdueOnly: !overdueOnly })
    expect(filter.overdueOnly).toBe(overdueOnly)
    expect(overdueCheckbox().checked).toBe(overdueOnly)
  })

  it('부모가 보낸 filter대로 선택과 체크가 바뀌고 전체로 초기화할 수 있다', () => {
    const onChange = vi.fn()
    const { rerender } = render(<IssueFilters issues={issues} filter={NO_FILTER} onChange={onChange} />)

    rerender(<IssueFilters issues={issues} filter={activeFilter} onChange={onChange} />)

    expect(selectFor('상태').value).toBe('IN_PROGRESS')
    expect(selectFor('화면').value).toBe('product-pc')
    expect(selectFor('분류').value).toBe('DESIGN')
    expect(selectFor('범위').value).toBe('OUT_OF_SCOPE')
    expect(overdueCheckbox().checked).toBe(true)

    rerender(<IssueFilters issues={issues} filter={NO_FILTER} onChange={onChange} />)

    expect(screen.getAllByRole('combobox').map((select) => (select as HTMLSelectElement).value)).toEqual([
      '',
      '',
      '',
      '',
    ])
    expect(overdueCheckbox().checked).toBe(false)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('접힌 버튼에도 고른 조건 수가 보이고 부모가 조건을 지우면 필터로 돌아간다', () => {
    const onChange = vi.fn()
    const { rerender } = render(<IssueFilters issues={issues} filter={NO_FILTER} onChange={onChange} />)

    expect(screen.getByRole('button', { name: '필터', expanded: false })).toBeTruthy()
    rerender(
      <IssueFilters
        issues={issues}
        filter={{ ...NO_FILTER, screenId: NO_PLACE, overdueOnly: true }}
        onChange={onChange}
      />,
    )
    expect(screen.getByRole('button', { name: '필터 2', expanded: false })).toBeTruthy()

    rerender(<IssueFilters issues={issues} filter={activeFilter} onChange={onChange} />)
    expect(screen.getByRole('button', { name: '필터 5', expanded: false })).toBeTruthy()

    rerender(<IssueFilters issues={issues} filter={NO_FILTER} onChange={onChange} />)
    expect(screen.getByRole('button', { name: '필터', expanded: false })).toBeTruthy()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('버튼으로 펴고 접으면 aria-expanded와 연결된 조건 영역의 data-expanded가 함께 바뀐다', () => {
    const onChange = vi.fn()
    render(<IssueFilters issues={issues} filter={activeFilter} onChange={onChange} />)
    const button = screen.getByRole('button', { name: '필터 5', expanded: false })
    const fieldsId = button.getAttribute('aria-controls')
    expect(fieldsId).toBeTruthy()
    const fields = document.getElementById(fieldsId!)!
    expect(fields).toBeTruthy()
    expect(fields.contains(selectFor('상태'))).toBe(true)
    expect(fields.getAttribute('data-expanded')).toBe('false')

    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(fields.getAttribute('data-expanded')).toBe('true')

    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(fields.getAttribute('data-expanded')).toBe('false')
    expect(selectFor('상태').value).toBe('IN_PROGRESS')
    expect(selectFor('화면').value).toBe('product-pc')
    expect(selectFor('분류').value).toBe('DESIGN')
    expect(selectFor('범위').value).toBe('OUT_OF_SCOPE')
    expect(overdueCheckbox().checked).toBe(true)
    expect(onChange).not.toHaveBeenCalled()

    fireEvent.click(button)
    fireEvent.change(selectFor('분류'), { target: { value: 'COPY' } })
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ ...activeFilter, category: 'COPY' })
  })

  it('목록을 새로 받아도 조건은 남고 화면 선택지만 새 목록에 맞게 바뀐다', () => {
    const onChange = vi.fn()
    const { rerender } = render(<IssueFilters issues={issues} filter={activeFilter} onChange={onChange} />)
    const newIssue: IssueSummary = {
      ...issue,
      id: 'new',
      origin: { ...origin, screenId: 'new-screen', screenName: '결제' },
    }

    rerender(<IssueFilters issues={[issue, newIssue]} filter={activeFilter} onChange={onChange} />)

    expect(
      within(selectFor('화면'))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['전체', '상품 상세 · PC', '결제 · PC', '위치 없음'])
    expect(selectFor('화면').value).toBe('product-pc')
    expect(selectFor('상태').value).toBe('IN_PROGRESS')
    expect(selectFor('분류').value).toBe('DESIGN')
    expect(selectFor('범위').value).toBe('OUT_OF_SCOPE')
    expect(overdueCheckbox().checked).toBe(true)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('고른 화면의 쪽지가 모두 사라져도 조건을 지우지 않고 다른 조건을 바꿀 때 그 화면 id를 유지한다', () => {
    const onChange = vi.fn()
    const { rerender } = render(<IssueFilters issues={issues} filter={activeFilter} onChange={onChange} />)

    rerender(<IssueFilters issues={[]} filter={activeFilter} onChange={onChange} />)

    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '필터 5' })).toBeTruthy()
    fireEvent.change(selectFor('분류'), { target: { value: 'COPY' } })
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ ...activeFilter, category: 'COPY' })

    rerender(<IssueFilters issues={issues} filter={activeFilter} onChange={onChange} />)
    expect(selectFor('화면').value).toBe('product-pc')
    expect(onChange).toHaveBeenCalledTimes(1)
  })
})
