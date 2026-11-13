import { act, fireEvent, render, screen, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { MemoryRouter } from 'react-router'
import { ApiError } from '../api/client.ts'
import { type IssueDetail as Issue, submitResolution } from '../api/issues.ts'
import { ResolutionForm } from './ResolutionForm.tsx'

vi.mock('../api/issues.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/issues.ts')>()),
  submitResolution: vi.fn(),
}))

const versionId = '22222222-2222-4222-8222-222222222222'
const latestVersionId = '33333333-3333-4333-8333-333333333333'
const screens: ComponentProps<typeof ResolutionForm>['screens'] = [
  { screenId: 'screen-mobile', name: '상품', viewport: 'MOBILE' },
  { screenId: 'screen-pc', name: '상품', viewport: 'PC' },
]
const issue: Issue = {
  currentVersion: { id: versionId, status: 'IN_REVIEW' },
  id: '11111111-1111-4111-8111-111111111111',
  projectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  number: 14,
  title: '버튼을 옮겨 주세요',
  body: '오른쪽으로 옮겨 주세요',
  status: 'OPEN',
  category: 'BUG',
  scope: 'IN_SCOPE',
  dueDate: null,
  authorName: '클라이언트',
  createdAt: '2026-11-10T00:00:00.000Z',
  commentCount: 0,
  originVersion: { id: 'origin-version', number: 1 },
  origin: {
    screenId: 'screen-pc',
    screenName: '상품',
    viewport: 'PC',
    asset: { id: 'asset-1', width: 1200, height: 800 },
    xRatio: 0.3,
    yRatio: 0.5,
  },
  isMine: false,
  canReview: false,
  attempts: [],
  attachments: [],
  comments: [],
}
const saved: Issue = { ...issue, status: 'READY_FOR_REVIEW' }
const unconfirmedMessage = '저장됐는지 확인하지 못했어요. 쪽지에 바뀐 내용이 보이지 않으면 다시 보내 주세요.'
const staleMessage = '쪽지 상태가 바뀌었어요. 새로 불러왔어요.'

const renderForm = (overrides: Partial<ComponentProps<typeof ResolutionForm>> = {}) => {
  const props = {
    issue,
    versionId,
    canWrite: true,
    isDeveloper: true,
    screens,
    fetchCount: 3,
    onChanged: vi.fn(),
    onRefresh: vi.fn(),
    onGoLatest: vi.fn(),
    ...overrides,
  }
  return { ...render(<ResolutionForm {...props} />, { wrapper: MemoryRouter }), props }
}
const summaryInput = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: '고친 내용' })
const screenInput = () => screen.getByRole<HTMLSelectElement>('combobox', { name: '고친 화면' })
const submitButton = () => screen.getByRole<HTMLButtonElement>('button', { name: '고쳤어요 보내기' })
const fillSummary = (value = '  버튼을 오른쪽으로 옮겼어요  ') => {
  fireEvent.change(summaryInput(), { target: { value } })
}
const selectScreen = (value = 'screen-mobile') => {
  fireEvent.change(screenInput(), { target: { value } })
}
const submit = async () => {
  await act(async () => {
    fireEvent.click(submitButton())
  })
}

beforeEach(() => {
  vi.mocked(submitResolution).mockReset().mockResolvedValue(saved)
})

