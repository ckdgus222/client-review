import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router'
import { logout } from '../api/auth.ts'
import { assetUrl, versionLabel } from '../api/versions.ts'
import { ApiError } from '../api/client.ts'
import {
  createProject,
  daysUntilPurge,
  listProjects,
  type MyProject,
  type ProjectStatus,
  purgeText,
  restoreProject,
} from '../api/projects.ts'
import { ManagementLayout } from '../components/PageLayout.tsx'
import { Button } from '../components/Button.tsx'
import { ErrorText, SessionEnded } from '../components/ErrorText.tsx'
import { TextField } from '../components/TextField.tsx'
import { useMe } from '../hooks/useMe.ts'
import styles from './ProjectListPage.module.css'

const toMessage = (error: unknown): ReactNode => {
  if (!(error instanceof ApiError)) return '연결을 확인하고 다시 시도해 주세요'
  if (error.status === 401) return <SessionEnded />
  if (error.status === 422) return '프로젝트 이름은 1~60자로 써 주세요'
  return '잠시 뒤 다시 시도해 주세요'
}

const restoreMessage = (error: unknown): ReactNode => {
  if (error instanceof ApiError && error.code === 'RESTORE_PERIOD_OVER') return '되살릴 수 있는 7일이 지났어요'
  return toMessage(error)
}

const ProjectLink = ({ project }: { project: MyProject }) => <Link to={`/projects/${project.id}`}>{project.name}</Link>

// 삭제 대기 줄은 개발자에게만 온다(클라이언트 목록에서는 서버가 뺀다).
const DeletedRow = ({ project, onRestored }: { project: MyProject; onRestored: () => Promise<unknown> }) => {
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<ReactNode>()
  // 줄을 처음 그린 때의 시각으로 센다. 다시 그릴 때마다 시각이 바뀌어 글이 흔들리지 않게 한다.
  const [now] = useState(Date.now)
  const daysLeft = project.purgeAfter === null ? null : daysUntilPurge(project.purgeAfter, now)

  const handleRestore = async () => {
    setSending(true)
    setError(undefined)
    try {
      await restoreProject(project.id)
      // 목록을 다시 받을 때까지 버튼을 잠가 두어, 그사이 한 번 더 누르지 못하게 한다.
      await onRestored()
    } catch (caught) {
      setError(restoreMessage(caught))
    } finally {
      setSending(false)
    }
  }

  return (
    <li className={styles.deleted}>
      <ProjectLink project={project} />
      {daysLeft !== null && <span className={styles.purge}>{purgeText(daysLeft)}</span>}
      {daysLeft !== null && daysLeft > 0 && (
        <Button variant="secondary" onClick={handleRestore} disabled={sending}>
          되살리기
        </Button>
      )}
      {error && <ErrorText message={error} />}
    </li>
  )
}

const createdDate = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium' })

const ProjectThumbnail = ({ assetId }: { assetId: string | null }) => {
  const [failed, setFailed] = useState(false)
  return (
    <span className={styles.thumbnail} aria-hidden="true">
      {assetId && !failed
        ? <img alt="" loading="lazy" src={assetUrl(assetId)} onError={() => setFailed(true)} />
        : <span className={styles.emptyThumbnail} />}
    </span>
  )
}

const ProjectProgress = ({ total, resolved, readyForReview }: MyProject['issueCounts']) => {
  if (total === 0) return <span className={styles.progress}>쪽지 없음</span>
  return (
    <div className={styles.progress}>
      <progress aria-label="검수 진행률" value={resolved} max={total} />
      <span>{resolved === total ? '모든 검수 완료 (100%)' : `미해결 ${total - resolved}건 (확인 요청 ${readyForReview})`}</span>
    </div>
  )
}

const quickLink = ({ id, currentVersion, myRole }: MyProject) => {
  if (currentVersion?.status === 'APPROVED') return { label: '확인서', to: `/versions/${currentVersion.id}/certificate` }
  if (!currentVersion && myRole === 'DEVELOPER') return { label: '준비', to: `/projects/${id}/draft` }
  return { label: '검수실', to: `/projects/${id}` }
}

