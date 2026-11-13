import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Link, Navigate, useParams } from 'react-router'
import { ApiError } from '../api/client.ts'
import { isUuid } from '../api/ids.ts'
import { getIssue, type IssueDetail as Issue, originLabel } from '../api/issues.ts'
import { screenLabel } from '../api/projects.ts'
import { versionLabel } from '../api/versions.ts'
import { ErrorText, SessionEnded } from '../components/ErrorText.tsx'
import { StatusBadge } from '../components/StatusBadge.tsx'
import { useMe } from '../hooks/useMe.ts'
import styles from './ComparePage.module.css'
import { IssueReview } from './IssueReview.tsx'
import { PhotoCanvas } from './PhotoCanvas.tsx'

const toMessage = (error: unknown): ReactNode => {
  if (!(error instanceof ApiError)) return '연결을 확인하고 다시 시도해 주세요'
  if (error.status === 401) return <SessionEnded />
  return '잠시 뒤 다시 시도해 주세요'
}

// 이 화면에서는 눌러도 할 일이 없는 것에 넘긴다: 핀은 보기만 하고, "최신 버전 보기" 버튼은 그려지지 않는다
// (새 버전 안내를 versionChangedNotice가 대신한다. IssueReview가 꼭 받는 값이라 넘긴다).
const doNothing = () => {}

