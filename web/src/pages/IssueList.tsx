import { type IssueStatus, type IssueSummary, originLabel } from '../api/issues.ts'
import { Button } from '../components/Button.tsx'
import { StatusBadge } from '../components/StatusBadge.tsx'
import styles from './IssueList.module.css'

// 아직 끝나지 않은 상태. 6번에서 확인 요청이 생기면 여기에 더하고, 확인 완료와 철회는 넣지 않는다.
const UNRESOLVED: IssueStatus[] = ['OPEN', 'IN_PROGRESS']

type IssueListProps = {
  // 서버가 준 순서(번호 큰 순) 그대로 보여 준다.
  issues: IssueSummary[]
  selectedId?: string
  onSelect: (issueId: string) => void
  // 없으면 쪽지 쓰기 버튼을 그리지 않는다(지난 버전이나 승인된 버전을 보는 중).
  onCompose?: () => void
}

export const IssueList = ({ issues, selectedId, onSelect, onCompose }: IssueListProps) => {
  const unresolved = issues.filter((issue) => UNRESOLVED.includes(issue.status)).length

  return (
    <section className={styles.list} aria-label="쪽지 목록">
      <div className={styles.heading}>
        <div>
          <h2>쪽지 {issues.length}개</h2>
          <span className={styles.hint}>미해결 {unresolved}개</span>
        </div>
        {onCompose && (
          <Button variant="secondary" onClick={onCompose}>
            쪽지 쓰기
          </Button>
        )}
      </div>
      {issues.length === 0 ? (
        <p className={styles.empty}>
          아직 쪽지가 없어요.{onCompose && ' 사진에서 고칠 곳을 눌러 첫 쪽지를 남겨 주세요.'}
        </p>
      ) : (
        <ul className={styles.rows}>
          {issues.map((issue) => (
            <li key={issue.id}>
              <button type="button" aria-pressed={issue.id === selectedId} onClick={() => onSelect(issue.id)}>
                <span className={styles.number}>#{issue.number}</span>
                <span className={styles.title}>{issue.title}</span>
                <StatusBadge status={issue.status} />
                <span className={styles.hint}>
                  {originLabel(issue)} · 댓글 {issue.commentCount}개
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
