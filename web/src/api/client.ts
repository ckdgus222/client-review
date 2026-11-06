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
export const toApiError = async (response: Response) => {
  const body = await response.json().catch(() => null)
  return new ApiError(response.status, body?.code)
}

// 쿠키와 Origin은 같은 주소라 브라우저가 알아서 붙인다. 그래서 credentials 설정이 없다.
// 두 함수 모두 Response를 돌려준다. 본문이 없는 응답(204)도 있어서 .json()은 부르는 쪽에서 한다.
export const apiGet = async (path: string) => {
  const response = await fetch(`/api${path}`)
  if (!response.ok) throw await toApiError(response)
  return response
}

export const apiPost = async (path: string, body: object = {}) => {
  const response = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw await toApiError(response)
  return response
}
