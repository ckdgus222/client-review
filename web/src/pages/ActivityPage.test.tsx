import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { Link, MemoryRouter, useLocation } from 'react-router'
import App from '../App.tsx'
import type { Me } from '../api/auth.ts'
import type { ProjectDetail } from '../api/projects.ts'
import type { ActivityItem, VersionDetail } from '../api/versions.ts'

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
const items: ActivityItem[] = [
  {
    id: 'f6dadf8d-5cb9-4602-80db-8c868ebaf601',
    issue: null,
    type: 'VERSION_PUBLISHED',
    createdAt: '2026-11-09T09:04:00.000Z',
    actorName: '최개발',
    memberName: null,
    version: project.currentVersion,
  },
  {
    id: 'ae3ddac8-e194-4396-ab22-f28b81e040b0',
    issue: null,
    type: 'VERSION_PUBLISHED',
    createdAt: '2026-11-08T23:59:00.000Z',
    actorName: '김개발',
    memberName: null,
    version: { id: '7b13b773-8835-45f0-b46f-c555b5033dc7', number: 1 },
  },
  {
    id: '695d8b02-3c89-4a80-b86d-5a01e345c9a5',
    issue: null,
    type: 'VERSION_PUBLISHED',
    createdAt: '2026-11-07T00:01:00.000Z',
    actorName: '이개발',
    memberName: null,
    version: { id: '24f86b45-afd2-4c27-a774-90586f6e8473', number: 0 },
  },
]
const nextProject: ProjectDetail = {
  ...project,
  id: '6b62c564-585a-4f05-ae57-8d6b3bc5a47f',
  name: '다음 프로젝트',
  currentVersion: null,
}
const projectUrl = `/api/projects/${project.id}`
const activityUrl = `${projectUrl}/activity`
const nextProjectUrl = `/api/projects/${nextProject.id}`
const activityPath = `/projects/${project.id}/activity`
const nextActivityPath = `/projects/${nextProject.id}/activity`
const responses = new Map<string, () => Response | Promise<Response>>()
const fetchMock = vi.fn<typeof fetch>()

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}
const CurrentPath = () => {
  const { pathname, search } = useLocation()
  return <output aria-label="현재 주소">{pathname + search}</output>
}
const renderActivity = (path = activityPath, basename = '/') => {
  const prefix = basename === '/' ? '' : basename
  return render(
    <MemoryRouter basename={basename} initialEntries={[`${prefix}${path}`]}>
      <CurrentPath />
      <Link to={nextActivityPath}>다른 프로젝트 일지로</Link>
      <App />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  responses.clear()
  responses.set('/api/auth/me', () => Response.json(user))
  responses.set(projectUrl, () => Response.json(project))
  responses.set(activityUrl, () => Response.json(items))
  responses.set(`${projectUrl}/issues`, () => Response.json([]))
  responses.set(nextProjectUrl, () => Response.json(nextProject))
  responses.set(`${nextProjectUrl}/activity`, () => Response.json([]))
  fetchMock.mockReset().mockImplementation(async (input) => {
    const respond = responses.get(String(input))
    if (!respond) throw new Error(`예상하지 않은 요청: ${String(input)}`)
    return respond()
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => vi.unstubAllGlobals())

describe('ActivityPage 기록 표시', () => {
  it('서버가 준 최신순으로 이름과 초안·1차·2차 문장을 표시한다', async () => {
    renderActivity()
    const list = await screen.findByRole('list')
    const rows = within(list).getAllByRole('listitem')

    expect(rows.map((row) => row.querySelector('span')?.textContent)).toEqual([
      '최개발님이 2차를 게시했어요',
      '김개발님이 1차를 게시했어요',
      '이개발님이 초안을 게시했어요',
    ])
    expect(fetchMock.mock.calls.map(([url]) => url).sort()).toEqual(['/api/auth/me', projectUrl, activityUrl].sort())
  })

  it('같은 시각의 기록도 서버 순서를 그대로 유지한다', async () => {
    responses.set(activityUrl, () => Response.json([{ ...items[1], createdAt: items[0].createdAt }, items[0]]))
    renderActivity()

    const rows = within(await screen.findByRole('list')).getAllByRole('listitem')
    expect(rows.map((row) => row.querySelector('span')?.textContent)).toEqual([
      '김개발님이 1차를 게시했어요',
      '최개발님이 2차를 게시했어요',
    ])
  })

  it('각 기록의 time에 원본 시각과 ko-KR로 바꾼 시각을 표시한다', async () => {
    renderActivity()
    const rows = within(await screen.findByRole('list')).getAllByRole('listitem')
    const format = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' })

    rows.forEach((row, index) => {
      const time = row.querySelector('time')
      expect(time?.getAttribute('datetime')).toBe(items[index].createdAt)
      expect(time?.textContent).toBe(format.format(new Date(items[index].createdAt)))
    })
  })

  it('버전이 없는 기록은 일반 문장과 시각만 표시하고 링크를 만들지 않는다', async () => {
    responses.set(activityUrl, () => Response.json([{ ...items[0], version: null }]))
    renderActivity()

    const row = within(await screen.findByRole('list')).getByRole('listitem')
    expect(within(row).getByText('최개발님이 버전을 게시했어요')).toBeDefined()
    expect(within(row).queryByRole('link')).toBeNull()
    expect(row.querySelector('time')?.getAttribute('datetime')).toBe(items[0].createdAt)
  })

  it.each([
    {
      type: 'INVITATION_CREATED',
      actorName: '개발 담당',
      memberName: null,
      message: '개발 담당님이 클라이언트를 초대했어요',
    },
    {
      type: 'INVITATION_ACCEPTED',
      actorName: '검수 담당',
      memberName: '검수 담당',
      message: '검수 담당님이 프로젝트에 참여했어요',
    },
    {
      type: 'MEMBER_REVOKED',
      actorName: '개발 담당',
      memberName: '검수 담당',
      message: '개발 담당님이 검수 담당님의 접근을 철회했어요',
    },
    {
      type: 'MEMBER_REVOKED',
      actorName: '개발 담당',
      memberName: null,
      message: '개발 담당님이 참여자의 접근을 철회했어요',
    },
    {
      type: 'APPROVER_CHANGED',
      actorName: '개발 담당',
      memberName: '검수 담당',
      message: '개발 담당님이 검수 담당님을 승인자로 정했어요',
    },
    {
      type: 'APPROVER_CHANGED',
      actorName: '개발 담당',
      memberName: null,
      message: '개발 담당님이 승인자를 비웠어요',
    },
  ] satisfies (Pick<ActivityItem, 'type' | 'actorName' | 'memberName'> & { message: string })[])(
    '$type 대상 $memberName: "$message"를 링크 없이 표시하고 게시 기록의 문장과 링크는 유지한다',
    async ({ type, actorName, memberName, message }) => {
      const event: ActivityItem = {
        id: 'd375d33f-813b-4651-8316-727f094c14b2',
        issue: null,
        type,
        createdAt: '2026-11-10T09:04:00.000Z',
        actorName,
        memberName,
        version: null,
      }
      responses.set(activityUrl, () => Response.json([event, items[0]]))
      renderActivity()

      const list = await screen.findByRole('list')
      const rows = within(list).getAllByRole('listitem')
      expect(rows).toHaveLength(2)
      expect(rows[0].querySelector('span')?.textContent).toBe(message)
      expect(within(rows[0]).queryByRole('link')).toBeNull()
      expect(rows[0].querySelector('time')?.getAttribute('datetime')).toBe(event.createdAt)
      expect(rows[1].querySelector('span')?.textContent).toBe('최개발님이 2차를 게시했어요')
      expect(within(list).getAllByRole('link')).toHaveLength(1)
      expect(within(rows[1]).getByRole('link').getAttribute('href')).toBe(
        `/projects/${project.id}?version=${items[0].version!.id}`,
      )
    },
  )

  it('기록이 없으면 빈 목록 안내를 표시한다', async () => {
    responses.set(activityUrl, () => Response.json([]))
    renderActivity()

    expect(await screen.findByText('아직 기록이 없어요.')).toBeDefined()
    expect(screen.queryByRole('list')).toBeNull()
  })

  it.each(['/', '/app'])('basename %s의 실제 App 경로에서 제목과 검수실 링크를 표시한다', async (basename) => {
    renderActivity(activityPath, basename)

    expect(await screen.findByRole('heading', { level: 1, name: `${project.name} 활동 일지` })).toBeDefined()
    const prefix = basename === '/' ? '' : basename
    expect(screen.getByRole('link', { name: '검수실' }).getAttribute('href')).toBe(`${prefix}/projects/${project.id}`)
    const rows = screen.getAllByRole('listitem')
    rows.forEach((row, index) => {
      expect(within(row).getByRole('link').getAttribute('href')).toBe(
        `${prefix}/projects/${project.id}?version=${items[index].version!.id}`,
      )
    })
    expect(screen.queryByRole('heading', { name: '없는 화면이에요' })).toBeNull()
  })

  it.each([
    { role: 'DEVELOPER' as const, basename: '/' },
    { role: 'CLIENT' as const, basename: '/app' },
  ])('$role도 검수실에서 활동 일지를 열고 초안 기록을 눌러 그 버전을 본다', async ({ role, basename }) => {
    responses.set(projectUrl, () => Response.json({ ...project, myRole: role }))
    const versions: VersionDetail[] = items.map((item) => ({
      ...item.version!,
      projectId: project.id,
      status: 'IN_REVIEW',
      publishedAt: item.createdAt,
      summary: `${item.version!.number}번 버전 설명`,
      testUrl: null,
      approval: null,
      screens: [
        {
          screenId: 'fdba89f1-38f6-4910-a5c7-6774a8e2f9ef',
          name: '메인',
          viewport: 'PC',
          hiddenAt: null,
          asset: { id: `photo-${item.version!.number}`, width: 1440, height: 900 },
        },
      ],
    }))
    responses.set(`${projectUrl}/versions`, () => Response.json(versions))
    versions.forEach((version) => {
      responses.set(`/api/versions/${version.id}`, () => Response.json(version))
    })
    renderActivity(`/projects/${project.id}`, basename)
    expect(await screen.findByText('2번 버전 설명')).toBeDefined()
    fireEvent.click(screen.getByRole('link', { name: '활동 일지' }))

    expect(await screen.findByRole('heading', { name: `${project.name} 활동 일지` })).toBeDefined()
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
    fireEvent.click(screen.getByRole('link', { name: /이개발님이 초안을 게시했어요/ }))

    expect(await screen.findByText('0번 버전 설명')).toBeDefined()
    expect(screen.getByLabelText('현재 주소').textContent).toBe(
      `/projects/${project.id}?version=${items[2].version!.id}`,
    )
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '버전' }).value).toBe(items[2].version!.id)
    expect(screen.getByRole('img', { name: '메인 · PC' }).getAttribute('src')).toBe('/api/assets/photo-0')
    expect(screen.queryByText('2번 버전 설명')).toBeNull()
  })
})