const Compare = ({ id }: { id: string }) => {
  const isValidId = isUuid(id)
  const { user, error: meError } = useMe()
  const [issue, setIssue] = useState<Issue>()
  const [notFound, setNotFound] = useState(false)
  const [loadError, setLoadError] = useState<ReactNode>()
  // 쪽지를 서버에서 새로 받아 화면에 쓴 횟수(useIssueRequest 참고).
  const [fetchCount, setFetchCount] = useState(0)
  // 쪽지를 다시 부르거나 서버가 돌려준 쪽지를 화면에 쓸 때마다 넘기는 차례 번호다. 가장 나중 차례의 응답만 화면에 쓴다
  // (검수실의 쪽지 상세와 같은 규칙). 값을 두 곳에 둔다. 늦게 끝난 요청은 "지금 차례"를 ref로 읽고, 버튼을 누른 때의
  // 차례는 그때 그린 화면의 state가 기억한다(ref는 늘 지금 값이라 누른 때를 알려 주지 못한다).
  const latestTurn = useRef(0)
  const [turn, setTurn] = useState(0)
  const startTurn = () => {
    latestTurn.current += 1
    setTurn(latestTurn.current)
  }

  // 쪽지는 열 때와 차례가 넘어갈 때만 받는다. 검수실과 달리 15초마다 새로 부르지 않는다.
  useEffect(() => {
    if (!isValidId) return
    // 이 실행이 정리되면(다시 부름, 개발 모드의 StrictMode가 effect를 두 번 실행함) 그 응답은 버린다.
    // 같은 차례에 불러오기가 둘이 될 수 있어서 차례 번호만으로는 가리지 못한다.
    let cleanedUp = false
    const load = async () => {
      try {
        const loaded = await getIssue(id)
        // 그사이 차례가 넘어갔으면(다시 불렀거나 더 새 쪽지를 화면에 썼으면) 이 응답은 옛 내용이라 버린다.
        if (cleanedUp || latestTurn.current !== turn) return
        setIssue(loaded)
        setFetchCount((count) => count + 1)
      } catch (caught) {
        if (cleanedUp || latestTurn.current !== turn) return
        // 남의 프로젝트의 쪽지도 서버가 없는 것과 같은 404로 답해서, 있는지조차 알 수 없다.
        if (caught instanceof ApiError && caught.status === 404) return setNotFound(true)
        setLoadError(toMessage(caught))
      }
    }
    void load()
    return () => {
      cleanedUp = true
    }
  }, [id, isValidId, turn])

  // 서버가 돌려준 바뀐 쪽지를 화면에 쓴다. pressedAt은 그 버튼을 누른 때의 차례다.
  const applyChange = (changed: Issue, pressedAt: number) => {
    // 누른 뒤에 쪽지를 다시 부른 적이 있으면 그쪽이 더 새 내용일 수 있다. 그때는 이 응답을 쓰지 않는다.
    if (latestTurn.current === pressedAt) setIssue(changed)
    // 어느 쪽이든 차례를 넘긴다. 누르기 전에 시작한 불러오기의 응답이 늦게 와도 버려지고, 쪽지를 한 번 더 받아 온다.
    startTurn()
  }

  if (user === null) return <Navigate to="/login" replace />
  // 확인 중 오류여도 로그인 화면으로 보내지 않는다. 서버가 잠깐 멈춘 것일 수 있다.
  if (user === undefined) return <p>{meError ?? '확인하는 중이에요.'}</p>
  if (!isValidId || notFound) {
    return (
      <>
        <h1>없는 쪽지예요</h1>
        <Link to="/">프로젝트 목록</Link>
      </>
    )
  }
  // 이미 보여 준 쪽지가 있으면 다시 불러오기가 실패해도 그 쪽지를 그대로 보여 준다.
  if (!issue) return loadError ? <ErrorText message={loadError} /> : <p>불러오는 중이에요.</p>

  const roomUrl = `/projects/${issue.projectId}?issue=${issue.id}`
  const heading = (
    <>
      <Link to={roomUrl}>검수실로 돌아가기</Link>
      <div className={styles.heading}>
        <h1>
          #{issue.number} {issue.title}
        </h1>
        <StatusBadge status={issue.status} />
      </div>
    </>
  )
  // 가장 최근 고쳤어요의 사진과 비교한다. 고쳤어요가 없거나 화면 없이 보낸 고쳤어요면 비교할 사진이 없다.
  const latest = issue.attempts[issue.attempts.length - 1]
  if (!latest?.screen) {
    return (
      <section className={styles.page}>
        {heading}
        <p>비교할 사진이 없어요.</p>
      </section>
    )
  }

  const { origin } = issue
  const fixedPlace = screenLabel({ name: latest.screen.screenName, viewport: latest.screen.viewport })
  return (
    <section className={styles.page}>
      {heading}
      <p className={styles.summary}>
        <strong>고친 내용</strong> {latest.summary}
      </p>
      {/* 요청에 보내는 "보고 있던 버전"은 보고 있는 고쳤어요 줄의 버전이다. 그사이 새 버전이 게시됐으면 서버가 409로 답한다. */}
      <IssueReview
        issue={issue}
        versionId={latest.versionId}
        canWrite
        reviewOnly
        fetchCount={fetchCount}
        // 누른 때의 차례를 넘긴다(applyChange).
        onChanged={(changed) => applyChange(changed, turn)}
        onRefresh={startTurn}
        onGoLatest={doNothing}
        versionChangedNotice={
          <>
            새 버전이 올라왔어요. <Link to={roomUrl}>검수실에서 최신 버전 보기</Link>
          </>
        }
      />
      <div className={styles.photos}>
        <div className={styles.pane}>
          {origin ? (
            <PhotoCanvas
              caption={`처음 사진 · ${originLabel(issue)}`}
              asset={origin.asset}
              alt={`처음 사진 ${screenLabel({ name: origin.screenName, viewport: origin.viewport })}`}
              pins={[{ id: issue.id, number: issue.number, title: issue.title, ...origin }]}
              selectedPinId={issue.id}
              onSelectPin={doNothing}
            />
          ) : (
            <p className={styles.empty}>위치 없는 쪽지예요.</p>
          )}
        </div>
        <div className={styles.pane}>
          <PhotoCanvas
            caption={`고친 사진 · ${versionLabel(latest.versionNumber)} · ${fixedPlace}`}
            asset={latest.screen.asset}
            alt={`고친 사진 ${fixedPlace}`}
            pins={[]}
            onSelectPin={doNothing}
          />
        </div>
      </div>
    </section>
  )
}

// 다른 쪽지의 비교 화면으로 바로 가면 이전 쪽지가 남지 않게, id가 바뀌면 새로 시작한다(검수실과 같다).
export const ComparePage = () => {
  const { id = '' } = useParams()
  return <Compare key={id} id={id} />
}
