import { apiDelete, apiGet, apiPatch, apiPost, apiPutForm } from './client.ts'
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
  screens: VersionScreen[]
}

// 일지는 게시된 버전만 가리켜서 번호가 늘 있다.
// memberName은 초대 수락·접근 철회·승인자 변경의 대상 사람이다. 대상이 없는 사건(게시, 초대)은 null이다.
// issue는 쪽지 작성·수정 시작의 대상 쪽지다. 다른 사건은 null이다.
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
