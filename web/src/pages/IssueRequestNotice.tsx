import type { ReactNode } from 'react'
import { ErrorText } from '../components/ErrorText.tsx'
import type { SubmitError } from '../hooks/useLockedSubmit.ts'
import { SubmitErrorText } from './SubmitErrorText.tsx'

type IssueRequestNoticeProps = {
  error?: SubmitError
  unconfirmed: boolean
  stale: boolean
  onGoLatest: () => void
  // 새 버전 안내를 다르게 보여 줄 때 넘긴다(비교 화면에는 버전 고르기가 없어서 검수실로 가는 링크를 보여 준다).
  versionChangedNotice?: ReactNode
}

// 고쳤어요 보내기와 확인하기가 실패를 같은 문구로 알린다. 어떤 실패든 쓰던 글은 화면에 그대로 남는다.
export const IssueRequestNotice = ({
  error,
  unconfirmed,
  stale,
  onGoLatest,
  versionChangedNotice,
}: IssueRequestNoticeProps) => {
  if (unconfirmed) {
    return <ErrorText message="저장됐는지 확인하지 못했어요. 쪽지에 바뀐 내용이 보이지 않으면 다시 보내 주세요." />
  }
  if (stale) return <ErrorText message="쪽지 상태가 바뀌었어요. 새로 불러왔어요." />
  if (!error) return null
  const versionChanged = error.kind === 'conflict' && error.code === 'VERSION_CHANGED'
  if (versionChangedNotice && versionChanged) return <ErrorText message={versionChangedNotice} />
  return <SubmitErrorText error={error} locked={false} onGoLatest={onGoLatest} />
}
