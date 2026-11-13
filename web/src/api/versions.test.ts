import { ApiError } from './client.ts'
import {
  APPROVE_WAIT_MS,
  approveVersion,
  assetUrl,
  versionLabel,
  createDraft,
  getVersion,
  getApprovalCheck,
  getCertificate,
  listActivity,
  listVersions,
  publishVersion,
  putScreenPhoto,
  removeDraftScreen,
  updateDraft,
  type ActivityItem,
  type ApprovalCheck,
  type Certificate,
  type DraftChanges,
  type VersionDetail,
  type VersionSummary,
} from './versions.ts'

const projectId = '43a30b6d-1b77-46ba-8743-061b463c1d37'
const versionId = 'd565474f-17a5-4a8e-9b61-bde406fefdf3'
const screenId = '250a258d-7af0-41b0-8eb8-5cbfa80105ce'
const photo = new File(['photo bytes'], '메인.png', { type: 'image/png' })
const draft: VersionDetail = {
  approval: null,
  id: versionId,
  projectId,
  number: null,
  status: 'DRAFT',
  summary: '',
  testUrl: null,
  publishedAt: null,
  screens: [],
}
const draftWithScreens: VersionDetail = {
  ...draft,
  summary: '두 화면을 바꿨어요',
  testUrl: 'https://example.com/review?version=2',
  screens: [
    {
      screenId,
      name: '메인',
      viewport: 'PC',
      hiddenAt: null,
      asset: { id: 'desktop-asset', width: 1440, height: 900 },
    },
    {
      screenId: 'mobile-screen',
      name: '메인',
      viewport: 'MOBILE',
      hiddenAt: '2026-11-07T09:00:00.000Z',
      asset: { id: 'mobile-asset', width: 390, height: 844 },
    },
  ],
}
const published: VersionDetail = {
  ...draftWithScreens,
  number: 2,
  status: 'IN_REVIEW',
  publishedAt: '2026-11-08T09:00:00.000Z',
  screens: [draftWithScreens.screens[0]],
}
const approved: VersionDetail = {
  ...published,
  status: 'APPROVED',
  approval: { approverName: '김승인', approvedAt: '2026-11-13T06:11:00.000Z' },
}
const certificate: Certificate = {
  certificateNumber: '057cab8c-808d-4a41-b488-15d4318f1949',
  project: { id: projectId, name: '쇼핑몰 리뉴얼' },
  version: { id: versionId, number: 2, publishedAt: '2026-11-10T01:00:00.000Z' },
  approval: { approverName: '김승인', approvedAt: '2026-11-13T06:10:22.123Z' },
  developerName: '김개발',
  screens: [
    { name: '메인', viewport: 'PC' },
    { name: '로그인', viewport: 'MOBILE' },
  ],
  counts: { verified: 1, withdrawn: 1, outOfScope: 2 },
  issues: [
    { number: 1, title: '  <b>버튼 색</b>\n수정  ', category: 'BUG', scope: 'IN_SCOPE', status: 'VERIFIED' },
    { number: 3, title: '화면 추가', category: 'DESIGN', scope: 'OUT_OF_SCOPE', status: 'OPEN' },
    { number: 5, title: '문구 변경', category: 'COPY', scope: 'IN_SCOPE', status: 'WITHDRAWN' },
    { number: 8, title: '추가 요청 완료', category: 'OTHER', scope: 'OUT_OF_SCOPE', status: 'VERIFIED' },
  ],
}
const approvalCheck: ApprovalCheck = {
  serverTime: '2026-11-13T06:10:22.123456Z',
  unresolved: [
    { id: 'issue-1', number: 1, title: '버튼 위치', status: 'OPEN' },
    { id: 'issue-2', number: 2, title: '글자 색', status: 'IN_PROGRESS' },
    { id: 'issue-3', number: 3, title: '모바일 여백', status: 'READY_FOR_REVIEW' },
  ],
  outOfScope: [{ id: 'extra-issue', number: 4, title: '화면 추가', status: 'READY_FOR_REVIEW' }],
  comments: [
    {
      id: 'comment-1',
      issueId: 'issue-1',
      issueNumber: 1,
      issueTitle: '버튼 위치',
      authorName: '김개발',
      body: '범위를 바꿨어요',
      createdAt: '2026-11-13T06:09:00.000001Z',
    },
    {
      id: 'comment-2',
      issueId: 'extra-issue',
      issueNumber: 4,
      issueTitle: '화면 추가',
      authorName: '김승인',
      body: '  다음 차수에서 확인할게요\n설명 감사합니다  ',
      createdAt: '2026-11-13T06:09:00.000002Z',
    },
  ],
}
const versions: VersionSummary[] = [
  { id: versionId, number: null, status: 'DRAFT', publishedAt: null },
  { id: 'second-version', number: 2, status: 'IN_REVIEW', publishedAt: '2026-11-08T09:00:00.000Z' },
  { id: 'first-version', number: 1, status: 'APPROVED', publishedAt: '2026-11-07T09:00:00.000Z' },
]
const activity: ActivityItem[] = [
  {
    id: 'new-event',
    mailFailedTo: [],
    issue: null,
    type: 'VERSION_PUBLISHED',
    createdAt: '2026-11-08T09:00:00.000Z',
    actorName: '김개발',
    memberName: null,
    version: { id: versionId, number: 2 },
  },
  {
    id: 'old-event',
    mailFailedTo: [],
    issue: null,
    type: 'VERSION_PUBLISHED',
    createdAt: '2026-11-07T09:00:00.000Z',
    actorName: '김개발',
    memberName: null,
    version: null,
  },
]
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
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe.each([
  { name: 'listVersions', call: listVersions, path: 'versions', responseBody: versions },
  { name: 'listActivity', call: listActivity, path: 'activity', responseBody: activity },
])('$name', ({ call, path, responseBody }) => {
  it('GET을 한 번 요청하고 서버의 순서와 null 값을 그대로 돌려준다', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(responseBody), { status: 200 }))

    await expect(call(projectId)).resolves.toEqual(responseBody)

    expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/projects/${projectId}/${path}`)
  })

  it('서버가 빈 목록을 보내면 빈 배열을 돌려준다', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('[]', { status: 200 }))

    await expect(call(projectId)).resolves.toEqual([])

    expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/projects/${projectId}/${path}`)
  })
})