describe.each([
  { type: 'ISSUE_CREATED', action: '를 남겼어요' },
  { type: 'ISSUE_STARTED', action: ' 수정을 시작했어요' },
] satisfies { type: ActivityItem['type']; action: string }[])('ActivityPage $type 기록', ({ type, action }) => {
  const issueId = 'a728f97e-4d83-49b2-b50d-38e72d3901c9'

  it.each([13, 14])('#%i를 쪽지 앞에 표시하고 쪽지 주소로 연결한다', async (number) => {
    const event: ActivityItem = {
      ...items[0],
      type,
      actorName: '김수정',
      issue: { id: issueId, number },
      version: null,
    }
    responses.set(activityUrl, () => Response.json([event, items[1]]))
    renderActivity()

    const rows = within(await screen.findByRole('list')).getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(within(rows[0]).getByText(`김수정님이 #${number} 쪽지${action}`)).toBeDefined()
    expect(within(rows[0]).getByRole('link').getAttribute('href')).toBe(`/projects/${project.id}?issue=${issueId}`)
    expect(rows[0].querySelector('time')?.getAttribute('datetime')).toBe(event.createdAt)
    expect(within(rows[1]).getByText('김개발님이 1차를 게시했어요')).toBeDefined()
    expect(within(rows[1]).getByRole('link').getAttribute('href')).toBe(
      `/projects/${project.id}?version=${items[1].version!.id}`,
    )
  })

  it('쪽지와 버전이 모두 null이면 번호 없는 쪽지 문장과 시각을 링크 없이 표시한다', async () => {
    responses.set(activityUrl, () => Response.json([{ ...items[0], type, issue: null, version: null }]))
    renderActivity()

    const row = within(await screen.findByRole('list')).getByRole('listitem')
    expect(within(row).getByText(`최개발님이 쪽지${action}`)).toBeDefined()
    expect(within(row).queryByRole('link')).toBeNull()
    expect(row.querySelector('time')?.getAttribute('datetime')).toBe(items[0].createdAt)
  })

  it.each(['/', '/app'])('basename %s에서 쪽지와 버전이 함께 있으면 쪽지 링크를 우선한다', async (basename) => {
    responses.set(activityUrl, () => Response.json([{ ...items[0], type, issue: { id: issueId, number: 14 } }]))
    renderActivity(activityPath, basename)

    const row = within(await screen.findByRole('list')).getByRole('listitem')
    expect(within(row).getByText(`최개발님이 #14 쪽지${action}`)).toBeDefined()
    expect(within(row).getAllByRole('link')).toHaveLength(1)
    const prefix = basename === '/' ? '' : basename
    expect(within(row).getByRole('link').getAttribute('href')).toBe(`${prefix}/projects/${project.id}?issue=${issueId}`)
  })

  it('쪽지가 null이고 버전이 있으면 번호 없는 쪽지 문장을 버전 주소로 연결한다', async () => {
    responses.set(activityUrl, () => Response.json([{ ...items[0], type, issue: null }]))
    renderActivity()

    const row = within(await screen.findByRole('list')).getByRole('listitem')
    expect(within(row).getByText(`최개발님이 쪽지${action}`)).toBeDefined()
    expect(within(row).getByRole('link').getAttribute('href')).toBe(
      `/projects/${project.id}?version=${items[0].version!.id}`,
    )
  })
})

