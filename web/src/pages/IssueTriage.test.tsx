import { act, fireEvent, render, screen, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { MemoryRouter } from 'react-router'
import { ApiError } from '../api/client.ts'
import { type IssueDetail as Issue, updateIssue } from '../api/issues.ts'
import { IssueTriage } from './IssueTriage.tsx'

vi.mock('../api/issues.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/issues.ts')>()),
  updateIssue: vi.fn(),
}))

const versionId = '22222222-2222-4222-8222-222222222222'
const latestVersionId = '33333333-3333-4333-8333-333333333333'
const issue: Issue = {
  projectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  canReview: false,
  attempts: [],
  id: '11111111-1111-4111-8111-111111111111',
  number: 14,
  status: 'OPEN',
  category: 'BUG',
  scope: 'IN_SCOPE',
  dueDate: '2026-11-15',
  title: '버튼을 옮겨 주세요',
  body: '오른쪽으로 옮겨 주세요',
  authorName: '쪽지 작성자',
  createdAt: '2026-11-10T00:00:00.000Z',
  commentCount: 0,
  originVersion: { id: versionId, number: 1 },
  origin: null,
  isMine: false,
  attachments: [],
  comments: [],
}
const savedComment = {
  id: 'comment-1',
  authorName: '개발자',
  versionNumber: 1,
  body: '범위: 하자 수정 → 추가 요청',
  createdAt: '2026-11-12T00:00:00.000Z',
}
const unconfirmedMessage = '저장됐는지 확인하지 못했어요. 쪽지에 바뀐 값이 보이지 않으면 다시 눌러 주세요.'

const renderTriage = (overrides: Partial<ComponentProps<typeof IssueTriage>> = {}) => {
  const props = {
    issue,
    versionId,
    canWrite: true,
    isDeveloper: true,
    fetchCount: 3,
    onChanged: vi.fn(),
    onRefresh: vi.fn(),
    onGoLatest: vi.fn(),
    ...overrides,
  }
  return { ...render(<IssueTriage {...props} />, { wrapper: MemoryRouter }), props }
}

const categoryInput = () => screen.getByRole<HTMLSelectElement>('combobox', { name: '분류' })
const scopeInput = () => screen.getByRole<HTMLSelectElement>('combobox', { name: '범위' })
const dueDateInput = () => screen.getByLabelText<HTMLInputElement>('마감일')
const button = (name: string) => screen.getByRole<HTMLButtonElement>('button', { name })
const fillDate = (value = '2026-11-20') => {
  fireEvent.change(dueDateInput(), { target: { value } })
}
const select = async (name: string, value: string) => {
  await act(async () => {
    fireEvent.change(screen.getByRole('combobox', { name }), { target: { value } })
  })
}
const click = async (name: string) => {
  await act(async () => {
    fireEvent.click(button(name))
  })
}
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

const actions = [
  { name: '분류', change: { category: 'DESIGN' }, run: () => select('분류', 'DESIGN') },
  { name: '범위', change: { scope: 'OUT_OF_SCOPE' }, run: () => select('범위', 'OUT_OF_SCOPE') },
  { name: '마감일 저장', change: { dueDate: '2026-11-20' }, run: () => click('마감일 저장') },
  { name: '마감일 지우기', change: { dueDate: null }, run: () => click('마감일 지우기') },
] as const

