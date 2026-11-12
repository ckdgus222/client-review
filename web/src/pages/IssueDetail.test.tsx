import { act, fireEvent, render, screen, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { MemoryRouter } from 'react-router'
import { ApiError } from '../api/client.ts'
import {
  attachIssuePhoto,
  createComment,
  type IssueDetail as Issue,
  removeIssuePhoto,
  startIssue,
} from '../api/issues.ts'
import { timeFormat } from '../api/versions.ts'
import { IssueDetail } from './IssueDetail.tsx'

vi.mock('../api/issues.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/issues.ts')>()),
  attachIssuePhoto: vi.fn(),
  createComment: vi.fn(),
  removeIssuePhoto: vi.fn(),
  startIssue: vi.fn(),
}))

const versionId = '22222222-2222-4222-8222-222222222222'
const latestVersionId = '33333333-3333-4333-8333-333333333333'
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const photos = [
  { id: 'attachment-1', assetId: 'asset-1', width: 800, height: 600 },
  { id: 'attachment-2', assetId: 'asset-2', width: 640, height: 480 },
  { id: 'attachment-3', assetId: 'asset-3', width: 400, height: 300 },
]
const issue: Issue = {
  id: '11111111-1111-4111-8111-111111111111',
  number: 14,
  status: 'OPEN',
  title: '버튼을 옮겨 주세요',
  body: '첫째 줄\n둘째 줄',
  authorName: '쪽지 작성자',
  createdAt: '2026-11-10T00:00:00.000Z',
  commentCount: 2,
  originVersion: { id: 'original-version', number: 0 },
  origin: {
    screenId: 'screen-1',
    screenName: '상품 상세',
    viewport: 'PC',
    asset: { id: 'original-photo', width: 1200, height: 800 },
    xRatio: 0.25,
    yRatio: 0.75,
  },
  isMine: true,
  attachments: photos.slice(0, 2),
  comments: [
    {
      id: 'comment-1',
      authorName: '첫 작성자',
      versionNumber: 1,
      body: '먼저 쓴 댓글',
      createdAt: '2026-11-10T01:00:00.000Z',
    },
    {
      id: 'comment-2',
      authorName: '다음 작성자',
      versionNumber: 2,
      body: '나중에 쓴 댓글',
      createdAt: '2026-11-11T02:00:00.000Z',
    },
  ],
}
const savedComment = { ...issue.comments[1], id: 'saved-comment', body: '새 댓글' }

const renderDetail = (overrides: Partial<ComponentProps<typeof IssueDetail>> = {}) => {
  const props = {
    issue,
    versionId,
    canWrite: true,
    isDeveloper: true,
    onChanged: vi.fn(),
    onCommented: vi.fn(),
    onDraftChange: vi.fn(),
    onRefresh: vi.fn(),
    onGoLatest: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  }
  return { ...render(<IssueDetail {...props} />, { wrapper: MemoryRouter }), props }
}

const commentInput = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: '댓글' })
const fillComment = (body = '  새 댓글\n둘째 줄  ') => {
  fireEvent.change(commentInput(), { target: { value: body } })
}
const click = async (name: string) => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }))
  })
}
const upload = async (file: File) => {
  await act(async () => {
    fireEvent.change(screen.getByLabelText('참고 사진 붙이기'), { target: { files: [file] } })
  })
}

