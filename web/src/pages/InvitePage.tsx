import { type ReactNode, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { logout, type Me } from '../api/auth.ts'
import { ApiError } from '../api/client.ts'
import { acceptInvitation, getInvitation, type InvitationPreview, isInviteToken } from '../api/invitations.ts'
import { MAX_CLIENTS } from '../api/projects.ts'
import { Button } from '../components/Button.tsx'
import { ErrorText } from '../components/ErrorText.tsx'
import { useMe } from '../hooks/useMe.ts'
import styles from './InvitePage.module.css'

// 모두 프로젝트 목록 링크로 끝난다.
type EndState = 'invalid' | 'expired' | 'accepted' | 'full' | 'already'
const END_MESSAGES: Record<EndState, { title: string; body: string }> = {
  invalid: {
    title: '초대 링크를 확인해 주세요',
    body: '사용할 수 없는 초대예요. 초대받은 링크가 맞는지 확인해 주세요.',
  },
  expired: { title: '초대가 만료됐어요', body: '개발자에게 새 초대 링크를 요청해 주세요.' },
  // 수락한 뒤 접근이 철회된 사람도 이 화면을 본다. 그래서 프로젝트가 보인다고 약속하지 않는다.
  accepted: { title: '이미 수락한 초대예요', body: '프로젝트 목록에서 확인해 주세요.' },
  full: {
    title: '참여할 수 있는 인원이 찼어요',
    body: `클라이언트는 ${MAX_CLIENTS}명까지 참여할 수 있어요. 개발자에게 알려 주세요.`,
  },
  already: { title: '이미 참여한 프로젝트예요', body: '프로젝트 목록에서 바로 검수실로 갈 수 있어요.' },
}

// 여기에 없는 오류는 연결 오류처럼 다시 시도하게 한다.
const toEndState = (error: unknown): EndState | undefined => {
  if (!(error instanceof ApiError)) return undefined
  if (error.status === 404) return 'invalid'
  if (error.status === 410) return 'expired'
  if (error.code === 'PROJECT_FULL') return 'full'
  if (error.code === 'ALREADY_MEMBER') return 'already'
  return undefined
}

const EndCard = ({ state }: { state: EndState }) => (
  <section className={styles.card}>
    <h1>{END_MESSAGES[state].title}</h1>
    <p>{END_MESSAGES[state].body}</p>
    <Link to="/">프로젝트 목록</Link>
  </section>
)

type InviteViewProps = {
  token: string
  preview: InvitationPreview
  user: Me | null | undefined
  meError?: string
}

const InviteView = ({ token, preview, user, meError }: InviteViewProps) => {
  const navigate = useNavigate()
  const [joining, setJoining] = useState(false)
  const [joinError, setJoinError] = useState<ReactNode>()
  const [endState, setEndState] = useState<EndState>()
  const [joinedProjectId, setJoinedProjectId] = useState<string>()
  // 로그인한 뒤 이 화면으로 돌아오게 한다. 로그인 화면은 우리 앱 안쪽 주소만 따른다.
  const loginPath = `/login?next=${encodeURIComponent(`/invite/${token}`)}`

  if (endState) return <EndCard state={endState} />
  if (joinedProjectId) {
    return (
      <section className={styles.card}>
        <h1>프로젝트에 참여했어요</h1>
        <p>검수실에서 게시한 화면을 확인해 주세요.</p>
        <Link className={styles.primaryLink} to={`/projects/${joinedProjectId}`}>
          검수실로 가기
        </Link>
      </section>
    )
  }

  const join = async () => {
    setJoining(true)
    setJoinError(undefined)
    try {
      const { projectId } = await acceptInvitation(token)
      setJoinedProjectId(projectId)
    } catch (caught) {
      const state = toEndState(caught)
      if (state) return setEndState(state)
      // 로그인이 끝났으면 이 초대로 돌아오는 로그인 링크를 준다. 공통 SessionEnded의 링크는 돌아오지 않는다.
      if (caught instanceof ApiError && caught.status === 401) {
        return setJoinError(
          <>
            로그인이 끝났어요. <Link to={loginPath}>다시 로그인하기</Link>
          </>,
        )
      }
      if (caught instanceof ApiError && caught.code === 'EMAIL_MISMATCH') {
        return setJoinError('초대받은 이메일로 로그인해 주세요')
      }
      setJoinError('연결을 확인하고 다시 시도해 주세요')
    } finally {
      setJoining(false)
    }
  }

  // 다른 이메일로 로그인해 있으면 로그아웃한 뒤 이 초대로 돌아오는 로그인 화면으로 보낸다.
  const switchAccount = async () => {
    await logout().catch(() => undefined)
    navigate(loginPath)
  }

  const renderAction = () => {
    if (user === undefined) return <p>{meError ?? '확인하는 중이에요.'}</p>
    if (user === null) {
      return (
        <>
          <p>초대받은 이메일로 로그인한 뒤 참여해 주세요.</p>
          <Link className={styles.primaryLink} to={loginPath}>
            로그인하고 참여하기
          </Link>
        </>
      )
    }
    if (user.email !== preview.email) {
      return (
        <>
          <p>
            지금 로그인한 이메일과 초대받은 이메일이 달라요. 현재 로그인: <strong>{user.email}</strong>
          </p>
          <Button onClick={switchAccount}>다른 이메일로 로그인</Button>
          <Link to="/">프로젝트 목록</Link>
        </>
      )
    }
    return (
      <>
        <p>{preview.email}로 로그인했어요. 참여하면 이 프로젝트의 화면을 보고 수정 요청을 남길 수 있어요.</p>
        {joinError && <ErrorText message={joinError} />}
        <Button onClick={join} disabled={joining}>
          {joinError ? '다시 참여하기' : '참여하기'}
        </Button>
        <Link to="/">나중에 하기</Link>
      </>
    )
  }

  return (
    <section className={styles.card}>
      <p className={styles.eyebrow}>프로젝트 초대</p>
      <h1>프로젝트에 초대받았어요</h1>
      <dl className={styles.details}>
        <dt>프로젝트</dt>
        <dd>{preview.projectName}</dd>
        <dt>초대한 사람</dt>
        <dd>{preview.inviterName}</dd>
        <dt>참여 역할</dt>
        <dd>클라이언트</dd>
        <dt>초대받은 이메일</dt>
        <dd>{preview.email}</dd>
      </dl>
      {renderAction()}
    </section>
  )
}

type Loaded = { preview?: InvitationPreview; endState?: EndState; error?: string }

const Invite = ({ token }: { token: string }) => {
  // 로그인 확인과 초대 내용을 같이 불러서, 로그인한 사람이 두 번 기다리지 않게 한다.
  const { user, error: meError } = useMe()
  const [loaded, setLoaded] = useState<Loaded>()

  // 초대 내용은 로그인 없이 볼 수 있다.
  useEffect(() => {
    getInvitation(token)
      // 수락한 사람이 메일 속 링크를 다시 눌러도 헷갈리지 않게 안내한다(정할 것 10).
      .then((preview) => setLoaded(preview.status === 'ACCEPTED' ? { endState: 'accepted' } : { preview }))
      .catch((caught) => {
        const endState = toEndState(caught)
        setLoaded(endState ? { endState } : { error: '연결을 확인하고 새로고침해 주세요' })
      })
  }, [token])

  if (!loaded) return <p>불러오는 중이에요.</p>
  if (loaded.error) return <ErrorText message={loaded.error} />
  if (loaded.endState) return <EndCard state={loaded.endState} />
  return loaded.preview && <InviteView token={token} preview={loaded.preview} user={user} meError={meError} />
}

// 다른 초대 링크로 바로 가면 React가 이 화면을 다시 써서 이전 초대 내용이 남는다. key로 새로 시작한다.
export const InvitePage = () => {
  const { token = '' } = useParams()
  // 모양이 틀린 토큰은 서버를 부르지 않는다. '.'이나 '..'은 감싸도 다른 API 주소가 된다.
  if (!isInviteToken(token)) return <EndCard state="invalid" />
  return <Invite key={token} token={token} />
}