describe('listActivity 쪽지 사건', () => {
  it.each(['ISSUE_CREATED', 'ISSUE_STARTED'] as const)('%s의 쪽지 id와 번호를 그대로 돌려준다', async (type) => {
    const event: ActivityItem = {
      id: 'issue-event',
      mailFailedTo: [],
      type,
      createdAt: '2026-11-11T09:00:00.000Z',
      actorName: '김개발',
      memberName: null,
      version: null,
      issue: { id: 'issue-id', number: 14 },
    }
    vi.mocked(fetch).mockResolvedValueOnce(Response.json([event]))

    await expect(listActivity(projectId)).resolves.toEqual([event])

    expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/projects/${projectId}/activity`)
  })
})

describe('getVersion', () => {
  it.each([draft, draftWithScreens, published, approved])(
    '$status 상세와 화면 구성을 그대로 돌려준다',
    async (detail) => {
      vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(detail), { status: 200 }))

      await expect(getVersion(versionId)).resolves.toEqual(detail)

      expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/versions/${versionId}`)
    },
  )
})

describe('createDraft', () => {
  it.each([draft, draftWithScreens])('빈 JSON을 POST하고 서버가 만든 초안을 그대로 돌려준다', async (detail) => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(detail), { status: 201 }))

    await expect(createDraft(projectId)).resolves.toEqual(detail)

    expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/projects/${projectId}/versions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
  })
})

describe('updateDraft', () => {
  it.each<{ label: string; changes: DraftChanges }>([
    { label: '설명만', changes: { summary: '  수정 "설명" \\ 시안\n두 번째 줄  ' } },
    { label: '주소만', changes: { testUrl: 'https://example.com/review?a=1&b=2#screen' } },
    { label: '주소 지우기', changes: { testUrl: '' } },
    { label: '설명 지우기', changes: { summary: '' } },
    { label: '두 칸 함께', changes: { summary: '수정했어요', testUrl: '' } },
    { label: '빈 변경', changes: {} },
  ])('$label: 받은 칸과 값을 바꾸지 않고 JSON PATCH로 보낸다', async ({ changes }) => {
    const detail = { ...draftWithScreens, summary: '서버가 정리한 설명', testUrl: null }
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(detail), { status: 200 }))

    await expect(updateDraft(versionId, changes)).resolves.toEqual(detail)

    expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/versions/${versionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(changes),
    })
  })
})

