import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { StrictMode } from 'react'
import { Link, MemoryRouter, Route, Routes } from 'react-router'
import { getMe, type Me } from '../api/auth.ts'
import { ApiError } from '../api/client.ts'
import { getIssue, type IssueDetail as Issue, reopenIssue, verifyIssue, withdrawIssue } from '../api/issues.ts'
import { ComparePage } from './ComparePage.tsx'

vi.mock('../api/auth.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/auth.ts')>()),
  getMe: vi.fn(),
}))

vi.mock('../api/issues.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/issues.ts')>()),
  getIssue: vi.fn(),
  verifyIssue: vi.fn(),
  reopenIssue: vi.fn(),
  withdrawIssue: vi.fn(),
}))

const user: Me = {
  id: '5b3a934d-ef8e-4ce8-b26a-a9d1cdd4983f',
  email: 'reader@example.com',
  name: '김수정',
  canCreateProjects: false,
}
const latestAttempt: Issue['attempts'][number] = {
  id: '44444444-4444-4444-8444-444444444444',
  versionId: '33333333-3333-4333-8333-333333333333',
  versionNumber: 3,
  screen: {
    screenId: 'fixed-screen',
    screenName: '고친 주문 화면',
    viewport: 'MOBILE',
    asset: { id: 'fixed-photo', width: 390, height: 844 },
  },
  summary: '주문 버튼을 오른쪽으로 옮겼어요',
  submittedByName: '개발자',
  createdAt: '2026-11-12T01:00:00.000Z',
  result: null,
  reviewedByName: null,
  reviewedAt: null,
}
const olderAttempt: Issue['attempts'][number] = {
  ...latestAttempt,
  id: '55555555-5555-4555-8555-555555555555',
  versionId: '22222222-2222-4222-8222-222222222222',
  versionNumber: 2,
  screen: { ...latestAttempt.screen!, asset: { id: 'older-fixed-photo', width: 360, height: 800 } },
  summary: '이전에 고친 설명',
  createdAt: '2026-11-11T01:00:00.000Z',
  result: 'REOPENED',
  reviewedByName: '김수정',
  reviewedAt: '2026-11-11T02:00:00.000Z',
}
const issue: Issue = {
  currentVersion: { id: latestAttempt.versionId, status: 'IN_REVIEW' },
  id: '11111111-1111-4111-8111-111111111111',
  projectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  number: 14,
  title: '주문 버튼을 옮겨 주세요',
  body: '오른쪽으로 옮겨 주세요',
  status: 'READY_FOR_REVIEW',
  category: 'BUG',
  scope: 'IN_SCOPE',
  dueDate: null,
  authorName: '김수정',
  createdAt: '2026-11-10T00:00:00.000Z',
  commentCount: 0,
  originVersion: { id: '66666666-6666-4666-8666-666666666666', number: 1 },
  origin: {
    screenId: 'origin-screen',
    screenName: '처음 주문 화면',
    viewport: 'PC',
    asset: { id: 'origin-photo', width: 1440, height: 900 },
    xRatio: 0.25,
    yRatio: 0.75,
  },
  isMine: true,
  canReview: true,
  attempts: [olderAttempt, latestAttempt],
  attachments: [],
  comments: [],
}
const otherIssue: Issue = {
  ...issue,
  id: '77777777-7777-4777-8777-777777777777',
  projectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  number: 27,
  title: '다른 쪽지 제목',
  status: 'IN_PROGRESS',
  attempts: [{ ...latestAttempt, summary: '다른 쪽지의 고친 설명' }],
}
const roomUrl = `/projects/${issue.projectId}?issue=${issue.id}`
const unconfirmedMessage = '저장됐는지 확인하지 못했어요. 쪽지에 바뀐 내용이 보이지 않으면 다시 보내 주세요.'
const staleMessage = '쪽지 상태가 바뀌었어요. 새로 불러왔어요.'

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

const renderCompare = (id = issue.id, strictMode = false) =>
  render(
    <MemoryRouter initialEntries={[`/issues/${id}/compare`]}>
      <Link to={`/issues/${otherIssue.id}/compare`}>다른 쪽지 비교</Link>
      <Routes>
        <Route path="/issues/:id/compare" element={<ComparePage />} />
        <Route path="/login" element={<h1>로그인 화면</h1>} />
      </Routes>
    </MemoryRouter>,
    { wrapper: strictMode ? StrictMode : undefined },
  )

const sendReview = (action: string) => {
  fireEvent.click(screen.getByRole('button', { name: action }))
  if (action !== '재요청') return
  fireEvent.change(screen.getByRole('textbox', { name: '재요청 사유' }), {
    target: { value: '아직 버튼이 겹쳐요' },
  })
  fireEvent.click(screen.getByRole('button', { name: '재요청 보내기' }))
}

beforeEach(() => {
  vi.mocked(getMe).mockReset().mockResolvedValue(user)
  vi.mocked(getIssue).mockReset().mockResolvedValue(issue)
  vi.mocked(verifyIssue).mockReset()
  vi.mocked(reopenIssue).mockReset()
  vi.mocked(withdrawIssue).mockReset()
})

afterEach(() => vi.useRealTimers())

