import { apiDelete, apiGet, apiPatch, apiPost, apiPostForm } from './client.ts'
import { screenLabel, type Viewport } from './projects.ts'
import { versionLabel } from './versions.ts'

// 접수 → 수정 중 → 확인 요청 → 확인 완료. 철회는 끝나기 전 어디서든 되고, 끝난 쪽지를 다시 열면 접수로 돌아간다.
export type IssueStatus = 'OPEN' | 'IN_PROGRESS' | 'READY_FOR_REVIEW' | 'VERIFIED' | 'WITHDRAWN'

// 적은 순서가 상태 필터의 선택지 순서다.
export const ISSUE_STATUS_LABELS: Record<IssueStatus, string> = {
  OPEN: '접수',
  IN_PROGRESS: '수정 중',
  READY_FOR_REVIEW: '확인 요청',
  VERIFIED: '확인 완료',
  WITHDRAWN: '철회',
}

// 아직 끝나지 않은 상태. 확인 완료와 철회는 끝난 것이라 넣지 않는다.
const UNRESOLVED: IssueStatus[] = ['OPEN', 'IN_PROGRESS', 'READY_FOR_REVIEW']
export const isUnresolved = (status: IssueStatus) => UNRESOLVED.includes(status)

export type IssueCategory = 'BUG' | 'DESIGN' | 'COPY' | 'OTHER'
// 하자 수정(계약 안)인지 추가 요청(계약 밖)인지. 개발자만 바꾼다.
export type IssueScope = 'IN_SCOPE' | 'OUT_OF_SCOPE'

export const ISSUE_CATEGORY_LABELS: Record<IssueCategory, string> = {
  BUG: '버그',
  DESIGN: '디자인',
  COPY: '문구',
  OTHER: '기타',
}
export const ISSUE_SCOPE_LABELS: Record<IssueScope, string> = { IN_SCOPE: '하자 수정', OUT_OF_SCOPE: '추가 요청' }

// 핀이 꽂힌 자리. 비율은 사진 가로·세로에 대한 0~1 값이라, 사진이 줄거나 커져도 같은 자리다.
export type IssuePin = {
  screenId: string
  screenName: string
  viewport: Viewport
  asset: { id: string; width: number; height: number }
  xRatio: number
  yRatio: number
}

// originVersion은 쪽지를 쓸 때의 현재 버전이고 늘 있다. origin은 위치 없는 쪽지면 null이다.
export type IssueSummary = {
  id: string
  number: number
  title: string
  status: IssueStatus
  category: IssueCategory
  scope: IssueScope
  // "YYYY-MM-DD" 글자. 시각이 없는 날짜라서 Date로 바꾸지 않고 글자 그대로 다룬다.
  dueDate: string | null
  authorName: string
  createdAt: string
  commentCount: number
  originVersion: { id: string; number: number }
  origin: IssuePin | null
}

// versionNumber는 댓글을 쓸 때의 현재 버전 번호다.
export type IssueComment = { id: string; authorName: string; versionNumber: number; body: string; createdAt: string }
export type IssueAttachment = { id: string; assetId: string; width: number; height: number }

export type ResolutionResult = 'VERIFIED' | 'REOPENED'

// 고쳤어요 한 번이 한 줄이다. versionId·versionNumber는 보낼 때의 현재 버전이다.
// screen은 고친 결과를 볼 수 있는 화면이고, 위치 없는 쪽지의 고쳤어요는 null일 수 있다.
// 새 버전 게시나 철회로 답을 받지 못한 줄은 result·reviewedByName·reviewedAt이 null로 남는다.
export type IssueAttempt = {
  id: string
  versionId: string
  versionNumber: number
  screen: Omit<IssuePin, 'xRatio' | 'yRatio'> | null
  summary: string
  submittedByName: string
  createdAt: string
  result: ResolutionResult | null
  reviewedByName: string | null
  reviewedAt: string | null
}

export const RESOLUTION_RESULT_LABELS: Record<ResolutionResult, string> = { VERIFIED: '확인 완료', REOPENED: '재요청' }

export type IssueDetail = IssueSummary & {
  projectId: string
  body: string
  isMine: boolean
  // 내가 이 쪽지를 확인 완료·재요청·철회·다시 열기 할 수 있는 사람인가(쓴 클라이언트이거나 승인자). 쪽지 상태와는 상관없다.
  canReview: boolean
  attachments: IssueAttachment[]
  comments: IssueComment[]
  // 오래된 순.
  attempts: IssueAttempt[]
}

