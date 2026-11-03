export type AuthUser = { id: string; email: string; name: string }

// 서버가 실패로 답했을 때 던진다. 화면은 status와 code를 보고 문구를 고른다.
export class ApiError extends Error {
  status: number
  code?: string

  constructor(status: number, code?: string) {
    super(`서버 요청 실패 (${status})`)
    this.status = status
    this.code = code
  }
}

// 본문이 JSON이 아니거나(서버가 꺼져 nginx가 오류 페이지를 보낼 때) null이어도 멈추지 않고 code 없이 만든다.
const toApiError = async (response: Response) => {
  const body = await response.json().catch(() => null)
  return new ApiError(response.status, body?.code)
}

// 쿠키와 Origin은 같은 주소라 브라우저가 알아서 붙인다. 그래서 credentials 설정이 없다.
const post = async (path: string, body: object = {}) => {
  const response = await fetch(`/api/auth/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw await toApiError(response)
  return response
}

export const requestCode = async (email: string) => {
  await post('email-code', { email })
}

// 처음 온 사람만 name을 보낸다. name이 undefined면 JSON에서 빠진다.
export const verifyCode = async (email: string, code: string, name?: string): Promise<AuthUser> => {
  const response = await post('verify-code', { email, code, name })
  return response.json()
}

// 로그인 안 했으면(401) 오류가 아니라 null이다.
export const getMe = async (): Promise<AuthUser | null> => {
  const response = await fetch('/api/auth/me')
  if (response.status === 401) return null
  if (!response.ok) throw await toApiError(response)
  return response.json()
}

export const logout = async () => {
  await post('logout')
}