describe('ResolutionForm', () => {
  it.each(['OPEN', 'IN_PROGRESS'] as const)('%s인 개발자에게만 고쳤어요 입력이 보인다', (status) => {
    renderForm({ issue: { ...issue, status } })
    const form = within(screen.getByRole('form', { name: '고쳤어요 보내기' }))

    expect(form.getByRole('combobox', { name: '고친 화면' })).toBe(screenInput())
    expect(form.getByRole('textbox', { name: '고친 내용' })).toBe(summaryInput())
    expect(summaryInput().maxLength).toBe(2000)
    expect(submitButton().disabled).toBe(false)
    expect(submitResolution).not.toHaveBeenCalled()
  })

  it.each(['OPEN', 'IN_PROGRESS', 'READY_FOR_REVIEW', 'VERIFIED', 'WITHDRAWN'] as const)(
    '%s여도 클라이언트에게는 아무것도 보이지 않는다',
    (status) => {
      const { container } = renderForm({ isDeveloper: false, issue: { ...issue, status, canReview: true } })
      expect(container.innerHTML).toBe('')
      expect(submitResolution).not.toHaveBeenCalled()
    },
  )

  it.each(['READY_FOR_REVIEW', 'VERIFIED', 'WITHDRAWN'] as const)('%s에는 입력과 보내기 버튼이 없다', (status) => {
    renderForm({ issue: { ...issue, status } })
    expect(screen.queryByRole('form')).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it.each(['OPEN', 'IN_PROGRESS'] as const)('%s여도 읽기 전용이면 입력이 없다', (status) => {
    renderForm({ canWrite: false, issue: { ...issue, status } })
    expect(screen.queryByRole('form')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('핀 쪽지는 받은 화면 순서와 PC·모바일 이름을 쓰고 시작한 화면을 기본으로 고른다', () => {
    renderForm()
    expect(
      within(screenInput())
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['화면을 골라 주세요', '상품 · 모바일', '상품 · PC'])
    expect(screenInput().value).toBe('screen-pc')
    expect(summaryInput().value).toBe('')
  })

  it.each([{ availableScreens: [] }, { availableScreens: [screens[0]] }])(
    '시작한 화면이 현재 화면 목록 $availableScreens에 없으면 첫 선택지를 보여 준다',
    ({ availableScreens }) => {
      renderForm({ screens: availableScreens })
      expect(screenInput().value).toBe('')
      expect(screenInput().selectedIndex).toBe(0)
    },
  )

  it('위치 없는 쪽지는 화면 없음이 기본값이고 화면 목록 순서를 유지한다', () => {
    renderForm({ issue: { ...issue, origin: null } })
    expect(screenInput().value).toBe('')
    expect(
      within(screenInput())
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['화면 없음', '상품 · 모바일', '상품 · PC'])
  })

  it('핀 쪽지에서 화면을 비우면 오류를 알리고 보내지 않으며 선택하면 보낼 수 있다', async () => {
    const { props } = renderForm()
    fillSummary()
    selectScreen('')
    await submit()

    expect(screen.getByRole('alert').textContent).toBe('고친 화면을 골라 주세요')
    expect(submitResolution).not.toHaveBeenCalled()
    expect(props.onChanged).not.toHaveBeenCalled()
    expect(props.onRefresh).not.toHaveBeenCalled()

    selectScreen()
    await submit()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(submitResolution).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['빈 글', ''],
    ['공백', ' \n\t '],
    ['2,001자', '가'.repeat(2001)],
  ])('%s 설명은 보내지 않는다', async (_, summary) => {
    const { props } = renderForm()
    // change로 HTML 길이 제한을 넘어도 제출 검사가 막는지 확인한다.
    fillSummary(summary)
    await submit()

    expect(screen.getByRole('alert').textContent).toBe('고친 내용은 1~2,000자로 써 주세요')
    expect(submitResolution).not.toHaveBeenCalled()
    expect(props.onChanged).not.toHaveBeenCalled()
    expect(summaryInput().value).toBe(summary)
  })

  it('빈 설명을 고쳐 보낸 요청이 실패하면 지난 내용 오류는 지우고 설명과 화면 선택은 남긴다', async () => {
    vi.mocked(submitResolution).mockRejectedValueOnce(new ApiError(422))
    const { props } = renderForm()
    selectScreen()
    await submit()

    expect(screen.getByRole('alert').textContent).toBe('고친 내용은 1~2,000자로 써 주세요')
    expect(submitResolution).not.toHaveBeenCalled()

    fillSummary('버튼을 오른쪽으로 옮겼어요')
    await submit()

    expect(submitResolution).toHaveBeenCalledExactlyOnceWith(issue.id, {
      versionId,
      summary: '버튼을 오른쪽으로 옮겼어요',
      screenId: 'screen-mobile',
    })
    expect(screen.queryByText('고친 내용은 1~2,000자로 써 주세요')).toBeNull()
    expect(screen.getByRole('alert').textContent).toBe('입력한 내용을 확인해 주세요')
    expect(summaryInput().value).toBe('버튼을 오른쪽으로 옮겼어요')
    expect(screenInput().value).toBe('screen-mobile')
    expect(props.onChanged).not.toHaveBeenCalled()
  })

  it.each([1, 2000])('앞뒤 공백을 뺀 설명 %i자를 정확한 화면·버전과 한 번 보낸다', async (length) => {
    const { props } = renderForm()
    const summary = '가'.repeat(length)
    fillSummary(` \n${summary}\t `)
    selectScreen()
    await submit()

    expect(submitResolution).toHaveBeenCalledExactlyOnceWith(issue.id, {
      versionId,
      summary,
      screenId: 'screen-mobile',
    })
    expect(props.onChanged).toHaveBeenCalledExactlyOnceWith(saved)
    expect(props.onRefresh).not.toHaveBeenCalled()
  })

  it.each(['', 'screen-mobile'])('위치 없는 쪽지는 화면 선택 %s로 보낼 수 있다', async (screenId) => {
    renderForm({ issue: { ...issue, origin: null }, screens: screenId ? screens : [] })
    fillSummary('기능을 고쳤어요')
    if (screenId) selectScreen(screenId)
    await submit()
    expect(submitResolution).toHaveBeenCalledExactlyOnceWith(issue.id, {
      versionId,
      summary: '기능을 고쳤어요',
      screenId: screenId || undefined,
    })
  })

  it('보내는 동안 선택·버튼은 잠기고 글은 읽기 전용이며 반복 클릭은 추가 요청을 보내지 않는다', async () => {
    let resolve!: (value: Issue) => void
    vi.mocked(submitResolution).mockReturnValueOnce(
      new Promise<Issue>((done) => {
        resolve = done
      }),
    )
    const { props } = renderForm()
    fillSummary()
    await submit()

    expect(submitButton().disabled).toBe(true)
    expect(screenInput().disabled).toBe(true)
    expect(summaryInput().readOnly).toBe(true)
    expect(summaryInput().disabled).toBe(false)
    expect(props.onChanged).not.toHaveBeenCalled()
    await submit()
    expect(submitResolution).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolve(saved)
    })
    expect(submitButton().disabled).toBe(false)
    expect(screenInput().disabled).toBe(false)
    expect(summaryInput().readOnly).toBe(false)
    expect(props.onChanged).toHaveBeenCalledExactlyOnceWith(saved)
  })

  it('성공 후 같은 쪽지가 다시 접수되면 설명은 비고 화면은 기본값으로 돌아온다', async () => {
    const { props, rerender } = renderForm()
    fillSummary()
    selectScreen()
    await submit()
    rerender(<ResolutionForm {...props} issue={saved} />)
    expect(screen.queryByRole('form')).toBeNull()
    rerender(<ResolutionForm {...props} issue={{ ...issue }} />)
    expect(summaryInput().value).toBe('')
    expect(screenInput().value).toBe('screen-pc')
    expect(submitResolution).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['422', new ApiError(422), '입력한 내용을 확인해 주세요', 0],
    ['403', new ApiError(403), '잠시 뒤 다시 시도해 주세요', 1],
    ['404', new ApiError(404), '찾을 수 없어요. 화면을 새로 고쳐 주세요', 1],
    ['VERSION_CHANGED', new ApiError(409, 'VERSION_CHANGED'), '새 버전이 올라왔어요. 쓰던 글은 그대로 남아 있어요.', 1],
    ['VERSION_NOT_IN_REVIEW', new ApiError(409, 'VERSION_NOT_IN_REVIEW'), '승인된 버전이라 더 쓸 수 없어요.', 1],
    ['ISSUE_STATE_CHANGED', new ApiError(409, 'ISSUE_STATE_CHANGED'), staleMessage, 1],
    ['연결 실패', new TypeError('Failed to fetch'), unconfirmedMessage, 1],
    ['500', new ApiError(500), unconfirmedMessage, 1],
    ['503', new ApiError(503), unconfirmedMessage, 1],
  ] as const)(
    '%s 실패는 안내와 새로 불러오기 규칙을 지키고 글·화면을 남겨 다시 보낼 수 있다',
    async (_, failure, message, refreshCount) => {
      vi.mocked(submitResolution).mockRejectedValueOnce(failure)
      const { props } = renderForm()
      fillSummary('  고친 설명  ')
      selectScreen()
      await submit()

      expect(screen.getByRole('alert').textContent).toContain(message)
      expect(props.onRefresh).toHaveBeenCalledTimes(refreshCount)
      expect(props.onChanged).not.toHaveBeenCalled()
      expect(summaryInput().value).toBe('  고친 설명  ')
      expect(screenInput().value).toBe('screen-mobile')
      expect(submitButton().disabled).toBe(false)
      expect(screenInput().disabled).toBe(false)
      expect(summaryInput().readOnly).toBe(false)

      await submit()
      expect(submitResolution).toHaveBeenCalledTimes(2)
      expect(submitResolution).toHaveBeenLastCalledWith(issue.id, {
        versionId,
        summary: '고친 설명',
        screenId: 'screen-mobile',
      })
      expect(props.onChanged).toHaveBeenCalledExactlyOnceWith(saved)
      expect(screen.queryByRole('alert')).toBeNull()
    },
  )

  it.each([new TypeError('Failed to fetch'), new ApiError(500)])(
    '저장 여부 안내는 새로 받은 횟수가 오를 때 걷히고 글은 남는다: %s',
    async (failure) => {
      vi.mocked(submitResolution).mockRejectedValueOnce(failure)
      const { props, rerender } = renderForm()
      fillSummary('쓰던 글')
      selectScreen()
      await submit()
      rerender(<ResolutionForm {...props} issue={{ ...issue }} />)
      expect(screen.getByRole('alert').textContent).toBe(unconfirmedMessage)
      rerender(<ResolutionForm {...props} issue={{ ...issue }} fetchCount={4} />)
      expect(screen.queryByRole('alert')).toBeNull()
      expect(summaryInput().value).toBe('쓰던 글')
      expect(screenInput().value).toBe('screen-mobile')
      expect(submitResolution).toHaveBeenCalledTimes(1)
    },
  )

  it('새 객체로 새로 불러오거나 입력을 감췄다 보여도 쓰던 글과 선택이 남는다', () => {
    const { props, rerender } = renderForm()
    fillSummary('쓰던 글')
    selectScreen()
    rerender(<ResolutionForm {...props} issue={{ ...issue }} fetchCount={4} />)
    expect(summaryInput().value).toBe('쓰던 글')
    expect(screenInput().value).toBe('screen-mobile')
    rerender(<ResolutionForm {...props} canWrite={false} />)
    expect(screen.queryByRole('textbox')).toBeNull()
    rerender(<ResolutionForm {...props} canWrite={true} />)
    expect(summaryInput().value).toBe('쓰던 글')
    expect(screenInput().value).toBe('screen-mobile')
    expect(submitResolution).not.toHaveBeenCalled()
  })

  it('입력이 감춰져도 최신 버전 안내가 남고 이동 뒤 새 버전으로 쓰던 글을 보낸다', async () => {
    vi.mocked(submitResolution).mockRejectedValueOnce(new ApiError(409, 'VERSION_CHANGED'))
    const { props, rerender } = renderForm()
    fillSummary('쓰던 글')
    selectScreen()
    await submit()
    rerender(<ResolutionForm {...props} canWrite={false} />)
    expect(screen.queryByRole('form')).toBeNull()
    expect(props.onGoLatest).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '최신 버전 보기' }))
    expect(props.onGoLatest).toHaveBeenCalledTimes(1)
    expect(props.onRefresh).toHaveBeenCalledTimes(1)
    rerender(<ResolutionForm {...props} versionId={latestVersionId} issue={{ ...issue }} fetchCount={4} />)
    expect(summaryInput().value).toBe('쓰던 글')
    expect(screenInput().value).toBe('screen-mobile')
    await submit()
    expect(submitResolution).toHaveBeenLastCalledWith(issue.id, {
      versionId: latestVersionId,
      summary: '쓰던 글',
      screenId: 'screen-mobile',
    })
  })

  it('고른 화면이 새 목록에서 사라지면 선택을 비우고 핀 쪽지는 다시 고르기 전까지 보내지 않는다', async () => {
    const { props, rerender } = renderForm()
    fillSummary('쓰던 글')
    selectScreen()
    rerender(<ResolutionForm {...props} screens={[screens[1]]} />)
    expect(screenInput().value).toBe('')
    expect(summaryInput().value).toBe('쓰던 글')
    await submit()
    expect(submitResolution).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe('고친 화면을 골라 주세요')
  })
})
