import { type ReactNode, useEffect, useState } from 'react'
import { Link, Navigate, useParams, useSearchParams } from 'react-router'
import { ApiError } from '../api/client.ts'
import { isUuid } from '../api/ids.ts'
import { getProject, type ProjectDetail, screenLabel } from '../api/projects.ts'
import {
  assetUrl,
  getVersion,
  listVersions,
  versionLabel,
  type VersionDetail,
  type VersionSummary,
} from '../api/versions.ts'
import { ErrorText, SessionEnded } from '../components/ErrorText.tsx'
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

const ProjectNotFound = () => (
  <>
    <h1>없는 프로젝트예요</h1>
    <Link to="/">프로젝트 목록</Link>
  </>
)

type VersionViewProps = {
  version: VersionDetail
  versions: VersionSummary[]
  selectedScreenId?: string
  onSelectVersion: (versionId: string) => void
  onSelectScreen: (screenId: string) => void
}

const VersionView = ({ version, versions, selectedScreenId, onSelectVersion, onSelectScreen }: VersionViewProps) => {
  // 버전을 바꿔도 같은 화면(예: 메인 · PC)을 이어서 보여 줘서, 차수끼리 비교하기 쉽다. 그 화면이 없으면 첫 화면이다.
  const selected = version.screens.find((screen) => screen.screenId === selectedScreenId) ?? version.screens[0]

  return (
    <>
      <div className={styles.versionBar}>
        <label className={styles.versionPicker}>
          버전
          <select
            value={version.id}
            onChange={(event) => {
              // 처음에 저절로 보인 첫 화면도 "보던 화면"으로 붙잡아 둔다. 안 그러면 새 버전의 첫 화면으로 바뀐다.
              if (selected) onSelectScreen(selected.screenId)
              onSelectVersion(event.target.value)
            }}
          >
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
        {version.testUrl && (
          <a href={version.testUrl} target="_blank" rel="noreferrer">
            테스트 주소
          </a>
        )}
      </div>
      {version.summary && <p className={styles.summary}>{version.summary}</p>}
      <div className={styles.body}>
        <ul className={styles.screens}>
          {version.screens.map((screen) => (
            <li key={screen.screenId}>
              <button type="button" aria-pressed={screen === selected} onClick={() => onSelectScreen(screen.screenId)}>
                {screenLabel(screen)}
              </button>
            </li>
          ))}
        </ul>
        {selected && (
          <div className={styles.photo}>
            <img
              src={assetUrl(selected.asset.id)}
              width={selected.asset.width}
              height={selected.asset.height}
              alt={screenLabel(selected)}
            />
          </div>
        )}
      </div>
    </>
  )
}

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

  const renderBody = () => {
    if (versionId === undefined) return <p>아직 게시한 버전이 없어요.</p>
    if (!isUuid(versionId) || current?.missing) {
      return (
        <>
          <h2>없는 버전이에요</h2>
          <Link to={`/projects/${id}`}>최신 버전 보기</Link>
        </>
      )
    }
    if (current?.error) return <ErrorText message={current.error} />
    if (!current?.detail) return <p>불러오는 중이에요.</p>
    return (
      <VersionView
        version={current.detail}
        versions={versions}
        selectedScreenId={selectedScreenId}
        onSelectVersion={(nextId) => setSearchParams({ version: nextId })}
        onSelectScreen={setSelectedScreenId}
      />
    )
  }

  return (
    <section className={styles.room}>
      <Link to="/">프로젝트 목록</Link>
      <div className={styles.top}>
        <h1>{project.name}</h1>
        <nav className={styles.links}>
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
