import { StrictMode } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Link, MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router'
import App from '../App.tsx'
import { getMe, type Me } from '../api/auth.ts'
import { ApiError } from '../api/client.ts'
import { getProject, listScreens, type ProjectDetail, type Screen } from '../api/projects.ts'
import {
  createDraft,
  getVersion,
  listVersions,
  publishVersion,
  putScreenPhoto,
  removeDraftScreen,
  updateDraft,
  type VersionDetail,
  type VersionSummary,
} from '../api/versions.ts'
import { DraftPage } from './DraftPage.tsx'
import styles from './DraftPage.module.css'

vi.mock('../api/auth.ts', async () => {
  const actual = await vi.importActual<typeof import('../api/auth.ts')>('../api/auth.ts')
  return { ...actual, getMe: vi.fn() }
})

vi.mock('../api/projects.ts', async () => {
  const actual = await vi.importActual<typeof import('../api/projects.ts')>('../api/projects.ts')
  return { ...actual, getProject: vi.fn(), listScreens: vi.fn() }
})

vi.mock('../api/versions.ts', async () => {
  const actual = await vi.importActual<typeof import('../api/versions.ts')>('../api/versions.ts')
  return {
    ...actual,
    listVersions: vi.fn(),
    getVersion: vi.fn(),
    createDraft: vi.fn(),
    updateDraft: vi.fn(),
    putScreenPhoto: vi.fn(),
    removeDraftScreen: vi.fn(),
    publishVersion: vi.fn(),
  }
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
  currentVersion: { id: 'd565474f-17a5-4a8e-9b61-bde406fefdf3', number: 0 },
  isApprover: false,
  approver: null,
}
const screens: Screen[] = [
  { id: 'fdba89f1-38f6-4910-a5c7-6774a8e2f9ef', name: '메인', viewport: 'PC', hiddenAt: null },
  { id: 'afb028f9-4966-4d5b-b13b-94e5636b5e75', name: '메인', viewport: 'MOBILE', hiddenAt: null },
  { id: 'd9e18ba9-4b1a-4b36-9bc4-609826ec1fa0', name: '소개', viewport: 'PC', hiddenAt: '2026-11-08T00:00:00.000Z' },
  {
    id: '88a36f2d-1455-43ba-a3dc-d859646d763a',
    name: '문의',
    viewport: 'MOBILE',
    hiddenAt: '2026-11-08T00:00:00.000Z',
  },
]
const draft: VersionDetail = {
  approval: null,
  id: '24f86b45-afd2-4c27-a774-90586f6e8473',
  projectId: project.id,
  number: null,
  status: 'DRAFT',
  summary: '모바일 화면을 고쳤어요.',
  testUrl: 'https://example.com/review',
  publishedAt: null,
  screens: [
    {
      screenId: screens[0].id,
      name: '메인',
      viewport: 'PC',
      hiddenAt: null,
      asset: { id: 'pc-photo', width: 1440, height: 900 },
    },
    {
      screenId: screens[2].id,
      name: '소개',
      viewport: 'PC',
      hiddenAt: screens[2].hiddenAt,
      asset: { id: 'hidden-photo', width: 1280, height: 720 },
    },
  ],
}
const published: VersionDetail = {
  ...draft,
  number: 1,
  status: 'IN_REVIEW',
  publishedAt: '2026-11-09T00:00:00.000Z',
}
const versions: VersionSummary[] = [
  { id: draft.id, number: null, status: 'DRAFT', publishedAt: null },
  { id: project.currentVersion!.id, number: 0, status: 'IN_REVIEW', publishedAt: '2026-11-08T00:00:00.000Z' },
]
const nextProject: ProjectDetail = {
  ...project,
  id: '6b62c564-585a-4f05-ae57-8d6b3bc5a47f',
  name: '다음 프로젝트',
  currentVersion: null,
}
const photo = new File(['photo'], 'screen.png', { type: 'image/png' })

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}
const CurrentPath = () => <output aria-label="현재 주소">{useLocation().pathname}</output>
const BackButton = () => {
  const navigate = useNavigate()
  return <button onClick={() => navigate(-1)}>뒤로 가기</button>
}
const renderDraft = (id = project.id, basename = '/') => {
  const prefix = basename === '/' ? '' : basename
  return render(
    <MemoryRouter
      basename={basename}
      initialEntries={[`${prefix}/previous`, `${prefix}/projects/${id}/draft`]}
      initialIndex={1}
    >
      <CurrentPath />
      <BackButton />
      <Link to={`/projects/${nextProject.id}/draft`}>다른 준비 화면으로</Link>
      <Routes>
        <Route path="/previous" element={<h1>이전 화면</h1>} />
        <Route path="/projects/:id/draft" element={<DraftPage />} />
        <Route path="/projects/:id" element={<h1>프로젝트 검수실</h1>} />
        <Route path="/projects/:id/settings" element={<h1>프로젝트 설정</h1>} />
        <Route path="/" element={<h1>내 프로젝트</h1>} />
        <Route path="/login" element={<h1>로그인</h1>} />
      </Routes>
    </MemoryRouter>,
  )
}
const getCard = (name: string) => screen.getByRole('heading', { name, level: 2 }).closest('li')!
const expectEditorLocked = () => {
  const editor = screen.getByRole('textbox', { name: '설명' }).closest('section')!
  for (const control of editor.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement>(
    'button, input, textarea',
  )) {
    expect(control.disabled).toBe(true)
  }
}

beforeEach(() => {
  vi.mocked(getMe).mockReset().mockResolvedValue(user)
  vi.mocked(getProject).mockReset().mockResolvedValue(project)
  vi.mocked(listScreens).mockReset().mockResolvedValue(screens)
  vi.mocked(listVersions).mockReset().mockResolvedValue(versions)
  vi.mocked(getVersion).mockReset().mockResolvedValue(draft)
  vi.mocked(createDraft).mockReset().mockResolvedValue(draft)
  vi.mocked(updateDraft).mockReset().mockResolvedValue(draft)
  vi.mocked(putScreenPhoto).mockReset().mockResolvedValue(draft)
  vi.mocked(removeDraftScreen)
    .mockReset()
    .mockResolvedValue({ ...draft, screens: [] })
  vi.mocked(publishVersion).mockReset().mockResolvedValue(published)
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})

afterEach(() => vi.restoreAllMocks())

