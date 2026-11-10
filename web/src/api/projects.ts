import { apiGet, apiPost } from './client.ts'

export type ProjectRole = 'DEVELOPER' | 'CLIENT'
export type Viewport = 'PC' | 'MOBILE'

// 시각은 JSON으로 와서 글자(ISO 문자열)다.
export type MyProject = { id: string; name: string; myRole: ProjectRole; createdAt: string }
// 서버의 클라이언트 정원과 같다(전체 기획 5장). 바꾸면 서버도 함께 바꾼다.
export const MAX_CLIENTS = 5
// 승인자는 이 프로젝트의 클라이언트 한 명이다. 정하지 않았으면 null이다.
export type Approver = { memberId: string; name: string } | null
// 현재 버전은 게시할 때만 바뀌어서 늘 번호가 있다. 게시 전에는 null이다.
export type ProjectDetail = {
  id: string
  name: string
  myRole: ProjectRole
  currentVersion: { id: string; number: number } | null
  approver: Approver
}
export type Screen = { id: string; name: string; viewport: Viewport; hiddenAt: string | null }

// 설정 화면과 검수실이 화면 이름표를 같은 글자로 보여 준다. 예: "메인 · 모바일"
export const VIEWPORT_LABELS: Record<Viewport, string> = { PC: 'PC', MOBILE: '모바일' }

export const screenLabel = (screen: { name: string; viewport: Viewport }) =>
  `${screen.name} · ${VIEWPORT_LABELS[screen.viewport]}`

export const listProjects = async (): Promise<MyProject[]> => {
  const response = await apiGet('/projects')
  return response.json()
}

export const createProject = async (name: string): Promise<MyProject> => {
  const response = await apiPost('/projects', { name })
  return response.json()
}

// 여기부터 주소 속 id는 encodeURIComponent로 감싼다. id가 브라우저 주소창에서 올 수 있어서,
// 감싸지 않으면 'x/../../auth/me' 같은 값의 /가 다른 API를 부른다.
// '.'과 '..'은 감싸도 그대로라서, 주소에서 id를 읽는 화면이 UUID 모양인지 먼저 확인한다.
export const getProject = async (id: string): Promise<ProjectDetail> => {
  const response = await apiGet(`/projects/${encodeURIComponent(id)}`)
  return response.json()
}

export const listScreens = async (projectId: string): Promise<Screen[]> => {
  const response = await apiGet(`/projects/${encodeURIComponent(projectId)}/screens`)
  return response.json()
}

export const createScreen = async (projectId: string, name: string, viewport: Viewport): Promise<Screen> => {
  const response = await apiPost(`/projects/${encodeURIComponent(projectId)}/screens`, { name, viewport })
  return response.json()
}

export const hideScreen = async (screenId: string): Promise<Screen> => {
  const response = await apiPost(`/screens/${encodeURIComponent(screenId)}/hide`)
  return response.json()
}

export const showScreen = async (screenId: string): Promise<Screen> => {
  const response = await apiPost(`/screens/${encodeURIComponent(screenId)}/show`)
  return response.json()
}
