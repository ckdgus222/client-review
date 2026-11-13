import { act, fireEvent, render, screen, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { MemoryRouter } from 'react-router'
import { ApiError } from '../api/client.ts'
import { type IssueDetail as Issue, reopenIssue, verifyIssue, withdrawIssue } from '../api/issues.ts'
import { IssueReview } from './IssueReview.tsx'

vi.mock('../api/issues.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/issues.ts')>()),
  verifyIssue: vi.fn(),
  reopenIssue: vi.fn(),
  withdrawIssue: vi.fn(),
}))

const versionId = '22222222-2222-4222-8222-222222222222'
const latestVersionId = '33333333-3333-4333-8333-333333333333'
const latestAttempt: Issue['attempts'][number] = {
  id: 'attempt-latest',
  versionId,
  versionNumber: 2,
  screen: null,
  summary: '버튼 위치를 고쳤어요',
  submittedByName: '개발자',
  createdAt: '2026-11-12T01:00:00.000Z',
  result: null,
  reviewedByName: null,
  reviewedAt: null,
}
const issue: Issue = {
  currentVersion: { id: versionId, status: 'IN_REVIEW' },
  id: '11111111-1111-4111-8111-111111111111',
  projectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  number: 14,
  title: '버튼을 옮겨 주세요',
  body: '오른쪽으로 옮겨 주세요',
  status: 'READY_FOR_REVIEW',
  category: 'BUG',
  scope: 'IN_SCOPE',
  dueDate: null,
  authorName: '클라이언트',
  createdAt: '2026-11-10T00:00:00.000Z',
  commentCount: 0,
  originVersion: { id: 'origin-version', number: 1 },
  origin: null,
  isMine: false,
  canReview: true,
  attempts: [
    {
      ...latestAttempt,
      id: 'attempt-old',
      createdAt: '2026-11-11T01:00:00.000Z',
      result: 'REOPENED',
      reviewedByName: '클라이언트',
      reviewedAt: '2026-11-11T02:00:00.000Z',
    },
    latestAttempt,
  ],
  attachments: [],
  comments: [],
}
const unconfirmedMessage = '저장됐는지 확인하지 못했어요. 쪽지에 바뀐 내용이 보이지 않으면 다시 보내 주세요.'
const staleMessage = '쪽지 상태가 바뀌었어요. 새로 불러왔어요.'
const reasonActions = [
  {
    name: '재요청',
    label: '재요청 사유',
    submit: '재요청 보내기',
    status: 'READY_FOR_REVIEW',
    api: reopenIssue,
    savedStatus: 'OPEN',
    attemptId: latestAttempt.id,
  },
  {
    name: '철회',
    label: '철회 사유',
    submit: '철회하기',
    status: 'OPEN',
    api: withdrawIssue,
    savedStatus: 'WITHDRAWN',
    attemptId: undefined,
  },
  {
    name: '다시 열기',
    label: '다시 여는 사유',
    submit: '다시 열기',
    status: 'VERIFIED',
    api: reopenIssue,
    savedStatus: 'OPEN',
    attemptId: undefined,
  },
] as const
const failures = [
  ['422', new ApiError(422), '입력한 내용을 확인해 주세요', 0],
  ['403', new ApiError(403), '잠시 뒤 다시 시도해 주세요', 1],
  ['404', new ApiError(404), '찾을 수 없어요. 화면을 새로 고쳐 주세요', 1],
  ['VERSION_CHANGED', new ApiError(409, 'VERSION_CHANGED'), '새 버전이 올라왔어요. 쓰던 글은 그대로 남아 있어요.', 1],
  ['VERSION_NOT_IN_REVIEW', new ApiError(409, 'VERSION_NOT_IN_REVIEW'), '승인된 버전이라 더 쓸 수 없어요.', 1],
  ['ISSUE_STATE_CHANGED', new ApiError(409, 'ISSUE_STATE_CHANGED'), staleMessage, 1],
  ['ATTEMPT_CHANGED', new ApiError(409, 'ATTEMPT_CHANGED'), staleMessage, 1],
  ['연결 실패', new TypeError('Failed to fetch'), unconfirmedMessage, 1],
  ['500', new ApiError(500), unconfirmedMessage, 1],
  ['503', new ApiError(503), unconfirmedMessage, 1],
] as const

