import { ApiError, apiDelete, apiGet, apiPatch, apiPost, apiPostForm, apiPutForm, toApiError } from './client.ts'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ApiError', () => {
  it('Error를 상속하고 상태와 코드를 보관하며 메시지에 상태를 넣는다', () => {
    const error = new ApiError(409, 'SCREEN_EXISTS')

    expect(error).toBeInstanceOf(Error)
    expect(error.status).toBe(409)
    expect(error.code).toBe('SCREEN_EXISTS')
    expect(error.message).toContain('409')
  })

  it('코드를 생략하면 상태만 보관한다', () => {
    const error = new ApiError(503)

    expect(error).toBeInstanceOf(Error)
    expect(error.status).toBe(503)
    expect(error.code).toBeUndefined()
    expect(error.message).toContain('503')
  })
})

describe('toApiError', () => {
  it('오류를 던지지 않고 응답 상태와 본문 코드를 담은 ApiError를 돌려준다', async () => {
    const response = new Response(JSON.stringify({ statusCode: 400, code: 'SCREEN_EXISTS' }), { status: 409 })

    const error = await toApiError(response)

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 409, code: 'SCREEN_EXISTS' })
    expect(error.message).toContain('409')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('JSON null 응답도 code 없는 ApiError로 돌려준다', async () => {
    const response = new Response('null', { status: 502 })

    const error = await toApiError(response)

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 502, code: undefined })
  })
})

describe('apiGet', () => {
  it('경로 앞에 /api를 붙이고 옵션 없이 한 번 요청한다', async () => {
    const response = new Response('[]', { status: 200 })
    vi.mocked(fetch).mockResolvedValueOnce(response)

    await expect(apiGet('/projects')).resolves.toBe(response)

    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/projects')
  })
})

describe('apiPost', () => {
  it('세 번째 인자의 signal을 그대로 fetch에 넘긴다', async () => {
    const controller = new AbortController()
    const body = { seenAt: '2026-11-13T06:10:22.123456Z' }
    const response = Response.json({ status: 'APPROVED' })
    vi.mocked(fetch).mockResolvedValueOnce(response)

    await expect(apiPost('/versions/version-id/approve', body, controller.signal)).resolves.toBe(response)

    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/versions/version-id/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    expect(vi.mocked(fetch).mock.calls[0][1]?.signal).toBe(controller.signal)
  })

  it('경로 앞에 /api를 붙이고 전달받은 본문을 JSON POST로 한 번 보낸다', async () => {
    const body = { name: '메인 "화면"', viewport: 'PC' }
    const response = new Response(JSON.stringify({ id: 'screen-id', ...body }), { status: 201 })
    vi.mocked(fetch).mockResolvedValueOnce(response)

    await expect(apiPost('/projects/project-id/screens', body)).resolves.toBe(response)

    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/projects/project-id/screens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  })

  it('본문을 생략하면 빈 객체를 JSON으로 보낸다', async () => {
    const response = new Response(null, { status: 204 })
    vi.mocked(fetch).mockResolvedValueOnce(response)

    await expect(apiPost('/screens/screen-id/hide')).resolves.toBe(response)

    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/screens/screen-id/hide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
  })

  it('본문이 명시적으로 undefined여도 빈 객체를 JSON으로 보낸다', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 204 }))

    await apiPost('/screens/screen-id/show', undefined)

    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/screens/screen-id/show', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
  })
})

