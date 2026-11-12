import { type ChangeEvent, type FormEvent, useEffect, useId, useState } from 'react'
import { ApiError } from '../api/client.ts'
import {
  attachIssuePhoto,
  createComment,
  type IssueComment,
  type IssueDetail as Issue,
  type NewComment,
  originLabel,
  removeIssuePhoto,
  startIssue,
} from '../api/issues.ts'
import { assetUrl, timeFormat, versionLabel } from '../api/versions.ts'
import { Button } from '../components/Button.tsx'
import { ErrorText } from '../components/ErrorText.tsx'
import { StatusBadge } from '../components/StatusBadge.tsx'
import { type SubmitError, toSubmitError, useLockedSubmit } from '../hooks/useLockedSubmit.ts'
import styles from './IssueDetail.module.css'
import { SubmitErrorText } from './SubmitErrorText.tsx'

// 서버의 한도와 같다(쪽지마다 참고 사진 3장, 댓글 2,000자). 바꾸면 서버도 함께 바꾼다.
const MAX_ATTACHMENTS = 3
const COMMENT_MAX = 2000

type IssueDetailProps = {
  issue: Issue
  // 지금 보고 있는 버전. 댓글과 수정 시작 요청에 들어간다.
  versionId: string
  // 고른 버전이 현재 버전이고 검수 중인가. 쪽지가 어느 버전에서 시작했는지는 보지 않는다.
  canWrite: boolean
  isDeveloper: boolean
  // 수정 시작·참고 사진처럼 서버가 바뀐 쪽지를 돌려준 경우.
  onChanged: (issue: Issue) => void
  // 댓글이 저장된 경우. 서버는 저장한 댓글만 돌려준다. 바로 뒤에 onRefresh도 부른다.
  onCommented: (comment: IssueComment) => void
  // 댓글을 썼거나 화면이 아는 것과 서버가 달라져서, 쪽지를 다시 불러와야 하는 경우.
  onRefresh: () => void
  // 아직 저장되지 않은 댓글 글이 있는지 알린다(쓰는 중, 보내는 중, 잠김). 검수실이 새 쪽지 쓰기로 넘어가기 전에 묻는 데 쓴다.
  onDraftChange: (hasDraft: boolean) => void
  onGoLatest: () => void
  onClose: () => void
}

// 참고 사진만의 거절 사유. 그 밖의 실패는 다른 쓰기와 같은 문구(SubmitErrorText)로 보여 준다.
const photoErrorMessage = (error: unknown) => {
  if (!(error instanceof ApiError)) return undefined
  if (error.status === 413) return '사진이 너무 커요. 20 MiB까지 붙일 수 있어요'
  if (error.status === 415) return 'PNG, JPEG, WebP 사진만 붙일 수 있어요'
  if (error.code === 'TOO_MANY_ATTACHMENTS') return `참고 사진은 ${MAX_ATTACHMENTS}장까지 붙일 수 있어요`
  return undefined
}

type ActionsProps = Pick<
  IssueDetailProps,
  'issue' | 'versionId' | 'canWrite' | 'isDeveloper' | 'onChanged' | 'onRefresh' | 'onGoLatest'
>