describe('DraftPage 불러오기와 버전 이름', () => {
  it('프로젝트·버전 목록·화면 이름표를 함께 요청하고 게시 전 버전의 설명과 주소를 채운다', async () => {
    const projectRequest = deferred<ProjectDetail>()
    const versionsRequest = deferred<VersionSummary[]>()
    const screensRequest = deferred<Screen[]>()
    const detailRequest = deferred<VersionDetail>()
    vi.mocked(getProject).mockReturnValueOnce(projectRequest.promise)
    vi.mocked(listVersions).mockReturnValueOnce(versionsRequest.promise)
    vi.mocked(listScreens).mockReturnValueOnce(screensRequest.promise)
    vi.mocked(getVersion).mockReturnValueOnce(detailRequest.promise)
    renderDraft()
    await screen.findByText('불러오는 중이에요.')

    expect(getProject).toHaveBeenCalledExactlyOnceWith(project.id)
    expect(listVersions).toHaveBeenCalledExactlyOnceWith(project.id)
    expect(listScreens).toHaveBeenCalledExactlyOnceWith(project.id)
    expect(getVersion).not.toHaveBeenCalled()
    await act(async () => {
      projectRequest.resolve(project)
      versionsRequest.resolve(versions)
      screensRequest.resolve(screens)
    })
    expect(getVersion).toHaveBeenCalledExactlyOnceWith(draft.id)
    expect(screen.queryByRole('button', { name: /준비 시작/ })).toBeNull()
    expect(screen.getByText('불러오는 중이에요.')).toBeDefined()
    await act(async () => detailRequest.resolve(draft))

    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '설명' }).value).toBe(draft.summary)
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: '테스트 주소' }).value).toBe(draft.testUrl)
    expect(createDraft).not.toHaveBeenCalled()
  })

  it.each([
    { currentVersion: null, label: '초안' },
    { currentVersion: project.currentVersion, label: '1차' },
    { currentVersion: { ...project.currentVersion!, number: 2 }, label: '3차' },
  ])(
    '현재 버전 $currentVersion이면 $label 준비를 시작하고 같은 이름으로 게시한다',
    async ({ currentVersion, label }) => {
      vi.mocked(getProject).mockResolvedValueOnce({ ...project, currentVersion })
      vi.mocked(listVersions).mockResolvedValueOnce(currentVersion ? [versions[1]] : [])
      const pending = deferred<VersionDetail>()
      vi.mocked(createDraft).mockReturnValueOnce(pending.promise)
      renderDraft()
      const start = await screen.findByRole<HTMLButtonElement>('button', { name: `${label} 준비 시작` })
      expect(
        screen.getByText(
          '준비를 시작하면 지금 버전의 화면 구성과 테스트 주소를 그대로 가져와요. 바뀐 화면만 새 사진으로 바꾸면 돼요.',
        ),
      ).toBeDefined()
      expect(getVersion).not.toHaveBeenCalled()
      fireEvent.click(start)
      fireEvent.click(start)
      expect(start.disabled).toBe(true)
      expect(createDraft).toHaveBeenCalledExactlyOnceWith(project.id)
      await act(async () => pending.resolve({ ...draft, summary: '', testUrl: null, screens: [] }))

      expect(screen.getByRole('heading', { name: `${project.name} · ${label} 준비 중` })).toBeDefined()
      expect(screen.getByRole('button', { name: `${label} 게시` })).toBeDefined()
      expect(screen.getByRole<HTMLInputElement>('textbox', { name: '테스트 주소' }).value).toBe('')
      expect(screen.queryByRole('button', { name: /준비 시작/ })).toBeNull()
    },
  )

  it('실제 App의 /app/projects/:id/draft 경로에서도 준비 화면을 연다', async () => {
    render(
      <MemoryRouter basename="/app" initialEntries={[`/app/projects/${project.id}/draft`]}>
        <App />
      </MemoryRouter>,
    )
    expect(await screen.findByRole('heading', { name: `${project.name} · 1차 준비 중` })).toBeDefined()
    expect(screen.getByRole('link', { name: '검수실' }).getAttribute('href')).toBe(`/app/projects/${project.id}`)
  })
})

describe('DraftPage StrictMode의 늦은 첫 조회', () => {
  const renderStrictDraft = () =>
    render(
      <StrictMode>
        <MemoryRouter initialEntries={[`/projects/${project.id}/draft`]}>
          <Routes>
            <Route path="/projects/:id/draft" element={<DraftPage />} />
          </Routes>
        </MemoryRouter>
      </StrictMode>,
    )

  it.each(['버전 목록', '버전 상세', '게시 전 버전 없는 목록'])(
    '첫 조회의 %s 응답이 늦어도 두 번째 응답 뒤 쓴 설명·주소와 사진을 유지한다',
    async (source) => {
      const firstVersions = deferred<VersionSummary[]>()
      const firstDetail = deferred<VersionDetail>()
      const oldDraft: VersionDetail = {
        ...draft,
        id: '4c91bf82-6d1b-43b9-b09d-918bd756d345',
        summary: '이전 조회의 설명',
        testUrl: 'https://example.com/old',
        screens: [],
      }
      const oldVersions: VersionSummary[] = [{ ...versions[0], id: oldDraft.id }]
      vi.mocked(listVersions).mockReturnValueOnce(firstVersions.promise)
      vi.mocked(getVersion).mockImplementation((id) =>
        id === oldDraft.id ? firstDetail.promise : Promise.resolve(draft),
      )
      renderStrictDraft()
      expect(getProject).toHaveBeenCalledTimes(2)
      expect(listVersions).toHaveBeenCalledTimes(2)
      expect(listScreens).toHaveBeenCalledTimes(2)

      // 상세만 늦는 경우에는 첫 목록을 먼저 끝내고 상세 요청을 대기시킨다.
      if (source === '버전 상세') {
        await act(async () => firstVersions.resolve(oldVersions))
        await waitFor(() => expect(getVersion).toHaveBeenCalledWith(oldDraft.id))
      }
      const summary = await screen.findByRole<HTMLTextAreaElement>('textbox', { name: '설명' })
      expect(summary.value).toBe(draft.summary)
      expect(screen.getByRole<HTMLInputElement>('textbox', { name: '테스트 주소' }).value).toBe(draft.testUrl)
      fireEvent.change(summary, { target: { value: '사용자가 새로 쓴 설명' } })
      fireEvent.change(screen.getByRole('textbox', { name: '테스트 주소' }), {
        target: { value: 'https://example.com/edited' },
      })

      await act(async () => {
        firstVersions.resolve(source === '게시 전 버전 없는 목록' ? [] : oldVersions)
        firstDetail.resolve(oldDraft)
      })

      expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '설명' }).value).toBe('사용자가 새로 쓴 설명')
      expect(screen.getByRole<HTMLInputElement>('textbox', { name: '테스트 주소' }).value).toBe(
        'https://example.com/edited',
      )
      expect(screen.getByRole('img', { name: '메인 · PC' }).getAttribute('src')).toBe('/api/assets/pc-photo')
      expect(screen.getByRole<HTMLButtonElement>('button', { name: '저장' }).disabled).toBe(false)
      expect(screen.getByRole<HTMLButtonElement>('button', { name: '1차 게시' }).disabled).toBe(true)
      expect(screen.queryByRole('button', { name: /준비 시작/ })).toBeNull()
      expect(screen.queryByRole('alert')).toBeNull()
    },
  )

  describe.each([
    { source: '프로젝트 조회', delay: (promise: Promise<never>) => vi.mocked(getProject).mockReturnValueOnce(promise) },
    { source: '버전 상세', delay: (promise: Promise<never>) => vi.mocked(getVersion).mockReturnValueOnce(promise) },
  ])('$source', ({ delay }) => {
    it.each([
      { label: '일반 오류', error: new TypeError('Failed to fetch') },
      { label: '서버 오류', error: new ApiError(500) },
      { label: '404', error: new ApiError(404) },
    ])('정리된 첫 조회의 늦은 $label가 편집 화면을 가리지 않는다', async ({ error }) => {
      const pending = deferred<never>()
      delay(pending.promise)
      renderStrictDraft()
      expect(getProject).toHaveBeenCalledTimes(2)
      expect(listVersions).toHaveBeenCalledTimes(2)
      expect(listScreens).toHaveBeenCalledTimes(2)
      const summary = await screen.findByRole<HTMLTextAreaElement>('textbox', { name: '설명' })
      expect(summary.value).toBe(draft.summary)
      fireEvent.change(summary, { target: { value: '오류가 와도 남아야 하는 설명' } })
      fireEvent.change(screen.getByRole('textbox', { name: '테스트 주소' }), {
        target: { value: 'https://example.com/edited' },
      })

      await act(async () => {
        pending.reject(error)
        await pending.promise.catch(() => undefined)
      })

      expect(screen.queryByRole('alert')).toBeNull()
      expect(screen.queryByRole('heading', { name: '없는 프로젝트예요' })).toBeNull()
      expect(screen.getByRole('heading', { name: `${project.name} · 1차 준비 중` })).toBeDefined()
      expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '설명' }).value).toBe(
        '오류가 와도 남아야 하는 설명',
      )
      expect(screen.getByRole<HTMLInputElement>('textbox', { name: '테스트 주소' }).value).toBe(
        'https://example.com/edited',
      )
      expect(screen.getByRole<HTMLButtonElement>('button', { name: '저장' }).disabled).toBe(false)
      expect(screen.getByRole<HTMLButtonElement>('button', { name: '1차 게시' }).disabled).toBe(true)
    })
  })
})

