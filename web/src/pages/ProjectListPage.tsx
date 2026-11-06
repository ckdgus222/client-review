import { type FormEvent, type ReactNode, useEffect, useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router'
import { logout } from '../api/auth.ts'
import { ApiError } from '../api/client.ts'
import { createProject, listProjects, type MyProject } from '../api/projects.ts'
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

const ProjectList = ({ projects, error }: { projects?: MyProject[]; error?: ReactNode }) => {
  if (error) return <ErrorText message={error} />
  if (!projects) return <p>불러오는 중이에요.</p>
  if (projects.length === 0) return <p>아직 프로젝트가 없어요.</p>

  return (
    <ul className={styles.list}>
      {projects.map((project) => (
        <li key={project.id}>
          <Link to={`/projects/${project.id}/settings`}>{project.name}</Link>
        </li>
      ))}
    </ul>
  )
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

  // 로그인 확인을 기다리지 않고 같이 부른다. 로그인 안 했으면 401로 실패하지만, 그때 화면은 로그인 화면으로 간다.
  useEffect(() => {
    listProjects()
      .then(setProjects)
      .catch((caught) => setListError(toMessage(caught)))
  }, [])

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault()
    setSending(true)
    setCreateError(undefined)
    try {
      const project = await createProject(name)
      navigate(`/projects/${project.id}/settings`)
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

  return (
    <section className={styles.panel}>
      <div className={styles.top}>
        <h1>내 프로젝트</h1>
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
      <ProjectList projects={projects} error={listError} />
    </section>
  )
}
