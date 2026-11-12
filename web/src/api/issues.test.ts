import { ApiError } from './client.ts'
import {
  attachIssuePhoto,
  createComment,
  createIssue,
  getIssue,
  ISSUE_STATUS_LABELS,
  listIssues,
  removeIssuePhoto,
  startIssue,
  type IssueComment,
  type IssueDetail,
  type IssueSummary,
  type NewComment,
  type NewIssue,
} from './issues.ts'

const projectId = '43a30b6d-1b77-46ba-8743-061b463c1d37'
const issueId = '250a258d-7af0-41b0-8eb8-5cbfa80105ce'
const versionId = 'd565474f-17a5-4a8e-9b61-bde406fefdf3'
const screenId = '0314675d-2c6d-47fc-807b-57af90d23564'
const attachmentId = 'a15508e5-2f72-4a81-b57b-e66528971c89'
const requestId = 'f056d584-e8eb-42e6-b421-33ef45f6c92f'
const photo = new File(['photo bytes'], '참고 사진.png', { type: 'image/png' })
const newIssue: NewIssue = { requestId, versionId, title: '  버튼 "색상"  ', body: '첫 줄\n<script>참고</script>' }
const newComment: NewComment = { requestId, versionId, body: '  댓글 "내용"\n다음 줄  ' }
const comment: IssueComment = {
  id: 'comment-id',
  authorName: '김수정',
  versionNumber: 2,
  body: '댓글 "내용"\n다음 줄',
  createdAt: '2026-11-11T09:00:00.000Z',
}
const summary: IssueSummary = {
  id: issueId,
  number: 14,
  title: '버튼 "색상"',
  status: 'OPEN',
  authorName: '김수정',
  createdAt: '2026-11-10T09:00:00.000Z',
  commentCount: 1,
  originVersion: { id: versionId, number: 0 },
  origin: {
    screenId,
    screenName: '상품 상세',
    viewport: 'PC',
    asset: { id: 'origin-asset', width: 1440, height: 900 },
    xRatio: 0.25,
    yRatio: 0.75,
  },
}
const detail: IssueDetail = {
  ...summary,
  body: newIssue.body,
  isMine: true,
  attachments: [{ id: attachmentId, assetId: 'reference-asset', width: 800, height: 600 }],
  comments: [comment],
}
const encodedIds = [
  { id: '../auth/me', encoded: '..%2Fauth%2Fme' },
  { id: 'a/b', encoded: 'a%2Fb' },
  { id: 'a?b', encoded: 'a%3Fb' },
  { id: 'a#b', encoded: 'a%23b' },
  { id: 'a%2Fb', encoded: 'a%252Fb' },
]

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('listIssues', () => {
  it('GET으로 받은 번호 순서와 처음 버전·핀·위치 없음 정보를 그대로 돌려준다', async () => {
    const issues: IssueSummary[] = [
      summary,
      { ...summary, id: 'older-issue', number: 13, status: 'IN_PROGRESS', origin: null, commentCount: 0 },
    ]
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(issues))

    await expect(listIssues(projectId)).resolves.toEqual(issues)

    expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/projects/${projectId}/issues`)
  })

  it('쪽지가 없으면 빈 배열을 돌려준다', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json([]))

    await expect(listIssues(projectId)).resolves.toEqual([])

    expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/projects/${projectId}/issues`)
  })
})