describe.each([
  { type: 'RESOLUTION_SUBMITTED', action: '에 고쳤어요를 보냈어요' },
  { type: 'ISSUE_VERIFIED', action: '를 확인 완료했어요' },
  { type: 'ISSUE_REOPENED', action: '를 다시 열었어요' },
  { type: 'ISSUE_WITHDRAWN', action: '를 철회했어요' },
] satisfies { type: ActivityItem['type']; action: string }[])('ActivityPage $type 기록', ({ type, action }) => {
  const issueId = 'a728f97e-4d83-49b2-b50d-38e72d3901c9'

  it.each([13, 14])('#%i 쪽지의 문장과 조사를 그대로 표시하고 그 쪽지로 연결한다', async (number) => {
    const event: ActivityItem = {
      ...items[0],
      type,
      actorName: '김수정',
      issue: { id: issueId, number },
      version: null,
    }
    responses.set(activityUrl, () => Response.json([event]))
    renderActivity()

    const row = within(await screen.findByRole('list')).getByRole('listitem')
    expect(row.querySelector('span')?.textContent).toBe(`김수정님이 #${number} 쪽지${action}`)
    expect(within(row).getByRole('link').getAttribute('href')).toBe(`/projects/${project.id}?issue=${issueId}`)
    expect(row.querySelector('time')?.getAttribute('datetime')).toBe(event.createdAt)
  })

  it.each(['/', '/app'])('basename %s에서 버전이 함께 있어도 쪽지를 연 검수실로 연결한다', async (basename) => {
    responses.set(activityUrl, () => Response.json([{ ...items[0], type, issue: { id: issueId, number: 14 } }]))
    renderActivity(activityPath, basename)

    const row = within(await screen.findByRole('list')).getByRole('listitem')
    expect(row.querySelector('span')?.textContent).toBe(`최개발님이 #14 쪽지${action}`)
    expect(within(row).getAllByRole('link')).toHaveLength(1)
    const prefix = basename === '/' ? '' : basename
    expect(within(row).getByRole('link').getAttribute('href')).toBe(`${prefix}/projects/${project.id}?issue=${issueId}`)
  })

  it('쪽지와 버전이 모두 null이면 번호 없는 문장을 링크 없이 표시한다', async () => {
    responses.set(activityUrl, () => Response.json([{ ...items[0], type, issue: null, version: null }]))
    renderActivity()

    const row = within(await screen.findByRole('list')).getByRole('listitem')
    expect(row.querySelector('span')?.textContent).toBe(`최개발님이 쪽지${action}`)
    expect(within(row).queryByRole('link')).toBeNull()
    expect(row.querySelector('time')?.getAttribute('datetime')).toBe(items[0].createdAt)
  })
})

