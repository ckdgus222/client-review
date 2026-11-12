import { useRef, useState } from 'react'
import { ApiError } from '../api/client.ts'

// 화면이 문구를 고를 수 있게 실패를 종류로 나눈다.
// unknown: 연결이 끊겼거나 서버 오류(5xx)라서 저장됐는지 알 수 없다.
// session: 로그인이 끝났다(401). conflict: 상태가 안 맞는다(409, code로 구분). rejected: 그 밖의 거절(403·404·422).
export type SubmitError =
  { kind: 'unknown' } | { kind: 'session' } | { kind: 'conflict'; code?: string } | { kind: 'rejected'; status: number }

// 훅을 거치지 않는 한 번짜리 쓰기(수정 시작, 참고 사진)도 같은 종류로 나눠 같은 문구를 쓴다.
export const toSubmitError = (error: unknown): SubmitError => {
  if (!(error instanceof ApiError) || error.status >= 500) return { kind: 'unknown' }
  if (error.status === 401) return { kind: 'session' }
  if (error.status === 409) return { kind: 'conflict', code: error.code }
  return { kind: 'rejected', status: error.status }
}

// 쪽지와 댓글 보내기가 함께 쓰는 규칙이다(기획 정할 것 12).
// 서버는 같은 requestId를 다시 받으면 처음 저장한 글을 그대로 돌려준다. 그래서 저장됐는지 모르는 실패 뒤에
// 글을 고쳐 같은 번호로 보내면, 고친 내용은 저장되지 않았는데 저장된 것처럼 보인다.
// 이를 막으려고 그런 실패 뒤에는 처음 보낸 요청을 그대로 기억해 잠그고(locked), 다시 보내기는 그 요청만 보낸다.
// 잠금은 다시 보내기가 성공하거나 409를 받거나(서버는 requestId를 먼저 보고 그다음에 409를 주므로 처음 것도
// 저장되지 않은 것이 확실하다) 취소할 때만 풀린다. 다시 보내기가 401·연결 실패 등으로 실패하면 잠긴 채로 둔다.
export const useLockedSubmit = <Request, Result>(
  send: (request: Request) => Promise<Result>,
  onDone: (result: Result) => void,
) => {
  const [sending, setSending] = useState(false)
  const [locked, setLocked] = useState<Request>()
  const [error, setError] = useState<SubmitError>()
  // 보내는 중에 한 번 더 눌러도 요청이 하나만 가게 한다. 상태(sending)는 다음 그리기에야 바뀌어서 ref로 바로 막는다.
  const busy = useRef(false)

  const run = async (request: Request) => {
    if (busy.current) return
    busy.current = true
    setSending(true)
    setError(undefined)
    try {
      const result = await send(request)
      setLocked(undefined)
      onDone(result)
    } catch (caught) {
      const submitError = toSubmitError(caught)
      setError(submitError)
      // 그 밖의 실패(401·403·404·422)는 잠금을 건드리지 않는다. 잠겨 있었으면 잠긴 채로, 아니었으면 안 잠긴 채로 남는다.
      if (submitError.kind === 'unknown') setLocked(request)
      else if (submitError.kind === 'conflict') setLocked(undefined)
    } finally {
      busy.current = false
      setSending(false)
    }
  }

  return {
    sending,
    locked,
    error,
    // 잠겨 있으면 새 요청을 받지 않는다. 화면이 입력칸을 잠그지만, 여기서도 한 번 더 막는다.
    submit: (request: Request) => (locked === undefined ? run(request) : Promise.resolve()),
    retry: () => (locked === undefined ? Promise.resolve() : run(locked)),
    cancel: () => {
      setLocked(undefined)
      setError(undefined)
    },
  }
}
