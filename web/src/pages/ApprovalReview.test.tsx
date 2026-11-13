import { StrictMode, type ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { ApiError } from '../api/client.ts'
import {
  type ApprovalCheck,
  approveVersion,
  getApprovalCheck,
  timeFormat,
  type VersionDetail,
} from '../api/versions.ts'
import { ApprovedSummary, ApprovalReview } from './ApprovalReview.tsx'

vi.mock('../api/versions.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/versions.ts')>()),
  getApprovalCheck: vi.fn(),
  approveVersion: vi.fn(),
}))

const version: VersionDetail = {
  id: '22222222-2222-4222-8222-222222222222',
  projectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  number: 2,
  status: 'IN_REVIEW',
  publishedAt: '2026-11-13T01:00:00.000Z',
  summary: '두 번째 수정',
  testUrl: null,
  approval: null,
  screens: [],
}
const approved: VersionDetail = {
  ...version,
  status: 'APPROVED',
  approval: { approverName: '홍길동', approvedAt: '2026-11-13T06:20:00.123Z' },
}
const emptyCheck: ApprovalCheck = {
  serverTime: '2026-11-13T06:10:22.123456Z',
  unresolved: [],
  outOfScope: [],
  comments: [],
}
const unresolved: ApprovalCheck['unresolved'] = [
  { id: 'issue-open', number: 3, title: '버튼이 겹쳐요', status: 'OPEN' },
  { id: 'issue-progress', number: 8, title: '글자가 잘려요', status: 'IN_PROGRESS' },
  { id: 'issue-ready', number: 12, title: '사진을 확인해 주세요', status: 'READY_FOR_REVIEW' },
]
const outOfScope: ApprovalCheck['outOfScope'] = [
  { id: 'issue-extra', number: 15, title: '검색을 추가해 주세요', status: 'OPEN' },
]
const comments: ApprovalCheck['comments'] = [
  {
    id: 'comment-first',
    issueId: 'issue-open',
    issueNumber: 3,
    issueTitle: '버튼이 겹쳐요',
    authorName: '개발자',
    body: '<img src=x onerror="alert(1)"> <strong>확인</strong> & 그대로',
    createdAt: '2026-11-13T05:00:00.123Z',
  },
  {
    id: 'comment-second',
    issueId: 'issue-extra',
    issueNumber: 15,
    issueTitle: '검색을 추가해 주세요',
    authorName: '클라이언트',
    body: '범위를 범위 밖으로 바꿨어요',
    createdAt: '2026-11-13T06:00:00.456Z',
  },
]
const readonlyMessage = '이 버전은 읽기 전용이에요. 새 요청은 다음 차수에서 할 수 있어요.'
const confirmation = '이 버전을 승인할까요? 승인하면 되돌릴 수 없어요.'
const draftHint = '쓰던 쪽지를 보내거나 취소하면 열 수 있어요'
const loadFailure = '승인 검토를 불러오지 못했어요. 연결을 확인하고 다시 불러와 주세요'
const uncertainFailures = [
  ['연결 실패', new TypeError('Failed to fetch')],
  ['500', new ApiError(500)],
  ['503', new ApiError(503)],
] as const

const pending = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
const renderReview = (overrides: Partial<ComponentProps<typeof ApprovalReview>> = {}) => {
  const props = {
    version,
    onOpenIssue: vi.fn(),
    onApproved: vi.fn(),
    onReloadVersion: vi.fn(),
    onNotApprover: vi.fn(),
    onGoLatest: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  }
  return { ...render(<ApprovalReview {...props} />, { wrapper: MemoryRouter }), props }
}
const button = (name: string) => screen.getByRole<HTMLButtonElement>('button', { name })
const click = async (name: string) => {
  await act(async () => {
    fireEvent.click(button(name))
  })
}
const submitApproval = async () => {
  await screen.findByRole('button', { name: '승인하기' })
  await click('승인하기')
  await click('승인 확정')
}

const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal')
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close')
const showModal = vi.fn<() => void>()
const close = vi.fn<() => void>()

beforeEach(() => {
  vi.mocked(getApprovalCheck).mockReset().mockResolvedValue(emptyCheck)
  vi.mocked(approveVersion).mockReset().mockResolvedValue(approved)
  showModal.mockReset().mockImplementation(() => {
    const dialog = showModal.mock.contexts.at(-1) as HTMLDialogElement
    dialog.open = true
  })
  close.mockReset().mockImplementation(() => {
    const dialog = close.mock.contexts.at(-1) as HTMLDialogElement
    dialog.open = false
  })
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    writable: true,
    value: showModal,
  })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    writable: true,
    value: close,
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  for (const [name, descriptor] of [
    ['showModal', originalShowModal],
    ['close', originalClose],
  ] as const) {
    if (descriptor) {
      Object.defineProperty(HTMLDialogElement.prototype, name, descriptor)
      continue
    }
    Reflect.deleteProperty(HTMLDialogElement.prototype, name)
  }
})

