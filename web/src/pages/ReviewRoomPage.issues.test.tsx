import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { Link, MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router'
import { getMe } from '../api/auth.ts'
import { ApiError } from '../api/client.ts'
import {
  attachIssuePhoto,
  createComment,
  createIssue,
  getIssue,
  type IssueDetail,
  listIssues,
  removeIssuePhoto,
  startIssue,
} from '../api/issues.ts'
import { listMembers } from '../api/members.ts'
import { getProject, type ProjectDetail } from '../api/projects.ts'
import { getVersion, listVersions, type VersionDetail } from '../api/versions.ts'
import { ReviewRoomPage } from './ReviewRoomPage.tsx'

vi.mock('../api/auth.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/auth.ts')>()),
  getMe: vi.fn(),
}))
vi.mock('../api/projects.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/projects.ts')>()),
  getProject: vi.fn(),
}))
vi.mock('../api/versions.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/versions.ts')>()),
  getVersion: vi.fn(),
  listVersions: vi.fn(),
}))
vi.mock('../api/members.ts', () => ({ listMembers: vi.fn() }))
vi.mock('../api/issues.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/issues.ts')>()),
  listIssues: vi.fn(),
  getIssue: vi.fn(),
  createIssue: vi.fn(),
  createComment: vi.fn(),
  startIssue: vi.fn(),
  attachIssuePhoto: vi.fn(),
  removeIssuePhoto: vi.fn(),
}))

const project: ProjectDetail = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  name: '쪽지 검수 프로젝트',
  myRole: 'DEVELOPER',
  currentVersion: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', number: 1 },
  approver: null,
}
const current: VersionDetail = {
  id: project.currentVersion!.id,
  projectId: project.id,
  number: 1,
  status: 'IN_REVIEW',
  summary: '현재 사진을 검수해 주세요.',
  testUrl: null,
  publishedAt: '2026-11-11T00:00:00.000Z',
  screens: [
    {
      screenId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      name: '상품 상세',
      viewport: 'PC',
      hiddenAt: null,
      asset: { id: 'current-product', width: 1200, height: 800 },
    },
    {
      screenId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      name: '장바구니',
      viewport: 'MOBILE',
      hiddenAt: null,
      asset: { id: 'current-cart', width: 390, height: 844 },
    },
  ],
}
const initial: VersionDetail = {
  ...current,
  id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  number: 0,
  status: 'APPROVED',
  screens: current.screens.map((item) => ({ ...item, asset: { ...item.asset, id: `old-${item.asset.id}` } })),
}
const latest: VersionDetail = {
  ...current,
  id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  number: 2,
  screens: current.screens.map((item) => ({ ...item, asset: { ...item.asset, id: `new-${item.asset.id}` } })),
}
const productIssue: IssueDetail = {
  id: 'a1111111-1111-4111-8111-111111111111',
  number: 1,
  title: '상품 버튼을 옮겨 주세요',
  body: '버튼과 설명 사이를 넓혀 주세요.',
  status: 'OPEN',
  authorName: '김수정',
  createdAt: '2026-11-11T01:00:00.000Z',
  commentCount: 0,
  originVersion: { id: current.id, number: 1 },
  origin: {
    screenId: current.screens[0].screenId,
    screenName: '상품 상세',
    viewport: 'PC',
    asset: current.screens[0].asset,
    xRatio: 0.25,
    yRatio: 0.75,
  },
  isMine: true,
  attachments: [{ id: 'attachment-1', assetId: 'reference-photo', width: 400, height: 300 }],
  comments: [],
}
const cartIssue: IssueDetail = {
  ...productIssue,
  id: 'a2222222-2222-4222-8222-222222222222',
  number: 2,
  title: '장바구니 여백',
  origin: {
    ...productIssue.origin!,
    screenId: current.screens[1].screenId,
    screenName: '장바구니',
    viewport: 'MOBILE',
    asset: current.screens[1].asset,
  },
}
const oldIssue: IssueDetail = {
  ...productIssue,
  id: 'a3333333-3333-4333-8333-333333333333',
  number: 3,
  title: '초안에서 남긴 요청',
  originVersion: { id: initial.id, number: 0 },
  origin: { ...productIssue.origin!, asset: initial.screens[0].asset },
}
const unpinnedIssue: IssueDetail = {
  ...productIssue,
  id: 'a4444444-4444-4444-8444-444444444444',
  number: 4,
  title: '전체 색상 요청',
  origin: null,
}
const issues = [unpinnedIssue, oldIssue, cartIssue, productIssue]
const savedIssue: IssueDetail = {
  ...productIssue,
  id: 'a5555555-5555-4555-8555-555555555555',
  number: 5,
  title: '새 요청 제목',
  body: '새 요청 내용',
  attachments: [],
}
const savedComment = {
  id: 'comment-new',
  authorName: '김수정',
  versionNumber: 1,
  body: '쓰던 댓글',
  createdAt: '2026-11-11T02:00:00.000Z',
}

const CurrentAddress = () => {
  const location = useLocation()
  const navigate = useNavigate()
  return (
    <>
      <output aria-label="현재 주소">
        {location.pathname}
        {location.search}
      </output>
      <button onClick={() => navigate(-1)}>브라우저 뒤로 가기</button>
      <button onClick={() => navigate(1)}>브라우저 앞으로 가기</button>
    </>
  )
}
const renderRoom = async (query = '', destination?: string) => {
  let view!: ReturnType<typeof render>
  await act(async () => {
    view = render(
      <MemoryRouter initialEntries={[`/projects/${project.id}${query}`]}>
        <CurrentAddress />
        {destination && <Link to={destination}>다른 페이지로 이동</Link>}
        <Routes>
          <Route path="/" element={<h1>프로젝트 목록</h1>} />
          <Route path="/projects/:id" element={<ReviewRoomPage />} />
          <Route path="/login" element={<h1>로그인</h1>} />
        </Routes>
      </MemoryRouter>,
    )
  })
  return view
}
const queryParams = () => new URLSearchParams(screen.getByLabelText('현재 주소').textContent!.split('?')[1])
const click = async (name: string) => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }))
  })
}
const chooseVersion = async (id: string) => {
  await act(async () => {
    fireEvent.change(screen.getByRole('combobox', { name: '버전' }), { target: { value: id } })
  })
}
const chooseIssue = async (issue: IssueDetail) => {
  await act(async () => {
    fireEvent.click(
      within(screen.getByRole('region', { name: '쪽지 목록' })).getByRole('button', { name: new RegExp(issue.title) }),
    )
  })
}
const photo = (name = '상품 상세 · PC') => screen.getByRole<HTMLImageElement>('img', { name })
const placePin = async (name = '상품 상세 · PC', clientX = 200, clientY = 350) => {
  const image = photo(name)
  vi.spyOn(image, 'getBoundingClientRect').mockReturnValue({
    left: 100,
    top: 50,
    width: 400,
    height: 400,
    right: 500,
    bottom: 450,
    x: 100,
    y: 50,
    toJSON: () => ({}),
  })
  await act(async () => {
    fireEvent.click(image, { clientX, clientY })
  })
}
const fillDraft = () => {
  fireEvent.change(screen.getByRole('textbox', { name: '제목 (필수)' }), { target: { value: savedIssue.title } })
  fireEvent.change(screen.getByRole('textbox', { name: '내용' }), { target: { value: savedIssue.body } })
}
const expectDraft = () => {
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: '제목 (필수)' }).value).toBe(savedIssue.title)
  expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '내용' }).value).toBe(savedIssue.body)
}
const fillComment = () => {
  fireEvent.change(screen.getByRole('textbox', { name: '댓글' }), { target: { value: savedComment.body } })
}
const pinName = (issue: IssueDetail) => `쪽지 #${issue.number} ${issue.title}`
const advance = async (ms = 15_000) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}
const publishLatest = () => {
  vi.mocked(getProject).mockResolvedValue({ ...project, currentVersion: { id: latest.id, number: 2 } })
  vi.mocked(listVersions).mockResolvedValue([latest, current, initial])
}
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(getMe).mockResolvedValue({
    id: 'reader',
    name: '김수정',
    email: 'reader@example.com',
    canCreateProjects: false,
  })
  vi.mocked(getProject).mockResolvedValue(project)
  vi.mocked(listVersions).mockResolvedValue([current, initial])
  vi.mocked(getVersion).mockImplementation(async (id) => {
    const version = [current, initial, latest].find((item) => item.id === id)
    if (!version) throw new ApiError(404)
    return version
  })
  vi.mocked(listMembers).mockResolvedValue({ members: [], invitations: [] })
  vi.mocked(listIssues).mockResolvedValue(issues)
  vi.mocked(getIssue).mockImplementation(async (id) => {
    const issue = [...issues, savedIssue].find((item) => item.id === id)
    if (!issue) throw new ApiError(404)
    return issue
  })
  vi.mocked(createIssue).mockResolvedValue(savedIssue)
  vi.mocked(createComment).mockResolvedValue(savedComment)
  vi.mocked(startIssue).mockResolvedValue({ ...productIssue, status: 'IN_PROGRESS' })
  vi.mocked(attachIssuePhoto).mockResolvedValue(productIssue)
  vi.mocked(removeIssuePhoto).mockResolvedValue({ ...productIssue, attachments: [] })
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('ReviewRoomPage 버전 재시도와 초기 불러오기', () => {
  it.each([
    { reason: '서버 오류', error: new ApiError(500), message: '잠시 뒤 다시 시도해 주세요' },
    { reason: '연결 끊김', error: new TypeError('Failed to fetch'), message: '연결을 확인하고 다시 시도해 주세요' },
  ])(
    '고른 지난 버전이 $reason로 실패해도 다시 시도로 같은 버전을 복구하고 쓰던 댓글을 남긴다',
    async ({ error, message }) => {
      await renderRoom(`?issue=${productIssue.id}`)
      fillComment()
      const firstVersion = deferred<VersionDetail>()
      vi.mocked(getVersion).mockReturnValueOnce(firstVersion.promise)
      await chooseVersion(initial.id)
      expect(getVersion).toHaveBeenLastCalledWith(initial.id)
      await act(async () => firstVersion.reject(error))

      expect(screen.getByText(message)).toBeTruthy()
      expect(screen.getByRole('button', { name: '다시 시도' })).toBeTruthy()
      expect(screen.queryByRole('combobox', { name: '버전' })).toBeNull()
      expect(screen.queryByRole('img', { name: '상품 상세 · PC' })).toBeNull()
      expect(screen.queryByRole('textbox', { name: '댓글' })).toBeNull()
      const secondVersion = deferred<VersionDetail>()
      vi.mocked(getVersion).mockReturnValueOnce(secondVersion.promise)
      await click('다시 시도')
      expect(vi.mocked(getVersion).mock.calls).toEqual([[current.id], [initial.id], [initial.id]])
      expect(queryParams().get('version')).toBe(initial.id)
      expect(queryParams().get('issue')).toBe(productIssue.id)
      await act(async () => secondVersion.resolve(initial))

      expect(photo().getAttribute('src')).toBe('/api/assets/old-current-product')
      expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '버전' }).value).toBe(initial.id)
      expect(screen.queryByText(message)).toBeNull()
      expect(screen.queryByRole('button', { name: '다시 시도' })).toBeNull()
      await chooseVersion(current.id)
      expect(photo().getAttribute('src')).toBe('/api/assets/current-product')
      expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '댓글' }).value).toBe(savedComment.body)
    },
  )

  it('다시 시도도 실패하면 문구와 버튼이 남고 한 번 더 눌러 성공하면 사진과 쓰던 글을 복구한다', async () => {
    await renderRoom()
    await click('쪽지 쓰기')
    fillDraft()
    const firstVersion = deferred<VersionDetail>()
    vi.mocked(getVersion).mockReturnValueOnce(firstVersion.promise)
    await chooseVersion(initial.id)
    await act(async () => firstVersion.reject(new ApiError(500)))
    expect(screen.getByText('잠시 뒤 다시 시도해 주세요')).toBeTruthy()
    expect(screen.getByRole('button', { name: '다시 시도' })).toBeTruthy()

    const secondVersion = deferred<VersionDetail>()
    vi.mocked(getVersion).mockReturnValueOnce(secondVersion.promise)
    await click('다시 시도')
    expect(vi.mocked(getVersion).mock.calls).toEqual([[current.id], [initial.id], [initial.id]])
    await act(async () => secondVersion.reject(new ApiError(500)))
    expect(screen.getByText('잠시 뒤 다시 시도해 주세요')).toBeTruthy()
    expect(screen.getByRole('button', { name: '다시 시도' })).toBeTruthy()
    expect(screen.queryByRole('combobox', { name: '버전' })).toBeNull()
    expect(screen.queryByRole('img', { name: '상품 상세 · PC' })).toBeNull()
    expectDraft()

    const thirdVersion = deferred<VersionDetail>()
    vi.mocked(getVersion).mockReturnValueOnce(thirdVersion.promise)
    await click('다시 시도')
    expect(vi.mocked(getVersion).mock.calls).toEqual([[current.id], [initial.id], [initial.id], [initial.id]])
    await act(async () => thirdVersion.resolve(initial))
    expect(photo().getAttribute('src')).toBe('/api/assets/old-current-product')
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '버전' }).value).toBe(initial.id)
    expect(screen.queryByText('잠시 뒤 다시 시도해 주세요')).toBeNull()
    expect(screen.queryByRole('button', { name: '다시 시도' })).toBeNull()
    expectDraft()
    await chooseVersion(current.id)
    expectDraft()
    expect(screen.getByRole('button', { name: '쪽지 남기기' })).toBeTruthy()
  })

  it('사진을 처음부터 정상으로 불러온 현재 버전과 지난 버전에는 다시 시도 버튼이 없다', async () => {
    await renderRoom()
    expect(photo().getAttribute('src')).toBe('/api/assets/current-product')
    expect(screen.queryByRole('button', { name: '다시 시도' })).toBeNull()

    await chooseVersion(initial.id)
    expect(photo().getAttribute('src')).toBe('/api/assets/old-current-product')
    expect(screen.queryByRole('button', { name: '다시 시도' })).toBeNull()
  })

  it('409 뒤 최신 버전 보기의 응답을 기다리는 사이 지난 버전을 고르면 응답 뒤에도 그 주소와 사진을 유지한다', async () => {
    vi.mocked(createComment).mockRejectedValueOnce(new ApiError(409, 'VERSION_CHANGED'))
    await renderRoom(`?version=${current.id}&issue=${productIssue.id}&keep=yes`)
    fillComment()
    await click('댓글 남기기')
    expect(screen.getByText('새 버전이 올라왔어요. 쓰던 글은 그대로 남아 있어요.')).toBeTruthy()

    publishLatest()
    const pendingProject = deferred<ProjectDetail>()
    vi.mocked(getProject).mockReturnValueOnce(pendingProject.promise)
    await click('최신 버전 보기')
    expect(getProject).toHaveBeenCalledTimes(2)
    await chooseVersion(initial.id)
    expect(queryParams().get('version')).toBe(initial.id)
    expect(photo().getAttribute('src')).toBe('/api/assets/old-current-product')
    await act(async () => {
      pendingProject.resolve({ ...project, currentVersion: { id: latest.id, number: 2 } })
    })

    expect(queryParams().get('version')).toBe(initial.id)
    expect(queryParams().get('issue')).toBe(productIssue.id)
    expect(queryParams().get('keep')).toBe('yes')
    expect(photo().getAttribute('src')).toBe('/api/assets/old-current-product')
    const versions = screen.getByRole<HTMLSelectElement>('combobox', { name: '버전' })
    expect(versions.value).toBe(initial.id)
    expect(Array.from(versions.options, (option) => option.value)).toEqual([latest.id, current.id, initial.id])
    expect(screen.queryByRole('textbox', { name: '댓글' })).toBeNull()

    // 프로젝트도 새 응답을 받았으므로, 직접 최신 버전을 고르면 쓰던 댓글을 이어 쓸 수 있다.
    await chooseVersion(latest.id)
    expect(photo().getAttribute('src')).toBe('/api/assets/new-current-product')
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '댓글' }).value).toBe(savedComment.body)
    expect(screen.getByRole('button', { name: '댓글 남기기' })).toBeTruthy()
  })

  it('409 뒤 최신 버전 응답을 기다리며 다른 버전을 골랐다가 원래 버전을 다시 고르면 마지막 선택을 유지한다', async () => {
    vi.mocked(createComment).mockRejectedValueOnce(new ApiError(409, 'VERSION_CHANGED'))
    await renderRoom(`?version=${current.id}&issue=${productIssue.id}&keep=yes`)
    fillComment()
    await click('댓글 남기기')
    expect(screen.getByText('새 버전이 올라왔어요. 쓰던 글은 그대로 남아 있어요.')).toBeTruthy()

    publishLatest()
    const pendingProject = deferred<ProjectDetail>()
    vi.mocked(getProject).mockReturnValueOnce(pendingProject.promise)
    await click('최신 버전 보기')
    expect(getProject).toHaveBeenCalledTimes(2)
    await chooseVersion(initial.id)
    expect(queryParams().get('version')).toBe(initial.id)
    expect(photo().getAttribute('src')).toBe('/api/assets/old-current-product')
    await chooseVersion(current.id)
    expect(queryParams().get('version')).toBe(current.id)
    expect(photo().getAttribute('src')).toBe('/api/assets/current-product')

    await act(async () => {
      pendingProject.resolve({ ...project, currentVersion: { id: latest.id, number: 2 } })
    })

    expect(queryParams().get('version')).toBe(current.id)
    expect(queryParams().get('issue')).toBe(productIssue.id)
    expect(queryParams().get('keep')).toBe('yes')
    expect(photo().getAttribute('src')).toBe('/api/assets/current-product')
    const versions = screen.getByRole<HTMLSelectElement>('combobox', { name: '버전' })
    expect(versions.value).toBe(current.id)
    expect(Array.from(versions.options, (option) => option.value)).toEqual([latest.id, current.id, initial.id])
    // 프로젝트의 현재 버전도 갱신돼, 직접 고른 원래 버전에서는 새 댓글을 쓰지 못한다.
    expect(screen.getByText(/지난 버전이에요/)).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: '댓글' })).toBeNull()
    await chooseVersion(latest.id)
    expect(photo().getAttribute('src')).toBe('/api/assets/new-current-product')
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '댓글' }).value).toBe(savedComment.body)
    expect(screen.getByRole('button', { name: '댓글 남기기' })).toBeTruthy()
  })

  it('409 뒤 최신 버전 응답을 기다리다 브라우저 뒤로 가기로 초안에 돌아가면 늦은 응답 뒤에도 초안 주소와 사진을 유지한다', async () => {
    vi.mocked(createComment).mockRejectedValueOnce(new ApiError(409, 'VERSION_CHANGED'))
    await renderRoom(`?version=${initial.id}&issue=${productIssue.id}&keep=yes`)
    await chooseVersion(current.id)
    expect(queryParams().get('version')).toBe(current.id)
    expect(photo().getAttribute('src')).toBe('/api/assets/current-product')
    fillComment()
    await click('댓글 남기기')
    expect(screen.getByText('새 버전이 올라왔어요. 쓰던 글은 그대로 남아 있어요.')).toBeTruthy()

    publishLatest()
    const pendingProject = deferred<ProjectDetail>()
    vi.mocked(getProject).mockReturnValueOnce(pendingProject.promise)
    await click('최신 버전 보기')
    expect(getProject).toHaveBeenCalledTimes(2)
    // 버전 고르기를 거치지 않고 주소 기록만 되돌린다.
    await click('브라우저 뒤로 가기')
    expect(queryParams().get('version')).toBe(initial.id)
    expect(photo().getAttribute('src')).toBe('/api/assets/old-current-product')

    await act(async () => {
      pendingProject.resolve({ ...project, currentVersion: { id: latest.id, number: 2 } })
    })

    expect(queryParams().get('version')).toBe(initial.id)
    expect(queryParams().get('issue')).toBe(productIssue.id)
    expect(queryParams().get('keep')).toBe('yes')
    expect(photo().getAttribute('src')).toBe('/api/assets/old-current-product')
    const versions = screen.getByRole<HTMLSelectElement>('combobox', { name: '버전' })
    expect(versions.value).toBe(initial.id)
    expect(Array.from(versions.options, (option) => option.value)).toEqual([latest.id, current.id, initial.id])
  })

  it('409 뒤 최신 버전 응답을 기다리다 브라우저 뒤로·앞으로 가기로 원래 버전에 돌아오면 늦은 응답 뒤에도 그 주소와 사진을 유지한다', async () => {
    vi.mocked(createComment).mockRejectedValueOnce(new ApiError(409, 'VERSION_CHANGED'))
    await renderRoom(`?version=${initial.id}&issue=${productIssue.id}&keep=yes`)
    await chooseVersion(current.id)
    expect(queryParams().get('version')).toBe(current.id)
    expect(photo().getAttribute('src')).toBe('/api/assets/current-product')
    fillComment()
    await click('댓글 남기기')
    expect(screen.getByText('새 버전이 올라왔어요. 쓰던 글은 그대로 남아 있어요.')).toBeTruthy()

    publishLatest()
    const pendingProject = deferred<ProjectDetail>()
    vi.mocked(getProject).mockReturnValueOnce(pendingProject.promise)
    await click('최신 버전 보기')
    expect(getProject).toHaveBeenCalledTimes(2)

    // 버전 고르기를 거치지 않고 주소 기록을 왕복해, 요청을 시작한 때와 같은 주소로 돌아온다.
    await click('브라우저 뒤로 가기')
    expect(queryParams().get('version')).toBe(initial.id)
    expect(photo().getAttribute('src')).toBe('/api/assets/old-current-product')
    await click('브라우저 앞으로 가기')
    expect(queryParams().get('version')).toBe(current.id)
    expect(photo().getAttribute('src')).toBe('/api/assets/current-product')

    await act(async () => {
      pendingProject.resolve({ ...project, currentVersion: { id: latest.id, number: 2 } })
    })

    expect(queryParams().get('version')).toBe(current.id)
    expect(queryParams().get('issue')).toBe(productIssue.id)
    expect(queryParams().get('keep')).toBe('yes')
    expect(photo().getAttribute('src')).toBe('/api/assets/current-product')
    const versions = screen.getByRole<HTMLSelectElement>('combobox', { name: '버전' })
    expect(versions.value).toBe(current.id)
    expect(Array.from(versions.options, (option) => option.value)).toEqual([latest.id, current.id, initial.id])
    expect(screen.getByText(/지난 버전이에요/)).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: '댓글' })).toBeNull()
  })

  it('409 뒤 지난 버전에서 최신 버전 응답을 기다리다 안내 링크로 이동하고 쪽지를 고르면 늦은 응답이 그 처음 사진을 바꾸지 않는다', async () => {
    vi.mocked(createComment).mockRejectedValueOnce(new ApiError(409, 'VERSION_CHANGED'))
    await renderRoom(`?version=${current.id}&issue=${productIssue.id}&keep=yes`)
    fillComment()
    await click('댓글 남기기')
    await chooseVersion(initial.id)
    expect(photo().getAttribute('src')).toBe('/api/assets/old-current-product')
    expect(screen.getByText('새 버전이 올라왔어요. 쓰던 글은 그대로 남아 있어요.')).toBeTruthy()

    publishLatest()
    const pendingProject = deferred<ProjectDetail>()
    vi.mocked(getProject).mockReturnValueOnce(pendingProject.promise)
    await click('최신 버전 보기')
    expect(getProject).toHaveBeenCalledTimes(2)
    // 요청을 시작한 뒤에는 버전 고르기를 쓰지 않고 안내 링크로만 버전을 바꾼다.
    await act(async () => {
      fireEvent.click(screen.getByRole('link', { name: '최신 버전 보기' }))
    })
    expect(queryParams().has('version')).toBe(false)
    expect(queryParams().get('issue')).toBe(productIssue.id)
    expect(photo().getAttribute('src')).toBe('/api/assets/current-product')
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '댓글' }).value).toBe(savedComment.body)
    await chooseIssue(oldIssue)
    fillComment()
    expect(photo().getAttribute('src')).toBe('/api/assets/old-current-product')

    await act(async () => {
      pendingProject.resolve({ ...project, currentVersion: { id: latest.id, number: 2 } })
    })

    expect(queryParams().has('version')).toBe(false)
    expect(queryParams().get('issue')).toBe(oldIssue.id)
    expect(queryParams().get('keep')).toBe('yes')
    // version 없는 주소는 새 최신 버전을 따르되, 사용자가 다시 연 쪽지의 처음 위치는 남는다.
    const versions = screen.getByRole<HTMLSelectElement>('combobox', { name: '버전' })
    expect(versions.value).toBe(latest.id)
    expect(Array.from(versions.options, (option) => option.value)).toEqual([latest.id, current.id, initial.id])
    expect(photo().getAttribute('src')).toBe('/api/assets/old-current-product')
    expect(screen.getByText('이 쪽지는 초안에 남긴 요청이에요. 처음 사진의 위치를 보여 드려요.')).toBeTruthy()
    expect(screen.getByRole('button', { name: pinName(oldIssue) }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('article', { name: '쪽지 #3' })).toBeTruthy()
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '댓글' }).value).toBe(savedComment.body)
  })

  it('처음 불러오기가 15초보다 늦으면 목록을 중복 요청하지 않고 받은 목록과 주소의 쪽지를 연 뒤 다음 15초에 갱신한다', async () => {
    vi.useFakeTimers()
    const pendingProject = deferred<ProjectDetail>()
    const pendingVersions = deferred<Awaited<ReturnType<typeof listVersions>>>()
    const pendingIssues = deferred<typeof issues>()
    vi.mocked(getProject).mockReturnValueOnce(pendingProject.promise)
    vi.mocked(listVersions).mockReturnValueOnce(pendingVersions.promise)
    vi.mocked(listIssues)
      .mockReturnValueOnce(pendingIssues.promise)
      .mockResolvedValue([savedIssue, ...issues])
    await renderRoom(`?issue=${productIssue.id}`)
    expect(getProject).toHaveBeenCalledTimes(1)
    expect(listVersions).toHaveBeenCalledTimes(1)
    expect(listIssues).toHaveBeenCalledTimes(1)

    await advance()
    expect(listIssues).toHaveBeenCalledTimes(1)
    expect(getIssue).not.toHaveBeenCalled()
    await act(async () => {
      pendingProject.resolve(project)
      pendingVersions.resolve([current, initial])
      pendingIssues.resolve(issues)
    })

    const list = screen.getByRole('region', { name: '쪽지 목록' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(issues.length)
    expect(within(list).getByRole('button', { name: new RegExp(productIssue.title) })).toBeTruthy()
    expect(within(list).queryByRole('button', { name: new RegExp(savedIssue.title) })).toBeNull()
    expect(screen.getByRole('article', { name: '쪽지 #1' })).toBeTruthy()
    expect(screen.getByText(productIssue.body)).toBeTruthy()
    expect(screen.queryByText('없는 쪽지예요')).toBeNull()
    expect(queryParams().get('issue')).toBe(productIssue.id)
    expect(listIssues).toHaveBeenCalledTimes(1)
    expect(getIssue).toHaveBeenCalledExactlyOnceWith(productIssue.id)

    await advance()
    expect(vi.mocked(listIssues).mock.calls).toEqual([[project.id], [project.id]])
    expect(vi.mocked(getIssue).mock.calls).toEqual([[productIssue.id], [productIssue.id]])
    expect(getProject).toHaveBeenCalledTimes(1)
    expect(listVersions).toHaveBeenCalledTimes(1)
    expect(within(list).getByRole('button', { name: new RegExp(savedIssue.title) })).toBeTruthy()
    expect(screen.getByRole('article', { name: '쪽지 #1' })).toBeTruthy()
  })
})

