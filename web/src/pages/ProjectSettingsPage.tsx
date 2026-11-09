import { type FormEvent, type ReactNode, useEffect, useState } from 'react'
import { Link, Navigate, useParams } from 'react-router'
import { ApiError } from '../api/client.ts'
import { isUuid } from '../api/ids.ts'
import {
  createScreen,
  getProject,
  hideScreen,
  listScreens,
  type ProjectDetail,
  type Screen,
  screenLabel,
  showScreen,
  VIEWPORT_LABELS,
  type Viewport,
} from '../api/projects.ts'
import { Button } from '../components/Button.tsx'
import { ErrorText, SessionEnded } from '../components/ErrorText.tsx'
import { ProjectNotFound } from '../components/ProjectNotFound.tsx'
import { TextField } from '../components/TextField.tsx'
import { useMe } from '../hooks/useMe.ts'
import styles from './ProjectSettingsPage.module.css'

const toMessage = (error: unknown): ReactNode => {
  if (!(error instanceof ApiError)) return '연결을 확인하고 다시 시도해 주세요'
  if (error.status === 401) return <SessionEnded />
  if (error.code === 'SCREEN_EXISTS') return '이미 있는 화면이에요'
  if (error.status === 422) return '화면 이름은 1~40자로 써 주세요'
  return '잠시 뒤 다시 시도해 주세요'
}

const ProjectSettings = ({ id }: { id: string }) => {
  const isValidId = isUuid(id)
  const { user, error: meError } = useMe()
  const [project, setProject] = useState<ProjectDetail>()
  const [screens, setScreens] = useState<Screen[]>([])
  const [notFound, setNotFound] = useState(false)
  const [loadError, setLoadError] = useState<ReactNode>()
  const [name, setName] = useState('')
  const [viewport, setViewport] = useState<Viewport>('PC')
  const [sending, setSending] = useState(false)
  const [changing, setChanging] = useState(false)
  // 만들기·숨기기·다시 보이기가 같이 쓴다. 어떤 작업을 시작하든 지난 오류를 지워서, 성공한 작업 위에 남은 오류가
  // 방금 한 일이 실패한 것처럼 보이지 않게 한다.
  const [actionError, setActionError] = useState<ReactNode>()

  // 로그인 확인을 기다리지 않고 같이 부른다. 둘 중 하나라도 실패하면 오류 하나로 보여 준다.
  useEffect(() => {
    if (!isValidId) return
    Promise.all([getProject(id), listScreens(id)])
      .then(([loadedProject, loadedScreens]) => {
        setProject(loadedProject)
        setScreens(loadedScreens)
      })
      .catch((caught) => {
        // 남의 프로젝트도 서버가 없는 것과 같은 404로 답해서, 있는지조차 알 수 없다.
        if (caught instanceof ApiError && caught.status === 404) return setNotFound(true)
        setLoadError(toMessage(caught))
      })
  }, [id, isValidId])

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault()
    setSending(true)
    setActionError(undefined)
    try {
      const screen = await createScreen(id, name, viewport)
      setScreens((current) => [...current, screen])
      // 다음 화면을 바로 쓰게 이름만 비운다. 기기는 같은 것을 이어서 만들 때가 많아서 그대로 둔다.
      setName('')
    } catch (caught) {
      setActionError(toMessage(caught))
    } finally {
      setSending(false)
    }
  }

  // 요청 하나가 끝날 때까지 숨기기·보이기 버튼을 모두 잠가서, 빠르게 눌러도 순서가 꼬이지 않게 한다.
  const toggleHidden = async (screen: Screen) => {
    setChanging(true)
    setActionError(undefined)
    try {
      const updated = await (screen.hiddenAt ? showScreen(screen.id) : hideScreen(screen.id))
      // 서버가 돌려준 화면으로 그 줄을 바꿔 끼우면 hiddenAt이 바뀌어 보이는 목록과 숨긴 목록 사이를 옮겨 간다.
      setScreens((current) => current.map((item) => (item.id === updated.id ? updated : item)))
    } catch (caught) {
      setActionError(toMessage(caught))
    } finally {
      setChanging(false)
    }
  }

  if (user === null) return <Navigate to="/login" replace />
  // 확인 중 오류여도 로그인 화면으로 보내지 않는다. 서버가 잠깐 멈춘 것일 수 있다.
  if (user === undefined) return <p>{meError ?? '확인하는 중이에요.'}</p>
  if (!isValidId || notFound) return <ProjectNotFound />
  if (loadError) return <ErrorText message={loadError} />
  if (!project) return <p>불러오는 중이에요.</p>

  const isDeveloper = project.myRole === 'DEVELOPER'
  const visibleScreens = screens.filter((screen) => !screen.hiddenAt)
  const hiddenScreens = screens.filter((screen) => screen.hiddenAt)

  return (
    <section className={styles.panel}>
      <Link to="/">프로젝트 목록</Link>
      <h1>{project.name}</h1>
      {isDeveloper && (
        <form className={styles.create} onSubmit={handleCreate} noValidate>
          <TextField label="화면 이름" value={name} onChange={setName} disabled={sending} />
          <label className={styles.viewport}>
            기기
            <select
              value={viewport}
              onChange={(event) => setViewport(event.target.value as Viewport)}
              disabled={sending}
            >
              <option value="PC">{VIEWPORT_LABELS.PC}</option>
              <option value="MOBILE">{VIEWPORT_LABELS.MOBILE}</option>
            </select>
          </label>
          <Button type="submit" disabled={sending}>
            만들기
          </Button>
        </form>
      )}
      {actionError && <ErrorText message={actionError} />}
      {visibleScreens.length === 0 ? (
        <p>아직 화면이 없어요.</p>
      ) : (
        <ul className={styles.list}>
          {visibleScreens.map((screen, index) => (
            <li key={screen.id}>
              {/* 번호는 보이는 화면 안에서 만든 순서다. */}
              <span className={styles.number}>{String(index + 1).padStart(2, '0')}</span>
              <span className={styles.name}>{screenLabel(screen)}</span>
              {isDeveloper && (
                <Button variant="secondary" disabled={changing} onClick={() => toggleHidden(screen)}>
                  숨기기
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {hiddenScreens.length > 0 && (
        <>
          <h2>숨긴 화면</h2>
          <ul className={styles.list}>
            {hiddenScreens.map((screen) => (
              <li key={screen.id}>
                <span className={styles.name}>{screenLabel(screen)}</span>
                {isDeveloper && (
                  <Button variant="secondary" disabled={changing} onClick={() => toggleHidden(screen)}>
                    다시 보이기
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

// 방문 기록으로 다른 프로젝트 설정에 바로 가면 React가 이 화면을 다시 써서 이전 프로젝트의 제목·목록·오류가 남는다.
// key를 id로 주면 id가 바뀔 때 새로 시작하고, 이전 화면에 늦게 온 응답은 버려진다.
export const ProjectSettingsPage = () => {
  const { id = '' } = useParams()
  return <ProjectSettings key={id} id={id} />
}