describe('ApprovalReview', () => {
  it.each([
    [2, '2차 승인 검토'],
    [0, '초안 승인 검토'],
  ])('번호 %i의 제목은 %s이고 열 때 그 버전의 검토를 한 번 불러온다', async (number, title) => {
    const request = pending<ApprovalCheck>()
    vi.mocked(getApprovalCheck).mockReturnValueOnce(request.promise)
    renderReview({ version: { ...version, number } })

    expect(screen.getByRole('dialog', { name: title })).toBeDefined()
    expect(screen.getByRole('status').textContent).toBe('승인 검토를 불러오는 중이에요')
    expect(getApprovalCheck).toHaveBeenCalledExactlyOnceWith(version.id)
    expect(screen.queryByRole('button', { name: '승인하기' })).toBeNull()
    expect(screen.queryByText('끝나지 않은 쪽지가 없어요.')).toBeNull()

    await act(async () => request.resolve(emptyCheck))

    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByText('끝나지 않은 쪽지가 없어요.')).toBeDefined()
    expect(screen.getByText('이번 차수에 달린 댓글이 없어요')).toBeDefined()
    expect(screen.queryByRole('region', { name: '범위 밖 쪽지' })).toBeNull()
    expect(button('승인하기').disabled).toBe(false)
    expect(getApprovalCheck).toHaveBeenCalledTimes(1)
  })

  it('같은 버전의 새 props와 콜백을 받아도 검토를 다시 불러오지 않는다', async () => {
    const { props, rerender } = renderReview()
    await screen.findByRole('button', { name: '승인하기' })

    rerender(<ApprovalReview {...props} version={{ ...version }} onReloadVersion={vi.fn()} />)

    expect(getApprovalCheck).toHaveBeenCalledExactlyOnceWith(version.id)
  })

  it('끝나지 않은 쪽지의 번호·제목·상태를 보여 주고 승인하기를 잠근다', async () => {
    vi.mocked(getApprovalCheck).mockResolvedValue({ ...emptyCheck, unresolved, outOfScope })
    renderReview()

    const section = await screen.findByRole('region', { name: '끝나지 않은 쪽지' })
    expect(within(section).getByText('아직 끝나지 않은 쪽지가 3개 있어요')).toBeDefined()
    const rows = within(section).getAllByRole('listitem')
    const labels = ['접수', '수정 중', '확인 요청']
    unresolved.forEach((issue, index) => {
      expect(within(rows[index]).getByRole('button', { name: `쪽지 #${issue.number} 열기` }).textContent).toBe(
        `#${issue.number}`,
      )
      expect(within(rows[index]).getByText(issue.title)).toBeDefined()
      expect(within(rows[index]).getByText(labels[index])).toBeDefined()
    })
    expect(button('승인하기').disabled).toBe(true)
    await click('승인하기')
    expect(screen.queryByText(confirmation)).toBeNull()
    expect(approveVersion).not.toHaveBeenCalled()
  })

  it('범위 밖 쪽지만 있으면 제외 안내와 목록을 보여 주고 승인할 수 있다', async () => {
    vi.mocked(getApprovalCheck).mockResolvedValue({ ...emptyCheck, outOfScope })
    renderReview()

    const section = await screen.findByRole('region', { name: '범위 밖 쪽지' })
    expect(within(section).getByText('범위 밖(추가 요청) 쪽지 1개는 이번 승인에서 빼요')).toBeDefined()
    expect(within(section).getByRole('button', { name: '쪽지 #15 열기' }).textContent).toBe('#15')
    expect(within(section).getByText(outOfScope[0].title)).toBeDefined()
    expect(within(section).getByText('접수')).toBeDefined()
    expect(button('승인하기').disabled).toBe(false)

    await submitApproval()

    expect(approveVersion).toHaveBeenCalledExactlyOnceWith(version.id, emptyCheck.serverTime)
  })

  it('댓글의 쪽지·쓴 사람·시각·본문을 받은 순서대로 보여 주고 HTML을 글자로 표시한다', async () => {
    vi.mocked(getApprovalCheck).mockResolvedValue({ ...emptyCheck, comments })
    renderReview()
    await screen.findByText('이번 차수의 댓글 2개')

    const section = screen.getByRole('region', { name: '이번 차수의 댓글' })
    const rows = within(section).getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    comments.forEach((comment, index) => {
      expect(within(rows[index]).getByText(`#${comment.issueNumber} ${comment.issueTitle}`)).toBeDefined()
      expect(within(rows[index]).getByText(comment.authorName)).toBeDefined()
      expect(rows[index].textContent).toContain(timeFormat.format(new Date(comment.createdAt)))
      const body = within(rows[index]).getByText(comment.body)
      expect(body.textContent).toBe(comment.body)
      expect(body.children).toHaveLength(0)
    })
    expect(section.querySelector('img')).toBeNull()
  })

  it('두 쪽지 목록의 번호를 누르면 각각 그 쪽지 id로 열기를 요청한다', async () => {
    vi.mocked(getApprovalCheck).mockResolvedValue({ ...emptyCheck, unresolved, outOfScope })
    const { props } = renderReview()
    await screen.findByRole('button', { name: '쪽지 #3 열기' })

    for (const issue of [...unresolved, ...outOfScope]) {
      await click(`쪽지 #${issue.number} 열기`)
    }

    expect(vi.mocked(props.onOpenIssue!).mock.calls).toEqual([...unresolved, ...outOfScope].map((issue) => [issue.id]))
    expect(approveVersion).not.toHaveBeenCalled()
  })

  it.each([
    ['범위 안과 밖', unresolved, outOfScope, true],
    ['범위 밖만', [], outOfScope, false],
  ] as const)(
    '열기 함수가 없으면 %s 번호가 글자가 되고 안내하며 승인 잠금 조건은 그대로다',
    async (_name, inside, outside, disabled) => {
      vi.mocked(getApprovalCheck).mockResolvedValue({
        ...emptyCheck,
        unresolved: [...inside],
        outOfScope: [...outside],
      })
      renderReview({ onOpenIssue: undefined })
      await screen.findByText(draftHint)

      expect(screen.queryByRole('button', { name: /쪽지 #/ })).toBeNull()
      for (const issue of [...inside, ...outside]) {
        expect(screen.getByText(`#${issue.number}`).closest('button, a')).toBeNull()
      }
      expect(button('승인하기').disabled).toBe(disabled)
    },
  )

  it('열기 함수가 없어도 쪽지 목록이 비어 있으면 작성 중 안내를 보여 주지 않는다', async () => {
    vi.mocked(getApprovalCheck).mockResolvedValue({ ...emptyCheck, comments })
    renderReview({ onOpenIssue: undefined })
    await screen.findByText('이번 차수의 댓글 2개')

    expect(screen.queryByText(draftHint)).toBeNull()
    expect(button('승인하기').disabled).toBe(false)
  })

  it('승인하기는 창 안의 확인 단계만 열고 취소하면 요청 없이 앞 단계로 돌아간다', async () => {
    const confirm = vi.spyOn(window, 'confirm')
    renderReview()
    await screen.findByRole('button', { name: '승인하기' })
    await click('승인하기')

    expect(screen.getByText(confirmation)).toBeDefined()
    expect(screen.queryByRole('button', { name: '승인하기' })).toBeNull()
    expect(button('취소').disabled).toBe(false)
    expect(button('승인 확정').disabled).toBe(false)
    expect(approveVersion).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()

    await click('취소')

    expect(screen.queryByText(confirmation)).toBeNull()
    expect(button('승인하기').disabled).toBe(false)
    expect(approveVersion).not.toHaveBeenCalled()
  })

  it.each(['닫기 버튼', '×', 'Esc', '확인 단계의 ×', '확인 단계의 Esc'])(
    '%s로 닫기를 요청하면 승인 요청을 보내지 않는다',
    async (action) => {
      const { props } = renderReview()
      await screen.findByRole('button', { name: '승인하기' })
      if (action.startsWith('확인 단계')) await click('승인하기')

      if (action.endsWith('Esc')) {
        fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }))
      } else {
        const buttons = screen.getAllByRole('button', { name: '닫기' })
        fireEvent.click(action === '닫기 버튼' ? buttons[1] : buttons[0])
      }

      expect(props.onClose).toHaveBeenCalledTimes(1)
      expect(approveVersion).not.toHaveBeenCalled()
    },
  )

  it('승인 확정은 받은 서버 시각을 그대로 한 번 보내고 응답 전에는 취소·중복 승인·닫기를 막는다', async () => {
    const request = pending<VersionDetail>()
    vi.mocked(approveVersion).mockReturnValueOnce(request.promise)
    const { props } = renderReview()
    await submitApproval()

    expect(approveVersion).toHaveBeenCalledExactlyOnceWith(version.id, '2026-11-13T06:10:22.123456Z')
    expect(button('취소').disabled).toBe(true)
    expect(button('승인 확정').disabled).toBe(true)
    expect(props.onApproved).not.toHaveBeenCalled()
    await click('취소')
    await click('승인 확정')
    for (const closeButton of screen.getAllByRole('button', { name: '닫기' })) fireEvent.click(closeButton)
    const dialog = screen.getByRole<HTMLDialogElement>('dialog')
    const cancel = new Event('cancel', { cancelable: true })
    fireEvent(dialog, cancel)
    // 브라우저가 직접 닫은 경우에도 Modal이 다시 열어 두며 부모에 닫기를 알리지 않는다.
    dialog.open = false
    fireEvent(dialog, new Event('close'))

    expect(cancel.defaultPrevented).toBe(true)
    expect(dialog.open).toBe(true)
    expect(props.onClose).not.toHaveBeenCalled()
    expect(screen.getByText(confirmation)).toBeDefined()
    expect(approveVersion).toHaveBeenCalledTimes(1)

    await act(async () => request.resolve(approved))

    expect(props.onApproved).toHaveBeenCalledExactlyOnceWith(approved)
    expect(props.onReloadVersion).not.toHaveBeenCalled()
    expect(props.onNotApprover).not.toHaveBeenCalled()
  })

  it('범위 밖 쪽지 번호는 확인 단계에서 열 수 있고 승인 전송 중에는 잠기며 실패하면 다시 열린다', async () => {
    const request = pending<VersionDetail>()
    vi.mocked(getApprovalCheck).mockResolvedValue({ ...emptyCheck, outOfScope })
    vi.mocked(approveVersion).mockReturnValueOnce(request.promise)
    const { props } = renderReview()
    await screen.findByRole('button', { name: '쪽지 #15 열기' })
    await click('승인하기')

    expect(button('쪽지 #15 열기').disabled).toBe(false)
    expect(approveVersion).not.toHaveBeenCalled()
    await click('승인 확정')

    expect(approveVersion).toHaveBeenCalledExactlyOnceWith(version.id, emptyCheck.serverTime)
    expect(button('쪽지 #15 열기').disabled).toBe(true)
    await click('쪽지 #15 열기')
    expect(props.onOpenIssue).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: '2차 승인 검토' })).toBeDefined()

    await act(async () => request.reject(new TypeError('Failed to fetch')))

    expect(screen.queryByText(confirmation)).toBeNull()
    expect(button('승인하기').disabled).toBe(false)
    expect(button('쪽지 #15 열기').disabled).toBe(false)
    await click('쪽지 #15 열기')
    expect(props.onOpenIssue).toHaveBeenCalledExactlyOnceWith(outOfScope[0].id)
  })

  it('새 댓글로 거절되면 지난 목록을 치우고 새 댓글과 새 서버 시각을 받아 다시 승인한다', async () => {
    const reload = pending<ApprovalCheck>()
    const refreshed = {
      ...emptyCheck,
      serverTime: '2026-11-13T06:10:22.123457Z',
      comments: [...comments, { ...comments[0], id: 'new-comment', body: '방금 달린 댓글이에요' }],
    }
    vi.mocked(getApprovalCheck)
      .mockResolvedValueOnce({ ...emptyCheck, comments })
      .mockReturnValueOnce(reload.promise)
    vi.mocked(approveVersion).mockRejectedValueOnce(new ApiError(409, 'NEW_COMMENTS'))
    const { props } = renderReview()
    await screen.findByText(comments[0].body)
    await submitApproval()

    expect(screen.getByRole('alert').textContent).toBe('새 댓글이 있어요. 확인 후 다시 승인해 주세요')
    expect(screen.getByRole('status').textContent).toBe('승인 검토를 불러오는 중이에요')
    expect(screen.queryByText(comments[0].body)).toBeNull()
    expect(screen.queryByRole('button', { name: '승인하기' })).toBeNull()
    expect(screen.queryByText(confirmation)).toBeNull()
    expect(getApprovalCheck).toHaveBeenNthCalledWith(2, version.id)

    await act(async () => reload.resolve(refreshed))
    expect(screen.getByText('이번 차수의 댓글 3개')).toBeDefined()
    expect(screen.getByText('방금 달린 댓글이에요')).toBeDefined()
    expect(approveVersion).toHaveBeenCalledTimes(1)
    expect(props.onReloadVersion).not.toHaveBeenCalled()

    await submitApproval()

    expect(approveVersion).toHaveBeenCalledTimes(2)
    expect(approveVersion).toHaveBeenNthCalledWith(2, version.id, refreshed.serverTime)
    expect(props.onApproved).toHaveBeenCalledExactlyOnceWith(approved)
  })

  it('새 미해결 쪽지로 거절되면 목록을 다시 받아 보여 주고 승인을 잠근다', async () => {
    vi.mocked(getApprovalCheck)
      .mockResolvedValueOnce(emptyCheck)
      .mockResolvedValueOnce({ ...emptyCheck, unresolved })
    vi.mocked(approveVersion).mockRejectedValueOnce(new ApiError(409, 'UNRESOLVED_ISSUES'))
    renderReview()
    await submitApproval()

    expect(screen.getByRole('alert').textContent).toBe('아직 끝나지 않은 쪽지가 있어요')
    expect(screen.getByText('아직 끝나지 않은 쪽지가 3개 있어요')).toBeDefined()
    expect(screen.getByText(unresolved[0].title)).toBeDefined()
    expect(button('승인하기').disabled).toBe(true)
    expect(screen.queryByText(confirmation)).toBeNull()
    expect(getApprovalCheck).toHaveBeenCalledTimes(2)
    await click('승인하기')
    expect(approveVersion).toHaveBeenCalledTimes(1)
  })

  it('422면 검토를 새로 불러왔다는 안내와 갱신한 서버 시각으로 다시 승인한다', async () => {
    const reload = pending<ApprovalCheck>()
    const refreshed = { ...emptyCheck, serverTime: '2026-11-13T06:12:33.654321Z' }
    vi.mocked(getApprovalCheck).mockResolvedValueOnce(emptyCheck).mockReturnValueOnce(reload.promise)
    vi.mocked(approveVersion).mockRejectedValueOnce(new ApiError(422))
    renderReview()
    await submitApproval()

    expect(screen.getByRole('alert').textContent).toBe('승인 검토를 새로 불러왔어요. 다시 승인해 주세요')
    expect(screen.queryByText(confirmation)).toBeNull()
    expect(screen.queryByRole('button', { name: '승인하기' })).toBeNull()
    expect(screen.getByRole('status')).toBeDefined()
    expect(getApprovalCheck).toHaveBeenCalledTimes(2)

    await act(async () => reload.resolve(refreshed))
    await submitApproval()

    expect(approveVersion).toHaveBeenNthCalledWith(2, version.id, refreshed.serverTime)
  })

  it('새 댓글 뒤 검토를 다시 읽다가 연결이 끊기면 재시도로 새 목록과 서버 시각을 받는다', async () => {
    const refreshed = { ...emptyCheck, serverTime: '2026-11-13T06:15:00.987654Z', comments }
    vi.mocked(getApprovalCheck)
      .mockResolvedValueOnce(emptyCheck)
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(refreshed)
    vi.mocked(approveVersion).mockRejectedValueOnce(new ApiError(409, 'NEW_COMMENTS'))
    renderReview()
    await submitApproval()

    expect(screen.getByText(loadFailure)).toBeDefined()
    expect(screen.queryByRole('button', { name: '승인하기' })).toBeNull()
    await click('다시 불러오기')
    expect(screen.getByText(comments[0].body)).toBeDefined()
    expect(screen.queryByText(loadFailure)).toBeNull()
    expect(getApprovalCheck).toHaveBeenCalledTimes(3)

    await submitApproval()

    expect(approveVersion).toHaveBeenNthCalledWith(2, version.id, refreshed.serverTime)
  })

  it.each([
    ['403', new ApiError(403), '승인자만 할 수 있어요'],
    ['VERSION_CHANGED', new ApiError(409, 'VERSION_CHANGED'), '새 버전이 올라왔어요'],
  ] as const)(
    '새 댓글 뒤 검토를 다시 읽다가 %s를 받으면 이전 오류와 관계없이 재시도를 없앤다',
    async (_name, error, message) => {
      vi.mocked(getApprovalCheck).mockResolvedValueOnce(emptyCheck).mockRejectedValueOnce(error)
      vi.mocked(approveVersion).mockRejectedValueOnce(new ApiError(409, 'NEW_COMMENTS'))
      const { props } = renderReview()
      await submitApproval()

      expect(screen.getByText(message, { exact: false })).toBeDefined()
      expect(screen.queryByRole('button', { name: '승인하기' })).toBeNull()
      expect(screen.queryByText(confirmation)).toBeNull()
      if (error.status === 403) expect(props.onNotApprover).toHaveBeenCalledTimes(1)
      if (error.code === 'VERSION_CHANGED') {
        await click('최신 버전 보기')
        expect(props.onClose).toHaveBeenCalledTimes(1)
        expect(props.onGoLatest).toHaveBeenCalledTimes(1)
      }
      expect(screen.queryByRole('button', { name: '다시 불러오기' })).toBeNull()
    },
  )

  describe.each(['조회', '승인'] as const)('%s 실패', (phase) => {
    const fail = async (error: Error) => {
      if (phase === '조회') vi.mocked(getApprovalCheck).mockRejectedValueOnce(error)
      if (phase === '승인') vi.mocked(approveVersion).mockRejectedValueOnce(error)
      const view = renderReview()
      if (phase === '승인') await submitApproval()
      await screen.findByRole('alert')
      return view
    }

    it('VERSION_CHANGED면 승인을 없애고 최신 버전 보기가 닫기와 이동을 요청한다', async () => {
      const { props } = await fail(new ApiError(409, 'VERSION_CHANGED'))

      expect(screen.getByRole('alert').textContent).toContain('새 버전이 올라왔어요')
      expect(screen.queryByRole('button', { name: '승인하기' })).toBeNull()
      expect(screen.queryByText(confirmation)).toBeNull()
      expect(screen.queryByRole('button', { name: '다시 불러오기' })).toBeNull()
      expect(props.onGoLatest).not.toHaveBeenCalled()
      await click('최신 버전 보기')

      expect(props.onClose).toHaveBeenCalledTimes(1)
      expect(props.onGoLatest).toHaveBeenCalledTimes(1)
      expect(props.onReloadVersion).not.toHaveBeenCalled()
    })

    it('VERSION_NOT_IN_REVIEW면 이미 승인됐다는 안내와 버전 다시 읽기를 요청한다', async () => {
      const { props } = await fail(new ApiError(409, 'VERSION_NOT_IN_REVIEW'))

      expect(screen.getByRole('alert').textContent).toBe('이미 승인된 버전이에요')
      expect(props.onReloadVersion).toHaveBeenCalledTimes(1)
      expect(props.onApproved).not.toHaveBeenCalled()
      expect(screen.queryByText(confirmation)).toBeNull()
    })

    it('403이면 승인자가 아니라는 안내와 콜백만 남기고 승인·다시 불러오기를 없앤다', async () => {
      const { props } = await fail(new ApiError(403))

      expect(screen.getByRole('alert').textContent).toBe('승인자만 할 수 있어요')
      expect(props.onNotApprover).toHaveBeenCalledTimes(1)
      expect(props.onReloadVersion).not.toHaveBeenCalled()
      expect(screen.queryByRole('button', { name: '승인하기' })).toBeNull()
      expect(screen.queryByRole('button', { name: '다시 불러오기' })).toBeNull()
      expect(screen.queryByText(confirmation)).toBeNull()
      fireEvent.click(screen.getAllByRole('button', { name: '닫기' })[1])
      expect(props.onClose).toHaveBeenCalledTimes(1)
    })

    it('401이면 로그인 만료 안내와 새 탭 로그인 링크를 보여 준다', async () => {
      const { props } = await fail(new ApiError(401))

      expect(screen.getByRole('alert').textContent).toContain('로그인이 끝났어요')
      const link = screen.getByRole('link', { name: '새 탭에서 로그인하기' })
      expect(link.getAttribute('href')).toBe('/login')
      expect(link.getAttribute('target')).toBe('_blank')
      expect(screen.queryByText(confirmation)).toBeNull()
      expect(props.onNotApprover).not.toHaveBeenCalled()
      expect(props.onReloadVersion).not.toHaveBeenCalled()
    })

    it('404이면 없는 자원 안내를 보여 주고 성공으로 알리지 않는다', async () => {
      const { props } = await fail(new ApiError(404))

      expect(screen.getByRole('alert').textContent).toBe('찾을 수 없어요. 화면을 새로 고쳐 주세요')
      expect(screen.queryByText(confirmation)).toBeNull()
      expect(props.onApproved).not.toHaveBeenCalled()
    })
  })

  it.each(uncertainFailures)('조회 중 %s면 다시 불러올 수 있고 성공하면 승인할 수 있다', async (_name, error) => {
    const reload = pending<ApprovalCheck>()
    vi.mocked(getApprovalCheck).mockRejectedValueOnce(error).mockReturnValueOnce(reload.promise)
    const { props } = renderReview()
    await screen.findByText(loadFailure)

    expect(screen.queryByRole('button', { name: '승인하기' })).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
    await click('다시 불러오기')
    expect(getApprovalCheck).toHaveBeenNthCalledWith(2, version.id)
    expect(screen.getByRole('status')).toBeDefined()
    expect(screen.queryByRole('alert')).toBeNull()
    await act(async () => reload.resolve({ ...emptyCheck, outOfScope, comments }))

    expect(screen.getByText(outOfScope[0].title)).toBeDefined()
    expect(screen.getByText(comments[0].body)).toBeDefined()
    expect(button('승인하기').disabled).toBe(false)
    expect(props.onReloadVersion).not.toHaveBeenCalled()
    expect(props.onNotApprover).not.toHaveBeenCalled()
  })

  it.each(uncertainFailures)('승인 중 %s면 결과 확인을 요청하고 닫기와 재승인을 허용한다', async (_name, error) => {
    vi.mocked(approveVersion).mockRejectedValueOnce(error)
    const { props } = renderReview()
    await submitApproval()

    expect(screen.getByRole('alert').textContent).toContain('승인됐는지 확인하지 못했어요')
    expect(props.onReloadVersion).toHaveBeenCalledTimes(1)
    expect(props.onApproved).not.toHaveBeenCalled()
    expect(props.onGoLatest).not.toHaveBeenCalled()
    expect(screen.queryByText(confirmation)).toBeNull()
    expect(button('승인하기').disabled).toBe(false)
    expect(getApprovalCheck).toHaveBeenCalledTimes(1)
    for (const closeButton of screen.getAllByRole('button', { name: '닫기' })) fireEvent.click(closeButton)
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }))
    expect(props.onClose).toHaveBeenCalledTimes(3)

    await submitApproval()

    expect(approveVersion).toHaveBeenCalledTimes(2)
    expect(props.onApproved).toHaveBeenCalledExactlyOnceWith(approved)
  })

  it.each([
    ['새 댓글', new ApiError(409, 'NEW_COMMENTS')],
    ['응답 끊김', new TypeError('Failed to fetch')],
    ['401', new ApiError(401)],
    ['422', new ApiError(422)],
  ] as const)('%s 오류 뒤 승인하기를 다시 누르는 순간 지난 실패 안내를 지운다', async (_name, error) => {
    vi.mocked(approveVersion).mockRejectedValueOnce(error)
    renderReview()
    await submitApproval()
    expect(screen.getByRole('alert')).toBeDefined()

    await click('승인하기')

    expect(screen.getByText(confirmation)).toBeDefined()
    expect(approveVersion).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alert')).toBeNull()
    await click('취소')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('실제 승인 요청이 30초 뒤 끊기면 결과 확인을 요청하고 창의 잠금을 푼다', async () => {
    const actual = await vi.importActual<typeof import('../api/versions.ts')>('../api/versions.ts')
    vi.mocked(approveVersion).mockImplementationOnce(actual.approveVersion)
    let signal: AbortSignal | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        signal = init?.signal ?? undefined
        return await new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new DOMException('요청 중단', 'AbortError')), { once: true })
        })
      }),
    )
    const { props } = renderReview()
    await screen.findByRole('button', { name: '승인하기' })
    vi.useFakeTimers()
    await click('승인하기')
    await click('승인 확정')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(29_999)
    })

    expect(signal?.aborted).toBe(false)
    expect(button('승인 확정').disabled).toBe(true)
    expect(props.onReloadVersion).not.toHaveBeenCalled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })

    expect(signal?.aborted).toBe(true)
    expect(screen.getByRole('alert').textContent).toContain('승인됐는지 확인하지 못했어요')
    expect(props.onReloadVersion).toHaveBeenCalledTimes(1)
    expect(props.onApproved).not.toHaveBeenCalled()
    expect(button('승인하기').disabled).toBe(false)
    expect(screen.queryByText(confirmation)).toBeNull()
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }))
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it.each([
    [2, '2차 승인 완료', '2차가 승인됐어요'],
    [0, '초안 승인 완료', '초안이 승인됐어요'],
  ])('승인된 번호 %i는 %s와 승인 정보·읽기 전용 안내·닫기만 보여 준다', async (number, title, message) => {
    const { props } = renderReview({ version: { ...approved, number } })
    await act(async () => {})

    expect(screen.getByRole('dialog', { name: title })).toBeDefined()
    expect(screen.getByText(message, { exact: false })).toBeDefined()
    expect(
      screen.getByText(`승인자 홍길동 · ${timeFormat.format(new Date(approved.approval!.approvedAt))}`),
    ).toBeDefined()
    expect(screen.getByText(readonlyMessage)).toBeDefined()
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(
      screen.getAllByRole('button').map((element) => element.getAttribute('aria-label') ?? element.textContent),
    ).toEqual(['닫기', '닫기'])
    fireEvent.click(screen.getAllByRole('button', { name: '닫기' })[1])
    expect(props.onClose).toHaveBeenCalledTimes(1)
    expect(approveVersion).not.toHaveBeenCalled()
  })

  it.each([
    ['이미 승인됨', new ApiError(409, 'VERSION_NOT_IN_REVIEW')],
    ['결과를 모름', new TypeError('Failed to fetch')],
    ['권한 변경', new ApiError(403)],
  ] as const)('%s 안내가 있어도 같은 버전의 props가 승인됨으로 바뀌면 완료 모습만 남는다', async (_name, error) => {
    vi.mocked(approveVersion).mockRejectedValueOnce(error)
    const { props, rerender } = renderReview()
    await submitApproval()
    expect(screen.getByRole('alert')).toBeDefined()

    rerender(<ApprovalReview {...props} version={approved} />)

    expect(screen.getByRole('dialog', { name: '2차 승인 완료' })).toBeDefined()
    expect(screen.getByText('2차가 승인됐어요', { exact: false })).toBeDefined()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText(confirmation)).toBeNull()
    expect(screen.queryByRole('button', { name: '승인하기' })).toBeNull()
    expect(screen.queryByRole('button', { name: '다시 불러오기' })).toBeNull()
  })

  it('성공 응답을 부모가 props에 반영하면 그 응답의 승인자·시각으로 완료 모습을 그린다', async () => {
    const { props, rerender } = renderReview()
    await submitApproval()
    const received = vi.mocked(props.onApproved).mock.calls[0][0] as VersionDetail

    rerender(<ApprovalReview {...props} version={received} />)

    expect(received).toEqual(approved)
    expect(screen.getByRole('dialog', { name: '2차 승인 완료' })).toBeDefined()
    expect(screen.getByText(/승인자 홍길동/).textContent).toContain(
      timeFormat.format(new Date(approved.approval!.approvedAt)),
    )
    expect(screen.queryByRole('button', { name: '승인 확정' })).toBeNull()
  })

  it('승인 정보가 null이면 승인자 줄만 생략하고 완료 모습은 유지한다', async () => {
    renderReview({ version: { ...approved, approval: null } })
    await act(async () => {})

    expect(screen.getByRole('dialog', { name: '2차 승인 완료' })).toBeDefined()
    expect(screen.getByText('2차가 승인됐어요', { exact: false })).toBeDefined()
    expect(screen.queryByText(/승인자/)).toBeNull()
    expect(screen.getByText(readonlyMessage)).toBeDefined()
  })

  it.each([
    ['403', new ApiError(403)],
    ['VERSION_NOT_IN_REVIEW', new ApiError(409, 'VERSION_NOT_IN_REVIEW')],
    ['연결 실패', new TypeError('Failed to fetch')],
  ] as const)(
    '창이 사라진 뒤 승인 요청이 %s로 실패해도 권한 변경이나 버전 다시 읽기를 요청하지 않는다',
    async (_name, error) => {
      const request = pending<VersionDetail>()
      vi.mocked(approveVersion).mockReturnValueOnce(request.promise)
      const { props, unmount } = renderReview()
      await submitApproval()

      expect(approveVersion).toHaveBeenCalledExactlyOnceWith(version.id, emptyCheck.serverTime)
      expect(props.onApproved).not.toHaveBeenCalled()
      unmount()
      expect(screen.queryByRole('dialog')).toBeNull()

      await act(async () => request.reject(error))

      expect(props.onNotApprover).not.toHaveBeenCalled()
      expect(props.onReloadVersion).not.toHaveBeenCalled()
      expect(props.onApproved).not.toHaveBeenCalled()
      expect(getApprovalCheck).toHaveBeenCalledTimes(1)
    },
  )

  it('창이 사라진 뒤 승인 요청이 성공하면 승인된 버전 상세를 부모에게 알린다', async () => {
    const request = pending<VersionDetail>()
    vi.mocked(approveVersion).mockReturnValueOnce(request.promise)
    const { props, unmount } = renderReview()
    await submitApproval()

    expect(approveVersion).toHaveBeenCalledExactlyOnceWith(version.id, emptyCheck.serverTime)
    expect(props.onApproved).not.toHaveBeenCalled()
    unmount()
    expect(screen.queryByRole('dialog')).toBeNull()

    await act(async () => request.resolve(approved))

    expect(props.onApproved).toHaveBeenCalledExactlyOnceWith(approved)
    expect(props.onNotApprover).not.toHaveBeenCalled()
    expect(props.onReloadVersion).not.toHaveBeenCalled()
  })

  it('StrictMode에서 창이 열려 있는 동안 승인 요청이 403이면 권한 변경을 알린다', async () => {
    const request = pending<VersionDetail>()
    vi.mocked(approveVersion).mockReturnValueOnce(request.promise)
    const props = {
      version,
      onApproved: vi.fn(),
      onReloadVersion: vi.fn(),
      onNotApprover: vi.fn(),
      onGoLatest: vi.fn(),
      onClose: vi.fn(),
    }
    render(
      <StrictMode>
        <MemoryRouter>
          <ApprovalReview {...props} />
        </MemoryRouter>
      </StrictMode>,
    )
    await submitApproval()

    expect(approveVersion).toHaveBeenCalledExactlyOnceWith(version.id, emptyCheck.serverTime)
    expect(props.onNotApprover).not.toHaveBeenCalled()
    await act(async () => request.reject(new ApiError(403)))

    expect(screen.getByRole('dialog', { name: '2차 승인 검토' })).toBeDefined()
    expect(screen.getByRole('alert').textContent).toBe('승인자만 할 수 있어요')
    expect(props.onNotApprover).toHaveBeenCalledTimes(1)
    expect(props.onReloadVersion).not.toHaveBeenCalled()
    expect(props.onApproved).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: '승인하기' })).toBeNull()
    expect(screen.queryByText(confirmation)).toBeNull()
  })

  it.each(['성공', '403', '이미 승인됨'] as const)(
    '창을 닫은 뒤 늦게 온 검토 %s 응답은 버리고 새 창에 영향을 주지 않는다',
    async (result) => {
      const old = pending<ApprovalCheck>()
      vi.mocked(getApprovalCheck).mockReturnValueOnce(old.promise)
      const { props, unmount } = renderReview()
      unmount()
      renderReview()
      await screen.findByRole('button', { name: '승인하기' })

      await act(async () => {
        if (result === '성공') old.resolve({ ...emptyCheck, unresolved })
        if (result === '403') old.reject(new ApiError(403))
        if (result === '이미 승인됨') old.reject(new ApiError(409, 'VERSION_NOT_IN_REVIEW'))
      })

      expect(screen.queryByText(unresolved[0].title)).toBeNull()
      expect(screen.queryByRole('alert')).toBeNull()
      expect(button('승인하기').disabled).toBe(false)
      expect(props.onNotApprover).not.toHaveBeenCalled()
      expect(props.onReloadVersion).not.toHaveBeenCalled()
      expect(getApprovalCheck).toHaveBeenCalledTimes(2)
    },
  )

  it.each(['성공', '403'] as const)(
    '다시 불러온 뒤 먼저 보낸 검토의 늦은 %s 응답이 새 목록·서버 시각을 덮지 않는다',
    async (result) => {
      const old = pending<ApprovalCheck>()
      const refreshed = { ...emptyCheck, serverTime: '2026-11-13T06:10:22.123999Z', comments }
      vi.mocked(getApprovalCheck)
        .mockReturnValueOnce(old.promise)
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValueOnce(refreshed)
      const props = {
        version,
        onApproved: vi.fn(),
        onReloadVersion: vi.fn(),
        onNotApprover: vi.fn(),
        onGoLatest: vi.fn(),
        onClose: vi.fn(),
      }
      // 개발 화면의 StrictMode가 검토를 두 번 시작한 상황에서, 활성 요청 실패 후 사용자가 다시 불러온다.
      render(
        <StrictMode>
          <MemoryRouter>
            <ApprovalReview {...props} />
          </MemoryRouter>
        </StrictMode>,
      )
      await screen.findByText(loadFailure)
      await click('다시 불러오기')
      expect(screen.getByText(comments[0].body)).toBeDefined()

      await act(async () => {
        if (result === '성공') old.resolve({ ...emptyCheck, unresolved })
        if (result === '403') old.reject(new ApiError(403))
      })

      expect(screen.queryByText(unresolved[0].title)).toBeNull()
      expect(screen.queryByRole('alert')).toBeNull()
      expect(screen.getByText(comments[0].body)).toBeDefined()
      expect(props.onNotApprover).not.toHaveBeenCalled()
      await submitApproval()
      expect(approveVersion).toHaveBeenCalledExactlyOnceWith(version.id, refreshed.serverTime)
    },
  )
})