describe('DraftPage 화면 카드', () => {
  it('보이는 이름표는 사진 유무와 관계없이 표시하고 숨긴 이름표는 버전에 있을 때만 표시한다', async () => {
    renderDraft()
    await screen.findByRole('heading', { name: `${project.name} · 1차 준비 중` })
    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual([
      '메인 · PC',
      '메인 · 모바일',
      '소개 · PC숨김',
    ])
    const pc = within(getCard('메인 · PC'))
    expect(pc.getByRole('img').getAttribute('src')).toBe('/api/assets/pc-photo')
    expect(pc.getByRole('img').getAttribute('alt')).toBe('메인 · PC')
    expect(pc.getByLabelText('메인 · PC 사진 바꾸기')).toBeDefined()
    expect(pc.getByRole('button', { name: '빼기' })).toBeDefined()
    const mobile = within(getCard('메인 · 모바일'))
    expect(mobile.getByText(/사진 없음/)).toBeDefined()
    expect(mobile.getByLabelText('메인 · 모바일 사진 선택')).toBeDefined()
    expect(mobile.queryByRole('button', { name: '빼기' })).toBeNull()
    const hidden = within(getCard('소개 · PC숨김'))
    expect(hidden.getByText('숨김')).toBeDefined()
    expect(hidden.getByRole('img', { name: '소개 · PC' }).getAttribute('src')).toBe('/api/assets/hidden-photo')
    expect(hidden.getAllByRole('button').map((button) => button.textContent)).toEqual(['빼기'])
    expect(hidden.queryByLabelText(/사진 선택|사진 바꾸기/)).toBeNull()
    expect(screen.queryByRole('heading', { name: /문의/ })).toBeNull()
  })

  it('숨긴 카드에는 끌어다 놓아도 강조하거나 사진을 올리지 않는다', async () => {
    renderDraft()
    await screen.findByRole('img', { name: '소개 · PC' })
    const hidden = getCard('소개 · PC숨김')
    fireEvent.dragOver(hidden, { dataTransfer: { files: [photo] } })
    expect(hidden.classList.contains(styles.dropping)).toBe(false)
    fireEvent.drop(hidden, { dataTransfer: { files: [photo] } })
    expect(putScreenPhoto).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('화면 이름표가 없으면 설정으로 안내한다', async () => {
    vi.mocked(listScreens).mockResolvedValueOnce([])
    vi.mocked(getVersion).mockResolvedValueOnce({ ...draft, screens: [] })
    renderDraft()
    expect(await screen.findByText(/화면 이름표가 없어요/)).toBeDefined()
    expect(screen.queryByRole('listitem')).toBeNull()
    const link = screen.getByRole('link', { name: '설정' })
    expect(link.getAttribute('href')).toBe(`/projects/${project.id}/settings`)
    fireEvent.click(link)
    expect(await screen.findByRole('heading', { name: '프로젝트 설정' })).toBeDefined()
  })
})

describe('DraftPage 사진 올리기와 빼기', () => {
  it.each([
    { name: '메인 · 모바일', input: '메인 · 모바일 사진 선택', index: 1 },
    { name: '메인 · PC', input: '메인 · PC 사진 바꾸기', index: 0 },
  ])('$input으로 고른 사진을 해당 화면에 올리고 응답 사진을 보여 준다', async ({ name, input, index }) => {
    const target = screens[index]
    vi.mocked(putScreenPhoto).mockResolvedValueOnce({
      ...draft,
      screens: [
        ...draft.screens.filter((item) => item.screenId !== target.id),
        {
          screenId: target.id,
          name: target.name,
          viewport: target.viewport,
          hiddenAt: null,
          asset: { id: 'new-photo', width: 800, height: 600 },
        },
      ],
    })
    renderDraft()
    fireEvent.change(await screen.findByLabelText(input), { target: { files: [photo] } })
    await waitFor(() =>
      expect(within(getCard(name)).getByRole('img').getAttribute('src')).toBe('/api/assets/new-photo'),
    )
    expect(putScreenPhoto).toHaveBeenCalledExactlyOnceWith(draft.id, target.id, photo)
    expect(screen.getByLabelText(`${name} 사진 바꾸기`)).toBeDefined()
    expect(within(getCard(name)).getByRole('button', { name: '빼기' })).toBeDefined()
  })

  it('파일 칸을 비워 같은 파일을 다시 고를 수 있게 한다', async () => {
    renderDraft()
    const input = await screen.findByLabelText<HTMLInputElement>('메인 · PC 사진 바꾸기')
    const valueSetter = vi.spyOn(input, 'value', 'set')
    fireEvent.change(input, { target: { files: [photo] } })
    await waitFor(() => expect(input.disabled).toBe(false))
    expect(valueSetter).toHaveBeenCalledWith('')
    expect(input.value).toBe('')
    fireEvent.change(input, { target: { files: [photo] } })
    await waitFor(() => expect(input.disabled).toBe(false))
    expect(putScreenPhoto).toHaveBeenCalledTimes(2)
    expect(putScreenPhoto).toHaveBeenNthCalledWith(2, draft.id, screens[0].id, photo)
    expect(valueSetter).toHaveBeenCalledTimes(2)
  })

  it('파일 고르기를 취소하면 요청하지 않는다', async () => {
    renderDraft()
    fireEvent.change(await screen.findByLabelText('메인 · 모바일 사진 선택'), { target: { files: [] } })
    expect(putScreenPhoto).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each(['메인 · PC', '메인 · 모바일'])('%s 카드의 끌어다 놓기로 사진을 올리거나 바꾼다', async (name) => {
    renderDraft()
    await screen.findByRole('heading', { name, level: 2 })
    const card = getCard(name)
    fireEvent.dragOver(card, { dataTransfer: { files: [photo] } })
    expect(card.classList.contains(styles.dropping)).toBe(true)
    fireEvent.drop(card, { dataTransfer: { files: [photo] } })
    await waitFor(() =>
      expect(screen.getByRole<HTMLButtonElement>('button', { name: '1차 게시' }).disabled).toBe(false),
    )
    expect(putScreenPhoto).toHaveBeenCalledExactlyOnceWith(draft.id, screens[name === '메인 · PC' ? 0 : 1].id, photo)
    expect(card.classList.contains(styles.dropping)).toBe(false)
  })

  it('카드 안에서 움직일 때 강조를 유지하고 카드 밖으로 나가면 지운다', async () => {
    renderDraft()
    const image = await screen.findByRole('img', { name: '메인 · PC' })
    const card = getCard('메인 · PC')
    fireEvent.dragOver(card)
    fireEvent(card, new MouseEvent('dragleave', { bubbles: true, relatedTarget: image }))
    expect(card.classList.contains(styles.dropping)).toBe(true)
    fireEvent(card, new MouseEvent('dragleave', { bubbles: true, relatedTarget: document.body }))
    expect(card.classList.contains(styles.dropping)).toBe(false)
    expect(putScreenPhoto).not.toHaveBeenCalled()
  })

  it.each([{ files: [] }, { files: [photo, new File(['other'], 'other.png', { type: 'image/png' })] }])(
    '한 장이 아닌 끌어다 놓기는 요청 없이 안내한다: $files',
    async ({ files }) => {
      renderDraft()
      await screen.findByRole('heading', { name: '메인 · 모바일' })
      fireEvent.dragOver(getCard('메인 · 모바일'))
      fireEvent.drop(getCard('메인 · 모바일'), { dataTransfer: { files } })
      expect(screen.getByRole('alert').textContent).toBe('한 장씩 올려 주세요')
      expect(getCard('메인 · 모바일').classList.contains(styles.dropping)).toBe(false)
      expect(putScreenPhoto).not.toHaveBeenCalled()
    },
  )

  describe.each(['파일 선택', '끌어다 놓기'])('%s 크기 검사', (method) => {
    it.each([20 * 1024 * 1024, 20 * 1024 * 1024 + 1])('%i바이트에서 20 MiB 경계를 지킨다', async (size) => {
      const file = new File([new Uint8Array(size)], 'large.png', { type: 'image/png' })
      renderDraft()
      const input = await screen.findByLabelText<HTMLInputElement>('메인 · 모바일 사진 선택')
      if (method === '파일 선택') fireEvent.change(input, { target: { files: [file] } })
      if (method === '끌어다 놓기') fireEvent.drop(getCard('메인 · 모바일'), { dataTransfer: { files: [file] } })
      await waitFor(() => expect(input.disabled).toBe(false))

      if (size > 20 * 1024 * 1024) {
        expect(putScreenPhoto).not.toHaveBeenCalled()
        expect(screen.getByRole('alert').textContent).toBe(
          '사진이 20 MB를 넘어요. JPG나 WebP로 저장하면 크기가 크게 줄어요.',
        )
        return
      }
      expect(putScreenPhoto).toHaveBeenCalledExactlyOnceWith(draft.id, screens[1].id, file)
      expect(screen.queryByRole('alert')).toBeNull()
    })
  })

  it.each(['올리기', '빼기'])('%s 응답은 저장하지 않은 설명과 주소를 덮지 않는다', async (action) => {
    renderDraft()
    await screen.findByRole('textbox', { name: '설명' })
    fireEvent.change(screen.getByRole('textbox', { name: '설명' }), { target: { value: '쓰던 설명' } })
    fireEvent.change(screen.getByRole('textbox', { name: '테스트 주소' }), {
      target: { value: 'https://example.com/new' },
    })
    if (action === '올리기')
      fireEvent.change(screen.getByLabelText('메인 · PC 사진 바꾸기'), { target: { files: [photo] } })
    if (action === '빼기') fireEvent.click(within(getCard('메인 · PC')).getByRole('button', { name: '빼기' }))
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: '저장' }).disabled).toBe(false))

    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '설명' }).value).toBe('쓰던 설명')
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: '테스트 주소' }).value).toBe('https://example.com/new')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '1차 게시' }).disabled).toBe(true)
    expect(screen.getByText(/저장한 뒤 게시해 주세요/)).toBeDefined()
    expect(updateDraft).not.toHaveBeenCalled()
  })

  it.each([
    { name: '메인 · PC', index: 0, hidden: false },
    { name: '소개 · PC숨김', index: 2, hidden: true },
  ])('$name에서 빼기를 누르면 해당 화면만 제거한다', async ({ name, index, hidden }) => {
    vi.mocked(removeDraftScreen).mockResolvedValueOnce({
      ...draft,
      screens: draft.screens.filter((item) => item.screenId !== screens[index].id),
    })
    renderDraft()
    await screen.findByRole('heading', { name, level: 2 })
    fireEvent.click(within(getCard(name)).getByRole('button', { name: '빼기' }))
    await waitFor(() =>
      expect(screen.getByRole<HTMLButtonElement>('button', { name: '1차 게시' }).disabled).toBe(false),
    )
    expect(removeDraftScreen).toHaveBeenCalledExactlyOnceWith(draft.id, screens[index].id)
    if (hidden) {
      expect(screen.queryByRole('heading', { name, level: 2 })).toBeNull()
      expect(screen.getByRole('img', { name: '메인 · PC' })).toBeDefined()
      return
    }
    expect(within(getCard(name)).getByText(/사진 없음/)).toBeDefined()
    expect(screen.getByLabelText(`${name} 사진 선택`)).toBeDefined()
    expect(screen.getByRole('img', { name: '소개 · PC' })).toBeDefined()
  })

  it.each(['올리기', '빼기', '저장', '게시'])(
    '%s 중에는 모든 편집 칸과 버튼을 잠그고 추가 drop과 게시를 막는다',
    async (action) => {
      const pending = deferred<VersionDetail>()
      vi.mocked(putScreenPhoto).mockReturnValueOnce(pending.promise)
      vi.mocked(removeDraftScreen).mockReturnValueOnce(pending.promise)
      vi.mocked(updateDraft).mockReturnValueOnce(pending.promise)
      vi.mocked(publishVersion).mockReturnValueOnce(pending.promise)
      renderDraft()
      await screen.findByRole('textbox', { name: '설명' })
      if (action === '올리기')
        fireEvent.change(screen.getByLabelText('메인 · PC 사진 바꾸기'), { target: { files: [photo] } })
      if (action === '빼기') fireEvent.click(within(getCard('메인 · PC')).getByRole('button', { name: '빼기' }))
      if (action === '저장') {
        fireEvent.change(screen.getByRole('textbox', { name: '설명' }), { target: { value: '수정' } })
        fireEvent.click(screen.getByRole('button', { name: '저장' }))
      }
      if (action === '게시') fireEvent.click(screen.getByRole('button', { name: '1차 게시' }))
      expectEditorLocked()
      fireEvent.drop(getCard('메인 · 모바일'), { dataTransfer: { files: [photo] } })
      fireEvent.click(screen.getByRole('button', { name: '1차 게시' }))
      fireEvent.click(screen.getByRole('button', { name: '저장' }))
      fireEvent.click(within(getCard('메인 · PC')).getByRole('button', { name: '빼기' }))
      expect(putScreenPhoto).toHaveBeenCalledTimes(action === '올리기' ? 1 : 0)
      expect(removeDraftScreen).toHaveBeenCalledTimes(action === '빼기' ? 1 : 0)
      expect(updateDraft).toHaveBeenCalledTimes(action === '저장' ? 1 : 0)
      expect(publishVersion).toHaveBeenCalledTimes(action === '게시' ? 1 : 0)
      await act(async () => pending.resolve(draft))
    },
  )
})

