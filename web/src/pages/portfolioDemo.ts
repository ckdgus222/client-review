import type { IssueStatus } from '../api/issues.ts'
import type { PinPosition } from './PhotoCanvas.tsx'

export type DemoRole = 'client' | 'developer'
type DemoStage = 'request' | 'received' | 'started' | 'published' | 'submitted' | 'comparing' | 'verified' | 'approved'

export const demoProject = {
  name: '오브제 스토어 리뉴얼',
  developer: '김서진',
  approver: '박지민',
  sample: { id: 'sample', number: 1, title: '배송 안내 문구 확인', xRatio: 0.69, yRatio: 0.29 },
  purchaseButton: { xRatio: 0.76, yRatio: 0.53 },
}

type DemoNote = { title: string; body: string; pin: PinPosition }
export type DemoState = { role: DemoRole; stage: DemoStage; note: DemoNote | null }
export const initialDemo: DemoState = { role: 'client', stage: 'request', note: null }

type Step = { actor: DemoRole; action: string; guide: string; status: IssueStatus; next: DemoStage }
export const steps = {
  received: { actor: 'developer', action: '수정 시작', guide: '접수된 쪽지를 읽고 수정을 시작하세요.', status: 'OPEN', next: 'started' },
  started: { actor: 'developer', action: '1차 게시', guide: '구매 버튼 여백을 넓힌 샘플 사진을 준비했어요. 수정한 1차 버전을 게시하세요.', status: 'IN_PROGRESS', next: 'published' },
  published: { actor: 'developer', action: '고쳤어요 보내기', guide: '방금 게시한 상품 상세 사진과 수정 내용을 고객에게 확인 요청하세요.', status: 'IN_PROGRESS', next: 'submitted' },
  submitted: { actor: 'client', action: '비교해 보기', guide: '처음 사진과 고친 사진을 열어 구매 버튼 주위의 여백을 비교하세요.', status: 'READY_FOR_REVIEW', next: 'comparing' },
  comparing: { actor: 'client', action: '확인 완료', guide: '두 사진에서 요청한 부분이 반영됐는지 보고 쪽지를 확인 완료로 바꾸세요.', status: 'READY_FOR_REVIEW', next: 'verified' },
  verified: { actor: 'client', action: '버전 승인', guide: '범위 안의 미해결 쪽지가 모두 끝났어요. 지정 승인자로서 1차 버전을 승인하세요.', status: 'VERIFIED', next: 'approved' },
} as const satisfies Record<Exclude<DemoStage, 'request' | 'approved'>, Step>

type Action =
  | { type: 'switch'; role: DemoRole }
  | { type: 'create'; note: DemoNote }
  | { type: 'advance'; from: keyof typeof steps }

export const updateDemo = (state: DemoState, action: Action): DemoState => {
  if (action.type === 'switch') return { ...state, role: action.role }
  if (action.type === 'create') {
    if (state.stage !== 'request' || state.role !== 'client' || !action.note.title.trim()) return state
    return { ...state, stage: 'received', note: { ...action.note, title: action.note.title.trim() } }
  }
  const step = steps[action.from]
  if (state.stage !== action.from || state.role !== step.actor) return state
  return { ...state, stage: step.next }
}