const renderReview = (overrides: Partial<ComponentProps<typeof IssueReview>> = {}) => {
  const props = {
    issue,
    versionId,
    canWrite: true,
    fetchCount: 3,
    onChanged: vi.fn(),
    onRefresh: vi.fn(),
    onGoLatest: vi.fn(),
    ...overrides,
  }
  return { ...render(<IssueReview {...props} />, { wrapper: MemoryRouter }), props }
}
const button = (name: string) => screen.getByRole<HTMLButtonElement>('button', { name })
const reasonInput = () => screen.getByRole<HTMLTextAreaElement>('textbox')
const fillReason = (value = '  아직 버튼이 겹쳐요  ') => {
  fireEvent.change(reasonInput(), { target: { value } })
}
const click = async (name: string) => {
  await act(async () => {
    fireEvent.click(button(name))
  })
}
const expectNoRequest = () => {
  expect(verifyIssue).not.toHaveBeenCalled()
  expect(reopenIssue).not.toHaveBeenCalled()
  expect(withdrawIssue).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.mocked(verifyIssue)
    .mockReset()
    .mockResolvedValue({ ...issue, status: 'VERIFIED' })
  vi.mocked(reopenIssue)
    .mockReset()
    .mockResolvedValue({ ...issue, status: 'OPEN' })
  vi.mocked(withdrawIssue)
    .mockReset()
    .mockResolvedValue({ ...issue, status: 'WITHDRAWN' })
})

