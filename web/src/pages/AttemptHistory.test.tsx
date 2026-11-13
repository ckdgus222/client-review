import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { IssueAttempt } from '../api/issues.ts'
import { timeFormat } from '../api/versions.ts'
import { AttemptHistory } from './AttemptHistory.tsx'

const firstAttempt: IssueAttempt = {
  id: 'attempt-1',
  versionId: 'version-0',
  versionNumber: 0,
  screen: {
    screenId: 'screen-1',
    screenName: '상품 상세',
    viewport: 'PC',
    asset: { id: 'asset-1', width: 1200, height: 800 },
  },
  summary: '첫 번째 수정',
  submittedByName: '첫 개발자',
  createdAt: '2026-11-10T01:00:00.000Z',
  result: 'REOPENED',
  reviewedByName: '클라이언트',
  reviewedAt: '2026-11-10T02:00:00.000Z',
}
const secondAttempt: IssueAttempt = {
  id: 'attempt-2',
  versionId: 'version-2',
  versionNumber: 2,
  screen: {
    screenId: 'screen-2',
    screenName: '결제',
    viewport: 'MOBILE',
    asset: { id: 'asset-2', width: 390, height: 844 },
  },
  summary: '두 번째 수정',
  submittedByName: '다음 개발자',
  createdAt: '2026-11-11T03:00:00.000Z',
  result: 'VERIFIED',
  reviewedByName: '승인자',
  reviewedAt: '2026-11-11T04:00:00.000Z',
}
const latestAttempt: IssueAttempt = {
  ...secondAttempt,
  id: 'attempt-3',
  summary: '답을 기다리는 수정',
  createdAt: '2026-11-12T05:00:00.000Z',
  result: null,
  reviewedByName: null,
  reviewedAt: null,
}