beforeEach(() => {
  vi.mocked(startIssue)
    .mockReset()
    .mockResolvedValue({ ...issue, status: 'IN_PROGRESS' })
  vi.mocked(attachIssuePhoto)
    .mockReset()
    .mockResolvedValue({ ...issue, attachments: photos })
  vi.mocked(removeIssuePhoto)
    .mockReset()
    .mockResolvedValue({ ...issue, attachments: [photos[0]] })
  vi.mocked(createComment).mockReset().mockResolvedValue(savedComment)
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('IssueDetail', () => {
  it('번호·상태·제목·처음 위치·작성 정보·본문과 오래된 순의 댓글을 보여 주고 닫기를 알린다', async () => {
    const { props } = renderDetail()
    expect(screen.getByRole('article', { name: '쪽지 #14' })).toBeTruthy()
    expect(screen.getByText('#14')).toBeTruthy()
    expect(screen.getByText('접수')).toBeTruthy()
    expect(screen.getByRole('heading', { name: issue.title })).toBeTruthy()
    expect(screen.getByText('초안 · 상품 상세 · PC')).toBeTruthy()
    expect(screen.getByText(issue.authorName)).toBeTruthy()
    expect(screen.getByText(timeFormat.format(new Date(issue.createdAt)))).toBeTruthy()
    expect(screen.getByText('첫째 줄 둘째 줄').textContent).toBe(issue.body)
    const comments = within(screen.getByRole('region', { name: '댓글' }))
    expect(comments.getByRole('heading', { name: '댓글 2개' })).toBeTruthy()
    const rows = comments.getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    issue.comments.forEach((comment, index) => {
      expect(within(rows[index]).getByText(comment.authorName)).toBeTruthy()
      expect(
        within(rows[index]).getByText(`${comment.versionNumber}차 · ${timeFormat.format(new Date(comment.createdAt))}`),
      ).toBeTruthy()
      expect(within(rows[index]).getByText(comment.body)).toBeTruthy()
    })

    await click('쪽지 닫기')
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('위치 없는 쪽지와 빈 댓글 목록을 보여 주고 빈 본문 문단은 만들지 않는다', () => {
    const { container } = renderDetail({ issue: { ...issue, body: '', origin: null, comments: [], commentCount: 0 } })
    expect(screen.getByText('초안 · 위치 없음')).toBeTruthy()
    expect(screen.getByRole('heading', { name: '댓글 0개' })).toBeTruthy()
    expect(container.querySelector('article > p')).toBeNull()
    expect(within(screen.getByRole('region', { name: '댓글' })).queryAllByRole('listitem')).toHaveLength(0)
  })

  it('쪽지와 댓글의 HTML 태그는 실행되지 않고 글자 그대로 보인다', () => {
    const title = '<script>alert("제목")</script>'
    const body = '<img src=x onerror=alert("본문")>'
    const commentBody = '<script>alert("댓글")</script><img src=x onerror=alert(1)>'
    const { container } = renderDetail({
      issue: { ...issue, title, body, attachments: [], comments: [{ ...savedComment, body: commentBody }] },
    })
    expect(screen.getByRole('heading', { name: title })).toBeTruthy()
    expect(screen.getByText(body)).toBeTruthy()
    expect(screen.getByText(commentBody)).toBeTruthy()
    expect(container.querySelector('script, img, [onerror]')).toBeNull()
  })

  it.each([
    ['클라이언트', { isDeveloper: false }],
    ['읽기 전용', { canWrite: false }],
    ['수정 중', { issue: { ...issue, status: 'IN_PROGRESS' as const } }],
  ])('%s이면 수정 시작 버튼이 없다', (_label, overrides) => {
    renderDetail(overrides)
    expect(screen.queryByRole('button', { name: '수정 시작' })).toBeNull()
    expect(startIssue).not.toHaveBeenCalled()
  })

  it('개발자는 지난 버전에 남긴 접수 쪽지도 현재 선택한 버전으로 수정 시작하고 받은 쪽지를 전달한다', async () => {
    const started: Issue = { ...issue, status: 'IN_PROGRESS' }
    vi.mocked(startIssue).mockResolvedValueOnce(started)
    const { props, rerender } = renderDetail()
    await click('수정 시작')
    expect(startIssue).toHaveBeenCalledExactlyOnceWith(issue.id, versionId)
    expect(props.onChanged).toHaveBeenCalledExactlyOnceWith(started)
    expect(vi.mocked(props.onChanged).mock.calls[0][0]).toBe(started)
    expect(props.onRefresh).not.toHaveBeenCalled()
    rerender(<IssueDetail {...props} issue={started} />)
    expect(screen.getByText('수정 중')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '수정 시작' })).toBeNull()
  })

  it.each([new ApiError(409, 'ISSUE_NOT_OPEN'), new ApiError(404)])(
    '수정 시작이 %s이면 오류 없이 상세를 새로 불러온다',
    async (error) => {
      vi.mocked(startIssue).mockRejectedValueOnce(error)
      const { props } = renderDetail()
      await click('수정 시작')
      expect(props.onRefresh).toHaveBeenCalledExactlyOnceWith()
      expect(props.onChanged).not.toHaveBeenCalled()
      expect(screen.queryByRole('alert')).toBeNull()
    },
  )

  it('수정 시작의 VERSION_CHANGED는 새 버전 안내와 최신 버전 보기를 보여 준다', async () => {
    vi.mocked(startIssue).mockRejectedValueOnce(new ApiError(409, 'VERSION_CHANGED'))
    const { props } = renderDetail()
    await click('수정 시작')
    expect(screen.getByRole('alert').textContent).toContain('새 버전이 올라왔어요. 쓰던 글은 그대로 남아 있어요.')
    await click('최신 버전 보기')
    expect(props.onGoLatest).toHaveBeenCalledTimes(1)
    expect(props.onRefresh).not.toHaveBeenCalled()
    expect(props.onChanged).not.toHaveBeenCalled()
    expect(startIssue).toHaveBeenCalledTimes(1)
  })

  it('수정 시작 연결 실패는 안내하고 다시 누를 수 있다', async () => {
    vi.mocked(startIssue).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const { props } = renderDetail()
    await click('수정 시작')
    expect(screen.getByRole('alert').textContent).toBe('연결을 확인하고 다시 시도해 주세요')
    expect(props.onChanged).not.toHaveBeenCalled()
    await click('수정 시작')
    expect(startIssue).toHaveBeenCalledTimes(2)
    expect(props.onChanged).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('수정 시작을 보내는 동안 버튼과 사진 동작을 잠그고 연속 클릭에도 한 번만 보낸다', async () => {
    let resolve!: (value: Issue) => void
    vi.mocked(startIssue).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      }),
    )
    const { props } = renderDetail()
    await click('수정 시작')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '수정 시작' }).disabled).toBe(true)
    expect(screen.getByLabelText<HTMLInputElement>('참고 사진 붙이기').disabled).toBe(true)
    expect(
      screen.getAllByRole<HTMLButtonElement>('button', { name: '지우기' }).every((button) => button.disabled),
    ).toBe(true)
    await click('수정 시작')
    expect(startIssue).toHaveBeenCalledTimes(1)
    expect(props.onChanged).not.toHaveBeenCalled()
    await act(async () => {
      resolve({ ...issue, status: 'IN_PROGRESS' })
    })
    expect(props.onChanged).toHaveBeenCalledTimes(1)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '수정 시작' }).disabled).toBe(false)
  })

  it('참고 사진마다 원본 사진을 새 창에서 여는 링크와 번호가 있는 그림을 보여 준다', () => {
    renderDetail({ canWrite: false })
    const list = within(screen.getByRole('list', { name: '참고 사진' }))
    expect(list.getAllByRole('listitem')).toHaveLength(2)
    issue.attachments.forEach((photo, index) => {
      const name = `참고 사진 ${index + 1}`
      const link = list.getByRole('link', { name })
      expect(link.getAttribute('href')).toBe(`/api/assets/${photo.assetId}`)
      expect(link.getAttribute('target')).toBe('_blank')
      expect(list.getByRole('img', { name }).getAttribute('src')).toBe(`/api/assets/${photo.assetId}`)
    })
  })

  it.each([
    ['남의 쪽지', { issue: { ...issue, isMine: false } }],
    ['읽기 전용', { canWrite: false }],
  ])('%s이면 개발자여도 사진 붙이기와 지우기가 없다', (_label, overrides) => {
    renderDetail(overrides)
    expect(screen.queryByLabelText('참고 사진 붙이기')).toBeNull()
    expect(screen.queryAllByRole('button', { name: '지우기' })).toHaveLength(0)
    expect(attachIssuePhoto).not.toHaveBeenCalled()
    expect(removeIssuePhoto).not.toHaveBeenCalled()
  })

  it('내 쪽지에 3장이 붙으면 붙이기는 숨기고 사진마다 지우기는 남긴다', () => {
    renderDetail({ isDeveloper: false, issue: { ...issue, attachments: photos } })
    expect(screen.queryByLabelText('참고 사진 붙이기')).toBeNull()
    expect(screen.getAllByRole('button', { name: '지우기' })).toHaveLength(3)
  })

  it('작성자는 개발자가 아니어도 사진을 붙이고 받은 쪽지를 전달하며 3장이 되면 붙이기를 숨긴다', async () => {
    const attached = { ...issue, attachments: photos }
    vi.mocked(attachIssuePhoto).mockResolvedValueOnce(attached)
    const { props, rerender } = renderDetail({ isDeveloper: false })
    const file = new File(['photo'], 'reference.png', { type: 'image/png' })
    await upload(file)
    expect(attachIssuePhoto).toHaveBeenCalledExactlyOnceWith(issue.id, file)
    expect(props.onChanged).toHaveBeenCalledExactlyOnceWith(attached)
    expect(vi.mocked(props.onChanged).mock.calls[0][0]).toBe(attached)
    expect(props.onRefresh).not.toHaveBeenCalled()
    rerender(<IssueDetail {...props} issue={attached} />)
    expect(screen.queryByLabelText('참고 사진 붙이기')).toBeNull()
    expect(screen.getByRole('img', { name: '참고 사진 3' })).toBeTruthy()
  })

  it.each([
    [413, undefined, '사진이 너무 커요. 20 MiB까지 붙일 수 있어요'],
    [415, undefined, 'PNG, JPEG, WebP 사진만 붙일 수 있어요'],
    [409, 'TOO_MANY_ATTACHMENTS', '참고 사진은 3장까지 붙일 수 있어요'],
  ])('사진 붙이기의 %i %s 오류는 안내하고 같은 파일을 다시 고를 수 있다', async (status, code, message) => {
    vi.mocked(attachIssuePhoto).mockRejectedValueOnce(new ApiError(status, code))
    const { props } = renderDetail()
    const input = screen.getByLabelText<HTMLInputElement>('참고 사진 붙이기')
    const file = new File(['photo'], 'reference.png', { type: 'image/png' })
    await upload(file)
    expect(screen.getByRole('alert').textContent).toBe(message)
    expect(input.disabled).toBe(false)
    expect(input.value).toBe('')
    expect(props.onChanged).not.toHaveBeenCalled()
    await upload(file)
    expect(attachIssuePhoto).toHaveBeenCalledTimes(2)
    expect(vi.mocked(attachIssuePhoto).mock.calls[1]).toEqual([issue.id, file])
    expect(props.onChanged).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('파일 고르기를 취소하면 사진 요청을 보내지 않는다', async () => {
    renderDetail()
    await act(async () => {
      fireEvent.change(screen.getByLabelText('참고 사진 붙이기'), { target: { files: [] } })
    })
    expect(attachIssuePhoto).not.toHaveBeenCalled()
  })

  it.each([false, true])('사진 지우기 확인이 %s이면 선택한 첨부만 처리한다', async (confirmed) => {
    vi.mocked(window.confirm).mockReturnValueOnce(confirmed)
    const removed = { ...issue, attachments: [photos[0]] }
    vi.mocked(removeIssuePhoto).mockResolvedValueOnce(removed)
    const { props, rerender } = renderDetail({ isDeveloper: false })
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: '지우기' })[1])
    })
    expect(window.confirm).toHaveBeenCalledExactlyOnceWith('이 사진을 지울까요?')
    if (!confirmed) {
      expect(removeIssuePhoto).not.toHaveBeenCalled()
      expect(props.onChanged).not.toHaveBeenCalled()
      expect(screen.getAllByRole('img')).toHaveLength(2)
      return
    }
    expect(removeIssuePhoto).toHaveBeenCalledExactlyOnceWith(issue.id, photos[1].id)
    expect(props.onChanged).toHaveBeenCalledExactlyOnceWith(removed)
    expect(vi.mocked(props.onChanged).mock.calls[0][0]).toBe(removed)
    rerender(<IssueDetail {...props} issue={removed} />)
    expect(screen.getAllByRole('img')).toHaveLength(1)
    expect(screen.getByRole('img').getAttribute('src')).toBe('/api/assets/asset-1')
  })

  it('이미 지워진 사진의 404는 오류 없이 상세를 다시 불러온다', async () => {
    vi.mocked(removeIssuePhoto).mockRejectedValueOnce(new ApiError(404))
    const { props } = renderDetail()
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: '지우기' })[0])
    })
    expect(removeIssuePhoto).toHaveBeenCalledExactlyOnceWith(issue.id, photos[0].id)
    expect(props.onRefresh).toHaveBeenCalledExactlyOnceWith()
    expect(props.onChanged).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('사진 지우기의 승인된 버전 오류는 사진을 남기고 안내한다', async () => {
    vi.mocked(removeIssuePhoto).mockRejectedValueOnce(new ApiError(409, 'VERSION_NOT_IN_REVIEW'))
    const { props } = renderDetail()
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: '지우기' })[0])
    })
    expect(screen.getByRole('alert').textContent).toBe('승인된 버전이라 더 쓸 수 없어요.')
    expect(screen.getAllByRole('img')).toHaveLength(2)
    expect(props.onChanged).not.toHaveBeenCalled()
    expect(props.onRefresh).not.toHaveBeenCalled()
  })

  it.each([
    ['빈 글', ''],
    ['공백뿐인 글', ' \t\n '],
    ['2,001자', '가'.repeat(2001)],
  ])('댓글이 %s이면 안내하고 보내지 않는다', async (_label, body) => {
    const { props } = renderDetail()
    fillComment(body)
    await click('댓글 남기기')
    expect(screen.getByRole('alert').textContent).toBe('댓글은 1~2,000자로 써 주세요')
    expect(commentInput().value).toBe(body)
    expect(commentInput().getAttribute('aria-invalid')).toBe('true')
    expect(createComment).not.toHaveBeenCalled()
    expect(props.onRefresh).not.toHaveBeenCalled()
  })

  it.each([
    [1, '가'],
    [2000, '나'.repeat(2000)],
  ])('%i자 댓글은 앞뒤 공백을 지우고 UUID와 현재 버전으로 보낸다', async (_length, body) => {
    const { props } = renderDetail({ issue: { ...issue, isMine: false }, isDeveloper: false })
    expect(commentInput().maxLength).toBe(2000)
    fillComment(`  ${body}  `)
    await click('댓글 남기기')
    expect(createComment).toHaveBeenCalledExactlyOnceWith(issue.id, {
      requestId: expect.stringMatching(uuidPattern),
      versionId,
      body,
    })
    expect(commentInput().value).toBe('')
    expect(props.onRefresh).toHaveBeenCalledExactlyOnceWith()
    expect(props.onChanged).not.toHaveBeenCalled()
  })

  it('댓글 입력 오류를 고쳐 저장하면 안내와 글이 지워지고 다음 댓글은 새 requestId로 보낸다', async () => {
    const { props } = renderDetail()
    await click('댓글 남기기')
    fillComment()
    await click('댓글 남기기')
    const firstRequest = structuredClone(vi.mocked(createComment).mock.calls[0])
    expect(firstRequest[1].body).toBe('새 댓글\n둘째 줄')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(commentInput().getAttribute('aria-invalid')).toBeNull()
    expect(commentInput().value).toBe('')
    fillComment('다음 댓글')
    await click('댓글 남기기')
    const nextRequest = vi.mocked(createComment).mock.calls[1][1]
    expect(nextRequest.requestId).toMatch(uuidPattern)
    expect(nextRequest.requestId).not.toBe(firstRequest[1].requestId)
    expect(nextRequest.body).toBe('다음 댓글')
    expect(props.onRefresh).toHaveBeenCalledTimes(2)
  })

  it('댓글을 보내는 중에는 입력을 잠그고 중복 제출을 막는다', async () => {
    let resolve!: (value: typeof savedComment) => void
    vi.mocked(createComment).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      }),
    )
    const { props } = renderDetail()
    fillComment()
    const input = commentInput()
    const button = screen.getByRole<HTMLButtonElement>('button', { name: '댓글 남기기' })
    act(() => {
      fireEvent.click(button)
      fireEvent.submit(input.form!)
    })
    fireEvent.click(button)
    expect(input.readOnly).toBe(true)
    expect(input.disabled).toBe(false)
    expect(button.disabled).toBe(true)
    expect(createComment).toHaveBeenCalledTimes(1)
    expect(props.onRefresh).not.toHaveBeenCalled()
    await act(async () => {
      resolve(savedComment)
    })
    expect(input.readOnly).toBe(false)
    expect(button.disabled).toBe(false)
    expect(input.value).toBe('')
    expect(props.onRefresh).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['연결 끊김', new TypeError('Failed to fetch')],
    ['500', new ApiError(500)],
  ])('댓글의 %s 뒤 글을 잠그고 쪽지·버전 props가 바뀌어도 처음 요청 그대로 다시 보낸다', async (_label, error) => {
    vi.mocked(createComment).mockRejectedValueOnce(error)
    const { props, rerender } = renderDetail()
    fillComment()
    await click('댓글 남기기')
    const firstRequest = structuredClone(vi.mocked(createComment).mock.calls[0])
    expect(commentInput().value).toBe('  새 댓글\n둘째 줄  ')
    expect(commentInput().readOnly).toBe(true)
    expect(commentInput().disabled).toBe(false)
    expect(screen.getByRole('alert').textContent).toContain('저장됐는지 확인하지 못해서')
    expect(screen.getByRole('button', { name: '취소' })).toBeTruthy()
    expect(props.onRefresh).not.toHaveBeenCalled()
    rerender(<IssueDetail {...props} issue={{ ...issue, id: 'another-issue' }} versionId={latestVersionId} />)
    await click('다시 보내기')
    expect(createComment).toHaveBeenCalledTimes(2)
    expect(vi.mocked(createComment).mock.calls[1]).toEqual(firstRequest)
    expect(commentInput().value).toBe('')
    expect(commentInput().readOnly).toBe(false)
    expect(screen.queryByRole('button', { name: '다시 보내기' })).toBeNull()
    expect(screen.queryByRole('button', { name: '취소' })).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(props.onRefresh).toHaveBeenCalledExactlyOnceWith()
  })

  it.each([
    ['401', new ApiError(401)],
    ['403', new ApiError(403)],
    ['404', new ApiError(404)],
    ['422', new ApiError(422)],
    ['연결 끊김', new TypeError('Failed to fetch')],
    ['500', new ApiError(500)],
  ])('잠긴 댓글 재전송이 %s이면 잠긴 채 남고 다시 보내기도 처음 요청과 같다', async (_label, error) => {
    vi.mocked(createComment).mockRejectedValueOnce(new TypeError('Failed to fetch')).mockRejectedValueOnce(error)
    const { props } = renderDetail()
    fillComment()
    await click('댓글 남기기')
    const firstRequest = structuredClone(vi.mocked(createComment).mock.calls[0])
    await click('다시 보내기')
    expect(commentInput().readOnly).toBe(true)
    expect(commentInput().disabled).toBe(false)
    expect(commentInput().value).toBe('  새 댓글\n둘째 줄  ')
    expect(screen.getByRole('button', { name: '취소' })).toBeTruthy()
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(props.onRefresh).not.toHaveBeenCalled()
    if (error instanceof ApiError && error.status === 401) {
      const link = screen.getByRole('link', { name: '새 탭에서 로그인하기' })
      expect(link.getAttribute('href')).toBe('/login')
      expect(link.getAttribute('target')).toBe('_blank')
      expect(screen.getByRole('alert').textContent).toContain('로그인이 끝났어요. 다른 탭에서 로그인한 뒤')
    }
    await click('다시 보내기')
    expect(createComment).toHaveBeenCalledTimes(3)
    expect(vi.mocked(createComment).mock.calls[1]).toEqual(firstRequest)
    expect(vi.mocked(createComment).mock.calls[2]).toEqual(firstRequest)
    expect(commentInput().readOnly).toBe(false)
    expect(props.onRefresh).toHaveBeenCalledTimes(1)
  })

  it.each(['VERSION_CHANGED', 'VERSION_NOT_IN_REVIEW', 'REQUEST_ID_REUSED'])(
    '잠긴 댓글의 %s 409는 글을 남기고 잠금을 풀며 최신 버전으로 다시 보낼 수 있다',
    async (code) => {
      vi.mocked(createComment)
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockRejectedValueOnce(new ApiError(409, code))
      const { props, rerender } = renderDetail()
      fillComment()
      await click('댓글 남기기')
      const firstRequest = structuredClone(vi.mocked(createComment).mock.calls[0])
      await click('다시 보내기')
      expect(vi.mocked(createComment).mock.calls[1]).toEqual(firstRequest)
      expect(commentInput().readOnly).toBe(false)
      expect(commentInput().value).toBe('  새 댓글\n둘째 줄  ')
      expect(screen.queryByRole('button', { name: '다시 보내기' })).toBeNull()
      expect(screen.queryByRole('button', { name: '취소' })).toBeNull()
      expect(props.onRefresh).not.toHaveBeenCalled()
      if (code === 'VERSION_CHANGED') {
        expect(screen.getByRole('alert').textContent).toContain('새 버전이 올라왔어요. 쓰던 글은 그대로 남아 있어요.')
        await click('최신 버전 보기')
        expect(props.onGoLatest).toHaveBeenCalledTimes(1)
      }
      rerender(<IssueDetail {...props} versionId={latestVersionId} />)
      fillComment('고친 댓글')
      await click('댓글 남기기')
      expect(vi.mocked(createComment).mock.calls[2]).toEqual([
        issue.id,
        { requestId: firstRequest[1].requestId, versionId: latestVersionId, body: '고친 댓글' },
      ])
      expect(props.onRefresh).toHaveBeenCalledTimes(1)
    },
  )

  it.each([401, 403, 404, 409, 422])(
    '처음 댓글 요청이 %i이면 잠그지 않고 글과 requestId를 보존한다',
    async (status) => {
      vi.mocked(createComment).mockRejectedValueOnce(
        new ApiError(status, status === 409 ? 'VERSION_CHANGED' : undefined),
      )
      const { props } = renderDetail()
      fillComment()
      await click('댓글 남기기')
      const firstRequest = structuredClone(vi.mocked(createComment).mock.calls[0])
      expect(commentInput().readOnly).toBe(false)
      expect(commentInput().value).toBe('  새 댓글\n둘째 줄  ')
      expect(screen.queryByRole('button', { name: '다시 보내기' })).toBeNull()
      expect(screen.queryByRole('button', { name: '취소' })).toBeNull()
      expect(screen.getByRole('alert')).toBeTruthy()
      expect(props.onRefresh).not.toHaveBeenCalled()
      if (status === 401) {
        const link = screen.getByRole('link', { name: '새 탭에서 로그인하기' })
        expect(link.getAttribute('href')).toBe('/login')
        expect(link.getAttribute('target')).toBe('_blank')
      }
      fillComment('고친 댓글')
      await click('댓글 남기기')
      expect(vi.mocked(createComment).mock.calls[1]).toEqual([issue.id, { ...firstRequest[1], body: '고친 댓글' }])
      expect(props.onRefresh).toHaveBeenCalledExactlyOnceWith()
    },
  )

  it('댓글의 VERSION_CHANGED 뒤 읽기 전용이면 안내와 최신 버전 보기만 남고 다시 쓸 수 있으면 쓰던 글이 보인다', async () => {
    vi.mocked(createComment).mockRejectedValueOnce(new ApiError(409, 'VERSION_CHANGED'))
    const { props, rerender } = renderDetail()
    fillComment()
    await click('댓글 남기기')
    expect(screen.getByRole('alert').textContent).toContain('새 버전이 올라왔어요. 쓰던 글은 그대로 남아 있어요.')

    rerender(<IssueDetail {...props} canWrite={false} />)
    expect(screen.queryByRole('textbox', { name: '댓글' })).toBeNull()
    expect(screen.queryByRole('button', { name: '댓글 남기기' })).toBeNull()
    expect(screen.queryByRole('button', { name: '다시 보내기' })).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain('새 버전이 올라왔어요. 쓰던 글은 그대로 남아 있어요.')
    await click('최신 버전 보기')
    expect(props.onGoLatest).toHaveBeenCalledTimes(1)
    expect(createComment).toHaveBeenCalledTimes(1)

    rerender(<IssueDetail {...props} canWrite={true} />)
    expect(commentInput().value).toBe('  새 댓글\n둘째 줄  ')
    expect(commentInput().readOnly).toBe(false)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '댓글 남기기' }).disabled).toBe(false)
  })

  it.each([
    [422, '입력한 내용을 확인해 주세요'],
    [401, '로그인이 끝났어요. 다른 탭에서 로그인한 뒤 다시 눌러 주세요'],
    [403, '잠시 뒤 다시 시도해 주세요'],
    [404, '찾을 수 없어요. 화면을 새로 고쳐 주세요'],
  ] as const)('댓글의 %i 뒤 읽기 전용이 되면 실패 문구와 댓글 입력을 모두 숨긴다', async (status, message) => {
    vi.mocked(createComment).mockRejectedValueOnce(new ApiError(status))
    const { props, rerender } = renderDetail()
    fillComment()
    await click('댓글 남기기')
    expect(screen.getByRole('alert').textContent).toContain(message)
    expect(commentInput().value).toBe('  새 댓글\n둘째 줄  ')

    rerender(<IssueDetail {...props} canWrite={false} />)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText(message, { exact: false })).toBeNull()
    expect(screen.queryByRole('textbox', { name: '댓글' })).toBeNull()
    expect(screen.queryByRole('button', { name: '댓글 남기기' })).toBeNull()
    expect(screen.queryByRole('button', { name: '최신 버전 보기' })).toBeNull()
    expect(screen.queryByRole('link', { name: '새 탭에서 로그인하기' })).toBeNull()
    expect(createComment).toHaveBeenCalledTimes(1)
  })

  it('잠긴 댓글을 취소하면 글은 남고 잠금과 오류가 풀리며 다음 보내기는 새 requestId를 쓴다', async () => {
    vi.mocked(createComment).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const { props } = renderDetail()
    fillComment()
    await click('댓글 남기기')
    const firstRequest = structuredClone(vi.mocked(createComment).mock.calls[0])
    await click('취소')
    expect(commentInput().readOnly).toBe(false)
    expect(commentInput().value).toBe('  새 댓글\n둘째 줄  ')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('button', { name: '다시 보내기' })).toBeNull()
    expect(screen.queryByRole('button', { name: '취소' })).toBeNull()
    expect(createComment).toHaveBeenCalledTimes(1)
    expect(props.onRefresh).not.toHaveBeenCalled()
    fillComment('취소한 뒤 고친 댓글')
    await click('댓글 남기기')
    const nextRequest = vi.mocked(createComment).mock.calls[1][1]
    expect(nextRequest.body).toBe('취소한 뒤 고친 댓글')
    expect(nextRequest.requestId).toMatch(uuidPattern)
    expect(nextRequest.requestId).not.toBe(firstRequest[1].requestId)
  })

  it('읽기 전용이면 읽기 안내만 보이고 댓글·수정 시작·사진 붙이기·지우기가 모두 없다', () => {
    renderDetail({ canWrite: false })
    expect(screen.getByText('읽기 전용이에요. 쪽지와 댓글은 바꿀 수 없어요.')).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: '댓글' })).toBeNull()
    for (const name of ['댓글 남기기', '수정 시작', '지우기', '다시 보내기', '취소']) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }
    expect(screen.queryByLabelText('참고 사진 붙이기')).toBeNull()
    expect(screen.getByText(issue.comments[0].body)).toBeTruthy()
  })

  it.each(['다시 보내기', '취소'])(
    '잠긴 뒤 읽기 전용이 되어도 글과 재전송·취소가 남고 %s로 잠금을 풀 수 있다',
    async (action) => {
      vi.mocked(createComment).mockRejectedValueOnce(new TypeError('Failed to fetch'))
      const { props, rerender } = renderDetail()
      fillComment()
      await click('댓글 남기기')
      const firstRequest = structuredClone(vi.mocked(createComment).mock.calls[0])
      rerender(<IssueDetail {...props} canWrite={false} versionId={latestVersionId} />)
      expect(commentInput().readOnly).toBe(true)
      expect(commentInput().value).toBe('  새 댓글\n둘째 줄  ')
      expect(screen.getByRole('button', { name: '다시 보내기' })).toBeTruthy()
      expect(screen.getByRole('button', { name: '취소' })).toBeTruthy()
      expect(screen.queryByRole('button', { name: '댓글 남기기' })).toBeNull()
      await click(action)
      expect(screen.queryByRole('textbox', { name: '댓글' })).toBeNull()
      expect(screen.queryByRole('button', { name: '다시 보내기' })).toBeNull()
      if (action === '취소') {
        expect(createComment).toHaveBeenCalledTimes(1)
        expect(props.onRefresh).not.toHaveBeenCalled()
        return
      }
      expect(vi.mocked(createComment).mock.calls[1]).toEqual(firstRequest)
      expect(props.onRefresh).toHaveBeenCalledExactlyOnceWith()
    },
  )

  it.each(['붙이기', '지우기'])('사진 %s를 보내는 중에는 사진 입력과 지우기·수정 시작을 잠근다', async (action) => {
    let resolve!: (value: Issue) => void
    const pending = new Promise<Issue>((done) => {
      resolve = done
    })
    const { props } = renderDetail()
    if (action === '붙이기') {
      vi.mocked(attachIssuePhoto).mockReturnValueOnce(pending)
      await upload(new File(['photo'], 'reference.png', { type: 'image/png' }))
    } else {
      vi.mocked(removeIssuePhoto).mockReturnValueOnce(pending)
      await act(async () => {
        fireEvent.click(screen.getAllByRole('button', { name: '지우기' })[0])
      })
    }
    expect(screen.getByLabelText<HTMLInputElement>('참고 사진 붙이기').disabled).toBe(true)
    const removeButtons = screen.getAllByRole<HTMLButtonElement>('button', { name: '지우기' })
    expect(removeButtons.every((button) => button.disabled)).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '수정 시작' }).disabled).toBe(true)
    fireEvent.click(removeButtons[0])
    await click('수정 시작')
    expect(startIssue).not.toHaveBeenCalled()
    expect(removeIssuePhoto).toHaveBeenCalledTimes(action === '지우기' ? 1 : 0)
    expect(props.onChanged).not.toHaveBeenCalled()
    await act(async () => {
      resolve(issue)
    })
    expect(props.onChanged).toHaveBeenCalledExactlyOnceWith(issue)
    expect(screen.getByLabelText<HTMLInputElement>('참고 사진 붙이기').disabled).toBe(false)
    expect(removeButtons.every((button) => !button.disabled)).toBe(true)
  })

  it('잠긴 댓글을 다시 보내는 중에는 재전송과 취소를 잠그고 중복 제출을 막는다', async () => {
    let resolve!: (value: typeof savedComment) => void
    vi.mocked(createComment)
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockReturnValueOnce(
        new Promise((done) => {
          resolve = done
        }),
      )
    const { props } = renderDetail()
    fillComment()
    await click('댓글 남기기')
    const firstRequest = structuredClone(vi.mocked(createComment).mock.calls[0])
    const retry = screen.getByRole<HTMLButtonElement>('button', { name: '다시 보내기' })
    const cancel = screen.getByRole<HTMLButtonElement>('button', { name: '취소' })
    act(() => {
      fireEvent.click(retry)
      fireEvent.submit(commentInput().form!)
    })
    expect(retry.disabled).toBe(true)
    expect(cancel.disabled).toBe(true)
    fireEvent.click(cancel)
    fireEvent.click(retry)
    expect(commentInput().readOnly).toBe(true)
    expect(commentInput().value).toBe('  새 댓글\n둘째 줄  ')
    expect(createComment).toHaveBeenCalledTimes(2)
    expect(vi.mocked(createComment).mock.calls[1]).toEqual(firstRequest)
    expect(props.onRefresh).not.toHaveBeenCalled()
    await act(async () => {
      resolve(savedComment)
    })
    expect(props.onRefresh).toHaveBeenCalledTimes(1)
    expect(commentInput().value).toBe('')
    expect(commentInput().readOnly).toBe(false)
  })

  it('상세를 새로 받아 댓글이 늘어나도 쓰던 글과 requestId는 남는다', async () => {
    vi.mocked(createComment).mockRejectedValueOnce(new ApiError(422))
    const { props, rerender } = renderDetail()
    fillComment()
    await click('댓글 남기기')
    const firstRequest = structuredClone(vi.mocked(createComment).mock.calls[0])
    rerender(
      <IssueDetail {...props} issue={{ ...issue, comments: [...issue.comments, savedComment], commentCount: 3 }} />,
    )
    expect(screen.getByRole('heading', { name: '댓글 3개' })).toBeTruthy()
    expect(commentInput().value).toBe('  새 댓글\n둘째 줄  ')
    await click('댓글 남기기')
    expect(vi.mocked(createComment).mock.calls[1]).toEqual(firstRequest)
  })
})

