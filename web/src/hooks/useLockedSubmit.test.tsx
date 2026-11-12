import { act, renderHook } from '@testing-library/react'
import { ApiError } from '../api/client.ts'
import { useLockedSubmit } from './useLockedSubmit.ts'

const request = {
  projectId: 'project-1',
  requestId: 'request-1',
  versionId: 'version-1',
  screenId: 'screen-1',
  xRatio: 0,
  yRatio: 1,
  title: '버튼 위치 수정',
  body: '사진에 표시한 자리로 옮겨 주세요.',
}
const nextRequest = {
  projectId: 'project-2',
  requestId: 'request-2',
  versionId: 'version-2',
  screenId: 'screen-2',
  xRatio: 0.25,
  yRatio: 0.75,
  title: '새 제목',
  body: '새 내용',
}
const saved = { id: 'issue-1', title: request.title, body: request.body }

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('useLockedSubmit', () => {
  it('처음에는 보내는 중이 아니고 잠금·오류가 없으며 retry는 아무것도 보내지 않는다', async () => {
    const send = vi.fn<(value: typeof request) => Promise<typeof saved>>()
    const onDone = vi.fn()
    const { result } = renderHook(() => useLockedSubmit(send, onDone))

    expect(result.current.sending).toBe(false)
    expect(result.current.locked).toBeUndefined()
    expect(result.current.error).toBeUndefined()

    await act(async () => {
      await result.current.retry()
    })

    expect(send).not.toHaveBeenCalled()
    expect(onDone).not.toHaveBeenCalled()
    expect(result.current.sending).toBe(false)
    expect(result.current.locked).toBeUndefined()
    expect(result.current.error).toBeUndefined()
  })

  it('성공하면 onDone에 응답을 그대로 한 번 전달하고 잠금·오류 없이 다음 요청을 받는다', async () => {
    const send = vi.fn<(value: typeof request) => Promise<typeof saved>>().mockResolvedValue(saved)
    const onDone = vi.fn()
    const { result } = renderHook(() => useLockedSubmit(send, onDone))

    await act(async () => {
      await result.current.submit(request)
    })

    expect(send).toHaveBeenCalledExactlyOnceWith(request)
    expect(onDone).toHaveBeenCalledExactlyOnceWith(saved)
    expect(onDone.mock.calls[0][0]).toBe(saved)
    expect(result.current.sending).toBe(false)
    expect(result.current.locked).toBeUndefined()
    expect(result.current.error).toBeUndefined()

    await act(async () => {
      await result.current.retry()
    })
    expect(send).toHaveBeenCalledTimes(1)

    await act(async () => {
      await result.current.submit(nextRequest)
    })
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1][0]).toBe(nextRequest)
    expect(onDone).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['연결 끊김', new TypeError('Failed to fetch')],
    ['일반 오류', new Error('응답을 받지 못함')],
    ['500', new ApiError(500)],
    ['503', new ApiError(503)],
  ])('%s로 저장 여부를 모르면 처음 요청 객체 그대로 잠기고 unknown 오류를 돌려준다', async (_, failure) => {
    const send = vi.fn<(value: typeof request) => Promise<typeof saved>>().mockRejectedValue(failure)
    const onDone = vi.fn()
    const { result, rerender } = renderHook(() => useLockedSubmit(send, onDone))

    await act(async () => {
      await result.current.submit(request)
    })
    rerender()

    expect(send).toHaveBeenCalledExactlyOnceWith(request)
    expect(result.current.locked).toBe(request)
    expect(result.current.error).toEqual({ kind: 'unknown' })
    expect(result.current.sending).toBe(false)
    expect(onDone).not.toHaveBeenCalled()

    await act(async () => {
      await result.current.submit(nextRequest)
    })

    expect(send).toHaveBeenCalledTimes(1)
    expect(result.current.locked).toBe(request)
    expect(result.current.error).toEqual({ kind: 'unknown' })
  })

  it.each([
    [401, undefined, { kind: 'session' }],
    [403, undefined, { kind: 'rejected', status: 403 }],
    [404, undefined, { kind: 'rejected', status: 404 }],
    [409, 'VERSION_CHANGED', { kind: 'conflict', code: 'VERSION_CHANGED' }],
    [409, 'VERSION_NOT_IN_REVIEW', { kind: 'conflict', code: 'VERSION_NOT_IN_REVIEW' }],
    [409, 'REQUEST_ID_REUSED', { kind: 'conflict', code: 'REQUEST_ID_REUSED' }],
    [422, undefined, { kind: 'rejected', status: 422 }],
  ] as const)(
    '처음 요청의 %i %s는 잠그지 않고 오류만 남기며 새 요청을 허용한다',
    async (status, code, expectedError) => {
      const send = vi
        .fn<(value: typeof request) => Promise<typeof saved>>()
        .mockRejectedValueOnce(new ApiError(status, code))
        .mockResolvedValueOnce(saved)
      const onDone = vi.fn()
      const { result } = renderHook(() => useLockedSubmit(send, onDone))

      await act(async () => {
        await result.current.submit(request)
      })

      expect(result.current.locked).toBeUndefined()
      expect(result.current.error).toEqual(expectedError)
      expect(result.current.sending).toBe(false)
      expect(onDone).not.toHaveBeenCalled()

      await act(async () => {
        await result.current.retry()
      })
      expect(send).toHaveBeenCalledTimes(1)
      expect(result.current.error).toEqual(expectedError)

      await act(async () => {
        await result.current.submit(nextRequest)
      })

      expect(send).toHaveBeenCalledTimes(2)
      expect(send.mock.calls[1][0]).toBe(nextRequest)
      expect(result.current.error).toBeUndefined()
      expect(result.current.locked).toBeUndefined()
      expect(onDone).toHaveBeenCalledExactlyOnceWith(saved)
    },
  )

  it('화면이 다시 그려져도 retry는 처음 요청 객체를 보내고 성공하면 잠금과 오류를 푼다', async () => {
    const send = vi
      .fn<(value: typeof request) => Promise<typeof saved>>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(saved)
    const onDone = vi.fn()
    const { result, rerender } = renderHook(() => useLockedSubmit(send, onDone))

    await act(async () => {
      await result.current.submit(request)
    })
    rerender()
    await act(async () => {
      await result.current.submit(nextRequest)
    })
    await act(async () => {
      await result.current.retry()
    })

    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[0][0]).toBe(request)
    expect(send.mock.calls[1][0]).toBe(request)
    expect(onDone).toHaveBeenCalledExactlyOnceWith(saved)
    expect(result.current.locked).toBeUndefined()
    expect(result.current.error).toBeUndefined()
    expect(result.current.sending).toBe(false)

    await act(async () => {
      await result.current.retry()
    })
    expect(send).toHaveBeenCalledTimes(2)

    await act(async () => {
      await result.current.submit(nextRequest)
    })
    expect(send.mock.calls[2][0]).toBe(nextRequest)
  })

  it.each(['VERSION_CHANGED', 'VERSION_NOT_IN_REVIEW', 'REQUEST_ID_REUSED', undefined])(
    'retry가 409 %s를 받으면 잠금을 풀고 conflict와 code를 남기며 새 요청을 허용한다',
    async (code) => {
      const send = vi
        .fn<(value: typeof request) => Promise<typeof saved>>()
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockRejectedValueOnce(new ApiError(409, code))
        .mockResolvedValueOnce(saved)
      const onDone = vi.fn()
      const { result } = renderHook(() => useLockedSubmit(send, onDone))

      await act(async () => {
        await result.current.submit(request)
      })
      await act(async () => {
        await result.current.retry()
      })

      expect(send.mock.calls[1][0]).toBe(request)
      expect(result.current.locked).toBeUndefined()
      expect(result.current.error).toEqual({ kind: 'conflict', code })
      expect(result.current.sending).toBe(false)
      expect(onDone).not.toHaveBeenCalled()

      await act(async () => {
        await result.current.retry()
      })
      expect(send).toHaveBeenCalledTimes(2)
      expect(result.current.error).toEqual({ kind: 'conflict', code })

      await act(async () => {
        await result.current.submit(nextRequest)
      })
      expect(send).toHaveBeenCalledTimes(3)
      expect(send.mock.calls[2][0]).toBe(nextRequest)
      expect(onDone).toHaveBeenCalledExactlyOnceWith(saved)
      expect(result.current.error).toBeUndefined()
    },
  )

  it.each([
    ['401', new ApiError(401), { kind: 'session' }],
    ['403', new ApiError(403), { kind: 'rejected', status: 403 }],
    ['404', new ApiError(404), { kind: 'rejected', status: 404 }],
    ['422', new ApiError(422), { kind: 'rejected', status: 422 }],
    ['연결 끊김', new TypeError('Failed to fetch'), { kind: 'unknown' }],
    ['500', new ApiError(500), { kind: 'unknown' }],
    ['503', new ApiError(503), { kind: 'unknown' }],
  ])(
    'retry가 %s로 실패해도 처음 요청의 잠금을 유지하고 다음 retry도 같은 객체를 보낸다',
    async (_, failure, expectedError) => {
      const send = vi
        .fn<(value: typeof request) => Promise<typeof saved>>()
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockRejectedValueOnce(failure)
        .mockResolvedValueOnce(saved)
      const onDone = vi.fn()
      const { result, rerender } = renderHook(() => useLockedSubmit(send, onDone))

      await act(async () => {
        await result.current.submit(request)
      })
      await act(async () => {
        await result.current.retry()
      })
      rerender()

      expect(result.current.locked).toBe(request)
      expect(result.current.error).toEqual(expectedError)
      expect(result.current.sending).toBe(false)
      expect(send).toHaveBeenCalledTimes(2)
      expect(send.mock.calls[1][0]).toBe(request)
      expect(onDone).not.toHaveBeenCalled()

      await act(async () => {
        await result.current.submit(nextRequest)
      })
      expect(send).toHaveBeenCalledTimes(2)
      expect(result.current.error).toEqual(expectedError)

      await act(async () => {
        await result.current.retry()
      })

      expect(send).toHaveBeenCalledTimes(3)
      expect(send.mock.calls[2][0]).toBe(request)
      expect(onDone).toHaveBeenCalledExactlyOnceWith(saved)
      expect(result.current.locked).toBeUndefined()
      expect(result.current.error).toBeUndefined()
      expect(result.current.sending).toBe(false)
    },
  )

  it.each(['성공', '연결 실패'] as const)(
    'submit 응답 전 같은 순간과 다시 그린 뒤 중복 호출을 막고 %s 뒤 sending을 끈다',
    async (outcome) => {
      const response = deferred<typeof saved>()
      const send = vi.fn<(value: typeof request) => Promise<typeof saved>>().mockReturnValue(response.promise)
      const onDone = vi.fn()
      const { result } = renderHook(() => useLockedSubmit(send, onDone))
      let submission!: Promise<void>

      act(() => {
        submission = result.current.submit(request)
        void result.current.submit(nextRequest)
        void result.current.retry()
      })
      expect(result.current.sending).toBe(true)
      expect(send).toHaveBeenCalledExactlyOnceWith(request)

      await act(async () => {
        await result.current.submit(nextRequest)
        await result.current.retry()
      })
      expect(send).toHaveBeenCalledTimes(1)
      expect(onDone).not.toHaveBeenCalled()

      await act(async () => {
        if (outcome === '성공') response.resolve(saved)
        if (outcome === '연결 실패') response.reject(new TypeError('Failed to fetch'))
        await submission
      })

      expect(result.current.sending).toBe(false)
      expect(send).toHaveBeenCalledTimes(1)
      expect(onDone).toHaveBeenCalledTimes(outcome === '성공' ? 1 : 0)
    },
  )

  it('retry 응답 전에는 잠금을 유지하고 오류를 지우며 같은 순간과 다시 그린 뒤 중복 호출을 막는다', async () => {
    const response = deferred<typeof saved>()
    const send = vi
      .fn<(value: typeof request) => Promise<typeof saved>>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockReturnValueOnce(response.promise)
    const onDone = vi.fn()
    const { result } = renderHook(() => useLockedSubmit(send, onDone))

    await act(async () => {
      await result.current.submit(request)
    })
    let retry!: Promise<void>
    act(() => {
      retry = result.current.retry()
      void result.current.retry()
      void result.current.submit(nextRequest)
    })

    expect(result.current.sending).toBe(true)
    expect(result.current.locked).toBe(request)
    expect(result.current.error).toBeUndefined()
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1][0]).toBe(request)

    await act(async () => {
      await result.current.retry()
      await result.current.submit(nextRequest)
    })
    expect(send).toHaveBeenCalledTimes(2)
    expect(onDone).not.toHaveBeenCalled()

    await act(async () => {
      response.resolve(saved)
      await retry
    })

    expect(result.current.sending).toBe(false)
    expect(result.current.locked).toBeUndefined()
    expect(result.current.error).toBeUndefined()
    expect(onDone).toHaveBeenCalledExactlyOnceWith(saved)
  })

  it('다시 submit하면 응답을 기다리는 동안에도 이전 오류가 지워진다', async () => {
    const response = deferred<typeof saved>()
    const send = vi
      .fn<(value: typeof request) => Promise<typeof saved>>()
      .mockRejectedValueOnce(new ApiError(422))
      .mockReturnValueOnce(response.promise)
    const onDone = vi.fn()
    const { result } = renderHook(() => useLockedSubmit(send, onDone))

    await act(async () => {
      await result.current.submit(request)
    })
    expect(result.current.error).toEqual({ kind: 'rejected', status: 422 })

    let submission!: Promise<void>
    act(() => {
      submission = result.current.submit(nextRequest)
    })

    expect(result.current.sending).toBe(true)
    expect(result.current.error).toBeUndefined()
    expect(result.current.locked).toBeUndefined()

    await act(async () => {
      response.resolve(saved)
      await submission
    })
    expect(result.current.sending).toBe(false)
    expect(result.current.error).toBeUndefined()
  })

  it.each([
    ['잠긴 요청', new TypeError('Failed to fetch')],
    ['잠기지 않은 오류', new ApiError(422)],
  ])('cancel은 %s의 잠금·오류를 지우고 이전 요청의 retry를 막으며 새 요청을 받는다', async (_, failure) => {
    const send = vi
      .fn<(value: typeof request) => Promise<typeof saved>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(saved)
    const onDone = vi.fn()
    const { result } = renderHook(() => useLockedSubmit(send, onDone))

    await act(async () => {
      await result.current.submit(request)
    })
    expect(result.current.error).toBeDefined()

    act(() => {
      result.current.cancel()
    })

    expect(result.current.locked).toBeUndefined()
    expect(result.current.error).toBeUndefined()
    expect(result.current.sending).toBe(false)
    expect(onDone).not.toHaveBeenCalled()

    await act(async () => {
      await result.current.retry()
    })
    expect(send).toHaveBeenCalledTimes(1)

    await act(async () => {
      await result.current.submit(nextRequest)
    })
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1][0]).toBe(nextRequest)
    expect(onDone).toHaveBeenCalledExactlyOnceWith(saved)
  })
})