describe('IssueReview', () => {
  it.each(['조회 먼저', '실패 먼저'] as const)(
    '확인 완료에서 %s 처리하고 같은 화면 갱신에 묶여도 저장 여부 안내는 다음 조회까지 남는다',
    async (order) => {
      let reject!: (error: unknown) => void
      vi.mocked(verifyIssue).mockReturnValueOnce(
        new Promise<Issue>((_resolve, fail) => {
          reject = fail
        }),
      )
      const { props, rerender } = renderReview()
      await click('확인 완료')

      await act(async () => {
        if (order === '조회 먼저') rerender(<IssueReview {...props} fetchCount={4} />)
        reject(new TypeError('Failed to fetch'))
        await Promise.resolve()
        if (order === '실패 먼저') rerender(<IssueReview {...props} fetchCount={4} />)
      })

      expect(screen.getByRole('alert').textContent).toBe(unconfirmedMessage)
      expect(props.onRefresh).toHaveBeenCalledExactlyOnceWith()
      expect(props.onChanged).not.toHaveBeenCalled()
      expect(verifyIssue).toHaveBeenCalledExactlyOnceWith(issue.id, { versionId, attemptId: latestAttempt.id })
      rerender(<IssueReview {...props} fetchCount={4} />)
      expect(screen.getByRole('alert').textContent).toBe(unconfirmedMessage)
      rerender(<IssueReview {...props} fetchCount={5} />)
      expect(screen.queryByText(unconfirmedMessage)).toBeNull()
    },
  )

  it.each([
    ['READY_FOR_REVIEW', ['재요청', '철회', '확인 완료']],
    ['OPEN', ['철회']],
    ['IN_PROGRESS', ['철회']],
    ['VERIFIED', ['다시 열기']],
    ['WITHDRAWN', ['다시 열기']],
  ] as const)('%s 상태에서 허용된 버튼만 보인다', (status, names) => {
    renderReview({ issue: { ...issue, status } })
    expect(
      within(screen.getByRole('region', { name: '확인하기' }))
        .getAllByRole('button')
        .map((item) => item.textContent),
    ).toEqual(names)
    expect(screen.queryByRole('textbox')).toBeNull()
    expectNoRequest()
  })

  it.each(['OPEN', 'IN_PROGRESS', 'READY_FOR_REVIEW', 'VERIFIED', 'WITHDRAWN'] as const)(
    '%s여도 canReview가 거짓이면 쓴 사람에게도 버튼을 보이지 않는다',
    (status) => {
      const { container } = renderReview({ issue: { ...issue, status, canReview: false, isMine: true } })
      expect(container.innerHTML).toBe('')
      expectNoRequest()
    },
  )

  it.each(['OPEN', 'IN_PROGRESS', 'READY_FOR_REVIEW', 'VERIFIED', 'WITHDRAWN'] as const)(
    '%s여도 읽기 전용이면 확인 버튼이 없다',
    (status) => {
      renderReview({ issue: { ...issue, status }, canWrite: false })
      expect(screen.queryByRole('button')).toBeNull()
      expect(screen.queryByRole('textbox')).toBeNull()
      expectNoRequest()
    },
  )

  it('비교 화면의 확인 요청에는 재요청과 확인 완료만 보인다', () => {
    renderReview({ reviewOnly: true })
    expect(screen.getAllByRole('button').map((item) => item.textContent)).toEqual(['재요청', '확인 완료'])
  })

  it.each(['OPEN', 'IN_PROGRESS', 'VERIFIED', 'WITHDRAWN'] as const)('비교 화면의 %s에는 버튼이 없다', (status) => {
    renderReview({ reviewOnly: true, issue: { ...issue, status } })
    expect(screen.queryByRole('button')).toBeNull()
    expectNoRequest()
  })

  it.each([false, true])(
    '확인 완료는 마지막 줄의 id와 보고 있는 버전을 즉시 보낸다(reviewOnly=%s)',
    async (reviewOnly) => {
      const saved: Issue = { ...issue, status: 'VERIFIED' }
      vi.mocked(verifyIssue).mockResolvedValueOnce(saved)
      const { props } = renderReview({ reviewOnly })
      await click('확인 완료')

      expect(verifyIssue).toHaveBeenCalledExactlyOnceWith(issue.id, { versionId, attemptId: latestAttempt.id })
      expect(props.onChanged).toHaveBeenCalledExactlyOnceWith(saved)
      expect(props.onRefresh).not.toHaveBeenCalled()
      expect(screen.queryByRole('textbox')).toBeNull()
      expect(reopenIssue).not.toHaveBeenCalled()
      expect(withdrawIssue).not.toHaveBeenCalled()
    },
  )

  it('확인 완료 응답을 기다리는 동안 모든 동작 버튼을 잠그고 중복 클릭을 보내지 않는다', async () => {
    let resolve!: (value: Issue) => void
    vi.mocked(verifyIssue).mockReturnValueOnce(
      new Promise<Issue>((done) => {
        resolve = done
      }),
    )
    const { props } = renderReview()
    await click('확인 완료')
    expect(screen.getAllByRole<HTMLButtonElement>('button').every((item) => item.disabled)).toBe(true)
    expect(props.onChanged).not.toHaveBeenCalled()
    await click('확인 완료')
    await click('재요청')
    expect(verifyIssue).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('textbox')).toBeNull()
    await act(async () => {
      resolve({ ...issue, status: 'VERIFIED' })
    })
    expect(screen.getAllByRole<HTMLButtonElement>('button').every((item) => !item.disabled)).toBe(true)
  })

  describe.each(reasonActions)('$name 사유', (action) => {
    it('버튼 자리에서 사유 칸이 펴지고 취소하면 요청 없이 글과 오류가 지워진다', async () => {
      renderReview({ issue: { ...issue, status: action.status } })
      await click(action.name)
      expect(screen.getByLabelText(action.label)).toBe(reasonInput())
      expect(reasonInput().maxLength).toBe(2000)
      expect(screen.getAllByRole('button').map((item) => item.textContent)).toEqual(['취소', action.submit])
      await click(action.submit)
      expect(screen.getByRole('alert').textContent).toBe('사유는 1~2,000자로 써 주세요')
      fillReason()
      await click('취소')
      expect(screen.queryByRole('textbox')).toBeNull()
      expect(screen.queryByRole('alert')).toBeNull()
      expectNoRequest()
      await click(action.name)
      expect(reasonInput().value).toBe('')
      expect(screen.queryByRole('alert')).toBeNull()
    })

    it.each([
      ['빈 글', ''],
      ['공백', ' \n\t '],
      ['2,001자', '가'.repeat(2001)],
    ])('%s 사유는 보내지 않는다', async (_, reason) => {
      const { props } = renderReview({ issue: { ...issue, status: action.status } })
      await click(action.name)
      fillReason(reason)
      await click(action.submit)
      expect(screen.getByRole('alert').textContent).toBe('사유는 1~2,000자로 써 주세요')
      expect(reasonInput().value).toBe(reason)
      expectNoRequest()
      expect(props.onChanged).not.toHaveBeenCalled()
    })

    it.each([1, 2000])('공백을 뺀 %i자 사유를 올바른 요청으로 보내고 성공하면 칸과 글을 비운다', async (length) => {
      const saved: Issue = { ...issue, status: action.savedStatus }
      vi.mocked(action.api).mockResolvedValueOnce(saved)
      const { props } = renderReview({ issue: { ...issue, status: action.status } })
      await click(action.name)
      const reason = '가'.repeat(length)
      fillReason(` \n${reason}\t `)
      await click(action.submit)
      const body = action.name === '철회' ? { versionId, reason } : { versionId, reason, attemptId: action.attemptId }
      expect(action.api).toHaveBeenCalledExactlyOnceWith(issue.id, body)
      expect(verifyIssue).not.toHaveBeenCalled()
      expect(action.name === '철회' ? reopenIssue : withdrawIssue).not.toHaveBeenCalled()
      expect(props.onChanged).toHaveBeenCalledExactlyOnceWith(saved)
      expect(props.onRefresh).not.toHaveBeenCalled()
      expect(screen.queryByRole('textbox')).toBeNull()
      await click(action.name)
      expect(reasonInput().value).toBe('')
    })

    it('보내는 동안 취소·보내기를 잠그고 사유는 읽기 전용이며 중복 요청이 없다', async () => {
      let resolve!: (value: Issue) => void
      vi.mocked(action.api).mockReturnValueOnce(
        new Promise<Issue>((done) => {
          resolve = done
        }),
      )
      const { props } = renderReview({ issue: { ...issue, status: action.status } })
      await click(action.name)
      fillReason()
      await click(action.submit)
      expect(button('취소').disabled).toBe(true)
      expect(button(action.submit).disabled).toBe(true)
      expect(reasonInput().readOnly).toBe(true)
      expect(reasonInput().disabled).toBe(false)
      expect(props.onChanged).not.toHaveBeenCalled()
      await click('취소')
      await click(action.submit)
      expect(reasonInput().value).toBe('  아직 버튼이 겹쳐요  ')
      expect(action.api).toHaveBeenCalledTimes(1)
      await act(async () => {
        resolve({ ...issue, status: action.savedStatus })
      })
      expect(screen.queryByRole('textbox')).toBeNull()
      expect(button(action.name).disabled).toBe(false)
    })

    it.each(failures)(
      '%s 실패는 사유를 보존하고 안내·새로 불러오기 후 다시 보낼 수 있다',
      async (_, failure, message, refreshCount) => {
        vi.mocked(action.api).mockRejectedValueOnce(failure)
        const { props } = renderReview({ issue: { ...issue, status: action.status } })
        await click(action.name)
        fillReason()
        await click(action.submit)
        expect(screen.getByRole('alert').textContent).toContain(message)
        expect(props.onRefresh).toHaveBeenCalledTimes(refreshCount)
        expect(props.onChanged).not.toHaveBeenCalled()
        expect(screen.getByLabelText(action.label)).toBe(reasonInput())
        expect(reasonInput().value).toBe('  아직 버튼이 겹쳐요  ')
        expect(reasonInput().readOnly).toBe(false)
        expect(button(action.submit).disabled).toBe(false)
        expect(button('취소').disabled).toBe(false)
        await click(action.submit)
        expect(action.api).toHaveBeenCalledTimes(2)
        expect(props.onChanged).toHaveBeenCalledTimes(1)
        expect(screen.queryByRole('alert')).toBeNull()
        expect(screen.queryByRole('textbox')).toBeNull()
      },
    )

    it('새 객체로 새로 불러오거나 입력을 감췄다 보여도 사유 칸과 글이 남는다', async () => {
      const currentIssue: Issue = { ...issue, status: action.status }
      const { props, rerender } = renderReview({ issue: currentIssue })
      await click(action.name)
      fillReason('쓰던 사유')
      rerender(<IssueReview {...props} issue={{ ...currentIssue }} fetchCount={4} />)
      expect(reasonInput().value).toBe('쓰던 사유')
      rerender(<IssueReview {...props} canWrite={false} />)
      expect(screen.queryByRole('textbox')).toBeNull()
      expect(screen.queryByRole('button')).toBeNull()
      rerender(<IssueReview {...props} canWrite={true} />)
      expect(screen.getByLabelText(action.label)).toBe(reasonInput())
      expect(reasonInput().value).toBe('쓰던 사유')
      expectNoRequest()
    })
  })

  it('빈 사유를 고쳐 보낸 재요청이 실패하면 지난 사유 오류는 지우고 사유 칸과 글은 남긴다', async () => {
    vi.mocked(reopenIssue).mockRejectedValueOnce(new ApiError(422))
    const { props } = renderReview()
    await click('재요청')
    await click('재요청 보내기')

    expect(screen.getByRole('alert').textContent).toBe('사유는 1~2,000자로 써 주세요')
    expectNoRequest()

    fillReason('아직 버튼이 겹쳐요')
    await click('재요청 보내기')

    expect(reopenIssue).toHaveBeenCalledExactlyOnceWith(issue.id, {
      versionId,
      reason: '아직 버튼이 겹쳐요',
      attemptId: latestAttempt.id,
    })
    expect(screen.queryByText('사유는 1~2,000자로 써 주세요')).toBeNull()
    expect(screen.getByRole('alert').textContent).toBe('입력한 내용을 확인해 주세요')
    expect(screen.getByLabelText('재요청 사유')).toBe(reasonInput())
    expect(reasonInput().value).toBe('아직 버튼이 겹쳐요')
    expect(props.onChanged).not.toHaveBeenCalled()
  })

  it.each(['OPEN', 'IN_PROGRESS', 'READY_FOR_REVIEW'] as const)(
    '%s에서 철회는 attemptId 없이 보낸다',
    async (status) => {
      renderReview({ issue: { ...issue, status } })
      await click('철회')
      fillReason('  더 이상 필요 없어요  ')
      await click('철회하기')
      expect(withdrawIssue).toHaveBeenCalledExactlyOnceWith(issue.id, { versionId, reason: '더 이상 필요 없어요' })
    },
  )

  it.each(['VERIFIED', 'WITHDRAWN'] as const)(
    '%s의 다시 열기는 고쳤어요 이력이 없어도 attemptId 없이 보낸다',
    async (status) => {
      renderReview({ issue: { ...issue, status, attempts: [] } })
      await click('다시 열기')
      fillReason('  다시 확인해 주세요  ')
      await click('다시 열기')
      expect(reopenIssue).toHaveBeenCalledExactlyOnceWith(issue.id, {
        versionId,
        reason: '다시 확인해 주세요',
        attemptId: undefined,
      })
    },
  )

  it.each(failures)(
    '확인 완료의 %s 실패도 안내·새로 불러오기 후 다시 누를 수 있다',
    async (_, failure, message, refreshCount) => {
      vi.mocked(verifyIssue).mockRejectedValueOnce(failure)
      const { props } = renderReview()
      await click('확인 완료')
      expect(screen.getByRole('alert').textContent).toContain(message)
      expect(props.onRefresh).toHaveBeenCalledTimes(refreshCount)
      expect(props.onChanged).not.toHaveBeenCalled()
      expect(button('확인 완료').disabled).toBe(false)
      await click('확인 완료')
      expect(verifyIssue).toHaveBeenCalledTimes(2)
      expect(props.onChanged).toHaveBeenCalledTimes(1)
      expect(screen.queryByRole('alert')).toBeNull()
    },
  )

  it.each([new TypeError('Failed to fetch'), new ApiError(500)])(
    '새로 받은 횟수가 오르면 저장 여부 안내만 걷고 사유를 남긴다: %s',
    async (failure) => {
      vi.mocked(reopenIssue).mockRejectedValueOnce(failure)
      const { props, rerender } = renderReview()
      await click('재요청')
      fillReason('쓰던 사유')
      await click('재요청 보내기')
      rerender(<IssueReview {...props} issue={{ ...issue }} />)
      expect(screen.getByRole('alert').textContent).toBe(unconfirmedMessage)
      rerender(<IssueReview {...props} issue={{ ...issue }} fetchCount={4} />)
      expect(screen.queryByRole('alert')).toBeNull()
      expect(reasonInput().value).toBe('쓰던 사유')
      expect(reopenIssue).toHaveBeenCalledTimes(1)
    },
  )

  it.each([
    ['재요청', 'READY_FOR_REVIEW', 'VERIFIED', '다시 열기'],
    ['철회', 'OPEN', 'WITHDRAWN', '다시 열기'],
    ['다시 열기', 'VERIFIED', 'IN_PROGRESS', '철회'],
  ] as const)(
    '%s 사유를 쓰던 중 %s에서 %s로 바뀌면 칸을 감추고 허용된 버튼을 보인다',
    async (name, before, after, nextButton) => {
      const { props, rerender } = renderReview({ issue: { ...issue, status: before } })
      await click(name)
      fillReason()
      rerender(<IssueReview {...props} issue={{ ...issue, status: after }} fetchCount={4} />)
      expect(screen.queryByRole('textbox')).toBeNull()
      expect(screen.getAllByRole('button').map((item) => item.textContent)).toEqual([nextButton])
      expectNoRequest()
    },
  )

  it.each([
    ['재요청', 'READY_FOR_REVIEW', 'VERIFIED', '다시 열기', '다시 여는 사유'],
    ['철회', 'OPEN', 'WITHDRAWN', '다시 열기', '다시 여는 사유'],
    ['다시 열기', 'WITHDRAWN', 'OPEN', '철회', '철회 사유'],
  ] as const)(
    '%s 사유를 쓰다가 %s에서 %s로 바뀌어 다른 동작을 펴면 빈 칸에서 시작한다',
    async (action, before, after, nextAction, label) => {
      const { props, rerender } = renderReview({ issue: { ...issue, status: before } })
      await click(action)
      fillReason('앞 동작에만 쓸 사유')

      rerender(<IssueReview {...props} issue={{ ...issue, status: after }} fetchCount={4} />)
      expect(screen.queryByRole('textbox')).toBeNull()
      await click(nextAction)

      expect(screen.getByLabelText(label)).toBe(reasonInput())
      expect(reasonInput().value).toBe('')
      expectNoRequest()
    },
  )

  it('철회 응답이 끊긴 뒤 철회 상태를 새로 받으면 다시 여는 사유는 비어 있다', async () => {
    vi.mocked(withdrawIssue).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const { props, rerender } = renderReview({ issue: { ...issue, status: 'OPEN', attempts: [] } })
    await click('철회')
    fillReason('더 이상 필요 없어요')
    await click('철회하기')
    expect(screen.getByRole('alert').textContent).toBe(unconfirmedMessage)
    expect(props.onRefresh).toHaveBeenCalledTimes(1)

    rerender(<IssueReview {...props} issue={{ ...props.issue, status: 'WITHDRAWN' }} fetchCount={4} />)
    expect(screen.queryByRole('textbox')).toBeNull()
    await click('다시 열기')
    expect(reasonInput().value).toBe('')
    fillReason('다시 필요해졌어요')
    await click('다시 열기')

    expect(withdrawIssue).toHaveBeenCalledExactlyOnceWith(issue.id, { versionId, reason: '더 이상 필요 없어요' })
    expect(reopenIssue).toHaveBeenCalledExactlyOnceWith(issue.id, {
      versionId,
      reason: '다시 필요해졌어요',
      attemptId: undefined,
    })
  })

  it.each([
    ['재요청', 'READY_FOR_REVIEW', '재요청 보내기', false],
    ['철회', 'READY_FOR_REVIEW', '철회하기', false],
    ['철회', 'OPEN', '철회하기', true],
  ] as const)(
    '%s 사유를 쓰는 %s에 새 고쳤어요가 오면 칸이 닫히고 같은 동작을 다시 펴면 사유가 남는다(보내기=%s, 첫 줄=%s)',
    async (action, status, submit, firstAttempt) => {
      const currentIssue: Issue = { ...issue, status, attempts: firstAttempt ? [] : issue.attempts }
      const { props, rerender } = renderReview({ issue: currentIssue })
      await click(action)
      fillReason('쓰던 사유')
      const refreshed: Issue = {
        ...currentIssue,
        status: 'READY_FOR_REVIEW',
        attempts: [...currentIssue.attempts, { ...latestAttempt, id: 'attempt-new' }],
      }

      rerender(<IssueReview {...props} issue={refreshed} fetchCount={4} />)

      expect(screen.queryByRole('textbox')).toBeNull()
      expect(screen.getAllByRole('button').map((item) => item.textContent)).toEqual(['재요청', '철회', '확인 완료'])
      expectNoRequest()
      await click(action)
      expect(reasonInput().value).toBe('쓰던 사유')
      await click(submit)
      if (action === '철회') {
        expect(withdrawIssue).toHaveBeenCalledExactlyOnceWith(issue.id, { versionId, reason: '쓰던 사유' })
        expect(reopenIssue).not.toHaveBeenCalled()
        return
      }
      expect(reopenIssue).toHaveBeenCalledExactlyOnceWith(issue.id, {
        versionId,
        reason: '쓰던 사유',
        attemptId: 'attempt-new',
      })
      expect(withdrawIssue).not.toHaveBeenCalled()
    },
  )

  it.each(reasonActions)(
    '가장 최근 줄의 id가 같으면 새로 받은 이력에서도 $name 사유 칸이 그대로 남는다',
    async (action) => {
      const { props, rerender } = renderReview({ issue: { ...issue, status: action.status } })
      await click(action.name)
      fillReason('쓰던 사유')

      rerender(
        <IssueReview
          {...props}
          issue={{ ...props.issue, attempts: props.issue.attempts.map((attempt) => ({ ...attempt })) }}
          fetchCount={4}
        />,
      )

      expect(screen.getByLabelText(action.label)).toBe(reasonInput())
      expect(reasonInput().value).toBe('쓰던 사유')
      expectNoRequest()
    },
  )

  it('새 버전 게시로 상태만 바뀌고 마지막 줄이 같으면 철회 사유 칸은 닫히지 않는다', async () => {
    const { props, rerender } = renderReview()
    await click('철회')
    fillReason('쓰던 철회 사유')

    rerender(
      <IssueReview
        {...props}
        issue={{ ...issue, status: 'IN_PROGRESS', attempts: issue.attempts.map((attempt) => ({ ...attempt })) }}
        versionId={latestVersionId}
        fetchCount={4}
      />,
    )

    expect(screen.getByLabelText('철회 사유')).toBe(reasonInput())
    expect(reasonInput().value).toBe('쓰던 철회 사유')
    expectNoRequest()
    await click('철회하기')
    expect(withdrawIssue).toHaveBeenCalledExactlyOnceWith(issue.id, {
      versionId: latestVersionId,
      reason: '쓰던 철회 사유',
    })
  })

  it('재요청의 ATTEMPT_CHANGED 뒤 새로 받은 마지막 줄을 보고 다시 보낸다', async () => {
    vi.mocked(reopenIssue).mockRejectedValueOnce(new ApiError(409, 'ATTEMPT_CHANGED'))
    const { props, rerender } = renderReview()
    await click('재요청')
    fillReason('쓰던 사유')
    await click('재요청 보내기')
    rerender(
      <IssueReview
        {...props}
        issue={{ ...issue, attempts: [...issue.attempts, { ...latestAttempt, id: 'attempt-new' }] }}
        fetchCount={4}
      />,
    )
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getAllByRole('button').map((item) => item.textContent)).toEqual(['재요청', '철회', '확인 완료'])
    expect(reopenIssue).toHaveBeenCalledTimes(1)
    await click('재요청')
    expect(reasonInput().value).toBe('쓰던 사유')
    await click('재요청 보내기')
    expect(reopenIssue).toHaveBeenLastCalledWith(issue.id, { versionId, reason: '쓰던 사유', attemptId: 'attempt-new' })
  })

  it('버튼을 감춰도 최신 버전 안내가 남고 이동하면 새 버전에 쓰던 사유를 보낸다', async () => {
    vi.mocked(withdrawIssue).mockRejectedValueOnce(new ApiError(409, 'VERSION_CHANGED'))
    const { props, rerender } = renderReview()
    await click('철회')
    fillReason('쓰던 사유')
    await click('철회하기')
    rerender(<IssueReview {...props} canWrite={false} />)
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('region', { name: '확인하기' })).toBeNull()
    expect(props.onGoLatest).not.toHaveBeenCalled()
    await click('최신 버전 보기')
    expect(props.onGoLatest).toHaveBeenCalledTimes(1)
    expect(props.onRefresh).toHaveBeenCalledTimes(1)
    rerender(
      <IssueReview {...props} versionId={latestVersionId} issue={{ ...issue, status: 'IN_PROGRESS' }} fetchCount={4} />,
    )
    expect(reasonInput().value).toBe('쓰던 사유')
    await click('철회하기')
    expect(withdrawIssue).toHaveBeenLastCalledWith(issue.id, { versionId: latestVersionId, reason: '쓰던 사유' })
  })

  it('비교 화면의 VERSION_CHANGED는 대체 안내를 쓰고 상태가 바뀌어 버튼이 없어도 남는다', async () => {
    vi.mocked(verifyIssue).mockRejectedValueOnce(new ApiError(409, 'VERSION_CHANGED'))
    const { props, rerender } = renderReview({
      reviewOnly: true,
      versionChangedNotice: <a href="/projects/project-1/review">새 버전이 올라왔어요. 검수실로 돌아가기</a>,
    })
    await click('확인 완료')
    expect(screen.getByRole('link').getAttribute('href')).toBe('/projects/project-1/review')
    expect(screen.queryByRole('button', { name: '최신 버전 보기' })).toBeNull()
    expect(props.onRefresh).toHaveBeenCalledTimes(1)
    expect(props.onGoLatest).not.toHaveBeenCalled()
    rerender(<IssueReview {...props} issue={{ ...issue, status: 'IN_PROGRESS' }} fetchCount={4} />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByRole('alert').textContent).toBe('새 버전이 올라왔어요. 검수실로 돌아가기')
  })
})