describe('IssueDetail 댓글 저장 알림', () => {
  it.each(['처음 보내기', '잠긴 댓글 다시 보내기'])(
    '%s가 성공하면 저장된 댓글을 한 번 알린 뒤 상세 갱신을 요청한다',
    async (sending) => {
      const { props } = renderDetail()
      fillComment(savedComment.body)
      if (sending === '잠긴 댓글 다시 보내기') {
        vi.mocked(createComment).mockRejectedValueOnce(new TypeError('연결 끊김'))
        await click('댓글 남기기')
        expect(props.onCommented).not.toHaveBeenCalled()
        expect(props.onRefresh).not.toHaveBeenCalled()
        expect(commentInput().readOnly).toBe(true)
      }

      await click(sending === '처음 보내기' ? '댓글 남기기' : '다시 보내기')

      expect(props.onCommented).toHaveBeenCalledExactlyOnceWith(savedComment)
      expect(vi.mocked(props.onCommented).mock.calls[0][0]).toBe(savedComment)
      expect(props.onRefresh).toHaveBeenCalledExactlyOnceWith()
      expect(vi.mocked(props.onCommented).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(props.onRefresh).mock.invocationCallOrder[0],
      )
      expect(commentInput().value).toBe('')
      expect(commentInput().readOnly).toBe(false)
    },
  )

  it.each([
    { reason: '401', error: new ApiError(401) },
    { reason: '403', error: new ApiError(403) },
    { reason: '404', error: new ApiError(404) },
    { reason: '409', error: new ApiError(409, 'VERSION_CHANGED') },
    { reason: '422', error: new ApiError(422) },
    { reason: '500', error: new ApiError(500) },
    { reason: '연결 끊김', error: new TypeError('연결 끊김') },
  ])('처음 보내기와 잠긴 댓글 다시 보내기가 $reason이면 저장을 알리지 않는다', async ({ error }) => {
    const { props } = renderDetail()
    fillComment(savedComment.body)
    vi.mocked(createComment).mockRejectedValueOnce(error)
    await click('댓글 남기기')
    expect(createComment).toHaveBeenCalledTimes(1)
    expect(props.onCommented).not.toHaveBeenCalled()
    expect(props.onRefresh).not.toHaveBeenCalled()
    expect(commentInput().value).toBe(savedComment.body)

    // 처음 실패가 확정된 거절이면, 연결 실패를 한 번 거쳐 잠긴 상태도 확인한다.
    if (!commentInput().readOnly) {
      vi.mocked(createComment).mockRejectedValueOnce(new TypeError('연결 끊김'))
      await click('댓글 남기기')
    }
    expect(commentInput().readOnly).toBe(true)
    const attempts = vi.mocked(createComment).mock.calls.length
    vi.mocked(createComment).mockRejectedValueOnce(error)
    await click('다시 보내기')
    expect(createComment).toHaveBeenCalledTimes(attempts + 1)
    expect(props.onCommented).not.toHaveBeenCalled()
    expect(props.onRefresh).not.toHaveBeenCalled()
    expect(commentInput().value).toBe(savedComment.body)
  })
})

