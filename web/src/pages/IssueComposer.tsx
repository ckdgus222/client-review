import { type FormEvent, useEffect, useId, useState } from 'react'
import { createIssue, type IssueDetail, type NewIssue } from '../api/issues.ts'
import { Button } from '../components/Button.tsx'
import { TextField } from '../components/TextField.tsx'
import { useLockedSubmit } from '../hooks/useLockedSubmit.ts'
import styles from './IssueComposer.module.css'
import { SubmitErrorText } from './SubmitErrorText.tsx'

const TITLE_MAX = 120
const BODY_MAX = 4000

type IssueComposerProps = {
  projectId: string
  // 지금 보고 있는 버전(현재 버전). 보내는 순간의 값이 요청에 들어간다.
  versionId: string
  // 사진에서 고른 자리. 없으면 위치 없는 쪽지다. label은 "상품 상세 · PC" 같은 화면 이름이다.
  pin?: { screenId: string; xRatio: number; yRatio: number; label: string }
  onClearPin: () => void
  onCancel: () => void
  onCreated: (issue: IssueDetail) => void
  // 잠겼는지 알린다. 잠긴 동안 검수실은 화면·버전을 바꿔도 임시 핀을 지우지 않는다(기획 정할 것 12).
  onLockChange: (locked: boolean) => void
  onGoLatest: () => void
}

export const IssueComposer = ({
  projectId,
  versionId,
  pin,
  onClearPin,
  onCancel,
  onCreated,
  onLockChange,
  onGoLatest,
}: IssueComposerProps) => {
  const bodyId = useId()
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [titleError, setTitleError] = useState<string>()
  // 쓰기 칸을 열 때 한 번 만든다. 실패해서 다시 보내도 같은 번호라 쪽지가 하나만 생긴다.
  const [requestId] = useState(() => crypto.randomUUID())
  // 요청에 대상 프로젝트도 함께 담는다. 잠긴 뒤에는 처음 보낸 대상과 글이 그대로 다시 간다.
  const { sending, locked, error, submit, retry, cancel } = useLockedSubmit(
    (request: { projectId: string; issue: NewIssue }) => createIssue(request.projectId, request.issue),
    onCreated,
  )
  const isLocked = locked !== undefined

  useEffect(() => {
    onLockChange(isLocked)
  }, [isLocked, onLockChange])

  // 잠긴 동안에는 제목과 내용 칸을 고칠 수 없어서 화면의 글이 곧 처음 보낸 글이다.
  // 자리는 검수실이 바꿀 수 있는 값(pin)이라, 잠긴 동안에는 처음 보낸 요청의 것으로 본다.
  const hasPin = isLocked ? locked.issue.pin !== undefined : pin !== undefined

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()
    if (isLocked) {
      void retry()
      return
    }
    const trimmed = title.trim()
    if (trimmed.length < 1 || trimmed.length > TITLE_MAX) {
      setTitleError(`제목은 1~${TITLE_MAX}자로 써 주세요`)
      return
    }
    setTitleError(undefined)
    void submit({
      projectId,
      issue: {
        requestId,
        versionId,
        title: trimmed,
        body,
        pin: pin && { screenId: pin.screenId, xRatio: pin.xRatio, yRatio: pin.yRatio },
      },
    })
  }

  const handleCancel = () => {
    cancel()
    onCancel()
  }

  return (
    <form className={styles.composer} onSubmit={handleSubmit} noValidate>
      <h2>쪽지 쓰기</h2>
      {hasPin ? (
        <p className={styles.place}>
          {pin ? `${pin.label}의 선택한 위치에 쪽지를 남겨요.` : '선택한 위치에 쪽지를 남겨요.'}{' '}
          {!isLocked && (
            <button type="button" className={styles.link} onClick={onClearPin}>
              위치 없이 쓰기
            </button>
          )}
        </p>
      ) : (
        <p className={styles.place}>위치를 정하지 않은 쪽지예요. 사진을 누르면 그 자리에 남길 수 있어요.</p>
      )}
      <TextField
        label="제목 (필수)"
        value={title}
        onChange={setTitle}
        error={titleError}
        disabled={sending || isLocked}
      />
      <div className={styles.field}>
        <label htmlFor={bodyId}>내용</label>
        <textarea
          id={bodyId}
          rows={6}
          maxLength={BODY_MAX}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          // 잠긴 글은 고칠 수 없지만 읽고 복사할 수는 있게 disabled 대신 readOnly로 둔다.
          readOnly={sending || isLocked}
          aria-describedby={`${bodyId}-hint`}
        />
        <span className={styles.hint} id={`${bodyId}-hint`}>
          {BODY_MAX.toLocaleString('ko-KR')}자까지 쓸 수 있어요.
        </span>
      </div>
      {error && <SubmitErrorText error={error} locked={isLocked} onGoLatest={onGoLatest} />}
      <div className={styles.actions}>
        <Button variant="secondary" onClick={handleCancel} disabled={sending}>
          취소
        </Button>
        <Button type="submit" disabled={sending}>
          {isLocked ? '다시 보내기' : '쪽지 남기기'}
        </Button>
      </div>
    </form>
  )
}
