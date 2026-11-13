import { type ReactNode, useEffect, useState } from 'react'
import { Link, Navigate, useParams } from 'react-router'
import { ApiError } from '../api/client.ts'
import { isUuid } from '../api/ids.ts'
import { ISSUE_CATEGORY_LABELS, ISSUE_STATUS_LABELS } from '../api/issues.ts'
import { screenLabel } from '../api/projects.ts'
import { type Certificate, getCertificate, versionLabel } from '../api/versions.ts'
import { Button } from '../components/Button.tsx'
import { ErrorText, SessionEnded } from '../components/ErrorText.tsx'
import { useMe } from '../hooks/useMe.ts'
import styles from './CertificatePage.module.css'

type CertificateIssue = Certificate['issues'][number]

// 확인서는 문서로 밖에 나가서, 누가 어느 시간대의 컴퓨터로 열어도 같은 시각이 찍혀야 한다.
// 그래서 다른 화면의 timeFormat(보는 사람 컴퓨터의 시간대)과 달리 한국 시각에 고정한다. 모양은 같다.
const kstFormat = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Seoul' })
const formatKst = (iso: string) => kstFormat.format(new Date(iso))

const toMessage = (error: unknown): ReactNode => {
  if (!(error instanceof ApiError)) return '연결을 확인하고 다시 시도해 주세요'
  if (error.status === 401) return <SessionEnded />
  return '잠시 뒤 다시 시도해 주세요'
}

// 서버는 없는 버전, 승인되지 않은 버전, 남의 버전을 같은 404로 답해서 화면도 셋을 구분하지 않는다.
const CertificateNotFound = () => (
  <>
    <h1>없는 확인서예요</h1>
    <Link to="/">프로젝트 목록</Link>
  </>
)

// 범위는 목록 제목이 말해 줘서 칸을 두지 않는다. 상태는 색이 아니라 글자로 적는다.
const IssueTable = ({ title, emptyText, issues }: { title: string; emptyText: string; issues: CertificateIssue[] }) => (
  <section className={styles.block}>
    <h2>
      {title} {issues.length}건
    </h2>
    {issues.length === 0 ? (
      <p>{emptyText}</p>
    ) : (
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">번호</th>
            <th scope="col">제목</th>
            <th scope="col">분류</th>
            <th scope="col">상태</th>
          </tr>
        </thead>
        <tbody>
          {issues.map((issue) => (
            <tr key={issue.number}>
              <td>#{issue.number}</td>
              <td className={styles.issueTitle}>{issue.title}</td>
              <td>{ISSUE_CATEGORY_LABELS[issue.category]}</td>
              <td>{ISSUE_STATUS_LABELS[issue.status]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    )}
  </section>
)

const CertificateIssues = ({ issues }: { issues: CertificateIssue[] }) => {
  if (issues.length === 0) return <p>이 버전에는 쪽지가 없었어요</p>
  // 서버가 번호 순으로 저장한 목록이라, 나누기만 해도 두 목록 모두 번호 순이다.
  const inScope = issues.filter((issue) => issue.scope === 'IN_SCOPE')
  const outOfScope = issues.filter((issue) => issue.scope === 'OUT_OF_SCOPE')
  return (
    <>
      <IssueTable title="이번 범위의 쪽지" emptyText="이번 범위의 쪽지가 없어요" issues={inScope} />
      <IssueTable title="범위 밖(추가 요청) 쪽지" emptyText="범위 밖 쪽지가 없어요" issues={outOfScope} />
    </>
  )
}

const CertificateView = ({ certificate }: { certificate: Certificate }) => {
  const { project, version, approval, counts } = certificate
  const label = versionLabel(version.number)
  // "초안을", "1차를"처럼 받침에 따라 조사가 다르다. 번호 0이 초안이다.
  const particle = version.number === 0 ? '을' : '를'

  return (
    <article className={styles.paper}>
      <div className={styles.toolbar}>
        <Link to={`/projects/${project.id}?version=${version.id}`}>검수실로 돌아가기</Link>
        <Button onClick={() => window.print()}>PDF로 저장</Button>
        <p className={styles.muted}>인쇄 창에서 'PDF로 저장'을 고르면 돼요</p>
      </div>

      <h1>검수 확인서</h1>
      <p className={styles.muted}>확인서 번호 {certificate.certificateNumber}</p>

      <dl className={styles.facts}>
        <dt>프로젝트</dt>
        <dd>{project.name}</dd>
        <dt>버전</dt>
        <dd>{label}</dd>
        <dt>게시 시각</dt>
        <dd>{formatKst(version.publishedAt)}</dd>
        <dt>승인 시각</dt>
        <dd>{formatKst(approval.approvedAt)}</dd>
        <dt>승인자</dt>
        <dd>{approval.approverName}</dd>
        <dt>개발자</dt>
        <dd>{certificate.developerName}</dd>
      </dl>

      <p className={styles.statement}>
        {approval.approverName}님이 {project.name}의 {label}
        {particle} 승인했어요.
      </p>

      <section className={styles.block}>
        <h2>검수한 화면 {certificate.screens.length}개</h2>
        <ul>
          {certificate.screens.map((screen, index) => (
            // 같은 이름·크기의 화면이 둘일 수 있어 순서를 key에 섞는다. 승인된 버전의 화면 목록은 바뀌지 않는다.
            <li key={`${index}-${screen.name}`}>{screenLabel(screen)}</li>
          ))}
        </ul>
      </section>

      <p>
        확인 완료 {counts.verified}건 · 철회 {counts.withdrawn}건 · 범위 밖(추가 요청) {counts.outOfScope}건
      </p>

      <CertificateIssues issues={certificate.issues} />

      <footer className={styles.footer}>
        <p>이 확인서는 승인한 때의 내용이에요. 그 뒤에 쪽지가 바뀌어도 달라지지 않아요.</p>
        <p>시각은 한국 표준시(KST) 기준이에요</p>
      </footer>
    </article>
  )
}

const CertificateLoader = ({ id }: { id: string }) => {
  const isValidId = isUuid(id)
  const { user, error: meError } = useMe()
  const [certificate, setCertificate] = useState<Certificate>()
  const [notFound, setNotFound] = useState(false)
  const [loadError, setLoadError] = useState<ReactNode>()

  // 로그인 확인을 기다리지 않고 같이 부른다(활동 일지와 같다).
  useEffect(() => {
    if (!isValidId) return
    getCertificate(id)
      .then(setCertificate)
      .catch((caught) => {
        if (caught instanceof ApiError && caught.status === 404) return setNotFound(true)
        setLoadError(toMessage(caught))
      })
  }, [id, isValidId])

  if (user === null) return <Navigate to="/login" replace />
  // 확인 중 오류여도 로그인 화면으로 보내지 않는다. 서버가 잠깐 멈춘 것일 수 있다.
  if (user === undefined) return <p>{meError ?? '확인하는 중이에요.'}</p>
  if (!isValidId || notFound) return <CertificateNotFound />
  if (loadError) return <ErrorText message={loadError} />
  if (!certificate) return <p>불러오는 중이에요.</p>
  return <CertificateView certificate={certificate} />
}

// 다른 버전의 확인서로 바로 가면 이전 확인서가 남지 않게, id가 바뀌면 새로 시작한다(활동 일지와 같다).
export const CertificatePage = () => {
  const { id = '' } = useParams()
  return <CertificateLoader key={id} id={id} />
}
