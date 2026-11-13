import { apiPost, toApiError } from './client.ts'

export type AuthUser = { id: string; email: string; name: string }
// /auth/me만 보낸다. 만들기 칸을 보여 줄지 정하는 값이고, 실제로 막는 곳은 서버의 만들기 API다.
export type Me = AuthUser & { canCreateProjects: boolean }

// 로그인 화면이 개인정보 수집·이용 동의 체크를 확인한 뒤에만 부른다.
export const requestCode = async (email: string) => {
  await apiPost('/auth/email-code', { email, privacyAgreed: true })
}

// 처음 온 사람만 name을 보낸다. name이 undefined면 JSON에서 빠진다.
export const verifyCode = async (email: string, code: string, name?: string): Promise<AuthUser> => {
  const response = await apiPost('/auth/verify-code', { email, code, name })
  return response.json()
}

// 로그인 안 했으면(401) 오류가 아니라 null이다. 그래서 apiGet 대신 직접 부른다.
export const getMe = async (): Promise<Me | null> => {
  const response = await fetch('/api/auth/me')
  if (response.status === 401) return null
  if (!response.ok) throw await toApiError(response)
  return response.json()
}

export const logout = async () => {
  await apiPost('/auth/logout')
}