describe('IssueDetail 댓글 초안 알림', () => {
  it('처음 그리면 저장되지 않은 댓글이 없다고 알린다', () => {
    const { props } = renderDetail()
    expect(props.onDraftChange).toHaveBeenCalledWith(false)
    expect(props.onDraftChange).not.toHaveBeenCalledWith(true)
  })

  it('댓글 글을 쓰면 초안이 있다고 알리고 모두 지우면 없다고 알린다', () => {
    const { props } = renderDetail()
    fillComment()
    expect(props.onDraftChange).toHaveBeenLastCalledWith(true)

    fillComment('')
    expect(props.onDraftChange).toHaveBeenLastCalledWith(false)
  })

  it('공백만 쓴 댓글은 초안으로 알리지 않는다', () => {
    const { props } = renderDetail()
    fillComment(' \n\t ')
    expect(props.onDraftChange).toHaveBeenLastCalledWith(false)
    expect(props.onDraftChange).not.toHaveBeenCalledWith(true)

    fillComment('쓰던 댓글')
    expect(props.onDraftChange).toHaveBeenLastCalledWith(true)
    fillComment(' \n\t ')
    expect(props.onDraftChange).toHaveBeenLastCalledWith(false)
  })

  it.each(['처음 보내기', '다시 보내기'])('%s로 댓글이 저장되면 초안이 없다고 알린다', async (sending) => {
    const { props } = renderDetail()
    fillComment(savedComment.body)
    expect(props.onDraftChange).toHaveBeenLastCalledWith(true)
    if (sending === '다시 보내기') {
      vi.mocked(createComment).mockRejectedValueOnce(new TypeError('Failed to fetch'))
      await click('댓글 남기기')
      expect(props.onDraftChange).toHaveBeenLastCalledWith(true)
    }

    await click(sending === '처음 보내기' ? '댓글 남기기' : '다시 보내기')
    expect(props.onCommented).toHaveBeenCalledExactlyOnceWith(savedComment)
    expect(commentInput().value).toBe('')
    expect(props.onDraftChange).toHaveBeenLastCalledWith(false)
  })

  it('댓글을 보내는 중과 연결 실패로 잠긴 동안 초안이 있다는 알림을 유지한다', async () => {
    let reject!: (reason: unknown) => void
    vi.mocked(createComment).mockReturnValueOnce(
      new Promise((_resolve, fail) => {
        reject = fail
      }),
    )
    const { props } = renderDetail()
    fillComment(savedComment.body)
    expect(props.onDraftChange).toHaveBeenLastCalledWith(true)
    vi.mocked(props.onDraftChange).mockClear()

    await click('댓글 남기기')
    expect(createComment).toHaveBeenCalledTimes(1)
    expect(commentInput().readOnly).toBe(true)
    expect(commentInput().value).toBe(savedComment.body)
    expect(props.onDraftChange).not.toHaveBeenCalledWith(false)

    await act(async () => reject(new TypeError('Failed to fetch')))
    expect(screen.getByRole('button', { name: '다시 보내기' })).toBeTruthy()
    expect(commentInput().readOnly).toBe(true)
    expect(commentInput().value).toBe(savedComment.body)
    expect(props.onDraftChange).not.toHaveBeenCalledWith(false)
  })

  it('쓰던 댓글이 있는 상세를 없애면 마지막으로 초안이 없다고 알린다', () => {
    const { props, unmount } = renderDetail()
    fillComment()
    expect(props.onDraftChange).toHaveBeenLastCalledWith(true)
    unmount()
    expect(props.onDraftChange).toHaveBeenLastCalledWith(false)
  })

  it('canWrite가 false여서 댓글 칸을 감춰도 쓰던 초안이 있다는 알림을 유지한다', () => {
    const { props, rerender } = renderDetail()
    fillComment(savedComment.body)
    expect(props.onDraftChange).toHaveBeenLastCalledWith(true)
    vi.mocked(props.onDraftChange).mockClear()

    rerender(<IssueDetail {...props} canWrite={false} />)
    expect(screen.queryByRole('textbox', { name: '댓글' })).toBeNull()
    expect(props.onDraftChange).not.toHaveBeenCalledWith(false)

    rerender(<IssueDetail {...props} canWrite />)
    expect(commentInput().value).toBe(savedComment.body)
    expect(props.onDraftChange).not.toHaveBeenCalledWith(false)
  })
})
