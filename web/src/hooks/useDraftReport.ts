import { useLayoutEffect } from 'react'

// 입력 칸이 "아직 저장되지 않은 글이 있는가"를 위에 알린다. 칸이 사라지면(쪽지를 닫거나 다른 쪽지를 열면) 없다고 알린다.
// 알릴 곳이 없으면(비교 화면) 넘기지 않는다.
// useEffect가 아니라 useLayoutEffect로 알린다. useEffect는 화면을 그린 뒤 조금 늦게 돌아서, 그사이에 온 클릭은
// 바뀌기 전의 값을 본다. 알림이 칸 → 쪽지 상세 → 검수실로 두 번 올라가서 그 틈이 더 길다.
export const useDraftReport = (hasDraft: boolean, onDraftChange?: (hasDraft: boolean) => void) => {
  useLayoutEffect(() => {
    onDraftChange?.(hasDraft)
    return () => onDraftChange?.(false)
  }, [hasDraft, onDraftChange])
}