describe('ActivityPage 고쳤어요와 확인 기록 순서', () => {
  it.each(['최신순', '같은 시각'])(
    '%s으로 받은 새 사건과 기존 사건을 서버 순서와 문장 그대로 표시한다',
    async (order) => {
      const events = (
        [
          {
            ...items[0],
            id: 'withdrawn',
            type: 'ISSUE_WITHDRAWN',
            actorName: '김수정',
            issue: { id: 'issue-14', number: 14 },
          },
          {
            ...items[0],
            id: 'verified',
            type: 'ISSUE_VERIFIED',
            actorName: '이승인',
            issue: { id: 'issue-13', number: 13 },
          },
          {
            ...items[0],
            id: 'reopened',
            type: 'ISSUE_REOPENED',
            actorName: '김수정',
            issue: { id: 'issue-13', number: 13 },
          },
          { ...items[0], id: 'submitted', type: 'RESOLUTION_SUBMITTED', issue: { id: 'issue-13', number: 13 } },
          { ...items[0], id: 'started', type: 'ISSUE_STARTED', issue: { id: 'issue-13', number: 13 } },
          {
            ...items[0],
            id: 'created',
            type: 'ISSUE_CREATED',
            actorName: '김수정',
            issue: { id: 'issue-13', number: 13 },
          },
          items[0],
        ] satisfies ActivityItem[]
      ).map((event, index) => ({
        ...event,
        createdAt: order === '같은 시각' ? items[0].createdAt : `2026-11-09T09:0${6 - index}:00.000Z`,
      }))
      responses.set(activityUrl, () => Response.json(events))
      renderActivity()

      const rows = within(await screen.findByRole('list')).getAllByRole('listitem')
      expect(rows.map((row) => row.querySelector('span')?.textContent)).toEqual([
        '김수정님이 #14 쪽지를 철회했어요',
        '이승인님이 #13 쪽지를 확인 완료했어요',
        '김수정님이 #13 쪽지를 다시 열었어요',
        '최개발님이 #13 쪽지에 고쳤어요를 보냈어요',
        '최개발님이 #13 쪽지 수정을 시작했어요',
        '김수정님이 #13 쪽지를 남겼어요',
        '최개발님이 2차를 게시했어요',
      ])
      expect(rows.map((row) => within(row).getByRole('link').getAttribute('href'))).toEqual([
        `/projects/${project.id}?issue=issue-14`,
        `/projects/${project.id}?issue=issue-13`,
        `/projects/${project.id}?issue=issue-13`,
        `/projects/${project.id}?issue=issue-13`,
        `/projects/${project.id}?issue=issue-13`,
        `/projects/${project.id}?issue=issue-13`,
        `/projects/${project.id}?version=${project.currentVersion!.id}`,
      ])
    },
  )
})

