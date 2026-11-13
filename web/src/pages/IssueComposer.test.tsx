import { act, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { MemoryRouter } from 'react-router'
import { ApiError } from '../api/client.ts'
import { createIssue, type IssueDetail } from '../api/issues.ts'
import { IssueComposer } from './IssueComposer.tsx'

vi.mock('../api/issues.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/issues.ts')>()),
  createIssue: vi.fn(),
}))

const projectId = '11111111-1111-4111-8111-111111111111'
const versionId = '22222222-2222-4222-8222-222222222222'
const pin = {
  screenId: '33333333-3333-4333-8333-333333333333',
  xRatio: 0,
  yRatio: 1,
  label: '상품 상세 · PC',
}
const saved: IssueDetail = {
  projectId,
  canReview: false,
  attempts: [],
  id: '44444444-4444-4444-8444-444444444444',
  number: 1,
  title: '버튼을 옮겨 주세요',
  body: '  첫째 줄\n둘째 줄  ',
  status: 'OPEN',
  category: 'BUG',
  scope: 'IN_SCOPE',
  dueDate: null,
  authorName: '클라이언트',
  createdAt: '2026-11-11T00:00:00.000Z',
  commentCount: 0,
  originVersion: { id: versionId, number: 1 },
  origin: null,
  isMine: true,
  attachments: [],
  comments: [],
}

const renderComposer = (overrides: Partial<ComponentProps<typeof IssueComposer>> = {}) => {
  const props = {
    projectId,
    versionId,
    canSubmit: true,
    versionLoaded: true,
    onClearPin: vi.fn(),
    onCancel: vi.fn(),
    onCreated: vi.fn(),
    onLockChange: vi.fn(),
    onGoLatest: vi.fn(),
    ...overrides,
  }
  const view = render(<IssueComposer {...props} />, { wrapper: MemoryRouter })
  const title = screen.getByRole<HTMLInputElement>('textbox', { name: '제목 (필수)' })
  const body = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '내용' })
  return { ...view, props, title, body }
}

const fillDraft = (title = saved.title, body = saved.body) => {
  fireEvent.change(screen.getByRole('textbox', { name: '제목 (필수)' }), { target: { value: title } })
  fireEvent.change(screen.getByRole('textbox', { name: '내용' }), { target: { value: body } })
}

const send = async (name = '쪽지 남기기') => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }))
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

beforeEach(() => {
  vi.mocked(createIssue).mockReset().mockResolvedValue(saved)
})