describe('putScreenPhoto', () => {
  it('받은 File 하나만 file 칸에 담아 PUT하고 Content-Type을 직접 붙이지 않는다', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(draftWithScreens), { status: 200 }))

    await expect(putScreenPhoto(versionId, screenId, photo)).resolves.toEqual(draftWithScreens)

    expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/versions/${versionId}/screens/${screenId}/asset`, {
      method: 'PUT',
      body: expect.any(FormData),
    })
    const form = vi.mocked(fetch).mock.calls[0][1]?.body as FormData
    const entries: [string, FormDataEntryValue][] = []
    form.forEach((value, key) => entries.push([key, value]))
    expect(entries).toEqual([['file', photo]])
    expect(form.get('file')).toBe(photo)
  })
})

describe('removeDraftScreen', () => {
  it('본문 없이 DELETE하고 마지막 화면을 뺀 빈 초안을 그대로 돌려준다', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(draft), { status: 200 }))

    await expect(removeDraftScreen(versionId, screenId)).resolves.toEqual(draft)

    expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/versions/${versionId}/screens/${screenId}`, {
      method: 'DELETE',
    })
  })
})

describe('publishVersion', () => {
  it('빈 JSON을 POST하고 서버가 붙인 번호와 게시 시각을 그대로 돌려준다', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(published), { status: 200 }))

    await expect(publishVersion(versionId)).resolves.toEqual(published)

    expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/versions/${versionId}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
  })
})

describe.each([
  { name: 'listVersions', call: listVersions, prefix: '/api/projects/', suffix: '/versions' },
  { name: 'getVersion', call: getVersion, prefix: '/api/versions/', suffix: '' },
  { name: 'createDraft', call: createDraft, prefix: '/api/projects/', suffix: '/versions' },
  { name: 'updateDraft', call: (id: string) => updateDraft(id, {}), prefix: '/api/versions/', suffix: '' },
  {
    name: 'putScreenPhoto 버전',
    call: (id: string) => putScreenPhoto(id, screenId, photo),
    prefix: '/api/versions/',
    suffix: `/screens/${screenId}/asset`,
  },
  {
    name: 'putScreenPhoto 화면',
    call: (id: string) => putScreenPhoto(versionId, id, photo),
    prefix: `/api/versions/${versionId}/screens/`,
    suffix: '/asset',
  },
  {
    name: 'removeDraftScreen 버전',
    call: (id: string) => removeDraftScreen(id, screenId),
    prefix: '/api/versions/',
    suffix: `/screens/${screenId}`,
  },
  {
    name: 'removeDraftScreen 화면',
    call: (id: string) => removeDraftScreen(versionId, id),
    prefix: `/api/versions/${versionId}/screens/`,
    suffix: '',
  },
  { name: 'publishVersion', call: publishVersion, prefix: '/api/versions/', suffix: '/publish' },
  { name: 'getApprovalCheck', call: getApprovalCheck, prefix: '/api/versions/', suffix: '/approval-check' },
  { name: 'getCertificate', call: getCertificate, prefix: '/api/versions/', suffix: '/certificate' },
  {
    name: 'approveVersion',
    call: (id: string) => approveVersion(id, approvalCheck.serverTime),
    prefix: '/api/versions/',
    suffix: '/approve',
  },
  { name: 'listActivity', call: listActivity, prefix: '/api/projects/', suffix: '/activity' },
])('$name ID 인코딩', ({ call, prefix, suffix }) => {
  it.each(encodedIds)('$id를 $encoded 한 덩어리로 보낸다', async ({ id, encoded }) => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('{}', { status: 200 }))

    await call(id)

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(`${prefix}${encoded}${suffix}`)
  })
})