const ProjectRow = ({ project }: { project: MyProject }) => {
  const { currentVersion, issueCounts, screenCount } = project
  const link = quickLink(project)
  const state = project.status === 'ARCHIVED' ? '보관함' : currentVersion?.status === 'APPROVED' ? '승인됨' : '진행 중'
  return (
    <li className={styles.row}>
      <div className={styles.identity}>
        <ProjectThumbnail key={project.thumbnailAssetId} assetId={project.thumbnailAssetId} />
        <div>
          <ProjectLink project={project} />
          <div className={styles.meta}>
            <span>{project.myRole === 'DEVELOPER' ? '개발자' : '클라이언트'}</span>
            <span aria-hidden="true"> · </span>
            <time dateTime={project.createdAt}>{createdDate.format(new Date(project.createdAt))}</time>
          </div>
        </div>
      </div>
      <span className={styles.datum}>
        <span className={styles.cellLabel}>현재 버전</span>
        <span>{currentVersion ? versionLabel(currentVersion.number) : '아직 게시 전'}</span>
      </span>
      <span className={styles.datum}>
        <span className={styles.cellLabel}>화면</span>
        <span>{currentVersion ? `${screenCount}개` : '-'}</span>
      </span>
      <ProjectProgress {...issueCounts} />
      <span className={styles.state} data-approved={state === '승인됨'}>{state}</span>
      <Link className={styles.quick} to={link.to}>{link.label}</Link>
    </li>
  )
}

const overviewText = (projects: MyProject[]) => {
  const active = projects.filter(({ status }) => status === 'ACTIVE')
  const inReview = active.filter(({ currentVersion }) => currentVersion?.status === 'IN_REVIEW').length
  const requests = active.reduce((count, { issueCounts }) => count + issueCounts.readyForReview, 0)
  const base = `참여하고 있는 프로젝트 ${projects.length}개`
  if (!inReview && !requests) return base
  return `${base} · 진행 중 ${active.length}개 · 검수 중 ${inReview}개 · 확인 요청 ${requests}건`
}

const GROUPS: { status: ProjectStatus; title: string }[] = [
  { status: 'ACTIVE', title: '진행 중' },
  { status: 'ARCHIVED', title: '보관함' },
  { status: 'DELETE_PENDING', title: '삭제 대기' },
]

const ProjectList = ({
  projects,
  error,
  onRestored,
}: {
  projects?: MyProject[]
  error?: ReactNode
  onRestored: () => Promise<unknown>
}) => {
  if (error) return <ErrorText message={error} />
  if (!projects) return <p>불러오는 중이에요.</p>
  if (projects.length === 0) return <p>아직 프로젝트가 없어요.</p>

  // 프로젝트가 없는 묶음은 제목도 보이지 않는다.
  return GROUPS.map(({ status, title }) => {
    const inGroup = projects.filter((project) => project.status === status)
    if (inGroup.length === 0) return null
    return (
      <section key={status} id={`projects-${status}`} className={styles.group} aria-label={title}>
        <h2>{title}</h2>
        {status !== 'DELETE_PENDING' && (
          <div className={`${styles.row} ${styles.columns}`} aria-hidden="true">
            <span>프로젝트</span><span>현재 버전</span><span>화면</span><span>검수 진행률</span><span>상태</span><span>이동</span>
          </div>
        )}
        <ul className={styles.list}>
          {inGroup.map((project) =>
            status === 'DELETE_PENDING' ? (
              <DeletedRow key={project.id} project={project} onRestored={onRestored} />
            ) : (
              <ProjectRow key={project.id} project={project} />
            ),
          )}
        </ul>
      </section>
    )
  })
}

