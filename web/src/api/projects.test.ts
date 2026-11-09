import { ApiError } from './client.ts'
import {
  createProject,
  createScreen,
  getProject,
  hideScreen,
  listProjects,
  listScreens,
  showScreen,
  screenLabel,
  VIEWPORT_LABELS,
} from './projects.ts'

const projectId = '43a30b6d-1b77-46ba-8743-061b463c1d37'
const screenId = '250a258d-7af0-41b0-8eb8-5cbfa80105ce'
const project = {
  id: projectId,
  name: '새 프로젝트',
  myRole: 'DEVELOPER',
  createdAt: '2026-11-04T09:00:00.000Z',
}
const screen = { id: screenId, name: '메인', viewport: 'PC', hiddenAt: null }
const hiddenScreen = { ...screen, hiddenAt: '2026-11-04T10:00:00.000Z' }
const encodedIds = [
  { id: '../auth/me', encoded: '..%2Fauth%2Fme' },
  { id: 'a/b', encoded: 'a%2Fb' },
  { id: 'a?b', encoded: 'a%3Fb' },
  { id: 'a#b', encoded: 'a%23b' },
]

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('listProjects', () => {
  it('옵션 없이 GET을 한 번 요청하고 역할과 서버의 목록 순서를 그대로 돌려준다', async () => {
    const projects = [
      project,
      { id: 'another-project', name: '이전 프로젝트', myRole: 'CLIENT', createdAt: '2026-11-03T09:00:00.000Z' },
    ]
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(projects), { status: 200 }))

    await expect(listProjects()).resolves.toEqual(projects)

    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/projects')
  })

  it('프로젝트가 없으면 빈 배열을 돌려준다', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('[]', { status: 200 }))

    await expect(listProjects()).resolves.toEqual([])

    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/projects')
  })
})

describe('createProject', () => {
  it('이름을 JSON POST로 한 번 보내고 201의 프로젝트를 돌려준다', async () => {
    const name = '외주 "리뉴얼" \\ 시안\n두 번째 줄'
    const createdProject = { ...project, name }
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(createdProject), { status: 201 }))

    await expect(createProject(name)).resolves.toEqual(createdProject)

    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
  })
})

describe('getProject', () => {
  it.each(['DEVELOPER', 'CLIENT'])('옵션 없이 GET을 한 번 요청하고 %s 역할의 프로젝트를 돌려준다', async (myRole) => {
    const detail = { id: projectId, name: project.name, myRole, currentVersion: null }
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(detail), { status: 200 }))

    await expect(getProject(projectId)).resolves.toEqual(detail)

    expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/projects/${projectId}`)
  })

  it('게시된 현재 버전의 id와 번호를 그대로 돌려준다', async () => {
    const detail = {
      id: projectId,
      name: project.name,
      myRole: 'DEVELOPER',
      currentVersion: { id: 'published-version', number: 2 },
    }
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(detail), { status: 200 }))

    await expect(getProject(projectId)).resolves.toEqual(detail)

    expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/projects/${projectId}`)
  })
})

describe('listScreens', () => {
  it('옵션 없이 GET을 한 번 요청하고 숨긴 화면과 서버의 목록 순서를 그대로 돌려준다', async () => {
    const screens = [hiddenScreen, { ...screen, id: 'mobile-screen', viewport: 'MOBILE' }]
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(screens), { status: 200 }))

    await expect(listScreens(projectId)).resolves.toEqual(screens)

    expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/projects/${projectId}/screens`)
  })

  it('화면이 없으면 빈 배열을 돌려준다', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('[]', { status: 200 }))

    await expect(listScreens(projectId)).resolves.toEqual([])

    expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/projects/${projectId}/screens`)
  })
})