describe('ReviewRoomPage 쪽지 통합', () => {
  it('보고 있는 버전·화면의 핀만 보이며 화면을 바꾸면 그 화면의 핀으로 바뀐다', async () => {
    await renderRoom()
    expect(screen.getAllByRole('button', { name: /^쪽지 #/ }).map((pin) => pin.getAttribute('aria-label'))).toEqual([
      pinName(productIssue),
    ])
    expect(screen.getByRole('button', { name: pinName(productIssue) }).style.left).toBe('25%')
    expect(screen.getByRole('button', { name: pinName(productIssue) }).style.top).toBe('75%')
    expect(within(screen.getByRole('region', { name: '쪽지 목록' })).getAllByRole('listitem')).toHaveLength(4)
    await click('장바구니 · 모바일')
    expect(screen.getAllByRole('button', { name: /^쪽지 #/ }).map((pin) => pin.getAttribute('aria-label'))).toEqual([
      pinName(cartIssue),
    ])
    expect(photo('장바구니 · 모바일').getAttribute('src')).toBe('/api/assets/current-cart')
    await chooseVersion(initial.id)
    await click('상품 상세 · PC')
    expect(screen.getAllByRole('button', { name: /^쪽지 #/ }).map((pin) => pin.getAttribute('aria-label'))).toEqual([
      pinName(oldIssue),
    ])
  })

  it.each(['핀', '목록'] as const)(
    '%s으로 쪽지를 열면 주소·상세·선택 표시가 바뀌고 닫아도 version은 남는다',
    async (entry) => {
      await renderRoom(`?version=${current.id}&keep=yes`)
      if (entry === '핀') await click(pinName(productIssue))
      if (entry === '목록') await chooseIssue(cartIssue)
      const selected = entry === '핀' ? productIssue : cartIssue
      expect(queryParams().get('issue')).toBe(selected.id)
      expect(queryParams().get('version')).toBe(current.id)
      expect(getIssue).toHaveBeenCalledExactlyOnceWith(selected.id)
      expect(screen.getByRole('article', { name: `쪽지 #${selected.number}` })).toBeTruthy()
      expect(photo(entry === '핀' ? '상품 상세 · PC' : '장바구니 · 모바일').getAttribute('src')).toBe(
        `/api/assets/${selected.origin!.asset.id}`,
      )
      expect(screen.getByRole('button', { name: pinName(selected) }).getAttribute('aria-pressed')).toBe('true')
      expect(
        screen
          .getByRole('button', { name: entry === '핀' ? '상품 상세 · PC' : '장바구니 · 모바일' })
          .getAttribute('aria-pressed'),
      ).toBe('true')
      await click('쪽지 닫기')
      expect(queryParams().has('issue')).toBe(false)
      expect(queryParams().get('version')).toBe(current.id)
      expect(queryParams().get('keep')).toBe('yes')
      expect(screen.queryByRole('article')).toBeNull()
    },
  )

  it('주소에 다른 프로젝트의 쪽지나 없는 쪽지를 넣으면 없는 쪽지 안내가 보이고 그 쪽지 내용은 보이지 않는다', async () => {
    const foreign = { ...productIssue, id: 'a9999999-9999-4999-8999-999999999999', title: '남의 프로젝트 비밀' }
    // 서버가 이 쪽지를 줄 수 있어도 프로젝트 목록에 없으면 상세 요청 자체를 막아야 한다.
    vi.mocked(getIssue).mockResolvedValue(foreign)
    await renderRoom(`?issue=${foreign.id}`)
    expect(screen.getByText('없는 쪽지예요.')).toBeTruthy()
    expect(screen.getByRole('region', { name: '쪽지 목록' })).toBeTruthy()
    expect(getIssue).not.toHaveBeenCalled()
    expect(screen.queryByText(foreign.title)).toBeNull()
    expect(screen.queryByRole('article')).toBeNull()
  })

  it.each(['a8888888-8888-4888-8888-888888888888', 'not-a-uuid', ''])(
    '주소의 없는·틀린·빈 쪽지 id(%s)는 상세를 부르지 않는다',
    async (id) => {
      await renderRoom(`?issue=${id}`)
      expect(screen.getByText('없는 쪽지예요.')).toBeTruthy()
      expect(getIssue).not.toHaveBeenCalled()
    },
  )

  it('주소의 대문자 쪽지 id는 목록의 같은 쪽지를 열고 그 화면과 핀을 고른다', async () => {
    await renderRoom(`?issue=${cartIssue.id.toUpperCase()}`)
    expect(getIssue).toHaveBeenCalledExactlyOnceWith(cartIssue.id)
    expect(screen.getByRole('heading', { name: cartIssue.title })).toBeTruthy()
    expect(photo('장바구니 · 모바일').getAttribute('src')).toBe('/api/assets/current-cart')
    expect(screen.getByRole('button', { name: pinName(cartIssue) }).getAttribute('aria-pressed')).toBe('true')
  })

  it('지난 버전에 남긴 쪽지를 고르면 처음 사진과 그 자리의 핀을 보여 준다', async () => {
    await renderRoom(`?issue=${oldIssue.id}`)
    expect(photo().getAttribute('src')).toBe(`/api/assets/${oldIssue.origin!.asset.id}`)
    expect(screen.getByText('이 쪽지는 초안에 남긴 요청이에요. 처음 사진의 위치를 보여 드려요.')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /^쪽지 #/ })).toHaveLength(1)
    const pin = screen.getByRole('button', { name: pinName(oldIssue) })
    expect(pin.style.left).toBe('25%')
    expect(pin.style.top).toBe('75%')
    expect(pin.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: '상품 상세 · PC' }).getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByRole('button', { name: '장바구니 · 모바일' }).getAttribute('aria-pressed')).toBe('false')
    await click('장바구니 · 모바일')
    expect(photo('장바구니 · 모바일').getAttribute('src')).toBe('/api/assets/current-cart')
    expect(screen.queryByText(/이 쪽지는 초안에 남긴 요청이에요/)).toBeNull()
    expect(screen.getByRole('button', { name: pinName(cartIssue) })).toBeTruthy()
  })

  it('지난 버전에 남긴 쪽지에도 댓글과 수정 시작은 되지만 그 처음 사진에는 새 핀이 생기지 않는다', async () => {
    await renderRoom(`?issue=${oldIssue.id}`)
    await placePin()
    expect(screen.queryByRole('img', { name: '새 쪽지 위치' })).toBeNull()
    expect(screen.queryByRole('textbox', { name: '제목 (필수)' })).toBeNull()
    expect(screen.getByRole('button', { name: '쪽지 쓰기' })).toBeTruthy()
    expect(screen.getByLabelText('참고 사진 붙이기')).toBeTruthy()
    fillComment()
    await click('댓글 남기기')
    expect(createComment).toHaveBeenCalledWith(oldIssue.id, {
      requestId: expect.any(String),
      versionId: current.id,
      body: savedComment.body,
    })
    vi.mocked(startIssue).mockResolvedValueOnce({ ...oldIssue, status: 'IN_PROGRESS' })
    vi.mocked(getIssue).mockResolvedValue({ ...oldIssue, status: 'IN_PROGRESS' })
    await click('수정 시작')
    expect(startIssue).toHaveBeenCalledExactlyOnceWith(oldIssue.id, current.id)
  })

  it('지난 버전의 위치 없는 쪽지는 현재 사진을 그대로 두고 새 핀을 찍을 수 있다', async () => {
    const oldUnpinned = { ...unpinnedIssue, originVersion: oldIssue.originVersion }
    vi.mocked(listIssues).mockResolvedValue([oldUnpinned])
    vi.mocked(getIssue).mockResolvedValue(oldUnpinned)
    await renderRoom(`?issue=${oldUnpinned.id}`)
    expect(photo().getAttribute('src')).toBe('/api/assets/current-product')
    expect(screen.queryByText(/처음 사진의 위치를 보여 드려요/)).toBeNull()
    await placePin()
    expect(screen.getByRole('img', { name: '새 쪽지 위치' })).toBeTruthy()
  })

  it.each([
    { name: '지난 버전을 볼 때는 쪽지를 읽기만 하고 사진을 눌러도 쓰기 칸이 열리지 않는다', past: true },
    {
      name: '현재 버전이 승인되면 읽기 전용 안내가 보이고 쪽지·댓글·수정 시작·참고 사진 입력과 지우기가 모두 없다',
      past: false,
    },
  ])('$name', async ({ past }) => {
    if (!past) vi.mocked(getVersion).mockResolvedValue({ ...current, status: 'APPROVED' })
    await renderRoom(`?issue=${productIssue.id}${past ? `&version=${initial.id}` : ''}`)
    expect(screen.getByText('읽기 전용이에요. 쪽지와 댓글은 바꿀 수 없어요.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '쪽지 쓰기' })).toBeNull()
    expect(screen.queryByRole('textbox', { name: '댓글' })).toBeNull()
    expect(screen.queryByRole('button', { name: '수정 시작' })).toBeNull()
    expect(screen.queryByLabelText('참고 사진 붙이기')).toBeNull()
    expect(screen.queryByRole('button', { name: '지우기' })).toBeNull()
    expect(screen.getByRole('img', { name: '참고 사진 1' })).toBeTruthy()
    // 처음 위치 사진이 아니라 고른 버전의 사진에서도 새 핀은 막혀야 한다.
    await click('상품 상세 · PC')
    await placePin()
    expect(screen.queryByRole('img', { name: '새 쪽지 위치' })).toBeNull()
    expect(screen.queryByRole('textbox', { name: '제목 (필수)' })).toBeNull()
    expect(createIssue).not.toHaveBeenCalled()
  })

  it('현재 검수 중 버전에서는 쪽지·댓글·수정 시작·참고 사진 입력과 지우기가 보인다', async () => {
    await renderRoom(`?issue=${productIssue.id}`)
    expect(screen.getByRole('button', { name: '쪽지 쓰기' })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: '댓글' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '수정 시작' })).toBeTruthy()
    expect(screen.getByLabelText('참고 사진 붙이기')).toBeTruthy()
    expect(screen.getByRole('button', { name: '지우기' })).toBeTruthy()
    await placePin()
    expect(screen.getByRole('textbox', { name: '제목 (필수)' })).toBeTruthy()
    expect(screen.getByRole('img', { name: '새 쪽지 위치' })).toBeTruthy()
  })

  it('개발자가 수정 시작을 누르면 수정 중이 되고 클라이언트에게는 그 버튼이 없다', async () => {
    const view = await renderRoom(`?issue=${productIssue.id}`)
    vi.mocked(getIssue).mockResolvedValue({ ...productIssue, status: 'IN_PROGRESS' })
    await click('수정 시작')
    expect(startIssue).toHaveBeenCalledExactlyOnceWith(productIssue.id, current.id)
    expect(within(screen.getByRole('article', { name: '쪽지 #1' })).getByText('수정 중')).toBeTruthy()
    view.unmount()
    vi.mocked(getIssue).mockResolvedValue(productIssue)
    vi.mocked(getProject).mockResolvedValue({ ...project, myRole: 'CLIENT' })
    await renderRoom(`?issue=${productIssue.id}`)
    expect(screen.queryByRole('button', { name: '수정 시작' })).toBeNull()
    expect(screen.getByRole('textbox', { name: '댓글' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '쪽지 쓰기' })).toBeTruthy()
  })

  it('개발자라도 남이 쓴 쪽지에는 참고 사진을 붙이거나 지우는 입력이 없다', async () => {
    vi.mocked(getIssue).mockResolvedValue({ ...productIssue, isMine: false })
    await renderRoom(`?issue=${productIssue.id}`)
    expect(screen.queryByLabelText('참고 사진 붙이기')).toBeNull()
    expect(screen.queryByRole('button', { name: '지우기' })).toBeNull()
    expect(screen.getByRole('button', { name: '수정 시작' })).toBeTruthy()
  })
})

describe('ReviewRoomPage 지난 버전의 상태가 IN_REVIEW인 경우', () => {
  it('지난 버전을 볼 때는 쪽지를 읽기만 하고 사진을 눌러도 쓰기 칸이 열리지 않는다', async () => {
    // 새 버전을 게시해도 직전 버전의 상태는 IN_REVIEW로 남는다.
    publishLatest()
    await renderRoom(`?version=${current.id}&issue=${productIssue.id}`)
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '버전' }).value).toBe(current.id)
    expect(screen.getByRole('article', { name: '쪽지 #1' })).toBeTruthy()
    expect(screen.getByText(productIssue.body)).toBeTruthy()
    expect(screen.getByRole('img', { name: '참고 사진 1' })).toBeTruthy()
    expect(screen.getByText('읽기 전용이에요. 쪽지와 댓글은 바꿀 수 없어요.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '쪽지 쓰기' })).toBeNull()
    expect(screen.queryByRole('textbox', { name: '댓글' })).toBeNull()
    expect(screen.queryByRole('button', { name: '수정 시작' })).toBeNull()
    expect(screen.queryByLabelText('참고 사진 붙이기')).toBeNull()
    expect(screen.queryByRole('button', { name: '지우기' })).toBeNull()
    expect(photo().getAttribute('src')).toBe('/api/assets/current-product')
    await placePin()
    expect(screen.queryByRole('img', { name: '새 쪽지 위치' })).toBeNull()
    expect(screen.queryByRole('textbox', { name: '제목 (필수)' })).toBeNull()
    expect(screen.queryByRole('textbox', { name: '내용' })).toBeNull()
    expect(createIssue).not.toHaveBeenCalled()
    expect(createComment).not.toHaveBeenCalled()
    expect(startIssue).not.toHaveBeenCalled()
    expect(attachIssuePhoto).not.toHaveBeenCalled()
    expect(removeIssuePhoto).not.toHaveBeenCalled()
  })
})

describe('ReviewRoomPage 쪽지 작성과 재시도', () => {
  it('사진을 눌러 핀 쪽지를 남기고 위치 없는 쪽지와 댓글을 쓴다', async () => {
    await renderRoom()
    await placePin()
    const draft = screen.getByRole('img', { name: '새 쪽지 위치' })
    expect(draft.style.left).toBe('25%')
    expect(draft.style.top).toBe('75%')
    fillDraft()
    await click('쪽지 남기기')
    expect(createIssue).toHaveBeenCalledExactlyOnceWith(project.id, {
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
      versionId: current.id,
      title: savedIssue.title,
      body: savedIssue.body,
      pin: { screenId: current.screens[0].screenId, xRatio: 0.25, yRatio: 0.75 },
    })
    expect(screen.queryByRole('textbox', { name: '제목 (필수)' })).toBeNull()
    expect(screen.queryByRole('img', { name: '새 쪽지 위치' })).toBeNull()
    expect(queryParams().get('issue')).toBe(savedIssue.id)
    expect(screen.getByRole('article', { name: '쪽지 #5' })).toBeTruthy()
    expect(screen.getByRole('button', { name: pinName(savedIssue) }).getAttribute('aria-pressed')).toBe('true')
    expect(within(screen.getByRole('region', { name: '쪽지 목록' })).getByText(savedIssue.title)).toBeTruthy()

    fillComment()
    vi.mocked(listIssues).mockResolvedValue([savedIssue, ...issues])
    vi.mocked(getIssue).mockResolvedValue({ ...savedIssue, comments: [savedComment], commentCount: 1 })
    await click('댓글 남기기')
    expect(createComment).toHaveBeenCalledExactlyOnceWith(savedIssue.id, {
      requestId: expect.any(String),
      versionId: current.id,
      body: savedComment.body,
    })
    expect(screen.getByText(savedComment.body)).toBeTruthy()
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '댓글' }).value).toBe('')

    const firstRequestId = vi.mocked(createIssue).mock.calls[0][1].requestId
    const savedUnpinned = {
      ...savedIssue,
      id: 'a6666666-6666-4666-8666-666666666666',
      number: 6,
      origin: null,
    }
    vi.mocked(createIssue).mockResolvedValueOnce(savedUnpinned)
    vi.mocked(getIssue).mockResolvedValueOnce(savedUnpinned)
    await click('쪽지 쓰기')
    expect(queryParams().has('issue')).toBe(false)
    fillDraft()
    await click('쪽지 남기기')
    expect(vi.mocked(createIssue).mock.calls[1][1]).toEqual({
      requestId: expect.any(String),
      versionId: current.id,
      title: savedIssue.title,
      body: savedIssue.body,
      pin: undefined,
    })
    expect(vi.mocked(createIssue).mock.calls[1][1].requestId).not.toBe(firstRequestId)
    expect(queryParams().get('issue')).toBe(savedUnpinned.id)
    expect(screen.getByRole('article', { name: '쪽지 #6' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: pinName(savedUnpinned) })).toBeNull()
  })

  it('핀을 찍고 다른 화면을 고르면 핀이 지워지고 글은 남으며 그대로 남기면 위치 없는 쪽지가 된다', async () => {
    await renderRoom()
    await placePin()
    fillDraft()
    await click('장바구니 · 모바일')
    expectDraft()
    expect(screen.queryByRole('img', { name: '새 쪽지 위치' })).toBeNull()
    await click('쪽지 남기기')
    expect(createIssue).toHaveBeenCalledWith(project.id, {
      requestId: expect.any(String),
      versionId: current.id,
      title: savedIssue.title,
      body: savedIssue.body,
      pin: undefined,
    })
  })

  it('작성 중 지난 버전을 골랐다 돌아와도 제목·내용은 남고 핀 없이 보낸다', async () => {
    await renderRoom()
    await placePin()
    fillDraft()
    await chooseVersion(initial.id)
    expect(screen.queryByRole('img', { name: '새 쪽지 위치' })).toBeNull()
    await chooseVersion(current.id)
    expectDraft()
    await click('쪽지 남기기')
    expect(createIssue).toHaveBeenCalledWith(project.id, {
      requestId: expect.any(String),
      versionId: current.id,
      title: savedIssue.title,
      body: savedIssue.body,
      pin: undefined,
    })
  })

  it('위치 없이 쓰기는 핀만 지우고 취소는 쓰기 칸을 닫으며 다음 글은 새 requestId를 쓴다', async () => {
    vi.mocked(createIssue).mockRejectedValueOnce(new ApiError(422))
    await renderRoom()
    await placePin()
    fillDraft()
    await click('위치 없이 쓰기')
    expectDraft()
    expect(screen.queryByRole('img', { name: '새 쪽지 위치' })).toBeNull()
    await click('쪽지 남기기')
    const first = vi.mocked(createIssue).mock.calls[0][1]
    expect(first.pin).toBeUndefined()
    await click('취소')
    expect(screen.queryByRole('textbox', { name: '제목 (필수)' })).toBeNull()
    expect(screen.getByRole('region', { name: '쪽지 목록' })).toBeTruthy()
    await click('쪽지 쓰기')
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: '제목 (필수)' }).value).toBe('')
    fillDraft()
    await click('쪽지 남기기')
    expect(vi.mocked(createIssue).mock.calls[1][1].requestId).not.toBe(first.requestId)
  })

  it('쓰는 중 핀을 눌러도 다른 쪽지가 열리지 않고 글과 임시 핀이 남는다', async () => {
    await renderRoom()
    await placePin()
    fillDraft()
    await click(pinName(productIssue))
    expect(getIssue).not.toHaveBeenCalled()
    expect(queryParams().has('issue')).toBe(false)
    expectDraft()
    expect(screen.getByRole('img', { name: '새 쪽지 위치' }).style.left).toBe('25%')
  })

  it('작성 중 새 사진을 누르면 보존한 글과 그 화면의 새 좌표를 보낸다', async () => {
    await renderRoom()
    await placePin()
    fillDraft()
    await click('장바구니 · 모바일')
    await placePin('장바구니 · 모바일', 420, 90)
    expectDraft()
    await click('쪽지 남기기')
    expect(vi.mocked(createIssue).mock.calls[0][1].pin).toEqual({
      screenId: current.screens[1].screenId,
      xRatio: 0.8,
      yRatio: 0.1,
    })
  })

  it('응답이 끊겨 잠긴 뒤 다른 화면이나 지난 버전을 골라도 다시 보내기가 남아 있고 처음 찍은 화면과 자리에 쪽지가 저장된다', async () => {
    vi.mocked(createIssue).mockRejectedValueOnce(new TypeError('연결 끊김'))
    await renderRoom()
    await placePin()
    fillDraft()
    await click('쪽지 남기기')
    const first = vi.mocked(createIssue).mock.calls[0]
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: '제목 (필수)' }).readOnly).toBe(true)
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '내용' }).readOnly).toBe(true)
    expect(screen.getByRole('img', { name: '새 쪽지 위치' }).style.left).toBe('25%')
    expect(screen.getByRole('img', { name: '새 쪽지 위치' }).style.top).toBe('75%')
    await click('장바구니 · 모바일')
    expect(photo('장바구니 · 모바일').getAttribute('src')).toBe('/api/assets/current-cart')
    expect(screen.queryByRole('img', { name: '새 쪽지 위치' })).toBeNull()
    expectDraft()
    expect(screen.getByRole('button', { name: '다시 보내기' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '취소' })).toBeTruthy()
    await click('상품 상세 · PC')
    expect(photo().getAttribute('src')).toBe('/api/assets/current-product')
    expect(screen.getByRole('img', { name: '새 쪽지 위치' }).style.left).toBe('25%')
    expect(screen.getByRole('img', { name: '새 쪽지 위치' }).style.top).toBe('75%')
    // 화면 id가 같아도 버전이 다르면 그 사진에는 임시 핀을 그리지 않는다.
    await chooseVersion(initial.id)
    expect(photo().getAttribute('src')).toBe('/api/assets/old-current-product')
    expect(screen.queryByRole('img', { name: '새 쪽지 위치' })).toBeNull()
    await chooseVersion(current.id)
    expect(photo().getAttribute('src')).toBe('/api/assets/current-product')
    expect(screen.getByRole('img', { name: '새 쪽지 위치' }).style.left).toBe('25%')
    expect(screen.getByRole('img', { name: '새 쪽지 위치' }).style.top).toBe('75%')
    await chooseVersion(initial.id)
    expectDraft()
    expect(screen.getByRole('button', { name: '다시 보내기' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '취소' })).toBeTruthy()
    await click('다시 보내기')
    expect(createIssue).toHaveBeenCalledTimes(2)
    expect(vi.mocked(createIssue).mock.calls[1]).toEqual(first)
    expect(first[1].pin).toEqual({ screenId: current.screens[0].screenId, xRatio: 0.25, yRatio: 0.75 })
    expect(first[1].versionId).toBe(current.id)
  })

  it('연결 실패로 잠긴 동안 사진을 눌러도 핀과 처음 요청이 바뀌지 않는다', async () => {
    vi.mocked(createIssue).mockRejectedValueOnce(new TypeError('연결 끊김'))
    await renderRoom()
    await placePin()
    fillDraft()
    await click('쪽지 남기기')
    const first = vi.mocked(createIssue).mock.calls[0]
    await placePin('상품 상세 · PC', 420, 90)
    expectDraft()
    expect(screen.getByRole('img', { name: '새 쪽지 위치' }).style.left).toBe('25%')
    expect(screen.getByRole('img', { name: '새 쪽지 위치' }).style.top).toBe('75%')
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '내용' }).readOnly).toBe(true)
    await click('장바구니 · 모바일')
    await placePin('장바구니 · 모바일', 420, 90)
    await click('상품 상세 · PC')
    expect(screen.getByRole('img', { name: '새 쪽지 위치' }).style.left).toBe('25%')
    await click('다시 보내기')
    expect(vi.mocked(createIssue).mock.calls[1]).toEqual(first)
  })

  it('잠긴 댓글도 지난 버전을 골라도 글과 다시 보내기가 남고 처음 versionId로 보낸다', async () => {
    vi.mocked(createComment).mockRejectedValueOnce(new TypeError('연결 끊김'))
    await renderRoom(`?issue=${productIssue.id}`)
    fillComment()
    await click('댓글 남기기')
    const first = vi.mocked(createComment).mock.calls[0]
    await chooseVersion(initial.id)
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '댓글' }).value).toBe(savedComment.body)
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '댓글' }).readOnly).toBe(true)
    expect(screen.getByRole('button', { name: '취소' })).toBeTruthy()
    await click('다시 보내기')
    expect(vi.mocked(createComment).mock.calls[1]).toEqual(first)
  })

  it('핀 쪽지를 쓰는 사이 새 버전이 올라오면 글은 남고 핀은 지워지며 새 사진에서 다시 고른 자리에 저장된다', async () => {
    vi.mocked(createIssue).mockRejectedValueOnce(new ApiError(409, 'VERSION_CHANGED'))
    await renderRoom(`?version=${current.id}`)
    await placePin()
    fillDraft()
    await click('쪽지 남기기')
    expect(screen.getByText('새 버전이 올라왔어요. 쓰던 글은 그대로 남아 있어요.')).toBeTruthy()
    publishLatest()
    await click('최신 버전 보기')
    expect(getProject).toHaveBeenCalledTimes(2)
    expect(listVersions).toHaveBeenCalledTimes(2)
    expect(listIssues).toHaveBeenCalledTimes(2)
    expect(queryParams().has('version')).toBe(false)
    expect(photo().getAttribute('src')).toBe('/api/assets/new-current-product')
    expect(screen.queryByRole('img', { name: '새 쪽지 위치' })).toBeNull()
    expectDraft()
    await placePin('상품 상세 · PC', 420, 90)
    await click('쪽지 남기기')
    expect(vi.mocked(createIssue).mock.calls[1][1]).toEqual({
      requestId: vi.mocked(createIssue).mock.calls[0][1].requestId,
      versionId: latest.id,
      title: savedIssue.title,
      body: savedIssue.body,
      pin: { screenId: latest.screens[0].screenId, xRatio: 0.8, yRatio: 0.1 },
    })
  })

  it('댓글을 쓰는 사이 새 버전이 올라오면 안내가 보이고 쓰던 글이 남으며 최신 버전에서 다시 보내면 저장된다', async () => {
    vi.mocked(createComment).mockRejectedValueOnce(new ApiError(409, 'VERSION_CHANGED'))
    await renderRoom(`?version=${current.id}&issue=${productIssue.id}`)
    fillComment()
    await click('댓글 남기기')
    expect(screen.getByText('새 버전이 올라왔어요. 쓰던 글은 그대로 남아 있어요.')).toBeTruthy()
    publishLatest()
    await click('최신 버전 보기')
    expect(getProject).toHaveBeenCalledTimes(2)
    expect(listVersions).toHaveBeenCalledTimes(2)
    expect(listIssues).toHaveBeenCalledTimes(2)
    expect(queryParams().has('version')).toBe(false)
    expect(queryParams().get('issue')).toBe(productIssue.id)
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '댓글' }).value).toBe(savedComment.body)
    await click('댓글 남기기')
    expect(vi.mocked(createComment).mock.calls[1]).toEqual([
      productIssue.id,
      {
        requestId: vi.mocked(createComment).mock.calls[0][1].requestId,
        versionId: latest.id,
        body: savedComment.body,
      },
    ])
  })

  it('응답이 끊겨 잠긴 글을 다시 보내 새 버전 안내를 받으면 잠금이 풀리고 최신 버전에서 저장된다', async () => {
    vi.mocked(createComment)
      .mockRejectedValueOnce(new TypeError('연결 끊김'))
      .mockRejectedValueOnce(new ApiError(409, 'VERSION_CHANGED'))
    await renderRoom(`?issue=${productIssue.id}`)
    fillComment()
    await click('댓글 남기기')
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '댓글' }).readOnly).toBe(true)
    await click('다시 보내기')
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '댓글' }).readOnly).toBe(false)
    expect(screen.queryByRole('button', { name: '다시 보내기' })).toBeNull()
    publishLatest()
    await click('최신 버전 보기')
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '댓글' }).value).toBe(savedComment.body)
    await click('댓글 남기기')
    expect(vi.mocked(createComment).mock.calls[2][1]).toEqual({
      requestId: vi.mocked(createComment).mock.calls[0][1].requestId,
      versionId: latest.id,
      body: savedComment.body,
    })
  })

  it.each(['getProject', 'listVersions', 'listIssues'] as const)(
    '핀 쪽지의 최신 버전 보기에서 %s가 실패하면 글·주소·핀을 보존하고 재시도가 모두 끝난 뒤에만 전환한다',
    async (failedRequest) => {
      vi.mocked(createIssue).mockRejectedValueOnce(new ApiError(409, 'VERSION_CHANGED'))
      await renderRoom(`?version=${current.id}&keep=yes`)
      await placePin()
      fillDraft()
      await click('쪽지 남기기')
      const address = screen.getByLabelText('현재 주소').textContent
      publishLatest()
      vi.mocked({ getProject, listVersions, listIssues }[failedRequest]).mockRejectedValueOnce(new ApiError(500))

      await click('최신 버전 보기')
      expect(screen.getByRole('heading', { name: project.name })).toBeTruthy()
      expect(screen.getByLabelText('현재 주소').textContent).toBe(address)
      expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '버전' }).value).toBe(current.id)
      expect(photo().getAttribute('src')).toBe('/api/assets/current-product')
      expectDraft()
      expect(screen.getByRole('img', { name: '새 쪽지 위치' }).style.left).toBe('25%')
      expect(screen.getByRole('img', { name: '새 쪽지 위치' }).style.top).toBe('75%')
      expect(createIssue).toHaveBeenCalledTimes(1)
      expect(getVersion).toHaveBeenCalledExactlyOnceWith(current.id)
      expect(getProject).toHaveBeenCalledTimes(2)
      expect(listVersions).toHaveBeenCalledTimes(2)
      expect(listIssues).toHaveBeenCalledTimes(2)

      // 프로젝트와 버전 목록이 먼저 와도 마지막 쪽지 목록 응답까지 기다린다.
      const pending = deferred<typeof issues>()
      vi.mocked(listIssues).mockReturnValueOnce(pending.promise)
      await click('최신 버전 보기')
      expect(screen.getByLabelText('현재 주소').textContent).toBe(address)
      expect(photo().getAttribute('src')).toBe('/api/assets/current-product')
      expectDraft()
      expect(screen.getByRole('img', { name: '새 쪽지 위치' }).style.left).toBe('25%')
      expect(screen.getByRole('img', { name: '새 쪽지 위치' }).style.top).toBe('75%')
      expect(getVersion).toHaveBeenCalledExactlyOnceWith(current.id)
      await act(async () => {
        pending.resolve(issues)
      })

      expect(getProject).toHaveBeenCalledTimes(3)
      expect(listVersions).toHaveBeenCalledTimes(3)
      expect(listIssues).toHaveBeenCalledTimes(3)
      expect(queryParams().has('version')).toBe(false)
      expect(queryParams().get('keep')).toBe('yes')
      expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '버전' }).value).toBe(latest.id)
      expect(photo().getAttribute('src')).toBe('/api/assets/new-current-product')
      expect(screen.queryByRole('img', { name: '새 쪽지 위치' })).toBeNull()
      expectDraft()
      await click('쪽지 남기기')
      expect(vi.mocked(createIssue).mock.calls[1][1]).toEqual({
        requestId: vi.mocked(createIssue).mock.calls[0][1].requestId,
        versionId: latest.id,
        title: savedIssue.title,
        body: savedIssue.body,
        pin: undefined,
      })
    },
  )

  it.each(['getProject', 'listVersions', 'listIssues'] as const)(
    '댓글의 최신 버전 보기에서 %s가 실패하면 상세·글·주소를 보존하고 재시도가 모두 끝난 뒤에만 전환한다',
    async (failedRequest) => {
      vi.mocked(createComment).mockRejectedValueOnce(new ApiError(409, 'VERSION_CHANGED'))
      await renderRoom(`?version=${current.id}&issue=${productIssue.id}&keep=yes`)
      fillComment()
      await click('댓글 남기기')
      const address = screen.getByLabelText('현재 주소').textContent
      publishLatest()
      vi.mocked({ getProject, listVersions, listIssues }[failedRequest]).mockRejectedValueOnce(new ApiError(500))

      await click('최신 버전 보기')
      expect(screen.getByRole('heading', { name: project.name })).toBeTruthy()
      expect(screen.getByRole('region', { name: '쪽지 목록' })).toBeTruthy()
      expect(screen.getByRole('article', { name: '쪽지 #1' })).toBeTruthy()
      expect(screen.getByLabelText('현재 주소').textContent).toBe(address)
      expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '버전' }).value).toBe(current.id)
      expect(photo().getAttribute('src')).toBe('/api/assets/current-product')
      expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '댓글' }).value).toBe(savedComment.body)
      expect(screen.getByRole('button', { name: pinName(productIssue) }).getAttribute('aria-pressed')).toBe('true')
      expect(createComment).toHaveBeenCalledTimes(1)
      expect(getVersion).toHaveBeenCalledExactlyOnceWith(current.id)
      expect(getProject).toHaveBeenCalledTimes(2)
      expect(listVersions).toHaveBeenCalledTimes(2)
      expect(listIssues).toHaveBeenCalledTimes(2)

      const pending = deferred<typeof issues>()
      vi.mocked(listIssues).mockReturnValueOnce(pending.promise)
      await click('최신 버전 보기')
      expect(screen.getByLabelText('현재 주소').textContent).toBe(address)
      expect(photo().getAttribute('src')).toBe('/api/assets/current-product')
      expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '댓글' }).value).toBe(savedComment.body)
      expect(getVersion).toHaveBeenCalledExactlyOnceWith(current.id)
      await act(async () => {
        pending.resolve(issues)
      })

      expect(getProject).toHaveBeenCalledTimes(3)
      expect(listVersions).toHaveBeenCalledTimes(3)
      expect(listIssues).toHaveBeenCalledTimes(3)
      expect(queryParams().has('version')).toBe(false)
      expect(queryParams().get('issue')).toBe(productIssue.id)
      expect(queryParams().get('keep')).toBe('yes')
      expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '버전' }).value).toBe(latest.id)
      expect(photo().getAttribute('src')).toBe('/api/assets/new-current-product')
      expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '댓글' }).value).toBe(savedComment.body)
      await click('댓글 남기기')
      expect(vi.mocked(createComment).mock.calls[1]).toEqual([
        productIssue.id,
        {
          requestId: vi.mocked(createComment).mock.calls[0][1].requestId,
          versionId: latest.id,
          body: savedComment.body,
        },
      ])
    },
  )

  it.each([
    { title: '쪽지를 보낼 때 로그인이 끝났으면 새 탭에서 로그인한 뒤 글을 다시 쓰지 않고 저장한다', comment: false },
    { title: '댓글을 보낼 때 로그인이 끝났으면 새 탭에서 로그인한 뒤 글을 다시 쓰지 않고 저장한다', comment: true },
  ])('$title', async ({ comment }) => {
    await renderRoom(`?issue=${productIssue.id}`)
    if (comment) {
      vi.mocked(createComment).mockRejectedValueOnce(new ApiError(401))
      fillComment()
      await click('댓글 남기기')
    } else {
      vi.mocked(createIssue).mockRejectedValueOnce(new ApiError(401))
      await placePin()
      fillDraft()
      await click('쪽지 남기기')
    }
    const login = screen.getByRole('link', { name: /로그인/ })
    expect(login.getAttribute('target')).toBe('_blank')
    expect(login.getAttribute('href')).toBe('/login')
    expect(screen.queryByRole('button', { name: '다시 보내기' })).toBeNull()
    if (comment) {
      expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '댓글' }).value).toBe(savedComment.body)
      await click('댓글 남기기')
      expect(vi.mocked(createComment).mock.calls[1]).toEqual(vi.mocked(createComment).mock.calls[0])
      return
    }
    expectDraft()
    expect(screen.getByRole('img', { name: '새 쪽지 위치' })).toBeTruthy()
    await click('쪽지 남기기')
    expect(vi.mocked(createIssue).mock.calls[1]).toEqual(vi.mocked(createIssue).mock.calls[0])
  })
})