describe.each([
  { name: 'listVersions', call: () => listVersions(projectId), statuses: [401, 404], codes: [] },
  { name: 'getVersion', call: () => getVersion(versionId), statuses: [401, 404], codes: [] },
  { name: 'getCertificate', call: () => getCertificate(versionId), statuses: [401, 404, 500], codes: [] },
  {
    name: 'getApprovalCheck',
    call: () => getApprovalCheck(versionId),
    statuses: [401, 403, 404],
    codes: ['VERSION_CHANGED', 'VERSION_NOT_IN_REVIEW'],
  },
  {
    name: 'approveVersion',
    call: () => approveVersion(versionId, approvalCheck.serverTime),
    statuses: [401, 403, 404, 422],
    codes: ['VERSION_CHANGED', 'VERSION_NOT_IN_REVIEW', 'UNRESOLVED_ISSUES', 'NEW_COMMENTS'],
  },
  { name: 'createDraft', call: () => createDraft(projectId), statuses: [401, 403, 404], codes: ['DRAFT_EXISTS'] },
  {
    name: 'updateDraft',
    call: () => updateDraft(versionId, { summary: '수정' }),
    statuses: [401, 403, 404, 422],
    codes: ['VERSION_NOT_DRAFT'],
  },
  {
    name: 'putScreenPhoto',
    call: () => putScreenPhoto(versionId, screenId, photo),
    statuses: [401, 403, 404, 413, 415, 422],
    codes: ['VERSION_NOT_DRAFT', 'SCREEN_HIDDEN', 'TOO_MANY_SCREENS'],
  },
  {
    name: 'removeDraftScreen',
    call: () => removeDraftScreen(versionId, screenId),
    statuses: [401, 403, 404],
    codes: ['VERSION_NOT_DRAFT'],
  },
  {
    name: 'publishVersion',
    call: () => publishVersion(versionId),
    statuses: [401, 403, 404],
    codes: ['VERSION_NOT_DRAFT', 'NO_SCREENS', 'SCREEN_HIDDEN'],
  },
  { name: 'listActivity', call: () => listActivity(projectId), statuses: [401, 404], codes: [] },
])('$name 실패 처리', ({ call, statuses, codes }) => {
  it.each(statuses)('%i 응답은 ApiError로 전달하고 다시 요청하지 않는다', async (status) => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ statusCode: status, message: '요청을 처리할 수 없어요' }), { status }),
    )

    const result = call()

    await expect(result).rejects.toBeInstanceOf(ApiError)
    await expect(result).rejects.toMatchObject({ status, code: undefined })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each(codes)('409의 %s 코드를 잃지 않고 전달한다', async (code) => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ statusCode: 409, message: '요청이 충돌했어요', code }), { status: 409 }),
    )

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

  it('네트워크 오류는 원래 오류를 그대로 전달한다', async () => {
    const networkError = new TypeError('Failed to fetch')
    vi.mocked(fetch).mockRejectedValueOnce(networkError)

    await expect(call()).rejects.toBe(networkError)

    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('assetUrl', () => {
  it.each([{ id: 'photo-id', encoded: 'photo-id' }, ...encodedIds])(
    '$id의 사진 주소만 만들고 fetch를 부르지 않는다',
    ({ id, encoded }) => {
      expect(assetUrl(id)).toBe(`/api/assets/${encoded}`)

      expect(fetch).not.toHaveBeenCalled()
    },
  )
})

describe('versionLabel', () => {
  it.each([
    [0, '초안'],
    [1, '1차'],
    [2, '2차'],
  ] as const)('%i의 이름은 %s다', (number, label) => {
    expect(versionLabel(number)).toBe(label)
  })
})

describe('getApprovalCheck', () => {
  it.each([
    { label: '쪽지와 댓글이 있는', body: approvalCheck },
    { label: '세 목록이 비어 있는', body: { ...approvalCheck, unresolved: [], outOfScope: [], comments: [] } },
  ])('$label 승인 검토와 마이크로초 서버 시각을 그대로 돌려준다', async ({ body }) => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(body))

    await expect(getApprovalCheck(versionId)).resolves.toEqual(body)

    expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/versions/${versionId}/approval-check`)
  })
})

describe('getCertificate', () => {
  it.each([0, 2])('%i번 버전의 확인서를 GET하고 모든 칸과 목록 순서를 그대로 돌려준다', async (number) => {
    const body: Certificate = { ...certificate, version: { ...certificate.version, number } }
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(body))

    await expect(getCertificate(versionId)).resolves.toEqual(body)

    expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/versions/${versionId}/certificate`)
  })

  it('쪽지가 없는 확인서는 0인 집계와 빈 목록을 그대로 돌려준다', async () => {
    const body: Certificate = {
      ...certificate,
      counts: { verified: 0, withdrawn: 0, outOfScope: 0 },
      issues: [],
    }
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(body))

    await expect(getCertificate(versionId)).resolves.toEqual(body)

    expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/versions/${versionId}/certificate`)
  })

  it('대문자 UUID도 바꾸지 않고 서버에 보낸다', async () => {
    const uppercaseId = versionId.toUpperCase()
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(certificate))

    await expect(getCertificate(uppercaseId)).resolves.toEqual(certificate)

    expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/versions/${uppercaseId}/certificate`)
  })

  it('200 응답의 본문을 읽다가 연결이 끊겨도 원래 오류를 전달한다', async () => {
    const error = new TypeError('응답을 읽지 못했어요')
    const response = Response.json(certificate)
    vi.spyOn(response, 'json').mockRejectedValueOnce(error)
    vi.mocked(fetch).mockResolvedValueOnce(response)

    await expect(getCertificate(versionId)).rejects.toBe(error)

    expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/versions/${versionId}/certificate`)
  })
})

describe('approveVersion', () => {
  it.each(['2026-11-13T06:10:22.123456Z', '2026-11-13T06:10:22.000001Z'])(
    'seenAt %s만 원문 그대로 POST하고 승인 상세를 그대로 돌려준다',
    async (seenAt) => {
      vi.mocked(fetch).mockResolvedValueOnce(Response.json(approved))

      await expect(approveVersion(versionId, seenAt)).resolves.toEqual(approved)

      expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/versions/${versionId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seenAt }),
        signal: expect.any(AbortSignal),
      })
    },
  )
})

describe('approveVersion 기다리는 한도', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('공개된 승인 대기 한도는 30초다', () => {
    expect(APPROVE_WAIT_MS).toBe(30_000)
  })

  it.each(['응답', '응답 본문'] as const)(
    '%s을 기다리는 동안 29,999ms에는 끊기지 않고 30,000ms에 끊겨 ApiError가 아닌 오류로 끝난다',
    async (stage) => {
      const response = Response.json(approved)
      const readJson = vi.spyOn(response, 'json')
      vi.mocked(fetch).mockImplementationOnce(async (_input, init) => {
        const signal = init!.signal!
        // fetch는 신호가 끊기면 응답 대기 또는 본문 읽기를 AbortError로 끝낸다.
        const pending = new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
        if (stage === '응답') return await pending
        readJson.mockImplementationOnce(async () => await pending)
        return response
      })
      const request = approveVersion(versionId, approvalCheck.serverTime)
      const failure = (async () => {
        try {
          await request
          return null
        } catch (error) {
          return error
        }
      })()
      const signal = vi.mocked(fetch).mock.calls[0][1]!.signal!

      await vi.advanceTimersByTimeAsync(29_999)

      expect(signal.aborted).toBe(false)
      expect(readJson).toHaveBeenCalledTimes(stage === '응답 본문' ? 1 : 0)

      await vi.advanceTimersByTimeAsync(1)

      expect(signal.aborted).toBe(true)
      const error = await failure
      expect(error).toMatchObject({ name: 'AbortError' })
      expect(error).not.toBeInstanceOf(ApiError)
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it('30초 전에 본문까지 읽으면 타이머를 지우고 나중에도 signal이 끊기지 않는다', async () => {
    const response = Response.json(approved)
    let finishBody!: (body: VersionDetail) => void
    vi.spyOn(response, 'json').mockImplementationOnce(
      async () =>
        await new Promise<VersionDetail>((resolve) => {
          finishBody = resolve
        }),
    )
    vi.mocked(fetch).mockResolvedValueOnce(response)
    const request = approveVersion(versionId, approvalCheck.serverTime)
    const signal = vi.mocked(fetch).mock.calls[0][1]!.signal!

    await vi.advanceTimersByTimeAsync(29_999)
    expect(signal.aborted).toBe(false)
    finishBody(approved)
    await expect(request).resolves.toEqual(approved)

    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(signal.aborted).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each([
    { status: 403, code: undefined },
    { status: 409, code: 'NEW_COMMENTS' },
    { status: 422, code: undefined },
    { status: 502, code: undefined },
  ])('$status 실패 응답 뒤에도 타이머를 지우고 signal을 끊지 않는다', async ({ status, code }) => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ code }, { status }))
    const request = approveVersion(versionId, approvalCheck.serverTime)
    const signal = vi.mocked(fetch).mock.calls[0][1]!.signal!

    await expect(request).rejects.toBeInstanceOf(ApiError)
    await expect(request).rejects.toMatchObject({ status, code })

    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(signal.aborted).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each(['네트워크', '본문 읽기'] as const)('%s 오류도 그대로 전달하고 타이머를 지운다', async (stage) => {
    const error = new TypeError('응답을 읽지 못했어요')
    const response = Response.json(approved)
    vi.spyOn(response, 'json').mockRejectedValueOnce(error)
    vi.mocked(fetch).mockImplementationOnce(async () => {
      if (stage === '네트워크') throw error
      return response
    })
    const request = approveVersion(versionId, approvalCheck.serverTime)
    const signal = vi.mocked(fetch).mock.calls[0][1]!.signal!

    await expect(request).rejects.toBe(error)

    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(signal.aborted).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('listActivity 승인 사건', () => {
  it.each([0, 2])('%i차의 VERSION_APPROVED 사건과 승인자 이름을 그대로 돌려준다', async (number) => {
    const event: ActivityItem = {
      id: 'approval-event',
      mailFailedTo: [],
      type: 'VERSION_APPROVED',
      actorName: '김승인',
      createdAt: approved.approval!.approvedAt,
      version: { id: versionId, number },
      memberName: null,
      issue: null,
    }
    vi.mocked(fetch).mockResolvedValueOnce(Response.json([event]))

    await expect(listActivity(projectId)).resolves.toEqual([event])

    expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/projects/${projectId}/activity`)
  })
})