describe('DraftPage 설명과 테스트 주소 저장', () => {
  it.each(['설명', '테스트 주소'])('%s만 바꾸어도 게시를 잠그고 원래 값으로 되돌리면 저장을 잠근다', async (label) => {
    renderDraft()
    const field = await screen.findByRole<HTMLInputElement | HTMLTextAreaElement>('textbox', { name: label })
    const original = field.value
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '저장' }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '1차 게시' }).disabled).toBe(false)
    fireEvent.change(field, { target: { value: label === '설명' ? '다른 설명' : 'https://example.com/changed' } })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '저장' }).disabled).toBe(false)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '1차 게시' }).disabled).toBe(true)
    expect(screen.getByText(/저장한 뒤 게시해 주세요/)).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: '1차 게시' }))
    expect(window.confirm).not.toHaveBeenCalled()
    expect(publishVersion).not.toHaveBeenCalled()
    fireEvent.change(field, { target: { value: original } })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '저장' }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '1차 게시' }).disabled).toBe(false)
    expect(screen.queryByText(/저장한 뒤 게시해 주세요/)).toBeNull()
    expect(updateDraft).not.toHaveBeenCalled()
  })

  it('쓴 값을 저장하고 서버가 공백을 지운 응답으로 칸을 다시 채운다', async () => {
    vi.mocked(updateDraft).mockResolvedValueOnce({ ...draft, summary: '새 설명', testUrl: 'https://example.com/new' })
    renderDraft()
    await screen.findByRole('textbox', { name: '설명' })
    fireEvent.change(screen.getByRole('textbox', { name: '설명' }), { target: { value: '  새 설명  ' } })
    fireEvent.change(screen.getByRole('textbox', { name: '테스트 주소' }), {
      target: { value: '  https://example.com/new  ' },
    })
    fireEvent.click(screen.getByRole('button', { name: '저장' }))
    await waitFor(() =>
      expect(screen.getByRole<HTMLButtonElement>('button', { name: '1차 게시' }).disabled).toBe(false),
    )

    expect(updateDraft).toHaveBeenCalledExactlyOnceWith(draft.id, {
      summary: '  새 설명  ',
      testUrl: '  https://example.com/new  ',
    })
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '설명' }).value).toBe('새 설명')
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: '테스트 주소' }).value).toBe('https://example.com/new')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '저장' }).disabled).toBe(true)
    expect(screen.queryByText(/저장한 뒤 게시해 주세요/)).toBeNull()
  })

  it('설명과 주소를 모두 비워 저장하면 null 주소를 빈 칸으로 표시한다', async () => {
    vi.mocked(updateDraft).mockResolvedValueOnce({ ...draft, summary: '', testUrl: null })
    renderDraft()
    await screen.findByRole('textbox', { name: '설명' })
    fireEvent.change(screen.getByRole('textbox', { name: '설명' }), { target: { value: '' } })
    fireEvent.change(screen.getByRole('textbox', { name: '테스트 주소' }), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: '저장' }))
    await waitFor(() =>
      expect(screen.getByRole<HTMLButtonElement>('button', { name: '1차 게시' }).disabled).toBe(false),
    )
    expect(updateDraft).toHaveBeenCalledExactlyOnceWith(draft.id, { summary: '', testUrl: '' })
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: '테스트 주소' }).value).toBe('')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '저장' }).disabled).toBe(true)
  })

  it('422이면 입력을 보존하고 저장을 다시 할 수 있게 한다', async () => {
    vi.mocked(updateDraft).mockRejectedValueOnce(new ApiError(422))
    renderDraft()
    await screen.findByRole('textbox', { name: '설명' })
    const summary = '가'.repeat(1001)
    fireEvent.change(screen.getByRole('textbox', { name: '설명' }), { target: { value: summary } })
    fireEvent.change(screen.getByRole('textbox', { name: '테스트 주소' }), { target: { value: 'http://example.com' } })
    fireEvent.click(screen.getByRole('button', { name: '저장' }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      '설명은 1,000자까지, 테스트 주소는 https://로 시작하는 주소로 써 주세요',
    )
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '설명' }).value).toBe(summary)
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: '테스트 주소' }).value).toBe('http://example.com')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '저장' }).disabled).toBe(false)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '1차 게시' }).disabled).toBe(true)
  })
})