export const ProjectListPage = () => {
  const navigate = useNavigate()
  const { user, error: meError } = useMe()
  const [projects, setProjects] = useState<MyProject[]>()
  const [listError, setListError] = useState<ReactNode>()
  const [name, setName] = useState('')
  const [sending, setSending] = useState(false)
  const [createError, setCreateError] = useState<ReactNode>()
  const [logoutError, setLogoutError] = useState<string>()
  // 만들기 응답을 기다리는 사이 다른 프로젝트로 떠났으면, 늦게 온 응답이 그 화면에서 끌어내지 않게 한다.
  // 개발 모드의 React는 화면을 붙였다 뗐다 다시 붙여 보므로, 붙을 때마다 true로 돌려놓는다.
  const isOpen = useRef(true)
  useEffect(() => {
    isOpen.current = true
    return () => {
      isOpen.current = false
    }
  }, [])

  // 되살린 뒤에도 다시 부른다. 여러 줄을 잇달아 되살리면 응답이 순서와 다르게 올 수 있어서, 마지막 요청의 응답만 쓴다.
  const latestLoad = useRef(0)
  const loadProjects = () => {
    latestLoad.current += 1
    const load = latestLoad.current
    return listProjects()
      .then((loaded) => {
        if (load !== latestLoad.current) return
        setProjects(loaded)
        setListError(undefined)
      })
      .catch((caught) => {
        if (load === latestLoad.current) setListError(toMessage(caught))
      })
  }

  // 로그인 확인을 기다리지 않고 같이 부른다. 로그인 안 했으면 401로 실패하지만, 그때 화면은 로그인 화면으로 간다.
  useEffect(() => {
    void loadProjects()
  }, [])

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault()
    setSending(true)
    setCreateError(undefined)
    try {
      const project = await createProject(name)
      if (isOpen.current) navigate(`/projects/${project.id}/settings`)
    } catch (caught) {
      // 고쳐서 다시 보내게 쓰던 이름은 그대로 둔다.
      setCreateError(toMessage(caught))
    } finally {
      setSending(false)
    }
  }

  const handleLogout = async () => {
    try {
      await logout()
      // 로그아웃한 화면을 방문 기록에서 바꿔치기해서, 뒤로 가기로 다시 오지 않게 한다.
      navigate('/login', { replace: true })
    } catch {
      setLogoutError('로그아웃하지 못했어요. 다시 눌러 주세요')
    }
  }

  // replace라서 뒤로 가기를 눌러도 이 화면으로 돌아와 다시 보내지는 고리가 생기지 않는다.
  if (user === null) return <Navigate to="/login" replace />
  // 확인 중 오류여도 로그인 화면으로 보내지 않는다. 서버가 잠깐 멈춘 것일 수 있다.
  if (user === undefined) return <p>{meError ?? '확인하는 중이에요.'}</p>

  const sections = GROUPS.map(({ status, title }) => ({
    id: `projects-${status}`,
    title,
    count: projects?.filter((project) => project.status === status).length ?? 0,
  }))

  return (
    <ManagementLayout active="projects" sections={sections}>
      <section className={styles.panel}>
        <div className={styles.top}>
          <div>
            <h1>내 프로젝트</h1>
            {projects && <p className={styles.overview}>{overviewText(projects)}</p>}
          </div>
          <div className={styles.account}>
            <span className={styles.user}>{user.name}님</span>
            <Button variant="secondary" onClick={handleLogout}>
              로그아웃
            </Button>
          </div>
        </div>
        {logoutError && <ErrorText message={logoutError} />}
        {user.canCreateProjects && (
          <form className={styles.create} onSubmit={handleCreate} noValidate>
            <TextField label="프로젝트 이름" value={name} onChange={setName} disabled={sending} />
            <Button type="submit" disabled={sending}>
              만들기
            </Button>
          </form>
        )}
        {createError && <ErrorText message={createError} />}
        <ProjectList projects={projects} error={listError} onRestored={loadProjects} />
      </section>
    </ManagementLayout>
  )
}
