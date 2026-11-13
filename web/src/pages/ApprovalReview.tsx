import { type ReactNode, useEffect, useEffectEvent, useRef, useState } from 'react'
import { Link } from 'react-router'
import {
  type ApprovalCheck,
  type ApprovalCheckIssue,
  approveVersion,
  getApprovalCheck,
  timeFormat,
  type VersionDetail,
  versionLabel,
} from '../api/versions.ts'
import { Button } from '../components/Button.tsx'
import { ErrorText } from '../components/ErrorText.tsx'
import { Modal } from '../components/Modal.tsx'
import { StatusBadge } from '../components/StatusBadge.tsx'
import { type SubmitError, toSubmitError } from '../hooks/useLockedSubmit.ts'
import styles from './ApprovalReview.module.css'
import { SubmitErrorText } from './SubmitErrorText.tsx'

const isConflict = (error: SubmitError | undefined, code: string) => error?.kind === 'conflict' && error.code === code
const isRejected = (error: SubmitError | undefined, status: number) =>
  error?.kind === 'rejected' && error.status === status

// 승인된 버전을 알리는 글. 승인 검토 창의 승인 완료 모습과 검수실의 승인 띠가 같은 글자로 보여 준다.
// 색만으로 구분하지 않게 ✓ 모양과 글자를 함께 쓴다. 게시한 버전만 승인돼서 번호는 늘 있다.
export const ApprovedSummary = ({ version }: { version: VersionDetail }) => (
  <>
    {version.number !== null && (
      <p className={styles.approvedTitle}>
        <span aria-hidden="true">✓</span> {versionLabel(version.number)}
        {/* "초안이", "1차가"처럼 받침에 따라 조사가 다르다. 번호 0이 초안이다. */}
        {version.number === 0 ? '이' : '가'} 승인됐어요
      </p>
    )}
    {version.approval && (
      <p>
        승인자 {version.approval.approverName} · {timeFormat.format(new Date(version.approval.approvedAt))}
      </p>
    )}
    <p>이 버전은 읽기 전용이에요. 새 요청은 다음 차수에서 할 수 있어요.</p>
    {/* 승인된 버전만 이 글이 보여서 링크도 그때만 있다. 확인서는 승인한 때의 쪽지 목록을 보여 준다. */}
    <Link to={`/versions/${version.id}/certificate`}>검수 확인서 보기</Link>
  </>
)

// 승인 검토에서만 쓰는 실패 문구. 여기에 없는 실패(로그인 끝남, 새 버전, 없는 버전 등)는 쪽지 쓰기와 같은 문구를 쓴다.
const describeFailure = (error: SubmitError, phase: 'load' | 'approve') => {
  if (isConflict(error, 'NEW_COMMENTS')) return '새 댓글이 있어요. 확인 후 다시 승인해 주세요'
  if (isConflict(error, 'UNRESOLVED_ISSUES')) return '아직 끝나지 않은 쪽지가 있어요'
  if (isConflict(error, 'VERSION_NOT_IN_REVIEW')) return '이미 승인된 버전이에요'
  if (isRejected(error, 403)) return '승인자만 할 수 있어요'
  if (isRejected(error, 422)) return '승인 검토를 새로 불러왔어요. 다시 승인해 주세요'
  if (error.kind !== 'unknown') return undefined
  // 응답을 못 받은 승인은 서버에서 저장됐을 수 있어서 "실패했어요"라고 하지 않는다.
  return phase === 'approve'
    ? '승인됐는지 확인하지 못했어요. 승인 완료가 보이지 않으면 다시 눌러 주세요'
    : '승인 검토를 불러오지 못했어요. 연결을 확인하고 다시 불러와 주세요'
}

type IssueRowsProps = { issues: ApprovalCheckIssue[]; disabled: boolean; onOpenIssue?: (issueId: string) => void }

