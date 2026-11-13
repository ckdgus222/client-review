import { useState } from 'react'
import type { IssueDetail } from '../api/issues.ts'
import { type SubmitError, toSubmitError } from './useLockedSubmit.ts'

type IssueRequestOptions = {
  // 쪽지 상세를 서버에서 새로 받아 화면에 쓴 횟수. 저장됐는지 모르는 실패 뒤에 이 값이 오르면,
  // 지금 보이는 쪽지가 실패한 뒤에 서버에 물은 것이라는 뜻이다.
  fetchCount: number
  // 서버가 돌려준 바뀐 쪽지.
  onChanged: (issue: IssueDetail) => void
  onRefresh: () => void
}

// 서버가 "지금 상태에서는 받을 수 없다"고 답한 경우. 화면이 옛 상태를 보고 있던 것이다.
const isStale = (error: SubmitError) =>
  error.kind === 'conflict' && (error.code === 'ISSUE_STATE_CHANGED' || error.code === 'ATTEMPT_CHANGED')

// 실패한 뒤 쪽지를 새로 불러와야 하는가. 저장됐는지 모르거나(unknown), 화면이 아는 것과 서버가 다른 경우다:
// 상태가 달라졌거나(409) 내 권한이 바뀌었거나(403) 쪽지가 없어졌다(404).
// 로그인이 끝난 것(401)과 틀린 입력(422)은 새로 불러와도 달라지지 않는다.
const needsRefresh = (error: SubmitError) => {
  if (error.kind === 'unknown' || error.kind === 'conflict') return true
  return error.kind === 'rejected' && error.status !== 422
}

// 고쳤어요·확인 완료·재요청·철회·다시 열기가 함께 쓰는 보내기 규칙이다(기획 정할 것 7).
// 이 요청들은 요청 번호가 없다. 서버가 쪽지의 지금 상태로 막아서, 이미 저장된 요청이 다시 가도 두 번 적용되지 않는다.
// 그래서 실패해도 입력을 잠그지 않고, 쪽지를 새로 불러와서 다시 보낼지를 사람이 지금 상태를 보고 정하게 한다.
export const useIssueRequest = ({ fetchCount, onChanged, onRefresh }: IssueRequestOptions) => {
  const [sending, setSending] = useState(false)
  // 로그인 끝남, 새 버전, 거절처럼 문구만 보여 주면 되는 실패.
  const [error, setError] = useState<SubmitError>()
  // 연결이 끊기거나 서버 오류(5xx)로 저장됐는지 모르는 실패가 난 뒤 처음 그릴 때의 fetchCount. 그런 실패가 없으면 undefined다.
  // 그 뒤에 쪽지를 새로 받아 오면(fetchCount가 이 값에서 오르면) 안내가 걷힌다.
  const [unconfirmedAt, setUnconfirmedAt] = useState<number>()
  // 방금 그런 실패가 났다는 표시. 실패를 처리하는 함수는 버튼을 누른 때의 fetchCount만 알아서, 실패한 때의 값은 여기서 적지 못한다.
  const [failedUnknown, setFailedUnknown] = useState(false)
  // 그사이 쪽지 상태나 고쳤어요가 바뀌어서 서버가 받지 않았다. 다음에 보낼 때까지 알린다.
  const [stale, setStale] = useState(false)

  // 실패 뒤 처음 그릴 때 그때의 fetchCount를 적는다(그리는 중에 상태를 맞추는, React 문서가 effect 대신 권하는 방식).
  // 실패보다 먼저 끝난 불러오기가 실패와 같은 화면 갱신에 묶여도, 그 몫이 이미 더해진 값이 적힌다. 그래서 그 불러오기가
  // 방금 뜬 안내를 지우지 않고, 실패 뒤에 받아 온 쪽지만 안내를 거둔다.
  if (failedUnknown) {
    setFailedUnknown(false)
    setUnconfirmedAt(fetchCount)
  }
  const unconfirmed = unconfirmedAt === fetchCount

  // 저장됐으면 참을 돌려준다. 부르는 쪽은 그때만 쓰던 글을 비운다.
  const send = async (request: () => Promise<IssueDetail>) => {
    setSending(true)
    setError(undefined)
    setUnconfirmedAt(undefined)
    setStale(false)
    try {
      onChanged(await request())
      return true
    } catch (caught) {
      const submitError = toSubmitError(caught)
      if (needsRefresh(submitError)) onRefresh()
      if (submitError.kind === 'unknown') {
        setFailedUnknown(true)
        return false
      }
      if (isStale(submitError)) {
        setStale(true)
        return false
      }
      setError(submitError)
      return false
    } finally {
      setSending(false)
    }
  }

  return { sending, error, unconfirmed, stale, send }
}