describe('ReviewRoomPage 쪽지 갱신', () => {
  it('다른 사람이 쓴 쪽지와 댓글이 새로고침 없이 보이고 쓰던 글은 그대로다', async () => {
    vi.useFakeTimers()
    await renderRoom(`?issue=${productIssue.id}`)
    fillComment()
    vi.mocked(listIssues).mockResolvedValue([savedIssue, ...issues])
    vi.mocked(getIssue).mockResolvedValue({
      ...productIssue,
      comments: [{ ...savedComment, body: '다른 사람이 남긴 댓글' }],
      commentCount: 1,
    })
    await advance(14_999)
    expect(listIssues).toHaveBeenCalledTimes(1)
    expect(getIssue).toHaveBeenCalledTimes(1)
    await advance(1)
    expect(listIssues).toHaveBeenCalledTimes(2)
    expect(getIssue).toHaveBeenCalledTimes(2)
    expect(getIssue).toHaveBeenLastCalledWith(productIssue.id)
    expect(screen.getByText('다른 사람이 남긴 댓글')).toBeTruthy()
    expect(within(screen.getByRole('region', { name: '쪽지 목록' })).getByText(savedIssue.title)).toBeTruthy()
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '댓글' }).value).toBe(savedComment.body)
    expect(queryParams().get('issue')).toBe(productIssue.id)
    await advance()
    expect(listIssues).toHaveBeenCalledTimes(3)
    expect(getIssue).toHaveBeenCalledTimes(3)
    expect(getProject).toHaveBeenCalledTimes(1)
    expect(listVersions).toHaveBeenCalledTimes(1)
    expect(getVersion).toHaveBeenCalledTimes(1)
  })

  it('15초 갱신은 작성 중 제목·내용과 임시 핀을 바꾸지 않고 닫힌 상세는 부르지 않는다', async () => {
    vi.useFakeTimers()
    await renderRoom()
    await placePin()
    fillDraft()
    vi.mocked(listIssues).mockResolvedValue([savedIssue, ...issues])
    await advance()
    expect(listIssues).toHaveBeenCalledTimes(2)
    expect(getIssue).not.toHaveBeenCalled()
    expectDraft()
    expect(screen.getByRole('img', { name: '새 쪽지 위치' }).style.left).toBe('25%')
    expect(screen.getByRole('img', { name: '새 쪽지 위치' }).style.top).toBe('75%')
    expect(screen.getByRole('button', { name: pinName(savedIssue) })).toBeTruthy()
    expect(getProject).toHaveBeenCalledTimes(1)
    expect(listVersions).toHaveBeenCalledTimes(1)
  })

  it('숨긴 문서에서는 갱신하지 않고 다시 보이면 현재 열린 쪽지만 불러온다', async () => {
    vi.useFakeTimers()
    const visibility = vi.spyOn(document, 'visibilityState', 'get')
    await renderRoom(`?issue=${productIssue.id}`)
    visibility.mockReturnValue('hidden')
    await advance(30_000)
    expect(listIssues).toHaveBeenCalledTimes(1)
    expect(getIssue).toHaveBeenCalledTimes(1)
    visibility.mockReturnValue('visible')
    await chooseIssue(cartIssue)
    await advance()
    expect(listIssues).toHaveBeenCalledTimes(2)
    expect(getIssue).toHaveBeenCalledTimes(3)
    expect(getIssue).toHaveBeenLastCalledWith(cartIssue.id)
    await click('쪽지 닫기')
    await advance()
    expect(listIssues).toHaveBeenCalledTimes(3)
    expect(getIssue).toHaveBeenCalledTimes(3)
  })

  it('15초 갱신이 실패해도 보던 목록·상세·댓글 글을 그대로 두고 다음 갱신을 시도한다', async () => {
    vi.useFakeTimers()
    await renderRoom(`?issue=${productIssue.id}`)
    fillComment()
    vi.mocked(listIssues).mockRejectedValueOnce(new TypeError('연결 끊김'))
    vi.mocked(getIssue).mockRejectedValueOnce(new ApiError(500))
    await advance()
    expect(within(screen.getByRole('region', { name: '쪽지 목록' })).getAllByRole('listitem')).toHaveLength(4)
    expect(screen.getByRole('article', { name: '쪽지 #1' })).toBeTruthy()
    expect(screen.getByText(productIssue.body)).toBeTruthy()
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '댓글' }).value).toBe(savedComment.body)
    expect(screen.queryByText('연결을 확인하고 다시 시도해 주세요')).toBeNull()
    await advance()
    expect(listIssues).toHaveBeenCalledTimes(3)
    expect(getIssue).toHaveBeenCalledTimes(3)
  })

  it('검수실을 떠나면 15초 타이머가 멈춘다', async () => {
    vi.useFakeTimers()
    const view = await renderRoom(`?issue=${productIssue.id}`)
    view.unmount()
    await advance(45_000)
    expect(listIssues).toHaveBeenCalledTimes(1)
    expect(getIssue).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('다른 쪽지로 바꾼 뒤 늦게 온 이전 상세 응답은 지금 고른 쪽지를 덮지 않는다', async () => {
    const pending = deferred<IssueDetail>()
    vi.mocked(getIssue).mockReturnValueOnce(pending.promise)
    await renderRoom(`?issue=${productIssue.id}`)
    await chooseIssue(cartIssue)
    expect(screen.getByRole('article', { name: '쪽지 #2' })).toBeTruthy()
    await act(async () => {
      pending.resolve(productIssue)
    })
    expect(screen.getByRole('article', { name: '쪽지 #2' })).toBeTruthy()
    expect(screen.queryByRole('article', { name: '쪽지 #1' })).toBeNull()
    expect(queryParams().get('issue')).toBe(cartIssue.id)
  })

  it('갱신 중 다른 쪽지로 바꾼 뒤 늦게 온 갱신 응답도 현재 상세를 덮지 않는다', async () => {
    vi.useFakeTimers()
    await renderRoom(`?issue=${productIssue.id}`)
    const pending = deferred<IssueDetail>()
    vi.mocked(getIssue).mockReturnValueOnce(pending.promise)
    await advance()
    await chooseIssue(cartIssue)
    await act(async () => {
      pending.resolve({ ...productIssue, body: '늦은 갱신 본문' })
    })
    expect(screen.getByRole('article', { name: '쪽지 #2' })).toBeTruthy()
    expect(screen.queryByText('늦은 갱신 본문')).toBeNull()
  })

  it('수정 시작 응답으로 상세가 바뀌고 목록을 다시 불러온다', async () => {
    await renderRoom(`?issue=${productIssue.id}`)
    const changed = { ...productIssue, status: 'IN_PROGRESS' as const }
    vi.mocked(listIssues).mockResolvedValue([changed])
    vi.mocked(startIssue).mockResolvedValue(changed)
    await click('수정 시작')
    expect(startIssue).toHaveBeenCalledExactlyOnceWith(productIssue.id, current.id)
    expect(listIssues).toHaveBeenCalledTimes(2)
    expect(getIssue).toHaveBeenCalledExactlyOnceWith(productIssue.id)
    expect(within(screen.getByRole('article', { name: '쪽지 #1' })).getByText('수정 중')).toBeTruthy()
    expect(within(screen.getByRole('region', { name: '쪽지 목록' })).getByText('수정 중')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '수정 시작' })).toBeNull()
  })

  it.each(['붙이기', '지우기'] as const)('참고 사진 %s 응답으로 상세가 바뀌고 목록을 다시 불러온다', async (action) => {
    await renderRoom(`?issue=${productIssue.id}`)
    const changed = {
      ...productIssue,
      attachments:
        action === '붙이기'
          ? [...productIssue.attachments, { id: 'attachment-2', assetId: 'second-photo', width: 300, height: 200 }]
          : [],
    }
    vi.mocked(attachIssuePhoto).mockResolvedValue(changed)
    vi.mocked(removeIssuePhoto).mockResolvedValue(changed)
    if (action === '붙이기') {
      const file = new File(['photo'], 'reference.png', { type: 'image/png' })
      await act(async () => {
        fireEvent.change(screen.getByLabelText('참고 사진 붙이기'), { target: { files: [file] } })
      })
      expect(attachIssuePhoto).toHaveBeenCalledExactlyOnceWith(productIssue.id, file)
      expect(screen.getByRole('img', { name: '참고 사진 2' }).getAttribute('src')).toBe('/api/assets/second-photo')
    } else {
      await click('지우기')
      expect(window.confirm).toHaveBeenCalledWith('이 사진을 지울까요?')
      expect(removeIssuePhoto).toHaveBeenCalledExactlyOnceWith(productIssue.id, 'attachment-1')
      expect(screen.queryByRole('img', { name: '참고 사진 1' })).toBeNull()
    }
    expect(listIssues).toHaveBeenCalledTimes(2)
    expect(getIssue).toHaveBeenCalledExactlyOnceWith(productIssue.id)
  })

  it('이미 지워진 참고 사진의 404는 목록과 상세를 새로 불러와 없앤다', async () => {
    await renderRoom(`?issue=${productIssue.id}`)
    vi.mocked(removeIssuePhoto).mockRejectedValue(new ApiError(404))
    vi.mocked(getIssue).mockResolvedValue({ ...productIssue, attachments: [] })
    await click('지우기')
    expect(listIssues).toHaveBeenCalledTimes(2)
    expect(getIssue).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('img', { name: '참고 사진 1' })).toBeNull()
  })

  it.each(['수정 시작', '붙이기', '지우기'] as const)(
    '%s 성공 뒤 목록 갱신만 실패해도 받은 상세와 쓰던 댓글은 남고 상세를 다시 부르지 않는다',
    async (action) => {
      await renderRoom(`?version=${current.id}&issue=${productIssue.id}`)
      fillComment()
      vi.mocked(listIssues).mockRejectedValueOnce(new TypeError('연결 끊김'))
      const attached = {
        ...productIssue,
        attachments: [
          ...productIssue.attachments,
          { id: 'attachment-2', assetId: 'second-photo', width: 300, height: 200 },
        ],
      }
      vi.mocked(attachIssuePhoto).mockResolvedValueOnce(attached)

      if (action === '수정 시작') {
        await click('수정 시작')
        expect(startIssue).toHaveBeenCalledExactlyOnceWith(productIssue.id, current.id)
        expect(within(screen.getByRole('article', { name: '쪽지 #1' })).getByText('수정 중')).toBeTruthy()
        expect(screen.queryByRole('button', { name: '수정 시작' })).toBeNull()
      }
      if (action === '붙이기') {
        const file = new File(['photo'], 'reference.png', { type: 'image/png' })
        await act(async () => {
          fireEvent.change(screen.getByLabelText('참고 사진 붙이기'), { target: { files: [file] } })
        })
        expect(attachIssuePhoto).toHaveBeenCalledExactlyOnceWith(productIssue.id, file)
        expect(screen.getByRole('img', { name: '참고 사진 2' }).getAttribute('src')).toBe('/api/assets/second-photo')
      }
      if (action === '지우기') {
        await click('지우기')
        expect(removeIssuePhoto).toHaveBeenCalledExactlyOnceWith(productIssue.id, 'attachment-1')
        expect(screen.queryByRole('img', { name: '참고 사진 1' })).toBeNull()
      }

      expect(listIssues).toHaveBeenCalledTimes(2)
      expect(getIssue).toHaveBeenCalledExactlyOnceWith(productIssue.id)
      expect(within(screen.getByRole('region', { name: '쪽지 목록' })).getAllByRole('listitem')).toHaveLength(4)
      expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '댓글' }).value).toBe(savedComment.body)
      expect(queryParams().get('issue')).toBe(productIssue.id)
      expect(queryParams().get('version')).toBe(current.id)
      expect(photo().getAttribute('src')).toBe('/api/assets/current-product')
    },
  )

  it.each([
    { reason: '연결 실패', error: new TypeError('연결 끊김'), message: '연결을 확인하고 다시 시도해 주세요' },
    { reason: '서버 오류', error: new ApiError(500), message: '잠시 뒤 다시 시도해 주세요' },
    { reason: '404', error: new ApiError(404), message: '없는 프로젝트예요' },
  ])('첫 쪽지 목록 불러오기가 $reason이면 검수실 전체에 오류를 보여 준다', async ({ error, message }) => {
    vi.mocked(listIssues).mockRejectedValue(error)
    await renderRoom()
    expect(screen.getByText(message)).toBeTruthy()
    expect(screen.queryByRole('heading', { name: project.name })).toBeNull()
    expect(screen.queryByRole('region', { name: '쪽지 목록' })).toBeNull()
    expect(screen.queryByRole('img', { name: '상품 상세 · PC' })).toBeNull()
  })

  it('쪽지와 댓글의 HTML 태그는 실행되지 않고 글자 그대로 보인다', async () => {
    const html = '<img src=x onerror="alert(1)"><script>alert(2)</script>'
    vi.mocked(getIssue).mockResolvedValue({
      ...productIssue,
      title: html,
      body: html,
      comments: [{ ...savedComment, body: html }],
    })
    await renderRoom(`?issue=${productIssue.id}`)
    const detail = screen.getByRole('article', { name: '쪽지 #1' })
    expect(within(detail).getAllByText(html)).toHaveLength(3)
    expect(detail.querySelector('script')).toBeNull()
    expect(detail.querySelector('[onerror]')).toBeNull()
  })
})

