/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Link, MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router'
import { getMe, type Me } from '../api/auth.ts'
import { ApiError } from '../api/client.ts'
import { getIssue, listIssues } from '../api/issues.ts'
import { listMembers, type Member, type MemberList } from '../api/members.ts'
import { getProject, type ProjectDetail } from '../api/projects.ts'
import { getVersion, listVersions, type VersionDetail, type VersionSummary } from '../api/versions.ts'
import { ReviewRoomPage } from './ReviewRoomPage.tsx'
import styles from './ReviewRoomPage.module.css'

vi.mock('../api/auth.ts', async () => {
  const actual = await vi.importActual<typeof import('../api/auth.ts')>('../api/auth.ts')
  return { ...actual, getMe: vi.fn() }
})

vi.mock('../api/projects.ts', async () => {
  const actual = await vi.importActual<typeof import('../api/projects.ts')>('../api/projects.ts')
  return { ...actual, getProject: vi.fn() }
})

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

vi.mock('../api/versions.ts', async () => {
  const actual = await vi.importActual<typeof import('../api/versions.ts')>('../api/versions.ts')
  return { ...actual, listVersions: vi.fn(), getVersion: vi.fn() }
})

const user: Me = {
  id: '5b3a934d-ef8e-4ce8-b26a-a9d1cdd4983f',
  email: 'reader@example.com',
  name: '김수정',
  canCreateProjects: false,
}
const project: ProjectDetail = {
  id: 'ebf058f0-dc9e-4a14-adcd-cb2712594e5a',
  name: '오브젝트 스토어',
  myRole: 'DEVELOPER',
  currentVersion: { id: 'd565474f-17a5-4a8e-9b61-bde406fefdf3', number: 2 },
  isApprover: false,
  approver: null,
}
const currentVersion: VersionDetail = {
  approval: null,
  id: project.currentVersion!.id,
  projectId: project.id,
  number: 2,
  status: 'IN_REVIEW',
  summary: '메인을 고쳤어요.\n모바일도 확인해 주세요.',
  testUrl: 'https://example.com/review?version=2',
  publishedAt: '2026-11-08T09:00:00.000Z',
  screens: [
    {
      screenId: 'fdba89f1-38f6-4910-a5c7-6774a8e2f9ef',
      name: '메인',
      viewport: 'PC',
      hiddenAt: null,
      asset: { id: 'b11c0462-6cc9-467c-98af-bd92cae7d7b4', width: 1440, height: 900 },
    },
    {
      screenId: 'afb028f9-4966-4d5b-b13b-94e5636b5e75',
      name: '메인',
      viewport: 'MOBILE',
      hiddenAt: null,
      asset: { id: '46003560-248e-4bc1-a64d-b58e253c3022', width: 390, height: 844 },
    },
  ],
}
const firstRevision: VersionDetail = {
  ...currentVersion,
  id: '7b13b773-8835-45f0-b46f-c555b5033dc7',
  number: 1,
  status: 'APPROVED',
  approval: { approverName: '김수정', approvedAt: '2026-11-12T09:00:00.000Z' },
  summary: '지난 버전 설명',
  testUrl: null,
  publishedAt: '2026-11-07T09:00:00.000Z',
  // 지난 버전에만 있던 더 오래된 화면이 앞에 있어도 같은 screenId를 이어서 보아야 한다.
  screens: [
    {
      screenId: '581ad983-2dfa-4f8e-98ab-338ec16dba77',
      name: '소개',
      viewport: 'PC',
      hiddenAt: null,
      asset: { id: 'old-intro-photo', width: 1280, height: 900 },
    },
    { ...currentVersion.screens[0], asset: { id: 'old-pc-photo', width: 1280, height: 720 } },
    { ...currentVersion.screens[1], name: '옛 메인', asset: { id: 'old-mobile-photo', width: 360, height: 800 } },
  ],
}
const initialVersion: VersionDetail = {
  ...firstRevision,
  id: 'bd309e09-1844-4494-8431-42def26af78f',
  number: 0,
  summary: '처음 게시한 초안',
  publishedAt: '2026-11-06T09:00:00.000Z',
  screens: [firstRevision.screens[1]],
}
const draft: VersionSummary = {
  id: '24f86b45-afd2-4c27-a774-90586f6e8473',
  number: null,
  status: 'DRAFT',
  publishedAt: null,
}
const versions: VersionSummary[] = [draft, currentVersion, firstRevision, initialVersion]
const nextProject: ProjectDetail = {
  id: '6b62c564-585a-4f05-ae57-8d6b3bc5a47f',
  name: '다음 프로젝트',
  myRole: 'CLIENT',
  currentVersion: null,
  isApprover: false,
  approver: null,
}

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const CurrentPath = () => {
  const location = useLocation()
  return (
    <output aria-label="현재 주소">
      {location.pathname}
      {location.search}
    </output>
  )
}
const BackButton = () => {
  const navigate = useNavigate()
  return <button onClick={() => navigate(-1)}>뒤로 가기</button>
}
const renderReview = (path = `/projects/${project.id}`, basename = '/') => {
  const prefix = basename === '/' ? '' : basename
  return render(
    <MemoryRouter basename={basename} initialEntries={[`${prefix}/previous`, `${prefix}${path}`]} initialIndex={1}>
      <CurrentPath />
      <BackButton />
      <Link to={`/projects/${nextProject.id}`}>다른 검수실로</Link>
      <Routes>
        <Route path="/previous" element={<p>이전 화면</p>} />
        <Route path="/" element={<h1>내 프로젝트</h1>} />
        <Route path="/projects/:id" element={<ReviewRoomPage />} />
        <Route path="/login" element={<h1>로그인</h1>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.mocked(listIssues).mockReset().mockResolvedValue([])
  vi.mocked(getIssue).mockReset()
  vi.mocked(getMe).mockReset().mockResolvedValue(user)
  vi.mocked(getProject).mockReset().mockResolvedValue(project)
  vi.mocked(listMembers).mockReset().mockResolvedValue({ members: [], invitations: [] })
  vi.mocked(listVersions).mockReset().mockResolvedValue(versions)
  vi.mocked(getVersion)
    .mockReset()
    .mockImplementation(async (id) => {
      const detail = [currentVersion, firstRevision, initialVersion].find((version) => version.id === id)
      if (!detail) throw new ApiError(404)
      return detail
    })
})

describe('ReviewRoomPage 승인자 알림', () => {
  const developer: Member = {
    id: 'f684e31f-9df6-4879-b155-ef585259255f',
    name: '개발자',
    email: 'developer@example.com',
    role: 'DEVELOPER',
    lastSeenAt: null,
  }
  const client: Member = {
    id: '8b070074-712e-46f4-a791-b4a6d0eaa3f2',
    name: '클라이언트',
    email: 'client@example.com',
    role: 'CLIENT',
    lastSeenAt: null,
  }

  it.each([
    { state: '게시한 버전이 있을 때', currentVersion: project.currentVersion, listedVersions: versions },
    { state: '게시한 버전이 없을 때', currentVersion: null, listedVersions: [draft] },
  ])(
    '$state 승인자가 없고 활성 클라이언트가 한 명이면 개발자에게 알림과 설정 링크를 보여 준다',
    async ({ currentVersion, listedVersions }) => {
      vi.mocked(getProject).mockResolvedValueOnce({ ...project, currentVersion })
      vi.mocked(listVersions).mockResolvedValueOnce(listedVersions)
      const pending = deferred<MemberList>()
      vi.mocked(listMembers).mockReturnValueOnce(pending.promise)
      renderReview()
      await screen.findByRole('heading', { name: project.name })

      await waitFor(() => expect(listMembers).toHaveBeenCalledExactlyOnceWith(project.id))
      expect(screen.queryByText('승인자를 정해 주세요.')).toBeNull()
      expect(screen.queryByRole('link', { name: '설정으로 가기' })).toBeNull()
      await act(async () => pending.resolve({ members: [developer, client], invitations: [] }))

      expect(screen.getByText('승인자를 정해 주세요.')).toBeDefined()
      expect(screen.getByRole('link', { name: '설정으로 가기' }).getAttribute('href')).toBe(
        `/projects/${project.id}/settings`,
      )
      if (currentVersion) {
        expect(await screen.findByRole('img', { name: '메인 · PC' })).toBeDefined()
        return
      }
      expect(screen.getByRole('heading', { name: '아직 게시한 버전이 없어요.' })).toBeDefined()
      expect(getVersion).not.toHaveBeenCalled()
    },
  )

  it.each([
    { state: '참여자 목록이 비어 있으면', members: [] },
    { state: '개발자와 초대 대기만 있으면', members: [developer] },
  ])('$state 승인자 알림과 설정으로 가기 링크가 없다', async ({ members }) => {
    const pending = deferred<MemberList>()
    vi.mocked(listMembers).mockReturnValueOnce(pending.promise)
    renderReview()
    await screen.findByRole('img', { name: '메인 · PC' })
    await act(async () =>
      pending.resolve({
        members,
        invitations: [{ email: client.email, expiresAt: '2026-11-17T09:00:00.000Z' }],
      }),
    )

    await waitFor(() => expect(listMembers).toHaveBeenCalledExactlyOnceWith(project.id))
    expect(screen.queryByText('승인자를 정해 주세요.')).toBeNull()
    expect(screen.queryByRole('link', { name: '설정으로 가기' })).toBeNull()
  })

  it('개발자에게 이미 승인자가 있으면 참여자 목록을 부르지 않고 알림도 없다', async () => {
    vi.mocked(getProject).mockResolvedValueOnce({
      ...project,
      approver: { memberId: client.id, name: client.name },
    })
    vi.mocked(listMembers).mockResolvedValueOnce({ members: [developer, client], invitations: [] })
    renderReview()
    await screen.findByRole('img', { name: '메인 · PC' })
    await act(async () => {})

    expect(listMembers).not.toHaveBeenCalled()
    expect(screen.queryByText('승인자를 정해 주세요.')).toBeNull()
    expect(screen.queryByRole('link', { name: '설정으로 가기' })).toBeNull()
  })

  it('CLIENT에게 승인자가 없어도 참여자 목록을 부르지 않고 알림도 없다', async () => {
    vi.mocked(getProject).mockResolvedValueOnce({ ...project, myRole: 'CLIENT' })
    vi.mocked(listMembers).mockResolvedValueOnce({ members: [developer, client], invitations: [] })
    renderReview()
    await screen.findByRole('img', { name: '메인 · PC' })
    await act(async () => {})

    expect(listMembers).not.toHaveBeenCalled()
    expect(screen.queryByText('승인자를 정해 주세요.')).toBeNull()
    expect(screen.queryByRole('link', { name: '설정으로 가기' })).toBeNull()
  })

  it.each([
    { reason: '서버 오류', error: new ApiError(500) },
    { reason: '연결 오류', error: new TypeError('Failed to fetch') },
  ])('참여자 목록의 $reason는 알림만 숨기고 검수실 제목·버전·사진을 유지한다', async ({ error }) => {
    const pending = deferred<MemberList>()
    vi.mocked(listMembers).mockReturnValueOnce(pending.promise)
    renderReview()
    await screen.findByRole('img', { name: '메인 · PC' })
    await act(async () => pending.reject(error))

    await waitFor(() => expect(listMembers).toHaveBeenCalledExactlyOnceWith(project.id))
    expect(screen.queryByText('승인자를 정해 주세요.')).toBeNull()
    expect(screen.queryByRole('link', { name: '설정으로 가기' })).toBeNull()
    expect(screen.getByRole('heading', { name: project.name })).toBeDefined()
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '버전' }).value).toBe(currentVersion.id)
    expect(screen.getByText(currentVersion.summary, { collapseWhitespace: false })).toBeDefined()
    expect(screen.getByRole('img', { name: '메인 · PC' }).getAttribute('src')).toBe(
      `/api/assets/${currentVersion.screens[0].asset.id}`,
    )
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('ReviewRoomPage 화면과 버전', () => {
  it('현재 버전의 화면 순서와 첫 사진의 주소, 크기, 이름을 보여 준다', async () => {
    renderReview()

    const image = await screen.findByRole('img', { name: '메인 · PC' })
    expect(image.getAttribute('src')).toBe(`/api/assets/${currentVersion.screens[0].asset.id}`)
    expect(image.getAttribute('width')).toBe('1440')
    expect(image.getAttribute('height')).toBe('900')
    const list = within(screen.getByRole('list'))
    expect(list.getAllByRole('button')).toEqual([
      list.getByRole('button', { name: '메인 · PC' }),
      list.getByRole('button', { name: '메인 · 모바일' }),
    ])
    expect(screen.getByRole('button', { name: '메인 · PC' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: '메인 · 모바일' }).getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '버전' }).value).toBe(currentVersion.id)
    expect(getProject).toHaveBeenCalledExactlyOnceWith(project.id)
    expect(listVersions).toHaveBeenCalledExactlyOnceWith(project.id)
    expect(getVersion).toHaveBeenCalledExactlyOnceWith(currentVersion.id)
  })

  it('화면 버튼을 누르면 선택 표시와 큰 사진이 함께 바뀐다', async () => {
    renderReview()
    fireEvent.click(await screen.findByRole('button', { name: '메인 · 모바일' }))

    const image = screen.getByRole('img', { name: '메인 · 모바일' })
    expect(image.getAttribute('src')).toBe(`/api/assets/${currentVersion.screens[1].asset.id}`)
    expect(image.getAttribute('width')).toBe('390')
    expect(image.getAttribute('height')).toBe('844')
    expect(screen.getByRole('button', { name: '메인 · 모바일' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: '메인 · PC' }).getAttribute('aria-pressed')).toBe('false')
    expect(screen.getAllByRole('img')).toHaveLength(1)
    expect(getVersion).toHaveBeenCalledTimes(1)
  })

  it('게시 전 버전은 빼고 게시 번호 2·1·0을 2차·1차·초안으로 고르게 한다', async () => {
    renderReview()
    const picker = await screen.findByRole('combobox', { name: '버전' })

    expect(
      within(picker)
        .getAllByRole<HTMLOptionElement>('option')
        .map((option) => [option.value, option.textContent]),
    ).toEqual([
      [currentVersion.id, '2차'],
      [firstRevision.id, '1차'],
      [initialVersion.id, '초안'],
    ])
    expect(screen.queryByRole('option', { name: '게시 전 버전' })).toBeNull()
  })

  it('버전 변경을 주소에 남기고 처음 자동으로 보던 화면도 같은 screenId로 유지한다', async () => {
    renderReview()
    await screen.findByRole('img', { name: '메인 · PC' })
    fireEvent.change(screen.getByRole('combobox', { name: '버전' }), { target: { value: firstRevision.id } })

    const image = await screen.findByRole('img', { name: '메인 · PC' })
    expect(image.getAttribute('src')).toBe('/api/assets/old-pc-photo')
    expect(screen.getByLabelText('현재 주소').textContent).toBe(`/projects/${project.id}?version=${firstRevision.id}`)
    expect(getVersion).toHaveBeenLastCalledWith(firstRevision.id)
    expect(screen.getByRole('button', { name: '메인 · PC' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('직접 고른 화면은 다음 버전에도 있으면 유지하고 없으면 첫 화면을 보여 준다', async () => {
    renderReview()
    fireEvent.click(await screen.findByRole('button', { name: '메인 · 모바일' }))
    fireEvent.change(screen.getByRole('combobox', { name: '버전' }), { target: { value: firstRevision.id } })
    expect((await screen.findByRole('img', { name: '옛 메인 · 모바일' })).getAttribute('src')).toBe(
      '/api/assets/old-mobile-photo',
    )
    expect(screen.getByRole('button', { name: '옛 메인 · 모바일' }).getAttribute('aria-pressed')).toBe('true')

    fireEvent.change(screen.getByRole('combobox', { name: '버전' }), { target: { value: initialVersion.id } })

    expect((await screen.findByRole('img', { name: '메인 · PC' })).getAttribute('src')).toBe('/api/assets/old-pc-photo')
    expect(screen.getByRole('button', { name: '메인 · PC' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByRole('button', { name: '옛 메인 · 모바일' })).toBeNull()
  })

  it.each([firstRevision, initialVersion])(
    '주소로 지정한 $number번 게시 버전을 처음부터 보여 준다',
    async (version) => {
      renderReview(`/projects/${project.id}?version=${version.id}`)

      expect(await screen.findByText(version.summary)).toBeDefined()
      expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '버전' }).value).toBe(version.id)
      expect(getVersion).toHaveBeenCalledExactlyOnceWith(version.id)
      expect(screen.getByRole('link', { name: '3차 준비' })).toBeDefined()
    },
  )

  it('설명의 줄바꿈을 유지하고 테스트 주소는 새 탭에서 연다', async () => {
    // Vitest의 CSS 모듈 이름에 실제 스타일을 연결해 줄바꿈 속성까지 확인한다.
    const reviewCss = readFileSync(`${import.meta.dirname}/ReviewRoomPage.module.css`, 'utf8')
    render(<style>{reviewCss.replaceAll('.summary', `.${styles.summary}`)}</style>)
    renderReview()
    const summary = await screen.findByText(currentVersion.summary, { collapseWhitespace: false })

    expect(summary.textContent).toBe(currentVersion.summary)
    expect(getComputedStyle(summary).whiteSpace).toBe('pre-wrap')
    const link = screen.getByRole('link', { name: '테스트 주소' })
    expect(link.getAttribute('href')).toBe(currentVersion.testUrl)
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noreferrer')
  })

  it('테스트 주소가 없으면 링크를 만들지 않는다', async () => {
    renderReview(`/projects/${project.id}?version=${initialVersion.id}`)
    await screen.findByRole('img')

    expect(screen.queryByRole('link', { name: '테스트 주소' })).toBeNull()
  })

  it('게시 후 숨긴 화면도 지난 버전에서는 사진을 볼 수 있다', async () => {
    vi.mocked(getVersion).mockResolvedValueOnce({
      ...initialVersion,
      screens: [{ ...initialVersion.screens[0], hiddenAt: '2026-11-08T10:00:00.000Z' }],
    })
    renderReview(`/projects/${project.id}?version=${initialVersion.id}`)

    expect((await screen.findByRole('img', { name: '메인 · PC' })).getAttribute('src')).toBe('/api/assets/old-pc-photo')
    expect(screen.getByRole('button', { name: '메인 · PC' })).toBeDefined()
  })

  it.each(['DEVELOPER', 'CLIENT'] as const)(
    '%s에게 게시 전이면 안내를 보여 주고 버전을 조회하지 않는다',
    async (myRole) => {
      vi.mocked(getProject).mockResolvedValueOnce({ ...project, myRole, currentVersion: null })
      vi.mocked(listVersions).mockResolvedValueOnce(myRole === 'DEVELOPER' ? [draft] : [])
      renderReview()

      expect(await screen.findByText('아직 게시한 버전이 없어요.')).toBeDefined()
      expect(screen.queryByRole('img')).toBeNull()
      expect(screen.queryByRole('combobox')).toBeNull()
      expect(getVersion).not.toHaveBeenCalled()
    },
  )

  it.each([
    { currentVersion: null, label: '초안 준비' },
    { currentVersion: { id: initialVersion.id, number: 0 }, label: '1차 준비' },
    { currentVersion: { id: firstRevision.id, number: 1 }, label: '2차 준비' },
  ])('개발자에게 활동 일지·$label·설정 링크를 보여 준다', async ({ currentVersion, label }) => {
    vi.mocked(getProject).mockResolvedValueOnce({ ...project, currentVersion })
    renderReview()
    await screen.findByRole('heading', { name: project.name })

    const nav = within(screen.getByRole('navigation'))
    expect(nav.getByRole('link', { name: label }).getAttribute('href')).toBe(`/projects/${project.id}/draft`)
    expect(nav.getByRole('link', { name: '설정' }).getAttribute('href')).toBe(`/projects/${project.id}/settings`)
    expect(nav.getByRole('link', { name: '활동 일지' }).getAttribute('href')).toBe(`/projects/${project.id}/activity`)
    if (currentVersion?.number === 0) {
      expect(await screen.findByRole('option', { name: '초안' })).toBeDefined()
      expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '버전' }).value).toBe(initialVersion.id)
    }
  })

  it.each([null, project.currentVersion])(
    '클라이언트의 메뉴에는 프로젝트 목록과 활동 일지만 있다: %s',
    async (currentVersion) => {
      vi.mocked(getProject).mockResolvedValueOnce({ ...project, currentVersion, myRole: 'CLIENT' })
      renderReview()
      const nav = await screen.findByRole('navigation')

      expect(
        within(nav)
          .getAllByRole('link')
          .map((link) => [link.textContent, link.getAttribute('href')]),
      ).toEqual([
        ['프로젝트 목록', '/'],
        ['활동 일지', `/projects/${project.id}/activity`],
      ])
      expect(screen.queryByRole('link', { name: /준비|설정/ })).toBeNull()
    },
  )
})

describe('ReviewRoomPage 대문자 프로젝트 주소', () => {
  it.each(['DEVELOPER', 'CLIENT'] as const)(
    '%s에게 현재 버전의 사진과 버전 고르기를 보여 주고 초안으로 바꿀 수 있다',
    async (myRole) => {
      vi.mocked(getProject).mockResolvedValueOnce({ ...project, myRole })
      vi.mocked(listVersions).mockResolvedValueOnce(myRole === 'DEVELOPER' ? versions : versions.slice(1))
      renderReview(`/projects/${project.id.toUpperCase()}`)

      const image = await screen.findByRole('img', { name: '메인 · PC' })
      expect(image.getAttribute('src')).toBe(`/api/assets/${currentVersion.screens[0].asset.id}`)
      expect(screen.getByText('검수 중')).toBeDefined()
      expect(screen.queryByRole('heading', { name: '없는 버전이에요' })).toBeNull()
      const picker = screen.getByRole<HTMLSelectElement>('combobox', { name: '버전' })
      expect(picker.value).toBe(currentVersion.id)
      expect(
        within(picker)
          .getAllByRole('option')
          .map((option) => option.textContent),
      ).toEqual(['2차', '1차', '초안'])

      fireEvent.change(picker, { target: { value: initialVersion.id } })

      expect(await screen.findByText(initialVersion.summary)).toBeDefined()
      expect(screen.getByRole('img', { name: '메인 · PC' }).getAttribute('src')).toBe('/api/assets/old-pc-photo')
      expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '버전' }).value).toBe(initialVersion.id)
      expect(screen.getByLabelText('현재 주소').textContent).toBe(
        `/projects/${project.id.toUpperCase()}?version=${initialVersion.id}`,
      )
      expect(screen.queryByRole('heading', { name: '없는 버전이에요' })).toBeNull()
    },
  )

  it.each([initialVersion, firstRevision])(
    '같은 프로젝트의 $number번 버전을 주소로 직접 열어도 사진과 읽기 전용 안내를 보여 준다',
    async (version) => {
      renderReview(`/projects/${project.id.toUpperCase()}?version=${version.id}`)

      const image = await screen.findByRole('img')
      expect(image.getAttribute('src')).toBe(`/api/assets/${version.screens[0].asset.id}`)
      expect(screen.getByText(version.summary)).toBeDefined()
      expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '버전' }).value).toBe(version.id)
      expect(screen.getByText('지난 버전이에요. 읽기만 할 수 있어요.')).toBeDefined()
      expect(screen.queryByRole('heading', { name: '없는 버전이에요' })).toBeNull()
    },
  )

  it.each([
    { reason: '다른 프로젝트 버전', detail: { ...firstRevision, projectId: nextProject.id } },
    { reason: '게시 전 버전', detail: { ...currentVersion, ...draft } },
  ])('$reason은 없는 버전으로 표시하고 사진과 설명을 숨긴다', async ({ detail }) => {
    vi.mocked(getVersion).mockResolvedValueOnce(detail)
    renderReview(`/projects/${project.id.toUpperCase()}?version=${detail.id}`)

    expect(await screen.findByRole('heading', { name: '없는 버전이에요' })).toBeDefined()
    expect(getVersion).toHaveBeenCalledExactlyOnceWith(detail.id)
    expect(screen.getByText('주소가 맞는지 확인해 주세요.')).toBeDefined()
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.queryAllByAltText('')).toHaveLength(0)
    expect(screen.queryByText(detail.summary, { collapseWhitespace: false })).toBeNull()
    expect(screen.queryByRole('link', { name: '테스트 주소' })).toBeNull()
    expect(screen.queryByRole('combobox')).toBeNull()

    fireEvent.click(screen.getByRole('link', { name: '최신 버전 보기' }))

    const image = await screen.findByRole('img', { name: '메인 · PC' })
    expect(image.getAttribute('src')).toBe(`/api/assets/${currentVersion.screens[0].asset.id}`)
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '버전' }).value).toBe(currentVersion.id)
    expect(screen.queryByRole('heading', { name: '없는 버전이에요' })).toBeNull()
  })
})