describe('ActivityPage 승인 기록', () => {
  it.each([
    { number: 0, message: '승인자님이 초안을 승인했어요' },
    { number: 1, message: '승인자님이 1차를 승인했어요' },
    { number: 2, message: '승인자님이 2차를 승인했어요' },
  ])('$number번 버전의 승인 문장과 그 버전을 여는 링크를 표시한다', async ({ number, message }) => {
    const event: ActivityItem = {
      ...items.find((item) => item.version?.number === number)!,
      type: 'VERSION_APPROVED',
      actorName: '승인자',
    }
    responses.set(activityUrl, () => Response.json([event]))
    renderActivity()

    const row = within(await screen.findByRole('list')).getByRole('listitem')
    expect(within(row).getByText(message, { exact: true })).toBeDefined()
    expect(within(row).getByRole('link').getAttribute('href')).toBe(
      `/projects/${project.id}?version=${event.version!.id}`,
    )
  })

  it('버전 없는 승인 기록은 번호 없는 문장과 시각을 링크 없이 표시한다', async () => {
    const event: ActivityItem = { ...items[0], type: 'VERSION_APPROVED', actorName: '승인자', version: null }
    responses.set(activityUrl, () => Response.json([event]))
    renderActivity()

    const row = within(await screen.findByRole('list')).getByRole('listitem')
    expect(within(row).getByText('승인자님이 버전을 승인했어요', { exact: true })).toBeDefined()
    expect(within(row).queryByRole('link')).toBeNull()
    expect(row.querySelector('time')?.getAttribute('datetime')).toBe(event.createdAt)
  })

  it('승인과 게시가 섞여 있어도 각 문장과 서버 순서, /app 아래 버전 링크를 유지한다', async () => {
    const events: ActivityItem[] = items.flatMap((item) => [
      { ...item, id: `approved-${item.id}`, type: 'VERSION_APPROVED', actorName: '승인자' },
      item,
    ])
    responses.set(activityUrl, () => Response.json(events))
    renderActivity(activityPath, '/app')

    const rows = within(await screen.findByRole('list')).getAllByRole('listitem')
    expect(rows.map((row) => row.querySelector('span')?.textContent)).toEqual([
      '승인자님이 2차를 승인했어요',
      '최개발님이 2차를 게시했어요',
      '승인자님이 1차를 승인했어요',
      '김개발님이 1차를 게시했어요',
      '승인자님이 초안을 승인했어요',
      '이개발님이 초안을 게시했어요',
    ])
    expect(rows.map((row) => within(row).getByRole('link').getAttribute('href'))).toEqual(
      events.map((event) => `/app/projects/${project.id}?version=${event.version!.id}`),
    )
  })
})