describe('getIssue', () => {
  it.each([detail, { ...detail, origin: null, isMine: false, attachments: [], comments: [], commentCount: 0 }])(
    'GET으로 본문·작성자 여부·참고 사진·댓글과 null 값을 그대로 돌려준다: isMine=$isMine',
    async (responseBody) => {
      vi.mocked(fetch).mockResolvedValueOnce(Response.json(responseBody))

      await expect(getIssue(issueId)).resolves.toEqual(responseBody)

      expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/issues/${issueId}`)
    },
  )
})

describe('createIssue', () => {
  it.each([
    { screenId, xRatio: 0.25, yRatio: 0.75 },
    { screenId, xRatio: 0, yRatio: 1 },
    { screenId, xRatio: 1, yRatio: 0 },
  ])('핀 ($xRatio, $yRatio)의 세 칸을 JSON 본문에 펴서 POST하고 pin 키는 보내지 않는다', async (pin) => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(detail, { status: 201 }))

    await expect(createIssue(projectId, { ...newIssue, pin })).resolves.toEqual(detail)

    expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/projects/${projectId}/issues`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...newIssue, screenId, xRatio: pin.xRatio, yRatio: pin.yRatio }),
    })
  })

  it.each<NewIssue>([
    newIssue,
    { ...newIssue, pin: undefined },
    { ...newIssue, body: '' },
    { ...newIssue, title: '제'.repeat(120), body: '글'.repeat(4000) },
  ])('핀이 없으면 pin·screenId·xRatio·yRatio 없이 글과 요청 번호를 그대로 POST한다: %j', async (input) => {
    const responseBody = { ...detail, origin: null }
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(responseBody, { status: 201 }))

    await expect(createIssue(projectId, input)).resolves.toEqual(responseBody)

    expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/projects/${projectId}/issues`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, versionId, title: input.title, body: input.body }),
    })
  })
})

describe('createComment', () => {
  it.each([newComment, { ...newComment, body: '글'.repeat(2000) }])(
    'requestId·versionId·본문을 JSON POST하고 서버의 댓글을 그대로 돌려준다',
    async (input) => {
      vi.mocked(fetch).mockResolvedValueOnce(Response.json(comment, { status: 201 }))

      await expect(createComment(issueId, input)).resolves.toEqual(comment)

      expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/issues/${issueId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      })
    },
  )
})

describe('startIssue', () => {
  it('versionId만 JSON POST하고 수정 중인 쪽지 상세를 그대로 돌려준다', async () => {
    const responseBody: IssueDetail = { ...detail, status: 'IN_PROGRESS' }
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(responseBody))

    await expect(startIssue(issueId, versionId)).resolves.toEqual(responseBody)

    expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/issues/${issueId}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ versionId }),
    })
  })
})

describe('attachIssuePhoto', () => {
  it('file 칸에 받은 File 하나만 담아 POST하고 Content-Type을 직접 붙이지 않는다', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(detail, { status: 201 }))

    await expect(attachIssuePhoto(issueId, photo)).resolves.toEqual(detail)

    expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/issues/${issueId}/attachments`, {
      method: 'POST',
      body: expect.any(FormData),
    })
    const options = vi.mocked(fetch).mock.calls[0][1]
    const form = options?.body as FormData
    const entries: [string, FormDataEntryValue][] = []
    form.forEach((value, key) => entries.push([key, value]))
    expect(entries).toEqual([['file', photo]])
    expect(form.get('file')).toBe(photo)
    expect(new Headers(options?.headers).has('Content-Type')).toBe(false)
  })
})