describe('ReviewRoomPage 시안 배치', () => {
  it('화면마다 작은 사진은 큰 사진과 같은 주소를 쓰고 빈 alt와 lazy 속성을 가진다', async () => {
    renderReview()
    const list = within(await screen.findByRole('list'))
    const buttons = list.getAllByRole('button')

    expect(list.getAllByAltText('')).toHaveLength(2)
    buttons.forEach((button, index) => {
      const thumbnail = within(button).getByAltText('')
      expect(thumbnail.tagName).toBe('IMG')
      expect(thumbnail.getAttribute('alt')).toBe('')
      expect(thumbnail.getAttribute('loading')).toBe('lazy')
      expect(thumbnail.getAttribute('src')).toBe(`/api/assets/${currentVersion.screens[index].asset.id}`)

      fireEvent.click(button)
      expect(screen.getByRole('img').getAttribute('src')).toBe(thumbnail.getAttribute('src'))
    })
  })

  it('화면 번호 01·02는 보이지만 버튼의 읽는 이름에는 들어가지 않는다', async () => {
    renderReview()
    const list = within(await screen.findByRole('list'))
    const desktop = list.getByRole('button', { name: '메인 · PC' })
    const mobile = list.getByRole('button', { name: '메인 · 모바일' })

    expect(within(desktop).getByText('01').getAttribute('aria-hidden')).toBe('true')
    expect(within(mobile).getByText('02').getAttribute('aria-hidden')).toBe('true')
    expect(list.queryByRole('button', { name: /01|02/ })).toBeNull()
  })

  it('사진 순서는 화면 선택과 버전별 화면 수에 따라 바뀌며 한 장이면 1 / 1이다', async () => {
    renderReview()
    expect(await screen.findByText('사진 1 / 2')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: '메인 · 모바일' }))
    expect(screen.getByText('사진 2 / 2')).toBeDefined()
    expect(screen.queryByText('사진 1 / 2')).toBeNull()

    fireEvent.change(screen.getByRole('combobox', { name: '버전' }), { target: { value: firstRevision.id } })
    expect(await screen.findByText('사진 3 / 3')).toBeDefined()
    expect(screen.getByRole('img', { name: '옛 메인 · 모바일' })).toBeDefined()
    expect(screen.queryByText('사진 2 / 2')).toBeNull()
    const thumbnail = within(screen.getByRole('button', { name: '옛 메인 · 모바일' })).getByAltText('')
    expect(thumbnail.getAttribute('src')).toBe('/api/assets/old-mobile-photo')

    fireEvent.change(screen.getByRole('combobox', { name: '버전' }), { target: { value: initialVersion.id } })
    expect(await screen.findByText('사진 1 / 1')).toBeDefined()
    expect(screen.queryByText('사진 3 / 3')).toBeNull()
  })

  it.each([
    { version: currentVersion, label: '2차', count: '사진 1 / 2' },
    { version: initialVersion, label: '초안', count: '사진 1 / 1' },
  ])('$label 버전의 큰 사진 위에 버전 이름·화면 이름·사진 순서를 함께 표시한다', async ({ version, label, count }) => {
    renderReview(`/projects/${project.id}?version=${version.id}`)
    const caption = (await screen.findByText(count)).closest('p')

    expect(caption?.textContent).toContain(label)
    expect(caption?.textContent).toContain('메인 · PC')
    expect(caption?.textContent).toContain(count)
  })

  it.each([currentVersion, initialVersion])(
    '현재 버전 번호 $number는 실제 상태를 보이고 지난 버전 안내가 없다',
    async (version) => {
      vi.mocked(getProject).mockResolvedValueOnce({
        ...project,
        currentVersion: { id: version.id, number: version.number! },
      })
      renderReview()

      expect(await screen.findByText(version.status === 'APPROVED' ? '승인됨' : '검수 중')).toBeDefined()
      expect(screen.queryByText('읽기 전용')).toBeNull()
      expect(screen.queryByText(/지난 버전이에요/)).toBeNull()
      expect(screen.queryByRole('link', { name: '최신 버전 보기' })).toBeNull()
    },
  )

  it.each(['IN_REVIEW', 'APPROVED'] as const)(
    '지난 버전의 상태가 %s여도 읽기 전용이며 최신 버전으로 돌아갈 수 있다',
    async (status) => {
      vi.mocked(getVersion).mockResolvedValueOnce({
        ...firstRevision,
        status,
        approval: status === 'APPROVED' ? firstRevision.approval : null,
      })
      renderReview(`/projects/${project.id}?version=${firstRevision.id}`)

      expect(await screen.findByText(status === 'APPROVED' ? '승인됨' : '읽기 전용')).toBeDefined()
      expect(screen.queryByText('검수 중')).toBeNull()
      expect(screen.getByText('지난 버전이에요. 읽기만 할 수 있어요.')).toBeDefined()
      const latest = screen.getByRole('button', { name: '최신 버전 보기' })

      fireEvent.click(latest)
      expect(await screen.findByText('검수 중')).toBeDefined()
      expect(getProject).toHaveBeenCalledTimes(2)
      expect(screen.getByLabelText('현재 주소').textContent).toBe(`/projects/${project.id}`)
      expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '버전' }).value).toBe(currentVersion.id)
      expect(screen.queryByText('읽기 전용')).toBeNull()
      expect(screen.queryByText(/지난 버전이에요/)).toBeNull()
      expect(screen.queryByRole('link', { name: '최신 버전 보기' })).toBeNull()
    },
  )

  it('게시 시각을 한국어 날짜와 시·분으로 보여 주고 버전을 바꾸면 그 버전의 시각으로 바뀐다', async () => {
    const format = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' })
    const currentTime = `${format.format(new Date(currentVersion.publishedAt!))} 게시`
    const initialTime = `${format.format(new Date(initialVersion.publishedAt!))} 게시`
    renderReview()

    expect(await screen.findByText(currentTime)).toBeDefined()
    fireEvent.change(screen.getByRole('combobox', { name: '버전' }), { target: { value: initialVersion.id } })
    expect(await screen.findByText(initialTime)).toBeDefined()
    expect(screen.queryByText(currentTime)).toBeNull()
  })

  it('게시한 버전이 없으면 개발자에게 준비 안내와 메뉴 밖의 초안 준비 링크를 보여 준다', async () => {
    vi.mocked(getProject).mockResolvedValueOnce({ ...project, currentVersion: null })
    vi.mocked(listVersions).mockResolvedValueOnce([draft])
    renderReview()

    expect(await screen.findByText('화면 사진을 준비해서 첫 버전을 게시해 주세요.')).toBeDefined()
    const nav = screen.getByRole('navigation')
    const links = screen.getAllByRole('link', { name: '초안 준비' })
    expect(links).toHaveLength(2)
    expect(links.filter((link) => !nav.contains(link))).toHaveLength(1)
    links.forEach((link) => expect(link.getAttribute('href')).toBe(`/projects/${project.id}/draft`))
    expect(screen.queryByText('개발자가 버전을 게시하면 여기서 확인할 수 있어요.')).toBeNull()
    expect(screen.queryByText('검수 중')).toBeNull()
    expect(screen.queryByText('읽기 전용')).toBeNull()
  })

  it('게시한 버전이 없으면 클라이언트에게 기다림 안내만 보이고 준비 링크는 없다', async () => {
    vi.mocked(getProject).mockResolvedValueOnce({ ...project, myRole: 'CLIENT', currentVersion: null })
    vi.mocked(listVersions).mockResolvedValueOnce([])
    renderReview()

    expect(await screen.findByText('개발자가 버전을 게시하면 여기서 확인할 수 있어요.')).toBeDefined()
    expect(screen.queryByText('화면 사진을 준비해서 첫 버전을 게시해 주세요.')).toBeNull()
    expect(screen.queryByRole('link', { name: /준비/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /준비/ })).toBeNull()
    expect(screen.queryByText('검수 중')).toBeNull()
    expect(screen.queryByText('읽기 전용')).toBeNull()
  })

  it.each([
    { reason: '잘못된 주소', id: 'abc', detail: null },
    { reason: '404', id: firstRevision.id, detail: null },
    { reason: '다른 프로젝트', id: firstRevision.id, detail: { ...firstRevision, projectId: nextProject.id } },
    { reason: '게시 전 버전', id: draft.id, detail: { ...currentVersion, ...draft } },
  ])('$reason인 버전은 주소 확인 안내를 보여 주고 작은 사진도 노출하지 않는다', async ({ id, detail }) => {
    if (detail) vi.mocked(getVersion).mockResolvedValueOnce(detail)
    if (!detail) vi.mocked(getVersion).mockRejectedValueOnce(new ApiError(404))
    renderReview(`/projects/${project.id}?version=${id}`)

    expect(await screen.findByText('주소가 맞는지 확인해 주세요.')).toBeDefined()
    expect(screen.getByRole('heading', { name: '없는 버전이에요' })).toBeDefined()
    expect(screen.getByRole('link', { name: '최신 버전 보기' }).getAttribute('href')).toBe(`/projects/${project.id}`)
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.queryAllByAltText('')).toHaveLength(0)
    expect(screen.queryByText('검수 중')).toBeNull()
    expect(screen.queryByText('읽기 전용')).toBeNull()
  })
})

