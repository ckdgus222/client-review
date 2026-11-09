import { apiGet, apiPost } from './client.ts'

// 초대 링크는 만든 직후 이 응답으로 한 번만 볼 수 있다. 서버는 토큰의 해시만 저장한다.
export type CreatedInvitation = { email: string; expiresAt: string; link: string }

// 로그인 전에도 보이는 초대 내용. 이미 수락한 초대는 ACCEPTED로 온다.
export type InvitationPreview = {
  projectName: string
  inviterName: string
  email: string
  status: 'PENDING' | 'ACCEPTED'
}

// 초대 토큰은 서버가 만드는 무작위 32바이트를 base64url로 쓴 43글자다. 주소에서 온 값이라
// '.'이나 '..'이면 encodeURIComponent로 감싸도 다른 API 주소가 된다. 이 모양이 아니면 서버를 부르지 않는다.
const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

export const isInviteToken = (value: string) => INVITE_TOKEN_PATTERN.test(value)

export const createInvitation = async (projectId: string, email: string): Promise<CreatedInvitation> => {
  const response = await apiPost(`/projects/${encodeURIComponent(projectId)}/invitations`, { email })
  return response.json()
}

export const getInvitation = async (token: string): Promise<InvitationPreview> => {
  const response = await apiGet(`/invitations/${encodeURIComponent(token)}`)
  return response.json()
}

// 토큰은 주소가 아니라 본문으로 보낸다. 수락은 로그인한 이메일과 초대 이메일이 같아야 한다.
export const acceptInvitation = async (token: string): Promise<{ projectId: string }> => {
  const response = await apiPost('/invitations/accept', { token })
  return response.json()
}
