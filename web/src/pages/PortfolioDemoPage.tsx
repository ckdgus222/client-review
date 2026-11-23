import { useReducer, useState, type FormEvent } from 'react'
import { Button } from '../components/Button.tsx'
import { Modal } from '../components/Modal.tsx'
import { StatusBadge } from '../components/StatusBadge.tsx'
import beforePhoto from '../assets/demo-before.webp'
import afterPhoto from '../assets/demo-after.webp'
import { PhotoCanvas, type PinPosition } from './PhotoCanvas.tsx'
import { DemoGuide } from './DemoGuide.tsx'
import { demoProject, initialDemo, steps, updateDemo, type DemoRole } from './portfolioDemo.ts'
import styles from './PortfolioDemoPage.module.css'

const roles: Record<DemoRole, string> = { client: '고객(승인자)', developer: '개발자' }
const photo = { id: 'demo-storefront', width: 790, height: 592 }
const sample = demoProject.sample

const DemoSession = ({ onRestart }: { onRestart: () => void }) => {
  const [state, dispatch] = useReducer(updateDemo, initialDemo)
  const [pin, setPin] = useState<PinPosition>()
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [selected, setSelected] = useState('')
  const [approvalOpen, setApprovalOpen] = useState(false)
  const [showCertificate, setShowCertificate] = useState(false)
  const { role, stage, note } = state
  const step = stage === 'request' || stage === 'approved' ? null : steps[stage]
  const creating = stage === 'request' && role === 'client'
  const revised = !['request', 'received', 'started'].includes(stage)
  const previewingRevision = role === 'developer' && stage === 'started'
  const version = revised ? '1차' : '초안'
  const noteStatus = step?.status ?? 'VERIFIED'
  const complete = noteStatus === 'VERIFIED' && note ? 2 : 1
  const total = note ? 2 : 1
  const pins = [sample]
  if (note) pins.push({ ...note.pin, id: 'visitor', number: 2, title: note.title })

  const create = (event: FormEvent) => {
    event.preventDefault()
    if (!pin || !title.trim()) return
    dispatch({ type: 'create', note: { title, body: body.trim(), pin } })
    setSelected('visitor')
  }

  const advance = () => {
    if (stage === 'request' || stage === 'approved') return
    if (stage === 'verified') {
      setApprovalOpen(true)
      return
    }
    if (stage === 'started' && !window.confirm('게시하면 고칠 수 없어요. 1차를 게시할까요?')) return
    dispatch({ type: 'advance', from: stage })
  }

  const renderPhoto = (after: boolean, comparing = false) => (
    <PhotoCanvas
      asset={photo}
      imageSrc={after ? afterPhoto : beforePhoto}
      alt={after ? '구매 버튼 위 여백을 넓힌 상품 상세 사진' : '수정 전 상품 상세 사진'}
      caption={comparing ? (after ? '고친 사진 · 1차' : '처음 사진 · 초안') : (previewingRevision ? '1차 게시 전 미리보기' : version) + ' · 상품 상세 · PC'}
      pins={after ? [] : pins}
      selectedPinId={selected}
      draftPin={creating ? pin : undefined}
      onSelectPin={setSelected}
      onPlacePin={creating ? setPin : undefined}
    />
  )

  return (
    <section className={styles.page} aria-label="포트폴리오 데모">
      <header className={styles.heading}>
        <div><p className={styles.eyebrow}>포트폴리오 데모</p><h1>{demoProject.name}</h1></div>
        <div className={styles.tools}><a href="/">서비스 소개</a><Button variant="secondary" onClick={onRestart}>처음부터</Button></div>
      </header>
      <p className={styles.intro}>샘플 사진에 쪽지를 남기고, 개발자와 고객 역할을 바꿔 승인까지 체험하세요. 이 탭에서만 진행되며 새로고침하면 처음으로 돌아갑니다.</p>
      <div className={styles.layout}>
        <div className={styles.work}>
          <div className={styles.caption}><strong>상품 상세 검수</strong><span>{version} · {stage === 'approved' ? '승인됨' : '검수 중'}</span></div>
          <div className={stage === 'comparing' ? styles.compare : styles.mat}>
            {stage === 'comparing' ? <>{renderPhoto(false, true)}{renderPhoto(true, true)}</> : renderPhoto(revised || previewingRevision)}
          </div>
          <div className={styles.guide}><DemoGuide /></div>
        </div>
        <aside className={styles.panel} aria-label="체험 가이드">
          <h2>체험 가이드</h2>
          <fieldset className={styles.roles}>
            <legend>내 역할</legend>
            {(['client', 'developer'] as const).map((item) => (
              <button key={item} type="button" aria-pressed={role === item} onClick={() => dispatch({ type: 'switch', role: item })}>{roles[item]}</button>
            ))}
          </fieldset>
          <p className={styles.progress}><span>확인 완료</span><strong>{complete} / {total}</strong></p>
          <ul className={styles.notes} aria-label="쪽지 목록">
            <li><span>#1 <StatusBadge status="VERIFIED" /></span><strong>{sample.title}</strong></li>
            {note && <li><span>#2 <StatusBadge status={noteStatus} /></span><strong>{note.title}</strong>{note.body && <p>{note.body}</p>}</li>}
          </ul>
          {selected === sample.id && <p className={styles.hint}>#1은 고객이 배송 안내를 확인한 예시 쪽지예요.</p>}
          {stage === 'request' && (creating ? (
            <form onSubmit={create} className={styles.form}>
              <h3>쪽지 쓰기</h3>
              <p>이 예시에서는 구매 버튼 간격을 고쳐요. 사진에서 그 자리를 누르거나 아래 버튼으로 선택하세요.</p>
              <Button variant="secondary" onClick={() => setPin(demoProject.purchaseButton)}>구매 버튼 위치 선택</Button>
              <span role="status">{pin ? '사진에 새 쪽지 위치를 표시했어요.' : '아직 위치를 고르지 않았어요.'}</span>
              <label>제목 (필수)<input required maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="구매 버튼 간격을 넓혀 주세요" /></label>
              <label>내용<textarea rows={2} maxLength={4000} value={body} onChange={(event) => setBody(event.target.value)} /></label>
              <Button type="submit" disabled={!pin || !title.trim()}>쪽지 남기기</Button>
            </form>
          ) : <p role="status">첫 쪽지는 고객이 남겨요. ‘고객(승인자)’로 역할을 바꾸세요.</p>)}
          {step && <div className={styles.action}>
            <h3>{step.action}</h3>
            <p>{step.guide}</p>
            {stage === 'published' && <p className={styles.hint}>고친 내용 · 수량과 구매 버튼 사이의 여백을 넓혔어요.</p>}
            {role !== step.actor && <p role="status">‘{roles[step.actor]}’로 역할을 바꾸세요.</p>}
            <Button disabled={role !== step.actor} onClick={advance}>{step.action}</Button>
          </div>}
          {stage === 'approved' && <div className={styles.action}>
            <h3>1차 승인 완료</h3><p>승인한 버전은 읽기 전용이에요.</p>
            <Button onClick={() => setShowCertificate(true)}>검수 확인서 보기</Button>
          </div>}
        </aside>
      </div>
      {approvalOpen && <Modal title="버전 승인" onClose={() => setApprovalOpen(false)}>
        <p>범위 안의 미해결 쪽지 0개 · 확인 완료 {complete}개</p>
        <p>이 버전을 승인할까요? 승인하면 되돌릴 수 없어요.</p>
        <div className={styles.tools}>
          <Button variant="secondary" onClick={() => setApprovalOpen(false)}>취소</Button>
          <Button onClick={() => { dispatch({ type: 'advance', from: 'verified' }); setApprovalOpen(false) }}>승인 확정</Button>
        </div>
      </Modal>}
      {showCertificate && note && <Modal title="검수 확인서" onClose={() => setShowCertificate(false)}>
        <p className={styles.eyebrow}>데모 확인서 · DEMO-001</p><h3>{demoProject.name} · 1차</h3>
        <p>개발자 {demoProject.developer} · 승인자 {demoProject.approver}</p>
        <p>승인 당시 확인 완료 {complete}개</p>
        <ul><li>#1 {sample.title}</li><li>#2 {note.title}</li></ul>
      </Modal>}
    </section>
  )
}

export const PortfolioDemoPage = () => {
  const [run, setRun] = useState(0)
  return <DemoSession key={run} onRestart={() => setRun((previous) => previous + 1)} />
}
