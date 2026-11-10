import { ApiError } from './client.ts'
import { listMembers, revokeMember, setApprover, type MemberList } from './members.ts'

const projectId = '43a30b6d-1b77-46ba-8743-061b463c1d37'
const memberId = '250a258d-7af0-41b0-8eb8-5cbfa80105ce'
const approver = { memberId, name: '김수정' }
const memberList: MemberList = {
  members: [
    {
      id: 'developer-member',
      name: '김개발',
      email: 'developer@example.com',
      role: 'DEVELOPER',
      lastSeenAt: '2026-11-09T09:00:00.000Z',
    },
    { id: memberId, name: approver.name, email: 'client@example.com', role: 'CLIENT', lastSeenAt: null },
    {
      id: 'second-client-member',
      name: '이수정',
      email: 'second-client@example.com',
      role: 'CLIENT',
      lastSeenAt: '2026-11-08T09:00:00.000Z',
    },
  ],
  invitations: [{ email: 'invited@example.com', expiresAt: '2026-11-16T09:00:00.000Z' }],
}
const encodedIds = [
  { id: '../auth/me', encoded: '..%2Fauth%2Fme' },
  { id: 'a/b', encoded: 'a%2Fb' },
  { id: 'a?b', encoded: 'a%3Fb' },
  { id: 'a#b', encoded: 'a%23b' },
  { id: 'a%2Fb', encoded: 'a%252Fb' },
  { id: 'a+b= c', encoded: 'a%2Bb%3D%20c' },
]

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('listMembers', () => {
  it('GET으로 받은 참여자 순서, 역할, 마지막 접속 시각과 초대 대기를 그대로 돌려준다', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(memberList))

    await expect(listMembers(projectId)).resolves.toEqual(memberList)

    expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/projects/${projectId}/members`)
  })

  it('클라이언트와 초대 대기가 없으면 개발자만 있는 목록과 빈 초대 배열을 돌려준다', async () => {
    const developerOnly: MemberList = { members: [memberList.members[0]], invitations: [] }
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(developerOnly))

    await expect(listMembers(projectId)).resolves.toEqual(developerOnly)

    expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/projects/${projectId}/members`)
  })

  it.each(encodedIds)('프로젝트 ID $id를 $encoded 한 덩어리로 GET한다', async ({ id, encoded }) => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(memberList))

    await expect(listMembers(id)).resolves.toEqual(memberList)

    expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/projects/${encoded}/members`)
  })
})

describe('revokeMember', () => {
  it('빈 객체를 JSON POST로 보내고 204의 JSON 본문을 읽지 않는다', async () => {
    const response = new Response(null, { status: 204 })
    const readJson = vi.spyOn(response, 'json')
    vi.mocked(fetch).mockResolvedValueOnce(response)

    await expect(revokeMember(memberId)).resolves.toBeUndefined()

    expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/members/${memberId}/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(readJson).not.toHaveBeenCalled()
  })

  it.each(encodedIds)('멤버 ID $id를 $encoded 한 덩어리로 POST한다', async ({ id, encoded }) => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 204 }))

    await expect(revokeMember(id)).resolves.toBeUndefined()

    expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/members/${encoded}/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
  })
})

describe('setApprover', () => {
  it.each([
    { label: '지정', selectedMemberId: memberId, savedApprover: approver },
    { label: '해제', selectedMemberId: null, savedApprover: null },
  ])(
    '승인자 $label 요청은 memberId를 POST하고 응답의 approver만 돌려준다',
    async ({ selectedMemberId, savedApprover }) => {
      vi.mocked(fetch).mockResolvedValueOnce(Response.json({ approver: savedApprover }))

      await expect(setApprover(projectId, selectedMemberId)).resolves.toEqual(savedApprover)

      expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/projects/${projectId}/approver`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberId: selectedMemberId }),
      })
    },
  )

  it.each(encodedIds)('프로젝트 ID $id를 $encoded 한 덩어리로 POST한다', async ({ id, encoded }) => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ approver }))

    await expect(setApprover(id, memberId)).resolves.toEqual(approver)

    expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/projects/${encoded}/approver`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId }),
    })
  })

  it('본문의 멤버 ID는 URL 인코딩하지 않고 JSON 문자열로 보낸다', async () => {
    const selectedMemberId = 'a/b?c#d%2F+="\\\n'
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ approver }))

    await expect(setApprover(projectId, selectedMemberId)).resolves.toEqual(approver)

    expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/projects/${projectId}/approver`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: selectedMemberId }),
    })
  })
})

describe.each([
  { name: 'listMembers', call: () => listMembers(projectId), statuses: [401, 403, 404] },
  { name: 'revokeMember', call: () => revokeMember(memberId), statuses: [401, 403, 404] },
  { name: 'setApprover', call: () => setApprover(projectId, memberId), statuses: [401, 403, 404, 422] },
  { name: 'setApprover 해제', call: () => setApprover(projectId, null), statuses: [401, 403, 404] },
])('$name 실패 처리', ({ call, statuses }) => {
  it.each(statuses)('%i 응답은 ApiError로 전달한다', async (status) => {
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({ statusCode: status, message: '요청을 처리할 수 없어요' }, { status }),
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