describe('IssueReview 쓰던 글 알림', () => {
  it.each(reasonActions)(
    '$name 사유의 빈 글과 공백은 알리지 않고 글을 쓰면 알리며 취소하면 지운다',
    async ({ name, label, status }) => {
      const onDraftChange = vi.fn()
      renderReview({ issue: { ...issue, status }, onDraftChange })
      expect(onDraftChange).toHaveBeenLastCalledWith(false)
      await click(name)
      fillReason(' \n\t ')
      expect(onDraftChange).not.toHaveBeenCalledWith(true)
      fillReason('남길 사유')
      expect(onDraftChange).toHaveBeenLastCalledWith(true)
      fillReason(' \n\t ')
      expect(onDraftChange).toHaveBeenLastCalledWith(false)
      fillReason('취소할 사유')
      await click('취소')
      expect(onDraftChange).toHaveBeenLastCalledWith(false)
      await click(name)
      expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: label }).value).toBe('')
      expectNoRequest()
    },
  )

  it.each(reasonActions)(
    '$name 사유를 보내는 동안 알림이 남고 저장되면 꺼진다',
    async ({ name, status, api, submit, savedStatus }) => {
      let resolve!: (value: Issue) => void
      vi.mocked(api).mockReturnValueOnce(
        new Promise((done) => {
          resolve = done
        }),
      )
      const onDraftChange = vi.fn()
      renderReview({ issue: { ...issue, status }, onDraftChange })
      await click(name)
      fillReason('보내는 사유')
      await click(submit)
      expect(api).toHaveBeenCalledTimes(1)
      expect(reasonInput().readOnly).toBe(true)
      expect(onDraftChange).toHaveBeenLastCalledWith(true)
      await act(async () => {
        resolve({ ...issue, status: savedStatus })
      })
      expect(onDraftChange).toHaveBeenLastCalledWith(false)
      expect(screen.queryByRole('textbox')).toBeNull()
    },
  )

  it('사유가 없는 확인 완료도 보내는 동안 알리고 저장되면 꺼진다', async () => {
    let resolve!: (value: Issue) => void
    vi.mocked(verifyIssue).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      }),
    )
    const onDraftChange = vi.fn()
    renderReview({ onDraftChange })
    expect(onDraftChange).toHaveBeenLastCalledWith(false)
    await click('확인 완료')
    expect(verifyIssue).toHaveBeenCalledTimes(1)
    expect(onDraftChange).toHaveBeenLastCalledWith(true)
    await act(async () => {
      resolve({ ...issue, status: 'VERIFIED' })
    })
    expect(onDraftChange).toHaveBeenLastCalledWith(false)
  })

  it.each(['읽기 전용', '권한 변경', '새 고쳤어요', '상태 변경'] as const)(
    '%s으로 사유 칸이 감춰져도 남은 사유를 알리고 사라지면 꺼진다',
    async (change) => {
      const onDraftChange = vi.fn()
      const { props, rerender, unmount } = renderReview({ onDraftChange })
      await click('재요청')
      fillReason('감춰져도 남는 사유')
      const changedIssue: Issue = {
        ...issue,
        canReview: change !== '권한 변경',
        status: change === '상태 변경' ? 'IN_PROGRESS' : issue.status,
        attempts:
          change === '새 고쳤어요' ? [...issue.attempts, { ...latestAttempt, id: 'new-attempt' }] : issue.attempts,
      }
      rerender(<IssueReview {...props} canWrite={change !== '읽기 전용'} issue={changedIssue} />)
      expect(screen.queryByRole('textbox', { name: '재요청 사유' })).toBeNull()
      expect(onDraftChange).toHaveBeenLastCalledWith(true)
      unmount()
      expect(onDraftChange).toHaveBeenLastCalledWith(false)
    },
  )

  it('저장 여부를 모르는 실패 뒤에도 사유 알림이 남는다', async () => {
    vi.mocked(reopenIssue).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const onDraftChange = vi.fn()
    renderReview({ onDraftChange })
    await click('재요청')
    fillReason('남겨야 할 사유')
    await click('재요청 보내기')
    expect(screen.getByText(unconfirmedMessage)).toBeTruthy()
    expect(onDraftChange).toHaveBeenLastCalledWith(true)
  })
})
