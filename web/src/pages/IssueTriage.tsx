import { useId, useState } from 'react'
import {
  ISSUE_CATEGORY_LABELS,
  ISSUE_SCOPE_LABELS,
  type IssueCategory,
  type IssueChange,
  type IssueDetail as Issue,
  type IssueScope,
  updateIssue,
} from '../api/issues.ts'
import { Button } from '../components/Button.tsx'
import { ErrorText } from '../components/ErrorText.tsx'
import { type SubmitError, toSubmitError } from '../hooks/useLockedSubmit.ts'
import styles from './IssueTriage.module.css'
import { SubmitErrorText } from './SubmitErrorText.tsx'

const CATEGORIES = Object.keys(ISSUE_CATEGORY_LABELS) as IssueCategory[]
const SCOPES = Object.keys(ISSUE_SCOPE_LABELS) as IssueScope[]

type IssueTriageProps = {
  issue: Issue
  // 지금 보고 있는 버전. 바꾸기 요청에 들어간다.
  versionId: string
  // 고른 버전이 현재 버전이고 검수 중인가. 아니면 입력을 그리지 않는다.
  canWrite: boolean
  isDeveloper: boolean
  // 검수실이 이 쪽지의 상세를 서버에서 새로 받아 화면에 쓴 횟수. 저장됐는지 모르는 실패 뒤에 이 값이 오르면,
  // 지금 보이는 값이 실패한 뒤에 서버에 물은 것이라는 뜻이다.
  fetchCount: number
  // 서버가 돌려준 바뀐 쪽지(자동 댓글이 들어 있다).
  onChanged: (issue: Issue) => void
  onRefresh: () => void
  onGoLatest: () => void
}

