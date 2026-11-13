import { apiDelete, apiGet, apiPatch, apiPost, apiPutForm } from './client.ts'
import type { IssueCategory, IssueScope, IssueStatus } from './issues.ts'
import type { Viewport } from './projects.ts'

export type VersionStatus = 'DRAFT' | 'IN_REVIEW' | 'APPROVED'

// 게시 전 버전은 아직 번호와 게시 시각이 없다. 번호 0은 "초안", 1부터는 "1차"·"2차"로 부른다.
export type VersionSummary = { id: string; number: number | null; status: VersionStatus; publishedAt: string | null }

export type VersionScreen = {
  screenId: string
  name: string
  viewport: Viewport
  hiddenAt: string | null
  asset: { id: string; width: number; height: number }
}

export type VersionDetail = VersionSummary & {
  projectId: string
  summary: string
  testUrl: string | null
  // 승인된 버전이면 누가 언제 승인했는지. 승인 전에는 null이다.
  approval: { approverName: string; approvedAt: string } | null
  screens: VersionScreen[]
}

export type ApprovalCheckIssue = { id: string; number: number; title: string; status: IssueStatus }

// 승인자가 승인하기 전에 보는 것(승인 검토).
export type ApprovalCheck = {
  // 서버가 이 목록을 읽은 때의 시각이다(마이크로초까지). 화면은 읽거나 고치지 않고 승인 요청에 그대로 돌려보낸다.
  // Date로 바꾸면 밀리초까지만 남아서, 같은 밀리초에 달린 댓글을 서버가 가려내지 못한다.
  serverTime: string
  // 범위 안의 끝나지 않은 쪽지. 하나라도 있으면 승인할 수 없다.
  unresolved: ApprovalCheckIssue[]
  // 범위 밖(추가 요청)의 끝나지 않은 쪽지. 승인을 막지 않는다.
  outOfScope: ApprovalCheckIssue[]
  // 이번 버전에 달린 댓글, 오래된 순.
  comments: {
    id: string
    issueId: string
    issueNumber: number
    issueTitle: string
    authorName: string
    body: string
    createdAt: string
  }[]
}

// 승인된 버전의 검수 확인서. issues는 승인한 때 저장한 쪽지 목록(번호 순)이라 그 뒤에 쪽지가 바뀌어도 그대로다.
// counts는 서버가 센다: 범위 안의 확인 완료·철회, 범위 밖 전부.
export type Certificate = {
  certificateNumber: string
  project: { id: string; name: string }
  version: { id: string; number: number; publishedAt: string }
  approval: { approverName: string; approvedAt: string }
  developerName: string
  screens: { name: string; viewport: Viewport }[]
  counts: { verified: number; withdrawn: number; outOfScope: number }
  issues: { number: number; title: string; category: IssueCategory; scope: IssueScope; status: IssueStatus }[]
}

// 일지는 게시된 버전만 가리켜서 번호가 늘 있다.
// memberName은 초대 수락·접근 철회·승인자 변경의 대상 사람이다. 대상이 없는 사건(게시, 승인, 초대)은 null이다.
// issue는 쪽지 사건(작성, 수정 시작, 고쳤어요, 확인 완료, 다시 열기, 철회)의 대상 쪽지다. 다른 사건은 null이다.
export type ActivityItem = {
  id: string
  type:
    | 'VERSION_PUBLISHED'
    | 'INVITATION_CREATED'
    | 'INVITATION_ACCEPTED'
    | 'MEMBER_REVOKED'
    | 'APPROVER_CHANGED'
    | 'ISSUE_CREATED'
    | 'ISSUE_STARTED'
    | 'RESOLUTION_SUBMITTED'
    | 'ISSUE_VERIFIED'
    | 'ISSUE_REOPENED'
    | 'ISSUE_WITHDRAWN'
    | 'VERSION_APPROVED'
  createdAt: string
  actorName: string
  version: { id: string; number: number } | null
  memberName: string | null
  issue: { id: string; number: number } | null
}

// testUrl에 빈 글을 보내면 서버가 주소를 지운다.
export type DraftChanges = { summary?: string; testUrl?: string }