describe('ComparePage 불러오기', () => {
  it.each(['성공', '404'] as const)(
    'StrictMode의 두 번째 조회가 먼저 끝나면 첫 조회의 늦은 %s 응답을 버린다',
    async (result) => {
      const firstLoad = deferred<Issue>()
      const secondLoad = deferred<Issue>()
      const newerAttempt = { ...latestAttempt, summary: '두 번째 조회에서 받은 새 설명' }
      const newerIssue: Issue = {
        ...issue,
        title: '두 번째 조회에서 받은 제목',
        attempts: [olderAttempt, newerAttempt],
      }
      vi.mocked(getIssue).mockReturnValueOnce(firstLoad.promise).mockReturnValueOnce(secondLoad.promise)
      renderCompare(issue.id, true)
      expect(getIssue).toHaveBeenCalledTimes(2)

      await act(async () => secondLoad.resolve(newerIssue))
      expect(screen.getByRole('heading', { name: '#14 두 번째 조회에서 받은 제목' })).toBeDefined()
      expect(screen.getByText(newerAttempt.summary, { exact: false })).toBeDefined()
      await act(async () => {
        if (result === '404') return firstLoad.reject(new ApiError(404))
        firstLoad.resolve(issue)
      })

      expect(screen.getByRole('heading', { name: '#14 두 번째 조회에서 받은 제목' })).toBeDefined()
      expect(screen.getByText(newerAttempt.summary, { exact: false })).toBeDefined()
      expect(screen.queryByText(latestAttempt.summary, { exact: false })).toBeNull()
      expect(screen.queryByRole('heading', { name: '없는 쪽지예요' })).toBeNull()
      expect(vi.mocked(getIssue).mock.calls).toEqual([[issue.id], [issue.id]])
    },
  )

  it('StrictMode에서도 확인 완료는 한 번만 보내고 저장 응답과 후속 조회를 화면에 쓴다', async () => {
    const firstLoad = deferred<Issue>()
    const secondLoad = deferred<Issue>()
    const verification = deferred<Issue>()
    const refreshed = deferred<Issue>()
    const verified: Issue = { ...issue, status: 'VERIFIED', title: '확인 완료 응답의 제목' }
    vi.mocked(getIssue)
      .mockReturnValueOnce(firstLoad.promise)
      .mockReturnValueOnce(secondLoad.promise)
      .mockReturnValueOnce(refreshed.promise)
    vi.mocked(verifyIssue).mockReturnValueOnce(verification.promise)
    renderCompare(issue.id, true)
    expect(getIssue).toHaveBeenCalledTimes(2)
    await act(async () => secondLoad.resolve(issue))
    fireEvent.click(screen.getByRole('button', { name: '확인 완료' }))

    expect(verifyIssue).toHaveBeenCalledExactlyOnceWith(issue.id, {
      versionId: latestAttempt.versionId,
      attemptId: latestAttempt.id,
    })
    await act(async () => verification.resolve(verified))
    expect(screen.getByText('확인 완료').getAttribute('data-status')).toBe('VERIFIED')
    expect(screen.getByRole('heading', { name: '#14 확인 완료 응답의 제목' })).toBeDefined()
    expect(screen.queryByRole('button', { name: '확인 완료' })).toBeNull()
    expect(getIssue).toHaveBeenCalledTimes(3)

    await act(async () => firstLoad.resolve(issue))
    expect(screen.getByRole('heading', { name: '#14 확인 완료 응답의 제목' })).toBeDefined()
    await act(async () => refreshed.resolve({ ...verified, title: '확인 완료 뒤 조회한 제목' }))
    expect(screen.getByRole('heading', { name: '#14 확인 완료 뒤 조회한 제목' })).toBeDefined()
    expect(screen.getByText('확인 완료').getAttribute('data-status')).toBe('VERIFIED')
    expect(verifyIssue).toHaveBeenCalledTimes(1)
    expect(vi.mocked(getIssue).mock.calls).toEqual([[issue.id], [issue.id], [issue.id]])
  })

  it('주소의 id로 한 번 불러오고 응답을 기다리는 동안 안내를 보인다', async () => {
    const pending = deferred<Issue>()
    vi.mocked(getIssue).mockReturnValueOnce(pending.promise)
    renderCompare()

    expect(await screen.findByText('불러오는 중이에요.')).toBeDefined()
    expect(getIssue).toHaveBeenCalledExactlyOnceWith(issue.id)
    expect(screen.queryByRole('img')).toBeNull()
    await act(async () => pending.resolve(issue))
    expect(screen.getByRole('heading', { name: '#14 주문 버튼을 옮겨 주세요' })).toBeDefined()
    expect(screen.queryByText('불러오는 중이에요.')).toBeNull()
  })

  it.each(['not-a-uuid', '11111111-1111-4111-8111-11111111111z'])(
    'UUID가 아닌 %s는 쪽지 API를 부르지 않고 없는 쪽지와 목록 링크를 보인다',
    async (id) => {
      renderCompare(id)
      expect(await screen.findByRole('heading', { name: '없는 쪽지예요' })).toBeDefined()
      expect(screen.getByRole('link', { name: '프로젝트 목록' }).getAttribute('href')).toBe('/')
      expect(getIssue).not.toHaveBeenCalled()
    },
  )

  it('404는 없는 쪽지와 프로젝트 목록 링크를 보인다', async () => {
    vi.mocked(getIssue).mockRejectedValueOnce(new ApiError(404))
    renderCompare()
    expect(await screen.findByRole('heading', { name: '없는 쪽지예요' })).toBeDefined()
    expect(screen.getByRole('link', { name: '프로젝트 목록' }).getAttribute('href')).toBe('/')
    expect(screen.queryByRole('img')).toBeNull()
  })

  it.each([
    ['서버 오류', new ApiError(500), '잠시 뒤 다시 시도해 주세요'],
    ['그 밖의 거절', new ApiError(403), '잠시 뒤 다시 시도해 주세요'],
    ['연결 실패', new TypeError('Failed to fetch'), '연결을 확인하고 다시 시도해 주세요'],
  ])('%s면 오류 안내를 보인다', async (_, error, message) => {
    vi.mocked(getIssue).mockRejectedValueOnce(error)
    renderCompare()
    expect((await screen.findByRole('alert')).textContent).toBe(message)
    expect(screen.queryByRole('heading', { name: '없는 쪽지예요' })).toBeNull()
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('401이면 다시 로그인하기 링크를 보인다', async () => {
    vi.mocked(getIssue).mockRejectedValueOnce(new ApiError(401))
    renderCompare()
    expect((await screen.findByRole('link', { name: '다시 로그인하기' })).getAttribute('href')).toBe('/login')
    expect(screen.queryByRole('heading', { name: '로그인 화면' })).toBeNull()
  })

  it('로그인하지 않았으면 로그인 화면으로 간다', async () => {
    vi.mocked(getMe).mockResolvedValueOnce(null)
    renderCompare()
    expect(await screen.findByRole('heading', { name: '로그인 화면' })).toBeDefined()
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('로그인 확인이 실패하면 오류를 알리고 로그인 화면으로 보내지 않는다', async () => {
    vi.mocked(getMe).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    renderCompare()
    expect(await screen.findByText('불러오지 못했어요. 잠시 뒤 새로고침해 주세요')).toBeDefined()
    expect(screen.queryByRole('heading', { name: '로그인 화면' })).toBeNull()
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('15초가 여러 번 지나도 자동으로 다시 불러오지 않는다', async () => {
    vi.useFakeTimers()
    renderCompare()
    await act(async () => {})
    expect(screen.getByRole('heading', { name: '#14 주문 버튼을 옮겨 주세요' })).toBeDefined()
    await act(async () => vi.advanceTimersByTimeAsync(45_000))
    expect(getIssue).toHaveBeenCalledExactlyOnceWith(issue.id)
  })
})

describe('ComparePage 사진과 내용', () => {
  it.each([
    ['PC', 'PC'],
    ['MOBILE', '모바일'],
  ] as const)('처음 사진과 핀, 가장 최근 %s 사진과 설명을 순서대로 보인다', async (viewport, label) => {
    vi.mocked(getIssue).mockResolvedValueOnce({
      ...issue,
      attempts: [olderAttempt, { ...latestAttempt, screen: { ...latestAttempt.screen!, viewport } }],
    })
    renderCompare()
    expect(await screen.findByRole('heading', { name: '#14 주문 버튼을 옮겨 주세요' })).toBeDefined()
    expect(screen.getByText('확인 요청').getAttribute('data-status')).toBe('READY_FOR_REVIEW')
    expect(screen.getByRole('link', { name: '검수실로 돌아가기' }).getAttribute('href')).toBe(roomUrl)
    expect(screen.getByText('고친 내용')).toBeDefined()
    expect(screen.getByText(latestAttempt.summary, { exact: false })).toBeDefined()
    expect(screen.queryByText(olderAttempt.summary, { exact: false })).toBeNull()
    expect(screen.getByText('처음 사진 · 1차 · 처음 주문 화면 · PC')).toBeDefined()
    expect(screen.getByText(`고친 사진 · 3차 · 고친 주문 화면 · ${label}`)).toBeDefined()

    const originPhoto = screen.getByRole('img', { name: '처음 사진 처음 주문 화면 · PC' })
    const fixedPhoto = screen.getByRole('img', { name: `고친 사진 고친 주문 화면 · ${label}` })
    expect(screen.getAllByRole('img')).toEqual([originPhoto, fixedPhoto])
    expect(originPhoto.getAttribute('src')).toBe('/api/assets/origin-photo')
    expect(fixedPhoto.getAttribute('src')).toBe('/api/assets/fixed-photo')
    const pin = screen.getByRole('button', { name: '쪽지 #14 주문 버튼을 옮겨 주세요' })
    expect(pin.textContent).toBe('14')
    expect(pin.style.left).toBe('25%')
    expect(pin.style.top).toBe('75%')
    expect(within(originPhoto.parentElement!).getAllByRole('button')).toEqual([pin])
    expect(within(fixedPhoto.parentElement!).queryByRole('button')).toBeNull()
    expect(screen.getAllByRole('button', { name: /^쪽지 #/ })).toHaveLength(1)
    expect(screen.queryByRole('combobox')).toBeNull()

    fireEvent.click(pin)
    fireEvent.click(fixedPhoto)
    expect(screen.getByRole('heading', { name: '#14 주문 버튼을 옮겨 주세요' })).toBeDefined()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(getIssue).toHaveBeenCalledTimes(1)
    expect(verifyIssue).not.toHaveBeenCalled()
    expect(reopenIssue).not.toHaveBeenCalled()
    expect(withdrawIssue).not.toHaveBeenCalled()
  })

  it('위치 없는 쪽지는 왼쪽 안내와 오른쪽 고친 사진만 보인다', async () => {
    vi.mocked(getIssue).mockResolvedValueOnce({ ...issue, origin: null })
    renderCompare()
    expect(await screen.findByText('위치 없는 쪽지예요.')).toBeDefined()
    expect(screen.getAllByRole('img')).toHaveLength(1)
    expect(screen.getByRole('img', { name: /^고친 사진 / }).getAttribute('src')).toBe('/api/assets/fixed-photo')
    expect(screen.queryByRole('img', { name: /^처음 사진 / })).toBeNull()
    expect(screen.queryByRole('button', { name: /^쪽지 #/ })).toBeNull()
    expect(screen.getByRole('button', { name: '확인 완료' })).toBeDefined()
  })

  it.each([
    { name: '고쳤어요가 없음', attempts: [] },
    { name: '가장 최근 줄에 화면이 없음', attempts: [{ ...latestAttempt, screen: null }] },
    { name: '앞 줄에만 화면이 있음', attempts: [olderAttempt, { ...latestAttempt, screen: null }] },
  ])('$name이면 비교할 사진이 없다는 안내와 제목·돌아가기 링크만 보인다', async ({ attempts }) => {
    vi.mocked(getIssue).mockResolvedValueOnce({ ...issue, attempts })
    renderCompare()
    expect(await screen.findByText('비교할 사진이 없어요.')).toBeDefined()
    expect(screen.getByRole('heading', { name: '#14 주문 버튼을 옮겨 주세요' })).toBeDefined()
    expect(screen.getByRole('link', { name: '검수실로 돌아가기' }).getAttribute('href')).toBe(roomUrl)
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByText('고친 내용')).toBeNull()
    expect(screen.queryByText(olderAttempt.summary, { exact: false })).toBeNull()
  })
})

describe('ComparePage 현재 버전의 검수 상태', () => {
  it('현재 버전이 검수 중이고 가장 최근 고쳤어요가 그 버전이면 확인 완료와 재요청 버튼이 보인다', async () => {
    renderCompare()

    expect(await screen.findByRole('button', { name: '확인 완료' })).toBeDefined()
    expect(screen.getByRole('button', { name: '재요청' })).toBeDefined()
    expect(screen.getByText(latestAttempt.summary, { exact: false })).toBeDefined()
    expect(screen.queryByText(olderAttempt.summary, { exact: false })).toBeNull()
  })

  it('현재 버전이 승인됐으면 확인 완료와 재요청 버튼 없이 두 사진과 고친 내용이 보인다', async () => {
    vi.mocked(getIssue).mockResolvedValueOnce({
      ...issue,
      scope: 'OUT_OF_SCOPE',
      currentVersion: { id: latestAttempt.versionId, status: 'APPROVED' },
    })
    renderCompare()

    expect(await screen.findByRole('heading', { name: '#14 주문 버튼을 옮겨 주세요' })).toBeDefined()
    expect(screen.getByText('확인 요청').getAttribute('data-status')).toBe('READY_FOR_REVIEW')
    expect(screen.queryByRole('button', { name: '확인 완료' })).toBeNull()
    expect(screen.queryByRole('button', { name: '재요청' })).toBeNull()
    expect(screen.getAllByRole('img')).toHaveLength(2)
    expect(screen.getByRole('img', { name: /^처음 사진 / }).getAttribute('src')).toBe('/api/assets/origin-photo')
    expect(screen.getByRole('img', { name: /^고친 사진 / }).getAttribute('src')).toBe('/api/assets/fixed-photo')
    expect(screen.getByText(latestAttempt.summary, { exact: false })).toBeDefined()
    expect(screen.getByRole('link', { name: '검수실로 돌아가기' }).getAttribute('href')).toBe(roomUrl)
  })

  it('현재 버전이 검수 중이어도 가장 최근 고쳤어요가 지난 버전이면 버튼 없이 사진이 보인다', async () => {
    vi.mocked(getIssue).mockResolvedValueOnce({
      ...issue,
      currentVersion: { id: '99999999-9999-4999-8999-999999999999', status: 'IN_REVIEW' },
    })
    renderCompare()

    expect(await screen.findByRole('heading', { name: '#14 주문 버튼을 옮겨 주세요' })).toBeDefined()
    expect(screen.queryByRole('button', { name: '확인 완료' })).toBeNull()
    expect(screen.queryByRole('button', { name: '재요청' })).toBeNull()
    expect(screen.getAllByRole('img')).toHaveLength(2)
    expect(screen.getByRole('img', { name: /^처음 사진 / }).getAttribute('src')).toBe('/api/assets/origin-photo')
    expect(screen.getByRole('img', { name: /^고친 사진 / }).getAttribute('src')).toBe('/api/assets/fixed-photo')
    expect(screen.getByText(latestAttempt.summary, { exact: false })).toBeDefined()
  })

  it('currentVersion이 null이어도 화면이 그려지고 확인 완료와 재요청 버튼은 없다', async () => {
    vi.mocked(getIssue).mockResolvedValueOnce({ ...issue, currentVersion: null })
    renderCompare()

    expect(await screen.findByRole('heading', { name: '#14 주문 버튼을 옮겨 주세요' })).toBeDefined()
    expect(screen.queryByRole('button', { name: '확인 완료' })).toBeNull()
    expect(screen.queryByRole('button', { name: '재요청' })).toBeNull()
    expect(screen.getAllByRole('img')).toHaveLength(2)
    expect(screen.getByText(latestAttempt.summary, { exact: false })).toBeDefined()
  })

  it('새 버전을 다시 받아 확인 버튼이 사라져도 새 버전 안내와 검수실 링크와 사진이 남는다', async () => {
    const refreshed = deferred<Issue>()
    vi.mocked(getIssue).mockResolvedValueOnce(issue).mockReturnValueOnce(refreshed.promise)
    vi.mocked(verifyIssue).mockRejectedValueOnce(new ApiError(409, 'VERSION_CHANGED'))
    renderCompare()
    fireEvent.click(await screen.findByRole('button', { name: '확인 완료' }))
    await screen.findByText('새 버전이 올라왔어요.', { exact: false })

    await act(async () =>
      refreshed.resolve({
        ...issue,
        status: 'IN_PROGRESS',
        currentVersion: { id: '99999999-9999-4999-8999-999999999999', status: 'IN_REVIEW' },
      }),
    )

    expect(screen.queryByRole('button', { name: '확인 완료' })).toBeNull()
    expect(screen.queryByRole('button', { name: '재요청' })).toBeNull()
    expect(screen.getByText('새 버전이 올라왔어요.', { exact: false })).toBeDefined()
    expect(screen.getByRole('link', { name: '검수실에서 최신 버전 보기' }).getAttribute('href')).toBe(roomUrl)
    expect(screen.getByRole('heading', { name: '#14 주문 버튼을 옮겨 주세요' })).toBeDefined()
    expect(screen.getAllByRole('img')).toHaveLength(2)
    expect(screen.getByText(latestAttempt.summary, { exact: false })).toBeDefined()
    expect(getIssue).toHaveBeenCalledTimes(2)
  })
})

describe('ComparePage 확인하기', () => {
  it('확인할 수 있는 확인 요청 쪽지는 재요청과 확인 완료만 보인다', async () => {
    renderCompare()
    const review = await screen.findByRole('region', { name: '확인하기' })
    expect(
      within(review)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['재요청', '확인 완료'])
    expect(screen.queryByRole('button', { name: '철회' })).toBeNull()
  })

  it.each([
    { status: 'READY_FOR_REVIEW', canReview: false, label: '확인 요청' },
    { status: 'IN_PROGRESS', canReview: true, label: '수정 중' },
    { status: 'VERIFIED', canReview: true, label: '확인 완료' },
    { status: 'WITHDRAWN', canReview: true, label: '철회' },
    { status: 'OPEN', canReview: true, label: '접수' },
  ] as const)(
    '$status, canReview=$canReview이면 사진과 상태만 보이고 확인 버튼은 없다',
    async ({ status, canReview, label }) => {
      vi.mocked(getIssue).mockResolvedValueOnce({ ...issue, status, canReview })
      renderCompare()
      expect(await screen.findByRole('heading', { name: '#14 주문 버튼을 옮겨 주세요' })).toBeDefined()
      expect(screen.getByText(label).getAttribute('data-status')).toBe(status)
      expect(screen.getAllByRole('img')).toHaveLength(2)
      expect(screen.queryByRole('region', { name: '확인하기' })).toBeNull()
      expect(screen.getAllByRole('button')).toEqual([screen.getByRole('button', { name: /^쪽지 #/ })])
    },
  )

  it('확인 완료는 처음 버전 대신 가장 최근 줄의 버전과 id를 보내고 응답 상태를 보인다', async () => {
    const pending = deferred<Issue>()
    vi.mocked(verifyIssue).mockReturnValueOnce(pending.promise)
    renderCompare()
    fireEvent.click(await screen.findByRole('button', { name: '확인 완료' }))
    expect(verifyIssue).toHaveBeenCalledExactlyOnceWith(issue.id, {
      versionId: latestAttempt.versionId,
      attemptId: latestAttempt.id,
    })
    expect((screen.getByRole('button', { name: '확인 완료' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '재요청' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '확인 완료' }))
    expect(verifyIssue).toHaveBeenCalledTimes(1)

    vi.mocked(getIssue).mockResolvedValueOnce({ ...issue, status: 'VERIFIED' })
    await act(async () => pending.resolve({ ...issue, status: 'VERIFIED' }))
    expect(screen.getByText('확인 완료').getAttribute('data-status')).toBe('VERIFIED')
    expect(screen.queryByRole('button', { name: '확인 완료' })).toBeNull()
    expect(screen.queryByRole('button', { name: '재요청' })).toBeNull()
    expect(getIssue).toHaveBeenCalledTimes(2)
  })

  it('재요청은 사유와 가장 최근 줄의 버전·id를 보내고 응답의 접수 상태를 보인다', async () => {
    vi.mocked(reopenIssue).mockResolvedValueOnce({ ...issue, status: 'OPEN' })
    vi.mocked(getIssue)
      .mockResolvedValueOnce(issue)
      .mockResolvedValueOnce({ ...issue, status: 'OPEN' })
    renderCompare()
    fireEvent.click(await screen.findByRole('button', { name: '재요청' }))
    fireEvent.change(screen.getByRole('textbox', { name: '재요청 사유' }), { target: { value: '  아직 겹쳐요  ' } })
    fireEvent.click(screen.getByRole('button', { name: '재요청 보내기' }))
    expect(reopenIssue).toHaveBeenCalledExactlyOnceWith(issue.id, {
      versionId: latestAttempt.versionId,
      reason: '아직 겹쳐요',
      attemptId: latestAttempt.id,
    })
    expect((await screen.findByText('접수')).getAttribute('data-status')).toBe('OPEN')
    expect(screen.queryByRole('region', { name: '확인하기' })).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(getIssue).toHaveBeenCalledTimes(2)
  })

  it('사유 없이 재요청할 수 없고 취소하면 요청하지 않는다', async () => {
    renderCompare()
    fireEvent.click(await screen.findByRole('button', { name: '재요청' }))
    fireEvent.change(screen.getByRole('textbox', { name: '재요청 사유' }), { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: '재요청 보내기' }))
    expect(await screen.findByText('사유는 1~2,000자로 써 주세요')).toBeDefined()
    expect(reopenIssue).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole('textbox', { name: '재요청 사유' }), { target: { value: '취소할 사유' } })
    fireEvent.click(screen.getByRole('button', { name: '취소' }))
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByText('확인 요청')).toBeDefined()
    expect(reopenIssue).not.toHaveBeenCalled()
  })
})

describe.each([
  { action: '확인 완료', api: verifyIssue },
  { action: '재요청', api: reopenIssue },
])('ComparePage $action 실패', ({ action, api }) => {
  it('VERSION_CHANGED면 다시 불러와 버튼이 사라져도 새 버전 안내와 검수실 링크가 남는다', async () => {
    vi.mocked(api).mockRejectedValueOnce(new ApiError(409, 'VERSION_CHANGED'))
    vi.mocked(getIssue)
      .mockResolvedValueOnce(issue)
      .mockResolvedValueOnce({ ...issue, status: 'IN_PROGRESS' })
    renderCompare()
    await screen.findByRole('button', { name: action })
    sendReview(action)

    expect(await screen.findByText('수정 중')).toBeDefined()
    expect(screen.getByText('새 버전이 올라왔어요.', { exact: false })).toBeDefined()
    expect(screen.getByRole('link', { name: '검수실에서 최신 버전 보기' }).getAttribute('href')).toBe(roomUrl)
    expect(screen.queryByRole('button', { name: '최신 버전 보기' })).toBeNull()
    expect(screen.queryByRole('button', { name: '확인 완료' })).toBeNull()
    expect(screen.queryByRole('button', { name: '재요청' })).toBeNull()
    expect(vi.mocked(getIssue).mock.calls).toEqual([[issue.id], [issue.id]])
  })

  it.each(['ISSUE_STATE_CHANGED', 'ATTEMPT_CHANGED'])('%s면 안내와 새로 받은 쪽지를 보인다', async (code) => {
    vi.mocked(api).mockRejectedValueOnce(new ApiError(409, code))
    vi.mocked(getIssue)
      .mockResolvedValueOnce(issue)
      .mockResolvedValueOnce({ ...issue, status: 'IN_PROGRESS' })
    renderCompare()
    await screen.findByRole('button', { name: action })
    sendReview(action)
    expect(await screen.findByText('수정 중')).toBeDefined()
    expect(screen.getByText(staleMessage)).toBeDefined()
    expect(screen.queryByRole('button', { name: '확인 완료' })).toBeNull()
    expect(vi.mocked(getIssue).mock.calls).toEqual([[issue.id], [issue.id]])
  })

  it.each([
    ['연결 실패', new TypeError('Failed to fetch')],
    ['서버 오류', new ApiError(500)],
  ])('%s면 저장 여부 안내를 보이고 다시 받은 뒤 안내를 거둔다', async (_, error) => {
    const pending = deferred<Issue>()
    vi.mocked(api).mockRejectedValueOnce(error)
    vi.mocked(getIssue).mockResolvedValueOnce(issue).mockReturnValueOnce(pending.promise)
    renderCompare()
    await screen.findByRole('button', { name: action })
    sendReview(action)
    expect(await screen.findByText(unconfirmedMessage)).toBeDefined()
    expect(vi.mocked(getIssue).mock.calls).toEqual([[issue.id], [issue.id]])
    expect(screen.getByRole('heading', { name: '#14 주문 버튼을 옮겨 주세요' })).toBeDefined()
    await act(async () => pending.resolve({ ...issue, status: 'VERIFIED' }))
    expect(screen.getByText('확인 완료').getAttribute('data-status')).toBe('VERIFIED')
    expect(screen.queryByText(unconfirmedMessage)).toBeNull()
  })
})

describe('ComparePage 새로 불러오기와 이동', () => {
  it.each(['실패', '성공'] as const)(
    '앞선 조회 성공과 확인 완료 연결 실패가 같은 화면 갱신에 묶이면 안내가 남고 후속 조회 %s에 따라 걷힌다',
    async (result) => {
      const earlierLoad = deferred<Issue>()
      const verification = deferred<Issue>()
      const followingLoad = deferred<Issue>()
      vi.mocked(getIssue)
        .mockResolvedValueOnce(issue)
        .mockReturnValueOnce(earlierLoad.promise)
        .mockReturnValueOnce(followingLoad.promise)
      vi.mocked(verifyIssue)
        .mockRejectedValueOnce(new ApiError(409, 'ATTEMPT_CHANGED'))
        .mockReturnValueOnce(verification.promise)
      renderCompare()

      fireEvent.click(await screen.findByRole('button', { name: '확인 완료' }))
      await screen.findByText(staleMessage)
      expect(getIssue).toHaveBeenCalledTimes(2)
      fireEvent.click(screen.getByRole('button', { name: '확인 완료' }))
      expect(verifyIssue).toHaveBeenCalledTimes(2)

      // 먼저 시작한 조회를 성공 처리한 뒤 저장 실패를 처리하되, 둘 다 같은 화면 갱신에 묶는다.
      await act(async () => {
        earlierLoad.resolve({ ...issue, title: '실패 직전에 받은 제목' })
        await earlierLoad.promise
        verification.reject(new TypeError('Failed to fetch'))
      })

      expect(screen.getByRole('heading', { name: '#14 실패 직전에 받은 제목' })).toBeDefined()
      expect(screen.getByText(unconfirmedMessage)).toBeDefined()
      expect(screen.queryByText(staleMessage)).toBeNull()
      expect(getIssue).toHaveBeenCalledTimes(3)

      await act(async () => {
        if (result === '실패') return followingLoad.reject(new TypeError('Failed to fetch'))
        followingLoad.resolve({ ...issue, status: 'VERIFIED', title: '실패 뒤에 받은 제목' })
      })

      if (result === '실패') {
        expect(screen.getByText(unconfirmedMessage)).toBeDefined()
        expect(screen.getByRole('heading', { name: '#14 실패 직전에 받은 제목' })).toBeDefined()
        expect(screen.getByRole('button', { name: '확인 완료' })).toBeDefined()
      }
      if (result === '성공') {
        expect(screen.queryByText(unconfirmedMessage)).toBeNull()
        expect(screen.getByRole('heading', { name: '#14 실패 뒤에 받은 제목' })).toBeDefined()
        expect(screen.getByText('확인 완료').getAttribute('data-status')).toBe('VERIFIED')
        expect(screen.queryByRole('button', { name: '확인 완료' })).toBeNull()
      }
      expect(verifyIssue).toHaveBeenCalledTimes(2)
      expect(vi.mocked(getIssue).mock.calls).toEqual([[issue.id], [issue.id], [issue.id]])
    },
  )

  it.each(['성공', '404'] as const)(
    '저장 응답과 옛 조회의 %s 응답이 같은 틱에 와도 확인 완료가 남고 후속 조회 실패에도 유지된다',
    async (result) => {
      const staleLoad = deferred<Issue>()
      const verification = deferred<Issue>()
      const freshLoad = deferred<Issue>()
      const verified: Issue = {
        ...issue,
        status: 'VERIFIED',
        attempts: [
          olderAttempt,
          { ...latestAttempt, result: 'VERIFIED', reviewedByName: user.name, reviewedAt: '2026-11-13T01:00:00Z' },
        ],
      }
      vi.mocked(getIssue)
        .mockResolvedValueOnce(issue)
        .mockReturnValueOnce(staleLoad.promise)
        .mockReturnValueOnce(freshLoad.promise)
      vi.mocked(verifyIssue)
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockReturnValueOnce(verification.promise)
      renderCompare()

      fireEvent.click(await screen.findByRole('button', { name: '확인 완료' }))
      await screen.findByText(unconfirmedMessage)
      expect(getIssue).toHaveBeenCalledTimes(2)
      fireEvent.click(screen.getByRole('button', { name: '확인 완료' }))
      expect(verifyIssue).toHaveBeenCalledTimes(2)

      // 두 응답 사이에 act를 끝내지 않는다. 저장을 적용한 뒤 다시 그리기 전에 옛 조회가 도착한다.
      await act(async () => {
        verification.resolve(verified)
        if (result === '404') return staleLoad.reject(new ApiError(404))
        staleLoad.resolve(issue)
      })
      expect(screen.getByText('확인 완료').getAttribute('data-status')).toBe('VERIFIED')
      expect(screen.queryByRole('button', { name: '확인 완료' })).toBeNull()
      expect(screen.queryByRole('button', { name: '재요청' })).toBeNull()
      expect(screen.queryByRole('heading', { name: '없는 쪽지예요' })).toBeNull()
      expect(getIssue).toHaveBeenCalledTimes(3)

      await act(async () => freshLoad.reject(new TypeError('Failed to fetch')))
      expect(screen.getByText('확인 완료').getAttribute('data-status')).toBe('VERIFIED')
      expect(screen.queryByRole('button', { name: '확인 완료' })).toBeNull()
      expect(screen.queryByRole('button', { name: '재요청' })).toBeNull()
      expect(vi.mocked(getIssue).mock.calls).toEqual([[issue.id], [issue.id], [issue.id]])
    },
  )

  it('버튼 잠금 전 요청이 겹쳐 새 조회가 먼저 끝나면 늦은 저장 응답을 버리고 한 번 더 불러온다', async () => {
    const failedVerification = deferred<Issue>()
    const lateVerification = deferred<Issue>()
    const newerLoad = deferred<Issue>()
    const finalLoad = deferred<Issue>()
    const newerAttempt = {
      ...latestAttempt,
      id: '88888888-8888-4888-8888-888888888888',
      summary: '새 고쳤어요가 한 줄 더 생겼어요',
    }
    const newerIssue: Issue = { ...issue, attempts: [...issue.attempts, newerAttempt] }
    const finalIssue: Issue = { ...newerIssue, title: '마지막 조회에서 받은 제목' }
    vi.mocked(getIssue)
      .mockResolvedValueOnce(issue)
      .mockReturnValueOnce(newerLoad.promise)
      .mockReturnValueOnce(finalLoad.promise)
    vi.mocked(verifyIssue).mockReturnValueOnce(failedVerification.promise).mockReturnValueOnce(lateVerification.promise)
    renderCompare()
    const verifyButton = await screen.findByRole('button', { name: '확인 완료' })

    // 보통은 보내는 중 버튼이 잠겨 다른 실패로 새 조회를 시작할 수 없다.
    // 가장 가까운 경계로, 잠금을 그리기 전 같은 act에서 두 클릭을 보내 요청을 겹친다.
    await act(async () => {
      fireEvent.click(verifyButton)
      fireEvent.click(verifyButton)
    })
    expect(verifyIssue).toHaveBeenCalledTimes(2)
    await act(async () => failedVerification.reject(new TypeError('Failed to fetch')))
    expect(getIssue).toHaveBeenCalledTimes(2)
    await act(async () => newerLoad.resolve(newerIssue))
    expect(screen.getByText(newerAttempt.summary, { exact: false })).toBeDefined()

    await act(async () => lateVerification.resolve({ ...issue, status: 'VERIFIED' }))
    // 다음 조회는 아직 대기 중이다. 늦은 저장 응답이 잠깐이라도 새 내용을 지우면 실패한다.
    expect(screen.getByText(newerAttempt.summary, { exact: false })).toBeDefined()
    expect(screen.getByText('확인 요청').getAttribute('data-status')).toBe('READY_FOR_REVIEW')
    expect(screen.getByRole('button', { name: '확인 완료' })).toBeDefined()
    expect(getIssue).toHaveBeenCalledTimes(3)

    await act(async () => finalLoad.resolve(finalIssue))
    expect(screen.getByRole('heading', { name: '#14 마지막 조회에서 받은 제목' })).toBeDefined()
    expect(screen.getByText(newerAttempt.summary, { exact: false })).toBeDefined()
    expect(vi.mocked(getIssue).mock.calls).toEqual([[issue.id], [issue.id], [issue.id]])
  })

  it('연달아 시작한 두 조회 중 나중 조회의 새 고쳤어요가 먼저 오면 늦은 첫 조회로 되돌아가지 않는다', async () => {
    const firstLoad = deferred<Issue>()
    const secondLoad = deferred<Issue>()
    const newerAttempt = {
      ...latestAttempt,
      id: '88888888-8888-4888-8888-888888888888',
      summary: '두 번째 조회의 새 고쳤어요',
    }
    vi.mocked(getIssue)
      .mockResolvedValueOnce(issue)
      .mockReturnValueOnce(firstLoad.promise)
      .mockReturnValueOnce(secondLoad.promise)
    vi.mocked(verifyIssue).mockRejectedValue(new ApiError(409, 'ATTEMPT_CHANGED'))
    renderCompare()

    fireEvent.click(await screen.findByRole('button', { name: '확인 완료' }))
    await waitFor(() => expect(getIssue).toHaveBeenCalledTimes(2))
    fireEvent.click(screen.getByRole('button', { name: '확인 완료' }))
    await waitFor(() => expect(getIssue).toHaveBeenCalledTimes(3))
    await act(async () => secondLoad.resolve({ ...issue, attempts: [...issue.attempts, newerAttempt] }))
    expect(screen.getByText(newerAttempt.summary, { exact: false })).toBeDefined()

    await act(async () => firstLoad.resolve(issue))
    expect(screen.getByText(newerAttempt.summary, { exact: false })).toBeDefined()
    expect(screen.queryByText(latestAttempt.summary, { exact: false })).toBeNull()
    expect(screen.getByText('확인 요청').getAttribute('data-status')).toBe('READY_FOR_REVIEW')
    expect(verifyIssue).toHaveBeenCalledTimes(2)
    expect(vi.mocked(getIssue).mock.calls).toEqual([[issue.id], [issue.id], [issue.id]])
  })

  it.each([
    { action: '확인 완료', api: verifyIssue, status: 'VERIFIED', label: '확인 완료' },
    { action: '재요청', api: reopenIssue, status: 'OPEN', label: '접수' },
  ] as const)(
    '$action 저장 성공 뒤 정확히 한 번 더 조회하고 그 응답을 화면에 쓴다',
    async ({ action, api, status, label }) => {
      const saved = deferred<Issue>()
      const refreshed = deferred<Issue>()
      const changed: Issue = { ...issue, status }
      vi.mocked(api).mockReturnValueOnce(saved.promise)
      vi.mocked(getIssue).mockResolvedValueOnce(issue).mockReturnValueOnce(refreshed.promise)
      renderCompare()
      await screen.findByRole('button', { name: action })
      sendReview(action)
      expect(api).toHaveBeenCalledTimes(1)
      expect(getIssue).toHaveBeenCalledTimes(1)

      await act(async () => saved.resolve(changed))
      expect(screen.getByText(label).getAttribute('data-status')).toBe(status)
      expect(screen.getByRole('heading', { name: '#14 주문 버튼을 옮겨 주세요' })).toBeDefined()
      expect(getIssue).toHaveBeenCalledTimes(2)

      await act(async () => refreshed.resolve({ ...changed, title: '저장 뒤 조회한 제목' }))
      expect(screen.getByRole('heading', { name: '#14 저장 뒤 조회한 제목' })).toBeDefined()
      expect(screen.getByText(label).getAttribute('data-status')).toBe(status)
      expect(screen.queryByRole('button', { name: '확인 완료' })).toBeNull()
      expect(screen.queryByRole('button', { name: '재요청' })).toBeNull()
      expect(vi.mocked(getIssue).mock.calls).toEqual([[issue.id], [issue.id]])
    },
  )

  it('확인 완료 응답보다 먼저 시작한 불러오기의 늦은 응답이 와도 확인 완료가 유지된다', async () => {
    const staleLoad = deferred<Issue>()
    const verification = deferred<Issue>()
    const freshLoad = deferred<Issue>()
    const verified: Issue = {
      ...issue,
      status: 'VERIFIED',
      attempts: [
        olderAttempt,
        { ...latestAttempt, result: 'VERIFIED', reviewedByName: user.name, reviewedAt: '2026-11-13T01:00:00Z' },
      ],
    }
    vi.mocked(getIssue)
      .mockResolvedValueOnce(issue)
      .mockReturnValueOnce(staleLoad.promise)
      .mockReturnValueOnce(freshLoad.promise)
    vi.mocked(verifyIssue)
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockReturnValueOnce(verification.promise)
    renderCompare()

    fireEvent.click(await screen.findByRole('button', { name: '확인 완료' }))
    await screen.findByText(unconfirmedMessage)
    expect(getIssue).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: '확인 완료' }))
    expect(verifyIssue).toHaveBeenCalledTimes(2)
    await act(async () => verification.resolve(verified))

    // 성공 뒤의 새 조회도 대기시켜, 화면이 쓰기 응답을 바로 쓰는지 확인한다.
    expect(screen.getByText('확인 완료').getAttribute('data-status')).toBe('VERIFIED')
    expect(screen.queryByRole('button', { name: '확인 완료' })).toBeNull()
    expect(getIssue).toHaveBeenCalledTimes(3)
    await act(async () => staleLoad.resolve(issue))

    expect(screen.getByText('확인 완료').getAttribute('data-status')).toBe('VERIFIED')
    expect(screen.queryByRole('button', { name: '확인 완료' })).toBeNull()
    expect(screen.queryByRole('button', { name: '재요청' })).toBeNull()
    await act(async () => freshLoad.resolve(verified))
    expect(screen.getByText('확인 완료').getAttribute('data-status')).toBe('VERIFIED')
    expect(vi.mocked(getIssue).mock.calls).toEqual([[issue.id], [issue.id], [issue.id]])
  })

  it('403이면 쪽지를 다시 불러오고 새로 받은 canReview가 거짓이면 버튼이 사라지며 안내는 남는다', async () => {
    const refreshed = deferred<Issue>()
    vi.mocked(verifyIssue).mockRejectedValueOnce(new ApiError(403))
    vi.mocked(getIssue).mockResolvedValueOnce(issue).mockReturnValueOnce(refreshed.promise)
    renderCompare()
    fireEvent.click(await screen.findByRole('button', { name: '확인 완료' }))

    expect((await screen.findByRole('alert')).textContent).toBe('잠시 뒤 다시 시도해 주세요')
    expect(getIssue).toHaveBeenCalledTimes(2)
    await act(async () => refreshed.resolve({ ...issue, canReview: false }))

    expect(screen.getByText('확인 요청').getAttribute('data-status')).toBe('READY_FOR_REVIEW')
    expect(screen.queryByRole('button', { name: '확인 완료' })).toBeNull()
    expect(screen.queryByRole('button', { name: '재요청' })).toBeNull()
    expect(screen.getByRole('alert').textContent).toBe('잠시 뒤 다시 시도해 주세요')
    expect(verifyIssue).toHaveBeenCalledExactlyOnceWith(issue.id, {
      versionId: latestAttempt.versionId,
      attemptId: latestAttempt.id,
    })
    expect(vi.mocked(getIssue).mock.calls).toEqual([[issue.id], [issue.id]])
  })

  it.each([
    ['연결 실패', new TypeError('Failed to fetch')],
    ['서버 오류', new ApiError(500)],
  ])('다시 불러오기가 %s여도 이미 보이던 쪽지와 저장 여부 안내를 유지한다', async (_, error) => {
    const pending = deferred<Issue>()
    vi.mocked(verifyIssue).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    vi.mocked(getIssue).mockResolvedValueOnce(issue).mockReturnValueOnce(pending.promise)
    renderCompare()
    fireEvent.click(await screen.findByRole('button', { name: '확인 완료' }))
    await screen.findByText(unconfirmedMessage)
    await act(async () => pending.reject(error))
    expect(screen.getByRole('heading', { name: '#14 주문 버튼을 옮겨 주세요' })).toBeDefined()
    expect(screen.getAllByRole('img')).toHaveLength(2)
    expect(screen.getByText(unconfirmedMessage)).toBeDefined()
    expect(screen.queryByRole('heading', { name: '없는 쪽지예요' })).toBeNull()
    expect(getIssue).toHaveBeenCalledTimes(2)
  })

  it('다시 불러오기가 404면 없는 쪽지와 프로젝트 목록 링크를 보이고 앞 쪽지의 제목·사진·버튼은 사라진다', async () => {
    const pending = deferred<Issue>()
    vi.mocked(verifyIssue).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    vi.mocked(getIssue).mockResolvedValueOnce(issue).mockReturnValueOnce(pending.promise)
    renderCompare()
    fireEvent.click(await screen.findByRole('button', { name: '확인 완료' }))
    await screen.findByText(unconfirmedMessage)
    expect(screen.getByRole('heading', { name: '#14 주문 버튼을 옮겨 주세요' })).toBeDefined()
    expect(screen.getAllByRole('img')).toHaveLength(2)

    await act(async () => pending.reject(new ApiError(404)))
    expect(screen.getByRole('heading', { name: '없는 쪽지예요' })).toBeDefined()
    expect(screen.getByRole('link', { name: '프로젝트 목록' }).getAttribute('href')).toBe('/')
    expect(screen.queryByRole('heading', { name: '#14 주문 버튼을 옮겨 주세요' })).toBeNull()
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    expect(getIssue).toHaveBeenCalledTimes(2)
  })

  it('재요청 실패 후 새로 불러와도 사유가 남고 새 줄의 id로 다시 보낸다', async () => {
    const newerAttempt = { ...latestAttempt, id: '88888888-8888-4888-8888-888888888888', summary: '새로 고친 설명' }
    vi.mocked(reopenIssue)
      .mockRejectedValueOnce(new ApiError(409, 'ATTEMPT_CHANGED'))
      .mockResolvedValueOnce({ ...issue, status: 'OPEN' })
    vi.mocked(getIssue)
      .mockResolvedValueOnce(issue)
      .mockResolvedValueOnce({ ...issue, attempts: [...issue.attempts, newerAttempt] })
      .mockResolvedValueOnce({ ...issue, status: 'OPEN', attempts: [...issue.attempts, newerAttempt] })
    renderCompare()
    await screen.findByRole('button', { name: '재요청' })
    sendReview('재요청')
    expect(await screen.findByText(newerAttempt.summary, { exact: false })).toBeDefined()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(reopenIssue).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: '재요청' }))
    expect((screen.getByRole('textbox', { name: '재요청 사유' }) as HTMLTextAreaElement).value).toBe(
      '아직 버튼이 겹쳐요',
    )
    expect(screen.getByText(staleMessage)).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: '재요청 보내기' }))
    expect(await screen.findByText('접수')).toBeDefined()
    expect(reopenIssue).toHaveBeenLastCalledWith(issue.id, {
      versionId: newerAttempt.versionId,
      reason: '아직 버튼이 겹쳐요',
      attemptId: newerAttempt.id,
    })
    expect(screen.queryByText(staleMessage)).toBeNull()
  })

  it('다른 쪽지 주소로 이동하면 응답을 기다리는 동안 앞 쪽지의 사진·제목·사유를 보이지 않는다', async () => {
    const pending = deferred<Issue>()
    vi.mocked(getIssue).mockResolvedValueOnce(issue).mockReturnValueOnce(pending.promise)
    renderCompare()
    fireEvent.click(await screen.findByRole('button', { name: '재요청' }))
    fireEvent.change(screen.getByRole('textbox', { name: '재요청 사유' }), { target: { value: '앞 쪽지 사유' } })
    fireEvent.click(screen.getByRole('link', { name: '다른 쪽지 비교' }))
    expect(await screen.findByText('불러오는 중이에요.')).toBeDefined()
    expect(screen.queryByRole('heading', { name: '#14 주문 버튼을 옮겨 주세요' })).toBeNull()
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
    await act(async () => pending.resolve({ ...otherIssue, status: 'READY_FOR_REVIEW' }))
    expect(screen.getByRole('heading', { name: '#27 다른 쪽지 제목' })).toBeDefined()
    expect(screen.getByRole('link', { name: '검수실로 돌아가기' }).getAttribute('href')).toBe(
      `/projects/${otherIssue.projectId}?issue=${otherIssue.id}`,
    )
    fireEvent.click(screen.getByRole('button', { name: '재요청' }))
    expect((screen.getByRole('textbox', { name: '재요청 사유' }) as HTMLTextAreaElement).value).toBe('')
    expect(vi.mocked(getIssue).mock.calls).toEqual([[issue.id], [otherIssue.id]])
  })

  it.each(['성공', '404'] as const)('다른 쪽지로 이동한 뒤 도착한 앞 쪽지의 늦은 %s 응답은 버린다', async (result) => {
    const pending = deferred<Issue>()
    vi.mocked(getIssue).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(otherIssue)
    renderCompare()
    await screen.findByText('불러오는 중이에요.')
    fireEvent.click(screen.getByRole('link', { name: '다른 쪽지 비교' }))
    await screen.findByRole('heading', { name: '#27 다른 쪽지 제목' })
    await act(async () => {
      if (result === '404') return pending.reject(new ApiError(404))
      pending.resolve(issue)
    })
    expect(screen.getByRole('heading', { name: '#27 다른 쪽지 제목' })).toBeDefined()
    expect(screen.queryByRole('heading', { name: '#14 주문 버튼을 옮겨 주세요' })).toBeNull()
    expect(screen.queryByRole('heading', { name: '없는 쪽지예요' })).toBeNull()
  })

  it.each(['성공', '404'] as const)('새로 불러오기가 겹치면 먼저 보낸 요청의 늦은 %s 응답은 버린다', async (result) => {
    const pending = deferred<Issue>()
    vi.mocked(verifyIssue).mockRejectedValue(new ApiError(409, 'ATTEMPT_CHANGED'))
    vi.mocked(getIssue)
      .mockResolvedValueOnce(issue)
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ ...issue, status: 'IN_PROGRESS' })
    renderCompare()
    fireEvent.click(await screen.findByRole('button', { name: '확인 완료' }))
    await waitFor(() => expect(getIssue).toHaveBeenCalledTimes(2))
    fireEvent.click(screen.getByRole('button', { name: '확인 완료' }))
    await screen.findByText('수정 중')
    await act(async () => {
      if (result === '404') return pending.reject(new ApiError(404))
      pending.resolve(issue)
    })
    expect(screen.getByText('수정 중')).toBeDefined()
    expect(screen.queryByRole('button', { name: '확인 완료' })).toBeNull()
    expect(screen.queryByRole('heading', { name: '없는 쪽지예요' })).toBeNull()
    expect(vi.mocked(getIssue).mock.calls).toEqual([[issue.id], [issue.id], [issue.id]])
  })
})