describe('DraftPage 게시와 화면 이동', () => {
  it.each([
    { currentVersion: null, label: '초안', particle: '으로', basename: '/' },
    { currentVersion: project.currentVersion, label: '1차', particle: '로', basename: '/app' },
  ])('$label 게시를 확인한 뒤 응답이 오면 검수실로 간다', async ({ currentVersion, label, particle, basename }) => {
    vi.mocked(getProject).mockResolvedValueOnce({ ...project, currentVersion })
    const pending = deferred<VersionDetail>()
    vi.mocked(publishVersion).mockReturnValueOnce(pending.promise)
    renderDraft(project.id, basename)
    fireEvent.click(await screen.findByRole('button', { name: `${label} 게시` }))
    expect(window.confirm).toHaveBeenCalledExactlyOnceWith(`게시하면 고칠 수 없어요. ${label}${particle} 게시할까요?`)
    expect(publishVersion).toHaveBeenCalledExactlyOnceWith(draft.id)
    expect(screen.getByLabelText('현재 주소').textContent).toBe(`/projects/${project.id}/draft`)
    await act(async () => pending.resolve({ ...published, number: currentVersion ? 1 : 0 }))
    expect(await screen.findByRole('heading', { name: '프로젝트 검수실' })).toBeDefined()
    expect(screen.getByLabelText('현재 주소').textContent).toBe(`/projects/${project.id}`)
  })

  it('확인 창에서 취소하면 게시하지 않고 편집 화면을 유지한다', async () => {
    vi.mocked(window.confirm).mockReturnValueOnce(false)
    renderDraft()
    fireEvent.click(await screen.findByRole('button', { name: '1차 게시' }))
    expect(window.confirm).toHaveBeenCalledExactlyOnceWith('게시하면 고칠 수 없어요. 1차로 게시할까요?')
    expect(publishVersion).not.toHaveBeenCalled()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '1차 게시' }).disabled).toBe(false)
    expect(screen.getByLabelText('현재 주소').textContent).toBe(`/projects/${project.id}/draft`)
  })

  it.each(['이전 화면', '다른 프로젝트'])(
    '게시 응답 전에 %s으로 떠나면 늦은 응답이 끌고 가지 않는다',
    async (destination) => {
      const pending = deferred<VersionDetail>()
      vi.mocked(publishVersion).mockReturnValueOnce(pending.promise)
      renderDraft()
      fireEvent.click(await screen.findByRole('button', { name: '1차 게시' }))
      vi.mocked(getProject).mockResolvedValueOnce(nextProject)
      vi.mocked(listVersions).mockResolvedValueOnce([])
      if (destination === '이전 화면') fireEvent.click(screen.getByRole('button', { name: '뒤로 가기' }))
      if (destination === '다른 프로젝트') fireEvent.click(screen.getByRole('link', { name: '다른 준비 화면으로' }))
      const heading = destination === '이전 화면' ? '이전 화면' : nextProject.name
      await screen.findByRole('heading', { name: heading })
      await act(async () => pending.resolve(published))
      expect(screen.getByRole('heading', { name: heading })).toBeDefined()
      expect(screen.getByLabelText('현재 주소').textContent).toBe(
        destination === '이전 화면' ? '/previous' : `/projects/${nextProject.id}/draft`,
      )
    },
  )

  it.each(['성공', '404'])('다른 프로젝트로 이동하면 이전 상세의 늦은 %s가 새 화면을 덮지 않는다', async (result) => {
    const pending = deferred<VersionDetail>()
    vi.mocked(getVersion).mockReturnValueOnce(pending.promise)
    renderDraft()
    await waitFor(() => expect(getVersion).toHaveBeenCalledExactlyOnceWith(draft.id))
    vi.mocked(getProject).mockResolvedValueOnce(nextProject)
    vi.mocked(listVersions).mockResolvedValueOnce([])
    fireEvent.click(screen.getByRole('link', { name: '다른 준비 화면으로' }))
    await screen.findByRole('heading', { name: nextProject.name })
    await act(async () => {
      if (result === '성공') pending.resolve(draft)
      if (result === '404') pending.reject(new ApiError(404))
      await pending.promise.catch(() => undefined)
    })
    expect(screen.getByRole('heading', { name: nextProject.name })).toBeDefined()
    expect(screen.getByRole('button', { name: '초안 준비 시작' })).toBeDefined()
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('heading', { name: '없는 프로젝트예요' })).toBeNull()
  })

  it('다른 프로젝트를 불러오는 동안 이전 사진·입력·게시 버튼을 남기지 않는다', async () => {
    renderDraft()
    await screen.findByRole('textbox', { name: '설명' })
    fireEvent.change(screen.getByRole('textbox', { name: '설명' }), {
      target: { value: '이전 프로젝트의 미저장 설명' },
    })
    const pending = deferred<ProjectDetail>()
    vi.mocked(getProject).mockReturnValueOnce(pending.promise)
    vi.mocked(listVersions).mockResolvedValueOnce([])
    fireEvent.click(screen.getByRole('link', { name: '다른 준비 화면으로' }))
    await screen.findByText('불러오는 중이에요.')
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('button', { name: '1차 게시' })).toBeNull()
    await act(async () => pending.resolve(nextProject))
    expect(screen.getByRole('heading', { name: nextProject.name })).toBeDefined()
  })

  it.each(['drop', 'dragover'])('카드 밖 window의 %s 기본 동작을 막고 떠난 뒤에는 해제한다', async (type) => {
    renderDraft()
    await screen.findByRole('textbox', { name: '설명' })
    const event = new Event(type, { bubbles: true, cancelable: true })
    fireEvent(window, event)
    expect(event.defaultPrevented).toBe(true)
    expect(putScreenPhoto).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '뒤로 가기' }))
    await screen.findByRole('heading', { name: '이전 화면' })
    const afterLeaving = new Event(type, { bubbles: true, cancelable: true })
    fireEvent(window, afterLeaving)
    expect(afterLeaving.defaultPrevented).toBe(false)
  })
})