beforeEach(() => {
  vi.mocked(updateIssue).mockReset().mockResolvedValue(issue)
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('IssueTriage', () => {
  it.each([false, true])('개발자는 isMine=%s여도 분류·범위·마감일 입력이 모두 보인다', (isMine) => {
    renderTriage({ issue: { ...issue, isMine } })
    const region = within(screen.getByRole('region', { name: '쪽지 정리' }))

    expect(region.getByRole('combobox', { name: '분류' })).toBe(categoryInput())
    expect(region.getByRole('combobox', { name: '범위' })).toBe(scopeInput())
    expect(region.getByLabelText('마감일')).toBe(dueDateInput())
    expect(dueDateInput().type).toBe('date')
    expect(categoryInput().disabled).toBe(false)
    expect(scopeInput().disabled).toBe(false)
    expect(dueDateInput().disabled).toBe(false)
    expect(region.getByRole('button', { name: '마감일 저장' })).toBeTruthy()
    expect(region.getByRole('button', { name: '마감일 지우기' })).toBeTruthy()
    expect(updateIssue).not.toHaveBeenCalled()
  })

  it('쓴 클라이언트에게는 분류만 보이고 바꿀 수 있다', async () => {
    const saved: Issue = { ...issue, isMine: true, category: 'COPY' }
    vi.mocked(updateIssue).mockResolvedValueOnce(saved)
    const { props } = renderTriage({ isDeveloper: false, issue: { ...issue, isMine: true } })

    expect(categoryInput().disabled).toBe(false)
    expect(screen.queryByRole('combobox', { name: '범위' })).toBeNull()
    expect(screen.queryByLabelText('마감일')).toBeNull()
    expect(screen.queryByRole('button', { name: '마감일 저장' })).toBeNull()
    expect(screen.queryByRole('button', { name: '마감일 지우기' })).toBeNull()
    await select('분류', 'COPY')
    expect(updateIssue).toHaveBeenCalledExactlyOnceWith(issue.id, versionId, { category: 'COPY' })
    expect(props.onChanged).toHaveBeenCalledExactlyOnceWith(saved)
    expect(window.confirm).not.toHaveBeenCalled()
  })

  it('남의 쪽지를 보는 클라이언트에게는 정리 입력이 없다', () => {
    renderTriage({ isDeveloper: false })

    expect(screen.queryByRole('region', { name: '쪽지 정리' })).toBeNull()
    expect(screen.queryAllByRole('combobox')).toHaveLength(0)
    expect(screen.queryByLabelText('마감일')).toBeNull()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(updateIssue).not.toHaveBeenCalled()
  })

  it.each([
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ])('canWrite=false이면 개발자=%s·쓴 사람=%s여도 입력이 없다', (isDeveloper, isMine) => {
    renderTriage({ canWrite: false, isDeveloper, issue: { ...issue, isMine } })

    expect(screen.queryAllByRole('combobox')).toHaveLength(0)
    expect(screen.queryByLabelText('마감일')).toBeNull()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(updateIssue).not.toHaveBeenCalled()
  })

  it('분류와 범위 선택지에 기획의 글자가 보이고 지금 값을 선택한다', () => {
    renderTriage({ issue: { ...issue, category: 'COPY', scope: 'OUT_OF_SCOPE' } })

    expect(Array.from(categoryInput().options, (option) => [option.value, option.textContent])).toEqual([
      ['BUG', '버그'],
      ['DESIGN', '디자인'],
      ['COPY', '문구'],
      ['OTHER', '기타'],
    ])
    expect(Array.from(scopeInput().options, (option) => [option.value, option.textContent])).toEqual([
      ['IN_SCOPE', '하자 수정'],
      ['OUT_OF_SCOPE', '추가 요청'],
    ])
    expect(categoryInput().value).toBe('COPY')
    expect(scopeInput().value).toBe('OUT_OF_SCOPE')
  })

  it.each(['BUG', 'DESIGN', 'COPY', 'OTHER'] as const)(
    '분류 %s를 고르면 확인 창 없이 그 칸만 바로 보낸다',
    async (category) => {
      const saved = { ...issue, category }
      vi.mocked(updateIssue).mockResolvedValueOnce(saved)
      const { props, rerender } = renderTriage({ issue: { ...issue, category: category === 'BUG' ? 'OTHER' : 'BUG' } })
      fillDate()

      await select('분류', category)

      expect(window.confirm).not.toHaveBeenCalled()
      expect(updateIssue).toHaveBeenCalledExactlyOnceWith(issue.id, versionId, { category })
      expect(props.onChanged).toHaveBeenCalledExactlyOnceWith(saved)
      expect(props.onRefresh).not.toHaveBeenCalled()
      rerender(<IssueTriage {...props} issue={saved} />)
      expect(categoryInput().value).toBe(category)
      expect(dueDateInput().value).toBe('2026-11-20')
    },
  )

  it.each([
    ['IN_SCOPE', 'OUT_OF_SCOPE', '추가 요청'],
    ['OUT_OF_SCOPE', 'IN_SCOPE', '하자 수정'],
  ] as const)('범위 %s에서 %s로 바꾸면 확인 후 범위만 보내고 댓글이 든 상세를 넘긴다', async (before, scope, label) => {
    const saved = { ...issue, scope, comments: [savedComment], commentCount: 1 }
    vi.mocked(updateIssue).mockResolvedValueOnce(saved)
    vi.mocked(window.confirm).mockImplementationOnce((message) => {
      expect(message).toBe(`범위를 '${label}'으로 바꿀까요? 바꾼 기록이 댓글로 남아요.`)
      expect(updateIssue).not.toHaveBeenCalled()
      return true
    })
    const { props, rerender } = renderTriage({ issue: { ...issue, scope: before } })
    fillDate()

    await select('범위', scope)

    expect(window.confirm).toHaveBeenCalledTimes(1)
    expect(updateIssue).toHaveBeenCalledExactlyOnceWith(issue.id, versionId, { scope })
    expect(props.onChanged).toHaveBeenCalledExactlyOnceWith(saved)
    rerender(<IssueTriage {...props} issue={saved} />)
    expect(scopeInput().value).toBe(scope)
    expect(dueDateInput().value).toBe('2026-11-20')
  })

  it.each([
    ['IN_SCOPE', 'OUT_OF_SCOPE'],
    ['OUT_OF_SCOPE', 'IN_SCOPE'],
  ] as const)('범위 %s에서 %s로 바꾸는 확인 창에서 취소하면 보내지 않고 원래 값이다', async (before, scope) => {
    vi.mocked(window.confirm).mockReturnValueOnce(false)
    const { props } = renderTriage({ issue: { ...issue, scope: before } })
    fillDate()

    await select('범위', scope)

    expect(window.confirm).toHaveBeenCalledTimes(1)
    expect(updateIssue).not.toHaveBeenCalled()
    expect(props.onChanged).not.toHaveBeenCalled()
    expect(props.onRefresh).not.toHaveBeenCalled()
    expect(scopeInput().value).toBe(before)
    expect(scopeInput().disabled).toBe(false)
    expect(dueDateInput().value).toBe('2026-11-20')
  })

  it.each([null, '2026-11-15'])(
    '처음 날짜는 지금 마감일 %s이고 빈 칸이나 같은 날짜는 저장할 수 없다',
    async (dueDate) => {
      renderTriage({ issue: { ...issue, dueDate } })

      expect(dueDateInput().value).toBe(dueDate ?? '')
      expect(button('마감일 저장').disabled).toBe(true)
      expect(screen.queryByRole('button', { name: '마감일 지우기' }) !== null).toBe(dueDate !== null)
      await click('마감일 저장')
      fillDate()
      expect(button('마감일 저장').disabled).toBe(false)
      fillDate('')
      expect(dueDateInput().value).toBe('')
      expect(button('마감일 저장').disabled).toBe(true)
      await click('마감일 저장')
      fillDate(dueDate ?? '')
      expect(button('마감일 저장').disabled).toBe(true)
      await click('마감일 저장')
      expect(updateIssue).not.toHaveBeenCalled()
    },
  )

  it.each(['2026-11-20', '2000-02-29'])(
    '날짜 %s는 입력만으로 보내지 않고 저장을 눌러 글자 그대로 보낸다',
    async (dueDate) => {
      const saved = { ...issue, dueDate }
      vi.mocked(updateIssue).mockResolvedValueOnce(saved)
      const { props, rerender } = renderTriage({ issue: { ...issue, dueDate: null } })

      fillDate(dueDate)
      expect(updateIssue).not.toHaveBeenCalled()
      expect(dueDateInput().validity.valid).toBe(true)
      expect(button('마감일 저장').disabled).toBe(false)
      await click('마감일 저장')

      expect(updateIssue).toHaveBeenCalledExactlyOnceWith(issue.id, versionId, { dueDate })
      expect(props.onChanged).toHaveBeenCalledExactlyOnceWith(saved)
      expect(window.confirm).not.toHaveBeenCalled()
      rerender(<IssueTriage {...props} issue={saved} />)
      expect(dueDateInput().value).toBe(dueDate)
      expect(button('마감일 저장').disabled).toBe(true)
      expect(button('마감일 지우기').disabled).toBe(false)
      rerender(<IssueTriage {...props} issue={{ ...saved, dueDate: '2026-12-01' }} />)
      expect(dueDateInput().value).toBe('2026-12-01')
    },
  )

  it('마감일 지우기는 null만 보내고 성공하면 치던 날짜도 비워 서버 값을 따른다', async () => {
    const saved = { ...issue, dueDate: null, comments: [savedComment], commentCount: 1 }
    vi.mocked(updateIssue).mockResolvedValueOnce(saved)
    const { props, rerender } = renderTriage()
    fillDate()

    await click('마감일 지우기')

    expect(updateIssue).toHaveBeenCalledExactlyOnceWith(issue.id, versionId, { dueDate: null })
    expect(props.onChanged).toHaveBeenCalledExactlyOnceWith(saved)
    expect(window.confirm).not.toHaveBeenCalled()
    rerender(<IssueTriage {...props} issue={saved} />)
    expect(dueDateInput().value).toBe('')
    expect(button('마감일 저장').disabled).toBe(true)
    expect(screen.queryByRole('button', { name: '마감일 지우기' })).toBeNull()
  })

  it.each(actions)('$name 응답을 기다리는 동안 모든 입력을 잠그고 고른 값을 보여 준다', async ({ change, run }) => {
    const pending = deferred<Issue>()
    vi.mocked(updateIssue).mockReturnValueOnce(pending.promise)
    const { props } = renderTriage()
    fillDate()

    await run()

    expect(updateIssue).toHaveBeenCalledExactlyOnceWith(issue.id, versionId, change)
    expect(categoryInput().value).toBe('category' in change ? change.category : issue.category)
    expect(scopeInput().value).toBe('scope' in change ? change.scope : issue.scope)
    expect(categoryInput().disabled).toBe(true)
    expect(scopeInput().disabled).toBe(true)
    expect(dueDateInput().disabled).toBe(true)
    expect(button('마감일 저장').disabled).toBe(true)
    expect(button('마감일 지우기').disabled).toBe(true)
    await click('마감일 저장')
    await click('마감일 지우기')
    expect(updateIssue).toHaveBeenCalledTimes(1)
    expect(props.onChanged).not.toHaveBeenCalled()

    const saved = { ...issue, ...change }
    await act(async () => pending.resolve(saved))

    expect(props.onChanged).toHaveBeenCalledExactlyOnceWith(saved)
    expect(categoryInput().disabled).toBe(false)
    expect(scopeInput().disabled).toBe(false)
    expect(dueDateInput().disabled).toBe(false)
    expect(button('마감일 지우기').disabled).toBe(false)
  })

  it.each([
    [409, 'VERSION_CHANGED', '새 버전이 올라왔어요. 쓰던 글은 그대로 남아 있어요.'],
    [409, 'VERSION_NOT_IN_REVIEW', '승인된 버전이라 더 쓸 수 없어요.'],
    [401, undefined, '로그인이 끝났어요. 다른 탭에서 로그인한 뒤 다시 눌러 주세요'],
    [403, undefined, '잠시 뒤 다시 시도해 주세요'],
    [404, undefined, '찾을 수 없어요. 화면을 새로 고쳐 주세요'],
    [422, undefined, '입력한 내용을 확인해 주세요'],
  ] as const)('%s %s 실패는 공통 문구를 보이고 분류를 되돌리며 치던 날짜는 남는다', async (status, code, message) => {
    vi.mocked(updateIssue).mockRejectedValueOnce(new ApiError(status, code))
    const { props } = renderTriage()
    fillDate()

    await select('분류', 'DESIGN')

    expect(screen.getByRole('alert').textContent).toContain(message)
    expect(categoryInput().value).toBe(issue.category)
    expect(categoryInput().disabled).toBe(false)
    expect(scopeInput().disabled).toBe(false)
    expect(dueDateInput().disabled).toBe(false)
    expect(dueDateInput().value).toBe('2026-11-20')
    expect(button('마감일 저장').disabled).toBe(false)
    expect(props.onChanged).not.toHaveBeenCalled()
    expect(props.onRefresh).not.toHaveBeenCalled()
    expect(screen.queryByText(unconfirmedMessage)).toBeNull()
    if (status === 401) {
      const login = screen.getByRole('link', { name: '새 탭에서 로그인하기' })
      expect(login.getAttribute('href')).toBe('/login')
      expect(login.getAttribute('target')).toBe('_blank')
    }
    if (code === 'VERSION_CHANGED') {
      await click('최신 버전 보기')
      expect(props.onGoLatest).toHaveBeenCalledTimes(1)
      return
    }
    expect(screen.queryByRole('button', { name: '최신 버전 보기' })).toBeNull()
  })

  it.each(actions)('$name 저장 실패 뒤에는 지금 서버 값으로 돌아가고 치던 날짜는 남는다', async ({ run }) => {
    const pending = deferred<Issue>()
    vi.mocked(updateIssue).mockReturnValueOnce(pending.promise)
    const { props, rerender } = renderTriage()
    fillDate()
    await run()
    const refreshed: Issue = { ...issue, category: 'COPY', scope: 'OUT_OF_SCOPE', dueDate: '2026-12-01' }
    rerender(<IssueTriage {...props} issue={refreshed} fetchCount={4} />)

    await act(async () => pending.reject(new ApiError(422)))

    expect(categoryInput().value).toBe(refreshed.category)
    expect(scopeInput().value).toBe(refreshed.scope)
    expect(dueDateInput().value).toBe('2026-11-20')
    expect(button('마감일 저장').disabled).toBe(false)
    expect(button('마감일 지우기').disabled).toBe(false)
    expect(props.onChanged).not.toHaveBeenCalled()
  })

  it.each([
    ['연결 실패', new TypeError('Failed to fetch')],
    ['500', new ApiError(500)],
    ['503', new ApiError(503)],
  ])('%s 뒤에는 전용 안내와 새로 불러오기 한 번만 요청하고 입력을 잠그지 않는다', async (_name, error) => {
    vi.mocked(updateIssue).mockRejectedValueOnce(error)
    const { props, rerender } = renderTriage()
    fillDate()

    await select('범위', 'OUT_OF_SCOPE')

    expect(screen.getByRole('alert').textContent).toBe(unconfirmedMessage)
    expect(props.onRefresh).toHaveBeenCalledExactlyOnceWith()
    expect(props.onChanged).not.toHaveBeenCalled()
    expect(scopeInput().value).toBe(issue.scope)
    expect(categoryInput().disabled).toBe(false)
    expect(scopeInput().disabled).toBe(false)
    expect(dueDateInput().disabled).toBe(false)
    expect(dueDateInput().value).toBe('2026-11-20')
    expect(button('마감일 저장').disabled).toBe(false)
    expect(button('마감일 지우기').disabled).toBe(false)
    fillDate('2026-11-21')
    expect(dueDateInput().value).toBe('2026-11-21')
    rerender(<IssueTriage {...props} />)
    expect(screen.getByRole('alert').textContent).toBe(unconfirmedMessage)
    expect(props.onRefresh).toHaveBeenCalledTimes(1)
  })

  it('저장 여부를 모르는 실패 뒤 댓글만 붙으면 안내가 남고 fetchCount가 오르면 사라진다', async () => {
    vi.mocked(updateIssue).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const { props, rerender } = renderTriage()
    fillDate()
    await select('범위', 'OUT_OF_SCOPE')
    const commented = { ...issue, comments: [savedComment], commentCount: 1 }

    rerender(<IssueTriage {...props} issue={commented} />)

    expect(screen.getByRole('alert').textContent).toBe(unconfirmedMessage)
    expect(scopeInput().value).toBe(issue.scope)
    expect(props.onRefresh).toHaveBeenCalledTimes(1)
    expect(props.onChanged).not.toHaveBeenCalled()
    const refreshed: Issue = { ...commented, scope: 'OUT_OF_SCOPE' }
    rerender(<IssueTriage {...props} issue={refreshed} fetchCount={4} />)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(scopeInput().value).toBe('OUT_OF_SCOPE')
    expect(dueDateInput().value).toBe('2026-11-20')
  })

  it('새로 받은 내용이 원래 값과 같아도 fetchCount가 오르면 저장 여부 안내가 사라진다', async () => {
    vi.mocked(updateIssue).mockRejectedValueOnce(new ApiError(503))
    const { props, rerender } = renderTriage()
    await select('분류', 'DESIGN')
    expect(screen.getByText(unconfirmedMessage)).toBeTruthy()

    rerender(<IssueTriage {...props} fetchCount={4} />)

    expect(screen.queryByRole('alert')).toBeNull()
    expect(categoryInput().value).toBe(issue.category)
  })

  it('요청 중 fetchCount가 올랐어도 실패 뒤에는 안내가 남고 그 뒤 한 번 더 올라야 사라진다', async () => {
    const pending = deferred<Issue>()
    vi.mocked(updateIssue).mockReturnValueOnce(pending.promise)
    const { props, rerender } = renderTriage()
    await select('범위', 'OUT_OF_SCOPE')
    rerender(<IssueTriage {...props} fetchCount={4} />)

    await act(async () => pending.reject(new TypeError('Failed to fetch')))

    expect(screen.getByText(unconfirmedMessage)).toBeTruthy()
    expect(props.onRefresh).toHaveBeenCalledTimes(1)
    expect(props.onChanged).not.toHaveBeenCalled()
    rerender(<IssueTriage {...props} fetchCount={4} issue={{ ...issue }} />)
    expect(screen.getByText(unconfirmedMessage)).toBeTruthy()
    rerender(<IssueTriage {...props} fetchCount={5} />)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each(['성공', '422', '연결 실패'])(
    '저장 여부를 모르는 실패 뒤 다시 보내면 안내를 지우고 새 결과 %s를 따른다',
    async (result) => {
      const pending = deferred<Issue>()
      vi.mocked(updateIssue)
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockReturnValueOnce(pending.promise)
      const { props } = renderTriage()
      await select('범위', 'OUT_OF_SCOPE')
      expect(screen.getByText(unconfirmedMessage)).toBeTruthy()

      await select('범위', 'OUT_OF_SCOPE')

      expect(screen.queryByRole('alert')).toBeNull()
      expect(updateIssue).toHaveBeenCalledTimes(2)
      expect(updateIssue).toHaveBeenLastCalledWith(issue.id, versionId, { scope: 'OUT_OF_SCOPE' })
      expect(scopeInput().value).toBe('OUT_OF_SCOPE')
      expect(scopeInput().disabled).toBe(true)
      const saved: Issue = { ...issue, scope: 'OUT_OF_SCOPE', comments: [savedComment], commentCount: 1 }
      await act(async () => {
        if (result === '성공') return pending.resolve(saved)
        pending.reject(result === '422' ? new ApiError(422) : new TypeError('Failed to fetch'))
      })
      expect(scopeInput().disabled).toBe(false)
      if (result === '성공') {
        expect(screen.queryByRole('alert')).toBeNull()
        expect(props.onChanged).toHaveBeenCalledExactlyOnceWith(saved)
        expect(props.onRefresh).toHaveBeenCalledTimes(1)
        return
      }
      expect(props.onChanged).not.toHaveBeenCalled()
      expect(screen.getByRole('alert').textContent).toBe(
        result === '422' ? '입력한 내용을 확인해 주세요' : unconfirmedMessage,
      )
      expect(props.onRefresh).toHaveBeenCalledTimes(result === '422' ? 1 : 2)
    },
  )

  it('마감일 연결 실패 뒤 치던 날짜를 고쳐 다시 저장할 수 있다', async () => {
    vi.mocked(updateIssue).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const { props } = renderTriage()
    fillDate()
    await click('마감일 저장')

    expect(dueDateInput().value).toBe('2026-11-20')
    expect(props.onChanged).not.toHaveBeenCalled()
    fillDate('2026-11-21')
    const saved = { ...issue, dueDate: '2026-11-21' }
    vi.mocked(updateIssue).mockResolvedValueOnce(saved)
    await click('마감일 저장')

    expect(updateIssue).toHaveBeenCalledTimes(2)
    expect(updateIssue).toHaveBeenLastCalledWith(issue.id, versionId, { dueDate: '2026-11-21' })
    expect(props.onChanged).toHaveBeenCalledExactlyOnceWith(saved)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('거절 안내도 다시 보내는 동안 지워지고 성공 뒤에 남지 않는다', async () => {
    const pending = deferred<Issue>()
    vi.mocked(updateIssue).mockRejectedValueOnce(new ApiError(422)).mockReturnValueOnce(pending.promise)
    renderTriage()
    await select('분류', 'DESIGN')
    expect(screen.getByRole('alert').textContent).toBe('입력한 내용을 확인해 주세요')

    await select('분류', 'COPY')
    expect(screen.queryByRole('alert')).toBeNull()
    await act(async () => pending.resolve({ ...issue, category: 'COPY' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('쓸 수 없어 입력이 사라졌다가 다시 나타나도 치던 날짜가 남는다', () => {
    const { props, rerender } = renderTriage()
    fillDate()

    rerender(<IssueTriage {...props} canWrite={false} />)
    expect(screen.queryByLabelText('마감일')).toBeNull()
    expect(screen.queryAllByRole('combobox')).toHaveLength(0)
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    rerender(<IssueTriage {...props} versionId={latestVersionId} issue={{ ...issue, dueDate: '2026-12-01' }} />)

    expect(dueDateInput().value).toBe('2026-11-20')
    expect(button('마감일 저장').disabled).toBe(false)
    expect(updateIssue).not.toHaveBeenCalled()
  })

  it('canWrite=false여도 새 버전 안내와 최신 버전 보기가 남고 새 버전에서 치던 날짜를 보낸다', async () => {
    const pending = deferred<Issue>()
    vi.mocked(updateIssue).mockReturnValueOnce(pending.promise)
    const { props, rerender } = renderTriage()
    fillDate()
    await click('마감일 저장')
    rerender(<IssueTriage {...props} canWrite={false} />)

    await act(async () => pending.reject(new ApiError(409, 'VERSION_CHANGED')))

    expect(screen.getByRole('alert').textContent).toContain('새 버전이 올라왔어요')
    expect(screen.queryByLabelText('마감일')).toBeNull()
    expect(screen.queryAllByRole('combobox')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: '마감일 저장' })).toBeNull()
    await click('최신 버전 보기')
    expect(props.onGoLatest).toHaveBeenCalledTimes(1)
    rerender(<IssueTriage {...props} versionId={latestVersionId} />)
    expect(dueDateInput().value).toBe('2026-11-20')
    await click('마감일 저장')
    expect(updateIssue).toHaveBeenLastCalledWith(issue.id, latestVersionId, { dueDate: '2026-11-20' })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each(['2026-11-20', ''])('15초 새로 불러오기처럼 새 상세를 받아도 직접 친 날짜 %s는 남는다', (draft) => {
    const { props, rerender } = renderTriage()
    fillDate(draft)

    rerender(<IssueTriage {...props} fetchCount={4} issue={{ ...issue, dueDate: '2026-12-01' }} />)

    expect(dueDateInput().value).toBe(draft)
    expect(button('마감일 저장').disabled).toBe(draft === '')
    expect(updateIssue).not.toHaveBeenCalled()
  })

  it('날짜를 치지 않았으면 새 상세의 마감일과 없음에 맞춰 날짜 칸도 바뀐다', () => {
    const { props, rerender } = renderTriage({ issue: { ...issue, dueDate: null } })
    expect(dueDateInput().value).toBe('')

    rerender(<IssueTriage {...props} issue={{ ...issue, dueDate: '2026-12-01' }} fetchCount={4} />)
    expect(dueDateInput().value).toBe('2026-12-01')
    expect(button('마감일 저장').disabled).toBe(true)
    expect(button('마감일 지우기').disabled).toBe(false)
    rerender(<IssueTriage {...props} fetchCount={5} />)
    expect(dueDateInput().value).toBe('')
    expect(button('마감일 저장').disabled).toBe(true)
    expect(screen.queryByRole('button', { name: '마감일 지우기' })).toBeNull()
  })

  it('쪽지를 닫거나 key가 달라져 다른 쪽지를 열면 치던 날짜와 오류를 새로 시작한다', async () => {
    vi.mocked(updateIssue).mockRejectedValueOnce(new ApiError(422))
    const { props, rerender } = renderTriage()
    fillDate()
    await click('마감일 저장')
    expect(screen.getByRole('alert')).toBeTruthy()
    const otherIssue = { ...issue, id: 'other-issue', dueDate: '2027-01-05' }

    rerender(<IssueTriage {...props} key={otherIssue.id} issue={otherIssue} />)

    expect(dueDateInput().value).toBe(otherIssue.dueDate)
    expect(button('마감일 저장').disabled).toBe(true)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('응답을 기다리는 사이 onChanged가 바뀌어도 누른 때의 콜백으로 서버 상세를 넘긴다', async () => {
    const pending = deferred<Issue>()
    vi.mocked(updateIssue).mockReturnValueOnce(pending.promise)
    const { props, rerender } = renderTriage()
    await select('범위', 'OUT_OF_SCOPE')
    const laterOnChanged = vi.fn()
    rerender(<IssueTriage {...props} onChanged={laterOnChanged} fetchCount={4} />)
    const saved: Issue = { ...issue, scope: 'OUT_OF_SCOPE', comments: [savedComment], commentCount: 1 }

    await act(async () => pending.resolve(saved))

    expect(props.onChanged).toHaveBeenCalledExactlyOnceWith(saved)
    expect(laterOnChanged).not.toHaveBeenCalled()
    expect(props.onRefresh).not.toHaveBeenCalled()
  })

  it('수정 중인 쪽지도 분류를 바꿀 수 있다', async () => {
    renderTriage({ issue: { ...issue, status: 'IN_PROGRESS' } })

    await select('분류', 'DESIGN')

    expect(updateIssue).toHaveBeenCalledExactlyOnceWith(issue.id, versionId, { category: 'DESIGN' })
  })
})
