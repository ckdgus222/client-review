import { getMe, logout, requestCode, verifyCode } from './auth.ts'
import { ApiError } from './client.ts'

const email = 'reader@example.com'
const user = { id: '5b3a934d-ef8e-4ce8-b26a-a9d1cdd4983f', email, name: '김수정' }

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('requestCode', () => {
  it('이메일을 JSON POST로 보내고 204의 본문을 읽지 않고 undefined를 돌려준다', async () => {
    const response = new Response(null, { status: 204 })
    const readJson = vi.spyOn(response, 'json')
    vi.mocked(fetch).mockResolvedValueOnce(response)

    await expect(requestCode(email)).resolves.toBeUndefined()

    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/auth/email-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    })
    expect(readJson).not.toHaveBeenCalled()
    expect(response.bodyUsed).toBe(false)
  })

  it('재요청 제한 429는 code 없는 ApiError로 전달한다', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ statusCode: 429, message: 'Too Many Requests' }), { status: 429 }),
    )

    const result = requestCode(email)

    await expect(result).rejects.toBeInstanceOf(ApiError)
    await expect(result).rejects.toBeInstanceOf(Error)
    await expect(result).rejects.toMatchObject({ status: 429, code: undefined })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('verifyCode', () => {
  it.each(['000000', '012345', '999999'])('코드 %s와 이름을 JSON POST로 보내고 사용자를 돌려준다', async (code) => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(user), { status: 200 }))

    await expect(verifyCode(email, code, user.name)).resolves.toEqual(user)

    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/auth/verify-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code, name: user.name }),
    })
  })

  it('이름을 생략하면 JSON에 name 키를 넣지 않는다', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(user), { status: 200 }))

    await expect(verifyCode(email, '012345')).resolves.toEqual(user)

    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/auth/verify-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code: '012345' }),
    })
  })

  it('이름을 명시적으로 undefined로 보내도 JSON에 name 키를 넣지 않는다', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(user), { status: 200 }))

    await expect(verifyCode(email, '012345', undefined)).resolves.toEqual(user)

    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/auth/verify-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code: '012345' }),
    })
  })

  it.each(['CODE_WRONG', 'CODE_EXPIRED', 'NAME_REQUIRED'])('422의 %s 코드를 ApiError에 담는다', async (code) => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ statusCode: 422, message: '코드를 확인해 주세요', code }), { status: 422 }),
    )

    const result = verifyCode(email, '012345')

    await expect(result).rejects.toBeInstanceOf(ApiError)
    await expect(result).rejects.toBeInstanceOf(Error)
    await expect(result).rejects.toMatchObject({ status: 422, code })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('NAME_REQUIRED 뒤 같은 이메일과 코드에 이름을 추가해 다시 요청할 수 있다', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ statusCode: 422, message: '이름이 필요해요', code: 'NAME_REQUIRED' }), {
          status: 422,
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(user), { status: 200 }))

    await expect(verifyCode(email, '012345')).rejects.toMatchObject({ status: 422, code: 'NAME_REQUIRED' })
    await expect(verifyCode(email, '012345', user.name)).resolves.toEqual(user)

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch).toHaveBeenNthCalledWith(2, '/api/auth/verify-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code: '012345', name: user.name }),
    })
  })
})

describe('getMe', () => {
  it('메서드나 본문 없이 기본 GET으로 요청하고 200의 사용자를 돌려준다', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(user), { status: 200 }))

    await expect(getMe()).resolves.toEqual(user)

    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/auth/me')
  })

  it.each([JSON.stringify({ statusCode: 401, message: 'Unauthorized' }), null, '<html>Unauthorized</html>'])(
    '401이면 본문 %j를 해석하지 않고 null을 돌려준다',
    async (body) => {
      const response = new Response(body, { status: 401 })
      const readJson = vi.spyOn(response, 'json')
      vi.mocked(fetch).mockResolvedValueOnce(response)

      await expect(getMe()).resolves.toBeNull()

      expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/auth/me')
      expect(readJson).not.toHaveBeenCalled()
    },
  )

  it('오류 본문이 JSON null이어도 상태를 잃지 않고 code 없는 ApiError를 던진다', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('null', { status: 502, headers: { 'Content-Type': 'application/json' } }),
    )

    const result = getMe()

    await expect(result).rejects.toBeInstanceOf(ApiError)
    await expect(result).rejects.toMatchObject({ status: 502, code: undefined })
  })
})

describe('logout', () => {
  it('빈 객체를 JSON POST로 보내고 204의 본문을 읽지 않고 undefined를 돌려준다', async () => {
    const response = new Response(null, { status: 204 })
    const readJson = vi.spyOn(response, 'json')
    vi.mocked(fetch).mockResolvedValueOnce(response)

    await expect(logout()).resolves.toBeUndefined()

    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(readJson).not.toHaveBeenCalled()
    expect(response.bodyUsed).toBe(false)
  })
})

describe.each([
  { name: 'requestCode', call: () => requestCode(email) },
  { name: 'verifyCode', call: () => verifyCode(email, '012345') },
])('$name 입력 오류', ({ call }) => {
  it('code 없는 입력 검사 422를 ApiError로 전달한다', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({ statusCode: 422, message: ['입력 값을 확인해 주세요'], error: 'Unprocessable Entity' }),
        { status: 422 },
      ),
    )

    const result = call()

    await expect(result).rejects.toBeInstanceOf(ApiError)
    await expect(result).rejects.toBeInstanceOf(Error)
    await expect(result).rejects.toMatchObject({ status: 422, code: undefined })
  })
})

describe.each([
  { name: 'requestCode', call: () => requestCode(email) },
  { name: 'verifyCode', call: () => verifyCode(email, '012345') },
  { name: 'logout', call: () => logout() },
])('$name 인증 오류', ({ call }) => {
  it('POST의 401은 null 대신 ApiError를 던진다', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 401 }))

    const result = call()

    await expect(result).rejects.toBeInstanceOf(ApiError)
    await expect(result).rejects.toMatchObject({ status: 401, code: undefined })
  })
})

describe.each([
  { name: 'requestCode', call: () => requestCode(email) },
  { name: 'verifyCode', call: () => verifyCode(email, '012345') },
  { name: 'getMe', call: () => getMe() },
  { name: 'logout', call: () => logout() },
])('$name 공통 실패 처리', ({ call }) => {
  it.each([
    { status: 403, body: JSON.stringify({ statusCode: 403, message: 'Forbidden' }), contentType: 'application/json' },
    { status: 500, body: JSON.stringify({ statusCode: 400, message: '서버 오류' }), contentType: 'application/json' },
    { status: 502, body: '<html>Bad Gateway</html>', contentType: 'text/html' },
    { status: 503, body: null, contentType: 'application/json' },
  ])('$status 응답을 본문 형식과 관계없이 code 없는 ApiError로 전달한다', async ({ status, body, contentType }) => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(body, { status, headers: { 'Content-Type': contentType } }))

    const result = call()

    await expect(result).rejects.toBeInstanceOf(ApiError)
    await expect(result).rejects.toBeInstanceOf(Error)
    await expect(result).rejects.toMatchObject({ status, code: undefined })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('fetch 자체가 실패하면 원래 TypeError를 그대로 던진다', async () => {
    const networkError = new TypeError('Failed to fetch')
    vi.mocked(fetch).mockRejectedValueOnce(networkError)

    const result = call()

    await expect(result).rejects.toBe(networkError)
    await expect(result).rejects.not.toBeInstanceOf(ApiError)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