const IssueRows = ({ issues, disabled, onOpenIssue }: IssueRowsProps) => (
  <ul className={styles.issues}>
    {issues.map((issue) => (
      <li key={issue.id}>
        {onOpenIssue ? (
          <button
            type="button"
            className={styles.link}
            aria-label={`쪽지 #${issue.number} 열기`}
            disabled={disabled}
            onClick={() => onOpenIssue(issue.id)}
          >
            #{issue.number}
          </button>
        ) : (
          <span>#{issue.number}</span>
        )}
        <span className={styles.issueTitle}>{issue.title}</span>
        <StatusBadge status={issue.status} />
      </li>
    ))}
  </ul>
)

type CheckListsProps = {
  check: ApprovalCheck
  // 승인을 보내는 중인가. 그동안에는 쪽지 번호를 누를 수 없다. 누르면 창이 닫혀서 승인 결과 안내를 놓친다.
  sending: boolean
  onOpenIssue?: (issueId: string) => void
}

// 승인자가 승인하기 전에 훑어보는 세 목록: 끝나지 않은 쪽지, 범위 밖 쪽지, 이번 차수의 댓글.
const CheckLists = ({ check, sending, onOpenIssue }: CheckListsProps) => {
  const { unresolved, outOfScope, comments } = check
  const hasIssues = unresolved.length > 0 || outOfScope.length > 0

  return (
    <>
      {/* 새 쪽지를 쓰는 중에는 검수실이 쓰기 칸만 보여 줘서 다른 쪽지를 열 수 없다. 번호를 글자로만 보여 주고 이유를 알린다. */}
      {hasIssues && !onOpenIssue && <p className={styles.hint}>쓰던 쪽지를 보내거나 취소하면 열 수 있어요</p>}
      {unresolved.length > 0 ? (
        <section className={styles.section} aria-label="끝나지 않은 쪽지">
          <h3>아직 끝나지 않은 쪽지가 {unresolved.length}개 있어요</h3>
          <IssueRows issues={unresolved} disabled={sending} onOpenIssue={onOpenIssue} />
        </section>
      ) : (
        <p>끝나지 않은 쪽지가 없어요.</p>
      )}
      {outOfScope.length > 0 && (
        <section className={styles.section} aria-label="범위 밖 쪽지">
          <h3>범위 밖(추가 요청) 쪽지 {outOfScope.length}개는 이번 승인에서 빼요</h3>
          <IssueRows issues={outOfScope} disabled={sending} onOpenIssue={onOpenIssue} />
        </section>
      )}
      <section className={styles.section} aria-label="이번 차수의 댓글">
        {comments.length > 0 ? (
          <>
            <h3>이번 차수의 댓글 {comments.length}개</h3>
            <ul className={styles.comments}>
              {comments.map((comment) => (
                <li key={comment.id}>
                  <p className={styles.commentMeta}>
                    <span>
                      #{comment.issueNumber} {comment.issueTitle}
                    </span>
                    <span>
                      <strong>{comment.authorName}</strong> · {timeFormat.format(new Date(comment.createdAt))}
                    </span>
                  </p>
                  {/* 글은 일반 글자로만 보여 준다. 줄바꿈은 CSS(pre-wrap)가 살린다. */}
                  <p className={styles.commentBody}>{comment.body}</p>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p>이번 차수에 달린 댓글이 없어요</p>
        )}
      </section>
    </>
  )
}

type ApprovalReviewProps = {
  // 승인 검토를 연 버전. 검토 결과, seenAt, 승인 요청이 모두 이 버전의 id를 쓴다.
  version: VersionDetail
  // 쪽지 번호를 누르면 부른다(창을 닫고 그 쪽지를 여는 일은 검수실이 한다). 새 쪽지를 쓰는 중이면 넘기지 않는다.
  onOpenIssue?: (issueId: string) => void
  // 서버가 돌려준 승인된 버전 상세.
  onApproved: (version: VersionDetail) => void
  // 이 버전의 상세를 다시 읽어 달라는 요청. 이미 승인됐다는 답을 받았거나, 승인됐는지 모를 때 부른다.
  onReloadVersion: () => void
  // 승인자가 아니라는 답(403)을 받았다. 그사이 승인자가 바뀐 것이라, 검수실이 "버전 승인" 버튼을 없앤다.
  onNotApprover: () => void
  onGoLatest: () => void
  onClose: () => void
}

// 승인 검토 창. 열리면 서버에 지금 상태를 물어 보여 주고, 승인자가 확인 단계를 거쳐 승인한다.
// 버전이 승인됨이면 승인 완료 모습만 보여 준다. 따로 "성공함"을 기억하지 않고 버전의 상태만 본다. 그래서 승인 응답을
// 받았을 때도, 다시 읽어 보니 이미 승인돼 있을 때도(응답이 끊긴 승인, 다른 창에서 한 승인) 같은 모습이다.
export const ApprovalReview = ({
  version,
  onOpenIssue,
  onApproved,
  onReloadVersion,
  onNotApprover,
  onGoLatest,
  onClose,
}: ApprovalReviewProps) => {
  const [check, setCheck] = useState<ApprovalCheck>()
  const [loadError, setLoadError] = useState<SubmitError>()
  // 올리면 승인 검토를 다시 불러온다.
  const [loads, setLoads] = useState(0)
  // "승인하기"를 누른 뒤의 확인 단계인가.
  const [confirming, setConfirming] = useState(false)
  const [sending, setSending] = useState(false)
  const [approveError, setApproveError] = useState<SubmitError>()
  // 이 창이 사라졌는가(닫음, 보고 있는 버전이 바뀜). 사라진 뒤에 끝난 승인 요청의 실패를 버리는 데 쓴다(approve 참고).
  // 개발 모드(StrictMode)는 effect를 정리했다가 다시 돌려서, 돌 때마다 거짓으로 되돌린다.
  const closed = useRef(false)
  useEffect(() => {
    closed.current = false
    return () => {
      closed.current = true
    }
  }, [])

  // 화면이 아는 것과 서버가 다를 때 검수실에 알린다: 승인자가 바뀌었거나(403) 이미 승인된 버전이다.
  const reportFailure = (error: SubmitError) => {
    if (isRejected(error, 403)) onNotApprover()
    if (isConflict(error, 'VERSION_NOT_IN_REVIEW')) onReloadVersion()
  }
  // effect 안에서는 이 함수로 부른다. 늘 지금의 콜백을 쓰면서도, 콜백이 바뀌었다고 승인 검토를 다시 불러오지 않는다.
  const reportLoadFailure = useEffectEvent(reportFailure)

  useEffect(() => {
    // 창을 닫거나 다시 불러오면 먼저 보낸 요청의 늦은 응답을 버린다.
    let ignore = false
    const load = async () => {
      try {
        const loaded = await getApprovalCheck(version.id)
        if (!ignore) setCheck(loaded)
      } catch (caught) {
        if (ignore) return
        const error = toSubmitError(caught)
        setLoadError(error)
        reportLoadFailure(error)
      }
    }
    void load()
    return () => {
      ignore = true
    }
  }, [version.id, loads])

  // 지난 목록을 치우고 다시 불러온다. 새 목록과 새 serverTime이 올 때까지 승인하기도 보이지 않는다.
  const reload = () => {
    setCheck(undefined)
    setLoadError(undefined)
    setLoads((count) => count + 1)
  }

  const approve = async (seenAt: string) => {
    setSending(true)
    try {
      onApproved(await approveVersion(version.id, seenAt))
    } catch (caught) {
      // 창이 사라진 뒤에 온 실패는 버린다. 그사이 검수실이 프로젝트를 다시 읽었을 수 있어서, 옛 요청의 "승인자가 아니에요"가
      // 새로 받은 권한을 지우면 안 된다. 성공은 버리지 않는다(실제로 승인된 것이라 검수실이 그 버전에 쓴다).
      if (closed.current) return
      const error = toSubmitError(caught)
      setApproveError(error)
      setConfirming(false)
      reportFailure(error)
      // 새 댓글이나 새 쪽지가 생겼으면 새 목록을 보여 준다. 422는 서버가 seenAt을 받지 않은 것이라 새로 받아 온다.
      const isOutdated = isConflict(error, 'NEW_COMMENTS') || isConflict(error, 'UNRESOLVED_ISSUES')
      if (isOutdated || isRejected(error, 422)) reload()
      // 응답을 못 받았으면(30초 한도로 끊긴 요청 포함) 승인됐는지 모른다. 버전을 다시 읽어서 확인한다.
      if (error.kind === 'unknown') onReloadVersion()
    } finally {
      setSending(false)
    }
  }

  // 앞의 실패 안내를 지우고 확인 단계로 간다. 안내가 "승인할까요?" 위에 남아 있으면 지금도 막힌 것처럼 보인다.
  // 승인 요청은 늘 이 단계를 거쳐서 가니, 보낼 때 안내를 한 번 더 지울 필요가 없다.
  const startConfirming = () => {
    setApproveError(undefined)
    setConfirming(true)
  }

  const closeAndGoLatest = () => {
    onClose()
    onGoLatest()
  }
  const errorText = (error: SubmitError, phase: 'load' | 'approve'): ReactNode => {
    const message = describeFailure(error, phase)
    if (message) return <ErrorText message={message} />
    return <SubmitErrorText error={error} locked={false} onGoLatest={closeAndGoLatest} />
  }

  const label = version.number === null ? '' : versionLabel(version.number)
  if (version.status === 'APPROVED') {
    return (
      <Modal title={`${label} 승인 완료`} onClose={onClose}>
        <div className={styles.review}>
          <ApprovedSummary version={version} />
          <div className={styles.actions}>
            <Button onClick={onClose}>닫기</Button>
          </div>
        </div>
      </Modal>
    )
  }

  // 승인자가 아니거나 새 버전이 올라왔으면 이 창에서 더 할 수 있는 일이 없다. 닫기만 남긴다.
  // 두 실패를 다 본다. 승인이 "새 댓글"로 막힌 뒤 다시 불러온 승인 검토가 이 답을 받을 수 있다.
  const isOver = [approveError, loadError].some(
    (error) => isRejected(error, 403) || isConflict(error, 'VERSION_CHANGED'),
  )
  const isLoading = !check && !loadError

  return (
    // 보내는 동안에는 닫지 않는다(닫기, ×, Esc). 닫으면 승인 결과를 볼 곳이 없다.
    <Modal title={`${label} 승인 검토`} onClose={sending ? () => {} : onClose}>
      <div className={styles.review}>
        {isLoading && <p role="status">승인 검토를 불러오는 중이에요</p>}
        {check && <CheckLists check={check} sending={sending} onOpenIssue={onOpenIssue} />}
        <div className={styles.footer}>
          {loadError && errorText(loadError, 'load')}
          {approveError && errorText(approveError, 'approve')}
          {confirming && check ? (
            <>
              <p>이 버전을 승인할까요? 승인하면 되돌릴 수 없어요.</p>
              <div className={styles.actions}>
                <Button variant="secondary" disabled={sending} onClick={() => setConfirming(false)}>
                  취소
                </Button>
                <Button disabled={sending} onClick={() => void approve(check.serverTime)}>
                  승인 확정
                </Button>
              </div>
            </>
          ) : (
            <div className={styles.actions}>
              <Button variant="secondary" onClick={onClose}>
                닫기
              </Button>
              {loadError && !isOver && (
                <Button variant="secondary" onClick={reload}>
                  다시 불러오기
                </Button>
              )}
              {check && !isOver && (
                <Button disabled={check.unresolved.length > 0} onClick={startConfirming}>
                  승인하기
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}