describe('ReviewRoomPage 응답 순서와 작성 화면 유지', () => {
  it.each(['수정 시작', '참고 사진 붙이기', '참고 사진 지우기'] as const)(
    'A의 늦은 %s 응답은 B의 상세와 쓰던 댓글을 바꾸지 않고 다음 15초 갱신도 B를 갱신한다',
    async (action) => {
      vi.useFakeTimers()
      const pending = deferred<IssueDetail>()
      const changed: IssueDetail = {
        ...productIssue,
        status: action === '수정 시작' ? 'IN_PROGRESS' : 'OPEN',
      }
      await renderRoom(`?issue=${productIssue.id}`)

      if (action === '수정 시작') {
        vi.mocked(startIssue).mockReturnValueOnce(pending.promise)
        await click('수정 시작')
        expect(startIssue).toHaveBeenCalledExactlyOnceWith(productIssue.id, current.id)
      }
      if (action === '참고 사진 붙이기') {
        changed.attachments = [
          ...productIssue.attachments,
          { id: 'attachment-2', assetId: 'second-photo', width: 300, height: 200 },
        ]
        vi.mocked(attachIssuePhoto).mockReturnValueOnce(pending.promise)
        const file = new File(['photo'], 'reference.png', { type: 'image/png' })
        await act(async () => {
          fireEvent.change(screen.getByLabelText('참고 사진 붙이기'), { target: { files: [file] } })
        })
        expect(attachIssuePhoto).toHaveBeenCalledExactlyOnceWith(productIssue.id, file)
      }
      if (action === '참고 사진 지우기') {
        changed.attachments = []
        vi.mocked(removeIssuePhoto).mockReturnValueOnce(pending.promise)
        await click('지우기')
        expect(removeIssuePhoto).toHaveBeenCalledExactlyOnceWith(productIssue.id, 'attachment-1')
      }

      await chooseIssue(cartIssue)
      fillComment()
      const commentInput = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '댓글' })
      vi.mocked(listIssues).mockResolvedValue(issues.map((issue) => (issue.id === changed.id ? changed : issue)))
      await act(async () => {
        pending.resolve(changed)
      })

      expect(listIssues).toHaveBeenCalledTimes(2)
      expect(getIssue).toHaveBeenCalledTimes(2)
      expect(queryParams().get('issue')).toBe(cartIssue.id)
      expect(screen.getByRole('heading', { name: cartIssue.title })).toBeTruthy()
      expect(screen.queryByRole('article', { name: '쪽지 #1' })).toBeNull()
      expect(screen.queryByText('쪽지를 불러오는 중이에요.')).toBeNull()
      expect(screen.queryByRole('heading', { name: productIssue.title })).toBeNull()
      expect(screen.queryByRole('img', { name: '참고 사진 2' })).toBeNull()
      expect(screen.getByRole('img', { name: '참고 사진 1' }).getAttribute('src')).toBe('/api/assets/reference-photo')
      expect(screen.getByRole('textbox', { name: '댓글' })).toBe(commentInput)
      expect(commentInput.value).toBe(savedComment.body)
      expect(photo('장바구니 · 모바일').getAttribute('src')).toBe('/api/assets/current-cart')
      if (action === '수정 시작') {
        expect(within(screen.getByRole('region', { name: '쪽지 목록' })).getByText('수정 중')).toBeTruthy()
      }

      vi.mocked(getIssue).mockResolvedValueOnce({ ...cartIssue, body: 'B의 새로 불러온 내용' })
      await advance()
      expect(listIssues).toHaveBeenCalledTimes(3)
      expect(getIssue).toHaveBeenCalledTimes(3)
      expect(getIssue).toHaveBeenLastCalledWith(cartIssue.id)
      expect(within(screen.getByRole('article', { name: '쪽지 #2' })).getByText('B의 새로 불러온 내용')).toBeTruthy()
      expect(screen.getByRole('textbox', { name: '댓글' })).toBe(commentInput)
      expect(commentInput.value).toBe(savedComment.body)
    },
  )

  it.each(['사진', '쪽지 쓰기 버튼'] as const)(
    '두 번째 화면의 쪽지를 목록에서 열고 %s으로 쓰기를 시작하면 보던 사진과 요청의 화면이 유지된다',
    async (entry) => {
      await renderRoom()
      expect(photo().getAttribute('src')).toBe('/api/assets/current-product')
      await chooseIssue(cartIssue)
      expect(photo('장바구니 · 모바일').getAttribute('src')).toBe('/api/assets/current-cart')
      expect(queryParams().get('issue')).toBe(cartIssue.id)
      if (entry === '사진') await placePin('장바구니 · 모바일', 420, 90)
      if (entry === '쪽지 쓰기 버튼') await click('쪽지 쓰기')

      expect(queryParams().has('issue')).toBe(false)
      expect(photo('장바구니 · 모바일').getAttribute('src')).toBe('/api/assets/current-cart')
      expect(screen.getByRole('button', { name: '장바구니 · 모바일' }).getAttribute('aria-pressed')).toBe('true')
      if (entry === '사진') {
        expect(screen.getByRole('img', { name: '새 쪽지 위치' }).style.left).toBe('80%')
        expect(screen.getByRole('img', { name: '새 쪽지 위치' }).style.top).toBe('10%')
      }
      if (entry === '쪽지 쓰기 버튼') expect(screen.queryByRole('img', { name: '새 쪽지 위치' })).toBeNull()
      fillDraft()
      await click('쪽지 남기기')
      expect(createIssue).toHaveBeenCalledExactlyOnceWith(project.id, {
        requestId: expect.any(String),
        versionId: current.id,
        title: savedIssue.title,
        body: savedIssue.body,
        pin: entry === '사진' ? { screenId: current.screens[1].screenId, xRatio: 0.8, yRatio: 0.1 } : undefined,
      })
    },
  )

  it('지난 쪽지의 처음 사진에서 위치 없는 쪽지 쓰기를 시작하면 현재 버전 사진으로 돌아온다', async () => {
    await renderRoom(`?issue=${oldIssue.id}`)
    expect(photo().getAttribute('src')).toBe('/api/assets/old-current-product')
    await click('쪽지 쓰기')
    expect(queryParams().has('issue')).toBe(false)
    expect(photo().getAttribute('src')).toBe('/api/assets/current-product')
    expect(screen.queryByText(/처음 사진의 위치를 보여 드려요/)).toBeNull()
    expect(screen.queryByRole('img', { name: '새 쪽지 위치' })).toBeNull()
    fillDraft()
    await click('쪽지 남기기')
    expect(createIssue).toHaveBeenCalledExactlyOnceWith(project.id, {
      requestId: expect.any(String),
      versionId: current.id,
      title: savedIssue.title,
      body: savedIssue.body,
      pin: undefined,
    })
  })

  it.each(['화면', '버전'] as const)(
    '잠긴 뒤 %s을 바꾸고 409로 잠금이 풀리면 다른 사진의 임시 핀을 쓰지 않는다',
    async (changedTarget) => {
      vi.mocked(createIssue)
        .mockRejectedValueOnce(new TypeError('응답 끊김'))
        .mockRejectedValueOnce(new ApiError(409, 'VERSION_CHANGED'))
      await renderRoom()
      await placePin()
      fillDraft()
      await click('쪽지 남기기')
      const firstRequest = vi.mocked(createIssue).mock.calls[0]
      if (changedTarget === '화면') await click('장바구니 · 모바일')
      if (changedTarget === '버전') await chooseVersion(initial.id)
      expect(screen.queryByRole('img', { name: '새 쪽지 위치' })).toBeNull()
      await click('다시 보내기')
      expect(vi.mocked(createIssue).mock.calls[1]).toEqual(firstRequest)
      expect(screen.getByRole<HTMLInputElement>('textbox', { name: '제목 (필수)' }).readOnly).toBe(false)
      expect(screen.getByText('위치를 정하지 않은 쪽지예요. 사진을 누르면 그 자리에 남길 수 있어요.')).toBeTruthy()
      expect(screen.queryByRole('button', { name: '위치 없이 쓰기' })).toBeNull()
      expectDraft()

      if (changedTarget === '버전') {
        expect(screen.queryByRole('button', { name: '쪽지 남기기' })).toBeNull()
        await chooseVersion(current.id)
      }
      await click('쪽지 남기기')
      expect(createIssue).toHaveBeenCalledTimes(3)
      expect(vi.mocked(createIssue).mock.calls[2]).toEqual([project.id, { ...firstRequest[1], pin: undefined }])
    },
  )

  it('만들기 전에 시작한 목록 응답이 늦게 와도 새 쪽지의 목록·상세와 쓰던 댓글이 남는다', async () => {
    vi.useFakeTimers()
    await renderRoom()
    const pending = deferred<typeof issues>()
    vi.mocked(listIssues).mockReturnValueOnce(pending.promise)
    await advance()
    expect(listIssues).toHaveBeenCalledTimes(2)
    await click('쪽지 쓰기')
    fillDraft()
    await click('쪽지 남기기')
    expect(createIssue).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('article', { name: '쪽지 #5' })).toBeTruthy()
    fillComment()
    const commentInput = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '댓글' })
    await act(async () => {
      pending.resolve(issues)
    })

    expect(queryParams().get('issue')).toBe(savedIssue.id)
    expect(within(screen.getByRole('region', { name: '쪽지 목록' })).getAllByText(savedIssue.title)).toHaveLength(1)
    expect(screen.getByRole('article', { name: '쪽지 #5' })).toBeTruthy()
    expect(screen.queryByText('없는 쪽지예요.')).toBeNull()
    expect(screen.queryByText('쪽지를 불러오는 중이에요.')).toBeNull()
    expect(screen.getByRole('textbox', { name: '댓글' })).toBe(commentInput)
    expect(commentInput.value).toBe(savedComment.body)

    vi.mocked(listIssues).mockResolvedValue([savedIssue, ...issues])
    vi.mocked(getIssue).mockResolvedValueOnce({ ...savedIssue, body: '새 쪽지의 갱신된 내용' })
    await advance()
    expect(listIssues).toHaveBeenCalledTimes(3)
    expect(getIssue).toHaveBeenLastCalledWith(savedIssue.id)
    expect(screen.getByText('새 쪽지의 갱신된 내용')).toBeTruthy()
    expect(screen.getByRole('textbox', { name: '댓글' })).toBe(commentInput)
    expect(commentInput.value).toBe(savedComment.body)
  })

  it('목록 요청 두 개의 응답이 뒤바뀌면 나중에 시작한 목록만 반영한다', async () => {
    vi.useFakeTimers()
    await renderRoom(`?issue=${productIssue.id}`)
    fillComment()
    const first = deferred<typeof issues>()
    const second = deferred<typeof issues>()
    vi.mocked(listIssues).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    await advance()
    await advance()
    expect(listIssues).toHaveBeenCalledTimes(3)
    await act(async () => {
      second.resolve([savedIssue, ...issues])
    })
    expect(within(screen.getByRole('region', { name: '쪽지 목록' })).getByText(savedIssue.title)).toBeTruthy()
    await act(async () => {
      first.resolve(issues)
    })
    expect(within(screen.getByRole('region', { name: '쪽지 목록' })).getAllByRole('listitem')).toHaveLength(5)
    expect(within(screen.getByRole('region', { name: '쪽지 목록' })).getByText(savedIssue.title)).toBeTruthy()
    expect(screen.getByRole('article', { name: '쪽지 #1' })).toBeTruthy()
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '댓글' }).value).toBe(savedComment.body)
  })

  it('상세 요청 두 개의 응답이 뒤바뀌면 나중에 시작한 상세와 쓰던 댓글만 남는다', async () => {
    vi.useFakeTimers()
    await renderRoom(`?issue=${productIssue.id}`)
    fillComment()
    const first = deferred<IssueDetail>()
    const second = deferred<IssueDetail>()
    vi.mocked(getIssue).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    await advance()
    await advance()
    expect(getIssue).toHaveBeenCalledTimes(3)
    await act(async () => {
      second.resolve({ ...productIssue, body: '나중 요청의 상세', comments: [savedComment], commentCount: 1 })
    })
    expect(screen.getByText('나중 요청의 상세')).toBeTruthy()
    await act(async () => {
      first.resolve({ ...productIssue, body: '먼저 요청한 옛 상세' })
    })
    expect(screen.getByText('나중 요청의 상세')).toBeTruthy()
    expect(screen.queryByText('먼저 요청한 옛 상세')).toBeNull()
    expect(screen.getByRole('heading', { name: '댓글 1개' })).toBeTruthy()
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '댓글' }).value).toBe(savedComment.body)
  })

  it('수정 시작 전에 시작한 상세 갱신이 늦게 와도 수정 중 상태와 쓰던 댓글이 남는다', async () => {
    vi.useFakeTimers()
    await renderRoom(`?issue=${productIssue.id}`)
    fillComment()
    const pending = deferred<IssueDetail>()
    vi.mocked(getIssue).mockReturnValueOnce(pending.promise)
    await advance()
    expect(getIssue).toHaveBeenCalledTimes(2)
    const changed = { ...productIssue, status: 'IN_PROGRESS' as const }
    vi.mocked(listIssues).mockResolvedValue(issues.map((issue) => (issue.id === changed.id ? changed : issue)))
    await click('수정 시작')
    expect(startIssue).toHaveBeenCalledExactlyOnceWith(productIssue.id, current.id)
    expect(within(screen.getByRole('article', { name: '쪽지 #1' })).getByText('수정 중')).toBeTruthy()
    await act(async () => {
      pending.resolve(productIssue)
    })
    expect(within(screen.getByRole('article', { name: '쪽지 #1' })).getByText('수정 중')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '수정 시작' })).toBeNull()
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '댓글' }).value).toBe(savedComment.body)
  })
})