describe('DraftPage 로그인과 접근', () => {
  it('로그인 확인 중에는 프로젝트와 편집 내용을 보여 주지 않는다', async () => {
    const pending = deferred<Me>()
    vi.mocked(getMe).mockReturnValueOnce(pending.promise)
    renderDraft()
    await act(async () => {})
    expect(screen.getByText('확인하는 중이에요.')).toBeDefined()
    expect(screen.queryByRole('heading')).toBeNull()
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(getMe).toHaveBeenCalledExactlyOnceWith()
    await act(async () => pending.resolve(user))
    expect(screen.getByRole('textbox', { name: '설명' })).toBeDefined()
  })

  it.each(['/', '/app'])('basename %s에서 비로그인이면 로그인으로 이동하고 방문 기록을 교체한다', async (basename) => {
    vi.mocked(getMe).mockResolvedValueOnce(null)
    renderDraft(project.id, basename)
    expect(await screen.findByRole('heading', { name: '로그인' })).toBeDefined()
    expect(screen.getByLabelText('현재 주소').textContent).toBe('/login')
    fireEvent.click(screen.getByRole('button', { name: '뒤로 가기' }))
    expect(await screen.findByRole('heading', { name: '이전 화면' })).toBeDefined()
  })

  it.each([new ApiError(500), new TypeError('Failed to fetch')])(
    '로그인 확인 오류 %s는 현재 주소에서 안내한다',
    async (error) => {
      vi.mocked(getMe).mockRejectedValueOnce(error)
      renderDraft()
      expect(await screen.findByText('불러오지 못했어요. 잠시 뒤 새로고침해 주세요')).toBeDefined()
      expect(screen.getByLabelText('현재 주소').textContent).toBe(`/projects/${project.id}/draft`)
      expect(screen.queryByRole('textbox')).toBeNull()
      expect(screen.queryByRole('img')).toBeNull()
    },
  )

  it.each([null, project.currentVersion])(
    '클라이언트에게는 안내와 검수실 링크만 보여 준다: %s',
    async (currentVersion) => {
      vi.mocked(getProject).mockResolvedValueOnce({ ...project, currentVersion, myRole: 'CLIENT' })
      // API 계약상 클라이언트 목록에는 DRAFT가 없다.
      vi.mocked(listVersions).mockResolvedValueOnce(currentVersion ? [versions[1]] : [])
      renderDraft()
      const heading = await screen.findByRole('heading', { name: '개발자만 준비할 수 있어요' })
      const page = within(heading.closest('section')!)
      expect(page.getAllByRole('link').map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
        ['검수실', `/projects/${project.id}`],
      ])
      expect(page.queryByRole('button')).toBeNull()
      expect(page.queryByRole('textbox')).toBeNull()
      expect(page.queryByRole('img')).toBeNull()
      expect(createDraft).not.toHaveBeenCalled()
      expect(getVersion).not.toHaveBeenCalled()
      fireEvent.click(page.getByRole('link', { name: '검수실' }))
      expect(await screen.findByRole('heading', { name: '프로젝트 검수실' })).toBeDefined()
    },
  )

  it.each(['abc', '.', '..', '00000000-invalid'])(
    '잘못된 프로젝트 id %s는 프로젝트·버전·화면 API를 부르지 않는다',
    async (id) => {
      renderDraft(id)
      expect(await screen.findByRole('heading', { name: '없는 프로젝트예요' })).toBeDefined()
      expect(screen.getByRole('link', { name: '프로젝트 목록' }).getAttribute('href')).toBe('/')
      expect(getProject).not.toHaveBeenCalled()
      expect(listVersions).not.toHaveBeenCalled()
      expect(listScreens).not.toHaveBeenCalled()
      expect(getVersion).not.toHaveBeenCalled()
      expect(createDraft).not.toHaveBeenCalled()
    },
  )
})

