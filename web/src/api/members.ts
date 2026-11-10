import { apiGet, apiPost } from './client.ts'
import type { Approver, ProjectRole } from './projects.ts'

// 마지막 접속은 서비스에 들어온 시각이다. 한 번도 들어오지 않았으면 null이다.
export type Member = { id: string; name: string; email: string; role: ProjectRole; lastSeenAt: string | null }
// 아직 수락하지 않은, 지금 쓸 수 있는 초대.
export type PendingInvitation = { email: string; expiresAt: string }
export type MemberList = { members: Member[]; invitations: PendingInvitation[] }

// 개발자만 부른다. 클라이언트에게는 서버가 403으로 답한다.
export const listMembers = async (projectId: string): Promise<MemberList> => {
  const response = await apiGet(`/projects/${encodeURIComponent(projectId)}/members`)
  return response.json()
}

// 서버는 본문 없이 204로 답한다.
export const revokeMember = async (memberId: string): Promise<void> => {
  await apiPost(`/members/${encodeURIComponent(memberId)}/revoke`)
}

// memberId가 null이면 승인자를 비운다("지정하지 않음").
export const setApprover = async (projectId: string, memberId: string | null): Promise<Approver> => {
  const response = await apiPost(`/projects/${encodeURIComponent(projectId)}/approver`, { memberId })
  const body: { approver: Approver } = await response.json()
  return body.approver
}