describe('ReviewRoomPage 늦은 새로 부르기와 상세 실패', () => {
  it.each([
    { reason: '연결 실패', error: new TypeError('연결 끊김'), message: '연결을 확인하고 다시 시도해 주세요' },
    { reason: '서버 오류 500', error: new ApiError(500), message: '잠시 뒤 다시 시도해 주세요' },
  ])(
    'A 상세를 보다가 목록에서 연 B의 상세 요청이 $reason이면 A 상세 대신 오류를 보여 준다',
    async ({ error, message }) => {
      await renderRoom(`?issue=${productIssue.id}`)
      const detail = screen.getByRole('article', { name: '쪽지 #1' })
      expect(within(detail).getByRole('heading', { name: productIssue.title })).toBeTruthy()
      expect(within(detail).getByText(productIssue.body)).toBeTruthy()

      vi.mocked(getIssue).mockRejectedValueOnce(error)
      await chooseIssue(cartIssue)

      expect(vi.mocked(getIssue).mock.calls).toEqual([[productIssue.id], [cartIssue.id]])
      expect(within(screen.getByRole('complementary', { name: '쪽지' })).getByText(message)).toBeTruthy()
      expect(screen.queryByRole('article')).toBeNull()
      expect(queryParams().get('issue')).toBe(cartIssue.id)
    },
  )

  it('A의 댓글 응답이 늦게 와도 B 상세와 쓰던 글이 남고 목록만 갱신하며 다음 15초에는 B를 부른다', async () => {
    vi.useFakeTimers()
    const pendingComment = deferred<typeof savedComment>()
    vi.mocked(createComment).mockReturnValueOnce(pendingComment.promise)
    await renderRoom(`?issue=${productIssue.id}`)
    fillComment()
    await click('댓글 남기기')
    expect(createComment).toHaveBeenCalledExactlyOnceWith(productIssue.id, {
      requestId: expect.any(String),
      versionId: current.id,
      body: savedComment.body,
    })

    await chooseIssue(cartIssue)
    const detail = screen.getByRole('article', { name: '쪽지 #2' })
    const draft = 'B에 쓰는 아직 보내지 않은 댓글'
    fireEvent.change(within(detail).getByRole('textbox', { name: '댓글' }), { target: { value: draft } })
    expect(listIssues).toHaveBeenCalledTimes(1)
    expect(vi.mocked(getIssue).mock.calls).toEqual([[productIssue.id], [cartIssue.id]])
    await act(async () => {
      pendingComment.resolve(savedComment)
    })

    expect(screen.getByRole('article', { name: '쪽지 #2' })).toBe(detail)
    expect(within(detail).getByRole('heading', { name: cartIssue.title })).toBeTruthy()
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '댓글' }).value).toBe(draft)
    expect(screen.queryByRole('article', { name: '쪽지 #1' })).toBeNull()
    expect(queryParams().get('issue')).toBe(cartIssue.id)
    expect(listIssues).toHaveBeenCalledTimes(2)
    expect(vi.mocked(getIssue).mock.calls).toEqual([[productIssue.id], [cartIssue.id]])

    await advance()
    expect(listIssues).toHaveBeenCalledTimes(3)
    expect(vi.mocked(getIssue).mock.calls).toEqual([[productIssue.id], [cartIssue.id], [cartIssue.id]])
    expect(screen.getByRole('article', { name: '쪽지 #2' })).toBe(detail)
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '댓글' }).value).toBe(draft)
  })

  it('B 상세를 기다리는 중 A의 댓글 응답이 와도 뒤이어 받은 B 상세를 보여 준다', async () => {
    const pendingComment = deferred<typeof savedComment>()
    const pendingDetail = deferred<IssueDetail>()
    vi.mocked(createComment).mockReturnValueOnce(pendingComment.promise)
    await renderRoom(`?issue=${productIssue.id}`)
    fillComment()
    await click('댓글 남기기')
    expect(createComment).toHaveBeenCalledExactlyOnceWith(productIssue.id, {
      requestId: expect.any(String),
      versionId: current.id,
      body: savedComment.body,
    })
    vi.mocked(getIssue).mockReturnValueOnce(pendingDetail.promise)
    await chooseIssue(cartIssue)
    expect(screen.queryByRole('article')).toBeNull()
    expect(vi.mocked(getIssue).mock.calls).toEqual([[productIssue.id], [cartIssue.id]])

    await act(async () => {
      pendingComment.resolve(savedComment)
    })
    expect(listIssues).toHaveBeenCalledTimes(2)
    expect(vi.mocked(getIssue).mock.calls).toEqual([[productIssue.id], [cartIssue.id]])
    expect(screen.queryByRole('article')).toBeNull()
    await act(async () => {
      pendingDetail.resolve({ ...cartIssue, body: 'B 요청으로 받은 상세' })
    })

    const detail = screen.getByRole('article', { name: '쪽지 #2' })
    expect(within(detail).getByRole('heading', { name: cartIssue.title })).toBeTruthy()
    expect(within(detail).getByText('B 요청으로 받은 상세')).toBeTruthy()
    expect(screen.queryByRole('article', { name: '쪽지 #1' })).toBeNull()
    expect(queryParams().get('issue')).toBe(cartIssue.id)
    expect(vi.mocked(getIssue).mock.calls).toEqual([[productIssue.id], [cartIssue.id]])
  })

  it.each([
    { action: '수정 시작', reason: '404', error: new ApiError(404) },
    { action: '수정 시작', reason: '409 ISSUE_NOT_OPEN', error: new ApiError(409, 'ISSUE_NOT_OPEN') },
    { action: '참고 사진 지우기', reason: '404', error: new ApiError(404) },
  ])(
    'A의 $action 요청이 늦게 $reason로 끝나도 B 상세와 쓰던 글을 남기고 목록만 갱신한다',
    async ({ action, error }) => {
      vi.useFakeTimers()
      const pending = deferred<IssueDetail>()
      await renderRoom(`?issue=${productIssue.id}`)
      if (action === '수정 시작') {
        vi.mocked(startIssue).mockReturnValueOnce(pending.promise)
        await click('수정 시작')
        expect(startIssue).toHaveBeenCalledExactlyOnceWith(productIssue.id, current.id)
      }
      if (action === '참고 사진 지우기') {
        vi.mocked(removeIssuePhoto).mockReturnValueOnce(pending.promise)
        await click('지우기')
        expect(removeIssuePhoto).toHaveBeenCalledExactlyOnceWith(productIssue.id, 'attachment-1')
      }
      await chooseIssue(cartIssue)
      const detail = screen.getByRole('article', { name: '쪽지 #2' })
      fillComment()
      expect(listIssues).toHaveBeenCalledTimes(1)
      await act(async () => {
        pending.reject(error)
      })

      expect(screen.getByRole('article', { name: '쪽지 #2' })).toBe(detail)
      expect(within(detail).getByRole('heading', { name: cartIssue.title })).toBeTruthy()
      expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '댓글' }).value).toBe(savedComment.body)
      expect(screen.queryByRole('article', { name: '쪽지 #1' })).toBeNull()
      expect(queryParams().get('issue')).toBe(cartIssue.id)
      expect(listIssues).toHaveBeenCalledTimes(2)
      expect(vi.mocked(getIssue).mock.calls).toEqual([[productIssue.id], [cartIssue.id]])
      await advance()
      expect(listIssues).toHaveBeenCalledTimes(3)
      expect(vi.mocked(getIssue).mock.calls).toEqual([[productIssue.id], [cartIssue.id], [cartIssue.id]])
      expect(screen.getByRole('article', { name: '쪽지 #2' })).toBe(detail)
      expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '댓글' }).value).toBe(savedComment.body)
    },
  )

  it('쪽지를 만든 직후 시작한 상세 요청이 실패해도 만든 상세와 쓰던 댓글을 남기고 오류를 숨긴다', async () => {
    const pending = deferred<IssueDetail>()
    vi.mocked(getIssue).mockReturnValueOnce(pending.promise)
    await renderRoom()
    await click('쪽지 쓰기')
    fillDraft()
    await click('쪽지 남기기')
    expect(createIssue).toHaveBeenCalledTimes(1)
    expect(getIssue).toHaveBeenCalledExactlyOnceWith(savedIssue.id)
    const detail = screen.getByRole('article', { name: '쪽지 #5' })
    expect(within(detail).getByText(savedIssue.body)).toBeTruthy()
    fillComment()
    await act(async () => {
      pending.reject(new TypeError('연결 실패'))
    })

    expect(screen.getByRole('article', { name: '쪽지 #5' })).toBe(detail)
    expect(within(detail).getByRole('heading', { name: savedIssue.title })).toBeTruthy()
    expect(within(detail).getByText(savedIssue.body)).toBeTruthy()
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '댓글' }).value).toBe(savedComment.body)
    expect(screen.queryByText('연결을 확인하고 다시 시도해 주세요')).toBeNull()
    expect(queryParams().get('issue')).toBe(savedIssue.id)
    expect(getIssue).toHaveBeenCalledTimes(1)
  })

  it('쪽지를 닫았다 다시 열 때 상세 요청이 실패해도 옛 상세와 쓰던 댓글을 남기고 오류를 숨긴다', async () => {
    await renderRoom(`?issue=${productIssue.id}`)
    await click('쪽지 닫기')
    expect(screen.queryByRole('article')).toBeNull()
    const pending = deferred<IssueDetail>()
    vi.mocked(getIssue).mockReturnValueOnce(pending.promise)
    await chooseIssue(productIssue)
    expect(vi.mocked(getIssue).mock.calls).toEqual([[productIssue.id], [productIssue.id]])
    const detail = screen.getByRole('article', { name: '쪽지 #1' })
    expect(within(detail).getByText(productIssue.body)).toBeTruthy()
    fillComment()
    await act(async () => {
      pending.reject(new TypeError('연결 실패'))
    })

    expect(screen.getByRole('article', { name: '쪽지 #1' })).toBe(detail)
    expect(within(detail).getByRole('heading', { name: productIssue.title })).toBeTruthy()
    expect(within(detail).getByText(productIssue.body)).toBeTruthy()
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '댓글' }).value).toBe(savedComment.body)
    expect(screen.queryByText('연결을 확인하고 다시 시도해 주세요')).toBeNull()
    expect(queryParams().get('issue')).toBe(productIssue.id)
    expect(getIssue).toHaveBeenCalledTimes(2)
  })
})

describe('ReviewRoomPage 처음 상세 응답과 보내는 중 핀 잠금', () => {
  it.each(['성공', '실패'] as const)(
    '쪽지를 만든 직후 시작한 상세 요청이 수정 시작보다 늦게 %s해도 수정 중 상태가 남는다',
    async (result) => {
      const pending = deferred<IssueDetail>()
      vi.mocked(getIssue).mockReturnValueOnce(pending.promise)
      const changed: IssueDetail = { ...savedIssue, status: 'IN_PROGRESS' }
      vi.mocked(startIssue).mockResolvedValueOnce(changed)
      await renderRoom()
      await click('쪽지 쓰기')
      fillDraft()
      await click('쪽지 남기기')
      expect(getIssue).toHaveBeenCalledExactlyOnceWith(savedIssue.id)
      expect(within(screen.getByRole('article', { name: '쪽지 #5' })).getByText('접수')).toBeTruthy()

      vi.mocked(listIssues).mockResolvedValue([changed, ...issues])
      await click('수정 시작')
      expect(startIssue).toHaveBeenCalledExactlyOnceWith(savedIssue.id, current.id)
      expect(within(screen.getByRole('article', { name: '쪽지 #5' })).getByText('수정 중')).toBeTruthy()
      await act(async () => {
        if (result === '실패') {
          pending.reject(new TypeError('연결 실패'))
          return
        }
        pending.resolve(savedIssue)
      })

      expect(within(screen.getByRole('article', { name: '쪽지 #5' })).getByText('수정 중')).toBeTruthy()
      expect(screen.queryByRole('button', { name: '수정 시작' })).toBeNull()
      expect(screen.queryByText('연결을 확인하고 다시 시도해 주세요')).toBeNull()
      expect(queryParams().get('issue')).toBe(savedIssue.id)
      expect(getIssue).toHaveBeenCalledTimes(1)
    },
  )

  it.each(['수정 시작', '댓글 남기기'] as const)(
    '쪽지를 닫았다 다시 열고 %s을 끝내면 늦은 옛 상세가 바뀐 내용을 되돌리지 않는다',
    async (action) => {
      await renderRoom(`?issue=${productIssue.id}`)
      await click('쪽지 닫기')
      expect(screen.queryByRole('article', { name: '쪽지 #1' })).toBeNull()
      const pending = deferred<IssueDetail>()
      vi.mocked(getIssue).mockReturnValueOnce(pending.promise)
      await chooseIssue(productIssue)
      expect(getIssue).toHaveBeenCalledTimes(2)
      expect(getIssue).toHaveBeenLastCalledWith(productIssue.id)
      expect(screen.getByRole('heading', { name: productIssue.title })).toBeTruthy()

      if (action === '댓글 남기기') {
        fillComment()
        vi.mocked(getIssue).mockResolvedValueOnce({ ...productIssue, comments: [savedComment], commentCount: 1 })
      }
      await click(action)
      const detail = screen.getByRole('article', { name: '쪽지 #1' })
      if (action === '수정 시작') {
        expect(startIssue).toHaveBeenCalledExactlyOnceWith(productIssue.id, current.id)
        expect(within(detail).getByText('수정 중')).toBeTruthy()
      }
      if (action === '댓글 남기기') {
        expect(createComment).toHaveBeenCalledExactlyOnceWith(productIssue.id, {
          requestId: expect.any(String),
          versionId: current.id,
          body: savedComment.body,
        })
        expect(within(detail).getByText(savedComment.body)).toBeTruthy()
      }
      await act(async () => {
        pending.resolve(productIssue)
      })

      expect(screen.getByRole('article', { name: '쪽지 #1' })).toBe(detail)
      if (action === '수정 시작') {
        expect(within(detail).getByText('수정 중')).toBeTruthy()
        expect(screen.queryByRole('button', { name: '수정 시작' })).toBeNull()
      }
      if (action === '댓글 남기기') {
        expect(within(detail).getByRole('heading', { name: '댓글 1개' })).toBeTruthy()
        expect(within(detail).getByText(savedComment.body)).toBeTruthy()
        expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '댓글' }).value).toBe('')
      }
    },
  )

  it('A의 수정 시작을 기다리다 B를 열면 A의 응답이 아직 끝나지 않은 B 상세 요청을 버리지 않는다', async () => {
    await renderRoom(`?issue=${productIssue.id}`)
    const pendingStart = deferred<IssueDetail>()
    const pendingDetail = deferred<IssueDetail>()
    vi.mocked(startIssue).mockReturnValueOnce(pendingStart.promise)
    await click('수정 시작')
    expect(startIssue).toHaveBeenCalledExactlyOnceWith(productIssue.id, current.id)
    vi.mocked(getIssue).mockReturnValueOnce(pendingDetail.promise)
    await chooseIssue(cartIssue)
    expect(getIssue).toHaveBeenCalledTimes(2)
    expect(getIssue).toHaveBeenLastCalledWith(cartIssue.id)
    expect(screen.queryByRole('article')).toBeNull()

    const changed: IssueDetail = { ...productIssue, status: 'IN_PROGRESS' }
    vi.mocked(listIssues).mockResolvedValue(issues.map((issue) => (issue.id === changed.id ? changed : issue)))
    await act(async () => {
      pendingStart.resolve(changed)
    })
    expect(queryParams().get('issue')).toBe(cartIssue.id)
    expect(screen.queryByRole('article', { name: '쪽지 #1' })).toBeNull()
    expect(getIssue).toHaveBeenCalledTimes(2)
    await act(async () => {
      pendingDetail.resolve({ ...cartIssue, body: 'B의 상세 내용' })
    })

    const detail = screen.getByRole('article', { name: '쪽지 #2' })
    expect(within(detail).getByRole('heading', { name: cartIssue.title })).toBeTruthy()
    expect(within(detail).getByText('B의 상세 내용')).toBeTruthy()
    expect(within(detail).getByText('접수')).toBeTruthy()
    expect(screen.queryByRole('article', { name: '쪽지 #1' })).toBeNull()
    expect(photo('장바구니 · 모바일').getAttribute('src')).toBe('/api/assets/current-cart')
    expect(getIssue).toHaveBeenCalledTimes(2)
  })

  it.each(['성공', '실패'] as const)(
    '처음 여는 상세 요청 중 15초 갱신이 성공하면 그 상세를 보여 주고 늦은 처음 요청의 %s 결과는 버린다',
    async (result) => {
      vi.useFakeTimers()
      const first = deferred<IssueDetail>()
      const second = deferred<IssueDetail>()
      vi.mocked(getIssue).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
      await renderRoom(`?issue=${productIssue.id}`)
      expect(getIssue).toHaveBeenCalledExactlyOnceWith(productIssue.id)
      expect(screen.queryByRole('article')).toBeNull()
      await advance()
      expect(listIssues).toHaveBeenCalledTimes(2)
      expect(getIssue).toHaveBeenCalledTimes(2)
      expect(getIssue).toHaveBeenLastCalledWith(productIssue.id)
      expect(screen.queryByRole('article')).toBeNull()

      await act(async () => {
        second.resolve({ ...productIssue, body: '15초 뒤 갱신한 상세' })
      })
      expect(within(screen.getByRole('article', { name: '쪽지 #1' })).getByText('15초 뒤 갱신한 상세')).toBeTruthy()
      fillComment()
      await act(async () => {
        if (result === '실패') {
          first.reject(new TypeError('연결 실패'))
          return
        }
        first.resolve({ ...productIssue, body: '처음 요청으로 받은 상세' })
      })
      expect(getIssue).toHaveBeenCalledTimes(2)
      expect(within(screen.getByRole('article', { name: '쪽지 #1' })).getByText('15초 뒤 갱신한 상세')).toBeTruthy()
      expect(screen.queryByText('처음 요청으로 받은 상세')).toBeNull()
      expect(screen.queryByText('연결을 확인하고 다시 시도해 주세요')).toBeNull()
      expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '댓글' }).value).toBe(savedComment.body)
    },
  )

  it.each(['성공', '실패'] as const)(
    '처음 여는 상세 요청 중 15초 갱신이 실패하면 오류를 보여 주고 늦은 처음 요청의 %s 결과는 버린다',
    async (result) => {
      vi.useFakeTimers()
      const first = deferred<IssueDetail>()
      const second = deferred<IssueDetail>()
      vi.mocked(getIssue).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
      await renderRoom(`?issue=${productIssue.id}`)
      expect(getIssue).toHaveBeenCalledExactlyOnceWith(productIssue.id)
      await advance()
      expect(listIssues).toHaveBeenCalledTimes(2)
      expect(getIssue).toHaveBeenCalledTimes(2)
      expect(getIssue).toHaveBeenLastCalledWith(productIssue.id)
      expect(screen.queryByRole('article')).toBeNull()

      await act(async () => {
        second.reject(new TypeError('연결 실패'))
      })
      expect(screen.getByText('연결을 확인하고 다시 시도해 주세요')).toBeTruthy()
      expect(screen.queryByRole('article')).toBeNull()
      await act(async () => {
        if (result === '실패') {
          first.reject(new ApiError(500))
          return
        }
        first.resolve(productIssue)
      })

      expect(screen.getByText('연결을 확인하고 다시 시도해 주세요')).toBeTruthy()
      expect(screen.queryByText('잠시 뒤 다시 시도해 주세요')).toBeNull()
      expect(screen.queryByRole('article')).toBeNull()
      expect(getIssue).toHaveBeenCalledTimes(2)
    },
  )

  it('보내는 중 사진의 다른 곳을 눌러도 임시 핀이 그대로이고 연결 실패 뒤 처음 좌표로 다시 보낸다', async () => {
    const pending = deferred<IssueDetail>()
    vi.mocked(createIssue).mockReturnValueOnce(pending.promise)
    await renderRoom()
    await placePin()
    fillDraft()
    await click('쪽지 남기기')
    const firstRequest = structuredClone(vi.mocked(createIssue).mock.calls[0])
    expect(firstRequest[1].pin).toEqual({ screenId: current.screens[0].screenId, xRatio: 0.25, yRatio: 0.75 })
    await placePin('상품 상세 · PC', 420, 90)

    expect(screen.getByRole('img', { name: '새 쪽지 위치' }).style.left).toBe('25%')
    expect(screen.getByRole('img', { name: '새 쪽지 위치' }).style.top).toBe('75%')
    expect(screen.queryByRole('button', { name: '위치 없이 쓰기' })).toBeNull()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '쪽지 남기기' }).disabled).toBe(true)
    await act(async () => {
      pending.reject(new TypeError('응답 끊김'))
    })
    expect(screen.getByRole('img', { name: '새 쪽지 위치' }).style.left).toBe('25%')
    expect(screen.getByRole('img', { name: '새 쪽지 위치' }).style.top).toBe('75%')
    expectDraft()
    await click('다시 보내기')
    expect(createIssue).toHaveBeenCalledTimes(2)
    expect(vi.mocked(createIssue).mock.calls[1]).toEqual(firstRequest)
  })

  it.each(['화면', '버전'] as const)(
    '보내는 중 다른 %s을 골랐다 연결이 끊겨도 돌아오면 처음 핀이 남고 처음 요청을 다시 보낸다',
    async (changedTarget) => {
      const pending = deferred<IssueDetail>()
      vi.mocked(createIssue).mockReturnValueOnce(pending.promise)
      await renderRoom()
      await placePin()
      fillDraft()
      await click('쪽지 남기기')
      const firstRequest = structuredClone(vi.mocked(createIssue).mock.calls[0])
      expect(firstRequest[1]).toEqual({
        requestId: expect.any(String),
        versionId: current.id,
        title: savedIssue.title,
        body: savedIssue.body,
        pin: { screenId: current.screens[0].screenId, xRatio: 0.25, yRatio: 0.75 },
      })
      if (changedTarget === '화면') await click('장바구니 · 모바일')
      if (changedTarget === '버전') await chooseVersion(initial.id)
      expect(screen.queryByRole('img', { name: '새 쪽지 위치' })).toBeNull()
      expect(screen.getByText('선택한 위치에 쪽지를 남겨요.')).toBeTruthy()
      await act(async () => {
        pending.reject(new TypeError('응답 끊김'))
      })
      expect(screen.getByRole('button', { name: '다시 보내기' })).toBeTruthy()
      if (changedTarget === '화면') await click('상품 상세 · PC')
      if (changedTarget === '버전') await chooseVersion(current.id)

      expect(photo().getAttribute('src')).toBe('/api/assets/current-product')
      expect(screen.getByRole('img', { name: '새 쪽지 위치' }).style.left).toBe('25%')
      expect(screen.getByRole('img', { name: '새 쪽지 위치' }).style.top).toBe('75%')
      expectDraft()
      await click('다시 보내기')
      expect(createIssue).toHaveBeenCalledTimes(2)
      expect(vi.mocked(createIssue).mock.calls[1]).toEqual(firstRequest)
    },
  )

  it.each([
    { status: 422, code: undefined },
    { status: 409, code: 'VERSION_CHANGED' },
  ])('처음 요청이 $status $code로 끝나면 핀 잠금이 풀리고 다시 고른 좌표로 보낸다', async ({ status, code }) => {
    const pending = deferred<IssueDetail>()
    vi.mocked(createIssue).mockReturnValueOnce(pending.promise)
    await renderRoom()
    await placePin()
    fillDraft()
    await click('쪽지 남기기')
    const firstRequest = structuredClone(vi.mocked(createIssue).mock.calls[0])
    await act(async () => {
      pending.reject(new ApiError(status, code))
    })

    expect(screen.getByRole('img', { name: '새 쪽지 위치' }).style.left).toBe('25%')
    expect(screen.getByRole('img', { name: '새 쪽지 위치' }).style.top).toBe('75%')
    expect(screen.queryByRole('button', { name: '다시 보내기' })).toBeNull()
    expect(screen.getByRole('button', { name: '위치 없이 쓰기' })).toBeTruthy()
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: '제목 (필수)' }).readOnly).toBe(false)
    await placePin('상품 상세 · PC', 420, 90)
    expect(screen.getByRole('img', { name: '새 쪽지 위치' }).style.left).toBe('80%')
    expect(screen.getByRole('img', { name: '새 쪽지 위치' }).style.top).toBe('10%')
    expectDraft()
    await click('쪽지 남기기')
    expect(createIssue).toHaveBeenCalledTimes(2)
    expect(vi.mocked(createIssue).mock.calls[1]).toEqual([
      project.id,
      { ...firstRequest[1], pin: { screenId: current.screens[0].screenId, xRatio: 0.8, yRatio: 0.1 } },
    ])
  })
})