describe('DraftPage 불러오기 오류', () => {
  describe.each([
    { source: '프로젝트', fail: (error: Error) => vi.mocked(getProject).mockRejectedValueOnce(error) },
    { source: '버전 목록', fail: (error: Error) => vi.mocked(listVersions).mockRejectedValueOnce(error) },
    { source: '화면 이름표', fail: (error: Error) => vi.mocked(listScreens).mockRejectedValueOnce(error) },
    { source: '게시 전 버전 상세', fail: (error: Error) => vi.mocked(getVersion).mockRejectedValueOnce(error) },
  ])('$source', ({ fail }) => {
    it('404는 없는 프로젝트로 안내한다', async () => {
      fail(new ApiError(404))
      renderDraft()
      expect(await screen.findByRole('heading', { name: '없는 프로젝트예요' })).toBeDefined()
      expect(screen.queryByRole('textbox')).toBeNull()
      expect(screen.queryByRole('button', { name: /준비 시작/ })).toBeNull()
      expect(screen.getByRole('link', { name: '프로젝트 목록' }).getAttribute('href')).toBe('/')
    })

    it('401은 현재 화면에서 다시 로그인 링크를 안내한다', async () => {
      fail(new ApiError(401))
      renderDraft()
      expect((await screen.findByRole('alert')).textContent).toContain('로그인이 끝났어요. 다시 로그인해 주세요')
      expect(screen.getByLabelText('현재 주소').textContent).toBe(`/projects/${project.id}/draft`)
      const link = screen.getByRole('link', { name: '다시 로그인하기' })
      expect(link.getAttribute('href')).toBe('/login')
      fireEvent.click(link)
      expect(await screen.findByRole('heading', { name: '로그인' })).toBeDefined()
    })

    it.each([
      { error: new ApiError(500), message: '잠시 뒤 다시 시도해 주세요' },
      { error: new TypeError('Failed to fetch'), message: '연결을 확인하고 다시 시도해 주세요' },
    ])('$message를 표시하고 준비 시작으로 잘못 안내하지 않는다', async ({ error, message }) => {
      fail(error)
      renderDraft()
      expect((await screen.findByRole('alert')).textContent).toBe(message)
      expect(screen.queryByRole('button', { name: /준비 시작/ })).toBeNull()
      expect(screen.queryByRole('textbox')).toBeNull()
    })
  })
})

