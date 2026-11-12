import { ApiError } from './client.ts'
import {
  attachIssuePhoto,
  createComment,
  createIssue,
  dueDateLabel,
  getIssue,
  isOverdue,
  isUnresolved,
  ISSUE_CATEGORY_LABELS,
  ISSUE_SCOPE_LABELS,
  ISSUE_STATUS_LABELS,
  listIssues,
  removeIssuePhoto,
  startIssue,
  updateIssue,
  type IssueCategory,
  type IssueChange,
  type IssueComment,
  type IssueDetail,
  type IssueSummary,
  type IssueStatus,
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
  category: 'BUG',
  scope: 'IN_SCOPE',
  dueDate: null,
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
  vi.useRealTimers()
  vi.unstubAllEnvs()
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
  it.each<IssueCategory>(['BUG', 'DESIGN', 'COPY', 'OTHER'])(
    '고른 분류 %s를 쓰기 본문에 그대로 넣는다',
    async (category) => {
      const responseBody = { ...detail, category }
      vi.mocked(fetch).mockResolvedValueOnce(Response.json(responseBody, { status: 201 }))

      await expect(createIssue(projectId, { ...newIssue, category })).resolves.toEqual(responseBody)

      expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/projects/${projectId}/issues`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...newIssue, category }),
      })
    },
  )

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

describe('updateIssue', () => {
  it.each<IssueChange>([
    { category: 'DESIGN' },
    { scope: 'OUT_OF_SCOPE' },
    { dueDate: '2026-01-05' },
    { dueDate: null },
    { category: 'COPY', scope: 'OUT_OF_SCOPE', dueDate: '2027-01-05' },
    { category: 'OTHER', scope: 'IN_SCOPE', dueDate: null },
    { category: 'BUG', scope: undefined, dueDate: undefined },
  ])('versionId와 보낸 칸만 JSON PATCH한다: %j', async (change) => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(detail))

    await expect(updateIssue(issueId, versionId, change)).resolves.toEqual(detail)

    expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/issues/${issueId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ versionId, ...change }),
    })
  })

  it('바뀐 값과 자동 댓글이 든 서버 상세를 그대로 돌려준다', async () => {
    const change: IssueChange = { scope: 'OUT_OF_SCOPE', dueDate: '2027-01-05' }
    const responseBody = {
      ...detail,
      ...change,
      commentCount: 3,
      comments: [
        comment,
        { ...comment, id: 'scope-comment', body: '범위: 하자 수정 → 추가 요청' },
        { ...comment, id: 'due-date-comment', body: '마감일: 없음 → 2027년 1월 5일' },
      ],
    }
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(responseBody))

    await expect(updateIssue(issueId, versionId, change)).resolves.toEqual(responseBody)
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
    name: 'updateIssue',
    call: (id: string) => updateIssue(id, versionId, { dueDate: null }),
    prefix: '/api/issues/',
    suffix: '',
  },
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
    name: 'updateIssue',
    call: () => updateIssue(issueId, versionId, { scope: 'OUT_OF_SCOPE' }),
    statuses: [401, 403, 404, 422, 500],
    codes: ['VERSION_CHANGED', 'VERSION_NOT_IN_REVIEW'],
  },
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

describe('쪽지 분류·범위 글자', () => {
  it('분류 네 개의 한국어 이름을 제공한다', () => {
    expect(ISSUE_CATEGORY_LABELS).toEqual({ BUG: '버그', DESIGN: '디자인', COPY: '문구', OTHER: '기타' })
  })

  it('범위 두 개의 한국어 이름을 제공한다', () => {
    expect(ISSUE_SCOPE_LABELS).toEqual({ IN_SCOPE: '하자 수정', OUT_OF_SCOPE: '추가 요청' })
  })
})

describe('분류·범위·마감일 응답', () => {
  it('목록의 기본값이 아닌 분류·범위와 마감일 글자를 그대로 돌려준다', async () => {
    const responseBody: IssueSummary[] = [
      summary,
      { ...summary, id: 'triaged-issue', category: 'OTHER', scope: 'OUT_OF_SCOPE', dueDate: '2027-01-05' },
    ]
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(responseBody))

    await expect(listIssues(projectId)).resolves.toEqual(responseBody)
  })

  it('상세의 기본값이 아닌 분류·범위와 마감일 글자를 그대로 돌려준다', async () => {
    const responseBody: IssueDetail = { ...detail, category: 'COPY', scope: 'OUT_OF_SCOPE', dueDate: '2026-01-05' }
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(responseBody))

    await expect(getIssue(issueId)).resolves.toEqual(responseBody)
  })
})

describe('isUnresolved', () => {
  it.each<IssueStatus>(['OPEN', 'IN_PROGRESS'])('%s는 아직 끝나지 않은 상태다', (status) => {
    expect(isUnresolved(status)).toBe(true)
  })

  // 끝난 상태는 6번에서 타입에 생긴다. 서버에서 그런 값을 받더라도 미해결로 세지 않는다.
  it.each(['VERIFIED', 'WITHDRAWN'])('%s는 끝나지 않은 상태가 아니다', (status) => {
    expect(isUnresolved(status as IssueStatus)).toBe(false)
  })
})

describe('isOverdue', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 10, 15, 12))
  })

  it.each<IssueStatus>(['OPEN', 'IN_PROGRESS'])(
    '%s 쪽지는 어제만 마감 지남이고 당일·내일·마감일 없음은 아니다',
    (status) => {
      expect(isOverdue({ status, dueDate: '2026-11-14' })).toBe(true)
      expect(isOverdue({ status, dueDate: '2026-11-15' })).toBe(false)
      expect(isOverdue({ status, dueDate: '2026-11-16' })).toBe(false)
      expect(isOverdue({ status, dueDate: null })).toBe(false)
    },
  )

  it.each(['VERIFIED', 'WITHDRAWN'])('끝난 상태 %s는 마감일이 지났어도 마감 지남이 아니다', (status) => {
    expect(isOverdue({ status: status as IssueStatus, dueDate: '2026-11-14' })).toBe(false)
  })

  it.each([
    { name: '보통 날', year: 2026, month: 11, day: 15, dueDate: '2026-11-15' },
    { name: '월말', year: 2026, month: 11, day: 30, dueDate: '2026-11-30' },
    { name: '연말', year: 2026, month: 12, day: 31, dueDate: '2026-12-31' },
    { name: '윤년 2월 말', year: 2028, month: 2, day: 29, dueDate: '2028-02-29' },
  ])('$name 자정 직전에는 당일이고 자정 직후에 마감 지남으로 바뀐다', ({ year, month, day, dueDate }) => {
    vi.setSystemTime(new Date(year, month - 1, day, 23, 59, 59, 999))
    expect(isOverdue({ status: 'OPEN', dueDate })).toBe(false)

    vi.setSystemTime(new Date(year, month - 1, day + 1, 0, 0, 0, 0))
    expect(isOverdue({ status: 'OPEN', dueDate })).toBe(true)
  })

  it.each([
    { now: [2026, 1, 5], yesterday: '2026-01-04', today: '2026-01-05', tomorrow: '2026-01-06' },
    { now: [2026, 9, 9], yesterday: '2026-09-08', today: '2026-09-09', tomorrow: '2026-09-10' },
    { now: [2026, 9, 30], yesterday: '2026-09-29', today: '2026-09-30', tomorrow: '2026-10-01' },
    { now: [2026, 10, 1], yesterday: '2026-09-30', today: '2026-10-01', tomorrow: '2026-10-02' },
    { now: [2027, 1, 1], yesterday: '2026-12-31', today: '2027-01-01', tomorrow: '2027-01-02' },
  ])('한 자리 월·일도 두 자리 날짜 글자로 비교한다: $today', ({ now, yesterday, today, tomorrow }) => {
    vi.setSystemTime(new Date(now[0], now[1] - 1, now[2], 12))

    expect(isOverdue({ status: 'OPEN', dueDate: yesterday })).toBe(true)
    expect(isOverdue({ status: 'OPEN', dueDate: today })).toBe(false)
    expect(isOverdue({ status: 'OPEN', dueDate: tomorrow })).toBe(false)
  })

  it('UTC로는 전날인 한국 새벽에도 보는 사람의 한국 날짜로 판단한다', () => {
    vi.stubEnv('TZ', 'Asia/Seoul')
    vi.setSystemTime(new Date('2026-11-15T00:30:00+09:00'))

    expect(new Date().getHours()).toBe(0)
    expect(new Date().getDate()).toBe(15)
    expect(new Date().toISOString()).toBe('2026-11-14T15:30:00.000Z')
    expect(isOverdue({ status: 'OPEN', dueDate: '2026-11-14' })).toBe(true)
    expect(isOverdue({ status: 'OPEN', dueDate: '2026-11-15' })).toBe(false)
  })
})

describe('dueDateLabel', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 10, 15, 12))
  })

  it.each([
    ['2026-11-15', '11월 15일'],
    ['2026-01-05', '1월 5일'],
    ['2027-01-05', '2027년 1월 5일'],
    ['2025-12-31', '2025년 12월 31일'],
    ['2028-02-29', '2028년 2월 29일'],
  ])('%s는 앞 0 없이 %s로 표시한다', (dueDate, expected) => {
    expect(dueDateLabel(dueDate)).toBe(expected)
  })

  it('한국에서 해가 바뀌면 UTC 연도와 달라도 한국의 올해를 기준으로 해를 붙인다', () => {
    vi.stubEnv('TZ', 'Asia/Seoul')
    vi.setSystemTime(new Date('2026-12-31T23:59:59.999+09:00'))
    expect(dueDateLabel('2026-12-31')).toBe('12월 31일')
    expect(dueDateLabel('2027-01-05')).toBe('2027년 1월 5일')

    vi.setSystemTime(new Date('2027-01-01T00:00:00+09:00'))
    expect(new Date().getFullYear()).toBe(2027)
    expect(new Date().getUTCFullYear()).toBe(2026)
    expect(dueDateLabel('2026-12-31')).toBe('2026년 12월 31일')
    expect(dueDateLabel('2027-01-05')).toBe('1월 5일')
  })
})
