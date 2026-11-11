import { type ReactNode, useCallback, useEffect, useEffectEvent, useState } from 'react'
import { Link, Navigate, useParams, useSearchParams } from 'react-router'
import { ApiError } from '../api/client.ts'
import { isUuid } from '../api/ids.ts'
import {
  getIssue,
  type IssueDetail as IssueDetailData,
  type IssueSummary,
  listIssues,
  originLabel,
} from '../api/issues.ts'
import { listMembers } from '../api/members.ts'
import { getProject, type ProjectDetail, screenLabel } from '../api/projects.ts'
import {
  assetUrl,
  getVersion,
  listVersions,
  timeFormat,
  versionLabel,
  type VersionDetail,
  type VersionScreen,
  type VersionSummary,
} from '../api/versions.ts'
import { ErrorText, SessionEnded } from '../components/ErrorText.tsx'
import { ProjectNotFound } from '../components/ProjectNotFound.tsx'
import { useMe } from '../hooks/useMe.ts'
import { IssueComposer } from './IssueComposer.tsx'
import { IssueDetail } from './IssueDetail.tsx'
import { IssueList } from './IssueList.tsx'
import { PhotoCanvas, type PinPosition } from './PhotoCanvas.tsx'
import styles from './ReviewRoomPage.module.css'

const toMessage = (error: unknown): ReactNode => {
  if (!(error instanceof ApiError)) return '연결을 확인하고 다시 시도해 주세요'
  if (error.status === 401) return <SessionEnded />
  return '잠시 뒤 다시 시도해 주세요'
}

const isNotFound = (error: unknown) => error instanceof ApiError && error.status === 404

// 어떤 버전을 불러왔는지 함께 적어 둔다. 버전을 바꾼 직후에는 id가 달라서 이전 버전 화면을 보여 주지 않는다.
type LoadedVersion = { versionId: string; detail?: VersionDetail; missing?: boolean; error?: ReactNode }

type VersionPickerProps = {
  versionId: string
  versions: VersionSummary[]
  isCurrent: boolean
  onSelectVersion: (versionId: string) => void
}

// 제목 옆에 두는 버전 고르기와 상태 표시다.
const VersionPicker = ({ versionId, versions, isCurrent, onSelectVersion }: VersionPickerProps) => (
  <div className={styles.versionControl}>
    <label className={styles.versionPicker}>
      버전
      <select value={versionId} onChange={(event) => onSelectVersion(event.target.value)}>
        {/* 개발자 목록에는 게시 전 버전도 오는데, 검수실은 게시한 버전만 고른다. */}
        {versions.map(
          (item) =>
            item.number !== null && (
              <option key={item.id} value={item.id}>
                {versionLabel(item.number)}
              </option>
            ),
        )}
      </select>
    </label>
    {/* 색만으로 구분하지 않게 글자와 점 모양(채운 점, 빈 점)도 함께 바뀐다. */}
    <span className={styles.status} data-current={isCurrent}>
      <span className={styles.dot} aria-hidden="true" />
      {isCurrent ? '검수 중' : '읽기 전용'}
    </span>
  </div>
)

type VersionViewProps = {
  projectId: string
  version: VersionDetail
  // 왼쪽 목록에서 눌린 화면. 지난 버전 쪽지의 처음 사진을 보는 동안에는 없다.
  selected?: VersionScreen
  isCurrent: boolean
  onSelectScreen: (screenId: string) => void
  canvas: ReactNode
}