describe('DraftPage 작업 오류와 재시도', () => {
  it.each([
    { error: new ApiError(413), message: '사진 크기(픽셀)가 너무 크거나 프로젝트 사진 용량(1 GB)이 찼어요' },
    { error: new ApiError(415), message: 'PNG, JPG, WebP 사진만 올릴 수 있어요(움직이는 사진 제외)' },
    { error: new ApiError(409, 'SCREEN_HIDDEN'), message: '숨긴 화면에는 사진을 올릴 수 없어요' },
    { error: new ApiError(409, 'TOO_MANY_SCREENS'), message: '화면은 20개까지 올릴 수 있어요' },
    { error: new ApiError(409, 'VERSION_NOT_DRAFT'), message: '이미 게시된 버전이에요. 새로고침해 주세요' },
    { error: new ApiError(500), message: '잠시 뒤 다시 시도해 주세요' },
    { error: new TypeError('Failed to fetch'), message: '연결을 확인하고 다시 시도해 주세요' },
  ])('사진 올리기 실패: $message', async ({ error, message }) => {
    vi.mocked(putScreenPhoto).mockRejectedValueOnce(error)
    renderDraft()
    fireEvent.change(await screen.findByLabelText('메인 · PC 사진 바꾸기'), { target: { files: [photo] } })
    expect((await screen.findByRole('alert')).textContent).toBe(message)
    expect(screen.getByRole('img', { name: '메인 · PC' }).getAttribute('src')).toBe('/api/assets/pc-photo')
    expect(screen.getByLabelText<HTMLInputElement>('메인 · PC 사진 바꾸기').disabled).toBe(false)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '1차 게시' }).disabled).toBe(false)
  })

  it.each([
    { code: 'NO_SCREENS', message: '사진을 올린 화면이 없어요' },
    { code: 'SCREEN_HIDDEN', message: '숨긴 화면을 빼고 게시해 주세요' },
    { code: 'VERSION_NOT_DRAFT', message: '이미 게시된 버전이에요. 새로고침해 주세요' },
  ])('게시 409 $code는 해당 안내를 보여 주고 검수실로 가지 않는다', async ({ code, message }) => {
    vi.mocked(publishVersion).mockRejectedValueOnce(new ApiError(409, code))
    if (code === 'NO_SCREENS') vi.mocked(getVersion).mockResolvedValueOnce({ ...draft, screens: [] })
    renderDraft()
    fireEvent.click(await screen.findByRole('button', { name: '1차 게시' }))
    expect((await screen.findByRole('alert')).textContent).toBe(message)
    expect(screen.getByLabelText('현재 주소').textContent).toBe(`/projects/${project.id}/draft`)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '1차 게시' }).disabled).toBe(false)
  })

  it('다른 곳에서 이미 준비를 시작했으면 DRAFT_EXISTS를 안내하고 다시 시작할 수 있다', async () => {
    vi.mocked(listVersions).mockResolvedValueOnce([versions[1]])
    vi.mocked(createDraft).mockRejectedValueOnce(new ApiError(409, 'DRAFT_EXISTS'))
    renderDraft()
    fireEvent.click(await screen.findByRole('button', { name: '1차 준비 시작' }))
    expect((await screen.findByRole('alert')).textContent).toBe('이미 준비 중인 버전이 있어요. 새로고침해 주세요')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '1차 준비 시작' }).disabled).toBe(false)
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('화면 빼기가 실패하면 원래 사진과 빼기 버튼이 남는다', async () => {
    vi.mocked(removeDraftScreen).mockRejectedValueOnce(new ApiError(409, 'VERSION_NOT_DRAFT'))
    renderDraft()
    await screen.findByRole('img', { name: '소개 · PC' })
    fireEvent.click(within(getCard('소개 · PC숨김')).getByRole('button', { name: '빼기' }))
    expect((await screen.findByRole('alert')).textContent).toBe('이미 게시된 버전이에요. 새로고침해 주세요')
    expect(screen.getByRole('img', { name: '소개 · PC' }).getAttribute('src')).toBe('/api/assets/hidden-photo')
    expect(within(getCard('소개 · PC숨김')).getByRole<HTMLButtonElement>('button', { name: '빼기' }).disabled).toBe(
      false,
    )
  })

  it('저장 중 401은 쓰던 글을 보존하고 다시 로그인 링크를 보여 준다', async () => {
    vi.mocked(updateDraft).mockRejectedValueOnce(new ApiError(401))
    renderDraft()
    fireEvent.change(await screen.findByRole('textbox', { name: '설명' }), {
      target: { value: '아직 저장하지 않은 설명' },
    })
    fireEvent.click(screen.getByRole('button', { name: '저장' }))
    expect((await screen.findByRole('alert')).textContent).toContain('로그인이 끝났어요. 다시 로그인해 주세요')
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '설명' }).value).toBe('아직 저장하지 않은 설명')
    expect(screen.getByRole('link', { name: '다시 로그인하기' }).getAttribute('href')).toBe('/login')
    expect(screen.getByLabelText('현재 주소').textContent).toBe(`/projects/${project.id}/draft`)
  })

  it.each(['시작', '올리기', '빼기', '저장', '게시'])(
    '%s를 새로 시작하면 응답 전부터 지난 오류를 지운다',
    async (action) => {
      const pending = deferred<VersionDetail>()
      if (action === '시작') {
        vi.mocked(listVersions).mockResolvedValueOnce([])
        vi.mocked(createDraft).mockRejectedValueOnce(new ApiError(500)).mockReturnValueOnce(pending.promise)
        renderDraft()
        fireEvent.click(await screen.findByRole('button', { name: '1차 준비 시작' }))
        await screen.findByRole('alert')
        fireEvent.click(screen.getByRole('button', { name: '1차 준비 시작' }))
        expect(screen.queryByRole('alert')).toBeNull()
        await act(async () => pending.resolve(draft))
        return
      }
      renderDraft()
      await screen.findByRole('heading', { name: '메인 · 모바일' })
      fireEvent.drop(getCard('메인 · 모바일'), { dataTransfer: { files: [photo, photo] } })
      expect(screen.getByRole('alert').textContent).toBe('한 장씩 올려 주세요')
      vi.mocked(putScreenPhoto).mockReturnValueOnce(pending.promise)
      vi.mocked(removeDraftScreen).mockReturnValueOnce(pending.promise)
      vi.mocked(updateDraft).mockReturnValueOnce(pending.promise)
      vi.mocked(publishVersion).mockReturnValueOnce(pending.promise)
      if (action === '올리기')
        fireEvent.change(screen.getByLabelText('메인 · PC 사진 바꾸기'), { target: { files: [photo] } })
      if (action === '빼기') fireEvent.click(within(getCard('메인 · PC')).getByRole('button', { name: '빼기' }))
      if (action === '저장') {
        fireEvent.change(screen.getByRole('textbox', { name: '설명' }), { target: { value: '새 설명' } })
        fireEvent.click(screen.getByRole('button', { name: '저장' }))
      }
      if (action === '게시') fireEvent.click(screen.getByRole('button', { name: '1차 게시' }))
      expect(screen.queryByRole('alert')).toBeNull()
      expectEditorLocked()
      await act(async () => pending.resolve(draft))
    },
  )
})