describe('ReviewRoomPage 최신 버전 이동과 늦은 목록 응답', () => {
  it('지난 버전 안내의 링크로 돌아온 뒤 목록에서 쪽지를 열어도 지난 version이 되살아나지 않는다', async () => {
    await renderRoom(`?version=${initial.id}`)
    expect(photo().getAttribute('src')).toBe('/api/assets/old-current-product')
    await act(async () => {
      fireEvent.click(screen.getByRole('link', { name: '최신 버전 보기' }))
    })
    expect([...queryParams().entries()]).toEqual([])
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '버전' }).value).toBe(current.id)
    expect(photo().getAttribute('src')).toBe('/api/assets/current-product')

    await chooseIssue(productIssue)

    expect([...queryParams().entries()]).toEqual([['issue', productIssue.id]])
    expect(screen.getByRole('article', { name: '쪽지 #1' })).toBeTruthy()
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '버전' }).value).toBe(current.id)
    expect(photo().getAttribute('src')).toBe('/api/assets/current-product')
    expect(screen.queryByText(/지난 버전이에요/)).toBeNull()
    expect(screen.getByRole('textbox', { name: '댓글' })).toBeTruthy()
  })

  it('최신 버전과 쪽지 저장 응답이 한 번에 끝나도 주소에는 새 issue만 남고 version은 되살아나지 않는다', async () => {
    const pendingProject = deferred<ProjectDetail>()
    const pendingIssue = deferred<IssueDetail>()
    const created = { ...savedIssue, origin: null }
    vi.mocked(createIssue)
      .mockRejectedValueOnce(new ApiError(409, 'VERSION_CHANGED'))
      .mockReturnValueOnce(pendingIssue.promise)
    vi.mocked(getIssue).mockResolvedValueOnce(created)
    await renderRoom(`?version=${current.id}`)
    await click('쪽지 쓰기')
    fillDraft()
    await click('쪽지 남기기')
    expect(screen.getByText('새 버전이 올라왔어요. 쓰던 글은 그대로 남아 있어요.')).toBeTruthy()

    publishLatest()
    vi.mocked(getProject).mockReturnValueOnce(pendingProject.promise)
    await click('최신 버전 보기')
    expect(getProject).toHaveBeenCalledTimes(2)
    expect(queryParams().get('version')).toBe(current.id)
    expectDraft()
    await click('쪽지 남기기')
    expect(createIssue).toHaveBeenCalledTimes(2)
    expect(vi.mocked(createIssue).mock.calls[1]).toEqual(vi.mocked(createIssue).mock.calls[0])
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '쪽지 남기기' }).disabled).toBe(true)
    expect(queryParams().has('issue')).toBe(false)

    // 사이에 await를 두면 렌더가 주소를 맞춰 주어, 같은 순간에 끝나는 두 요청의 충돌을 놓친다.
    await act(async () => {
      pendingProject.resolve({ ...project, currentVersion: { id: latest.id, number: 2 } })
      pendingIssue.resolve(created)
      // 두 응답을 먼저 완료한 뒤 함께 기다려, 주소 변경 사이에 act가 화면을 갱신하지 않게 한다.
      await Promise.all([pendingProject.promise, pendingIssue.promise])
    })

    expect([...queryParams().entries()]).toEqual([['issue', created.id]])
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '버전' }).value).toBe(latest.id)
    expect(photo().getAttribute('src')).toBe('/api/assets/new-current-product')
    const detail = screen.getByRole('article', { name: '쪽지 #5' })
    expect(within(detail).getByRole('heading', { name: created.title })).toBeTruthy()
    expect(within(detail).getByText(created.body)).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: '제목 (필수)' })).toBeNull()
  })

  it('지난 버전 안내의 링크는 issue를 유지하고 댓글 글과 상세를 남긴 채 최신 사진으로 돌아온다', async () => {
    await renderRoom(`?issue=${oldIssue.id}&keep=yes`)
    fillComment()
    const detail = screen.getByRole('article', { name: '쪽지 #3' })
    await chooseVersion(initial.id)
    // 같은 쪽지를 다시 골라 처음 위치 보기를 켠다. 링크가 이를 끄는지도 확인한다.
    await chooseIssue(oldIssue)
    expect(queryParams().get('version')).toBe(initial.id)
    expect(photo().getAttribute('src')).toBe('/api/assets/old-current-product')
    expect(screen.getByRole('article', { name: '쪽지 #3' })).toBe(detail)
    expect(screen.queryByRole('textbox', { name: '댓글' })).toBeNull()

    const link = screen.getByRole('link', { name: '최신 버전 보기' })
    const destination = new URL(link.getAttribute('href')!, 'http://localhost')
    expect(destination.pathname).toBe(`/projects/${project.id}`)
    expect([...destination.searchParams.entries()]).toEqual([
      ['issue', oldIssue.id],
      ['keep', 'yes'],
    ])
    const pendingVersion = deferred<VersionDetail>()
    vi.mocked(getVersion).mockReturnValueOnce(pendingVersion.promise)
    await act(async () => {
      fireEvent.click(link)
    })
    expect(queryParams().has('version')).toBe(false)
    expect(queryParams().get('issue')).toBe(oldIssue.id)
    expect(queryParams().get('keep')).toBe('yes')
    expect(getVersion).toHaveBeenLastCalledWith(current.id)
    expect(screen.getByRole('article', { name: '쪽지 #3' })).toBe(detail)
    await act(async () => {
      pendingVersion.resolve(current)
    })

    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '버전' }).value).toBe(current.id)
    expect(photo().getAttribute('src')).toBe('/api/assets/current-product')
    expect(screen.queryByText(/처음 사진의 위치를 보여 드려요/)).toBeNull()
    expect(screen.getByRole('article', { name: '쪽지 #3' })).toBe(detail)
    expect(within(detail).getByRole('heading', { name: oldIssue.title })).toBeTruthy()
    expect(within(detail).getByText(oldIssue.body)).toBeTruthy()
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '댓글' }).value).toBe(savedComment.body)
  })

  it('A의 최신 버전 보기를 기다리는 사이 B를 열어 쓰면 응답 뒤에도 B의 주소·상세·댓글 글이 남는다', async () => {
    vi.mocked(createComment).mockRejectedValueOnce(new ApiError(409, 'VERSION_CHANGED'))
    await renderRoom(`?version=${current.id}&issue=${productIssue.id}&keep=yes`)
    fillComment()
    await click('댓글 남기기')
    expect(screen.getByText('새 버전이 올라왔어요. 쓰던 글은 그대로 남아 있어요.')).toBeTruthy()

    publishLatest()
    const pendingProject = deferred<ProjectDetail>()
    vi.mocked(getProject).mockReturnValueOnce(pendingProject.promise)
    await click('최신 버전 보기')
    expect(getProject).toHaveBeenCalledTimes(2)
    expect(queryParams().get('version')).toBe(current.id)
    await chooseIssue(cartIssue)
    const draft = 'B 쪽지에 새로 쓰던 댓글'
    fireEvent.change(screen.getByRole('textbox', { name: '댓글' }), { target: { value: draft } })
    const detail = screen.getByRole('article', { name: '쪽지 #2' })
    expect(queryParams().get('issue')).toBe(cartIssue.id)
    expect(photo('장바구니 · 모바일').getAttribute('src')).toBe('/api/assets/current-cart')
    await act(async () => {
      pendingProject.resolve({ ...project, currentVersion: { id: latest.id, number: 2 } })
    })

    expect(queryParams().has('version')).toBe(false)
    expect(queryParams().get('issue')).toBe(cartIssue.id)
    expect(queryParams().get('keep')).toBe('yes')
    expect(screen.getByRole('article', { name: '쪽지 #2' })).toBe(detail)
    expect(within(detail).getByRole('heading', { name: cartIssue.title })).toBeTruthy()
    expect(screen.queryByRole('article', { name: '쪽지 #1' })).toBeNull()
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '댓글' }).value).toBe(draft)
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '버전' }).value).toBe(latest.id)
    expect(photo().getAttribute('src')).toBe('/api/assets/new-current-product')
    expect(screen.queryByText(/처음 사진의 위치를 보여 드려요/)).toBeNull()
  })

  it('위치 없는 쪽지의 저장을 기다리는 사이 지난 버전을 고르면 응답 뒤 고른 version과 새 issue가 함께 남는다', async () => {
    const pendingIssue = deferred<IssueDetail>()
    const created = { ...savedIssue, origin: null }
    vi.mocked(createIssue).mockReturnValueOnce(pendingIssue.promise)
    vi.mocked(getIssue).mockResolvedValueOnce(created)
    await renderRoom(`?version=${current.id}&keep=yes`)
    await click('쪽지 쓰기')
    fillDraft()
    await click('쪽지 남기기')
    expect(createIssue).toHaveBeenCalledExactlyOnceWith(project.id, {
      requestId: expect.any(String),
      versionId: current.id,
      title: savedIssue.title,
      body: savedIssue.body,
      pin: undefined,
    })
    await chooseVersion(initial.id)
    expect(queryParams().get('version')).toBe(initial.id)
    expect(queryParams().has('issue')).toBe(false)
    expectDraft()
    expect(photo().getAttribute('src')).toBe('/api/assets/old-current-product')
    await act(async () => {
      pendingIssue.resolve(created)
    })

    expect(queryParams().get('version')).toBe(initial.id)
    expect(queryParams().get('issue')).toBe(created.id)
    expect(queryParams().get('keep')).toBe('yes')
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '버전' }).value).toBe(initial.id)
    expect(photo().getAttribute('src')).toBe('/api/assets/old-current-product')
    const detail = screen.getByRole('article', { name: '쪽지 #5' })
    expect(within(detail).getByRole('heading', { name: created.title })).toBeTruthy()
    expect(within(detail).getByText(created.body)).toBeTruthy()
    expect(within(detail).getByText('1차 · 위치 없음')).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: '댓글' })).toBeNull()
    expect(createIssue).toHaveBeenCalledTimes(1)
  })

  it('먼저 시작한 15초 목록이 최신 버전 보기보다 늦게 와도 새 쪽지 목록·상세·쓰던 댓글이 남는다', async () => {
    vi.useFakeTimers()
    vi.mocked(createComment).mockRejectedValueOnce(new ApiError(409, 'VERSION_CHANGED'))
    await renderRoom(`?version=${current.id}&issue=${productIssue.id}`)
    fillComment()
    await click('댓글 남기기')

    const pendingRefresh = deferred<typeof issues>()
    const pendingLatest = deferred<typeof issues>()
    vi.mocked(listIssues).mockReturnValueOnce(pendingRefresh.promise).mockReturnValueOnce(pendingLatest.promise)
    await advance()
    expect(listIssues).toHaveBeenCalledTimes(2)
    publishLatest()
    await click('최신 버전 보기')
    expect(listIssues).toHaveBeenCalledTimes(3)
    expect(queryParams().get('version')).toBe(current.id)
    await act(async () => {
      pendingLatest.resolve([savedIssue, ...issues])
    })
    expect(queryParams().has('version')).toBe(false)
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '버전' }).value).toBe(latest.id)
    expect(photo().getAttribute('src')).toBe('/api/assets/new-current-product')
    expect(within(screen.getByRole('region', { name: '쪽지 목록' })).getByText(savedIssue.title)).toBeTruthy()
    await chooseIssue(savedIssue)
    fillComment()
    const detail = screen.getByRole('article', { name: '쪽지 #5' })
    const comment = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '댓글' })
    await act(async () => {
      pendingRefresh.resolve(issues)
    })

    const list = within(screen.getByRole('region', { name: '쪽지 목록' }))
    expect(list.getAllByRole('listitem')).toHaveLength(5)
    expect(list.getByText(savedIssue.title)).toBeTruthy()
    expect(queryParams().get('issue')).toBe(savedIssue.id)
    expect(queryParams().has('version')).toBe(false)
    expect(screen.getByRole('article', { name: '쪽지 #5' })).toBe(detail)
    expect(within(detail).getByText(savedIssue.body)).toBeTruthy()
    expect(screen.getByRole('textbox', { name: '댓글' })).toBe(comment)
    expect(comment.value).toBe(savedComment.body)
    expect(screen.queryByText('없는 쪽지예요.')).toBeNull()
  })

  it('최신 버전 보기의 목록이 15초 갱신보다 늦게 와도 새 목록은 남고 프로젝트·버전은 최신으로 바뀐다', async () => {
    vi.useFakeTimers()
    vi.mocked(createComment).mockRejectedValueOnce(new ApiError(409, 'VERSION_CHANGED'))
    await renderRoom(`?version=${current.id}&issue=${productIssue.id}`)
    fillComment()
    await click('댓글 남기기')

    publishLatest()
    const pendingLatest = deferred<typeof issues>()
    const pendingRefresh = deferred<typeof issues>()
    vi.mocked(listIssues).mockReturnValueOnce(pendingLatest.promise).mockReturnValueOnce(pendingRefresh.promise)
    await click('최신 버전 보기')
    expect(listIssues).toHaveBeenCalledTimes(2)
    await advance()
    expect(listIssues).toHaveBeenCalledTimes(3)
    await act(async () => {
      pendingRefresh.resolve([savedIssue, ...issues])
    })
    expect(within(screen.getByRole('region', { name: '쪽지 목록' })).getByText(savedIssue.title)).toBeTruthy()
    expect(queryParams().get('version')).toBe(current.id)
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '버전' }).value).toBe(current.id)
    expect(photo().getAttribute('src')).toBe('/api/assets/current-product')
    await chooseIssue(savedIssue)
    fillComment()
    const detail = screen.getByRole('article', { name: '쪽지 #5' })
    await act(async () => {
      pendingLatest.resolve(issues)
    })

    const list = within(screen.getByRole('region', { name: '쪽지 목록' }))
    expect(list.getAllByRole('listitem')).toHaveLength(5)
    expect(list.getByText(savedIssue.title)).toBeTruthy()
    expect(queryParams().get('issue')).toBe(savedIssue.id)
    expect(queryParams().has('version')).toBe(false)
    expect(screen.getByRole('article', { name: '쪽지 #5' })).toBe(detail)
    expect(within(detail).getByText(savedIssue.body)).toBeTruthy()
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '댓글' }).value).toBe(savedComment.body)
    expect(screen.queryByText('없는 쪽지예요.')).toBeNull()
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '버전' }).value).toBe(latest.id)
    expect(screen.getByRole('option', { name: '2차' })).toBeTruthy()
    expect(photo().getAttribute('src')).toBe('/api/assets/new-current-product')
    expect(screen.queryByText(/처음 사진의 위치를 보여 드려요/)).toBeNull()
  })
})

