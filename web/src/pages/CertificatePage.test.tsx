import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import App from '../App.tsx'
import { getMe, type Me } from '../api/auth.ts'
import { ApiError } from '../api/client.ts'
import { getCertificate, type Certificate } from '../api/versions.ts'
import { CertificatePage } from './CertificatePage.tsx'

vi.mock('../api/auth.ts', async () => {
  const actual = await vi.importActual<typeof import('../api/auth.ts')>('../api/auth.ts')
  return { ...actual, getMe: vi.fn() }
})

vi.mock('../api/versions.ts', async () => {
  const actual = await vi.importActual<typeof import('../api/versions.ts')>('../api/versions.ts')
  return { ...actual, getCertificate: vi.fn() }
})

const user: Me = {
  id: 'bab3067c-8f43-4946-988a-622764ee4d71',
  email: 'client@example.com',
  name: '홍승인',
  canCreateProjects: false,
}

const certificate: Certificate = {
  certificateNumber: 'a028a4a6-7db0-46a8-a6fe-04c3b02ca742',
  project: { id: '64d713f0-24df-47f3-97d4-d9c36d05f061', name: '쇼핑몰 리뉴얼' },
  version: {
    id: '731a8b91-4dba-40f6-b83a-49987854261b',
    number: 1,
    publishedAt: '2026-11-10T16:05:00.000Z',
  },
  approval: { approverName: '홍승인', approvedAt: '2026-11-13T06:10:22.123Z' },
  developerName: '김개발',
  screens: [
    { name: '홈', viewport: 'PC' },
    { name: '결제', viewport: 'MOBILE' },
  ],
  counts: { verified: 1, withdrawn: 1, outOfScope: 2 },
  // 서버가 보장하는 번호 순서. 범위가 번갈아 나오고 두 자리 번호도 있다.
  issues: [
    { number: 1, title: '버튼 색', category: 'BUG', scope: 'IN_SCOPE', status: 'VERIFIED' },
    { number: 2, title: '배너 추가', category: 'DESIGN', scope: 'OUT_OF_SCOPE', status: 'OPEN' },
    { number: 10, title: '안내 문장', category: 'COPY', scope: 'IN_SCOPE', status: 'WITHDRAWN' },
    { number: 11, title: '추가 요청', category: 'OTHER', scope: 'OUT_OF_SCOPE', status: 'IN_PROGRESS' },
  ],
}

