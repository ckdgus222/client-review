import { type FormEvent, type ReactNode, useId, useState } from 'react'
import { type IssueDetail as Issue, type IssueStatus, reopenIssue, verifyIssue, withdrawIssue } from '../api/issues.ts'
import { Button } from '../components/Button.tsx'
import { ErrorText } from '../components/ErrorText.tsx'
import { useIssueRequest } from '../hooks/useIssueRequest.ts'
import { IssueRequestNotice } from './IssueRequestNotice.tsx'
import styles from './IssueReview.module.css'

// 서버의 한도와 같다(사유 2,000자). 바꾸면 서버도 함께 바꾼다.
const REASON_MAX = 2000

// 사유를 적어야 보내는 동작. 재요청은 확인 요청을 돌려보내는 것이고, 다시 열기는 끝난 쪽지를 접수로 되돌리는 것이다.
type ReasonAction = 'reject' | 'withdraw' | 'reopen'

const REASON_FORMS: Record<ReasonAction, { open: string; label: string; submit: string }> = {
  reject: { open: '재요청', label: '재요청 사유', submit: '재요청 보내기' },
  withdraw: { open: '철회', label: '철회 사유', submit: '철회하기' },
  reopen: { open: '다시 열기', label: '다시 여는 사유', submit: '다시 열기' },
}

// 쪽지 상태마다 할 수 있는, 사유를 적는 동작(서버도 같은 규칙으로 막는다). 사유가 필요 없는 확인 완료는
// 확인 요청일 때 재요청과 늘 함께 보여서 여기에 넣지 않는다. 비교 화면(reviewOnly)에서는 확인 완료와 재요청만 한다.
const reasonActionsFor = (status: IssueStatus, reviewOnly: boolean): ReasonAction[] => {
  if (status === 'READY_FOR_REVIEW') return reviewOnly ? ['reject'] : ['reject', 'withdraw']
  if (reviewOnly) return []
  if (status === 'VERIFIED' || status === 'WITHDRAWN') return ['reopen']
  return ['withdraw']
}

type IssueReviewProps = {
  issue: Issue
  // 지금 보고 있는 버전. 요청에 들어간다.
  versionId: string
  // 고른 버전이 현재 버전이고 검수 중인가. 아니면 버튼을 그리지 않는다.
  canWrite: boolean
  // 확인 완료와 재요청만 보여 준다(비교 화면).
  reviewOnly?: boolean
  // 이 쪽지의 상세를 서버에서 새로 받아 화면에 쓴 횟수(useIssueRequest 참고).
  fetchCount: number
  // 서버가 돌려준 바뀐 쪽지(바뀐 상태, 고쳤어요 줄의 결과, 사유 댓글이 들어 있다).
  onChanged: (issue: Issue) => void
  onRefresh: () => void
  onGoLatest: () => void
  // 새 버전 안내를 다르게 보여 줄 때 넘긴다(IssueRequestNotice 참고).
  versionChangedNotice?: ReactNode
}

