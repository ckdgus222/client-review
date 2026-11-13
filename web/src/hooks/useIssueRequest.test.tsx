import { act, renderHook } from '@testing-library/react'
import { ApiError } from '../api/client.ts'
import type { IssueDetail } from '../api/issues.ts'
import { useIssueRequest } from './useIssueRequest.ts'
import type { SubmitError } from './useLockedSubmit.ts'

const saved: IssueDetail = {
  currentVersion: { id: 'version-1', status: 'IN_REVIEW' },
  id: 'issue-1',
  projectId: 'project-1',
  number: 1,
  title: '버튼 수정',
  body: '버튼을 옮겨 주세요',
  status: 'READY_FOR_REVIEW',
  category: 'BUG',
  scope: 'IN_SCOPE',
  dueDate: null,
  authorName: '클라이언트',
  createdAt: '2026-11-10T01:00:00.000Z',
  commentCount: 0,
  originVersion: { id: 'version-1', number: 1 },
  origin: null,
  isMine: false,
  canReview: false,
  attachments: [],
  comments: [],
  attempts: [],
}

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('useIssueRequest', () => {
  it('처음에는 보내는 중이 아니고 실패 안내도 없다', () => {
    const onChanged = vi.fn()
    const onRefresh = vi.fn()
    const { result } = renderHook(() => useIssueRequest({ fetchCount: 0, onChanged, onRefresh }))

    expect(result.current.sending).toBe(false)
    expect(result.current.error).toBeUndefined()
    expect(result.current.unconfirmed).toBe(false)
    expect(result.current.stale).toBe(false)
    expect(onChanged).not.toHaveBeenCalled()
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('응답을 기다리는 동안 sending이고 성공하면 응답을 한 번 전달하고 true를 돌려준다', async () => {
    const pending = deferred<IssueDetail>()
    const request = vi.fn(() => pending.promise)
    const onChanged = vi.fn()
    const onRefresh = vi.fn()
    const { result } = renderHook(() => useIssueRequest({ fetchCount: 0, onChanged, onRefresh }))
    let completion!: Promise<boolean>

    act(() => {
      completion = result.current.send(request)
    })
    expect(request).toHaveBeenCalledExactlyOnceWith()
    expect(result.current.sending).toBe(true)
    expect(onChanged).not.toHaveBeenCalled()

    await act(async () => {
      pending.resolve(saved)
      expect(await completion).toBe(true)
    })

    expect(result.current.sending).toBe(false)
    expect(result.current.error).toBeUndefined()
    expect(result.current.unconfirmed).toBe(false)
    expect(result.current.stale).toBe(false)
    expect(onChanged).toHaveBeenCalledExactlyOnceWith(saved)
    expect(onChanged.mock.calls[0][0]).toBe(saved)
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it.each([
    ['연결 실패', new TypeError('Failed to fetch'), undefined, true, false, 1],
    ['일반 오류', new Error('응답 없음'), undefined, true, false, 1],
    ['500', new ApiError(500), undefined, true, false, 1],
    ['503', new ApiError(503), undefined, true, false, 1],
    ['409 ISSUE_STATE_CHANGED', new ApiError(409, 'ISSUE_STATE_CHANGED'), undefined, false, true, 1],
    ['409 ATTEMPT_CHANGED', new ApiError(409, 'ATTEMPT_CHANGED'), undefined, false, true, 1],
    [
      '409 VERSION_CHANGED',
      new ApiError(409, 'VERSION_CHANGED'),
      { kind: 'conflict', code: 'VERSION_CHANGED' },
      false,
      false,
      1,
    ],
    [
      '409 VERSION_NOT_IN_REVIEW',
      new ApiError(409, 'VERSION_NOT_IN_REVIEW'),
      { kind: 'conflict', code: 'VERSION_NOT_IN_REVIEW' },
      false,
      false,
      1,
    ],
    ['코드 없는 409', new ApiError(409), { kind: 'conflict', code: undefined }, false, false, 1],
    ['401', new ApiError(401), { kind: 'session' }, false, false, 0],
    ['403', new ApiError(403), { kind: 'rejected', status: 403 }, false, false, 1],
    ['404', new ApiError(404), { kind: 'rejected', status: 404 }, false, false, 1],
    ['422', new ApiError(422), { kind: 'rejected', status: 422 }, false, false, 0],
    [
      '409가 아닌 상태 변경 코드',
      new ApiError(422, 'ISSUE_STATE_CHANGED'),
      { kind: 'rejected', status: 422 },
      false,
      false,
      0,
    ],
  ] satisfies [string, Error, SubmitError | undefined, boolean, boolean, number][])(
    '%s는 해당 안내만 남기고 false를 돌려주며 필요한 경우에만 새로 불러온다',
    async (_, failure, error, unconfirmed, stale, refreshCount) => {
      const pending = deferred<IssueDetail>()
      const request = vi.fn(() => pending.promise)
      const onChanged = vi.fn()
      const onRefresh = vi.fn()
      const { result } = renderHook(() => useIssueRequest({ fetchCount: 0, onChanged, onRefresh }))
      let completion!: Promise<boolean>

      act(() => {
        completion = result.current.send(request)
      })
      expect(result.current.sending).toBe(true)
      expect(onRefresh).not.toHaveBeenCalled()

      await act(async () => {
        pending.reject(failure)
        expect(await completion).toBe(false)
      })

      expect(request).toHaveBeenCalledExactlyOnceWith()
      expect(result.current.sending).toBe(false)
      expect(result.current.error).toEqual(error)
      expect(result.current.unconfirmed).toBe(unconfirmed)
      expect(result.current.stale).toBe(stale)
      expect(onRefresh).toHaveBeenCalledTimes(refreshCount)
      expect(onChanged).not.toHaveBeenCalled()
    },
  )

  it.each([
    ['저장 여부 안내', new TypeError('Failed to fetch'), 'unconfirmed'],
    ['상태 변경 안내', new ApiError(409, 'ATTEMPT_CHANGED'), 'stale'],
    ['입력 오류', new ApiError(422), 'error'],
    ['새 버전 안내', new ApiError(409, 'VERSION_CHANGED'), 'error'],
  ] as const)('%s 뒤 다시 보내면 응답이 오기 전에 지난 안내를 모두 지운다', async (_, failure, field) => {
    const onChanged = vi.fn()
    const onRefresh = vi.fn()
    const { result } = renderHook(() => useIssueRequest({ fetchCount: 0, onChanged, onRefresh }))
    await act(async () => {
      expect(
        await result.current.send(async () => {
          throw failure
        }),
      ).toBe(false)
    })
    expect(result.current[field]).toBeTruthy()
    const previousRefreshCount = onRefresh.mock.calls.length
    const pending = deferred<IssueDetail>()
    let completion!: Promise<boolean>

    act(() => {
      completion = result.current.send(() => pending.promise)
    })

    expect(result.current.sending).toBe(true)
    expect(result.current.error).toBeUndefined()
    expect(result.current.unconfirmed).toBe(false)
    expect(result.current.stale).toBe(false)
    expect(onChanged).not.toHaveBeenCalled()
    expect(onRefresh).toHaveBeenCalledTimes(previousRefreshCount)

    await act(async () => {
      pending.resolve(saved)
      expect(await completion).toBe(true)
    })
    expect(result.current.sending).toBe(false)
    expect(result.current.error).toBeUndefined()
    expect(result.current.unconfirmed).toBe(false)
    expect(result.current.stale).toBe(false)
    expect(onChanged).toHaveBeenCalledExactlyOnceWith(saved)
  })

  it('fetchCount가 같으면 저장 여부 안내가 남고 증가하면 사라지며 다음 실패는 다시 알린다', async () => {
    const onChanged = vi.fn()
    const onRefresh = vi.fn()
    const { result, rerender } = renderHook(({ fetchCount }) => useIssueRequest({ fetchCount, onChanged, onRefresh }), {
      initialProps: { fetchCount: 4 },
    })
    const request = vi.fn<() => Promise<IssueDetail>>().mockRejectedValue(new ApiError(503))

    await act(async () => {
      await result.current.send(request)
    })
    expect(result.current.unconfirmed).toBe(true)
    rerender({ fetchCount: 4 })
    expect(result.current.unconfirmed).toBe(true)
    rerender({ fetchCount: 5 })
    expect(result.current.unconfirmed).toBe(false)
    expect(result.current.error).toBeUndefined()
    expect(result.current.stale).toBe(false)
    expect(onRefresh).toHaveBeenCalledTimes(1)

    await act(async () => {
      await result.current.send(request)
    })
    rerender({ fetchCount: 5 })
    expect(result.current.unconfirmed).toBe(true)
    rerender({ fetchCount: 7 })
    expect(result.current.unconfirmed).toBe(false)
    expect(onRefresh).toHaveBeenCalledTimes(2)
    expect(onChanged).not.toHaveBeenCalled()
  })

  it.each(['조회 먼저', '실패 먼저'] as const)(
    '%s 처리하고 같은 화면 갱신에 묶이면 저장 여부 안내는 다음 조회가 성공할 때까지 남는다',
    async (order) => {
      const pending = deferred<IssueDetail>()
      const onChanged = vi.fn()
      const onRefresh = vi.fn()
      const { result, rerender } = renderHook(
        ({ fetchCount }) => useIssueRequest({ fetchCount, onChanged, onRefresh }),
        { initialProps: { fetchCount: 4 } },
      )
      let completion!: Promise<boolean>
      act(() => {
        completion = result.current.send(() => pending.promise)
      })

      // act를 나누지 않아 조회 횟수와 실패가 한 번에 화면에 반영되게 한다.
      await act(async () => {
        if (order === '조회 먼저') rerender({ fetchCount: 5 })
        pending.reject(new TypeError('Failed to fetch'))
        expect(await completion).toBe(false)
        if (order === '실패 먼저') rerender({ fetchCount: 5 })
      })

      expect(result.current.unconfirmed).toBe(true)
      expect(result.current.sending).toBe(false)
      expect(onRefresh).toHaveBeenCalledExactlyOnceWith()
      expect(onChanged).not.toHaveBeenCalled()

      // 뒤따른 조회가 실패하면 받은 횟수는 늘지 않는다.
      rerender({ fetchCount: 5 })
      expect(result.current.unconfirmed).toBe(true)
      rerender({ fetchCount: 6 })
      expect(result.current.unconfirmed).toBe(false)
      expect(onRefresh).toHaveBeenCalledTimes(1)
    },
  )

  it.each([
    ['ISSUE_STATE_CHANGED', new ApiError(409, 'ISSUE_STATE_CHANGED'), undefined, true],
    ['ATTEMPT_CHANGED', new ApiError(409, 'ATTEMPT_CHANGED'), undefined, true],
    ['VERSION_CHANGED', new ApiError(409, 'VERSION_CHANGED'), { kind: 'conflict', code: 'VERSION_CHANGED' }, false],
    ['403', new ApiError(403), { kind: 'rejected', status: 403 }, false],
    ['404', new ApiError(404), { kind: 'rejected', status: 404 }, false],
    ['422', new ApiError(422), { kind: 'rejected', status: 422 }, false],
  ] satisfies [string, Error, SubmitError | undefined, boolean][])(
    'fetchCount가 올라도 %s 안내는 그대로 남는다',
    async (_, failure, error, stale) => {
      const onChanged = vi.fn()
      const onRefresh = vi.fn()
      const { result, rerender } = renderHook(
        ({ fetchCount }) => useIssueRequest({ fetchCount, onChanged, onRefresh }),
        { initialProps: { fetchCount: 0 } },
      )
      await act(async () => {
        await result.current.send(async () => {
          throw failure
        })
      })
      const previousRefreshCount = onRefresh.mock.calls.length

      rerender({ fetchCount: 1 })

      expect(result.current.error).toEqual(error)
      expect(result.current.stale).toBe(stale)
      expect(result.current.unconfirmed).toBe(false)
      expect(result.current.sending).toBe(false)
      expect(onRefresh).toHaveBeenCalledTimes(previousRefreshCount)
      expect(onChanged).not.toHaveBeenCalled()
    },
  )
})
