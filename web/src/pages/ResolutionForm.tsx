import { type FormEvent, useId, useState } from 'react'
import { type IssueDetail as Issue, submitResolution } from '../api/issues.ts'
import { screenLabel, type Viewport } from '../api/projects.ts'
import { Button } from '../components/Button.tsx'
import { ErrorText } from '../components/ErrorText.tsx'
import { useIssueRequest } from '../hooks/useIssueRequest.ts'
import { IssueRequestNotice } from './IssueRequestNotice.tsx'
import styles from './ResolutionForm.module.css'

// 서버의 한도와 같다(고쳤어요 설명 2,000자). 바꾸면 서버도 함께 바꾼다.
const SUMMARY_MAX = 2000

export type ResolutionScreen = { screenId: string; name: string; viewport: Viewport }

type ResolutionFormProps = {
  issue: Issue
  // 지금 보고 있는 버전. 요청에 들어간다.
  versionId: string
  // 고른 버전이 현재 버전이고 검수 중인가. 아니면 입력을 그리지 않는다.
  canWrite: boolean
  isDeveloper: boolean
  // 지금 보고 있는 버전의 화면들. 고친 결과를 볼 수 있는 화면을 여기서 고른다.
  screens: ResolutionScreen[]
  // 검수실이 이 쪽지의 상세를 서버에서 새로 받아 화면에 쓴 횟수(useIssueRequest 참고).
  fetchCount: number
  // 서버가 돌려준 바뀐 쪽지(확인 요청 상태와 새 고쳤어요 줄이 들어 있다).
  onChanged: (issue: Issue) => void
  onRefresh: () => void
  onGoLatest: () => void
}

// 개발자가 "고쳤어요"를 보내는 칸. 어느 화면에서 볼 수 있는지와 무엇을 고쳤는지 적는다.
// 쓸 수 없는 동안에도 이 부품은 화면에 남고 입력만 그리지 않는다. 그래야 쓰던 설명이 15초 새로 불러오기나
// 버전을 옮겨 다닌 뒤에도 남는다. 저장하거나 쪽지를 닫으면 사라진다.
export const ResolutionForm = ({
  issue,
  versionId,
  canWrite,
  isDeveloper,
  screens,
  fetchCount,
  onChanged,
  onRefresh,
  onGoLatest,
}: ResolutionFormProps) => {
  const screenFieldId = useId()
  const summaryFieldId = useId()
  const [summary, setSummary] = useState('')
  // 고른 화면. 고르지 않았으면(undefined) 쪽지가 시작한 화면을 보여 준다.
  const [screenChoice, setScreenChoice] = useState<string>()
  const [fieldError, setFieldError] = useState<{ field: 'screen' | 'summary'; message: string }>()
  const { sending, error, unconfirmed, stale, send } = useIssueRequest({ fetchCount, onChanged, onRefresh })

  if (!isDeveloper) return null

  const notice = <IssueRequestNotice error={error} unconfirmed={unconfirmed} stale={stale} onGoLatest={onGoLatest} />
  // 고쳤어요는 접수나 수정 중인 쪽지에만 보낸다(서버도 같은 규칙으로 막는다).
  const canSubmit = canWrite && (issue.status === 'OPEN' || issue.status === 'IN_PROGRESS')
  // 입력을 감춰도 안내는 남긴다. 새 버전 안내의 "최신 버전 보기"까지 감추면 다시 불러올 길이 없다.
  if (!canSubmit) return notice

  // 핀이 있는 쪽지는 화면을 꼭 골라야 한다. 그래야 처음 사진과 고친 사진을 나란히 볼 수 있다.
  const isPinned = issue.origin !== null
  const wantedScreenId = screenChoice ?? issue.origin?.screenId ?? ''
  // 고른 화면(또는 쪽지가 시작한 화면)이 지금 버전에 없으면 고르지 않은 것으로 본다.
  const screenId = screens.some((screen) => screen.screenId === wantedScreenId) ? wantedScreenId : ''

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    const trimmed = summary.trim()
    if (isPinned && screenId === '') {
      setFieldError({ field: 'screen', message: '고친 화면을 골라 주세요' })
      return
    }
    if (trimmed.length < 1 || trimmed.length > SUMMARY_MAX) {
      const message = `고친 내용은 1~${SUMMARY_MAX.toLocaleString('ko-KR')}자로 써 주세요`
      setFieldError({ field: 'summary', message })
      return
    }
    setFieldError(undefined)
    // 화면 없음('')은 보내지 않는다. undefined인 칸은 요청 본문에서 빠진다.
    const resolution = { versionId, summary: trimmed, screenId: screenId || undefined }
    const saved = await send(() => submitResolution(issue.id, resolution))
    if (!saved) return
    setSummary('')
    setScreenChoice(undefined)
  }

  return (
    <form
      className={styles.form}
      aria-label="고쳤어요 보내기"
      onSubmit={(event) => void handleSubmit(event)}
      noValidate
    >
      <div className={styles.field}>
        <label htmlFor={screenFieldId}>고친 화면</label>
        <select
          id={screenFieldId}
          value={screenId}
          onChange={(event) => setScreenChoice(event.target.value)}
          disabled={sending}
          aria-invalid={fieldError?.field === 'screen' ? true : undefined}
        >
          <option value="">{isPinned ? '화면을 골라 주세요' : '화면 없음'}</option>
          {screens.map((screen) => (
            <option key={screen.screenId} value={screen.screenId}>
              {screenLabel(screen)}
            </option>
          ))}
        </select>
      </div>
      <div className={styles.field}>
        <label htmlFor={summaryFieldId}>고친 내용</label>
        <textarea
          id={summaryFieldId}
          rows={3}
          maxLength={SUMMARY_MAX}
          value={summary}
          onChange={(event) => setSummary(event.target.value)}
          // 보내는 동안에도 읽고 복사할 수는 있게 disabled 대신 readOnly로 둔다.
          readOnly={sending}
          aria-invalid={fieldError?.field === 'summary' ? true : undefined}
        />
      </div>
      {fieldError && <ErrorText message={fieldError.message} />}
      {notice}
      <div className={styles.actions}>
        <Button type="submit" disabled={sending}>
          고쳤어요 보내기
        </Button>
      </div>
    </form>
  )
}