describe('ReviewRoomPage 검수실을 떠난 뒤 응답과 버전 재시도', () => {
  const otherProject: ProjectDetail = {
    ...project,
    id: 'a6666666-6666-4666-8666-666666666666',
    name: '다른 검수 프로젝트',
    currentVersion: { id: 'b6666666-6666-4666-8666-666666666666', number: 1 },
  }
  const otherVersion: VersionDetail = {
    ...current,
    id: otherProject.currentVersion!.id,
    projectId: otherProject.id,
    screens: current.screens.map((item) => ({
      ...item,
      asset: { ...item.asset, id: `other-${item.asset.id}` },
    })),
  }
  const destinations = [
    { page: '프로젝트 목록', address: '/?filter=active', heading: '프로젝트 목록' },
    {
      page: '다른 프로젝트 검수실',
      address: `/projects/${otherProject.id}?version=${otherVersion.id}&keep=other`,
      heading: otherProject.name,
    },
  ]

  beforeEach(() => {
    vi.mocked(listVersions).mockImplementation(async (id) =>
      id === otherProject.id ? [otherVersion] : [latest, current, initial],
    )
    vi.mocked(listIssues).mockImplementation(async (id) => (id === otherProject.id ? [] : issues))
    vi.mocked(getVersion).mockImplementation(async (id) => {
      const version = [current, initial, latest, otherVersion].find((item) => item.id === id)
      if (!version) throw new ApiError(404)
      return version
    })
  })

  it.each(destinations)(
    '쪽지 저장을 기다리다 $page으로 이동하면 늦은 저장 응답은 pathname과 search를 바꾸지 않는다',
    async ({ address, heading }) => {
      vi.mocked(getProject).mockImplementation(async (id) => (id === otherProject.id ? otherProject : project))
      const pendingIssue = deferred<IssueDetail>()
      vi.mocked(createIssue).mockReturnValueOnce(pendingIssue.promise)
      await renderRoom(`?version=${current.id}&keep=original`, address)
      await click('쪽지 쓰기')
      fillDraft()
      await click('쪽지 남기기')
      expect(createIssue).toHaveBeenCalledExactlyOnceWith(project.id, {
        requestId: expect.any(String),
        versionId: current.id,
        title: savedIssue.title,
        body: savedIssue.body,
        pin: undefined,
      })

      await act(async () => {
        fireEvent.click(screen.getByRole('link', { name: '다른 페이지로 이동' }))
      })
      expect(screen.getByLabelText('현재 주소').textContent).toBe(address)
      expect(screen.getByRole('heading', { name: heading })).toBeTruthy()
      await act(async () => {
        pendingIssue.resolve({ ...savedIssue, origin: null })
      })

      expect(screen.getByLabelText('현재 주소').textContent).toBe(address)
      expect(screen.getByRole('heading', { name: heading })).toBeTruthy()
      expect(screen.queryByRole('heading', { name: project.name })).toBeNull()
      expect(queryParams().has('issue')).toBe(false)
      expect(queryParams().get('version')).not.toBe(current.id)
      expect(getIssue).not.toHaveBeenCalledWith(savedIssue.id)
    },
  )

  it.each(destinations)(
    '최신 버전 보기를 기다리다 $page으로 이동하면 늦은 프로젝트 응답은 pathname과 search를 바꾸지 않는다',
    async ({ address, heading }) => {
      vi.mocked(createComment).mockRejectedValueOnce(new ApiError(409, 'VERSION_CHANGED'))
      await renderRoom(`?version=${current.id}&issue=${productIssue.id}&keep=original`, address)
      fillComment()
      await click('댓글 남기기')
      expect(screen.getByText('새 버전이 올라왔어요. 쓰던 글은 그대로 남아 있어요.')).toBeTruthy()
      const pendingProject = deferred<ProjectDetail>()
      vi.mocked(getProject)
        .mockImplementation(async (id) => (id === otherProject.id ? otherProject : project))
        .mockReturnValueOnce(pendingProject.promise)
      await click('최신 버전 보기')
      expect(getProject).toHaveBeenCalledTimes(2)
      expect(queryParams().get('version')).toBe(current.id)

      await act(async () => {
        fireEvent.click(screen.getByRole('link', { name: '다른 페이지로 이동' }))
      })
      expect(screen.getByLabelText('현재 주소').textContent).toBe(address)
      expect(screen.getByRole('heading', { name: heading })).toBeTruthy()
      await act(async () => {
        pendingProject.resolve({ ...project, currentVersion: { id: latest.id, number: 2 } })
      })

      expect(screen.getByLabelText('현재 주소').textContent).toBe(address)
      expect(screen.getByRole('heading', { name: heading })).toBeTruthy()
      expect(screen.queryByRole('heading', { name: project.name })).toBeNull()
      expect(queryParams().has('issue')).toBe(false)
      expect(queryParams().get('version')).not.toBe(current.id)
      expect(getVersion).not.toHaveBeenCalledWith(latest.id)
    },
  )

  it('최신 버전 상세가 500으로 실패해도 글이 남고 다시 누르면 같은 버전을 불러 복구한 뒤 새 versionId로 저장한다', async () => {
    vi.mocked(createIssue).mockRejectedValueOnce(new ApiError(409, 'VERSION_CHANGED'))
    await renderRoom(`?version=${current.id}&keep=yes`)
    await click('쪽지 쓰기')
    fillDraft()
    await click('쪽지 남기기')
    expect(screen.getByText('새 버전이 올라왔어요. 쓰던 글은 그대로 남아 있어요.')).toBeTruthy()
    publishLatest()
    const firstVersion = deferred<VersionDetail>()
    vi.mocked(getVersion).mockImplementation((id) =>
      id === latest.id ? firstVersion.promise : Promise.resolve(current),
    )
    await click('최신 버전 보기')
    expect(vi.mocked(getVersion).mock.calls.filter(([id]) => id === latest.id)).toEqual([[latest.id]])
    expectDraft()
    await act(async () => {
      firstVersion.reject(new ApiError(500))
    })

    expect(screen.getByText('잠시 뒤 다시 시도해 주세요')).toBeTruthy()
    expect(screen.queryByRole('img', { name: '상품 상세 · PC' })).toBeNull()
    expect(screen.queryByRole('combobox', { name: '버전' })).toBeNull()
    expect(screen.queryByRole('button', { name: '쪽지 남기기' })).toBeNull()
    expectDraft()
    const address = screen.getByLabelText('현재 주소').textContent
    const secondVersion = deferred<VersionDetail>()
    vi.mocked(getVersion).mockReturnValueOnce(secondVersion.promise)
    await click('최신 버전 보기')
    expect(getProject).toHaveBeenCalledTimes(3)
    expect(vi.mocked(getVersion).mock.calls.filter(([id]) => id === latest.id)).toEqual([[latest.id], [latest.id]])
    expect(screen.getByLabelText('현재 주소').textContent).toBe(address)
    expectDraft()
    await act(async () => {
      secondVersion.resolve(latest)
    })

    expect(screen.queryByText('잠시 뒤 다시 시도해 주세요')).toBeNull()
    expect(photo().getAttribute('src')).toBe('/api/assets/new-current-product')
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '버전' }).value).toBe(latest.id)
    expectDraft()
    const created = { ...savedIssue, origin: null, originVersion: { id: latest.id, number: 2 } }
    vi.mocked(createIssue).mockResolvedValueOnce(created)
    vi.mocked(getIssue).mockResolvedValueOnce(created)
    await click('쪽지 남기기')
    expect(createIssue).toHaveBeenCalledTimes(2)
    expect(vi.mocked(createIssue).mock.calls[1]).toEqual([
      project.id,
      { ...vi.mocked(createIssue).mock.calls[0][1], versionId: latest.id },
    ])
    expect(queryParams().get('issue')).toBe(created.id)
    expect(within(screen.getByRole('article', { name: '쪽지 #5' })).getByText(created.body)).toBeTruthy()
  })

  it('최신 사진을 보여 주다가 같은 버전 상세를 다시 불러 500으로 실패하면 사진과 글을 남기고 불러오기 오류를 보이지 않는다', async () => {
    vi.mocked(createIssue).mockRejectedValueOnce(new ApiError(409, 'VERSION_CHANGED'))
    await renderRoom(`?version=${current.id}`)
    await click('쪽지 쓰기')
    fillDraft()
    await click('쪽지 남기기')
    publishLatest()
    const firstVersion = deferred<VersionDetail>()
    vi.mocked(getVersion).mockImplementation((id) =>
      id === latest.id ? firstVersion.promise : Promise.resolve(current),
    )
    await click('최신 버전 보기')
    await act(async () => {
      firstVersion.resolve(latest)
    })
    const shownPhoto = photo()
    expect(shownPhoto.getAttribute('src')).toBe('/api/assets/new-current-product')
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '버전' }).value).toBe(latest.id)
    expectDraft()
    const alerts = screen.getAllByRole('alert').map((alert) => alert.textContent)
    const pendingVersion = deferred<VersionDetail>()
    vi.mocked(getVersion).mockReturnValueOnce(pendingVersion.promise)
    await click('최신 버전 보기')
    expect(getProject).toHaveBeenCalledTimes(3)
    expect(vi.mocked(getVersion).mock.calls.filter(([id]) => id === latest.id)).toEqual([[latest.id], [latest.id]])
    expect(photo()).toBe(shownPhoto)
    await act(async () => {
      pendingVersion.reject(new ApiError(500))
    })

    expect(photo()).toBe(shownPhoto)
    expect(photo().getAttribute('src')).toBe('/api/assets/new-current-product')
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '버전' }).value).toBe(latest.id)
    expect(screen.queryByText('잠시 뒤 다시 시도해 주세요')).toBeNull()
    expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toEqual(alerts)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '쪽지 남기기' }).disabled).toBe(false)
    expectDraft()
  })
})

describe('ReviewRoomPage 댓글의 최신 버전 복구와 중복 요청', () => {
  it('댓글 409 뒤 최신 버전 상세가 500이면 최신 버전 보기로 같은 버전을 다시 불러 쓰던 댓글을 새 versionId로 보낸다', async () => {
    vi.mocked(createComment).mockRejectedValueOnce(new ApiError(409, 'VERSION_CHANGED'))
    await renderRoom(`?version=${current.id}&issue=${productIssue.id}`)
    fillComment()
    await click('댓글 남기기')
    expect(screen.getByText('새 버전이 올라왔어요. 쓰던 글은 그대로 남아 있어요.')).toBeTruthy()
    const firstRequest = structuredClone(vi.mocked(createComment).mock.calls[0])
    expect(firstRequest[1].versionId).toBe(current.id)
    publishLatest()
    const firstVersion = deferred<VersionDetail>()
    vi.mocked(getVersion).mockImplementation((id) =>
      id === latest.id ? firstVersion.promise : Promise.resolve(current),
    )
    await click('최신 버전 보기')
    expect(vi.mocked(getVersion).mock.calls.filter(([id]) => id === latest.id)).toEqual([[latest.id]])
    await act(async () => {
      firstVersion.reject(new ApiError(500))
    })

    expect(screen.getByText('잠시 뒤 다시 시도해 주세요')).toBeTruthy()
    expect(screen.queryByRole('img', { name: '상품 상세 · PC' })).toBeNull()
    expect(screen.queryByRole('textbox', { name: '댓글' })).toBeNull()
    expect(screen.queryByRole('button', { name: '댓글 남기기' })).toBeNull()
    expect(screen.getByText('새 버전이 올라왔어요. 쓰던 글은 그대로 남아 있어요.')).toBeTruthy()
    expect(screen.getByRole('button', { name: '최신 버전 보기' })).toBeTruthy()
    expect(queryParams().get('issue')).toBe(productIssue.id)
    const secondVersion = deferred<VersionDetail>()
    vi.mocked(getVersion).mockReturnValueOnce(secondVersion.promise)
    await click('최신 버전 보기')
    expect(getProject).toHaveBeenCalledTimes(3)
    expect(vi.mocked(getVersion).mock.calls.filter(([id]) => id === latest.id)).toEqual([[latest.id], [latest.id]])
    await act(async () => {
      secondVersion.resolve(latest)
    })

    expect(screen.queryByText('잠시 뒤 다시 시도해 주세요')).toBeNull()
    expect(photo().getAttribute('src')).toBe('/api/assets/new-current-product')
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '버전' }).value).toBe(latest.id)
    expect(queryParams().get('issue')).toBe(productIssue.id)
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '댓글' }).value).toBe(savedComment.body)
    await click('댓글 남기기')
    expect(createComment).toHaveBeenCalledTimes(2)
    expect(vi.mocked(createComment).mock.calls[1]).toEqual([
      productIssue.id,
      { ...firstRequest[1], versionId: latest.id },
    ])
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '댓글' }).value).toBe('')
  })

  it.each(['성공', '실패'] as const)(
    '최신 버전 보기의 프로젝트 응답을 기다리는 중에는 한 번만 요청하고 %s 뒤에는 다시 요청할 수 있다',
    async (result) => {
      vi.mocked(createComment).mockRejectedValueOnce(new ApiError(409, 'VERSION_CHANGED'))
      await renderRoom(`?version=${current.id}&issue=${productIssue.id}`)
      fillComment()
      await click('댓글 남기기')
      publishLatest()
      const firstProject = deferred<ProjectDetail>()
      vi.mocked(getProject).mockClear().mockReturnValueOnce(firstProject.promise)
      await click('최신 버전 보기')
      expect(getProject).toHaveBeenCalledExactlyOnceWith(project.id)
      await click('최신 버전 보기')
      expect(getProject).toHaveBeenCalledExactlyOnceWith(project.id)
      expect(queryParams().get('version')).toBe(current.id)
      expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '댓글' }).value).toBe(savedComment.body)

      await act(async () => {
        if (result === '실패') {
          firstProject.reject(new ApiError(500))
          return
        }
        firstProject.resolve({ ...project, currentVersion: { id: latest.id, number: 2 } })
      })
      expect(getProject).toHaveBeenCalledTimes(1)
      expect(photo().getAttribute('src')).toBe(
        result === '성공' ? '/api/assets/new-current-product' : '/api/assets/current-product',
      )
      const secondProject = deferred<ProjectDetail>()
      vi.mocked(getProject).mockReturnValueOnce(secondProject.promise)
      await click('최신 버전 보기')
      expect(getProject).toHaveBeenCalledTimes(2)
      expect(getProject).toHaveBeenNthCalledWith(2, project.id)
      await click('최신 버전 보기')
      expect(getProject).toHaveBeenCalledTimes(2)
      await act(async () => {
        secondProject.resolve({ ...project, currentVersion: { id: latest.id, number: 2 } })
      })
      expect(photo().getAttribute('src')).toBe('/api/assets/new-current-product')
      expect(queryParams().has('version')).toBe(false)
      expect(queryParams().get('issue')).toBe(productIssue.id)
      expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '댓글' }).value).toBe(savedComment.body)
      expect(createComment).toHaveBeenCalledTimes(1)
    },
  )
})

describe('ReviewRoomPage 작성 상태 경계', () => {
  it('잠기지 않은 쪽지를 쓰다가 지난 버전을 고르면 새 글을 보내는 버튼은 없다', async () => {
    await renderRoom()
    await placePin()
    fillDraft()
    await chooseVersion(initial.id)
    expect(screen.queryByRole('button', { name: '쪽지 남기기' })).toBeNull()
    expect(screen.queryByRole('button', { name: '쪽지 쓰기' })).toBeNull()
    expect(screen.queryByRole('img', { name: '새 쪽지 위치' })).toBeNull()
    expect(createIssue).not.toHaveBeenCalled()
  })

  it('응답이 끊긴 뒤 다시 보내기가 세션 만료로 실패해도 잠긴 채로 남고 다시 로그인해 보내면 쪽지는 하나만 생긴다', async () => {
    vi.mocked(createIssue).mockRejectedValueOnce(new TypeError('응답 끊김')).mockRejectedValueOnce(new ApiError(401))
    await renderRoom()
    await placePin()
    fillDraft()
    await click('쪽지 남기기')
    const first = vi.mocked(createIssue).mock.calls[0]
    await click('다시 보내기')
    expectDraft()
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '내용' }).readOnly).toBe(true)
    expect(screen.getByRole('link', { name: '새 탭에서 로그인하기' }).getAttribute('target')).toBe('_blank')
    await placePin('상품 상세 · PC', 420, 90)
    expect(screen.getByRole('img', { name: '새 쪽지 위치' }).style.left).toBe('25%')
    await click('다시 보내기')
    expect(vi.mocked(createIssue).mock.calls).toEqual([first, first, first])
    expect(within(screen.getByRole('region', { name: '쪽지 목록' })).getAllByText(savedIssue.title)).toHaveLength(1)
  })

  it('잠긴 쪽지의 제목과 내용은 읽고 복사할 수 있도록 readOnly로 남긴다', async () => {
    vi.mocked(createIssue).mockRejectedValueOnce(new ApiError(503))
    await renderRoom()
    await placePin()
    fillDraft()
    await click('쪽지 남기기')
    const title = screen.getByRole<HTMLInputElement>('textbox', { name: '제목 (필수)' })
    const body = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '내용' })
    expect(title.disabled).toBe(false)
    expect(title.readOnly).toBe(true)
    expect(body.disabled).toBe(false)
    expect(body.readOnly).toBe(true)
  })

  it('잠긴 요청을 취소하면 잠금과 임시 핀이 사라지고 새 사진에 새 요청을 쓸 수 있다', async () => {
    vi.mocked(createIssue).mockRejectedValueOnce(new TypeError('응답 끊김'))
    await renderRoom()
    await placePin()
    fillDraft()
    await click('쪽지 남기기')
    const first = vi.mocked(createIssue).mock.calls[0][1]
    await click('취소')
    expect(screen.queryByRole('button', { name: '다시 보내기' })).toBeNull()
    expect(screen.queryByRole('img', { name: '새 쪽지 위치' })).toBeNull()
    await placePin('상품 상세 · PC', 420, 90)
    fillDraft()
    await click('쪽지 남기기')
    const second = vi.mocked(createIssue).mock.calls[1][1]
    expect(second.requestId).not.toBe(first.requestId)
    expect(second.pin).toEqual({ screenId: current.screens[0].screenId, xRatio: 0.8, yRatio: 0.1 })
  })

  it('새 버전 안내 뒤 최신 사진에서 자리를 고르지 않으면 pin 없이 새 versionId로 보낸다', async () => {
    vi.mocked(createIssue).mockRejectedValueOnce(new ApiError(409, 'VERSION_CHANGED'))
    await renderRoom(`?version=${current.id}`)
    await placePin()
    fillDraft()
    await click('쪽지 남기기')
    publishLatest()
    await click('최신 버전 보기')
    expectDraft()
    await click('쪽지 남기기')
    expect(vi.mocked(createIssue).mock.calls[1][1]).toEqual({
      requestId: vi.mocked(createIssue).mock.calls[0][1].requestId,
      versionId: latest.id,
      title: savedIssue.title,
      body: savedIssue.body,
      pin: undefined,
    })
  })

  it('같은 쪽지의 버전만 바꿨다가 돌아오면 쓰던 댓글이 남는다', async () => {
    await renderRoom(`?issue=${productIssue.id}`)
    fillComment()
    await chooseVersion(initial.id)
    expect(screen.queryByRole('textbox', { name: '댓글' })).toBeNull()
    await chooseVersion(current.id)
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '댓글' }).value).toBe(savedComment.body)
  })

  it('다른 쪽지를 열면 이전 쪽지에 쓰던 댓글은 새 쪽지로 넘어가지 않는다', async () => {
    await renderRoom(`?issue=${productIssue.id}`)
    fillComment()
    await chooseIssue(cartIssue)
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '댓글' }).value).toBe('')
    expect(screen.getByRole('article', { name: '쪽지 #2' })).toBeTruthy()
  })

  it('상세 불러오기가 실패해도 쪽지 목록과 사진은 남고 다른 쪽지를 열 수 있다', async () => {
    vi.mocked(getIssue).mockRejectedValueOnce(new TypeError('연결 실패'))
    await renderRoom(`?issue=${productIssue.id}`)
    expect(screen.getByText('연결을 확인하고 다시 시도해 주세요')).toBeTruthy()
    expect(screen.getByRole('region', { name: '쪽지 목록' })).toBeTruthy()
    expect(photo()).toBeTruthy()
    await chooseIssue(cartIssue)
    expect(screen.getByRole('article', { name: '쪽지 #2' })).toBeTruthy()
    expect(screen.queryByText('연결을 확인하고 다시 시도해 주세요')).toBeNull()
  })
})

