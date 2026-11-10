import { ApiError } from './client.ts'
import {
  assetUrl,
  versionLabel,
  createDraft,
  getVersion,
  listActivity,
  listVersions,
  publishVersion,
  putScreenPhoto,
  removeDraftScreen,
  updateDraft,
  type ActivityItem,
  type DraftChanges,
  type VersionDetail,
  type VersionSummary,
} from './versions.ts'

const projectId = '43a30b6d-1b77-46ba-8743-061b463c1d37'
const versionId = 'd565474f-17a5-4a8e-9b61-bde406fefdf3'
const screenId = '250a258d-7af0-41b0-8eb8-5cbfa80105ce'
const photo = new File(['photo bytes'], '메인.png', { type: 'image/png' })
const draft: VersionDetail = {
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
const versions: VersionSummary[] = [
  { id: versionId, number: null, status: 'DRAFT', publishedAt: null },
  { id: 'second-version', number: 2, status: 'IN_REVIEW', publishedAt: '2026-11-08T09:00:00.000Z' },
  { id: 'first-version', number: 1, status: 'APPROVED', publishedAt: '2026-11-07T09:00:00.000Z' },
]
const activity: ActivityItem[] = [
  {
    id: 'new-event',
    type: 'VERSION_PUBLISHED',
    createdAt: '2026-11-08T09:00:00.000Z',
    actorName: '김개발',
    memberName: null,
    version: { id: versionId, number: 2 },
  },
  {
    id: 'old-event',
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

describe('getVersion', () => {
  it.each([draft, draftWithScreens, published])('$status 상세와 화면 구성을 그대로 돌려준다', async (detail) => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(detail), { status: 200 }))

    await expect(getVersion(versionId)).resolves.toEqual(detail)

    expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/versions/${versionId}`)
  })
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