describe('ReviewRoomPage 로그인과 오류', () => {
  it('로그인 확인 중에는 사진과 프로젝트를 보여 주지 않는다', async () => {
    const pending = deferred<Me>()
    vi.mocked(getMe).mockReturnValueOnce(pending.promise)
    renderReview()
    await act(async () => {})

    expect(screen.getByText('확인하는 중이에요.')).toBeDefined()
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.queryByRole('heading')).toBeNull()
    expect(getMe).toHaveBeenCalledExactlyOnceWith()
    await act(async () => pending.resolve(user))
    expect(await screen.findByRole('img')).toBeDefined()
  })

  it.each(['/', '/app'])('basename %s에서 비로그인이면 /login으로 교체한다', async (basename) => {
    vi.mocked(getMe).mockResolvedValueOnce(null)
    renderReview(`/projects/${project.id}`, basename)

    expect(await screen.findByRole('heading', { name: '로그인' })).toBeDefined()
    expect(screen.getByLabelText('현재 주소').textContent).toBe('/login')
    expect(screen.queryByRole('img')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '뒤로 가기' }))
    expect(await screen.findByText('이전 화면')).toBeDefined()
  })

  it.each([new TypeError('Failed to fetch'), new ApiError(500)])(
    '로그인 확인 오류 %s는 안내를 보여 주고 주소를 보존한다',
    async (error) => {
      vi.mocked(getMe).mockRejectedValueOnce(error)
      renderReview()

      expect(await screen.findByText('불러오지 못했어요. 잠시 뒤 새로고침해 주세요')).toBeDefined()
      expect(screen.queryByRole('img')).toBeNull()
      expect(screen.queryByRole('heading')).toBeNull()
      expect(screen.getByLabelText('현재 주소').textContent).toBe(`/projects/${project.id}`)
    },
  )

  it.each(['abc', '..', '.'])('잘못된 프로젝트 id %s는 프로젝트·버전 API를 부르지 않는다', async (id) => {
    renderReview(`/projects/${id}`)

    expect(await screen.findByRole('heading', { name: '없는 프로젝트예요' })).toBeDefined()
    expect(screen.getByRole('link', { name: '프로젝트 목록' }).getAttribute('href')).toBe('/')
    expect(getProject).not.toHaveBeenCalled()
    expect(listVersions).not.toHaveBeenCalled()
    expect(getVersion).not.toHaveBeenCalled()
  })

  it('프로젝트 id가 틀리면 정상 모양의 버전 쿼리가 있어도 버전 API를 부르지 않는다', async () => {
    renderReview(`/projects/abc?version=${currentVersion.id}`)

    expect(await screen.findByRole('heading', { name: '없는 프로젝트예요' })).toBeDefined()
    expect(getProject).not.toHaveBeenCalled()
    expect(listVersions).not.toHaveBeenCalled()
    expect(getVersion).not.toHaveBeenCalled()
  })

  it.each([
    { source: '프로젝트', fail: () => vi.mocked(getProject).mockRejectedValueOnce(new ApiError(404)) },
    { source: '버전 목록', fail: () => vi.mocked(listVersions).mockRejectedValueOnce(new ApiError(404)) },
  ])('$source 404도 없는 프로젝트로 표시한다', async ({ fail }) => {
    fail()
    renderReview()

    expect(await screen.findByRole('heading', { name: '없는 프로젝트예요' })).toBeDefined()
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.queryByRole('heading', { name: project.name })).toBeNull()
  })

  it.each(['abc', '..', ''])('잘못된 버전 id %s는 상세를 요청하지 않고 최신 버전 링크를 보여 준다', async (id) => {
    renderReview(`/projects/${project.id}?version=${id}`)

    expect(await screen.findByRole('heading', { name: '없는 버전이에요' })).toBeDefined()
    expect(getVersion).not.toHaveBeenCalled()
    const link = screen.getByRole('link', { name: '최신 버전 보기' })
    expect(link.getAttribute('href')).toBe(`/projects/${project.id}`)
    fireEvent.click(link)
    expect(await screen.findByRole('img', { name: '메인 · PC' })).toBeDefined()
    expect(screen.getByLabelText('현재 주소').textContent).toBe(`/projects/${project.id}`)
    expect(getVersion).toHaveBeenCalledExactlyOnceWith(currentVersion.id)
  })

  it.each([
    { reason: '404', detail: null },
    { reason: '다른 프로젝트 버전', detail: { ...firstRevision, projectId: nextProject.id } },
    { reason: '게시 전 버전', detail: { ...firstRevision, status: 'DRAFT' as const, number: null, publishedAt: null } },
  ])('$reason이면 사진과 설명을 숨기고 최신 버전 링크를 보여 준다', async ({ detail }) => {
    if (detail) vi.mocked(getVersion).mockResolvedValueOnce(detail)
    if (!detail) vi.mocked(getVersion).mockRejectedValueOnce(new ApiError(404))
    renderReview(`/projects/${project.id}?version=${firstRevision.id}`)

    expect(await screen.findByRole('heading', { name: '없는 버전이에요' })).toBeDefined()
    expect(screen.getByRole('link', { name: '최신 버전 보기' }).getAttribute('href')).toBe(`/projects/${project.id}`)
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.queryByText(firstRevision.summary)).toBeNull()
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  describe.each([
    { source: '프로젝트', fail: (error: Error) => vi.mocked(getProject).mockRejectedValueOnce(error) },
    { source: '버전 목록', fail: (error: Error) => vi.mocked(listVersions).mockRejectedValueOnce(error) },
    { source: '버전 상세', fail: (error: Error) => vi.mocked(getVersion).mockRejectedValueOnce(error) },
  ])('$source 실패', ({ fail }) => {
    it('401이면 다시 로그인 문구와 링크를 보여 주고 클릭할 때 로그인으로 간다', async () => {
      fail(new ApiError(401))
      renderReview()

      expect((await screen.findByRole('alert')).textContent).toContain('로그인이 끝났어요. 다시 로그인해 주세요')
      expect(screen.getByLabelText('현재 주소').textContent).toBe(`/projects/${project.id}`)
      expect(screen.queryByRole('img')).toBeNull()
      const link = screen.getByRole('link', { name: '다시 로그인하기' })
      expect(link.getAttribute('href')).toBe('/login')
      fireEvent.click(link)
      expect(await screen.findByRole('heading', { name: '로그인' })).toBeDefined()
    })

    it.each([
      { error: new ApiError(500), message: '잠시 뒤 다시 시도해 주세요' },
      { error: new TypeError('Failed to fetch'), message: '연결을 확인하고 다시 시도해 주세요' },
    ])('$error이면 오류 문구를 표시한다', async ({ error, message }) => {
      fail(error)
      renderReview()

      expect((await screen.findByRole('alert')).textContent).toBe(message)
      expect(screen.queryByRole('img')).toBeNull()
      expect(screen.queryByText('아직 게시한 버전이 없어요.')).toBeNull()
      expect(screen.queryByRole('heading', { name: '없는 프로젝트예요' })).toBeNull()
      expect(screen.queryByRole('heading', { name: '없는 버전이에요' })).toBeNull()
    })
  })
})