describe('AttemptHistory', () => {
  it('확인 요청 쪽지의 결과 없는 한 줄은 확인 대기 중으로 보인다', () => {
    render(<AttemptHistory issueId="issue-1" attempts={[latestAttempt]} isReadyForReview={true} />, {
      wrapper: MemoryRouter,
    })

    expect(screen.getByText('결과: 확인 대기 중')).toBeTruthy()
    expect(screen.queryByText('결과: 결과 없음')).toBeNull()
  })

  it('확인 요청 쪽지에 결과 없는 줄이 여러 개면 가장 최근 줄만 확인 대기 중으로 보인다', () => {
    const previous = {
      ...firstAttempt,
      result: null,
      reviewedByName: null,
      reviewedAt: null,
    }
    render(<AttemptHistory issueId="issue-1" attempts={[previous, latestAttempt]} isReadyForReview={true} />, {
      wrapper: MemoryRouter,
    })

    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(within(rows[0]).getByText('결과: 결과 없음')).toBeTruthy()
    expect(within(rows[1]).getByText('결과: 확인 대기 중')).toBeTruthy()
    expect(screen.getAllByText('결과: 확인 대기 중')).toHaveLength(1)
  })

  it('확인 요청 상태가 아니면 가장 최근 결과 없는 줄도 결과 없음으로 보인다', () => {
    render(<AttemptHistory issueId="issue-1" attempts={[latestAttempt]} isReadyForReview={false} />, {
      wrapper: MemoryRouter,
    })

    expect(screen.getByText('결과: 결과 없음')).toBeTruthy()
    expect(screen.queryByText('결과: 확인 대기 중')).toBeNull()
  })

  it.each([true, false])(
    'isReadyForReview=%s여도 저장된 확인 완료·재요청 결과와 사람·시각을 보여 준다',
    (isReadyForReview) => {
      const { rerender } = render(
        <AttemptHistory issueId="issue-1" attempts={[secondAttempt]} isReadyForReview={isReadyForReview} />,
        { wrapper: MemoryRouter },
      )

      expect(
        screen.getByText(`결과: 확인 완료 · 승인자 · ${timeFormat.format(new Date(secondAttempt.reviewedAt!))}`),
      ).toBeTruthy()
      expect(screen.queryByText(/결과: (확인 대기 중|결과 없음)/)).toBeNull()

      rerender(<AttemptHistory issueId="issue-1" attempts={[firstAttempt]} isReadyForReview={isReadyForReview} />)

      expect(
        screen.getByText(`결과: 재요청 · 클라이언트 · ${timeFormat.format(new Date(firstAttempt.reviewedAt!))}`),
      ).toBeTruthy()
      expect(screen.queryByText(/결과: (확인 대기 중|결과 없음)/)).toBeNull()
    },
  )

  it('이력이 없으면 제목과 영역을 포함해 아무것도 그리지 않는다', () => {
    const { container } = render(<AttemptHistory isReadyForReview={true} issueId="issue-1" attempts={[]} />, {
      wrapper: MemoryRouter,
    })

    expect(container.innerHTML).toBe('')
  })

  it('이력 개수와 모든 줄의 보낸 사람·버전·시각·화면·설명·결과를 받은 순서대로 보여 준다', () => {
    const attempts = [firstAttempt, secondAttempt, { ...latestAttempt, screen: null }]
    render(<AttemptHistory isReadyForReview={true} issueId="issue-1" attempts={attempts} />, { wrapper: MemoryRouter })

    const history = within(screen.getByRole('region', { name: '고쳤어요 이력' }))
    expect(history.getByRole('heading', { name: '고쳤어요 3번' })).toBeTruthy()
    const rows = within(history.getByRole('list')).getAllByRole('listitem')
    expect(rows).toHaveLength(3)
    const versions = ['초안', '2차', '2차']
    const screens = ['화면: 상품 상세 · PC', '화면: 결제 · 모바일', '화면: 없음']
    const results = [
      `결과: 재요청 · 클라이언트 · ${timeFormat.format(new Date(firstAttempt.reviewedAt!))}`,
      `결과: 확인 완료 · 승인자 · ${timeFormat.format(new Date(secondAttempt.reviewedAt!))}`,
      '결과: 확인 대기 중',
    ]
    attempts.forEach((attempt, index) => {
      const row = within(rows[index])
      expect(row.getByText(attempt.submittedByName)).toBeTruthy()
      expect(row.getByText(`${versions[index]} · ${timeFormat.format(new Date(attempt.createdAt))}`)).toBeTruthy()
      expect(row.getByText(screens[index])).toBeTruthy()
      expect(row.getByText(attempt.summary)).toBeTruthy()
      expect(row.getByText(results[index])).toBeTruthy()
    })
  })

  it('줄바꿈과 HTML처럼 생긴 설명을 원래 글자로 보여 주고 HTML 요소를 만들지 않는다', () => {
    const summary = '첫째 줄\n<strong>고친 내용</strong>\n<img src="missing" onerror="alert(1)">'
    const { container } = render(
      <AttemptHistory isReadyForReview={true} issueId="issue-1" attempts={[{ ...latestAttempt, summary }]} />,
      {
        wrapper: MemoryRouter,
      },
    )

    const text = screen.getByText(summary, { normalizer: (value) => value })
    expect(text.textContent).toBe(summary)
    expect(text.childElementCount).toBe(0)
    expect(container.querySelector('img')).toBeNull()
  })

  it.each([
    ['결과 없음', latestAttempt],
    ['확인 완료', secondAttempt],
    ['재요청', firstAttempt],
  ] as const)('가장 최근 줄의 결과가 %s여도 화면이 있으면 그 줄에만 비교 링크를 둔다', (_, latest) => {
    render(
      <AttemptHistory
        isReadyForReview={true}
        issueId="issue-42"
        attempts={[{ ...firstAttempt, id: 'older' }, latest]}
      />,
      {
        wrapper: MemoryRouter,
      },
    )

    const rows = screen.getAllByRole('listitem')
    expect(within(rows[0]).queryByRole('link')).toBeNull()
    const link = within(rows[1]).getByRole('link', { name: '비교해서 보기' })
    expect(link.getAttribute('href')).toBe('/issues/issue-42/compare')
    expect(screen.getAllByRole('link')).toHaveLength(1)
  })

  it('가장 최근 줄에 화면이 없으면 지난 줄에 화면이 있어도 비교 링크가 없다', () => {
    render(
      <AttemptHistory
        isReadyForReview={true}
        issueId="issue-1"
        attempts={[firstAttempt, { ...latestAttempt, screen: null }]}
      />,
      {
        wrapper: MemoryRouter,
      },
    )

    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByText('화면: 없음')).toBeTruthy()
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('한 줄만 있어도 화면이 있으면 비교할 수 있다', () => {
    render(<AttemptHistory isReadyForReview={true} issueId="issue-7" attempts={[latestAttempt]} />, {
      wrapper: MemoryRouter,
    })

    expect(screen.getByRole('heading', { name: '고쳤어요 1번' })).toBeTruthy()
    expect(screen.getByRole('link', { name: '비교해서 보기' }).getAttribute('href')).toBe('/issues/issue-7/compare')
  })

  it('새 이력을 받으면 지난 결과를 남기고 개수와 비교 링크를 가장 최근 줄에 맞춘다', () => {
    const { rerender } = render(
      <AttemptHistory isReadyForReview={true} issueId="issue-1" attempts={[firstAttempt]} />,
      {
        wrapper: MemoryRouter,
      },
    )
    const previousText = screen.getByText(/^결과: 재요청/).textContent

    rerender(<AttemptHistory isReadyForReview={true} issueId="issue-1" attempts={[firstAttempt, latestAttempt]} />)

    expect(screen.getByRole('heading', { name: '고쳤어요 2번' })).toBeTruthy()
    const rows = screen.getAllByRole('listitem')
    expect(within(rows[0]).getByText(previousText!)).toBeTruthy()
    expect(within(rows[0]).queryByRole('link')).toBeNull()
    expect(within(rows[1]).getByRole('link', { name: '비교해서 보기' })).toBeTruthy()
    expect(within(rows[1]).getByText('결과: 확인 대기 중')).toBeTruthy()
  })
})