// 쪽지를 쓴 클라이언트와 승인자가 고쳤어요에 답하는 칸: 확인 완료, 재요청, 철회, 다시 열기.
// 볼 수 없는 동안에도 이 부품은 화면에 남고 버튼만 그리지 않는다. 그래야 쓰던 사유가 15초 새로 불러오기나
// 버전을 옮겨 다닌 뒤에도 남는다. 저장하거나 취소하거나 쪽지를 닫으면 사라진다.
export const IssueReview = ({
  issue,
  versionId,
  canWrite,
  reviewOnly = false,
  fetchCount,
  onChanged,
  onRefresh,
  onGoLatest,
  versionChangedNotice,
}: IssueReviewProps) => {
  const reasonFieldId = useId()
  // 사유 칸을 펴 둔 동작. 그 동작을 할 수 없는 상태가 되면 칸을 그리지 않는다.
  const [opened, setOpened] = useState<ReasonAction>()
  const [reason, setReason] = useState('')
  const [reasonError, setReasonError] = useState<string>()
  const { sending, error, unconfirmed, stale, send } = useIssueRequest({ fetchCount, onChanged, onRefresh })

  const notice = (
    <IssueRequestNotice
      error={error}
      unconfirmed={unconfirmed}
      stale={stale}
      onGoLatest={onGoLatest}
      versionChangedNotice={versionChangedNotice}
    />
  )
  const reasonActions = issue.canReview && canWrite ? reasonActionsFor(issue.status, reviewOnly) : []
  // 버튼을 감춰도 안내는 남긴다. 새 버전 안내까지 감추면 다시 불러올 길이 없다.
  if (reasonActions.length === 0) return notice

  // 확인 완료와 재요청이 답하는 줄. 보고 있던 줄의 id를 보내서, 그사이 새 고쳤어요가 왔으면 서버가 멈춘다.
  const latestAttemptId = issue.attempts[issue.attempts.length - 1]?.id
  const shownForm = opened && reasonActions.includes(opened) ? opened : undefined

  const closeForm = () => {
    setOpened(undefined)
    setReason('')
    setReasonError(undefined)
  }

  const verify = () => {
    if (latestAttemptId === undefined) return
    void send(() => verifyIssue(issue.id, { versionId, attemptId: latestAttemptId }))
  }

  const sendReason = (action: ReasonAction, trimmed: string) => {
    if (action === 'withdraw') return withdrawIssue(issue.id, { versionId, reason: trimmed })
    // 재요청은 보고 있던 고쳤어요 줄을 함께 보내고, 다시 열기는 보내지 않는다. 서버가 이것으로 둘을 가린다.
    const attemptId = action === 'reject' ? latestAttemptId : undefined
    return reopenIssue(issue.id, { versionId, reason: trimmed, attemptId })
  }

  const handleSubmit = async (event: FormEvent, action: ReasonAction) => {
    event.preventDefault()
    const trimmed = reason.trim()
    if (trimmed.length < 1 || trimmed.length > REASON_MAX) {
      setReasonError(`사유는 1~${REASON_MAX.toLocaleString('ko-KR')}자로 써 주세요`)
      return
    }
    setReasonError(undefined)
    const saved = await send(() => sendReason(action, trimmed))
    if (saved) closeForm()
  }

  if (shownForm === undefined) {
    return (
      <section className={styles.review} aria-label="확인하기">
        <div className={styles.actions}>
          {reasonActions.map((action) => (
            <Button key={action} variant="secondary" disabled={sending} onClick={() => setOpened(action)}>
              {REASON_FORMS[action].open}
            </Button>
          ))}
          {issue.status === 'READY_FOR_REVIEW' && (
            <Button disabled={sending} onClick={verify}>
              확인 완료
            </Button>
          )}
        </div>
        {notice}
      </section>
    )
  }

  const form = REASON_FORMS[shownForm]
  return (
    <section className={styles.review} aria-label="확인하기">
      {/* 사유 칸은 버튼을 누른 그 자리에 편다. 쓰는 동안 쪽지 내용과 댓글이 그대로 보인다. */}
      <form className={styles.form} onSubmit={(event) => void handleSubmit(event, shownForm)} noValidate>
        <label htmlFor={reasonFieldId}>{form.label}</label>
        <textarea
          id={reasonFieldId}
          rows={3}
          maxLength={REASON_MAX}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          // 보내는 동안에도 읽고 복사할 수는 있게 disabled 대신 readOnly로 둔다.
          readOnly={sending}
          aria-invalid={reasonError ? true : undefined}
        />
        {reasonError && <ErrorText message={reasonError} />}
        {notice}
        <div className={styles.actions}>
          <Button variant="secondary" disabled={sending} onClick={closeForm}>
            취소
          </Button>
          <Button type="submit" disabled={sending}>
            {form.submit}
          </Button>
        </div>
      </form>
    </section>
  )
}
