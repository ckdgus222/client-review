import { renderHook, waitFor } from '@testing-library/react'
import { useMe } from './useMe.ts'

const user = { id: '5b3a934d-ef8e-4ce8-b26a-a9d1cdd4983f', email: 'reader@example.com', name: '김수정' }

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('useMe', () => {
  it('응답 전에는 확인 중이고 200이면 사용자를 돌려주며 다시 렌더링해도 한 번만 요청한다', async () => {
    let resolveResponse!: (value: Response) => void
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveResponse = resolve
        }),
    )
    const { result, rerender } = renderHook(() => useMe())

    expect(result.current.user).toBeUndefined()
    expect(result.current.error).toBeUndefined()
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/auth/me')

    rerender()

    expect(result.current.user).toBeUndefined()
    expect(result.current.error).toBeUndefined()
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/auth/me')

    resolveResponse(new Response(JSON.stringify(user), { status: 200 }))

    await waitFor(() => expect(result.current.user).toEqual(user))
    expect(result.current.error).toBeUndefined()

    rerender()

    expect(result.current.user).toEqual(user)
    expect(result.current.error).toBeUndefined()
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/auth/me')
  })

  it.each([JSON.stringify({ statusCode: 401, message: 'Unauthorized' }), null, '<html>Unauthorized</html>'])(
    '401이면 본문 %j와 관계없이 오류 없이 로그인 안 함 상태가 된다',
    async (body) => {
      vi.mocked(fetch).mockResolvedValueOnce(new Response(body, { status: 401 }))
      const { result, rerender } = renderHook(() => useMe())

      expect(result.current.user).toBeUndefined()
      expect(result.current.error).toBeUndefined()

      await waitFor(() => expect(result.current.user).toBeNull())
      expect(result.current.error).toBeUndefined()

      rerender()

      expect(result.current.user).toBeNull()
      expect(result.current.error).toBeUndefined()
      expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/auth/me')
    },
  )

  it('네트워크 오류면 오류 문구를 돌려주고 로그인 안 함 상태로 바꾸지 않는다', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const { result, rerender } = renderHook(() => useMe())

    expect(result.current.user).toBeUndefined()
    expect(result.current.error).toBeUndefined()

    await waitFor(() => expect(result.current.error).toBe('불러오지 못했어요. 잠시 뒤 새로고침해 주세요'))
    expect(result.current.user).toBeUndefined()

    rerender()

    expect(result.current.error).toBe('불러오지 못했어요. 잠시 뒤 새로고침해 주세요')
    expect(result.current.user).toBeUndefined()
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/auth/me')
  })

  it.each([
    JSON.stringify({ statusCode: 500, message: 'Internal Server Error' }),
    '<html>Internal Server Error</html>',
  ])('500이면 본문 %j와 관계없이 오류 문구를 돌려주고 로그인 안 함 상태로 바꾸지 않는다', async (body) => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(body, { status: 500 }))
    const { result, rerender } = renderHook(() => useMe())

    expect(result.current.user).toBeUndefined()
    expect(result.current.error).toBeUndefined()

    await waitFor(() => expect(result.current.error).toBe('불러오지 못했어요. 잠시 뒤 새로고침해 주세요'))
    expect(result.current.user).toBeUndefined()

    rerender()

    expect(result.current.error).toBe('불러오지 못했어요. 잠시 뒤 새로고침해 주세요')
    expect(result.current.user).toBeUndefined()
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/auth/me')
  })

  it('화면을 닫고 새로 열면 이전 사용자 대신 확인 중 상태에서 시작하고 세션을 다시 확인한다', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify(user), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
    const firstScreen = renderHook(() => useMe())

    await waitFor(() => expect(firstScreen.result.current.user).toEqual(user))
    firstScreen.unmount()

    const nextScreen = renderHook(() => useMe())

    expect(nextScreen.result.current.user).toBeUndefined()
    expect(nextScreen.result.current.error).toBeUndefined()

    await waitFor(() => expect(nextScreen.result.current.user).toBeNull())
    expect(nextScreen.result.current.error).toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch).toHaveBeenNthCalledWith(1, '/api/auth/me')
    expect(fetch).toHaveBeenNthCalledWith(2, '/api/auth/me')
  })
})