describe('ApprovedSummary', () => {
  it.each([
    [0, '초안이 승인됐어요'],
    [1, '1차가 승인됐어요'],
    [2, '2차가 승인됐어요'],
  ])('번호 %i를 맞는 조사로 알리고 승인자·시각·읽기 전용 안내를 보여 준다', (number, message) => {
    render(<ApprovedSummary version={{ ...approved, number }} />, { wrapper: MemoryRouter })

    expect(screen.getByText(message, { exact: false })).toBeDefined()
    expect(
      screen.getByText(`승인자 홍길동 · ${timeFormat.format(new Date(approved.approval!.approvedAt))}`),
    ).toBeDefined()
    expect(screen.getByText(readonlyMessage)).toBeDefined()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('approval이 null이어도 승인 문장과 읽기 전용 안내는 남고 승인자 줄만 없다', () => {
    render(<ApprovedSummary version={{ ...approved, approval: null }} />, { wrapper: MemoryRouter })

    expect(screen.getByText('2차가 승인됐어요', { exact: false })).toBeDefined()
    expect(screen.getByText(readonlyMessage)).toBeDefined()
    expect(screen.queryByText(/승인자/)).toBeNull()
  })

  it.each(['/', '/app'])('basename이 %s이면 그 경로 아래의 버전 확인서로 연결한다', (basename) => {
    render(
      <MemoryRouter basename={basename} initialEntries={[basename]}>
        <ApprovedSummary version={approved} />
      </MemoryRouter>,
    )

    const prefix = basename === '/' ? '' : basename
    expect(screen.getByRole('link', { name: '검수 확인서 보기' }).getAttribute('href')).toBe(
      `${prefix}/versions/${approved.id}/certificate`,
    )
  })
})
