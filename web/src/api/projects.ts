import { apiGet, apiPost } from './client.ts'

export type ProjectRole = 'DEVELOPER' | 'CLIENT'
export type Viewport = 'PC' | 'MOBILE'

// 진행 중, 보관(읽기만), 삭제 대기(7일 안에 되살릴 수 있음).
export type ProjectStatus = 'ACTIVE' | 'ARCHIVED' | 'DELETE_PENDING'
// 시각은 JSON으로 와서 글자(ISO 문자열)다. purgeAfter는 삭제 대기일 때만 있는 "완전히 지워지는 때"다.
export type MyProject = {
  id: string
  name: string
  myRole: ProjectRole
  createdAt: string
  status: ProjectStatus
  purgeAfter: string | null
}
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
  // 내가 승인자인가. 서버가 정해서 알려 준다(화면은 내 멤버 id를 몰라서 approver와 비교할 수 없다).
  isApprover: boolean
  status: ProjectStatus
  purgeAfter: string | null
}
export type Screen = { id: string; name: string; viewport: Viewport; hiddenAt: string | null }

// 설정 화면과 검수실이 화면 이름표를 같은 글자로 보여 준다. 예: "메인 · 모바일"
export const VIEWPORT_LABELS: Record<Viewport, string> = { PC: 'PC', MOBILE: '모바일' }

export const screenLabel = (screen: { name: string; viewport: Viewport }) =>
  `${screen.name} · ${VIEWPORT_LABELS[screen.viewport]}`

const DAY_MS = 24 * 60 * 60 * 1000

// 목록·검수실·설정이 같은 규칙으로 센다. 남은 날은 올림이다(1시간 남아도 "1일 뒤").
// 0 이하면 정리 작업이 돌기 전이라도 되살릴 수 없다(서버가 7일을 다시 본다).
export const daysUntilPurge = (purgeAfter: string, now: number) => Math.ceil((Date.parse(purgeAfter) - now) / DAY_MS)

export const purgeText = (daysLeft: number) =>
  daysLeft > 0 ? `${daysLeft}일 뒤 완전히 지워져요` : '곧 완전히 지워져요'

// 서버가 보관·삭제 대기 프로젝트의 쓰기를 409로 막을 때의 문구. 오류 코드를 문구로 바꾸는 화면들이 같이 쓴다.
const PROJECT_STATUS_ERRORS: Record<string, string> = {
  PROJECT_ARCHIVED: '보관한 프로젝트예요. 보관을 풀어야 바꿀 수 있어요',
  PROJECT_DELETE_PENDING: '삭제 대기 중인 프로젝트예요. 되살려야 바꿀 수 있어요',
}

export const projectStatusError = (code: string | undefined) => (code ? PROJECT_STATUS_ERRORS[code] : undefined)

// 검수실·설정 화면 위의 띠 글. 진행 중이면 null이다. 쓰기 버튼은 감추지 않고, 누르면 서버의 409를 오류 글로 보인다.
export const statusNotice = ({ status, purgeAfter }: Pick<ProjectDetail, 'status' | 'purgeAfter'>, now: number) => {
  if (status === 'ARCHIVED') return '보관한 프로젝트예요. 읽기만 할 수 있어요'
  if (status === 'DELETE_PENDING' && purgeAfter) {
    return `삭제 대기 중인 프로젝트예요. ${purgeText(daysUntilPurge(purgeAfter, now))}`
  }
  return null
}

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

// 보관·보관 풀기·지우기·되살리기는 개발자만 한다. 성공하면 본문 없이 204가 온다.
export const archiveProject = async (id: string) => {
  await apiPost(`/projects/${encodeURIComponent(id)}/archive`)
}

export const unarchiveProject = async (id: string) => {
  await apiPost(`/projects/${encodeURIComponent(id)}/unarchive`)
}

// 실수로 지우지 않게 서버가 프로젝트 이름을 다시 본다.
export const deleteProject = async (id: string, name: string) => {
  await apiPost(`/projects/${encodeURIComponent(id)}/delete`, { name })
}

export const restoreProject = async (id: string) => {
  await apiPost(`/projects/${encodeURIComponent(id)}/restore`)
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