const renderCertificate = (id = certificate.version.id, basename = '/') => {
  const prefix = basename === '/' ? '' : basename
  return render(
    <MemoryRouter basename={basename} initialEntries={[`${prefix}/versions/${id}/certificate`]}>
      <Routes>
        <Route path="/versions/:id/certificate" element={<CertificatePage />} />
        <Route path="/login" element={<h1>로그인</h1>} />
        <Route path="/" element={<h1>내 프로젝트</h1>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.mocked(getMe).mockReset().mockResolvedValue(user)
  vi.mocked(getCertificate).mockReset().mockResolvedValue(structuredClone(certificate))
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('CertificatePage', () => {
  it('확인서 번호, 정보 목록, 화면 순서와 개수, 쪽지 수, 승인 당시 내용 안내를 보여 준다', async () => {
    renderCertificate()

    expect(await screen.findByRole('heading', { level: 1, name: '검수 확인서' })).toBeDefined()
    expect(getCertificate).toHaveBeenCalledExactlyOnceWith(certificate.version.id)
    expect(screen.getByText(`확인서 번호 ${certificate.certificateNumber}`)).toBeDefined()
    const facts = screen.getAllByRole('definition').map((item) => item.textContent)
    expect(screen.getAllByRole('term').map((item) => item.textContent)).toEqual([
      '프로젝트',
      '버전',
      '게시 시각',
      '승인 시각',
      '승인자',
      '개발자',
    ])
    const kst = new Intl.DateTimeFormat('ko-KR', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Asia/Seoul',
    })
    expect(facts).toEqual([
      '쇼핑몰 리뉴얼',
      '1차',
      kst.format(new Date(certificate.version.publishedAt)),
      kst.format(new Date(certificate.approval.approvedAt)),
      '홍승인',
      '김개발',
    ])
    expect(screen.getByRole('heading', { name: '검수한 화면 2개' })).toBeDefined()
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual(['홈 · PC', '결제 · 모바일'])
    expect(screen.getByText('확인 완료 1건 · 철회 1건 · 범위 밖(추가 요청) 2건')).toBeDefined()
    expect(
      screen.getByText('이 확인서는 승인한 때의 내용이에요. 그 뒤에 쪽지가 바뀌어도 달라지지 않아요.'),
    ).toBeDefined()
    expect(screen.getByText('시각은 한국 표준시(KST) 기준이에요')).toBeDefined()
  })

  it.each([
    { number: 0, text: '초안을' },
    { number: 1, text: '1차를' },
    { number: 2, text: '2차를' },
  ])('$number번 버전은 승인 문장에 $text이라고 적는다', async ({ number, text }) => {
    vi.mocked(getCertificate).mockResolvedValueOnce({ ...certificate, version: { ...certificate.version, number } })
    renderCertificate()

    expect(await screen.findByText(`홍승인님이 쇼핑몰 리뉴얼의 ${text} 승인했어요.`)).toBeDefined()
  })

  it('범위 안과 밖을 두 목록으로 나누고 번호 순서와 분류·상태를 글자로 보여 주며 범위 칸은 두지 않는다', async () => {
    renderCertificate()
    await screen.findByRole('heading', { name: '이번 범위의 쪽지 2건' })
    expect(screen.getByRole('heading', { name: '범위 밖(추가 요청) 쪽지 2건' })).toBeDefined()
    const tables = screen.getAllByRole('table')
    expect(tables).toHaveLength(2)
    const rows = tables.map((table) =>
      within(table)
        .getAllByRole('row')
        .slice(1)
        .map((row) =>
          within(row)
            .getAllByRole('cell')
            .map((cell) => cell.textContent),
        ),
    )
    expect(rows).toEqual([
      [
        ['#1', '버튼 색', '버그', '확인 완료'],
        ['#10', '안내 문장', '문구', '철회'],
      ],
      [
        ['#2', '배너 추가', '디자인', '접수'],
        ['#11', '추가 요청', '기타', '수정 중'],
      ],
    ])
    for (const table of tables) {
      expect(
        within(table)
          .getAllByRole('columnheader')
          .map((cell) => cell.textContent),
      ).toEqual(['번호', '제목', '분류', '상태'])
    }
    expect(screen.queryByRole('columnheader', { name: '범위' })).toBeNull()
  })

  it.each([
    { scope: 'IN_SCOPE', message: '범위 밖 쪽지가 없어요', counts: { verified: 1, withdrawn: 1, outOfScope: 0 } },
    {
      scope: 'OUT_OF_SCOPE',
      message: '이번 범위의 쪽지가 없어요',
      counts: { verified: 0, withdrawn: 0, outOfScope: 2 },
    },
  ])('$scope 쪽지만 있으면 빈 목록 자리에 $message를 보여 준다', async ({ scope, message, counts }) => {
    vi.mocked(getCertificate).mockResolvedValueOnce({
      ...certificate,
      counts,
      issues: certificate.issues.filter((issue) => issue.scope === scope),
    })
    renderCertificate()

    expect(await screen.findByText(message)).toBeDefined()
    expect(screen.getAllByRole('table')).toHaveLength(1)
    expect(screen.queryByText('이 버전에는 쪽지가 없었어요')).toBeNull()
  })

  it('쪽지가 0개면 수는 모두 0이고 빈 테이블 대신 쪽지가 없었다고 알린다', async () => {
    vi.mocked(getCertificate).mockResolvedValueOnce({
      ...certificate,
      issues: [],
      counts: { verified: 0, withdrawn: 0, outOfScope: 0 },
    })
    renderCertificate()

    expect(await screen.findByText('이 버전에는 쪽지가 없었어요')).toBeDefined()
    expect(screen.getByText('확인 완료 0건 · 철회 0건 · 범위 밖(추가 요청) 0건')).toBeDefined()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it.each([
    { reason: '404', id: certificate.version.id },
    { reason: 'UUID가 아닌 id', id: 'not-a-uuid' },
  ])('$reason이면 없는 확인서 안내와 프로젝트 목록 링크를 보여 준다', async ({ id }) => {
    vi.mocked(getCertificate).mockRejectedValueOnce(new ApiError(404))
    renderCertificate(id)

    expect(await screen.findByRole('heading', { name: '없는 확인서예요' })).toBeDefined()
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.queryByRole('button', { name: 'PDF로 저장' })).toBeNull()
    const link = screen.getByRole('link', { name: '프로젝트 목록' })
    expect(link.getAttribute('href')).toBe('/')
    fireEvent.click(link)
    expect(await screen.findByRole('heading', { name: '내 프로젝트' })).toBeDefined()
  })

  it('확인서 요청의 401이면 로그인 안내와 다시 로그인하기 링크를 보여 준다', async () => {
    vi.mocked(getCertificate).mockRejectedValueOnce(new ApiError(401))
    renderCertificate()

    expect((await screen.findByRole('alert')).textContent).toContain('로그인이 끝났어요. 다시 로그인해 주세요')
    const link = screen.getByRole('link', { name: '다시 로그인하기' })
    expect(link.getAttribute('href')).toBe('/login')
    expect(screen.queryByRole('heading', { name: '검수 확인서' })).toBeNull()
    fireEvent.click(link)
    expect(await screen.findByRole('heading', { name: '로그인' })).toBeDefined()
  })

  it.each([
    { error: new TypeError('Failed to fetch'), message: '연결을 확인하고 다시 시도해 주세요' },
    { error: new ApiError(500), message: '잠시 뒤 다시 시도해 주세요' },
  ])('불러오기 실패는 $message라고 알린다', async ({ error, message }) => {
    vi.mocked(getCertificate).mockRejectedValueOnce(error)
    renderCertificate()

    expect((await screen.findByRole('alert')).textContent).toBe(message)
    expect(screen.queryByRole('heading', { name: '없는 확인서예요' })).toBeNull()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('로그인하지 않았으면 확인서 대신 로그인 화면으로 이동한다', async () => {
    vi.mocked(getMe).mockResolvedValueOnce(null)
    renderCertificate()

    expect(await screen.findByRole('heading', { name: '로그인' })).toBeDefined()
    expect(screen.queryByRole('heading', { name: '검수 확인서' })).toBeNull()
  })

  it('로그인 확인의 연결 실패를 로그아웃으로 판단하지 않는다', async () => {
    vi.mocked(getMe).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    renderCertificate()

    expect(await screen.findByText('불러오지 못했어요. 잠시 뒤 새로고침해 주세요')).toBeDefined()
    expect(screen.queryByRole('heading', { name: '로그인' })).toBeNull()
    expect(screen.queryByRole('heading', { name: '검수 확인서' })).toBeNull()
  })

  it('PDF로 저장을 누르면 브라우저 인쇄를 한 번 부르고 저장 방법을 안내한다', async () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined)
    renderCertificate()

    const button = await screen.findByRole('button', { name: 'PDF로 저장' })
    expect(print).not.toHaveBeenCalled()
    expect(screen.getByText("인쇄 창에서 'PDF로 저장'을 고르면 돼요")).toBeDefined()
    fireEvent.click(button)
    expect(print).toHaveBeenCalledExactlyOnceWith()
  })

  it.each(['/', '/app'])('basename %s에서 돌아가기 링크는 확인서의 프로젝트와 버전을 가리킨다', async (basename) => {
    renderCertificate(certificate.version.id, basename)

    const link = await screen.findByRole('link', { name: '검수실로 돌아가기' })
    const prefix = basename === '/' ? '' : basename
    expect(link.getAttribute('href')).toBe(
      `${prefix}/projects/${certificate.project.id}?version=${certificate.version.id}`,
    )
  })

  it('게시·승인 시각은 보는 사람의 기본 시간대 대신 Asia/Seoul 기준으로 표시한다', async () => {
    renderCertificate()
    await screen.findByRole('heading', { name: '검수 확인서' })
    const kst = new Intl.DateTimeFormat('ko-KR', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Asia/Seoul',
    })
    const overseas = new Intl.DateTimeFormat('ko-KR', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'America/Los_Angeles',
    })
    for (const iso of [certificate.version.publishedAt, certificate.approval.approvedAt]) {
      expect(screen.getByText(kst.format(new Date(iso)))).toBeDefined()
      expect(screen.queryByText(overseas.format(new Date(iso)))).toBeNull()
    }
  })

  it('쪽지 제목의 HTML을 요소로 만들지 않고 글자 그대로 보여 준다', async () => {
    const title = '<img src=x onerror="alert(1)"><b>추가 요청</b>'
    vi.mocked(getCertificate).mockResolvedValueOnce({
      ...certificate,
      issues: [{ ...certificate.issues[0], title }],
      counts: { verified: 1, withdrawn: 0, outOfScope: 0 },
    })
    renderCertificate()

    const cell = await screen.findByRole('cell', { name: title })
    expect(cell.textContent).toBe(title)
    expect(cell.children).toHaveLength(0)
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('실제 App의 /app/versions/:id/certificate 주소로 확인서가 열린다', async () => {
    render(
      <MemoryRouter basename="/app" initialEntries={[`/app/versions/${certificate.version.id}/certificate`]}>
        <App />
      </MemoryRouter>,
    )

    expect(await screen.findByRole('heading', { name: '검수 확인서' })).toBeDefined()
    expect(getCertificate).toHaveBeenCalledExactlyOnceWith(certificate.version.id)
  })
})