// 버전 하나의 틀이다: 위에 설명 줄, 아래에 왼쪽 화면 목록과 사진.
const VersionView = ({ projectId, version, selected, isCurrent, onSelectScreen, canvas }: VersionViewProps) => (
  <>
    {!isCurrent && (
      <p className={styles.notice}>
        지난 버전이에요. 읽기만 할 수 있어요. <Link to={`/projects/${projectId}`}>최신 버전 보기</Link>
      </p>
    )}
    <div className={styles.info}>
      {version.summary && <p className={styles.summary}>{version.summary}</p>}
      {version.publishedAt && (
        <span className={styles.hint}>{timeFormat.format(new Date(version.publishedAt))} 게시</span>
      )}
      {version.testUrl && (
        <a href={version.testUrl} target="_blank" rel="noreferrer">
          테스트 주소
        </a>
      )}
    </div>
    <div className={styles.workspace}>
      <ul className={styles.screens}>
        {version.screens.map((screen, index) => (
          <li key={screen.screenId}>
            <button type="button" aria-pressed={screen === selected} onClick={() => onSelectScreen(screen.screenId)}>
              {/* 화면 이름은 버튼 글자가 알려 줘서 작은 사진은 빈 alt다. 번호도 읽지 않게 숨긴다.
                  1200px 이하에서는 작은 사진을 숨기는데, lazy라서 숨긴 사진은 받지 않는다. */}
              <img className={styles.thumbnail} src={assetUrl(screen.asset.id)} alt="" loading="lazy" />
              <span>
                <strong aria-hidden="true">{String(index + 1).padStart(2, '0')}</strong> {screenLabel(screen)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {canvas}
    </div>
  </>
)

// 새 쪽지의 자리. 좌표만이 아니라 찍은 버전과 화면도 함께 기억해서, 다른 사진에 이 좌표가 쓰이지 않게 한다.
type DraftPin = PinPosition & { versionId: string; screenId: string }

// 어떤 쪽지를 불러왔는지 함께 적어 둔다. 쪽지를 바꾼 직후에는 id가 달라서 이전 쪽지를 보여 주지 않는다.
type LoadedIssue = { id: string; detail?: IssueDetailData; error?: ReactNode }

const REFRESH_MS = 15_000

const ReviewRoom = ({ id }: { id: string }) => {
  const [searchParams, setSearchParams] = useSearchParams()
  const requestedVersionId = searchParams.get('version')
  const requestedIssueId = searchParams.get('issue')
  const isValidId = isUuid(id)
  const { user, error: meError } = useMe()
  const [project, setProject] = useState<ProjectDetail>()
  const [versions, setVersions] = useState<VersionSummary[]>([])
  const [issues, setIssues] = useState<IssueSummary[]>([])
  const [notFound, setNotFound] = useState(false)
  const [loadError, setLoadError] = useState<ReactNode>()
  const [loaded, setLoaded] = useState<LoadedVersion>()
  const [selectedScreenId, setSelectedScreenId] = useState<string>()
  const [needsApprover, setNeedsApprover] = useState(false)
  const [loadedIssue, setLoadedIssue] = useState<LoadedIssue>()
  // 고른 쪽지의 처음 자리를 사진에 보여 주는 중인가. 화면이나 버전을 직접 고르면 꺼진다.
  const [showIssuePlace, setShowIssuePlace] = useState(true)
  const [composing, setComposing] = useState(false)
  const [draftPin, setDraftPin] = useState<DraftPin>()
  // 보낸 쪽지가 저장됐는지 몰라 잠긴 동안에는 화면·버전을 바꿔도 임시 핀을 지우지 않는다(기획 정할 것 12).
  const [composerLocked, setComposerLocked] = useState(false)

  // 로그인 확인을 기다리지 않고 같이 부른다. 하나라도 실패하면 오류 하나로 보여 준다.
  const loadRoom = useCallback(
    () =>
      Promise.all([getProject(id), listVersions(id), listIssues(id)]).then(
        ([loadedProject, loadedVersions, loadedIssues]) => {
          setProject(loadedProject)
          setVersions(loadedVersions)
          setIssues(loadedIssues)
        },
      ),
    [id],
  )

  useEffect(() => {
    if (!isValidId) return
    loadRoom().catch((caught) => {
      // 남의 프로젝트도 서버가 없는 것과 같은 404로 답해서, 있는지조차 알 수 없다.
      if (isNotFound(caught)) return setNotFound(true)
      setLoadError(toMessage(caught))
    })
  }, [isValidId, loadRoom])

  // 승인자가 없어도 고를 클라이언트가 없으면 알리지 않는다. 그래서 참여자 목록에서 클라이언트가 있는지 본다.
  // 참여자 목록은 개발자만 부를 수 있어서(클라이언트는 403) 개발자이고 승인자가 없을 때만 부른다.
  useEffect(() => {
    if (project?.myRole !== 'DEVELOPER' || project.approver) return
    listMembers(id)
      .then(({ members }) => setNeedsApprover(members.some((member) => member.role === 'CLIENT')))
      // 알림은 도움말이라, 목록을 못 불러와도 검수실은 그대로 보여 준다.
      .catch(() => {})
  }, [id, project])

  // 주소에 고른 버전이 없으면 현재 버전을 본다. 빈 값(?version=)은 고른 것으로 보고 아래에서 틀린 id로 거른다.
  const versionId = requestedVersionId ?? project?.currentVersion?.id

  useEffect(() => {
    if (!isValidId || !versionId || !isUuid(versionId)) return
    // 버전을 빠르게 바꾸면 이전 버전 응답이 늦게 올 수 있다. 정리 함수가 그 응답을 버린다.
    let ignore = false
    getVersion(versionId)
      .then((detail) => {
        if (ignore) return
        // 두 프로젝트의 멤버면 다른 프로젝트 버전도 서버가 준다. 게시 전 버전도 개발자에게는 온다.
        // 둘 다 이 검수실의 버전이 아니라서 없는 버전으로 본다.
        // 주소의 id는 대문자여도 서버가 받지만, 서버가 돌려주는 projectId는 늘 소문자라 맞춰서 비교한다.
        const belongsHere = detail.projectId === id.toLowerCase() && detail.status !== 'DRAFT'
        setLoaded(belongsHere ? { versionId, detail } : { versionId, missing: true })
      })
      .catch((caught) => {
        if (ignore) return
        setLoaded(isNotFound(caught) ? { versionId, missing: true } : { versionId, error: toMessage(caught) })
      })
    return () => {
      ignore = true
    }
  }, [id, isValidId, versionId])

  // 주소의 쪽지는 이 프로젝트의 쪽지 목록에 있을 때만 연다. 두 프로젝트의 멤버면 다른 프로젝트의 쪽지 상세도
  // 서버가 주기 때문에, 상세를 부르기 전에 목록으로 거른다. 주소의 id는 대문자일 수 있어서 소문자로 맞춘다.
  const openIssue = issues.find((issue) => issue.id === requestedIssueId?.toLowerCase())
  const openIssueId = openIssue?.id

  useEffect(() => {
    if (!openIssueId) return
    // 쪽지를 빠르게 바꾸면 이전 쪽지 응답이 늦게 올 수 있다. 정리 함수가 그 응답을 버린다.
    let ignore = false
    getIssue(openIssueId).then(
      (detail) => {
        if (!ignore) setLoadedIssue({ id: openIssueId, detail })
      },
      (caught) => {
        if (!ignore) setLoadedIssue({ id: openIssueId, error: toMessage(caught) })
      },
    )
    return () => {
      ignore = true
    }
  }, [openIssueId])

  // 다른 사람이 쓴 쪽지와 댓글이 새로고침 없이 보이게 한다. 쪽지 목록과 열어 둔 쪽지만 다시 부르고,
  // 프로젝트와 버전은 부르지 않는다. 보던 버전이 저절로 바뀌면 쓰던 글과 핀이 흔들리기 때문이다.
  // 새 버전이 올라왔는지는 쓰기 요청의 409로 안다(기획 정할 것 4).
  // 도움 기능이라 실패해도 알리지 않고 보던 내용을 그대로 둔다. 다음 차례에 다시 부른다.
  const refreshList = () => {
    listIssues(id).then(setIssues, () => {})
  }

  const refreshIssues = () => {
    refreshList()
    if (!openIssueId) return
    getIssue(openIssueId).then(
      // 응답이 오는 사이 다른 쪽지로 바꿨으면 버린다.
      (detail) => setLoadedIssue((shown) => (shown?.id === detail.id ? { id: detail.id, detail } : shown)),
      () => {},
    )
  }

  // 타이머는 한 번만 걸고, 울릴 때마다 그때의 쪽지(openIssueId)로 새로 부른다.
  const refreshIfVisible = useEffectEvent(() => {
    if (document.visibilityState === 'visible') refreshIssues()
  })

  useEffect(() => {
    if (!isValidId) return
    const timer = setInterval(() => refreshIfVisible(), REFRESH_MS)
    return () => clearInterval(timer)
  }, [isValidId])

  if (user === null) return <Navigate to="/login" replace />
  // 확인 중 오류여도 로그인 화면으로 보내지 않는다. 서버가 잠깐 멈춘 것일 수 있다.
  if (user === undefined) return <p>{meError ?? '확인하는 중이에요.'}</p>
  if (!isValidId || notFound) return <ProjectNotFound />
  if (loadError) return <ErrorText message={loadError} />
  if (!project) return <p>불러오는 중이에요.</p>

  const isDeveloper = project.myRole === 'DEVELOPER'
  // 현재 버전은 가장 최근에 게시한 버전이라, 다음 차수는 그 번호 + 1이다.
  const nextLabel = versionLabel(project.currentVersion ? project.currentVersion.number + 1 : 0)
  const current = loaded?.versionId === versionId ? loaded : undefined
  const detail = current?.detail
  // 볼 버전이 있는가. 게시한 버전이 없거나, 주소의 버전이 틀렸거나 없는 버전이면 거짓이다. 불러오는 중이면 참이다.
  const hasVersion = versionId !== undefined && isUuid(versionId) && !current?.missing
  const isCurrent = detail?.id === project.currentVersion?.id
  // 쓸 수 있는지는 위에서 고른 버전으로 판단한다: 현재 버전이고 검수 중일 때. 쪽지가 어느 버전에서 시작했는지는 보지 않는다.
  const canWrite = isCurrent && detail?.status === 'IN_REVIEW'

  // 고른 쪽지의 처음 자리. 보고 있는 버전의 화면이면 그 화면을 고른 것으로 보고, 다른 버전의 화면이면 그 처음 사진을 따로 보여 준다.
  const shownOrigin = showIssuePlace ? openIssue?.origin : undefined
  const originInViewedVersion = openIssue?.originVersion.id === detail?.id
  const olderVersionOrigin = shownOrigin && !originInViewedVersion ? shownOrigin : undefined
  // 버전을 바꿔도 같은 화면(예: 메인 · PC)을 이어서 보여 줘서, 차수끼리 비교하기 쉽다. 그 화면이 없으면 첫 화면이다.
  const wantedScreenId = shownOrigin && originInViewedVersion ? shownOrigin.screenId : selectedScreenId
  const selected = detail?.screens.find((screen) => screen.screenId === wantedScreenId) ?? detail?.screens[0]

  // 쓰기와 고르기에서 주소의 쪽지·버전을 바꾼다. 다른 값은 그대로 둔다.
  const setParam = (name: 'issue' | 'version', value?: string) =>
    setSearchParams((params) => {
      const next = new URLSearchParams(params)
      if (value === undefined) next.delete(name)
      else next.set(name, value)
      return next
    })

  // 아직 보내지 않은 글의 핀은 화면이나 버전을 바꾸면 지운다(글은 쓰기 칸에 남는다). A 사진의 자리가 B 사진의 쪽지로
  // 저장되지 않게 하려는 것이다. 이미 보내서 잠긴 요청의 핀은 건드리지 않는다(기획 정할 것 11·12).
  const dropDraftPin = () => {
    if (!composerLocked) setDraftPin(undefined)
  }

  const selectScreen = (screenId: string) => {
    setSelectedScreenId(screenId)
    setShowIssuePlace(false)
    dropDraftPin()
  }

  const selectVersion = (nextId: string) => {
    // 처음에 저절로 보인 첫 화면도 "보던 화면"으로 붙잡아 둔다. 안 그러면 새 버전의 첫 화면으로 바뀐다.
    if (selected) setSelectedScreenId(selected.screenId)
    setShowIssuePlace(false)
    dropDraftPin()
    setParam('version', nextId)
  }

  const selectIssue = (issueId: string) => {
    setShowIssuePlace(true)
    setParam('issue', issueId)
  }

  const startComposing = (pin?: DraftPin) => {
    setDraftPin(pin)
    setComposing(true)
    setParam('issue')
  }

  const closeComposer = () => {
    setComposing(false)
    setDraftPin(undefined)
    setComposerLocked(false)
  }

  // 새 버전 409 뒤에 누른다. 프로젝트를 다시 불러 최신 버전을 알아내고 그 버전으로 간다. 쓰던 글은 그대로다.
  // 다시 불러오기가 실패하면 아무것도 바꾸지 않는다. 화면 전체를 오류로 바꾸면 쓰던 글이 사라진다. 한 번 더 누르면 된다.
  const goLatest = () => {
    loadRoom().then(
      () => {
        dropDraftPin()
        setShowIssuePlace(false)
        setParam('version')
      },
      () => {},
    )
  }

  const renderCanvas = (version: VersionDetail) => {
    if (olderVersionOrigin && openIssue) {
      return (
        <PhotoCanvas
          caption={<span>처음 위치 · {originLabel(openIssue)}</span>}
          notice={`이 쪽지는 ${versionLabel(openIssue.originVersion.number)}에 남긴 요청이에요. 처음 사진의 위치를 보여 드려요.`}
          asset={olderVersionOrigin.asset}
          alt={screenLabel({ name: olderVersionOrigin.screenName, viewport: olderVersionOrigin.viewport })}
          pins={[{ id: openIssue.id, number: openIssue.number, title: openIssue.title, ...olderVersionOrigin }]}
          selectedPinId={openIssue.id}
          onSelectPin={selectIssue}
        />
      )
    }
    if (!selected) return null
    const pins = issues.flatMap((issue) =>
      issue.origin && issue.originVersion.id === version.id && issue.origin.screenId === selected.screenId
        ? [{ id: issue.id, number: issue.number, title: issue.title, ...issue.origin }]
        : [],
    )
    const pinIsHere = draftPin?.versionId === version.id && draftPin.screenId === selected.screenId
    // 새 핀은 쓸 수 있는 버전의 사진에만 찍는다. 잠긴 동안에는 처음 보낸 자리를 바꾸지 않는다.
    const canPlacePin = canWrite && !composerLocked
    return (
      <PhotoCanvas
        caption={
          <>
            {/* 검수실에는 게시한 버전만 와서 번호가 늘 있다. 타입이 null을 허용해서 확인만 한다. */}
            <span>
              {version.number !== null && `${versionLabel(version.number)} · `}
              {screenLabel(selected)}
            </span>
            <span>
              사진 {version.screens.indexOf(selected) + 1} / {version.screens.length}
            </span>
          </>
        }
        asset={selected.asset}
        alt={screenLabel(selected)}
        pins={pins}
        selectedPinId={openIssueId}
        draftPin={pinIsHere ? draftPin : undefined}
        // 쓰는 중에는 핀을 눌러도 다른 쪽지로 넘어가지 않는다. 쓰던 글이 사라지지 않게 하려는 것이다.
        onSelectPin={composing ? () => {} : selectIssue}
        onPlacePin={
          canPlacePin
            ? (position) => startComposing({ ...position, versionId: version.id, screenId: selected.screenId })
            : undefined
        }
      />
    )
  }

  // 쪽지 칸은 버전을 불러오는 동안에도 그대로 남는다. 그래서 버전 상세가 아니라 고른 버전의 id만 쓴다.
  // 버전을 바꾸는 사이 이 칸이 사라졌다 다시 그려지면 쓰던 글과 잠긴 요청이 지워진다.
  const renderPanel = (shownVersionId: string) => {
    if (composing) {
      const pinScreen = detail?.screens.find((screen) => screen.screenId === draftPin?.screenId)
      return (
        <IssueComposer
          projectId={id}
          versionId={shownVersionId}
          canSubmit={canWrite}
          pin={draftPin && { ...draftPin, label: pinScreen ? screenLabel(pinScreen) : '' }}
          onClearPin={() => setDraftPin(undefined)}
          onCancel={closeComposer}
          onCreated={(issue) => {
            closeComposer()
            setLoadedIssue({ id: issue.id, detail: issue })
            setIssues((list) => [issue, ...list.filter((item) => item.id !== issue.id)])
            selectIssue(issue.id)
          }}
          onLockChange={setComposerLocked}
          onGoLatest={goLatest}
        />
      )
    }
    const shownIssue = loadedIssue?.id === openIssueId ? loadedIssue : undefined
    return (
      <>
        <IssueList
          issues={issues}
          selectedId={openIssueId}
          onSelect={selectIssue}
          onCompose={canWrite ? () => startComposing() : undefined}
        />
        {requestedIssueId !== null && !openIssue && <p className={styles.panelMessage}>없는 쪽지예요.</p>}
        {shownIssue?.error && (
          <div className={styles.panelMessage}>
            <ErrorText message={shownIssue.error} />
          </div>
        )}
        {openIssue && shownIssue && !shownIssue.detail && !shownIssue.error && (
          <p className={styles.panelMessage}>쪽지를 불러오는 중이에요.</p>
        )}
        {shownIssue?.detail && (
          <IssueDetail
            // 쪽지를 바꾸면 쓰던 댓글과 잠금이 다음 쪽지로 넘어가지 않게 새로 시작한다. 버전만 바꾸면 그대로 남는다.
            key={shownIssue.detail.id}
            issue={shownIssue.detail}
            versionId={shownVersionId}
            canWrite={canWrite}
            isDeveloper={isDeveloper}
            // 서버가 바뀐 쪽지를 이미 돌려줬으니 상세는 다시 부르지 않고, 목록(상태·댓글 수)만 새로 부른다.
            onChanged={(issue) => {
              setLoadedIssue({ id: issue.id, detail: issue })
              refreshList()
            }}
            onRefresh={refreshIssues}
            onGoLatest={goLatest}
            onClose={() => setParam('issue')}
          />
        )}
      </>
    )
  }

  const renderBody = () => {
    if (versionId === undefined) {
      return (
        <div className={styles.message}>
          <h2>아직 게시한 버전이 없어요.</h2>
          {isDeveloper ? (
            <>
              <p>화면 사진을 준비해서 첫 버전을 게시해 주세요.</p>
              <Link className={styles.messageAction} to={`/projects/${id}/draft`}>
                {nextLabel} 준비
              </Link>
            </>
          ) : (
            <p>개발자가 버전을 게시하면 여기서 확인할 수 있어요.</p>
          )}
        </div>
      )
    }
    if (!isUuid(versionId) || current?.missing) {
      return (
        <div className={styles.message}>
          <h2>없는 버전이에요</h2>
          <p>주소가 맞는지 확인해 주세요.</p>
          <Link to={`/projects/${id}`}>최신 버전 보기</Link>
        </div>
      )
    }
    if (current?.error) {
      return (
        <div className={styles.message}>
          <ErrorText message={current.error} />
        </div>
      )
    }
    if (!detail) return <p className={styles.message}>불러오는 중이에요.</p>
    return (
      <VersionView
        projectId={id}
        version={detail}
        selected={olderVersionOrigin ? undefined : selected}
        isCurrent={isCurrent}
        onSelectScreen={selectScreen}
        canvas={renderCanvas(detail)}
      />
    )
  }

  return (
    <section className={styles.room}>
      <div className={styles.top}>
        <div className={styles.heading}>
          <h1>{project.name}</h1>
          {detail && (
            <VersionPicker
              versionId={detail.id}
              versions={versions}
              isCurrent={isCurrent}
              onSelectVersion={selectVersion}
            />
          )}
        </div>
        <nav className={styles.links}>
          <Link to="/">프로젝트 목록</Link>
          <Link to={`/projects/${id}/activity`}>활동 일지</Link>
          {isDeveloper && <Link to={`/projects/${id}/draft`}>{nextLabel} 준비</Link>}
          {isDeveloper && <Link to={`/projects/${id}/settings`}>설정</Link>}
        </nav>
      </div>
      {needsApprover && (
        <p className={styles.notice}>
          승인자를 정해 주세요. <Link to={`/projects/${id}/settings`}>설정으로 가기</Link>
        </p>
      )}
      {/* 볼 버전이 있을 때만 쪽지 칸을 둔다(게시한 버전이 없거나 없는 버전이면 쪽지를 쓸 곳이 없다). */}
      {hasVersion ? (
        <div className={styles.stage}>
          <div className={styles.main}>{renderBody()}</div>
          <aside className={styles.inspector} aria-label="쪽지">
            {renderPanel(versionId)}
          </aside>
        </div>
      ) : (
        renderBody()
      )}
    </section>
  )
}

// 다른 프로젝트 검수실로 바로 가면 React가 이 화면을 다시 써서 이전 프로젝트의 제목·사진이 남는다.
// key를 id로 주면 id가 바뀔 때 새로 시작하고, 이전 화면에 늦게 온 응답은 버려진다.
export const ReviewRoomPage = () => {
  const { id = '' } = useParams()
  return <ReviewRoom key={id} id={id} />
}