describe('ActivityPage 로그인과 불러오기', () => {
  it('로그인 확인 중에는 이미 받은 일지와 프로젝트 이름을 보여 주지 않는다', async () => {
    const pending = deferred<Response>()
    responses.set('/api/auth/me', () => pending.promise)
    renderActivity()
    await act(async () => {})

    expect(screen.getByText('확인하는 중이에요.')).toBeDefined()
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.queryByRole('heading', { name: `${project.name} 활동 일지` })).toBeNull()
    await act(async () => pending.resolve(Response.json(user)))
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
  })

  it('로그인 확인이 401이면 실제 로그인 화면으로 이동한다', async () => {
    responses.set('/api/auth/me', () => Response.json({}, { status: 401 }))
    renderActivity()

    expect(await screen.findByRole('heading', { name: '로그인' })).toBeDefined()
    expect(screen.getByLabelText('현재 주소').textContent).toBe('/login')
    expect(screen.queryByRole('list')).toBeNull()
  })

  it.each(['서버 오류', '연결 실패'])('로그인 확인의 %s는 현재 주소에서 안내한다', async (failure) => {
    responses.set('/api/auth/me', () => {
      if (failure === '연결 실패') throw new TypeError('Failed to fetch')
      return Response.json({}, { status: 500 })
    })
    renderActivity()

    expect(await screen.findByText('불러오지 못했어요. 잠시 뒤 새로고침해 주세요')).toBeDefined()
    expect(screen.getByLabelText('현재 주소').textContent).toBe(activityPath)
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.queryByRole('heading', { name: '로그인' })).toBeNull()
  })

  it.each([projectUrl, activityUrl])('%s 응답 전에는 빈 기록 안내 대신 불러오는 중이라고 표시한다', async (url) => {
    const pending = deferred<Response>()
    responses.set(url, () => pending.promise)
    renderActivity()

    expect(await screen.findByText('불러오는 중이에요.')).toBeDefined()
    expect(screen.queryByText('아직 기록이 없어요.')).toBeNull()
    expect(screen.queryByRole('list')).toBeNull()
    await act(async () => pending.resolve(Response.json(url === projectUrl ? project : items)))
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
  })

  it.each(['not-a-uuid', '123', 'ebf058f0-dc9e-4a14-adcd-cb2712594e5z'])(
    '틀린 id %s는 프로젝트·일지 요청 없이 없는 프로젝트로 안내한다',
    async (id) => {
      renderActivity(`/projects/${id}/activity`)

      expect(await screen.findByRole('heading', { name: '없는 프로젝트예요' })).toBeDefined()
      expect(fetchMock).toHaveBeenCalledExactlyOnceWith('/api/auth/me')
      expect(screen.getByRole('link', { name: '프로젝트 목록' }).getAttribute('href')).toBe('/')
      expect(screen.queryByRole('list')).toBeNull()
    },
  )
})

