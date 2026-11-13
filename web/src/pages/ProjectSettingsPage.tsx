import { type FormEvent, type ReactNode, useEffect, useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router'
import { ApiError } from '../api/client.ts'
import { isUuid } from '../api/ids.ts'
import { type CreatedInvitation, createInvitation } from '../api/invitations.ts'
import { listMembers, type Member, type MemberList, revokeMember, setApprover } from '../api/members.ts'
import {
  type Approver,
  archiveProject,
  createScreen,
  deleteProject,
  getProject,
  hideScreen,
  MAX_CLIENTS,
  listScreens,
  type ProjectDetail,
  projectStatusError,
  type ProjectStatus,
  type Screen,
  screenLabel,
  showScreen,
  statusNotice,
  unarchiveProject,
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
  return projectStatusError(error.code) ?? '잠시 뒤 다시 시도해 주세요'
}

// "마지막 접속: 2시간 전"처럼 보여 준다. 하루 넘게 지나면 "어제", "3일 전"이 된다.
const relativeTime = new Intl.RelativeTimeFormat('ko', { numeric: 'auto' })
const lastSeenLabel = (lastSeenAt: string | null) => {
  if (!lastSeenAt) return '접속 기록 없음'
  const minutes = Math.round((Date.parse(lastSeenAt) - Date.now()) / 60_000)
  if (minutes > -1) return '지금'
  if (minutes > -60) return relativeTime.format(minutes, 'minute')
  if (minutes > -60 * 24) return relativeTime.format(Math.round(minutes / 60), 'hour')
  return relativeTime.format(Math.round(minutes / (60 * 24)), 'day')
}

const dateFormat = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium' })

// 422는 작업마다 뜻이 달라서(초대는 이메일 모양, 승인자는 고를 수 없는 사람) 문구를 따로 받는다.
// 목록과 철회는 422가 없어서 넘기지 않는다.
const memberMessage = (error: unknown, invalidInput?: string): ReactNode => {
  if (!(error instanceof ApiError)) return '연결을 확인하고 다시 시도해 주세요'
  if (error.status === 401) return <SessionEnded />
  if (error.code === 'PROJECT_FULL') return `클라이언트는 ${MAX_CLIENTS}명까지 참여할 수 있어요`
  if (error.code === 'ALREADY_MEMBER') return '이미 참여한 사람이에요'
  if (error.status === 422 && invalidInput) return invalidInput
  return projectStatusError(error.code) ?? '잠시 뒤 다시 시도해 주세요'
}

const INVALID_EMAIL = '이메일 주소를 확인해 주세요'
const INVALID_APPROVER = '승인자는 이 프로젝트에 참여 중인 클라이언트만 될 수 있어요'

type MembersSectionProps = {
  projectId: string
  approver: Approver
  onApproverChange: (approver: Approver) => void
}

// 개발자에게만 보이는 참여자·초대·승인자 칸이다. 다른 클라이언트의 이메일과 접속 시각이 보이지 않게
// 서버도 클라이언트에게는 목록을 주지 않는다(403).
const MembersSection = ({ projectId, approver, onApproverChange }: MembersSectionProps) => {
  const [list, setList] = useState<MemberList>()
  const [loadError, setLoadError] = useState<ReactNode>()
  const [email, setEmail] = useState('')
  const [created, setCreated] = useState<CreatedInvitation>()
  // 새 초대를 만들면 링크가 바뀌어 '복사했어요'가 저절로 풀린다.
  const [copiedLink, setCopiedLink] = useState<string>()
  const [approverChoice, setApproverChoice] = useState(approver?.memberId ?? '')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<ReactNode>()

  useEffect(() => {
    // 개발 모드(StrictMode)는 두 번 부른다. 정리된 쪽의 늦은 응답은 버린다.
    let ignore = false
    listMembers(projectId)
      .then((loaded) => !ignore && setList(loaded))
      .catch((caught) => !ignore && setLoadError(memberMessage(caught)))
    return () => {
      ignore = true
    }
  }, [projectId])

  // 요청이 겹치면 늦게 온 목록이 앞선 결과를 덮을 수 있어서, 하나가 끝날 때까지 버튼을 모두 잠근다.
  const run = async (work: () => Promise<void>, invalidInput?: string) => {
    setBusy(true)
    setActionError(undefined)
    try {
      await work()
    } catch (caught) {
      setActionError(memberMessage(caught, invalidInput))
    } finally {
      setBusy(false)
    }
  }

  const handleInvite = (event: FormEvent) => {
    event.preventDefault()
    run(async () => {
      const invitation = await createInvitation(projectId, email)
      setCreated(invitation)
      setEmail('')
      setList(await listMembers(projectId))
    }, INVALID_EMAIL)
  }

  const handleRevoke = (member: Member) => {
    const isApprover = approver?.memberId === member.id
    const message =
      `${member.name}님의 접근을 철회할까요? 사진과 기록을 더 이상 볼 수 없어요. 쪽지와 댓글은 남아요.` +
      (isApprover ? ' 승인자가 비게 돼요. 새 승인자를 정해 주세요.' : '')
    if (!window.confirm(message)) return
    run(async () => {
      await revokeMember(member.id)
      if (isApprover) {
        // 서버가 철회와 함께 승인자를 비웠다. 화면도 맞춘다.
        onApproverChange(null)
        setApproverChoice('')
      } else if (approverChoice === member.id) {
        // 저장하지 않고 골라만 둔 사람이 철회되면, 고르기 칸에 남지 않게 지금 승인자로 되돌린다.
        setApproverChoice(approver?.memberId ?? '')
      }
      setList(await listMembers(projectId))
    })
  }

  const handleApprover = (event: FormEvent) => {
    event.preventDefault()
    run(async () => onApproverChange(await setApprover(projectId, approverChoice || null)), INVALID_APPROVER)
  }

  // 클립보드를 쓸 수 없는 브라우저(http 주소 등)는 navigator.clipboard가 없다. 실패하면 링크를 직접 골라 복사하게 안내한다.
  const copyLink = async (link: string) => {
    try {
      await navigator.clipboard.writeText(link)
      setCopiedLink(link)
    } catch {
      setActionError('복사하지 못했어요. 링크를 직접 골라 복사해 주세요')
    }
  }

  if (loadError) return <ErrorText message={loadError} />
  if (!list) return <p>참여자를 불러오는 중이에요.</p>

  const clients = list.members.filter((member) => member.role === 'CLIENT')
  const roleLabel = (member: Member) => {
    if (member.role === 'DEVELOPER') return '개발자'
    return approver?.memberId === member.id ? '승인자' : '클라이언트'
  }

  return (
    <>
      <h2>참여자와 승인자</h2>
      <p className={styles.hint}>
        클라이언트는 최대 {MAX_CLIENTS}명까지 참여해요.{' '}
        {approver ? `${approver.name}님이 최종 버전을 승인해요.` : '승인자를 정해 주세요.'}
      </p>
      <ul className={styles.list}>
        {list.members.map((member) => (
          <li key={member.id}>
            <span className={styles.name}>
              <strong>{member.name}</strong> {member.email}
              <span className={styles.hint}> · 마지막 접속: {lastSeenLabel(member.lastSeenAt)}</span>
            </span>
            <span className={styles.role}>{roleLabel(member)}</span>
            {member.role === 'CLIENT' && (
              <Button variant="secondary" disabled={busy} onClick={() => handleRevoke(member)}>
                접근 철회
              </Button>
            )}
          </li>
        ))}
      </ul>
      <p className={styles.hint}>마지막 접속은 서비스에 들어온 시각이에요. 이 프로젝트를 본 시각은 아니에요.</p>
      {list.invitations.length > 0 && (
        <>
          <h3>초대 대기</h3>
          <ul className={styles.list}>
            {list.invitations.map((invitation) => (
              <li key={invitation.email}>
                <span className={styles.name}>{invitation.email}</span>
                <span className={styles.hint}>{dateFormat.format(new Date(invitation.expiresAt))}까지</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <form className={styles.create} onSubmit={handleApprover}>
        <label className={styles.viewport}>
          승인자
          <select value={approverChoice} onChange={(event) => setApproverChoice(event.target.value)} disabled={busy}>
            {clients.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
            <option value="">지정하지 않음</option>
          </select>
        </label>
        <Button type="submit" variant="secondary" disabled={busy}>
          승인자 저장
        </Button>
      </form>
      <form className={styles.create} onSubmit={handleInvite} noValidate>
        <TextField label="클라이언트 초대 이메일" type="email" value={email} onChange={setEmail} disabled={busy} />
        <Button type="submit" disabled={busy}>
          초대 보내기
        </Button>
      </form>
      {actionError && <ErrorText message={actionError} />}
      {created && (
        <div className={styles.created}>
          <p>{created.email}에게 초대 메일을 보냈어요. 링크는 지금 한 번만 확인할 수 있어요.</p>
          <code className={styles.link}>{created.link}</code>
          <Button variant="secondary" onClick={() => copyLink(created.link)}>
            {copiedLink === created.link ? '복사했어요' : '링크 복사'}
          </Button>
        </div>
      )}
    </>
  )
}

const deleteMessage = (error: unknown): ReactNode => {
  if (error instanceof ApiError && error.code === 'PROJECT_NAME_MISMATCH') return '프로젝트 이름이 달라요'
  return toMessage(error)
}

type StatusSectionProps = { project: ProjectDetail; onStatusChange: (status: ProjectStatus) => void }

// 보관·보관 풀기와 지우기(docs/archive.md 정할 것 17). 개발자에게만, 삭제 대기가 아닐 때만 보인다(되살리기는 목록에서 한다).
const StatusSection = ({ project, onStatusChange }: StatusSectionProps) => {
  const navigate = useNavigate()
  const [confirmName, setConfirmName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ReactNode>()
  const isArchived = project.status === 'ARCHIVED'
  // 서버도 앞뒤 공백을 지우고 다시 본다. 버튼 잠금은 실수를 줄이는 것이고 막는 것은 서버다.
  const nameMatches = confirmName.trim() === project.name

  const toggleArchived = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await (isArchived ? unarchiveProject(project.id) : archiveProject(project.id))
      onStatusChange(isArchived ? 'ACTIVE' : 'ARCHIVED')
    } catch (caught) {
      setError(toMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(undefined)
    try {
      await deleteProject(project.id, confirmName)
      navigate('/')
    } catch (caught) {
      setError(deleteMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <h2>보관과 지우기</h2>
      <p className={styles.hint}>
        보관하면 읽기만 할 수 있어요. 지우면 7일 동안 프로젝트 목록에서 되살릴 수 있고, 그 뒤 사진과 함께 완전히
        지워져요.
      </p>
      <div>
        <Button variant="secondary" disabled={busy} onClick={toggleArchived}>
          {isArchived ? '보관 풀기' : '보관하기'}
        </Button>
      </div>
      <form className={styles.create} onSubmit={handleDelete} noValidate>
        <TextField
          label="지우려면 프로젝트 이름을 그대로 입력해 주세요"
          value={confirmName}
          onChange={setConfirmName}
          disabled={busy}
        />
        <Button type="submit" disabled={busy || !nameMatches}>
          프로젝트 지우기
        </Button>
      </form>
      {error && <ErrorText message={error} />}
    </>
  )
}

const ProjectSettings = ({ id }: { id: string }) => {
  const isValidId = isUuid(id)
  const { user, error: meError } = useMe()
  const [project, setProject] = useState<ProjectDetail>()
  // 삭제 대기 띠의 남은 날을 화면을 연 때의 시각으로 센다. 다시 그릴 때마다 글이 흔들리지 않게 한다.
  const [openedAt] = useState(Date.now)
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
  const notice = statusNotice(project, openedAt)

  return (
    <section className={styles.panel}>
      <Link to="/">프로젝트 목록</Link>
      <h1>{project.name}</h1>
      {/* 보관·삭제 대기 띠(정할 것 18). */}
      {notice && (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}
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
      {isDeveloper && (
        <MembersSection
          projectId={id}
          approver={project.approver}
          onApproverChange={(approver) => setProject({ ...project, approver })}
        />
      )}
      {isDeveloper && project.status !== 'DELETE_PENDING' && (
        <StatusSection project={project} onStatusChange={(status) => setProject({ ...project, status })} />
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