describe('removeIssuePhoto', () => {
  it('본문 없이 DELETE하고 사진이 빠진 상세를 그대로 돌려준다', async () => {
    const responseBody = { ...detail, attachments: [] }
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(responseBody))

    await expect(removeIssuePhoto(issueId, attachmentId)).resolves.toEqual(responseBody)

    expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/issues/${issueId}/attachments/${attachmentId}`, {
      method: 'DELETE',
    })
  })

  it('쪽지와 첨부 ID에 모두 /가 있어도 각각 한 덩어리로 인코딩한다', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(detail))

    await removeIssuePhoto('issue/one', 'attachment/two')

    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/issues/issue%2Fone/attachments/attachment%2Ftwo', {
      method: 'DELETE',
    })
  })
})

describe.each([
  { name: 'listIssues', call: listIssues, prefix: '/api/projects/', suffix: '/issues' },
  { name: 'getIssue', call: getIssue, prefix: '/api/issues/', suffix: '' },
  { name: 'createIssue', call: (id: string) => createIssue(id, newIssue), prefix: '/api/projects/', suffix: '/issues' },
  {
    name: 'createComment',
    call: (id: string) => createComment(id, newComment),
    prefix: '/api/issues/',
    suffix: '/comments',
  },
  { name: 'startIssue', call: (id: string) => startIssue(id, versionId), prefix: '/api/issues/', suffix: '/start' },
  {
    name: 'attachIssuePhoto',
    call: (id: string) => attachIssuePhoto(id, photo),
    prefix: '/api/issues/',
    suffix: '/attachments',
  },
  {
    name: 'removeIssuePhoto 쪽지',
    call: (id: string) => removeIssuePhoto(id, attachmentId),
    prefix: '/api/issues/',
    suffix: `/attachments/${attachmentId}`,
  },
  {
    name: 'removeIssuePhoto 첨부',
    call: (id: string) => removeIssuePhoto(issueId, id),
    prefix: `/api/issues/${issueId}/attachments/`,
    suffix: '',
  },
])('$name ID 인코딩', ({ call, prefix, suffix }) => {
  it.each(encodedIds)('$id를 $encoded 한 덩어리로 보낸다', async ({ id, encoded }) => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(detail))

    await call(id)

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(`${prefix}${encoded}${suffix}`)
  })
})

describe.each([
  { name: 'listIssues', call: () => listIssues(projectId), statuses: [401, 404], codes: [] },
  { name: 'getIssue', call: () => getIssue(issueId), statuses: [401, 404], codes: [] },
  {
    name: 'createIssue',
    call: () => createIssue(projectId, newIssue),
    statuses: [401, 403, 404, 422],
    codes: ['VERSION_CHANGED', 'VERSION_NOT_IN_REVIEW', 'REQUEST_ID_REUSED'],
  },
  {
    name: 'createComment',
    call: () => createComment(issueId, newComment),
    statuses: [401, 403, 404, 422],
    codes: ['VERSION_CHANGED', 'VERSION_NOT_IN_REVIEW', 'REQUEST_ID_REUSED'],
  },
  {
    name: 'startIssue',
    call: () => startIssue(issueId, versionId),
    statuses: [401, 403, 404, 422],
    codes: ['VERSION_CHANGED', 'VERSION_NOT_IN_REVIEW', 'ISSUE_NOT_OPEN'],
  },
  {
    name: 'attachIssuePhoto',
    call: () => attachIssuePhoto(issueId, photo),
    statuses: [400, 401, 403, 404, 413, 415, 422],
    codes: ['VERSION_NOT_IN_REVIEW', 'TOO_MANY_ATTACHMENTS'],
  },
  {
    name: 'removeIssuePhoto',
    call: () => removeIssuePhoto(issueId, attachmentId),
    statuses: [401, 403, 404],
    codes: ['VERSION_NOT_IN_REVIEW'],
  },
])('$name 실패 처리', ({ call, statuses, codes }) => {
  it.each(statuses)('%i 응답은 ApiError로 전달하고 다시 요청하지 않는다', async (status) => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ message: '요청을 처리할 수 없어요' }, { status }))

    const result = call()

    await expect(result).rejects.toBeInstanceOf(ApiError)
    await expect(result).rejects.toMatchObject({ status, code: undefined })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each(codes)('409의 %s 코드를 잃지 않고 전달한다', async (code) => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ code }, { status: 409 }))

    const result = call()

    await expect(result).rejects.toBeInstanceOf(ApiError)
    await expect(result).rejects.toMatchObject({ status: 409, code })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('JSON이 아닌 서버 오류도 상태를 잃지 않고 ApiError로 전달한다', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('<html>Bad Gateway</html>', { status: 502 }))

    const result = call()

    await expect(result).rejects.toBeInstanceOf(ApiError)
    await expect(result).rejects.toMatchObject({ status: 502, code: undefined })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('연결이 끊기면 자동 재전송 없이 원래 오류를 전달한다', async () => {
    const error = new TypeError('Failed to fetch')
    vi.mocked(fetch).mockRejectedValueOnce(error)

    await expect(call()).rejects.toBe(error)

    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe.each([
  {
    name: 'createIssue',
    call: () => createIssue(projectId, { ...newIssue, pin: { screenId, xRatio: 0, yRatio: 1 } }),
    responseBody: detail,
  },
  { name: 'createComment', call: () => createComment(issueId, newComment), responseBody: comment },
])('$name 재전송', ({ call, responseBody }) => {
  it('연결 실패 뒤 다시 호출해도 처음 requestId·versionId·글·핀을 그대로 보내고 서버 응답을 돌려준다', async () => {
    const error = new TypeError('Failed to fetch')
    vi.mocked(fetch).mockRejectedValueOnce(error)

    await expect(call()).rejects.toBe(error)

    vi.mocked(fetch).mockResolvedValueOnce(Response.json(responseBody, { status: 201 }))

    await expect(call()).resolves.toEqual(responseBody)

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(vi.mocked(fetch).mock.calls[1]).toEqual(vi.mocked(fetch).mock.calls[0])
  })
})

describe('ISSUE_STATUS_LABELS', () => {
  it('접수와 수정 중 두 상태의 한국어 이름을 제공한다', () => {
    expect(ISSUE_STATUS_LABELS).toEqual({ OPEN: '접수', IN_PROGRESS: '수정 중' })
  })
})