// 쪽지가 처음 남겨진 자리. 예: "초안 · 상품 상세 · PC", "2차 · 위치 없음". 목록과 상세가 같은 글자로 보여 준다.
export const originLabel = ({ originVersion, origin }: Pick<IssueSummary, 'originVersion' | 'origin'>) => {
  const place = origin ? screenLabel({ name: origin.screenName, viewport: origin.viewport }) : '위치 없음'
  return `${versionLabel(originVersion.number)} · ${place}`
}

// 보는 사람 컴퓨터의 오늘 날짜를 마감일과 같은 "YYYY-MM-DD" 글자로 만든다.
const todayText = () => {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

// 마감일이 오늘보다 앞이고 쪽지가 아직 끝나지 않았을 때다. 마감일 당일은 지남이 아니다.
// 글자끼리 비교한다. Date로 바꾸면 시간대 때문에 하루가 밀린다.
export const isOverdue = ({ dueDate, status }: Pick<IssueSummary, 'dueDate' | 'status'>) =>
  dueDate !== null && isUnresolved(status) && dueDate < todayText()

// "11월 15일"처럼 보여 주고, 올해가 아니면 해를 붙인다("2027년 1월 5일").
export const dueDateLabel = (dueDate: string) => {
  const [year, month, day] = dueDate.split('-').map(Number)
  const monthDay = `${month}월 ${day}일`
  return year === new Date().getFullYear() ? monthDay : `${year}년 ${monthDay}`
}

// 쪽지 목록을 골라 보는 조건(검수실의 필터). 서버를 부르지 않지만 여기에 둔다. 필터 부품 파일(IssueFilters.tsx)이
// 부품이 아닌 것을 함께 내보내면, 개발 서버가 그 파일을 고칠 때 화면을 통째로 새로 불러온다(린트 경고).
// 화면 필터에서 "위치 없음"을 고른 값. 화면 id(UUID)와 겹치지 않는다.
export const NO_PLACE = 'none'

// 빈 글자('')는 "전체"다. screenId는 쪽지가 시작한 화면의 id이거나 NO_PLACE다.
export type IssueFilter = {
  status: IssueStatus | ''
  screenId: string
  category: IssueCategory | ''
  scope: IssueScope | ''
  overdueOnly: boolean
}

export const NO_FILTER: IssueFilter = { status: '', screenId: '', category: '', scope: '', overdueOnly: false }

// 고른 조건의 수. 고르지 않은 값('', false)은 세지 않는다.
export const countFilters = ({ status, screenId, category, scope, overdueOnly }: IssueFilter) =>
  [status, screenId, category, scope, overdueOnly].filter(Boolean).length

// 고른 조건을 모두 만족하는 쪽지만 남긴다. 서버에 다시 묻지 않고 받아 둔 목록에서 거른다.
// 조건마다 "골랐는데 맞지 않으면 뺀다"를 차례로 본다. 고르지 않은 조건('')은 건너뛴다.
export const filterIssues = (issues: IssueSummary[], filter: IssueFilter) =>
  issues.filter((issue) => {
    if (filter.status !== '' && issue.status !== filter.status) return false
    const place = issue.origin ? issue.origin.screenId : NO_PLACE
    if (filter.screenId !== '' && place !== filter.screenId) return false
    if (filter.category !== '' && issue.category !== filter.category) return false
    if (filter.scope !== '' && issue.scope !== filter.scope) return false
    if (filter.overdueOnly && !isOverdue(issue)) return false
    return true
  })

// requestId는 쓰기 칸을 열 때 만든 번호다. 실패해서 다시 보낼 때도 같은 번호를 써야 쪽지가 하나만 생긴다.
// versionId는 보고 있던 버전이다. 그사이 새 버전이 게시됐으면 서버가 409(VERSION_CHANGED)로 답한다.
export type NewIssue = {
  requestId: string
  versionId: string
  title: string
  body: string
  // 없으면 서버가 버그로 저장한다.
  category?: IssueCategory
  pin?: { screenId: string; xRatio: number; yRatio: number }
}
export type NewComment = { requestId: string; versionId: string; body: string }
// 보낸 칸만 바뀐다. dueDate의 null은 마감일을 지운다는 뜻이다.
export type IssueChange = { category?: IssueCategory; scope?: IssueScope; dueDate?: string | null }
// 아래 네 요청의 versionId도 보고 있던 버전이다. screenId는 고친 결과를 볼 수 있는 화면이고, 핀이 있는 쪽지는 꼭 보낸다.
export type NewResolution = { versionId: string; summary: string; screenId?: string }
// attemptId는 보고 있던 고쳤어요 줄이다. 그사이 새 고쳤어요가 왔으면 서버가 409(ATTEMPT_CHANGED)로 답한다.
export type Verification = { versionId: string; attemptId: string }
// attemptId가 있으면 확인 요청을 돌려보내는 "재요청"이고, 없으면 끝난 쪽지(확인 완료·철회)를 "다시 열기"다.
export type Reopening = { versionId: string; reason: string; attemptId?: string }
export type Withdrawal = { versionId: string; reason: string }

// 주소 속 id는 projects.ts와 같은 이유로 encodeURIComponent로 감싼다.
export const listIssues = async (projectId: string): Promise<IssueSummary[]> => {
  const response = await apiGet(`/projects/${encodeURIComponent(projectId)}/issues`)
  return response.json()
}

export const getIssue = async (issueId: string): Promise<IssueDetail> => {
  const response = await apiGet(`/issues/${encodeURIComponent(issueId)}`)
  return response.json()
}

// 서버는 핀의 세 칸을 본문에 바로 받는다(셋 다 있거나 셋 다 없다).
export const createIssue = async (projectId: string, { pin, ...issue }: NewIssue): Promise<IssueDetail> => {
  const response = await apiPost(`/projects/${encodeURIComponent(projectId)}/issues`, { ...issue, ...pin })
  return response.json()
}

export const createComment = async (issueId: string, comment: NewComment): Promise<IssueComment> => {
  const response = await apiPost(`/issues/${encodeURIComponent(issueId)}/comments`, comment)
  return response.json()
}

export const startIssue = async (issueId: string, versionId: string): Promise<IssueDetail> => {
  const response = await apiPost(`/issues/${encodeURIComponent(issueId)}/start`, { versionId })
  return response.json()
}

// 범위나 마감일을 바꾸면 서버가 자동 댓글이 든 쪽지 상세를 돌려준다.
export const updateIssue = async (issueId: string, versionId: string, change: IssueChange): Promise<IssueDetail> => {
  const response = await apiPatch(`/issues/${encodeURIComponent(issueId)}`, { versionId, ...change })
  return response.json()
}

// 아래 네 요청은 서버가 바뀐 쪽지 상세(상태, 고쳤어요 이력, 사유 댓글)를 돌려준다.
export const submitResolution = async (issueId: string, resolution: NewResolution): Promise<IssueDetail> => {
  const response = await apiPost(`/issues/${encodeURIComponent(issueId)}/submit-resolution`, resolution)
  return response.json()
}

export const verifyIssue = async (issueId: string, verification: Verification): Promise<IssueDetail> => {
  const response = await apiPost(`/issues/${encodeURIComponent(issueId)}/verify`, verification)
  return response.json()
}

export const reopenIssue = async (issueId: string, reopening: Reopening): Promise<IssueDetail> => {
  const response = await apiPost(`/issues/${encodeURIComponent(issueId)}/reopen`, reopening)
  return response.json()
}

export const withdrawIssue = async (issueId: string, withdrawal: Withdrawal): Promise<IssueDetail> => {
  const response = await apiPost(`/issues/${encodeURIComponent(issueId)}/withdraw`, withdrawal)
  return response.json()
}

// 서버는 'file' 칸의 사진 한 장만 받는다.
export const attachIssuePhoto = async (issueId: string, file: File): Promise<IssueDetail> => {
  const form = new FormData()
  form.append('file', file)
  const response = await apiPostForm(`/issues/${encodeURIComponent(issueId)}/attachments`, form)
  return response.json()
}

// 서버는 그 사진이 빠진 쪽지 상세를 돌려준다.
export const removeIssuePhoto = async (issueId: string, attachmentId: string): Promise<IssueDetail> => {
  const response = await apiDelete(
    `/issues/${encodeURIComponent(issueId)}/attachments/${encodeURIComponent(attachmentId)}`,
  )
  return response.json()
}
