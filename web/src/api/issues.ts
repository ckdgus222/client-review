import { apiDelete, apiGet, apiPost, apiPostForm } from './client.ts'
import { screenLabel, type Viewport } from './projects.ts'
import { versionLabel } from './versions.ts'

// 확인 요청·확인 완료·철회는 6번 기능에서 생긴다.
export type IssueStatus = 'OPEN' | 'IN_PROGRESS'

export const ISSUE_STATUS_LABELS: Record<IssueStatus, string> = { OPEN: '접수', IN_PROGRESS: '수정 중' }

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
  authorName: string
  createdAt: string
  commentCount: number
  originVersion: { id: string; number: number }
  origin: IssuePin | null
}

// versionNumber는 댓글을 쓸 때의 현재 버전 번호다.
export type IssueComment = { id: string; authorName: string; versionNumber: number; body: string; createdAt: string }
export type IssueAttachment = { id: string; assetId: string; width: number; height: number }

export type IssueDetail = IssueSummary & {
  body: string
  isMine: boolean
  attachments: IssueAttachment[]
  comments: IssueComment[]
}

// 쪽지가 처음 남겨진 자리. 예: "초안 · 상품 상세 · PC", "2차 · 위치 없음". 목록과 상세가 같은 글자로 보여 준다.
export const originLabel = ({ originVersion, origin }: Pick<IssueSummary, 'originVersion' | 'origin'>) => {
  const place = origin ? screenLabel({ name: origin.screenName, viewport: origin.viewport }) : '위치 없음'
  return `${versionLabel(originVersion.number)} · ${place}`
}

// requestId는 쓰기 칸을 열 때 만든 번호다. 실패해서 다시 보낼 때도 같은 번호를 써야 쪽지가 하나만 생긴다.
// versionId는 보고 있던 버전이다. 그사이 새 버전이 게시됐으면 서버가 409(VERSION_CHANGED)로 답한다.
export type NewIssue = {
  requestId: string
  versionId: string
  title: string
  body: string
  pin?: { screenId: string; xRatio: number; yRatio: number }
}
export type NewComment = { requestId: string; versionId: string; body: string }

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
