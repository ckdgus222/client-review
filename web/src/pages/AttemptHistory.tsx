import { Link } from 'react-router'
import { type IssueAttempt, RESOLUTION_RESULT_LABELS } from '../api/issues.ts'
import { screenLabel } from '../api/projects.ts'
import { timeFormat, versionLabel } from '../api/versions.ts'
import styles from './AttemptHistory.module.css'

type AttemptHistoryProps = {
  issueId: string
  // 오래된 순.
  attempts: IssueAttempt[]
}

// 결과와, 답한 사람·시각. 새 버전 게시나 철회로 답을 받지 못한 줄과 아직 답을 기다리는 줄은 "결과 없음"이다.
const resultText = ({ result, reviewedByName, reviewedAt }: IssueAttempt) => {
  if (result === null || reviewedByName === null || reviewedAt === null) return '결과 없음'
  return `${RESOLUTION_RESULT_LABELS[result]} · ${reviewedByName} · ${timeFormat.format(new Date(reviewedAt))}`
}

// 쪽지의 고쳤어요 이력. 지난 줄도 지우지 않고 오래된 순으로 모두 보여 준다.
export const AttemptHistory = ({ issueId, attempts }: AttemptHistoryProps) => {
  if (attempts.length === 0) return null
  const latest = attempts[attempts.length - 1]

  return (
    <section aria-label="고쳤어요 이력">
      <h3>고쳤어요 {attempts.length}번</h3>
      <ol className={styles.attempts}>
        {attempts.map((attempt) => (
          <li key={attempt.id}>
            <p className={styles.meta}>
              <strong>{attempt.submittedByName}</strong>
              <span>
                {versionLabel(attempt.versionNumber)} · {timeFormat.format(new Date(attempt.createdAt))}
              </span>
            </p>
            <p>
              화면:{' '}
              {attempt.screen
                ? screenLabel({ name: attempt.screen.screenName, viewport: attempt.screen.viewport })
                : '없음'}
            </p>
            {/* 글은 일반 글자로만 보여 준다. 줄바꿈은 CSS(pre-wrap)가 살린다. */}
            <p className={styles.summary}>{attempt.summary}</p>
            <p className={styles.result}>결과: {resultText(attempt)}</p>
            {/* 비교 화면은 가장 최근 고쳤어요의 사진만 보여 줘서, 링크도 그 줄에만 둔다. */}
            {attempt === latest && attempt.screen && <Link to={`/issues/${issueId}/compare`}>비교해서 보기</Link>}
          </li>
        ))}
      </ol>
    </section>
  )
}