// 참고 사진과 수정 시작. 둘 다 누르면 바로 보내는 동작이라, 진행과 실패를 한 곳에서 다룬다.
const Actions = ({ issue, versionId, canWrite, isDeveloper, onChanged, onRefresh, onGoLatest }: ActionsProps) => {
  const [busy, setBusy] = useState(false)
  // 참고 사진만의 거절 사유(photo)이거나, 다른 쓰기와 같은 종류의 실패다.
  const [error, setError] = useState<SubmitError | { kind: 'photo'; message: string }>()
  const canEditPhotos = canWrite && issue.isMine

  const run = async (action: () => Promise<Issue>) => {
    setBusy(true)
    setError(undefined)
    try {
      onChanged(await action())
    } catch (caught) {
      // 이미 지워진 사진이나 이미 시작된 쪽지는 화면이 옛 상태를 보고 있던 것이라, 오류 대신 새로 불러온다.
      const isStale = caught instanceof ApiError && (caught.status === 404 || caught.code === 'ISSUE_NOT_OPEN')
      if (isStale) {
        onRefresh()
        return
      }
      const photoMessage = photoErrorMessage(caught)
      setError(photoMessage ? { kind: 'photo', message: photoMessage } : toSubmitError(caught))
    } finally {
      setBusy(false)
    }
  }

  const attach = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    // 같은 파일을 다시 골라도 change가 나게 고른 값을 비운다.
    event.target.value = ''
    if (file) void run(() => attachIssuePhoto(issue.id, file))
  }

  const remove = (attachmentId: string) => {
    if (window.confirm('이 사진을 지울까요?')) void run(() => removeIssuePhoto(issue.id, attachmentId))
  }

  return (
    <>
      {issue.attachments.length > 0 && (
        <ul className={styles.photos} aria-label="참고 사진">
          {issue.attachments.map((attachment, index) => (
            <li key={attachment.id}>
              {/* 작게 보여 주고, 누르면 새 창에서 원래 크기로 연다. */}
              <a href={assetUrl(attachment.assetId)} target="_blank" rel="noreferrer">
                <img
                  src={assetUrl(attachment.assetId)}
                  width={attachment.width}
                  height={attachment.height}
                  alt={`참고 사진 ${index + 1}`}
                  loading="lazy"
                />
              </a>
              {canEditPhotos && (
                <button type="button" className={styles.link} disabled={busy} onClick={() => remove(attachment.id)}>
                  지우기
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEditPhotos && issue.attachments.length < MAX_ATTACHMENTS && (
        <label className={styles.attach}>
          참고 사진 붙이기
          <input type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={attach} />
        </label>
      )}
      {isDeveloper && canWrite && issue.status === 'OPEN' && (
        <Button disabled={busy} onClick={() => void run(() => startIssue(issue.id, versionId))}>
          수정 시작
        </Button>
      )}
      {error?.kind === 'photo' ? (
        <ErrorText message={error.message} />
      ) : (
        error && <SubmitErrorText error={error} locked={false} onGoLatest={onGoLatest} />
      )}
    </>
  )
}

type CommentFormProps = Pick<
  IssueDetailProps,
  'issue' | 'versionId' | 'canWrite' | 'onCommented' | 'onRefresh' | 'onDraftChange' | 'onGoLatest'
>

const CommentForm = ({
  issue,
  versionId,
  canWrite,
  onCommented,
  onRefresh,
  onDraftChange,
  onGoLatest,
}: CommentFormProps) => {
  const bodyId = useId()
  const [body, setBody] = useState('')
  const [bodyError, setBodyError] = useState<string>()
  // 댓글 하나에 번호 하나다. 저장되면 다음 댓글을 위해 새 번호를 만든다.
  const [requestId, setRequestId] = useState(() => crypto.randomUUID())
  // 요청에 대상 쪽지도 함께 담는다. 잠긴 뒤에는 처음 보낸 대상과 글이 그대로 다시 간다.
  const { sending, locked, error, submit, retry, cancel } = useLockedSubmit(
    (request: { issueId: string; comment: NewComment }) => createComment(request.issueId, request.comment),
    (comment) => {
      setBody('')
      setRequestId(crypto.randomUUID())
      onCommented(comment)
      onRefresh()
    },
  )
  const isLocked = locked !== undefined

  // 보내는 중이거나 잠긴 댓글도 글이 칸에 남아 있어서, 글이 있는지만 보면 된다. 저장되면 칸이 비워진다.
  const hasDraft = body.trim() !== ''

  useEffect(() => {
    onDraftChange(hasDraft)
    // 쪽지를 닫거나 다른 쪽지를 열어서 이 칸이 사라지면 쓰던 댓글도 함께 사라진다.
    return () => onDraftChange(false)
  }, [hasDraft, onDraftChange])

  // 취소한 뒤에는 새 번호로 보낸다. 처음 것이 저장돼 있었다면, 같은 번호로 고친 글을 보냈을 때
  // 서버가 처음 댓글을 돌려줘서 고친 글이 저장되지 않는다. 글은 지우지 않고 남긴다.
  const handleCancel = () => {
    cancel()
    setRequestId(crypto.randomUUID())
  }

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()
    if (isLocked) {
      void retry()
      return
    }
    const trimmed = body.trim()
    if (trimmed.length < 1 || trimmed.length > COMMENT_MAX) {
      setBodyError(`댓글은 1~${COMMENT_MAX.toLocaleString('ko-KR')}자로 써 주세요`)
      return
    }
    setBodyError(undefined)
    void submit({ issueId: issue.id, comment: { requestId, versionId, body: trimmed } })
  }

  // 이미 보내서 잠긴 댓글은 읽기 전용보다 앞선다. 지난 버전을 골라 봐도 다시 보내기와 취소가 남는다.
  if (!canWrite && !isLocked) {
    // 읽기 전용이면 댓글 칸을 감추지만 새 버전 안내("최신 버전 보기")는 남긴다. 최신 버전의 사진을 불러오지 못해도
    // 읽기 전용이 되는데, 그때 이 버튼까지 감추면 다시 불러올 길이 없다. 쓰던 댓글은 감춘 칸에 그대로 남아 있다.
    const versionChanged = error?.kind === 'conflict' && error.code === 'VERSION_CHANGED'
    return versionChanged ? <SubmitErrorText error={error} locked={false} onGoLatest={onGoLatest} /> : null
  }

  return (
    <form className={styles.commentForm} onSubmit={handleSubmit} noValidate>
      <label htmlFor={bodyId}>댓글</label>
      <textarea
        id={bodyId}
        rows={3}
        maxLength={COMMENT_MAX}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        // 잠긴 글은 고칠 수 없지만 읽고 복사할 수는 있게 disabled 대신 readOnly로 둔다.
        readOnly={sending || isLocked}
        aria-invalid={bodyError ? true : undefined}
      />
      {bodyError && <ErrorText message={bodyError} />}
      {error && <SubmitErrorText error={error} locked={isLocked} onGoLatest={onGoLatest} />}
      <div className={styles.actions}>
        {isLocked && (
          <Button variant="secondary" onClick={handleCancel} disabled={sending}>
            취소
          </Button>
        )}
        <Button type="submit" disabled={sending}>
          {isLocked ? '다시 보내기' : '댓글 남기기'}
        </Button>
      </div>
    </form>
  )
}

export const IssueDetail = ({
  issue,
  versionId,
  canWrite,
  isDeveloper,
  onChanged,
  onCommented,
  onRefresh,
  onDraftChange,
  onGoLatest,
  onClose,
}: IssueDetailProps) => (
  <article className={styles.detail} aria-label={`쪽지 #${issue.number}`}>
    <div className={styles.heading}>
      <span className={styles.number}>#{issue.number}</span>
      <StatusBadge status={issue.status} />
      <button type="button" className={styles.link} onClick={onClose}>
        쪽지 닫기
      </button>
    </div>
    <h2>{issue.title}</h2>
    <dl className={styles.meta}>
      <dt>처음 위치</dt>
      <dd>{originLabel(issue)}</dd>
      <dt>쓴 사람</dt>
      <dd>{issue.authorName}</dd>
      <dt>쓴 시각</dt>
      <dd>{timeFormat.format(new Date(issue.createdAt))}</dd>
    </dl>
    {/* 글은 일반 글자로만 보여 준다. 줄바꿈은 CSS(pre-wrap)가 살린다. */}
    {issue.body && <p className={styles.body}>{issue.body}</p>}
    <Actions
      issue={issue}
      versionId={versionId}
      canWrite={canWrite}
      isDeveloper={isDeveloper}
      onChanged={onChanged}
      onRefresh={onRefresh}
      onGoLatest={onGoLatest}
    />
    <section aria-label="댓글">
      <h3>댓글 {issue.comments.length}개</h3>
      <ul className={styles.comments}>
        {issue.comments.map((comment) => (
          <li key={comment.id}>
            <p className={styles.commentMeta}>
              <strong>{comment.authorName}</strong>
              <span>
                {versionLabel(comment.versionNumber)} · {timeFormat.format(new Date(comment.createdAt))}
              </span>
            </p>
            <p className={styles.body}>{comment.body}</p>
          </li>
        ))}
      </ul>
      <CommentForm
        issue={issue}
        versionId={versionId}
        canWrite={canWrite}
        onCommented={onCommented}
        onRefresh={onRefresh}
        onDraftChange={onDraftChange}
        onGoLatest={onGoLatest}
      />
    </section>
    {!canWrite && <p className={styles.readonly}>읽기 전용이에요. 쪽지와 댓글은 바꿀 수 없어요.</p>}
  </article>
)