describe('createScreen', () => {
  it.each(['PC', 'MOBILE'] as const)(
    '이름과 %s 기기를 JSON POST로 한 번 보내고 201의 화면을 돌려준다',
    async (viewport) => {
      const name = '메인 "화면" \\ 시안\n두 번째 줄'
      const createdScreen = { ...screen, name, viewport }
      vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(createdScreen), { status: 201 }))

      await expect(createScreen(projectId, name, viewport)).resolves.toEqual(createdScreen)

      expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/projects/${projectId}/screens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, viewport }),
      })
    },
  )

  it('409의 SCREEN_EXISTS 코드를 ApiError에 담아 전달한다', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ statusCode: 409, message: '이미 있는 화면이에요', code: 'SCREEN_EXISTS' }), {
        status: 409,
      }),
    )

    const result = createScreen(projectId, screen.name, 'PC')

    await expect(result).rejects.toBeInstanceOf(ApiError)
    await expect(result).rejects.toMatchObject({ status: 409, code: 'SCREEN_EXISTS' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe.each([
  { name: 'hideScreen', call: hideScreen, action: 'hide', responseScreen: hiddenScreen },
  { name: 'showScreen', call: showScreen, action: 'show', responseScreen: screen },
])('$name', ({ call, action, responseScreen }) => {
  it('빈 객체를 JSON POST로 한 번 보내고 서버가 준 화면 상태를 돌려준다', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(responseScreen), { status: 200 }))

    await expect(call(screenId)).resolves.toEqual(responseScreen)

    expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/screens/${screenId}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
  })

  it('같은 요청을 다시 보내도 서버가 준 hiddenAt을 그대로 돌려준다', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify(responseScreen), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(responseScreen), { status: 200 }))

    await expect(call(screenId)).resolves.toEqual(responseScreen)
    await expect(call(screenId)).resolves.toEqual(responseScreen)

    const expectedRequest = [
      `/api/screens/${screenId}/${action}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    ]
    expect(vi.mocked(fetch).mock.calls).toEqual([expectedRequest, expectedRequest])
  })
})

describe.each([
  { name: 'getProject', call: getProject, suffix: '', responseBody: { ...project, currentVersion: null } },
  { name: 'listScreens', call: listScreens, suffix: '/screens', responseBody: [screen] },
])('$name의 프로젝트 ID 인코딩', ({ call, suffix, responseBody }) => {
  it.each(encodedIds)('$id를 $encoded 한 덩어리로 보내고 GET 옵션을 추가하지 않는다', async ({ id, encoded }) => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(responseBody), { status: 200 }))

    await expect(call(id)).resolves.toEqual(responseBody)

    expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/projects/${encoded}${suffix}`)
  })
})

describe.each([
  {
    name: 'createScreen',
    call: (id: string) => createScreen(id, '메인', 'MOBILE'),
    prefix: '/api/projects/',
    suffix: '/screens',
    body: '{"name":"메인","viewport":"MOBILE"}',
  },
  { name: 'hideScreen', call: hideScreen, prefix: '/api/screens/', suffix: '/hide', body: '{}' },
  { name: 'showScreen', call: showScreen, prefix: '/api/screens/', suffix: '/show', body: '{}' },
])('$name의 ID 인코딩', ({ call, prefix, suffix, body }) => {
  it.each(encodedIds)('$id를 $encoded 한 덩어리로 보내고 POST 옵션을 유지한다', async ({ id, encoded }) => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(screen), { status: 200 }))

    await expect(call(id)).resolves.toEqual(screen)

    expect(fetch).toHaveBeenCalledExactlyOnceWith(`${prefix}${encoded}${suffix}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
  })
})

describe.each([
  { name: 'listProjects', call: listProjects, statuses: [401] },
  { name: 'createProject', call: () => createProject(project.name), statuses: [401, 403, 422] },
  { name: 'getProject', call: () => getProject(projectId), statuses: [401, 404] },
  { name: 'listScreens', call: () => listScreens(projectId), statuses: [401, 404] },
  { name: 'createScreen', call: () => createScreen(projectId, screen.name, 'PC'), statuses: [401, 403, 404, 422] },
  { name: 'hideScreen', call: () => hideScreen(screenId), statuses: [401, 403, 404] },
  { name: 'showScreen', call: () => showScreen(screenId), statuses: [401, 403, 404] },
])('$name 실패 처리', ({ call, statuses }) => {
  it.each(statuses)('%i 응답은 code 없는 ApiError로 전달한다', async (status) => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ statusCode: status, message: '요청을 처리할 수 없어요' }), { status }),
    )

    const result = call()

    await expect(result).rejects.toBeInstanceOf(ApiError)
    await expect(result).rejects.toMatchObject({ status, code: undefined })
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

describe('화면 이름표', () => {
  it('기기 이름을 PC와 모바일로 표시한다', () => {
    expect(VIEWPORT_LABELS).toEqual({ PC: 'PC', MOBILE: '모바일' })
  })

  it.each([
    { name: '메인', viewport: 'PC' as const, label: '메인 · PC' },
    { name: '메인', viewport: 'MOBILE' as const, label: '메인 · 모바일' },
    { name: '상품 상세', viewport: 'PC' as const, label: '상품 상세 · PC' },
  ])('$label 이름표를 만든다', ({ name, viewport, label }) => {
    expect(screenLabel({ name, viewport })).toBe(label)
  })
})