describe.each([
  { source: '프로젝트', url: projectUrl },
  { source: '활동 일지', url: activityUrl },
])('ActivityPage $source 오류', ({ url }) => {
  it('404이면 다른 응답이 성공해도 프로젝트 이름과 기록을 숨긴다', async () => {
    responses.set(url, () => Response.json({}, { status: 404 }))
    renderActivity()

    expect(await screen.findByRole('heading', { name: '없는 프로젝트예요' })).toBeDefined()
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.queryByRole('heading', { name: `${project.name} 활동 일지` })).toBeNull()
    expect(screen.queryByText('아직 기록이 없어요.')).toBeNull()
  })

  it('401이면 현재 주소에 만료 안내를 표시하고 다시 로그인 링크로 이동한다', async () => {
    responses.set(url, () => Response.json({}, { status: 401 }))
    renderActivity()

    expect((await screen.findByRole('alert')).textContent).toContain('로그인이 끝났어요')
    expect(screen.getByLabelText('현재 주소').textContent).toBe(activityPath)
    const login = screen.getByRole('link', { name: '다시 로그인하기' })
    expect(login.getAttribute('href')).toBe('/login')
    expect(screen.queryByRole('list')).toBeNull()
    fireEvent.click(login)
    expect(await screen.findByRole('heading', { name: '로그인' })).toBeDefined()
    expect(screen.getByLabelText('현재 주소').textContent).toBe('/login')
  })

  it.each([
    { status: 403, message: '잠시 뒤 다시 시도해 주세요' },
    { status: 500, message: '잠시 뒤 다시 시도해 주세요' },
    { status: 502, message: '잠시 뒤 다시 시도해 주세요' },
    { status: null, message: '연결을 확인하고 다시 시도해 주세요' },
  ])('$status 실패는 안내 문구를 표시한다', async ({ status, message }) => {
    responses.set(url, () => {
      if (status === null) throw new TypeError('Failed to fetch')
      if (status === 502) return new Response('Bad Gateway', { status })
      return Response.json({}, { status })
    })
    renderActivity()

    expect((await screen.findByRole('alert')).textContent).toBe(message)
    expect(screen.getByLabelText('현재 주소').textContent).toBe(activityPath)
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.queryByText('아직 기록이 없어요.')).toBeNull()
  })
})

describe('ActivityPage 프로젝트 이동', () => {
  it('다른 일지를 불러오는 동안 이전 프로젝트의 제목과 기록을 남기지 않는다', async () => {
    const pending = deferred<Response>()
    responses.set(`${nextProjectUrl}/activity`, () => pending.promise)
    renderActivity()
    await screen.findByRole('list')
    fireEvent.click(screen.getByRole('link', { name: '다른 프로젝트 일지로' }))

    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.queryByRole('heading', { name: `${project.name} 활동 일지` })).toBeNull()
    expect(await screen.findByText('불러오는 중이에요.')).toBeDefined()
    await act(async () => pending.resolve(Response.json([])))
    expect(screen.getByRole('heading', { name: `${nextProject.name} 활동 일지` })).toBeDefined()
    expect(screen.getByText('아직 기록이 없어요.')).toBeDefined()
    expect(screen.getByRole('link', { name: '검수실' }).getAttribute('href')).toBe(`/projects/${nextProject.id}`)
  })

  it.each(['성공', '404', '서버 오류'])('이전 일지의 늦은 %s 응답이 새 프로젝트를 덮지 않는다', async (result) => {
    const pending = deferred<Response>()
    responses.set(activityUrl, () => pending.promise)
    renderActivity()
    await screen.findByText('불러오는 중이에요.')
    fireEvent.click(screen.getByRole('link', { name: '다른 프로젝트 일지로' }))
    await screen.findByRole('heading', { name: `${nextProject.name} 활동 일지` })
    await act(async () => {
      pending.resolve(
        result === '성공' ? Response.json(items) : Response.json({}, { status: result === '404' ? 404 : 500 }),
      )
    })

    expect(screen.getByRole('heading', { name: `${nextProject.name} 활동 일지` })).toBeDefined()
    expect(screen.getByText('아직 기록이 없어요.')).toBeDefined()
    expect(screen.getByLabelText('현재 주소').textContent).toBe(nextActivityPath)
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.queryByRole('heading', { name: '없는 프로젝트예요' })).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each([401, 404, 500])('이전 프로젝트의 %s 오류가 다른 프로젝트에 남지 않는다', async (status) => {
    responses.set(activityUrl, () => Response.json({}, { status }))
    renderActivity()
    await screen.findByText(
      status === 404 ? '없는 프로젝트예요' : status === 401 ? /로그인이 끝났어요/ : '잠시 뒤 다시 시도해 주세요',
    )
    fireEvent.click(screen.getByRole('link', { name: '다른 프로젝트 일지로' }))

    expect(await screen.findByRole('heading', { name: `${nextProject.name} 활동 일지` })).toBeDefined()
    expect(screen.getByText('아직 기록이 없어요.')).toBeDefined()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('heading', { name: '없는 프로젝트예요' })).toBeNull()
  })
})