describe('IssueComposer', () => {
  it('제목 위에 분류 선택지가 버그·디자인·문구·기타 순서로 있고 기본값은 버그다', () => {
    const { title } = renderComposer()
    const category = screen.getByRole<HTMLSelectElement>('combobox', { name: '분류' })

    expect(screen.getByLabelText('분류')).toBe(category)
    expect(category.tagName).toBe('SELECT')
    expect(Array.from(category.options, (option) => [option.value, option.textContent])).toEqual([
      ['BUG', '버그'],
      ['DESIGN', '디자인'],
      ['COPY', '문구'],
      ['OTHER', '기타'],
    ])
    expect(category.value).toBe('BUG')
    expect(category.disabled).toBe(false)
    expect(category.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
  })

  it.each([
    ['버그', 'BUG'],
    ['디자인', 'DESIGN'],
    ['문구', 'COPY'],
    ['기타', 'OTHER'],
  ] as const)('%s를 고르기만 하면 보내지 않고 쪽지를 남길 때 %s로 보낸다', async (_label, value) => {
    const result = { ...saved, category: value }
    vi.mocked(createIssue).mockResolvedValueOnce(result)
    const { props } = renderComposer()
    fillDraft()
    const category = screen.getByRole<HTMLSelectElement>('combobox', { name: '분류' })
    // 버그도 다른 분류에서 돌아와 고를 수 있어야 한다.
    fireEvent.change(category, { target: { value: 'DESIGN' } })
    fireEvent.change(category, { target: { value } })
    expect(category.value).toBe(value)
    expect(createIssue).not.toHaveBeenCalled()

    await send()

    expect(createIssue).toHaveBeenCalledExactlyOnceWith(projectId, {
      requestId: expect.any(String),
      versionId,
      title: saved.title,
      body: saved.body,
      category: value,
      pin: undefined,
    })
    expect(props.onCreated).toHaveBeenCalledExactlyOnceWith(result)
  })

  it('분류를 따로 고르지 않으면 BUG로 보낸다', async () => {
    renderComposer()
    fillDraft()

    await send()

    expect(createIssue).toHaveBeenCalledExactlyOnceWith(projectId, expect.objectContaining({ category: 'BUG' }))
  })

  it('보내는 중에는 분류가 잠기고 고른 값이 남으며 성공하면 잠금이 풀린다', async () => {
    const pending = deferred<IssueDetail>()
    vi.mocked(createIssue).mockReturnValueOnce(pending.promise)
    renderComposer()
    fillDraft()
    const category = screen.getByRole<HTMLSelectElement>('combobox', { name: '분류' })
    fireEvent.change(category, { target: { value: 'COPY' } })

    await send()

    expect(category.disabled).toBe(true)
    expect(category.value).toBe('COPY')
    expect(createIssue).toHaveBeenCalledExactlyOnceWith(projectId, expect.objectContaining({ category: 'COPY' }))
    await act(async () => pending.resolve({ ...saved, category: 'COPY' }))
    expect(category.disabled).toBe(false)
  })

  it.each([
    ['연결 끊김', new TypeError('Failed to fetch')],
    ['서버 오류', new ApiError(503)],
  ])('%s 뒤 분류를 잠그고 읽기 전용에서도 처음 분류 그대로 다시 보낸다', async (_label, error) => {
    const pending = deferred<IssueDetail>()
    vi.mocked(createIssue).mockRejectedValueOnce(error).mockReturnValueOnce(pending.promise)
    const { props, rerender } = renderComposer()
    fillDraft()
    const category = screen.getByRole<HTMLSelectElement>('combobox', { name: '분류' })
    fireEvent.change(category, { target: { value: 'OTHER' } })
    await send()
    const firstRequest = structuredClone(vi.mocked(createIssue).mock.calls[0])

    expect(firstRequest[1].category).toBe('OTHER')
    expect(category.disabled).toBe(true)
    expect(category.value).toBe('OTHER')
    rerender(<IssueComposer {...props} canSubmit={false} versionId="past-version" />)
    expect(category.disabled).toBe(true)
    expect(category.value).toBe('OTHER')

    await send('다시 보내기')

    expect(category.disabled).toBe(true)
    expect(category.value).toBe('OTHER')
    expect(createIssue).toHaveBeenCalledTimes(2)
    expect(vi.mocked(createIssue).mock.calls[1]).toEqual(firstRequest)
    await act(async () => pending.resolve({ ...saved, category: 'OTHER' }))
    expect(category.disabled).toBe(false)
  })

  it.each([401, 403, 404, 422, 500])(
    '잠긴 요청의 재시도가 %i로 실패해도 처음 분류를 잠근 채 유지한다',
    async (status) => {
      vi.mocked(createIssue)
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockRejectedValueOnce(new ApiError(status))
      renderComposer()
      fillDraft()
      const category = screen.getByRole<HTMLSelectElement>('combobox', { name: '분류' })
      fireEvent.change(category, { target: { value: 'DESIGN' } })
      await send()
      const firstRequest = structuredClone(vi.mocked(createIssue).mock.calls[0])

      await send('다시 보내기')

      expect(category.disabled).toBe(true)
      expect(category.value).toBe('DESIGN')
      await send('다시 보내기')
      expect(firstRequest[1].category).toBe('DESIGN')
      expect(vi.mocked(createIssue).mock.calls).toEqual([firstRequest, firstRequest, firstRequest])
    },
  )

  it.each(['취소', 'VERSION_CHANGED', 'VERSION_NOT_IN_REVIEW', 'REQUEST_ID_REUSED'])(
    '%s로 잠금이 풀리면 분류를 다시 골라 바뀐 값으로 보낸다',
    async (action) => {
      vi.mocked(createIssue).mockRejectedValueOnce(new TypeError('Failed to fetch'))
      if (action !== '취소') vi.mocked(createIssue).mockRejectedValueOnce(new ApiError(409, action))
      const { props, rerender } = renderComposer()
      fillDraft()
      const category = screen.getByRole<HTMLSelectElement>('combobox', { name: '분류' })
      fireEvent.change(category, { target: { value: 'DESIGN' } })
      await send()
      expect(category.disabled).toBe(true)

      await send(action === '취소' ? '취소' : '다시 보내기')

      expect(props.onCancel).toHaveBeenCalledTimes(action === '취소' ? 1 : 0)
      expect(category.disabled).toBe(false)
      expect(category.value).toBe('DESIGN')
      rerender(<IssueComposer {...props} versionId="latest-version" />)
      fireEvent.change(category, { target: { value: 'COPY' } })
      await send()

      expect(category.value).toBe('COPY')
      expect(createIssue).toHaveBeenCalledTimes(action === '취소' ? 2 : 3)
      expect(createIssue).toHaveBeenLastCalledWith(
        projectId,
        expect.objectContaining({ versionId: 'latest-version', category: 'COPY' }),
      )
    },
  )

  it.each([401, 403, 404, 422])('처음 요청이 %i로 실패해도 고른 분류가 남고 잠기지 않는다', async (status) => {
    vi.mocked(createIssue).mockRejectedValueOnce(new ApiError(status))
    renderComposer()
    fillDraft()
    const category = screen.getByRole<HTMLSelectElement>('combobox', { name: '분류' })
    fireEvent.change(category, { target: { value: 'OTHER' } })

    await send()

    expect(category.value).toBe('OTHER')
    expect(category.disabled).toBe(false)
    await send()
    expect(createIssue).toHaveBeenCalledTimes(2)
    expect(vi.mocked(createIssue).mock.calls[1][1].category).toBe('OTHER')
  })

  it.each([false, true])(
    '쓸 수 없고 versionLoaded=%s여도 고른 분류가 남고 돌아오면 그대로 보낸다',
    async (versionLoaded) => {
      const { props, rerender, title } = renderComposer()
      fillDraft()
      const category = screen.getByRole<HTMLSelectElement>('combobox', { name: '분류' })
      fireEvent.change(category, { target: { value: 'DESIGN' } })

      rerender(<IssueComposer {...props} canSubmit={false} versionLoaded={versionLoaded} versionId="past-version" />)

      expect(category.value).toBe('DESIGN')
      await act(async () => fireEvent.submit(title.form!))
      expect(createIssue).not.toHaveBeenCalled()
      rerender(<IssueComposer {...props} />)
      expect(category.value).toBe('DESIGN')
      await send()
      expect(createIssue).toHaveBeenCalledExactlyOnceWith(
        projectId,
        expect.objectContaining({ versionId, category: 'DESIGN' }),
      )
    },
  )

  it('제목 검사에 실패해도 고른 분류가 남고 제목을 고치면 그 분류로 보낸다', async () => {
    renderComposer()
    const category = screen.getByRole<HTMLSelectElement>('combobox', { name: '분류' })
    fireEvent.change(category, { target: { value: 'COPY' } })

    await send()

    expect(createIssue).not.toHaveBeenCalled()
    expect(category.value).toBe('COPY')
    expect(category.disabled).toBe(false)
    fillDraft()
    await send()
    expect(createIssue).toHaveBeenCalledExactlyOnceWith(projectId, expect.objectContaining({ category: 'COPY' }))
  })

  it.each([
    [false, '아직 사진을 불러오지 못했어요. 지금은 쪽지를 남길 수 없어요.'],
    [true, '읽기 전용인 버전을 보고 있어요. 검수 중인 최신 버전으로 돌아오면 남길 수 있어요.'],
  ] as const)(
    '쓸 수 없고 versionLoaded=%s이면 사진 상태에 맞는 안내만 보이며 글은 남는다',
    async (versionLoaded, message) => {
      const { props, rerender, title, body } = renderComposer()
      fillDraft()
      rerender(<IssueComposer {...props} canSubmit={false} versionLoaded={versionLoaded} />)

      expect(screen.getByText(message)).toBeTruthy()
      expect(screen.queryByText(versionLoaded ? /아직 사진을 불러오지 못했어요/ : /읽기 전용/)).toBeNull()
      expect(screen.queryByRole('button', { name: '쪽지 남기기' })).toBeNull()
      await act(async () => fireEvent.submit(title.form!))
      expect(createIssue).not.toHaveBeenCalled()
      expect(title.value).toBe(saved.title)
      expect(body.value).toBe(saved.body)

      rerender(<IssueComposer {...props} />)
      expect(screen.queryByText(/아직 사진을 불러오지 못했어요|읽기 전용/)).toBeNull()
      await send()
      expect(createIssue).toHaveBeenCalledExactlyOnceWith(
        projectId,
        expect.objectContaining({ title: saved.title, body: saved.body }),
      )
    },
  )

  it.each([false, true])('쓸 수 있으면 versionLoaded=%s여도 사진 대기와 읽기 전용 안내가 없다', (versionLoaded) => {
    renderComposer({ versionLoaded })
    expect(screen.queryByText(/아직 사진을 불러오지 못했어요|읽기 전용/)).toBeNull()
    expect(screen.getByRole('button', { name: '쪽지 남기기' })).toBeTruthy()
  })

  it.each(['다시 보내기', '취소'])('사진을 못 불러와도 잠긴 쪽지는 안내보다 앞서고 %s가 가능하다', async (action) => {
    vi.mocked(createIssue).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const { props, rerender, title, body } = renderComposer({ pin })
    fillDraft()
    await send()
    const firstRequest = structuredClone(vi.mocked(createIssue).mock.calls[0])
    rerender(
      <IssueComposer {...props} canSubmit={false} versionLoaded={false} versionId="other-version" pin={undefined} />,
    )

    expect(screen.queryByText(/아직 사진을 불러오지 못했어요|읽기 전용/)).toBeNull()
    expect(title.value).toBe(saved.title)
    expect(title.readOnly).toBe(true)
    expect(body.value).toBe(saved.body)
    expect(body.readOnly).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '다시 보내기' }).disabled).toBe(false)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '취소' }).disabled).toBe(false)
    expect(screen.queryByRole('button', { name: '쪽지 남기기' })).toBeNull()
    await send(action)
    if (action === '취소') {
      expect(props.onCancel).toHaveBeenCalledExactlyOnceWith()
      expect(createIssue).toHaveBeenCalledTimes(1)
      return
    }
    expect(createIssue).toHaveBeenCalledTimes(2)
    expect(vi.mocked(createIssue).mock.calls[1]).toEqual(firstRequest)
    expect(props.onCreated).toHaveBeenCalledExactlyOnceWith(saved)
  })

  it('읽기 전용이면 안내와 취소만 보이고 유효한 글도 폼 제출로 보내지 않는다', async () => {
    const { title, body, props } = renderComposer({ canSubmit: false })
    fillDraft()

    expect(
      screen.getByText('읽기 전용인 버전을 보고 있어요. 검수 중인 최신 버전으로 돌아오면 남길 수 있어요.'),
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: '쪽지 남기기' })).toBeNull()
    expect(screen.queryByRole('button', { name: '다시 보내기' })).toBeNull()
    expect(title.disabled).toBe(false)
    expect(title.readOnly).toBe(false)
    expect(body.disabled).toBe(false)
    expect(body.readOnly).toBe(false)

    // Enter로 발생하는 폼 제출도 버튼 유무와 별개로 막아야 한다.
    await act(async () => {
      fireEvent.submit(title.form!)
    })

    expect(createIssue).not.toHaveBeenCalled()
    expect(props.onCreated).not.toHaveBeenCalled()
    expect(props.onLockChange).not.toHaveBeenCalledWith(true)
    expect(title.value).toBe(saved.title)
    expect(body.value).toBe(saved.body)
    fireEvent.click(screen.getByRole('button', { name: '취소' }))
    expect(props.onCancel).toHaveBeenCalledExactlyOnceWith()
  })

  it('쓰다가 읽기 전용이 되어도 글을 고칠 수 있고 최신 버전으로 돌아오면 고친 글을 보낸다', async () => {
    const { props, rerender, title, body } = renderComposer({ pin })
    fillDraft()
    rerender(<IssueComposer {...props} canSubmit={false} versionId="past-version" pin={undefined} />)

    expect(title.value).toBe(saved.title)
    expect(body.value).toBe(saved.body)
    expect(title.disabled).toBe(false)
    expect(title.readOnly).toBe(false)
    expect(body.disabled).toBe(false)
    expect(body.readOnly).toBe(false)
    expect(screen.queryByRole('button', { name: '쪽지 남기기' })).toBeNull()
    fillDraft('고친 제목', '고친 내용')
    await act(async () => {
      fireEvent.submit(title.form!)
    })
    expect(createIssue).not.toHaveBeenCalled()

    rerender(<IssueComposer {...props} pin={undefined} />)
    expect(screen.queryByText(/읽기 전용인 버전을 보고 있어요/)).toBeNull()
    expect(title.value).toBe('고친 제목')
    expect(body.value).toBe('고친 내용')
    await send()

    expect(createIssue).toHaveBeenCalledExactlyOnceWith(projectId, {
      category: 'BUG',
      requestId: expect.any(String),
      versionId,
      title: '고친 제목',
      body: '고친 내용',
      pin: undefined,
    })
  })

  it.each(['버튼', '폼 제출'])('잠긴 뒤 읽기 전용이어도 %s로 처음 요청을 다시 보낼 수 있다', async (method) => {
    vi.mocked(createIssue).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const { props, rerender, title, body } = renderComposer({ pin })
    fillDraft()
    await send()
    const firstRequest = structuredClone(vi.mocked(createIssue).mock.calls[0])

    rerender(<IssueComposer {...props} canSubmit={false} versionId="past-version" pin={undefined} />)

    expect(screen.getByRole<HTMLButtonElement>('button', { name: '다시 보내기' }).disabled).toBe(false)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '취소' }).disabled).toBe(false)
    expect(screen.queryByRole('button', { name: '쪽지 남기기' })).toBeNull()
    expect(screen.queryByRole('button', { name: '위치 없이 쓰기' })).toBeNull()
    expect(screen.queryByText(/읽기 전용인 버전을 보고 있어요/)).toBeNull()
    expect(title.value).toBe(saved.title)
    expect(title.readOnly).toBe(true)
    expect(title.disabled).toBe(false)
    expect(body.value).toBe(saved.body)
    expect(body.readOnly).toBe(true)
    expect(body.disabled).toBe(false)

    await act(async () => {
      if (method === '폼 제출') {
        fireEvent.submit(title.form!)
        return
      }
      fireEvent.click(screen.getByRole('button', { name: '다시 보내기' }))
    })

    expect(createIssue).toHaveBeenCalledTimes(2)
    expect(vi.mocked(createIssue).mock.calls[1]).toEqual(firstRequest)
    expect(props.onCreated).toHaveBeenCalledExactlyOnceWith(saved)
    expect(props.onLockChange).toHaveBeenLastCalledWith(false)
    expect(title.readOnly).toBe(false)
    expect(body.readOnly).toBe(false)
    expect(screen.queryByRole('button', { name: '다시 보내기' })).toBeNull()
    expect(screen.queryByRole('button', { name: '쪽지 남기기' })).toBeNull()
  })

  it.each(['취소', '409'])('읽기 전용에서 %s로 잠금이 풀려도 새 요청은 보내지 않는다', async (action) => {
    vi.mocked(createIssue)
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new ApiError(409, 'VERSION_CHANGED'))
    const { props, rerender, title, body } = renderComposer({ pin })
    fillDraft()
    await send()
    rerender(<IssueComposer {...props} canSubmit={false} versionId="past-version" pin={undefined} />)

    await send(action === '취소' ? '취소' : '다시 보내기')

    expect(props.onCancel).toHaveBeenCalledTimes(action === '취소' ? 1 : 0)
    expect(props.onLockChange).toHaveBeenLastCalledWith(false)
    expect(title.readOnly).toBe(false)
    expect(title.disabled).toBe(false)
    expect(body.readOnly).toBe(false)
    expect(title.value).toBe(saved.title)
    expect(body.value).toBe(saved.body)
    expect(screen.queryByRole('button', { name: '다시 보내기' })).toBeNull()
    expect(screen.queryByRole('button', { name: '쪽지 남기기' })).toBeNull()
    expect(screen.getByText(/읽기 전용인 버전을 보고 있어요/)).toBeTruthy()

    await act(async () => {
      fireEvent.submit(title.form!)
    })
    expect(createIssue).toHaveBeenCalledTimes(action === '취소' ? 1 : 2)
    expect(props.onCreated).not.toHaveBeenCalled()
  })

  it.each([
    ['빈 제목', ''],
    ['공백뿐인 제목', ' \t  '],
    ['121자 제목', '가'.repeat(121)],
  ])('%s은 안내를 보여 주고 요청을 보내지 않는다', async (_label, invalidTitle) => {
    const { props, title } = renderComposer()
    fillDraft(invalidTitle)

    await send()

    expect(screen.getByText('제목은 1~120자로 써 주세요')).toBeTruthy()
    expect(title.value).toBe(invalidTitle)
    expect(createIssue).not.toHaveBeenCalled()
    expect(props.onCreated).not.toHaveBeenCalled()
    expect(props.onLockChange).not.toHaveBeenCalledWith(true)
  })

  it.each([
    ['빈 본문', ''],
    ['4,000자 본문', '나'.repeat(4000)],
  ])('제목 120자와 %s을 보내고 제목만 앞뒤 공백을 지운다', async (_label, body) => {
    renderComposer()
    fillDraft(`  ${'가'.repeat(120)}  `, body)

    await send()

    expect(createIssue).toHaveBeenCalledExactlyOnceWith(projectId, {
      category: 'BUG',
      requestId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
      versionId,
      title: '가'.repeat(120),
      body,
      pin: undefined,
    })
  })

  it('핀은 화면·좌표만 보내고 내용의 공백과 줄바꿈은 보존하며 성공 응답을 전달한다', async () => {
    const { props } = renderComposer({ pin })
    fillDraft(`  ${saved.title}  `)

    await send()

    expect(createIssue).toHaveBeenCalledExactlyOnceWith(projectId, {
      category: 'BUG',
      requestId: expect.any(String),
      versionId,
      title: saved.title,
      body: saved.body,
      pin: { screenId: pin.screenId, xRatio: 0, yRatio: 1 },
    })
    expect(props.onCreated).toHaveBeenCalledExactlyOnceWith(saved)
    expect(vi.mocked(props.onCreated).mock.calls[0][0]).toBe(saved)
    expect(props.onLockChange).toHaveBeenCalledWith(true)
    expect(props.onLockChange).toHaveBeenLastCalledWith(false)
  })

  it('제목 오류를 고치면 안내가 사라지고 보낼 수 있다', async () => {
    renderComposer()
    await send()
    expect(screen.getByText('제목은 1~120자로 써 주세요')).toBeTruthy()

    fillDraft('가')
    await send()

    expect(screen.queryByText('제목은 1~120자로 써 주세요')).toBeNull()
    expect(createIssue).toHaveBeenCalledTimes(1)
  })

  it('핀 안내에서 위치 없이 쓰기를 누르면 알리고 핀이 없어져도 글은 남는다', async () => {
    const { props, rerender, title, body } = renderComposer({ pin })
    fillDraft()
    expect(screen.getByText('상품 상세 · PC의 선택한 위치에 쪽지를 남겨요.')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '위치 없이 쓰기' }))
    expect(props.onClearPin).toHaveBeenCalledTimes(1)
    expect(createIssue).not.toHaveBeenCalled()
    rerender(<IssueComposer {...props} pin={undefined} />)

    expect(screen.getByText(/위치를 정하지 않은 쪽지예요\./)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '위치 없이 쓰기' })).toBeNull()
    expect(title.value).toBe(saved.title)
    expect(body.value).toBe(saved.body)
    await send()
    expect(vi.mocked(createIssue).mock.calls[0][1].pin).toBeUndefined()
  })

  it('잠기기 전 버전·핀 변경은 글을 남기고 새 버전의 선택한 위치로 보낸다', async () => {
    const { props, rerender, title, body } = renderComposer()
    fillDraft()
    rerender(<IssueComposer {...props} versionId="new-version" pin={pin} />)

    expect(title.value).toBe(saved.title)
    expect(body.value).toBe(saved.body)
    await send()
    expect(vi.mocked(createIssue).mock.calls[0][1]).toEqual({
      category: 'BUG',
      requestId: expect.any(String),
      versionId: 'new-version',
      title: saved.title,
      body: saved.body,
      pin: { screenId: pin.screenId, xRatio: 0, yRatio: 1 },
    })
  })

  it('보내는 중 버튼과 입력을 잠그고 연속 클릭·폼 제출에도 요청은 하나다', async () => {
    let resolve!: (issue: IssueDetail) => void
    vi.mocked(createIssue).mockReturnValue(
      new Promise((done) => {
        resolve = done
      }),
    )
    const { title, body, props } = renderComposer()
    fillDraft()
    const button = screen.getByRole<HTMLButtonElement>('button', { name: '쪽지 남기기' })

    act(() => {
      fireEvent.click(button)
      fireEvent.submit(title.form!)
    })
    fireEvent.click(button)

    expect(button.disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '취소' }).disabled).toBe(true)
    expect(title.disabled).toBe(true)
    expect(body.readOnly).toBe(true)
    expect(createIssue).toHaveBeenCalledTimes(1)
    expect(props.onCreated).not.toHaveBeenCalled()

    await act(async () => {
      resolve(saved)
    })
    expect(button.disabled).toBe(false)
    expect(props.onCreated).toHaveBeenCalledExactlyOnceWith(saved)
  })

  it.each([
    ['연결 끊김', new TypeError('Failed to fetch')],
    ['서버 오류', new ApiError(500)],
  ])('%s 뒤 글·핀을 잠그고 같은 요청으로 다시 보내 성공하면 잠금을 푼다', async (_label, error) => {
    vi.mocked(createIssue).mockRejectedValueOnce(error)
    const { title, body, props, rerender } = renderComposer({ pin })
    fillDraft()
    await send()
    const firstRequest = structuredClone(vi.mocked(createIssue).mock.calls[0])

    expect(title.value).toBe(saved.title)
    expect(body.value).toBe(saved.body)
    expect(title.disabled).toBe(false)
    expect(title.readOnly).toBe(true)
    expect(body.readOnly).toBe(true)
    expect(body.disabled).toBe(false)
    expect(screen.queryByRole('button', { name: '위치 없이 쓰기' })).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain('저장됐는지 확인하지 못해서')
    expect(props.onLockChange).toHaveBeenLastCalledWith(true)
    expect(props.onCreated).not.toHaveBeenCalled()

    rerender(
      <IssueComposer
        {...props}
        versionId="other-version"
        pin={{ ...pin, screenId: 'other-screen', xRatio: 0.5, yRatio: 0.25 }}
      />,
    )
    await send('다시 보내기')

    expect(createIssue).toHaveBeenCalledTimes(2)
    expect(vi.mocked(createIssue).mock.calls[1]).toEqual(firstRequest)
    expect(props.onCreated).toHaveBeenCalledExactlyOnceWith(saved)
    expect(props.onLockChange).toHaveBeenLastCalledWith(false)
    expect(title.disabled).toBe(false)
    expect(title.readOnly).toBe(false)
    expect(body.readOnly).toBe(false)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('잠긴 핀이 props에서 없어져도 처음 핀으로 다시 보낸다', async () => {
    vi.mocked(createIssue).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const { props, rerender } = renderComposer({ pin })
    fillDraft()
    await send()
    const firstRequest = structuredClone(vi.mocked(createIssue).mock.calls[0])

    rerender(<IssueComposer {...props} pin={undefined} versionId="other-version" />)
    expect(screen.queryByText(/위치를 정하지 않은 쪽지예요/)).toBeNull()
    await send('다시 보내기')
    expect(vi.mocked(createIssue).mock.calls[1]).toEqual(firstRequest)
  })

  it('응답을 기다리는 중에는 위치 없이 쓰기가 없고 핀 잠금을 알린다', async () => {
    const pending = deferred<IssueDetail>()
    vi.mocked(createIssue).mockReturnValueOnce(pending.promise)
    const { props } = renderComposer({ pin })
    fillDraft()
    expect(screen.getByRole('button', { name: '위치 없이 쓰기' })).toBeTruthy()

    await send()

    expect(createIssue).toHaveBeenCalledTimes(1)
    expect(props.onCreated).not.toHaveBeenCalled()
    expect(props.onLockChange).toHaveBeenLastCalledWith(true)
    expect(screen.queryByRole('button', { name: '위치 없이 쓰기' })).toBeNull()
    expect(props.onClearPin).not.toHaveBeenCalled()

    await act(async () => {
      pending.resolve(saved)
    })
    expect(props.onCreated).toHaveBeenCalledExactlyOnceWith(saved)
    expect(props.onLockChange).toHaveBeenLastCalledWith(false)
  })

  it('보내는 중 다른 사진을 보아 pin이 없어져도 선택한 위치 안내를 유지한다', async () => {
    const pending = deferred<IssueDetail>()
    vi.mocked(createIssue).mockReturnValueOnce(pending.promise)
    const { props, rerender } = renderComposer({ pin })
    fillDraft()
    await send()

    rerender(<IssueComposer {...props} pin={undefined} />)

    expect(screen.getByText('선택한 위치에 쪽지를 남겨요.')).toBeTruthy()
    expect(screen.queryByText(/위치를 정하지 않은 쪽지예요/)).toBeNull()
    expect(screen.queryByRole('button', { name: '위치 없이 쓰기' })).toBeNull()
    expect(props.onLockChange).toHaveBeenLastCalledWith(true)
    await act(async () => {
      pending.resolve(saved)
    })
    expect(props.onCreated).toHaveBeenCalledExactlyOnceWith(saved)
  })

  it('보내는 중 pin이 없어지고 연결이 끊겨도 다시 보내기는 처음 핀을 그대로 보낸다', async () => {
    const pending = deferred<IssueDetail>()
    vi.mocked(createIssue).mockReturnValueOnce(pending.promise)
    const { props, rerender } = renderComposer({ pin })
    fillDraft()
    await send()
    const firstRequest = structuredClone(vi.mocked(createIssue).mock.calls[0])
    expect(firstRequest[1].pin).toEqual({ screenId: pin.screenId, xRatio: 0, yRatio: 1 })

    rerender(<IssueComposer {...props} pin={undefined} versionId="other-version" />)
    await act(async () => {
      pending.reject(new TypeError('Failed to fetch'))
    })

    expect(screen.getByText('선택한 위치에 쪽지를 남겨요.')).toBeTruthy()
    expect(props.onLockChange).toHaveBeenLastCalledWith(true)
    await send('다시 보내기')
    expect(createIssue).toHaveBeenCalledTimes(2)
    expect(vi.mocked(createIssue).mock.calls[1]).toEqual(firstRequest)
    expect(props.onCreated).toHaveBeenCalledExactlyOnceWith(saved)
    expect(props.onLockChange).toHaveBeenLastCalledWith(false)
  })

  it('잠긴 뒤 프로젝트가 바뀌어도 처음 프로젝트와 요청으로 다시 보낸다', async () => {
    vi.mocked(createIssue).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const { props, rerender } = renderComposer({ pin })
    fillDraft()
    await send()
    const firstRequest = structuredClone(vi.mocked(createIssue).mock.calls[0])

    rerender(<IssueComposer {...props} projectId="other-project" />)
    await send('다시 보내기')

    expect(vi.mocked(createIssue).mock.calls[1]).toEqual(firstRequest)
  })

  it.each([
    ['401', new ApiError(401)],
    ['403', new ApiError(403)],
    ['404', new ApiError(404)],
    ['422', new ApiError(422)],
    ['연결 끊김', new TypeError('Failed to fetch')],
    ['500', new ApiError(500)],
  ])('잠긴 뒤 다시 보내기가 %s이면 글·핀·요청을 잠근 채 남기고 다시 보낼 수 있다', async (_label, error) => {
    vi.mocked(createIssue).mockRejectedValueOnce(new TypeError('Failed to fetch')).mockRejectedValueOnce(error)
    const { title, body, props } = renderComposer({ pin })
    fillDraft()
    await send()
    const firstRequest = structuredClone(vi.mocked(createIssue).mock.calls[0])
    await send('다시 보내기')

    expect(screen.getByRole('alert')).toBeTruthy()
    expect(title.disabled).toBe(false)
    expect(title.readOnly).toBe(true)
    expect(body.readOnly).toBe(true)
    expect(title.value).toBe(saved.title)
    expect(body.value).toBe(saved.body)
    expect(props.onLockChange).toHaveBeenLastCalledWith(true)
    expect(props.onCreated).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: '위치 없이 쓰기' })).toBeNull()
    if (error instanceof ApiError && error.status === 401) {
      const link = screen.getByRole('link', { name: '새 탭에서 로그인하기' })
      expect(link.getAttribute('target')).toBe('_blank')
      expect(link.getAttribute('href')).toBe('/login')
    }

    await send('다시 보내기')
    expect(createIssue).toHaveBeenCalledTimes(3)
    expect(vi.mocked(createIssue).mock.calls[1]).toEqual(firstRequest)
    expect(vi.mocked(createIssue).mock.calls[2]).toEqual(firstRequest)
    expect(props.onCreated).toHaveBeenCalledExactlyOnceWith(saved)
    expect(props.onLockChange).toHaveBeenLastCalledWith(false)
  })

  it.each(['VERSION_CHANGED', 'VERSION_NOT_IN_REVIEW', 'REQUEST_ID_REUSED'])(
    '잠긴 뒤 %s 409는 글을 남기고 잠금을 풀어 고칠 수 있다',
    async (code) => {
      vi.mocked(createIssue)
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockRejectedValueOnce(new ApiError(409, code))
      const { title, body, props, rerender } = renderComposer({ pin })
      fillDraft()
      await send()
      const firstRequest = structuredClone(vi.mocked(createIssue).mock.calls[0])
      await send('다시 보내기')

      expect(title.disabled).toBe(false)
      expect(title.readOnly).toBe(false)
      expect(body.readOnly).toBe(false)
      expect(title.value).toBe(saved.title)
      expect(body.value).toBe(saved.body)
      expect(props.onLockChange).toHaveBeenLastCalledWith(false)
      expect(props.onCreated).not.toHaveBeenCalled()
      expect(vi.mocked(createIssue).mock.calls[1]).toEqual(firstRequest)
      if (code === 'VERSION_CHANGED') {
        expect(screen.getByRole('alert').textContent).toContain('새 버전이 올라왔어요. 쓰던 글은 그대로 남아 있어요.')
        fireEvent.click(screen.getByRole('button', { name: '최신 버전 보기' }))
        expect(props.onGoLatest).toHaveBeenCalledTimes(1)
        expect(createIssue).toHaveBeenCalledTimes(2)
      }

      rerender(<IssueComposer {...props} versionId="latest-version" pin={undefined} />)
      fillDraft('고친 제목', '고친 내용')
      await send()
      expect(vi.mocked(createIssue).mock.calls[2]).toEqual([
        projectId,
        {
          category: 'BUG',
          requestId: firstRequest[1].requestId,
          versionId: 'latest-version',
          title: '고친 제목',
          body: '고친 내용',
          pin: undefined,
        },
      ])
    },
  )

  it.each([401, 403, 404, 409, 422])(
    '처음 요청이 %i이면 잠그지 않고 글·핀을 남기며 같은 requestId로 다시 보낸다',
    async (status) => {
      vi.mocked(createIssue).mockRejectedValueOnce(new ApiError(status, status === 409 ? 'VERSION_CHANGED' : undefined))
      const { title, body, props } = renderComposer({ pin })
      fillDraft()
      await send()
      const firstRequest = structuredClone(vi.mocked(createIssue).mock.calls[0])

      expect(screen.getByRole('alert')).toBeTruthy()
      expect(title.disabled).toBe(false)
      expect(title.readOnly).toBe(false)
      expect(body.readOnly).toBe(false)
      expect(title.value).toBe(saved.title)
      expect(body.value).toBe(saved.body)
      expect(screen.getByRole('button', { name: '위치 없이 쓰기' })).toBeTruthy()
      expect(props.onLockChange).toHaveBeenCalledWith(true)
      expect(props.onLockChange).toHaveBeenLastCalledWith(false)
      expect(props.onCreated).not.toHaveBeenCalled()
      if (status === 401) {
        const link = screen.getByRole('link', { name: '새 탭에서 로그인하기' })
        expect(link.getAttribute('href')).toBe('/login')
        expect(link.getAttribute('target')).toBe('_blank')
      }

      fillDraft('고친 제목', '고친 내용')
      await send()
      expect(createIssue).toHaveBeenCalledTimes(2)
      expect(vi.mocked(createIssue).mock.calls[1]).toEqual([
        projectId,
        {
          ...firstRequest[1],
          title: '고친 제목',
          body: '고친 내용',
        },
      ])
      expect(props.onCreated).toHaveBeenCalledExactlyOnceWith(saved)
    },
  )

  it.each([false, true])('잠금이 %s여도 취소하면 onCancel을 부르고 잠금을 푼다', async (locked) => {
    const { props, title, body } = renderComposer({ pin })
    if (locked) {
      vi.mocked(createIssue).mockRejectedValueOnce(new TypeError('Failed to fetch'))
      fillDraft()
      await send()
      expect(props.onLockChange).toHaveBeenLastCalledWith(true)
    }

    fireEvent.click(screen.getByRole('button', { name: '취소' }))

    expect(props.onCancel).toHaveBeenCalledExactlyOnceWith()
    expect(props.onLockChange).toHaveBeenLastCalledWith(false)
    expect(title.disabled).toBe(false)
    expect(title.readOnly).toBe(false)
    expect(body.readOnly).toBe(false)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(createIssue).toHaveBeenCalledTimes(locked ? 1 : 0)
    expect(props.onCreated).not.toHaveBeenCalled()
  })

  it('쓰기 칸을 닫았다 다시 열면 새로운 requestId를 쓴다', async () => {
    const first = renderComposer()
    fillDraft()
    await send()
    first.unmount()
    renderComposer()
    fillDraft()
    await send()

    expect(vi.mocked(createIssue).mock.calls[0][1].requestId).not.toBe(
      vi.mocked(createIssue).mock.calls[1][1].requestId,
    )
  })

  it('내용 칸은 4,000자로 제한하고 처음에는 고칠 수 있다', () => {
    const { body } = renderComposer()
    expect(body.maxLength).toBe(4000)
    expect(body.readOnly).toBe(false)
    expect(body.disabled).toBe(false)
  })
})
