import {
  countFilters,
  dueDateLabel,
  filterIssues,
  ISSUE_CATEGORY_LABELS,
  ISSUE_SCOPE_LABELS,
  type IssueFilter,
  type IssueSummary,
  isOverdue,
  isUnresolved,
  NO_FILTER,
  originLabel,
} from '../api/issues.ts'
import { Button } from '../components/Button.tsx'
import { StatusBadge } from '../components/StatusBadge.tsx'
import { IssueFilters } from './IssueFilters.tsx'
import styles from './IssueList.module.css'

type IssueListProps = {
  // 서버가 준 순서(번호 큰 순) 그대로 보여 준다.
  issues: IssueSummary[]
  // 고른 필터. 검수실이 들고 있다. 쪽지 쓰기 칸이 열리면 이 목록은 화면에서 빠지는데, 그때도 고른 조건이 남아야 한다.
  filter: IssueFilter
  onFilterChange: (filter: IssueFilter) => void
  selectedId?: string
  onSelect: (issueId: string) => void
  // 없으면 쪽지 쓰기 버튼을 그리지 않는다(지난 버전이나 승인된 버전을 보는 중).
  onCompose?: () => void
}

// 줄에 붙이는 꼬리표. 분류는 늘, 범위는 추가 요청일 때만, 마감일은 정해졌을 때만 붙인다.
const tagLine = (issue: IssueSummary) => {
  const tags = [ISSUE_CATEGORY_LABELS[issue.category]]
  if (issue.scope === 'OUT_OF_SCOPE') tags.push(ISSUE_SCOPE_LABELS.OUT_OF_SCOPE)
  if (issue.dueDate) tags.push(`마감 ${dueDateLabel(issue.dueDate)}`)
  return tags.join(' · ')
}

export const IssueList = ({ issues, filter, onFilterChange, selectedId, onSelect, onCompose }: IssueListProps) => {
  const shown = filterIssues(issues, filter)
  const isFiltering = countFilters(filter) > 0
  const unresolved = issues.filter((issue) => isUnresolved(issue.status)).length

  const renderRows = () => {
    if (issues.length === 0) {
      return (
        <p className={styles.empty}>
          아직 쪽지가 없어요.{onCompose && ' 사진에서 고칠 곳을 눌러 첫 쪽지를 남겨 주세요.'}
        </p>
      )
    }
    if (shown.length === 0) return <p className={styles.empty}>조건에 맞는 쪽지가 없어요</p>
    return (
      <ul className={styles.rows}>
        {shown.map((issue) => (
          <li key={issue.id}>
            <button type="button" aria-pressed={issue.id === selectedId} onClick={() => onSelect(issue.id)}>
              <span className={styles.number}>#{issue.number}</span>
              <span className={styles.title}>{issue.title}</span>
              <StatusBadge status={issue.status} />
              <span className={styles.hint}>
                {tagLine(issue)}
                {isOverdue(issue) && <strong className={styles.overdue}> · 마감 지남</strong>}
              </span>
              <span className={styles.hint}>
                {originLabel(issue)} · 댓글 {issue.commentCount}개
              </span>
            </button>
          </li>
        ))}
      </ul>
    )
  }

  return (
    <section className={styles.list} aria-label="쪽지 목록">
      <div className={styles.heading}>
        <div>
          <h2>{isFiltering ? `쪽지 ${shown.length}개 / 전체 ${issues.length}개` : `쪽지 ${issues.length}개`}</h2>
          <span className={styles.hint}>미해결 {unresolved}개</span>
          {isFiltering && (
            <button type="button" className={styles.link} onClick={() => onFilterChange(NO_FILTER)}>
              필터 지우기
            </button>
          )}
        </div>
        {onCompose && (
          <Button variant="secondary" onClick={onCompose}>
            쪽지 쓰기
          </Button>
        )}
      </div>
      {issues.length > 0 && <IssueFilters issues={issues} filter={filter} onChange={onFilterChange} />}
      {renderRows()}
    </section>
  )
}
