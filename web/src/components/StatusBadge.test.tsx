import { isInaccessible } from '@testing-library/dom'
import { render, screen } from '@testing-library/react'
import { ISSUE_STATUS_LABELS } from '../api/issues.ts'
import { StatusBadge } from './StatusBadge.tsx'
import styles from './StatusBadge.module.css'

describe('StatusBadge', () => {
  it.each([
    ['OPEN', '접수'],
    ['IN_PROGRESS', '수정 중'],
  ] as const)('%s는 %s 글자와 상태에 맞는 data-status를 보여 준다', (status, label) => {
    render(<StatusBadge status={status} />)

    const badge = screen.getByText(label)

    expect(badge.textContent).toBe(label)
    expect(badge.textContent).toBe(ISSUE_STATUS_LABELS[status])
    expect(badge.getAttribute('data-status')).toBe(status)
    expect(badge.classList.contains(styles.badge)).toBe(true)
    expect(isInaccessible(badge)).toBe(false)
  })

  it.each(['OPEN', 'IN_PROGRESS'] as const)('%s의 점은 aria-hidden으로 읽어 주지 않는다', (status) => {
    render(<StatusBadge status={status} />)

    const badge = screen.getByText(ISSUE_STATUS_LABELS[status])
    const dots = badge.getElementsByClassName(styles.dot)

    expect(dots).toHaveLength(1)
    expect(dots[0].getAttribute('aria-hidden')).toBe('true')
    expect(isInaccessible(dots[0])).toBe(true)
  })

  it('접수에서 수정 중으로 바뀌면 글자와 점 모양을 정하는 data-status가 함께 바뀐다', () => {
    const { rerender } = render(<StatusBadge status="OPEN" />)

    expect(screen.getByText('접수').getAttribute('data-status')).toBe('OPEN')

    rerender(<StatusBadge status="IN_PROGRESS" />)

    const badge = screen.getByText('수정 중')

    expect(screen.queryByText('접수')).toBeNull()
    expect(badge.textContent).toBe(ISSUE_STATUS_LABELS.IN_PROGRESS)
    expect(badge.getAttribute('data-status')).toBe('IN_PROGRESS')
    expect(badge.getElementsByClassName(styles.dot)).toHaveLength(1)
    expect(badge.getElementsByClassName(styles.dot)[0].getAttribute('aria-hidden')).toBe('true')
  })
})