describe('ReviewRoomPage 늦은 응답과 화면 이동', () => {
  it.each(['프로젝트', '버전 목록'])(
    '%s가 늦으면 두 응답을 받을 때까지 빈 버전 안내 대신 불러오는 중을 보여 준다',
    async (source) => {
      const pendingProject = deferred<ProjectDetail>()
      const pendingVersions = deferred<VersionSummary[]>()
      vi.mocked(getProject).mockReturnValueOnce(pendingProject.promise)
      vi.mocked(listVersions).mockReturnValueOnce(pendingVersions.promise)
      renderReview()
      await screen.findByText('불러오는 중이에요.')
      await act(async () => {
        if (source === '프로젝트') pendingVersions.resolve(versions)
        if (source === '버전 목록') pendingProject.resolve(project)
      })

      expect(screen.getByText('불러오는 중이에요.')).toBeDefined()
      expect(screen.queryByText('아직 게시한 버전이 없어요.')).toBeNull()
      expect(getProject).toHaveBeenCalledExactlyOnceWith(project.id)
      expect(listVersions).toHaveBeenCalledExactlyOnceWith(project.id)
      await act(async () => {
        pendingProject.resolve(project)
        pendingVersions.resolve(versions)
      })
      expect(await screen.findByRole('img')).toBeDefined()
    },
  )

  it.each(['성공', '404', '서버 오류'])('버전을 바꿨다가 돌아오면 늦은 이전 요청의 %s를 버린다', async (result) => {
    const pending = deferred<VersionDetail>()
    renderReview()
    await screen.findByRole('img')
    vi.mocked(getVersion).mockReturnValueOnce(pending.promise)
    fireEvent.change(screen.getByRole('combobox', { name: '버전' }), { target: { value: firstRevision.id } })

    expect(screen.getByText('불러오는 중이에요.')).toBeDefined()
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.queryByText(currentVersion.summary)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '뒤로 가기' }))
    expect(await screen.findByRole('img', { name: '메인 · PC' })).toBeDefined()
    await act(async () => {
      if (result === '성공') pending.resolve(firstRevision)
      if (result !== '성공') pending.reject(new ApiError(result === '404' ? 404 : 500))
      await pending.promise.catch(() => undefined)
    })

    expect(screen.getByLabelText('현재 주소').textContent).toBe(`/projects/${project.id}`)
    expect(screen.getByRole('img').getAttribute('src')).toBe(`/api/assets/${currentVersion.screens[0].asset.id}`)
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '버전' }).value).toBe(currentVersion.id)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('heading', { name: '없는 버전이에요' })).toBeNull()
    expect(getVersion).toHaveBeenCalledTimes(3)
  })

  it('다른 프로젝트 검수실로 가면 조회 중에도 이전 제목·사진·설명·개발자 메뉴가 남지 않는다', async () => {
    renderReview()
    await screen.findByRole('img')
    const pending = deferred<ProjectDetail>()
    vi.mocked(getProject).mockReturnValueOnce(pending.promise)
    vi.mocked(listVersions).mockResolvedValueOnce([])
    fireEvent.click(screen.getByRole('link', { name: '다른 검수실로' }))
    await screen.findByText('불러오는 중이에요.')

    expect(screen.queryByRole('heading', { name: project.name })).toBeNull()
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.queryByText(currentVersion.summary)).toBeNull()
    expect(screen.queryByRole('link', { name: /준비|설정/ })).toBeNull()
    await act(async () => pending.resolve(nextProject))
    expect(await screen.findByRole('heading', { name: nextProject.name })).toBeDefined()
    expect(screen.getByText('아직 게시한 버전이 없어요.')).toBeDefined()
    expect(screen.getByLabelText('현재 주소').textContent).toBe(`/projects/${nextProject.id}`)
    expect(getProject).toHaveBeenLastCalledWith(nextProject.id)
    expect(listVersions).toHaveBeenLastCalledWith(nextProject.id)
    expect(getVersion).toHaveBeenCalledTimes(1)
  })

  it.each(['성공', '404'])('다른 프로젝트로 이동한 뒤 이전 버전의 늦은 %s가 새 화면을 덮지 않는다', async (result) => {
    const pending = deferred<VersionDetail>()
    vi.mocked(getVersion).mockReturnValueOnce(pending.promise)
    renderReview()
    await screen.findByRole('heading', { name: project.name })
    await waitFor(() => expect(getVersion).toHaveBeenCalledExactlyOnceWith(currentVersion.id))
    vi.mocked(getProject).mockResolvedValueOnce(nextProject)
    vi.mocked(listVersions).mockResolvedValueOnce([])
    fireEvent.click(screen.getByRole('link', { name: '다른 검수실로' }))
    await screen.findByRole('heading', { name: nextProject.name })
    await act(async () => {
      if (result === '성공') pending.resolve(currentVersion)
      if (result === '404') pending.reject(new ApiError(404))
      await pending.promise.catch(() => undefined)
    })

    expect(screen.getByText('아직 게시한 버전이 없어요.')).toBeDefined()
    expect(screen.queryByRole('heading', { name: project.name })).toBeNull()
    expect(screen.queryByRole('heading', { name: '없는 버전이에요' })).toBeNull()
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByLabelText('현재 주소').textContent).toBe(`/projects/${nextProject.id}`)
  })
})
