import { type ReactNode, useEffect, useState } from 'react'
import { Link, Navigate, useParams, useSearchParams } from 'react-router'
import { ApiError } from '../api/client.ts'
import { isUuid } from '../api/ids.ts'
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
  selected?: VersionScreen
  isCurrent: boolean
  onSelectScreen: (screenId: string) => void
}

const VersionView = ({ projectId, version, selected, isCurrent, onSelectScreen }: VersionViewProps) => (
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
      {selected && (
        <div className={styles.canvas}>
          <p className={styles.caption}>
            {/* 검수실에는 게시한 버전만 와서 번호가 늘 있다. 타입이 null을 허용해서 확인만 한다. */}
            <span>
              {version.number !== null && `${versionLabel(version.number)} · `}
              {screenLabel(selected)}
            </span>
            <span>
              사진 {version.screens.indexOf(selected) + 1} / {version.screens.length}
            </span>
          </p>
          <div className={styles.photo}>
            <img
              src={assetUrl(selected.asset.id)}
              width={selected.asset.width}
              height={selected.asset.height}
              alt={screenLabel(selected)}
            />
          </div>
        </div>
      )}
    </div>
  </>
)

const ReviewRoom = ({ id }: { id: string }) => {
  const [searchParams, setSearchParams] = useSearchParams()
  const requestedVersionId = searchParams.get('version')
  const isValidId = isUuid(id)
  const { user, error: meError } = useMe()
  const [project, setProject] = useState<ProjectDetail>()
  const [versions, setVersions] = useState<VersionSummary[]>([])
  const [notFound, setNotFound] = useState(false)
  const [loadError, setLoadError] = useState<ReactNode>()
  const [loaded, setLoaded] = useState<LoadedVersion>()
  const [selectedScreenId, setSelectedScreenId] = useState<string>()

  // 로그인 확인을 기다리지 않고 같이 부른다. 둘 중 하나라도 실패하면 오류 하나로 보여 준다.
  useEffect(() => {
    if (!isValidId) return
    Promise.all([getProject(id), listVersions(id)])
      .then(([loadedProject, loadedVersions]) => {
        setProject(loadedProject)
        setVersions(loadedVersions)
      })
      .catch((caught) => {
        // 남의 프로젝트도 서버가 없는 것과 같은 404로 답해서, 있는지조차 알 수 없다.
        if (isNotFound(caught)) return setNotFound(true)
        setLoadError(toMessage(caught))
      })
  }, [id, isValidId])

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
        const belongsHere = detail.projectId === id && detail.status !== 'DRAFT'
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
  // 버전을 바꿔도 같은 화면(예: 메인 · PC)을 이어서 보여 줘서, 차수끼리 비교하기 쉽다. 그 화면이 없으면 첫 화면이다.
  const selected = detail?.screens.find((screen) => screen.screenId === selectedScreenId) ?? detail?.screens[0]
  const isCurrent = detail?.id === project.currentVersion?.id

  const selectVersion = (nextId: string) => {
    // 처음에 저절로 보인 첫 화면도 "보던 화면"으로 붙잡아 둔다. 안 그러면 새 버전의 첫 화면으로 바뀐다.
    if (selected) setSelectedScreenId(selected.screenId)
    setSearchParams({ version: nextId })
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
        selected={selected}
        isCurrent={isCurrent}
        onSelectScreen={setSelectedScreenId}
      />
    )
  }

  return (
    <section className={styles.room}>
      <div className={styles.top}>
        <div className={styles.heading}>
          <h1>{project.name}</h1>
          {detail && (
            <VersionPicker versionId={detail.id} versions={versions} isCurrent={isCurrent} onSelectVersion={selectVersion} />
          )}
        </div>
        <nav className={styles.links}>
          <Link to="/">프로젝트 목록</Link>
          <Link to={`/projects/${id}/activity`}>활동 일지</Link>
          {isDeveloper && <Link to={`/projects/${id}/draft`}>{nextLabel} 준비</Link>}
          {isDeveloper && <Link to={`/projects/${id}/settings`}>설정</Link>}
        </nav>
      </div>
      {renderBody()}
    </section>
  )
}

// 다른 프로젝트 검수실로 바로 가면 React가 이 화면을 다시 써서 이전 프로젝트의 제목·사진이 남는다.
// key를 id로 주면 id가 바뀔 때 새로 시작하고, 이전 화면에 늦게 온 응답은 버려진다.
export const ReviewRoomPage = () => {
  const { id = '' } = useParams()
  return <ReviewRoom key={id} id={id} />
}
