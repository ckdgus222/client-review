import { useId, useState } from 'react'
import {
  countFilters,
  ISSUE_CATEGORY_LABELS,
  ISSUE_SCOPE_LABELS,
  ISSUE_STATUS_LABELS,
  type IssueFilter,
  type IssueSummary,
  NO_PLACE,
} from '../api/issues.ts'
import { screenLabel } from '../api/projects.ts'
import styles from './IssueFilters.module.css'

// 화면 선택지는 쪽지 목록에서 만든다. 쪽지가 하나도 없는 화면은 골라도 빈 목록이라 넣지 않는다.
const screenOptions = (issues: IssueSummary[]) => {
  const labels = new Map<string, string>()
  for (const { origin } of issues) {
    if (origin) labels.set(origin.screenId, screenLabel({ name: origin.screenName, viewport: origin.viewport }))
  }
  return [...labels]
}

// 글자 테이블(값 → 이름)로 선택지를 만든다. 상태·분류·범위가 같이 쓴다.
const labelOptions = (labels: Record<string, string>) =>
  Object.entries(labels).map(([value, label]) => (
    <option key={value} value={value}>
      {label}
    </option>
  ))

type IssueFiltersProps = {
  // 거르기 전의 전체 목록. 화면 선택지를 만드는 데 쓴다.
  issues: IssueSummary[]
  filter: IssueFilter
  onChange: (filter: IssueFilter) => void
}

// 쪽지 목록을 골라 보는 조건. 고른 값은 부모(쪽지 목록)가 들고 있어서, 목록이 새로 와도 남는다.
export const IssueFilters = ({ issues, filter, onChange }: IssueFiltersProps) => {
  const fieldsId = useId()
  // 좁은 화면에서만 쓴다. 넓은 화면에서는 CSS가 조건을 늘 펴 두고 이 버튼을 감춘다.
  const [expanded, setExpanded] = useState(false)
  const count = countFilters(filter)
  const change = (changed: Partial<IssueFilter>) => onChange({ ...filter, ...changed })

  return (
    <div className={styles.filters}>
      <button
        type="button"
        className={styles.toggle}
        aria-expanded={expanded}
        aria-controls={fieldsId}
        onClick={() => setExpanded(!expanded)}
      >
        {/* 접힌 채로도 조건을 골랐다는 것이 보이게 고른 개수를 붙인다. */}
        {count > 0 ? `필터 ${count}` : '필터'}
      </button>
      <div id={fieldsId} className={styles.fields} data-expanded={expanded}>
        <label>
          상태
          <select
            value={filter.status}
            onChange={(event) => change({ status: event.target.value as IssueFilter['status'] })}
          >
            <option value="">전체</option>
            {labelOptions(ISSUE_STATUS_LABELS)}
          </select>
        </label>
        <label>
          화면
          <select value={filter.screenId} onChange={(event) => change({ screenId: event.target.value })}>
            <option value="">전체</option>
            {screenOptions(issues).map(([screenId, label]) => (
              <option key={screenId} value={screenId}>
                {label}
              </option>
            ))}
            <option value={NO_PLACE}>위치 없음</option>
          </select>
        </label>
        <label>
          분류
          <select
            value={filter.category}
            onChange={(event) => change({ category: event.target.value as IssueFilter['category'] })}
          >
            <option value="">전체</option>
            {labelOptions(ISSUE_CATEGORY_LABELS)}
          </select>
        </label>
        <label>
          범위
          <select
            value={filter.scope}
            onChange={(event) => change({ scope: event.target.value as IssueFilter['scope'] })}
          >
            <option value="">전체</option>
            {labelOptions(ISSUE_SCOPE_LABELS)}
          </select>
        </label>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={filter.overdueOnly}
            onChange={(event) => change({ overdueOnly: event.target.checked })}
          />
          마감 지남만
        </label>
      </div>
    </div>
  )
}
