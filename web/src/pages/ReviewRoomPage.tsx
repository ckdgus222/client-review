import { type ReactNode, useCallback, useEffect, useEffectEvent, useRef, useState } from 'react'
import { Link, Navigate, useParams, useSearchParams } from 'react-router'
import { ApiError } from '../api/client.ts'
import { isUuid } from '../api/ids.ts'
import {
  getIssue,
  type IssueComment,
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
import { Button } from '../components/Button.tsx'
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
  version: VersionDetail
  // 왼쪽 목록에서 눌린 화면. 지난 버전 쪽지의 처음 사진을 보는 동안에는 없다.
  selected?: VersionScreen
  isCurrent: boolean
  // 최신 버전으로 가는 주소의 ? 뒷부분. 고른 버전만 빼고 나머지(열어 둔 쪽지)는 그대로다.
  latestSearch: string
  onLeaveVersion: () => void
  onSelectScreen: (screenId: string) => void
  canvas: ReactNode
}

// 버전 하나의 틀이다: 위에 설명 줄, 아래에 왼쪽 화면 목록과 사진.
const VersionView = ({
  version,
  selected,
  isCurrent,
  latestSearch,
  onLeaveVersion,
  onSelectScreen,
  canvas,
}: VersionViewProps) => (
  <>
    {!isCurrent && (
      <p className={styles.notice}>
        지난 버전이에요. 읽기만 할 수 있어요.{' '}
        <Link to={{ search: latestSearch }} onClick={onLeaveVersion}>
          최신 버전 보기
        </Link>
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
  // 쪽지를 보내는 중이거나, 보낸 쪽지가 저장됐는지 몰라 잠긴 동안이다. 이때는 임시 핀을 옮기지도 지우지도 않는다(기획 정할 것 12).
  const [composerLocked, setComposerLocked] = useState(false)
  // 열어 둔 쪽지에 아직 저장되지 않은 댓글 글이 있는가(쓰는 중, 보내는 중, 잠김). 새 쪽지 쓰기로 넘어가기 전에 묻는 데 쓴다.
  const [hasCommentDraft, setHasCommentDraft] = useState(false)

  // 주소의 지금 값. 늦게 끝난 요청의 콜백(쪽지를 만든 뒤 그 쪽지 열기, 최신 버전으로 가기)이 주소를 바꿀 때 쓴다.
  // 그런 콜백은 요청을 시작한 때의 주소를 기억하고 있어서(setSearchParams에 함수를 넘겨도 같다), 그대로 쓰면
  // 기다리는 사이 연 다른 쪽지나 고른 버전을 옛 값으로 되돌린다.
  // 검수실을 떠나면 비운다(setParam 참고).
  const latestParams = useRef<URLSearchParams | undefined>(searchParams)
  // 볼 버전이 바뀐 횟수. goLatest가 기다리는 사이 사용자가 버전을 바꿨는지 이것으로 안다. 주소의 버전 값만 비교하면
  // 다른 버전에 갔다가 원래 버전으로 돌아온 것을 놓친다. 두 곳에서 센다: 사용자가 직접 고를 때(leaveVersion, 누른 바로
  // 그때)와 주소의 버전이 바뀐 것을 알았을 때(아래 effect. 브라우저의 뒤로·앞으로 가기는 여기서만 잡힌다).
  const versionChanges = useRef(0)
  useEffect(() => {
    // setParam으로 바꾼 주소는 latestParams에 이미 적혀 있어서 여기서 다시 세지 않는다.
    if (latestParams.current?.get('version') !== searchParams.get('version')) versionChanges.current += 1
    latestParams.current = searchParams
  }, [searchParams])
  useEffect(
    () => () => {
      latestParams.current = undefined
    },
    [],
  )

  // 쪽지 목록과 상세를 부를 때마다 번호를 매겨, 가장 나중에 시작한 요청의 응답만 받는다. 쪽지를 만들거나 바꾸거나 닫은 뒤에도
  // 번호를 올려서, 그보다 먼저 시작한 요청의 응답(방금 만든 쪽지나 방금 바뀐 내용이 빠져 있다)이 늦게 와도 버린다.
  // 상세는 가장 나중에 연 쪽지가 무엇인지도 함께 적는다. 늦게 끝난 요청의 콜백은 그 요청을 시작한 때의 쪽지를
  // 기억하고 있어서, 그사이 다른 쪽지를 열었는지는 화면 상태가 아니라 이 값으로 확인한다.
  const listRequest = useRef(0)
  const detailRequest = useRef({ issueId: '', number: 0 })
  // 상세 요청의 번호를 화면 상태로도 둔다. 수정 시작·참고 사진 버튼을 누른 때의 번호를 그 요청의 콜백이 기억하게
  // 하려는 것이다(applyChange). ref는 늘 지금 값이라서, 콜백이 읽으면 누른 때가 아니라 응답이 온 때의 번호가 나온다.
  const [detailNumber, setDetailNumber] = useState(0)

  // 상세 요청을 새로 시작한다고 적는다. 이보다 먼저 시작한 요청의 응답은 이제 받지 않는다.
  const startDetailRequest = useCallback((issueId: string) => {
    const number = detailRequest.current.number + 1
    detailRequest.current = { issueId, number }
    setDetailNumber(number)
    return number
  }, [])

  // 로그인 확인을 기다리지 않고 같이 부른다. 하나라도 실패하면 오류 하나로 보여 준다.
  // 쪽지 목록에는 위의 번호를 함께 쓴다. 안 그러면 먼저 시작한 15초 새로 부르기의 늦은 응답이 여기서 받은 목록을
  // 덮어써서, 방금 열린 쪽지가 목록에서 빠지고 그 상세와 쓰던 댓글이 사라진다.
  const loadRoom = useCallback(() => {
    const request = ++listRequest.current
    return Promise.all([getProject(id), listVersions(id), listIssues(id)]).then(
      ([loadedProject, loadedVersions, loadedIssues]) => {
        setProject(loadedProject)
        setVersions(loadedVersions)
        if (listRequest.current === request) setIssues(loadedIssues)
      },
    )
  }, [id])

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
    // "최신 버전 보기"가 프로젝트를 다시 불러오면 한 번 더 부른다. 정리 함수가 먼저 부른 요청의 늦은 응답을 버린다.
    let ignore = false
    listMembers(id)
      .then(({ members }) => {
        if (!ignore) setNeedsApprover(members.some((member) => member.role === 'CLIENT'))
      })
      // 알림은 도움말이라, 목록을 못 불러와도 검수실은 그대로 보여 준다.
      .catch(() => {})
    return () => {
      ignore = true
    }
  }, [id, project])

  // 주소에 고른 버전이 없으면 현재 버전을 본다. 빈 값(?version=)은 고른 것으로 보고 아래에서 틀린 id로 거른다.
  const versionId = requestedVersionId ?? project?.currentVersion?.id

  // 올리면 보던 버전과 같은 버전이어도 상세를 다시 부른다. "최신 버전 보기"(goLatest)가 프로젝트를 다시 불러오는 데
  // 성공할 때와, 사진을 못 불러온 화면의 "다시 시도"가 올린다. 이것 없이는 같은 버전이라 다시 부르지 않아서, 사진도
  // 버전 고르기도 없는 화면에서 새로 고침 말고는 빠져나올 길이 없다(쓰던 글이 사라진다).
  const [versionReloads, setVersionReloads] = useState(0)
  // goLatest가 프로젝트를 다시 불러오는 중인가.
  const loadingLatest = useRef(false)

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
        if (isNotFound(caught)) return setLoaded({ versionId, missing: true })
        // 같은 버전을 다시 부르다 실패했으면(goLatest) 보여 주던 사진을 그대로 둔다.
        setLoaded((shown) =>
          shown?.versionId === versionId && shown.detail ? shown : { versionId, error: toMessage(caught) },
        )
      })
    return () => {
      ignore = true
    }
  }, [id, isValidId, versionId, versionReloads])

  // 주소의 쪽지는 이 프로젝트의 쪽지 목록에 있을 때만 연다. 두 프로젝트의 멤버면 다른 프로젝트의 쪽지 상세도
  // 서버가 주기 때문에, 상세를 부르기 전에 목록으로 거른다. 주소의 id는 대문자일 수 있어서 소문자로 맞춘다.
  const openIssue = issues.find((issue) => issue.id === requestedIssueId?.toLowerCase())
  const openIssueId = openIssue?.id

  // 쪽지를 처음 열 때와 새로 부를 때(15초마다, 댓글을 남긴 뒤, 쪽지 상태가 달라져 있을 때, 쓰기 응답을 버렸을 때) 함께 쓴다.
  const loadIssue = useCallback(
    (issueId: string) => {
      const number = startDetailRequest(issueId)
      getIssue(issueId).then(
        (detail) => {
          if (detailRequest.current.number === number) setLoadedIssue({ id: issueId, detail })
        },
        (caught) => {
          if (detailRequest.current.number !== number) return
          // 보여 주던 상세가 있으면 그대로 둔다. 새로 부르기는 도움 기능이라, 실패했다고 보던 쪽지와 쓰던 댓글을 치우지 않는다.
          // 보여 줄 상세가 없을 때만 오류를 알린다.
          setLoadedIssue((shown) =>
            shown?.id === issueId && shown.detail ? shown : { id: issueId, error: toMessage(caught) },
          )
        },
      )
    },
    [startDetailRequest],
  )

  useEffect(() => {
    if (openIssueId) loadIssue(openIssueId)
    // 쪽지를 닫으면 번호만 올려서, 닫기 전에 시작한 요청의 응답을 버린다. 그 응답이 늦게 오면 그사이 새로 만든 쪽지의 상세를 덮어쓴다.
    else startDetailRequest('')
  }, [openIssueId, loadIssue, startDetailRequest])

  // 다른 사람이 쓴 쪽지와 댓글이 새로고침 없이 보이게 한다. 쪽지 목록과 열어 둔 쪽지만 다시 부르고,
  // 프로젝트와 버전은 부르지 않는다. 보던 버전이 저절로 바뀌면 쓰던 글과 핀이 흔들리기 때문이다.
  // 새 버전이 올라왔는지는 쓰기 요청의 409로 안다(기획 정할 것 4).
  // 도움 기능이라 실패해도 보던 내용을 그대로 둔다. 다음 차례에 다시 부른다.
  const refreshList = () => {
    const request = ++listRequest.current
    listIssues(id).then(
      (list) => {
        if (listRequest.current === request) setIssues(list)
      },
      () => {},
    )
  }

  // issueId는 부르는 쪽이 보고 있던 쪽지다. 그사이 다른 쪽지를 열었으면 목록만 새로 부른다.
  // 그때 상세까지 부르면 지금 연 쪽지의 요청이 밀려나고, 그 쪽지의 상세와 쓰던 댓글이 화면에서 사라진다.
  const refreshIssues = (issueId?: string) => {
    refreshList()
    if (issueId && detailRequest.current.issueId === issueId) loadIssue(issueId)
  }

  // 수정 시작·참고 사진의 응답(서버가 돌려준 바뀐 쪽지)을 화면에 쓴다. startedAt은 그 버튼을 누른 때의 상세 요청 번호다.
  const applyChange = (issue: IssueDetailData, startedAt: number) => {
    // 목록에 보이는 상태도 바뀌었으니 목록은 늘 새로 부른다.
    refreshList()
    const open = detailRequest.current
    // 응답을 기다리는 사이 다른 쪽지를 열었으면 그 쪽지의 상세도, 그 쪽지를 부르는 요청도 건드리지 않는다.
    // 건드리면 지금 보는 쪽지와 쓰던 댓글이 화면에서 사라진다.
    if (open.issueId !== issue.id) return
    // 누른 뒤에 이 쪽지를 새로 부른 적이 있으면(댓글을 남긴 뒤, 15초마다 등) 이 응답을 버리고 다시 부른다.
    // 서버가 이 요청을 그 새로 부르기보다 먼저 처리했을 수 있어서, 그대로 쓰면 방금 보이던 댓글이 화면에서 사라진다.
    if (open.number !== startedAt) return loadIssue(issue.id)
    // 누르기 전에 시작한 요청의 응답(바뀌기 전 내용)이 아직 안 왔으면, 번호를 올려서 버린다.
    startDetailRequest(issue.id)
    setLoadedIssue({ id: issue.id, detail: issue })
  }

  // 저장된 댓글을 보이는 상세에 바로 붙인다. 뒤따르는 새로 부르기가 실패해도 댓글이 보여서, 저장이 안 된 줄 알고
  // 한 번 더 쓰지 않는다(댓글은 지울 수 없다). 새로 부르기가 이 댓글을 먼저 받아 왔으면 붙이지 않는다.
  const addComment = (issueId: string, comment: IssueComment) =>
    setLoadedIssue((shown) => {
      if (shown?.id !== issueId || !shown.detail) return shown
      if (shown.detail.comments.some((item) => item.id === comment.id)) return shown
      return { ...shown, detail: { ...shown.detail, comments: [...shown.detail.comments, comment] } }
    })

  // 타이머는 한 번만 걸고, 울릴 때마다 그때의 쪽지(openIssueId)로 새로 부른다.
  // 처음 불러오기가 끝나기 전에는 부르지 않는다. 먼저 부르면 목록 요청 번호가 올라가서, 처음 불러오기가 받아 온 쪽지 목록이 버려진다.
  const refreshIfVisible = useEffectEvent(() => {
    if (project && document.visibilityState === 'visible') refreshIssues(openIssueId)
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
  // 임시 핀은 찍은 버전·화면의 사진을 보는 동안에만 보이고, 그때만 쓰기 칸에 넘긴다. 보이지 않는 핀이 보내지지 않게 하려는 것이다.
  // 보내는 중이거나 잠긴 요청은 쓰기 칸이 처음 보낸 그대로 기억하고 있어서, 여기 값과 상관없이 처음 자리로 다시 간다.
  const shownDraftPin =
    draftPin?.versionId === detail?.id && draftPin?.screenId === selected?.screenId ? draftPin : undefined

  // 쓰기와 고르기에서 주소의 쪽지·버전을 바꾼다. 다른 값은 그대로 둔다. 지금 주소(latestParams)에서 바꾼다.
  const setParam = (name: 'issue' | 'version', value?: string) => {
    // 검수실을 떠난 뒤에 끝난 요청의 콜백이면 주소를 바꾸지 않는다. 바꾸면 다른 페이지로 간 사용자를 검수실로 다시 끌고 온다.
    if (!latestParams.current) return
    const next = new URLSearchParams(latestParams.current)
    if (value === undefined) next.delete(name)
    else next.set(name, value)
    latestParams.current = next
    setSearchParams(next)
  }

  // 아직 보내지 않은 글의 핀은 화면이나 버전을 고르면 지운다(글은 쓰기 칸에 남는다. goLatest만 지우지 않고 감춘다). A 사진의 자리가 B 사진의 쪽지로
  // 저장되지 않게 하려는 것이다. 보내는 중이거나 잠긴 요청의 핀은 건드리지 않는다(기획 정할 것 11·12).
  const dropDraftPin = () => {
    if (!composerLocked) setDraftPin(undefined)
  }

  const selectScreen = (screenId: string) => {
    setSelectedScreenId(screenId)
    setShowIssuePlace(false)
    dropDraftPin()
  }

  // 보던 버전을 떠날 때 한다. 버전 고르기와 지난 버전의 "최신 버전 보기" 링크가 함께 쓴다.
  const leaveVersion = () => {
    versionChanges.current += 1
    // 처음에 저절로 보인 첫 화면도 "보던 화면"으로 붙잡아 둔다. 안 그러면 새 버전의 첫 화면으로 바뀐다.
    if (selected) setSelectedScreenId(selected.screenId)
    setShowIssuePlace(false)
    dropDraftPin()
  }

  const selectVersion = (nextId: string) => {
    leaveVersion()
    setParam('version', nextId)
  }

  const selectIssue = (issueId: string) => {
    setShowIssuePlace(true)
    setParam('issue', issueId)
  }

  const startComposing = (pin?: DraftPin) => {
    // 새 쪽지를 쓰면 열어 둔 쪽지가 닫혀서 쓰던 댓글이 사라진다. 사진을 잘못 눌러도 글을 잃지 않게 먼저 묻는다(기획 정할 것 13).
    if (hasCommentDraft && !window.confirm('쓰던 댓글이 사라져요. 새 쪽지를 쓸까요?')) return
    // 쪽지를 열어서 그 쪽지의 화면을 보던 중이면, 그 화면을 "고른 화면"으로 붙잡아 둔다. 주소에서 쪽지를 지우면
    // 화면을 고른 근거도 사라져서 첫 화면으로 돌아가고, 방금 찍은 핀이 다른 사진의 쪽지로 보내진다.
    if (selected) setSelectedScreenId(selected.screenId)
    setShowIssuePlace(false)
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
  // 응답이 온 뒤의 일은 누른 때의 화면 상태를 읽지 않는다. 기다리는 사이 다른 쪽지를 열거나 쪽지를 보냈을 수 있다.
  // 그래서 임시 핀은 여기서 지우지 않는다. 핀은 찍은 버전의 사진에서만 보이고 보내져서(shownDraftPin),
  // 새 버전으로 가면 저절로 빠진다.
  // 불러오는 중에 한 번 더 누르면 받지 않는다. 요청이 둘이면 먼저 보낸 요청의 응답이 나중에 와서,
  // 더 새 버전을 보여 주던 화면을 그 전 버전으로 되돌릴 수 있다.
  // 기다리는 사이 사용자가 볼 버전을 바꿨으면(고르기, 링크, 뒤로·앞으로 가기) 그 선택을 둔다.
  // 나중에 한 선택을 먼저 누른 버튼이 뒤집지 않는다.
  const goLatest = () => {
    if (loadingLatest.current) return
    loadingLatest.current = true
    const changesAtPress = versionChanges.current
    loadRoom()
      .then(
        () => {
          setVersionReloads((count) => count + 1)
          if (versionChanges.current !== changesAtPress) return
          setShowIssuePlace(false)
          setParam('version')
        },
        () => {},
      )
      .finally(() => {
        loadingLatest.current = false
      })
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
    // 새 핀은 쓸 수 있는 버전의 사진에만 찍는다. 보내는 중이거나 잠긴 동안에는 처음 보낸 자리를 바꾸지 않는다.
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
        draftPin={shownDraftPin}
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
      const pinScreen = detail?.screens.find((screen) => screen.screenId === shownDraftPin?.screenId)
      return (
        <IssueComposer
          projectId={id}
          versionId={shownVersionId}
          canSubmit={canWrite}
          versionLoaded={detail !== undefined}
          pin={shownDraftPin && { ...shownDraftPin, label: pinScreen ? screenLabel(pinScreen) : '' }}
          onClearPin={() => setDraftPin(undefined)}
          onCancel={closeComposer}
          onCreated={(issue) => {
            listRequest.current += 1
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
        {/* 고른 쪽지를 아직 받지 못했다. 느린 연결에서 빈칸으로 보이지 않게 돌아가는 동그라미와 글자를 보여 준다. */}
        {openIssue && !shownIssue && (
          <p className={`${styles.panelMessage} ${styles.loading}`} role="status">
            <span className={styles.spinner} aria-hidden="true" />
            쪽지를 불러오는 중이에요
          </p>
        )}
        {shownIssue?.detail && (
          <IssueDetail
            // 쪽지를 바꾸면 쓰던 댓글과 잠금이 다음 쪽지로 넘어가지 않게 새로 시작한다. 버전만 바꾸면 그대로 남는다.
            key={shownIssue.detail.id}
            issue={shownIssue.detail}
            versionId={shownVersionId}
            canWrite={canWrite}
            versionLoaded={detail !== undefined}
            isDeveloper={isDeveloper}
            // 누른 때의 번호를 넘긴다(applyChange).
            onChanged={(issue) => applyChange(issue, detailNumber)}
            onCommented={(comment) => addComment(shownIssue.id, comment)}
            onRefresh={() => refreshIssues(shownIssue.id)}
            onDraftChange={setHasCommentDraft}
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
          {/* 사진을 못 불러와도 쪽지 칸에는 쓰던 글이 남아 있다. 새로 고침 없이 다시 불러올 길을 둔다. */}
          <Button variant="secondary" onClick={() => setVersionReloads((count) => count + 1)}>
            다시 시도
          </Button>
        </div>
      )
    }
    if (!detail) return <p className={styles.message}>불러오는 중이에요.</p>
    const searchWithoutVersion = new URLSearchParams(searchParams)
    searchWithoutVersion.delete('version')
    return (
      <VersionView
        version={detail}
        selected={olderVersionOrigin ? undefined : selected}
        isCurrent={isCurrent}
        latestSearch={searchWithoutVersion.toString()}
        onLeaveVersion={leaveVersion}
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
      {/* 프로젝트를 다시 불러와 승인자가 생겼으면 알리지 않는다. */}
      {needsApprover && !project.approver && (
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