describe.each([
  { name: 'apiGet', call: () => apiGet('/projects') },
  { name: 'apiPost', call: () => apiPost('/projects', { name: '새 프로젝트' }) },
])('$name 응답 처리', ({ call }) => {
  it.each([200, 201, 299])('%i 응답은 본문을 읽지 않고 같은 Response를 돌려준다', async (status) => {
    const body = 'JSON이 아닌 본문도 호출한 쪽에서 읽는다'
    const response = new Response(body, { status })
    const readJson = vi.spyOn(response, 'json')
    vi.mocked(fetch).mockResolvedValueOnce(response)

    await expect(call()).resolves.toBe(response)

    expect(readJson).not.toHaveBeenCalled()
    expect(response.bodyUsed).toBe(false)
    await expect(response.text()).resolves.toBe(body)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('본문 없는 204 응답도 읽지 않고 같은 Response를 돌려준다', async () => {
    const response = new Response(null, { status: 204 })
    const readJson = vi.spyOn(response, 'json')
    vi.mocked(fetch).mockResolvedValueOnce(response)

    await expect(call()).resolves.toBe(response)

    expect(readJson).not.toHaveBeenCalled()
    expect(response.bodyUsed).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('409 응답의 SCREEN_EXISTS 코드를 ApiError로 전달한다', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ statusCode: 409, message: '이미 있는 화면이에요', code: 'SCREEN_EXISTS' }), {
        status: 409,
      }),
    )

    const result = call()

    await expect(result).rejects.toBeInstanceOf(ApiError)
    await expect(result).rejects.toMatchObject({ status: 409, code: 'SCREEN_EXISTS' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each([
    { status: 401, body: JSON.stringify({ statusCode: 401, message: 'Unauthorized' }) },
    { status: 403, body: JSON.stringify({ statusCode: 403, message: 'Forbidden' }) },
    { status: 404, body: JSON.stringify({ statusCode: 404, message: 'Not Found' }) },
    { status: 422, body: JSON.stringify({ statusCode: 422, message: ['입력 값을 확인해 주세요'] }) },
    { status: 500, body: JSON.stringify({ statusCode: 400, message: '서버 오류' }) },
    { status: 502, body: '<html>Bad Gateway</html>' },
    { status: 503, body: '' },
    { status: 503, body: null },
    { status: 502, body: 'null' },
  ])('$status 응답의 본문이 $body이면 code 없이 응답 상태를 전달한다', async ({ status, body }) => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(body, { status }))

    const result = call()

    await expect(result).rejects.toBeInstanceOf(ApiError)
    await expect(result).rejects.toBeInstanceOf(Error)
    await expect(result).rejects.toMatchObject({
      status,
      code: undefined,
      message: expect.stringContaining(String(status)),
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('네트워크 오류는 ApiError로 바꾸지 않고 원래 오류 그대로 전달한다', async () => {
    const networkError = new TypeError('Failed to fetch')
    vi.mocked(fetch).mockRejectedValueOnce(networkError)

    const result = call()

    await expect(result).rejects.toBe(networkError)
    await expect(result).rejects.not.toBeInstanceOf(ApiError)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('apiPatch', () => {
  it('경로 앞에 /api를 붙이고 전달받은 본문을 JSON PATCH로 한 번 보낸다', async () => {
    const body = { summary: '메인 "화면" 수정\n다음 줄', testUrl: 'https://example.com/review' }
    const response = new Response(JSON.stringify({ id: 'version-id', ...body }), { status: 200 })
    vi.mocked(fetch).mockResolvedValueOnce(response)

    await expect(apiPatch('/versions/version-id', body)).resolves.toBe(response)

    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/versions/version-id', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  })

  it.each([{ summary: '' }, { testUrl: '' }, {}])(
    '빈 값과 생략한 칸을 바꾸지 않고 JSON으로 보낸다: %j',
    async (body) => {
      vi.mocked(fetch).mockResolvedValueOnce(new Response('{}', { status: 200 }))

      await apiPatch('/versions/version-id', body)

      expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/versions/version-id', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    },
  )
})

describe('apiPutForm', () => {
  it('경로 앞에 /api를 붙이고 같은 FormData를 Content-Type 지정 없이 PUT으로 한 번 보낸다', async () => {
    const form = new FormData()
    const file = new File(['photo bytes'], '메인 화면.png', { type: 'image/png' })
    form.append('file', file)
    const response = new Response(JSON.stringify({ id: 'version-id' }), { status: 200 })
    vi.mocked(fetch).mockResolvedValueOnce(response)

    await expect(apiPutForm('/versions/version-id/screens/screen-id/asset', form)).resolves.toBe(response)

    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      '/api/versions/version-id/screens/screen-id/asset',
      expect.objectContaining({ method: 'PUT' }),
    )
    const options = vi.mocked(fetch).mock.calls[0][1]
    expect(options?.body).toBe(form)
    expect(new Headers(options?.headers).has('Content-Type')).toBe(false)
    expect(form.getAll('file')).toEqual([file])
  })
})

describe('apiPostForm', () => {
  it('경로 앞에 /api를 붙이고 같은 FormData를 Content-Type 지정 없이 POST로 한 번 보낸다', async () => {
    const form = new FormData()
    const file = new File(['photo bytes'], '참고 사진.png', { type: 'image/png' })
    form.append('file', file)
    const response = Response.json({ id: 'issue-id' }, { status: 201 })
    vi.mocked(fetch).mockResolvedValueOnce(response)

    await expect(apiPostForm('/issues/issue-id/attachments', form)).resolves.toBe(response)

    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      '/api/issues/issue-id/attachments',
      expect.objectContaining({ method: 'POST' }),
    )
    const options = vi.mocked(fetch).mock.calls[0][1]
    expect(options?.body).toBe(form)
    expect(new Headers(options?.headers).has('Content-Type')).toBe(false)
    expect(form.getAll('file')).toEqual([file])
  })
})

describe('apiDelete', () => {
  it('경로 앞에 /api를 붙이고 본문 없이 DELETE로 한 번 요청한다', async () => {
    const response = new Response(JSON.stringify({ id: 'version-id', screens: [] }), { status: 200 })
    vi.mocked(fetch).mockResolvedValueOnce(response)

    await expect(apiDelete('/versions/version-id/screens/screen-id')).resolves.toBe(response)

    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      '/api/versions/version-id/screens/screen-id',
      expect.objectContaining({ method: 'DELETE' }),
    )
    expect(vi.mocked(fetch).mock.calls[0][1]?.body).toBeUndefined()
  })
})

describe.each([
  { name: 'apiPatch', call: () => apiPatch('/versions/version-id', { summary: '수정한 화면' }) },
  { name: 'apiPutForm', call: () => apiPutForm('/versions/version-id/screens/screen-id/asset', new FormData()) },
  { name: 'apiPostForm', call: () => apiPostForm('/issues/issue-id/attachments', new FormData()) },
  { name: 'apiDelete', call: () => apiDelete('/versions/version-id/screens/screen-id') },
])('$name 응답 처리', ({ call }) => {
  it.each([200, 201, 299])('%i 응답은 본문을 읽지 않고 같은 Response를 돌려준다', async (status) => {
    const body = '호출한 쪽에서 읽을 응답 본문'
    const response = new Response(body, { status })
    vi.mocked(fetch).mockResolvedValueOnce(response)

    await expect(call()).resolves.toBe(response)

    expect(response.bodyUsed).toBe(false)
    await expect(response.text()).resolves.toBe(body)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('본문 없는 204 응답도 같은 Response를 돌려준다', async () => {
    const response = new Response(null, { status: 204 })
    vi.mocked(fetch).mockResolvedValueOnce(response)

    await expect(call()).resolves.toBe(response)

    expect(response.bodyUsed).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each(['VERSION_NOT_DRAFT', 'SCREEN_HIDDEN', 'TOO_MANY_SCREENS'])(
    '409 응답의 %s 코드를 ApiError로 전달한다',
    async (code) => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ statusCode: 409, message: '요청을 처리할 수 없어요', code }), { status: 409 }),
      )

      const result = call()

      await expect(result).rejects.toBeInstanceOf(ApiError)
      await expect(result).rejects.toMatchObject({ status: 409, code })
      expect(fetch).toHaveBeenCalledTimes(1)
    },
  )

  it('nginx의 413 HTML 응답도 code 없는 ApiError로 전달한다', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('<html><body><h1>413 Request Entity Too Large</h1><hr>nginx</body></html>', {
        status: 413,
        headers: { 'Content-Type': 'text/html' },
      }),
    )

    const result = call()

    await expect(result).rejects.toBeInstanceOf(ApiError)
    await expect(result).rejects.toMatchObject({ status: 413, code: undefined })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each([
    { status: 401, body: JSON.stringify({ statusCode: 401, message: 'Unauthorized' }) },
    { status: 403, body: JSON.stringify({ statusCode: 403, message: 'Forbidden' }) },
    { status: 404, body: JSON.stringify({ statusCode: 404, message: 'Not Found' }) },
    { status: 413, body: JSON.stringify({ statusCode: 413, message: 'Payload Too Large' }) },
    { status: 415, body: JSON.stringify({ statusCode: 415, message: 'Unsupported Media Type' }) },
    { status: 422, body: JSON.stringify({ statusCode: 422, message: ['입력 값을 확인해 주세요'] }) },
    { status: 500, body: JSON.stringify({ statusCode: 400, message: '서버 오류' }) },
    { status: 503, body: null },
    { status: 502, body: 'null' },
  ])('$status 응답의 본문이 $body이면 code 없이 응답 상태를 전달한다', async ({ status, body }) => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(body, { status }))

    const result = call()

    await expect(result).rejects.toBeInstanceOf(ApiError)
    await expect(result).rejects.toMatchObject({ status, code: undefined })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('네트워크 오류는 ApiError로 바꾸지 않고 원래 오류 그대로 전달한다', async () => {
    const networkError = new TypeError('Failed to fetch')
    vi.mocked(fetch).mockRejectedValueOnce(networkError)

    await expect(call()).rejects.toBe(networkError)

    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
