import { ApiError } from './client.ts'
import { acceptInvitation, createInvitation, getInvitation, isInviteToken } from './invitations.ts'

const projectId = '43a30b6d-1b77-46ba-8743-061b463c1d37'
const token = 'Ab0_-'.repeat(8) + 'xyz'
const email = 'client+review@example.com'
const createdInvitation = {
  email,
  expiresAt: '2026-11-16T09:00:00.000Z',
  link: `https://example.com/app/invite/${token}`,
}
const preview = { projectName: '새 프로젝트', inviterName: '김개발', email, status: 'PENDING' }
const encodedValues = [
  { value: '../auth/me', encoded: '..%2Fauth%2Fme' },
  { value: 'a/b', encoded: 'a%2Fb' },
  { value: 'a?b', encoded: 'a%3Fb' },
  { value: 'a#b', encoded: 'a%23b' },
  { value: 'a%2Fb', encoded: 'a%252Fb' },
  { value: 'a+b= c', encoded: 'a%2Bb%3D%20c' },
]

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('isInviteToken', () => {
  it.each([token, 'A'.repeat(43), 'z'.repeat(43), '9'.repeat(43), '_'.repeat(43), '-'.repeat(43)])(
    '43자 base64url 문자열 %s는 참이다',
    (value) => {
      expect(isInviteToken(value)).toBe(true)
    },
  )

  it.each([
    { label: '빈 값', value: '' },
    { label: '42자', value: 'a'.repeat(42) },
    { label: '44자', value: 'a'.repeat(44) },
    { label: '현재 경로', value: '.' },
    { label: '상위 경로', value: '..' },
    { label: '슬래시', value: '/' },
    { label: '더하기', value: '+' },
    { label: '패딩', value: '=' },
    { label: '43자 안의 점', value: 'a'.repeat(42) + '.' },
    { label: '43자 안의 슬래시', value: 'a'.repeat(42) + '/' },
    { label: '43자 안의 더하기', value: 'a'.repeat(42) + '+' },
    { label: '43자 안의 패딩', value: 'a'.repeat(42) + '=' },
    { label: '43자 안의 공백', value: 'a'.repeat(21) + ' ' + 'a'.repeat(21) },
    { label: '43자 안의 한글', value: 'a'.repeat(42) + '가' },
    { label: '앞 공백', value: ' ' + token },
    { label: '뒤 공백', value: token + ' ' },
    { label: '앞 줄바꿈', value: '\n' + token },
    { label: '뒤 줄바꿈', value: token + '\n' },
    { label: '뒤 캐리지 리턴', value: token + '\r' },
  ])('$label은 거짓이다', ({ value }) => {
    expect(isInviteToken(value)).toBe(false)
  })
})

describe('createInvitation', () => {
  it('이메일만 JSON POST로 보내고 201의 이메일, 만료일, 링크를 그대로 돌려준다', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(createdInvitation), { status: 201 }))

    await expect(createInvitation(projectId, email)).resolves.toEqual(createdInvitation)

    expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/projects/${projectId}/invitations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    })
  })

  it.each(encodedValues)('프로젝트 ID $value를 $encoded 한 덩어리로 보낸다', async ({ value, encoded }) => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(createdInvitation), { status: 201 }))

    await expect(createInvitation(value, email)).resolves.toEqual(createdInvitation)

    expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/projects/${encoded}/invitations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    })
  })
})

describe('getInvitation', () => {
  it.each(['PENDING', 'ACCEPTED'])('GET으로 받은 %s 초대의 네 칸을 그대로 돌려준다', async (status) => {
    const invitation = { ...preview, status }
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(invitation), { status: 200 }))

    await expect(getInvitation(token)).resolves.toEqual(invitation)

    expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/invitations/${token}`)
  })

  it.each(encodedValues)('토큰 $value를 $encoded 한 덩어리로 보낸다', async ({ value, encoded }) => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(preview), { status: 200 }))

    await expect(getInvitation(value)).resolves.toEqual(preview)

    expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/invitations/${encoded}`)
  })
})

describe('acceptInvitation', () => {
  it.each([token, 'a/b?c#d%2F+="\\\n'])('토큰 %s를 인코딩하지 않고 JSON 본문에 담아 POST한다', async (value) => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ projectId }), { status: 200 }))

    await expect(acceptInvitation(value)).resolves.toEqual({ projectId })

    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/invitations/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: value }),
    })
  })
})

describe.each([
  { name: 'createInvitation', call: () => createInvitation(projectId, email) },
  { name: 'acceptInvitation', call: () => acceptInvitation(token) },
])('$name 충돌 처리', ({ call }) => {
  it.each(['PROJECT_FULL', 'ALREADY_MEMBER'])('409의 %s 코드를 ApiError로 전달한다', async (code) => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ statusCode: 409, message: '초대를 처리할 수 없어요', code }), { status: 409 }),
    )

    const result = call()

    await expect(result).rejects.toBeInstanceOf(ApiError)
    await expect(result).rejects.toMatchObject({ status: 409, code })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

it('다른 이메일로 수락하면 403 EMAIL_MISMATCH를 ApiError로 전달한다', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(
    new Response(JSON.stringify({ statusCode: 403, code: 'EMAIL_MISMATCH' }), { status: 403 }),
  )

  const result = acceptInvitation(token)

  await expect(result).rejects.toBeInstanceOf(ApiError)
  await expect(result).rejects.toMatchObject({ status: 403, code: 'EMAIL_MISMATCH' })
  expect(fetch).toHaveBeenCalledTimes(1)
})

describe.each([
  { name: 'createInvitation', call: () => createInvitation(projectId, email), statuses: [401, 403, 404, 422, 500] },
  { name: 'getInvitation', call: () => getInvitation(token), statuses: [404, 410] },
  { name: 'acceptInvitation', call: () => acceptInvitation(token), statuses: [401, 403, 404, 410, 422] },
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
