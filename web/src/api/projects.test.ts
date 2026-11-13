import { ApiError } from './client.ts'
import {
  archiveProject,
  unarchiveProject,
  deleteProject,
  restoreProject,
  createProject,
  daysUntilPurge,
  purgeText,
  statusNotice,
  projectStatusError,
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
  status: 'ACTIVE',
  purgeAfter: null,
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

describe('projectStatusError', () => {
  it.each([
    ['PROJECT_ARCHIVED', '보관한 프로젝트예요. 보관을 풀어야 바꿀 수 있어요'],
    ['PROJECT_DELETE_PENDING', '삭제 대기 중인 프로젝트예요. 되살려야 바꿀 수 있어요'],
  ])('%s를 상태에 맞는 안내 문구로 바꾼다', (code, message) => {
    expect(projectStatusError(code)).toBe(message)
  })

  it.each([undefined, '', 'SCREEN_EXISTS', 'PROJECT_NAME_MISMATCH', 'UNKNOWN_CODE'])(
    '상태 오류가 아닌 %s는 각 화면의 기존 오류 처리에 맡긴다',
    (code) => {
      expect(projectStatusError(code)).toBeUndefined()
    },
  )
})

describe('daysUntilPurge', () => {
  const now = Date.parse('2026-11-14T12:00:00.000Z')

  it.each([
    { label: '정확히 7일 남으면', purgeAfter: '2026-11-21T12:00:00.000Z', expected: 7 },
    { label: '1일보다 1밀리초 더 남으면', purgeAfter: '2026-11-15T12:00:00.001Z', expected: 2 },
    { label: '정확히 1일 남으면', purgeAfter: '2026-11-15T12:00:00.000Z', expected: 1 },
    { label: '1밀리초 남으면', purgeAfter: '2026-11-14T12:00:00.001Z', expected: 1 },
    { label: '남은 시간이 정확히 0이면', purgeAfter: '2026-11-14T12:00:00.000Z', expected: 0 },
    { label: '정확히 1일 지났으면', purgeAfter: '2026-11-13T12:00:00.000Z', expected: -1 },
  ])('$label 올림한 $expected일을 돌려준다', ({ purgeAfter, expected }) => {
    expect(daysUntilPurge(purgeAfter, now)).toBe(expected)
  })

  it('1밀리초만 지났어도 남은 날은 0 이하다', () => {
    expect(daysUntilPurge('2026-11-14T11:59:59.999Z', now)).toBeLessThanOrEqual(0)
  })
})

describe('purgeText', () => {
  it.each([1, 2, 7])('%i일 남으면 남은 날을 알려 준다', (daysLeft) => {
    expect(purgeText(daysLeft)).toBe(`${daysLeft}일 뒤 완전히 지워져요`)
  })

  it.each([0, -1, -7])('남은 날이 %i이면 곧 완전히 지워진다고 알려 준다', (daysLeft) => {
    expect(purgeText(daysLeft)).toBe('곧 완전히 지워져요')
  })
})

describe('statusNotice', () => {
  const now = Date.parse('2026-11-14T12:00:00.000Z')

  it('진행 중인 프로젝트에는 띠가 없다', () => {
    expect(statusNotice({ status: 'ACTIVE', purgeAfter: null }, now)).toBeNull()
  })

  it('보관한 프로젝트에는 읽기만 할 수 있다는 띠를 보여 준다', () => {
    expect(statusNotice({ status: 'ARCHIVED', purgeAfter: null }, now)).toBe('보관한 프로젝트예요. 읽기만 할 수 있어요')
  })

  it.each([
    { label: '1일보다 1밀리초 더 남으면', purgeAfter: '2026-11-15T12:00:00.001Z', text: '2일 뒤 완전히 지워져요' },
    { label: '1밀리초 남으면', purgeAfter: '2026-11-14T12:00:00.001Z', text: '1일 뒤 완전히 지워져요' },
    { label: '남은 시간이 정확히 0이면', purgeAfter: '2026-11-14T12:00:00.000Z', text: '곧 완전히 지워져요' },
    { label: '1밀리초 지났으면', purgeAfter: '2026-11-14T11:59:59.999Z', text: '곧 완전히 지워져요' },
    { label: '1일 지났으면', purgeAfter: '2026-11-13T12:00:00.000Z', text: '곧 완전히 지워져요' },
  ])('삭제 대기에서 $label 알맞은 띠를 보여 준다', ({ purgeAfter, text }) => {
    expect(statusNotice({ status: 'DELETE_PENDING', purgeAfter }, now)).toBe(`삭제 대기 중인 프로젝트예요. ${text}`)
  })
})

describe('listProjects', () => {
  it('옵션 없이 GET을 한 번 요청하고 역할과 서버의 목록 순서를 그대로 돌려준다', async () => {
    const projects = [
      project,
      {
        id: 'another-project',
        name: '이전 프로젝트',
        myRole: 'CLIENT',
        createdAt: '2026-11-03T09:00:00.000Z',
        status: 'ACTIVE',
        purgeAfter: null,
      },
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
  it.each([true, false])('서버가 준 isApprover=%s를 그대로 돌려준다', async (isApprover) => {
    const detail = {
      ...project,
      myRole: 'CLIENT',
      currentVersion: { id: 'current-version', number: 2 },
      approver: { memberId: 'approver-member', name: '김승인' },
      isApprover,
    }
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(detail))

    await expect(getProject(projectId)).resolves.toEqual(detail)

    expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/projects/${projectId}`)
  })

  it.each(['DEVELOPER', 'CLIENT'])('옵션 없이 GET을 한 번 요청하고 %s 역할의 프로젝트를 돌려준다', async (myRole) => {
    const detail = {
      id: projectId,
      name: project.name,
      status: 'ACTIVE',
      purgeAfter: null,
      myRole,
      currentVersion: null,
      isApprover: false,
      approver: null,
    }
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(detail), { status: 200 }))

    await expect(getProject(projectId)).resolves.toEqual(detail)

    expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/projects/${projectId}`)
  })

  it('게시된 현재 버전의 id와 번호를 그대로 돌려준다', async () => {
    const detail = {
      id: projectId,
      name: project.name,
      status: 'ACTIVE',
      purgeAfter: null,
      myRole: 'DEVELOPER',
      currentVersion: { id: 'published-version', number: 2 },
      isApprover: false,
      approver: null,
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
  {
    name: 'getProject',
    call: getProject,
    suffix: '',
    responseBody: { ...project, currentVersion: null, isApprover: false, approver: null },
  },
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
  { name: 'archiveProject', call: () => archiveProject(projectId), statuses: [401, 403, 404, 409] },
  { name: 'unarchiveProject', call: () => unarchiveProject(projectId), statuses: [401, 403, 404, 409] },
  { name: 'deleteProject', call: () => deleteProject(projectId, project.name), statuses: [401, 403, 404, 409, 422] },
  { name: 'restoreProject', call: () => restoreProject(projectId), statuses: [401, 403, 404, 409] },
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

describe('listProjects의 보관과 삭제 상태', () => {
  it('진행·보관·삭제 대기의 상태와 purgeAfter를 서버 순서와 값 그대로 돌려준다', async () => {
    const projects = [
      { ...project, id: 'deleted', status: 'DELETE_PENDING', purgeAfter: '2026-11-21T00:00:00.000Z' },
      { ...project, id: 'archived', status: 'ARCHIVED', myRole: 'CLIENT' },
      project,
    ]
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(projects))

    await expect(listProjects()).resolves.toEqual(projects)

    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/projects')
  })
})

describe.each([
  { name: 'archiveProject', call: archiveProject, action: 'archive', body: {} },
  { name: 'unarchiveProject', call: unarchiveProject, action: 'unarchive', body: {} },
  {
    name: 'deleteProject',
    call: (id: string) => deleteProject(id, '  외주 "리뉴얼" \\ 시안\n두 번째 줄  '),
    action: 'delete',
    body: { name: '  외주 "리뉴얼" \\ 시안\n두 번째 줄  ' },
  },
  { name: 'restoreProject', call: restoreProject, action: 'restore', body: {} },
])('$name 상태 변경 요청', ({ call, action, body }) => {
  it('정해진 주소에 JSON POST를 한 번 보내고 본문 없는 204를 처리한다', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 204 }))

    await expect(call(projectId)).resolves.toBeUndefined()

    expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/projects/${projectId}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  })

  it.each(encodedIds)('$id를 $encoded 한 덩어리로 보내고 본문을 유지한다', async ({ id, encoded }) => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 204 }))

    await expect(call(id)).resolves.toBeUndefined()

    expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/projects/${encoded}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  })
})

describe('프로젝트 상태 변경 오류 코드', () => {
  it.each([
    { name: 'archiveProject', call: () => archiveProject(projectId), status: 409, code: 'PROJECT_ARCHIVED' },
    { name: 'unarchiveProject', call: () => unarchiveProject(projectId), status: 409, code: 'PROJECT_NOT_ARCHIVED' },
    {
      name: 'deleteProject',
      call: () => deleteProject(projectId, '다른 이름'),
      status: 422,
      code: 'PROJECT_NAME_MISMATCH',
    },
    {
      name: 'deleteProject',
      call: () => deleteProject(projectId, project.name),
      status: 409,
      code: 'PROJECT_DELETE_PENDING',
    },
    { name: 'restoreProject', call: () => restoreProject(projectId), status: 409, code: 'PROJECT_NOT_DELETED' },
    { name: 'restoreProject', call: () => restoreProject(projectId), status: 409, code: 'RESTORE_PERIOD_OVER' },
  ])('$name의 $code를 ApiError에 담아 전달한다', async ({ call, status, code }) => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ code }, { status }))

    const result = call()

    await expect(result).rejects.toBeInstanceOf(ApiError)
    await expect(result).rejects.toMatchObject({ status, code })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
