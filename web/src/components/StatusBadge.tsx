import { ISSUE_STATUS_LABELS, type IssueStatus } from '../api/issues.ts'
import styles from './StatusBadge.module.css'

// 쪽지 상태를 글자와 점으로 보여 준다. 색만으로 구분하지 않게 점 모양도 바뀐다:
// 접수는 빈 점, 수정 중은 채운 점, 확인 요청은 반만 채운 점, 확인 완료는 채운 네모, 철회는 가로줄.
// 상태가 늘면 글자는 ISSUE_STATUS_LABELS에, 점 모양은 CSS에 더한다.
export const StatusBadge = ({ status }: { status: IssueStatus }) => (
  <span className={styles.badge} data-status={status}>
    <span className={styles.dot} aria-hidden="true" />
    {ISSUE_STATUS_LABELS[status]}
  </span>
)