// 분류·범위·마감일을 바꾸는 칸. 분류는 개발자와 쓴 사람이, 범위와 마감일은 개발자만 바꾼다(서버도 같은 규칙으로 막는다).
// 쓸 수 없는 동안에도 이 부품은 화면에 남고 입력만 그리지 않는다. 그래야 치던 날짜가 버전을 옮겨 다녀도 남는다.
export const IssueTriage = ({
  issue,
  versionId,
  canWrite,
  isDeveloper,
  fetchCount,
  onChanged,
  onRefresh,
  onGoLatest,
}: IssueTriageProps) => {
  const categoryId = useId()
  const scopeId = useId()
  const dueDateId = useId()
  // 보내는 중인 변경. 응답이 올 때까지 고르기 칸은 고른 값을 보여 주고, 입력은 모두 잠긴다(한 번에 하나만 보낸다).
  const [sending, setSending] = useState<IssueChange>()
  const [error, setError] = useState<SubmitError>()
  // 연결이 끊기거나 서버 오류(5xx)로 저장됐는지 모르는 실패가 난 뒤 처음 그릴 때의 fetchCount. 그런 실패가 없으면 undefined다.
  // 그 뒤에 쪽지를 새로 받아 오면(fetchCount가 이 값에서 오르면) 안내가 걷힌다.
  const [unconfirmedAt, setUnconfirmedAt] = useState<number>()
  // 방금 그런 실패가 났다는 표시. 요청을 보낸 함수는 누른 때의 횟수만 알아서, 실패한 때의 횟수는 여기서 적지 못한다.
  const [failedUnknown, setFailedUnknown] = useState(false)
  // 날짜 칸에 치던 날짜. 치지 않았으면(undefined) 지금 마감일을 보여 준다.
  const [dueDraft, setDueDraft] = useState<string>()

  // 실패 뒤 처음 그릴 때 그때의 fetchCount를 적는다(그리는 중에 상태를 맞추는, React 문서가 effect 대신 권하는 방식).
  // 실패보다 먼저 끝난 불러오기가 실패와 같은 화면 갱신에 묶여도, 그 몫이 이미 더해진 값이 적힌다. 그래서 그 불러오기가
  // 방금 뜬 안내를 지우지 않고, 실패 뒤에 받아 온 쪽지만 안내를 거둔다(고쳤어요·확인하기의 useIssueRequest와 같은 규칙).
  // 쪽지 내용이 달라졌는지로 판단하지 않는다. 저장된 댓글은 서버에 다시 묻지 않고 화면에 바로 붙어서,
  // 새로 받아 오지 못했는데도 내용은 달라질 수 있다.
  if (failedUnknown) {
    setFailedUnknown(false)
    setUnconfirmedAt(fetchCount)
  }
  const unconfirmed = unconfirmedAt === fetchCount

  const send = async (change: IssueChange) => {
    setSending(change)
    setError(undefined)
    setUnconfirmedAt(undefined)
    try {
      onChanged(await updateIssue(issue.id, versionId, change))
      if (change.dueDate !== undefined) setDueDraft(undefined)
    } catch (caught) {
      const submitError = toSubmitError(caught)
      if (submitError.kind !== 'unknown') {
        setError(submitError)
        return
      }
      // 잠그지 않는다. 같은 값을 다시 보내도 서버가 지금 값과 비교해서, 이미 저장됐으면 기록이 두 번 남지 않는다.
      setFailedUnknown(true)
      onRefresh()
    } finally {
      // 실패하면 고르기 칸이 서버가 아는 값으로 돌아간다. 날짜 칸에 친 날짜는 남는다.
      setSending(undefined)
    }
  }

  const changeScope = (scope: IssueScope) => {
    // 범위는 바꿀 때마다 댓글이 남아서, 잘못 눌러 "갔다가 돌아온" 기록이 생기지 않게 먼저 묻는다.
    const label = ISSUE_SCOPE_LABELS[scope]
    if (window.confirm(`범위를 '${label}'으로 바꿀까요? 바꾼 기록이 댓글로 남아요.`)) void send({ scope })
  }

  if (!canWrite) {
    // 입력을 감춰도 새 버전 안내("최신 버전 보기")는 남긴다(댓글 칸과 같다).
    const versionChanged = error?.kind === 'conflict' && error.code === 'VERSION_CHANGED'
    return versionChanged ? <SubmitErrorText error={error} locked={false} onGoLatest={onGoLatest} /> : null
  }
  if (!isDeveloper && !issue.isMine) return null

  const busy = sending !== undefined
  const dueDate = dueDraft ?? issue.dueDate ?? ''

  return (
    <section className={styles.triage} aria-label="쪽지 정리">
      <div className={styles.field}>
        <label htmlFor={categoryId}>분류</label>
        <select
          id={categoryId}
          value={sending?.category ?? issue.category}
          onChange={(event) => void send({ category: event.target.value as IssueCategory })}
          disabled={busy}
        >
          {CATEGORIES.map((value) => (
            <option key={value} value={value}>
              {ISSUE_CATEGORY_LABELS[value]}
            </option>
          ))}
        </select>
      </div>
      {isDeveloper && (
        <>
          <div className={styles.field}>
            <label htmlFor={scopeId}>범위</label>
            <select
              id={scopeId}
              value={sending?.scope ?? issue.scope}
              onChange={(event) => changeScope(event.target.value as IssueScope)}
              disabled={busy}
            >
              {SCOPES.map((value) => (
                <option key={value} value={value}>
                  {ISSUE_SCOPE_LABELS[value]}
                </option>
              ))}
            </select>
          </div>
          <div className={styles.field}>
            <label htmlFor={dueDateId}>마감일</label>
            {/* 날짜 칸은 연도를 치는 도중에도 값이 바뀐다. 그래서 바뀔 때마다 보내지 않고 저장 버튼을 눌러야 보낸다. */}
            <input
              id={dueDateId}
              type="date"
              value={dueDate}
              onChange={(event) => setDueDraft(event.target.value)}
              disabled={busy}
            />
            <div className={styles.actions}>
              {issue.dueDate !== null && (
                <Button variant="secondary" disabled={busy} onClick={() => void send({ dueDate: null })}>
                  마감일 지우기
                </Button>
              )}
              <Button
                disabled={busy || dueDate === '' || dueDate === issue.dueDate}
                onClick={() => void send({ dueDate })}
              >
                마감일 저장
              </Button>
            </div>
          </div>
        </>
      )}
      {unconfirmed && (
        <ErrorText message="저장됐는지 확인하지 못했어요. 쪽지에 바뀐 값이 보이지 않으면 다시 눌러 주세요." />
      )}
      {error && <SubmitErrorText error={error} locked={false} onGoLatest={onGoLatest} />}
    </section>
  )
}