describe('ReviewRoomPage 댓글 보존과 응답 순서', () => {
  it('A의 댓글 저장 응답을 기다리다 B 상세를 열면 늦은 댓글은 B에 붙지 않고 댓글 0개가 유지된다', async () => {
    const pendingComment = deferred<typeof savedComment>()
    vi.mocked(createComment).mockReturnValueOnce(pendingComment.promise)
    await renderRoom(`?issue=${productIssue.id}`)
    fillComment()
    await click('댓글 남기기')
    expect(createComment).toHaveBeenCalledExactlyOnceWith(productIssue.id, {
      requestId: expect.any(String),
      versionId: current.id,
      body: savedComment.body,
    })

    await chooseIssue(cartIssue)
    const detail = screen.getByRole('article', { name: '쪽지 #2' })
    expect(within(detail).getByRole('heading', { name: cartIssue.title })).toBeTruthy()
    expect(within(detail).getByRole('heading', { name: '댓글 0개' })).toBeTruthy()
    expect(within(detail).queryByText(savedComment.body)).toBeNull()

    await act(async () => pendingComment.resolve(savedComment))

    const shownDetail = screen.getByRole('article', { name: '쪽지 #2' })
    expect(within(shownDetail).getByRole('heading', { name: cartIssue.title })).toBeTruthy()
    expect(within(shownDetail).queryByText(savedComment.body)).toBeNull()
    expect(within(shownDetail).getByRole('heading', { name: '댓글 0개' })).toBeTruthy()
    expect(vi.mocked(getIssue).mock.calls).toEqual([[productIssue.id], [cartIssue.id]])
  })

  it.each(['수정 시작', '참고 사진 붙이기', '지우기'] as const)(
    '%s를 기다리는 사이 저장한 댓글은 늦은 변경 응답 뒤에도 남고 새 상세로 갱신된다',
    async (action) => {
      const pendingChange = deferred<IssueDetail>()
      const pendingRefresh = deferred<IssueDetail>()
      vi.mocked(startIssue).mockReturnValueOnce(pendingChange.promise)
      vi.mocked(attachIssuePhoto).mockReturnValueOnce(pendingChange.promise)
      vi.mocked(removeIssuePhoto).mockReturnValueOnce(pendingChange.promise)
      await renderRoom(`?issue=${productIssue.id}`)

      if (action === '참고 사진 붙이기') {
        const file = new File(['photo'], 'reference.png', { type: 'image/png' })
        await act(async () => {
          fireEvent.change(screen.getByLabelText(action), { target: { files: [file] } })
        })
        expect(attachIssuePhoto).toHaveBeenCalledExactlyOnceWith(productIssue.id, file)
      }
      if (action !== '참고 사진 붙이기') await click(action)
      if (action === '수정 시작') expect(startIssue).toHaveBeenCalledExactlyOnceWith(productIssue.id, current.id)
      if (action === '지우기') {
        expect(removeIssuePhoto).toHaveBeenCalledExactlyOnceWith(productIssue.id, productIssue.attachments[0].id)
      }

      const withComment = { ...productIssue, comments: [savedComment], commentCount: 1 }
      vi.mocked(getIssue).mockResolvedValueOnce(withComment).mockReturnValueOnce(pendingRefresh.promise)
      fillComment()
      await click('댓글 남기기')
      expect(createComment).toHaveBeenCalledTimes(1)
      expect(getIssue).toHaveBeenCalledTimes(2)
      expect(screen.getByText(savedComment.body)).toBeTruthy()
      expect(screen.getByRole('heading', { name: '댓글 1개' })).toBeTruthy()

      const changed: IssueDetail = {
        ...productIssue,
        status: action === '수정 시작' ? 'IN_PROGRESS' : 'OPEN',
        attachments:
          action === '참고 사진 붙이기'
            ? [...productIssue.attachments, { id: 'attachment-2', assetId: 'new-reference', width: 400, height: 300 }]
            : action === '지우기'
              ? []
              : productIssue.attachments,
        body: '늦은 변경 응답의 본문',
      }
      await act(async () => pendingChange.resolve(changed))
      expect(vi.mocked(getIssue).mock.calls).toEqual([[productIssue.id], [productIssue.id], [productIssue.id]])
      expect(screen.getByText(savedComment.body)).toBeTruthy()
      expect(screen.getByRole('heading', { name: '댓글 1개' })).toBeTruthy()
      expect(screen.queryByText(changed.body)).toBeNull()

      const refreshed: IssueDetail = {
        ...changed,
        body: '변경 뒤 새로 받은 상세',
        comments: [savedComment],
        commentCount: 1,
      }
      await act(async () => pendingRefresh.resolve(refreshed))
      expect(screen.getByText(refreshed.body)).toBeTruthy()
      expect(screen.getByText(savedComment.body)).toBeTruthy()
      expect(screen.getByRole('heading', { name: '댓글 1개' })).toBeTruthy()
      if (action === '수정 시작') {
        expect(within(screen.getByRole('article')).getByText('수정 중')).toBeTruthy()
        expect(screen.queryByRole('button', { name: '수정 시작' })).toBeNull()
      }
      if (action === '참고 사진 붙이기') {
        expect(screen.getByRole('img', { name: '참고 사진 2' }).getAttribute('src')).toBe('/api/assets/new-reference')
      }
      if (action === '지우기') expect(screen.queryByRole('img', { name: '참고 사진 1' })).toBeNull()
    },
  )

  it.each(['끝난', '아직 끝나지 않은'])(
    '수정 시작을 기다리는 사이 시작해 %s 15초 갱신보다 늦은 변경 응답은 버리고 다시 조회한다',
    async (refreshState) => {
      vi.useFakeTimers()
      const pendingStart = deferred<IssueDetail>()
      const pendingPoll = deferred<IssueDetail>()
      const pendingRefresh = deferred<IssueDetail>()
      vi.mocked(startIssue).mockReturnValueOnce(pendingStart.promise)
      await renderRoom(`?issue=${productIssue.id}`)
      await click('수정 시작')
      expect(startIssue).toHaveBeenCalledTimes(1)
      vi.mocked(getIssue).mockReturnValueOnce(pendingPoll.promise).mockReturnValueOnce(pendingRefresh.promise)
      await advance()
      expect(getIssue).toHaveBeenCalledTimes(2)
      const polled = { ...productIssue, body: '15초 갱신의 본문' }
      if (refreshState === '끝난') await act(async () => pendingPoll.resolve(polled))

      await act(async () => {
        pendingStart.resolve({ ...productIssue, status: 'IN_PROGRESS', body: '늦은 수정 시작 본문' })
      })
      expect(getIssue).toHaveBeenCalledTimes(3)
      expect(screen.queryByText('늦은 수정 시작 본문')).toBeNull()
      expect(screen.getByText(refreshState === '끝난' ? polled.body : productIssue.body)).toBeTruthy()

      const refreshed: IssueDetail = {
        ...productIssue,
        status: 'IN_PROGRESS',
        body: '수정 시작 뒤 다시 받은 본문',
        comments: [savedComment],
        commentCount: 1,
      }
      await act(async () => pendingRefresh.resolve(refreshed))
      if (refreshState === '아직 끝나지 않은') await act(async () => pendingPoll.resolve(polled))
      expect(screen.getByText(refreshed.body)).toBeTruthy()
      expect(screen.queryByText(polled.body)).toBeNull()
      expect(screen.getByText(savedComment.body)).toBeTruthy()
      expect(within(screen.getByRole('article')).getByText('수정 중')).toBeTruthy()
      expect(screen.queryByRole('button', { name: '수정 시작' })).toBeNull()
      expect(vi.mocked(getIssue).mock.calls).toEqual([[productIssue.id], [productIssue.id], [productIssue.id]])
    },
  )

  it.each([
    { reason: '500', error: new ApiError(500) },
    { reason: '연결 끊김', error: new TypeError('연결 끊김') },
  ])('댓글 저장 뒤 상세 조회가 $reason이어도 댓글을 보여 주고 다음 15초 결과로 갱신한다', async ({ error }) => {
    vi.useFakeTimers()
    const pendingRefresh = deferred<IssueDetail>()
    await renderRoom(`?issue=${productIssue.id}`)
    vi.mocked(getIssue).mockReturnValueOnce(pendingRefresh.promise)
    fillComment()
    await click('댓글 남기기')
    expect(createComment).toHaveBeenCalledTimes(1)
    expect(getIssue).toHaveBeenCalledTimes(2)
    expect(screen.getByText(savedComment.body)).toBeTruthy()
    await act(async () => pendingRefresh.reject(error))

    const comments = within(screen.getByRole('region', { name: '댓글' }))
    expect(comments.getByText(savedComment.body)).toBeTruthy()
    expect(comments.getAllByRole('listitem')).toHaveLength(1)
    expect(comments.getByRole('heading', { name: '댓글 1개' })).toBeTruthy()
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '댓글' }).value).toBe('')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText('연결을 확인하고 다시 시도해 주세요')).toBeNull()
    expect(screen.queryByText('잠시 뒤 다시 시도해 주세요')).toBeNull()

    const anotherComment = { ...savedComment, id: 'comment-other', body: '다른 참여자가 남긴 댓글' }
    vi.mocked(getIssue).mockResolvedValueOnce({
      ...productIssue,
      body: '다음 갱신의 본문',
      comments: [savedComment, anotherComment],
      commentCount: 2,
    })
    await advance()
    expect(getIssue).toHaveBeenCalledTimes(3)
    expect(screen.getByText('다음 갱신의 본문')).toBeTruthy()
    expect(comments.getByText(anotherComment.body)).toBeTruthy()
    expect(comments.getAllByRole('listitem')).toHaveLength(2)
    expect(comments.getByRole('heading', { name: '댓글 2개' })).toBeTruthy()
    expect(createComment).toHaveBeenCalledTimes(1)
  })

  it.each(['처음 보내기', '잠긴 댓글 다시 보내기'])(
    '15초 갱신으로 이미 보이는 댓글은 %s 응답을 받아도 하나만 보인다',
    async (sending) => {
      vi.useFakeTimers()
      const pendingComment = deferred<typeof savedComment>()
      const pendingRefresh = deferred<IssueDetail>()
      await renderRoom(`?issue=${productIssue.id}`)
      fillComment()
      if (sending === '잠긴 댓글 다시 보내기') {
        vi.mocked(createComment).mockRejectedValueOnce(new TypeError('연결 끊김'))
        await click('댓글 남기기')
        expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '댓글' }).readOnly).toBe(true)
      }
      vi.mocked(createComment).mockReturnValueOnce(pendingComment.promise)
      await click(sending === '처음 보내기' ? '댓글 남기기' : '다시 보내기')
      vi.mocked(getIssue)
        .mockResolvedValueOnce({ ...productIssue, comments: [savedComment], commentCount: 1 })
        .mockReturnValueOnce(pendingRefresh.promise)
      await advance()
      expect(getIssue).toHaveBeenCalledTimes(2)
      const visibleComment = within(screen.getByRole('region', { name: '댓글' })).getByRole('listitem')
      expect(within(visibleComment).getByText(savedComment.body)).toBeTruthy()

      await act(async () => pendingComment.resolve(savedComment))
      expect(getIssue).toHaveBeenCalledTimes(3)
      const comments = within(screen.getByRole('region', { name: '댓글' }))
      expect(comments.getAllByText(savedComment.body)).toHaveLength(1)
      expect(comments.getAllByRole('listitem')).toHaveLength(1)
      expect(comments.getByRole('heading', { name: '댓글 1개' })).toBeTruthy()
      expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '댓글' }).value).toBe('')
      expect(screen.queryByRole('alert')).toBeNull()
      if (sending === '잠긴 댓글 다시 보내기') {
        expect(createComment).toHaveBeenCalledTimes(2)
        expect(vi.mocked(createComment).mock.calls[1]).toEqual(vi.mocked(createComment).mock.calls[0])
      }
      // 뒤따르는 조회가 중복을 가려 주지 못하도록, 실패한 뒤에도 댓글 수를 확인한다.
      await act(async () => pendingRefresh.reject(new ApiError(500)))
      expect(comments.getAllByRole('listitem')).toHaveLength(1)
      expect(comments.getByRole('heading', { name: '댓글 1개' })).toBeTruthy()
    },
  )

  it.each(['댓글 남기기', '수정 시작'])(
    '%s 응답을 기다리다 닫으면 목록만 한 번 갱신하고 다시 열 때 상세를 새로 받는다',
    async (action) => {
      const pendingComment = deferred<typeof savedComment>()
      const pendingStart = deferred<IssueDetail>()
      vi.mocked(createComment).mockReturnValueOnce(pendingComment.promise)
      vi.mocked(startIssue).mockReturnValueOnce(pendingStart.promise)
      await renderRoom(`?issue=${productIssue.id}`)
      if (action === '댓글 남기기') fillComment()
      await click(action)
      if (action === '댓글 남기기') expect(createComment).toHaveBeenCalledTimes(1)
      if (action === '수정 시작') expect(startIssue).toHaveBeenCalledTimes(1)
      await click('쪽지 닫기')
      expect(screen.queryByRole('article')).toBeNull()
      expect(queryParams().has('issue')).toBe(false)
      const listsBeforeResponse = vi.mocked(listIssues).mock.calls.length
      const detailsBeforeResponse = vi.mocked(getIssue).mock.calls.length
      await act(async () => {
        if (action === '댓글 남기기') pendingComment.resolve(savedComment)
        if (action === '수정 시작') pendingStart.resolve({ ...productIssue, status: 'IN_PROGRESS' })
      })
      expect(listIssues).toHaveBeenCalledTimes(listsBeforeResponse + 1)
      expect(getIssue).toHaveBeenCalledTimes(detailsBeforeResponse)
      expect(screen.queryByRole('article')).toBeNull()
      expect(queryParams().has('issue')).toBe(false)

      const pendingReopen = deferred<IssueDetail>()
      vi.mocked(getIssue).mockReturnValueOnce(pendingReopen.promise)
      await chooseIssue(productIssue)
      expect(getIssue).toHaveBeenCalledTimes(detailsBeforeResponse + 1)
      expect(getIssue).toHaveBeenLastCalledWith(productIssue.id)
      await act(async () => {
        pendingReopen.resolve({
          ...productIssue,
          body: '다시 열어 새로 받은 쪽지',
          status: 'IN_PROGRESS',
          comments: [savedComment],
          commentCount: 1,
        })
      })
      expect(within(screen.getByRole('article')).getByText('다시 열어 새로 받은 쪽지')).toBeTruthy()
      expect(screen.getByText(savedComment.body)).toBeTruthy()
      expect(screen.getByRole('heading', { name: '댓글 1개' })).toBeTruthy()
      expect(queryParams().get('issue')).toBe(productIssue.id)
    },
  )
})

describe('ReviewRoomPage 승인자 알림 갱신', () => {
  const membersWithClient = {
    members: [
      {
        id: 'client-member',
        name: '클라이언트',
        email: 'client@example.com',
        role: 'CLIENT' as const,
        lastSeenAt: null,
      },
    ],
    invitations: [],
  }

  it('알림이 보이던 개발자가 최신 버전 보기로 승인자가 있는 프로젝트를 받으면 알림이 사라진다', async () => {
    vi.mocked(listMembers).mockResolvedValueOnce(membersWithClient)
    await renderRoom(`?issue=${productIssue.id}`)
    expect(screen.getByText('승인자를 정해 주세요.')).toBeTruthy()
    expect(listMembers).toHaveBeenCalledExactlyOnceWith(project.id)
    vi.mocked(createComment).mockRejectedValueOnce(new ApiError(409, 'VERSION_CHANGED'))
    fillComment()
    await click('댓글 남기기')
    vi.mocked(getProject).mockResolvedValueOnce({
      ...project,
      currentVersion: { id: latest.id, number: 2 },
      approver: { memberId: 'client-member', name: '클라이언트' },
    })
    vi.mocked(listVersions).mockResolvedValueOnce([latest, current, initial])
    await click('최신 버전 보기')

    expect(getProject).toHaveBeenCalledTimes(2)
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '버전' }).value).toBe(latest.id)
    expect(screen.queryByText('승인자를 정해 주세요.')).toBeNull()
    expect(screen.queryByRole('link', { name: '설정으로 가기' })).toBeNull()
    expect(listMembers).toHaveBeenCalledTimes(1)
  })

  it('승인자가 여전히 없으면 참여자를 다시 조회하고 먼저 보낸 늦은 응답이 새 알림을 지우지 않는다', async () => {
    const olderMembers = deferred<Awaited<ReturnType<typeof listMembers>>>()
    const newerMembers = deferred<Awaited<ReturnType<typeof listMembers>>>()
    vi.mocked(listMembers)
      .mockResolvedValueOnce(membersWithClient)
      .mockReturnValueOnce(olderMembers.promise)
      .mockReturnValueOnce(newerMembers.promise)
    await renderRoom(`?issue=${productIssue.id}`)
    expect(screen.getByText('승인자를 정해 주세요.')).toBeTruthy()
    vi.mocked(createComment).mockRejectedValueOnce(new ApiError(409, 'VERSION_CHANGED'))
    fillComment()
    await click('댓글 남기기')

    // 프로젝트는 매번 새 응답 객체다. 첫 재조회가 늦어진 사이 한 번 더 최신 버전을 확인한다.
    vi.mocked(getProject)
      .mockResolvedValueOnce({ ...project })
      .mockResolvedValueOnce({ ...project })
    await click('최신 버전 보기')
    expect(listMembers).toHaveBeenCalledTimes(2)
    expect(screen.getByText('승인자를 정해 주세요.')).toBeTruthy()
    await click('최신 버전 보기')
    expect(listMembers).toHaveBeenCalledTimes(3)
    await act(async () => newerMembers.resolve(membersWithClient))
    expect(screen.getByText('승인자를 정해 주세요.')).toBeTruthy()

    await act(async () => olderMembers.resolve({ members: [], invitations: [] }))
    expect(screen.getByText('승인자를 정해 주세요.')).toBeTruthy()
    expect(screen.getByRole('link', { name: '설정으로 가기' }).getAttribute('href')).toBe(
      `/projects/${project.id}/settings`,
    )
    expect(vi.mocked(listMembers).mock.calls).toEqual([[project.id], [project.id], [project.id]])
  })

  it('최신 버전에서 클라이언트가 없다고 확인되면 기존 승인자 알림을 없앤다', async () => {
    vi.mocked(listMembers)
      .mockResolvedValueOnce(membersWithClient)
      .mockResolvedValueOnce({ members: [], invitations: [] })
    await renderRoom(`?issue=${productIssue.id}`)
    expect(screen.getByText('승인자를 정해 주세요.')).toBeTruthy()
    vi.mocked(createComment).mockRejectedValueOnce(new ApiError(409, 'VERSION_CHANGED'))
    fillComment()
    await click('댓글 남기기')
    vi.mocked(getProject).mockResolvedValueOnce({ ...project })
    await click('최신 버전 보기')

    expect(listMembers).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('승인자를 정해 주세요.')).toBeNull()
    expect(screen.queryByRole('link', { name: '설정으로 가기' })).toBeNull()
  })
})

describe('ReviewRoomPage 댓글 초안을 남기고 새 쪽지 쓰기', () => {
  it.each([
    { action: '사진 누르기', compose: () => placePin(), pinned: true },
    { action: '쪽지 쓰기 버튼', compose: () => click('쪽지 쓰기'), pinned: false },
  ])('$action은 쓰던 댓글이 있으면 묻고 취소하면 그대로 두며 확인하면 쓰기 칸을 연다', async ({ compose, pinned }) => {
    await renderRoom(`?version=${current.id}&issue=${productIssue.id}`)
    fillComment()
    const address = screen.getByLabelText('현재 주소').textContent
    vi.mocked(window.confirm).mockReturnValueOnce(false)

    await compose()
    expect(window.confirm).toHaveBeenCalledExactlyOnceWith('쓰던 댓글이 사라져요. 새 쪽지를 쓸까요?')
    expect(screen.queryByRole('textbox', { name: '제목 (필수)' })).toBeNull()
    expect(screen.getByRole('article', { name: '쪽지 #1' })).toBeTruthy()
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '댓글' }).value).toBe(savedComment.body)
    expect(screen.getByLabelText('현재 주소').textContent).toBe(address)
    expect(screen.queryByRole('img', { name: '새 쪽지 위치' })).toBeNull()
    expect(createComment).not.toHaveBeenCalled()
    expect(createIssue).not.toHaveBeenCalled()

    await compose()
    expect(window.confirm).toHaveBeenCalledTimes(2)
    expect(window.confirm).toHaveBeenLastCalledWith('쓰던 댓글이 사라져요. 새 쪽지를 쓸까요?')
    expect(screen.getByRole('textbox', { name: '제목 (필수)' })).toBeTruthy()
    expect(screen.queryByRole('article', { name: '쪽지 #1' })).toBeNull()
    expect(queryParams().has('issue')).toBe(false)
    expect(queryParams().get('version')).toBe(current.id)
    expect(screen.queryByRole('img', { name: '새 쪽지 위치' }) !== null).toBe(pinned)
  })

  it.each([
    { action: '사진 누르기', compose: () => placePin(), body: '' },
    { action: '사진 누르기', compose: () => placePin(), body: ' \n\t ' },
    { action: '쪽지 쓰기 버튼', compose: () => click('쪽지 쓰기'), body: '' },
    { action: '쪽지 쓰기 버튼', compose: () => click('쪽지 쓰기'), body: ' \n\t ' },
  ])('$action은 댓글이 "$body"이면 묻지 않고 쓰기 칸을 연다', async ({ compose, body }) => {
    await renderRoom(`?issue=${productIssue.id}`)
    fireEvent.change(screen.getByRole('textbox', { name: '댓글' }), { target: { value: body } })
    await compose()
    expect(window.confirm).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name: '제목 (필수)' })).toBeTruthy()
    expect(queryParams().has('issue')).toBe(false)
  })

  it.each([
    { state: '보내는 중', action: '사진 누르기', compose: () => placePin() },
    { state: '보내는 중', action: '쪽지 쓰기 버튼', compose: () => click('쪽지 쓰기') },
    { state: '연결 실패로 잠김', action: '사진 누르기', compose: () => placePin() },
    { state: '연결 실패로 잠김', action: '쪽지 쓰기 버튼', compose: () => click('쪽지 쓰기') },
  ])('$state 댓글도 $action에서 묻고 취소하면 글과 잠금을 유지한다', async ({ state, compose }) => {
    const pending = deferred<typeof savedComment>()
    vi.mocked(createComment).mockReturnValueOnce(pending.promise)
    await renderRoom(`?issue=${productIssue.id}`)
    fillComment()
    await click('댓글 남기기')
    expect(createComment).toHaveBeenCalledTimes(1)
    if (state === '연결 실패로 잠김') {
      await act(async () => pending.reject(new TypeError('Failed to fetch')))
      expect(screen.getByRole('button', { name: '다시 보내기' })).toBeTruthy()
    }
    const address = screen.getByLabelText('현재 주소').textContent
    vi.mocked(window.confirm).mockReturnValueOnce(false)

    await compose()
    expect(window.confirm).toHaveBeenCalledExactlyOnceWith('쓰던 댓글이 사라져요. 새 쪽지를 쓸까요?')
    expect(screen.getByRole('article', { name: '쪽지 #1' })).toBeTruthy()
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '댓글' }).value).toBe(savedComment.body)
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '댓글' }).readOnly).toBe(true)
    expect(screen.getByLabelText('현재 주소').textContent).toBe(address)
    expect(screen.queryByRole('textbox', { name: '제목 (필수)' })).toBeNull()
    expect(screen.queryByRole('img', { name: '새 쪽지 위치' })).toBeNull()
    expect(createComment).toHaveBeenCalledTimes(1)

    if (state === '보내는 중') {
      await act(async () => pending.resolve(savedComment))
    }
  })

  it.each(['처음 보내기', '다시 보내기'])('댓글이 %s로 저장된 뒤 사진을 누르면 묻지 않는다', async (sending) => {
    await renderRoom(`?issue=${productIssue.id}`)
    fillComment()
    if (sending === '다시 보내기') {
      vi.mocked(createComment).mockRejectedValueOnce(new TypeError('Failed to fetch'))
      await click('댓글 남기기')
    }
    vi.mocked(getIssue).mockResolvedValueOnce({ ...productIssue, comments: [savedComment], commentCount: 1 })
    await click(sending === '처음 보내기' ? '댓글 남기기' : '다시 보내기')
    expect(screen.getByText(savedComment.body)).toBeTruthy()
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '댓글' }).value).toBe('')

    await placePin()
    expect(window.confirm).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name: '제목 (필수)' })).toBeTruthy()
    expect(queryParams().has('issue')).toBe(false)
  })

  it.each(['쪽지 닫기', '다른 쪽지 열기'])(
    '댓글을 쓰다 %s를 하면 묻지 않고 이후 사진을 눌러도 묻지 않는다',
    async (action) => {
      await renderRoom(`?issue=${productIssue.id}`)
      fillComment()
      if (action === '쪽지 닫기') {
        await click('쪽지 닫기')
        expect(screen.queryByRole('article', { name: '쪽지 #1' })).toBeNull()
        expect(queryParams().has('issue')).toBe(false)
      } else {
        await chooseIssue(unpinnedIssue)
        expect(screen.getByRole('article', { name: '쪽지 #4' })).toBeTruthy()
        expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '댓글' }).value).toBe('')
        expect(queryParams().get('issue')).toBe(unpinnedIssue.id)
      }
      expect(window.confirm).not.toHaveBeenCalled()

      await placePin()
      expect(window.confirm).not.toHaveBeenCalled()
      expect(screen.getByRole('textbox', { name: '제목 (필수)' })).toBeTruthy()
      expect(queryParams().has('issue')).toBe(false)
    },
  )
})
