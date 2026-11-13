import { renderHook } from '@testing-library/react'
import { useDraftReport } from './useDraftReport.ts'

describe('useDraftReport', () => {
  it.each([false, true])('처음 받은 초안 상태 %s를 알리고 바뀐 상태를 알린다', (hasDraft) => {
    const onDraftChange = vi.fn()
    const { rerender } = renderHook(({ value }) => useDraftReport(value, onDraftChange), {
      initialProps: { value: hasDraft },
    })
    expect(onDraftChange).toHaveBeenLastCalledWith(hasDraft)

    rerender({ value: !hasDraft })
    expect(onDraftChange).toHaveBeenLastCalledWith(!hasDraft)
  })

  it('사라질 때 초안이 없다고 알린다', () => {
    const onDraftChange = vi.fn()
    const { unmount } = renderHook(() => useDraftReport(true, onDraftChange))
    expect(onDraftChange).toHaveBeenLastCalledWith(true)
    unmount()
    expect(onDraftChange).toHaveBeenLastCalledWith(false)
  })

  it('알릴 곳이 바뀌면 이전 곳은 비우고 새 곳에 현재 상태를 알린다', () => {
    const previous = vi.fn()
    const next = vi.fn()
    const { rerender } = renderHook(({ report }) => useDraftReport(true, report), {
      initialProps: { report: previous },
    })
    rerender({ report: next })
    expect(previous).toHaveBeenLastCalledWith(false)
    expect(next).toHaveBeenLastCalledWith(true)
  })

  it('알릴 곳이 없어도 상태 변경과 사라지기가 오류 없이 끝난다', () => {
    const { rerender, unmount } = renderHook(({ value }) => useDraftReport(value), {
      initialProps: { value: false },
    })
    expect(() => rerender({ value: true })).not.toThrow()
    expect(() => unmount()).not.toThrow()
  })
})