// 주소 속 id는 projects.ts와 같은 이유로 encodeURIComponent로 감싼다.
export const listVersions = async (projectId: string): Promise<VersionSummary[]> => {
  const response = await apiGet(`/projects/${encodeURIComponent(projectId)}/versions`)
  return response.json()
}

export const getVersion = async (versionId: string): Promise<VersionDetail> => {
  const response = await apiGet(`/versions/${encodeURIComponent(versionId)}`)
  return response.json()
}

export const createDraft = async (projectId: string): Promise<VersionDetail> => {
  const response = await apiPost(`/projects/${encodeURIComponent(projectId)}/versions`)
  return response.json()
}

export const updateDraft = async (versionId: string, changes: DraftChanges): Promise<VersionDetail> => {
  const response = await apiPatch(`/versions/${encodeURIComponent(versionId)}`, changes)
  return response.json()
}

// 서버는 'file' 칸의 사진 한 장만 받는다.
export const putScreenPhoto = async (versionId: string, screenId: string, file: File): Promise<VersionDetail> => {
  const form = new FormData()
  form.append('file', file)
  const response = await apiPutForm(
    `/versions/${encodeURIComponent(versionId)}/screens/${encodeURIComponent(screenId)}/asset`,
    form,
  )
  return response.json()
}

export const removeDraftScreen = async (versionId: string, screenId: string): Promise<VersionDetail> => {
  const response = await apiDelete(`/versions/${encodeURIComponent(versionId)}/screens/${encodeURIComponent(screenId)}`)
  return response.json()
}

export const publishVersion = async (versionId: string): Promise<VersionDetail> => {
  const response = await apiPost(`/versions/${encodeURIComponent(versionId)}/publish`)
  return response.json()
}

export const getApprovalCheck = async (versionId: string): Promise<ApprovalCheck> => {
  const response = await apiGet(`/versions/${encodeURIComponent(versionId)}/approval-check`)
  return response.json()
}

// 승인 요청이 응답을 기다리는 한도. 승인 검토는 위에 뜨는 창이라, 응답이 끝내 오지 않으면 창도 못 닫고 뒤 화면도 못 누른다.
export const APPROVE_WAIT_MS = 30_000

// seenAt은 승인 검토가 준 serverTime 그대로다. 한도가 지나면 요청을 끊어서 실패로 끝낸다.
// 끊긴 요청도 서버에서는 저장됐을 수 있어서, 부르는 쪽은 "승인됐는지 모른다"로 다룬다.
export const approveVersion = async (versionId: string, seenAt: string): Promise<VersionDetail> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), APPROVE_WAIT_MS)
  try {
    const path = `/versions/${encodeURIComponent(versionId)}/approve`
    const response = await apiPost(path, { seenAt }, controller.signal)
    // 본문을 다 읽을 때까지가 한 요청이다. 여기서 기다리지 않고 돌려주면 본문을 읽기 전에 시계가 꺼진다.
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

// 승인되지 않은 버전, 없는 버전, 멤버가 아닌 사람에게는 서버가 모두 404 "없는 확인서예요"로 답한다.
export const getCertificate = async (versionId: string): Promise<Certificate> => {
  const response = await apiGet(`/versions/${encodeURIComponent(versionId)}/certificate`)
  return response.json()
}

export const listActivity = async (projectId: string): Promise<ActivityItem[]> => {
  const response = await apiGet(`/projects/${encodeURIComponent(projectId)}/activity`)
  return response.json()
}

// 버전 이름은 모든 화면이 이 함수로만 만든다. 부르는 쪽에서 `if (number)`로 확인하면 0(초안)이 거짓이라
// 번호 없는 버전처럼 보이니, 번호가 있는지는 `number !== null`로 본다.
export const versionLabel = (number: number) => (number === 0 ? '초안' : `${number}차`)

// 서버는 UTC 시각을 보내고, 화면에는 보는 사람 컴퓨터의 시간대로 "2026. 11. 9. 오후 3:04"처럼 보인다.
// 활동 일지와 검수실이 같은 모양으로 보이게 함께 쓴다.
export const timeFormat = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' })

// 요청하지 않고 주소만 만든다. <img src>에 넣으면 브라우저가 쿠키를 붙여 받고, 바뀌지 않은 사진은 다시 받지 않는다.
export const assetUrl = (assetId: string) => `/api/assets/${encodeURIComponent(assetId)}`
