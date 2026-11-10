import { type ReactNode, useEffect, useState } from 'react'
import { Link, Navigate, useParams } from 'react-router'
import { ApiError } from '../api/client.ts'
import { isUuid } from '../api/ids.ts'
import { getProject, type ProjectDetail } from '../api/projects.ts'
import { type ActivityItem, listActivity, timeFormat, versionLabel } from '../api/versions.ts'
import { ErrorText, SessionEnded } from '../components/ErrorText.tsx'
import { ProjectNotFound } from '../components/ProjectNotFound.tsx'
import { useMe } from '../hooks/useMe.ts'
import styles from './ActivityPage.module.css'

const toMessage = (error: unknown): ReactNode => {
  if (!(error instanceof ApiError)) return '연결을 확인하고 다시 시도해 주세요'
  if (error.status === 401) return <SessionEnded />
  return '잠시 뒤 다시 시도해 주세요'
}

// 서버는 사건 종류(type)만 보내고 문장은 화면이 만든다.
const describe = ({ type, actorName, version, memberName }: ActivityItem) => {
  // 초대받은 사람은 아직 멤버가 아니라서 서버가 대상 이름을 보내지 않는다.
  if (type === 'INVITATION_CREATED') return `${actorName}님이 클라이언트를 초대했어요`
  // 수락한 사람이 곧 참여한 사람이라 이름은 한 번만 쓴다.
  if (type === 'INVITATION_ACCEPTED') return `${actorName}님이 프로젝트에 참여했어요`
  if (type === 'MEMBER_REVOKED') {
    return `${actorName}님이 ${memberName ? `${memberName}님` : '참여자'}의 접근을 철회했어요`
  }
  if (type === 'APPROVER_CHANGED') {
    // 대상이 없으면 승인자를 "지정하지 않음"으로 바꾼 것이다.
    if (!memberName) return `${actorName}님이 승인자를 비웠어요`
    return `${actorName}님이 ${memberName}님을 승인자로 정했어요`
  }
  if (!version) return `${actorName}님이 버전을 게시했어요`
  // "초안을", "1차를"처럼 받침에 따라 조사가 다르다. 번호 0이 초안이다.
  const particle = version.number === 0 ? '을' : '를'
  return `${actorName}님이 ${versionLabel(version.number)}${particle} 게시했어요`
}

const ActivityRow = ({ projectId, item }: { projectId: string; item: ActivityItem }) => {
  const content = (
    <>
      <span>{describe(item)}</span>
      <time className={styles.time} dateTime={item.createdAt}>
        {timeFormat.format(new Date(item.createdAt))}
      </time>
    </>
  )
  // 누르면 그 버전을 고른 검수실로 간다. 가리키는 버전이 없는 줄은 갈 곳이 없어 글만 보인다.
  if (!item.version) return <div className={styles.row}>{content}</div>
  return (
    <Link className={styles.row} to={`/projects/${projectId}?version=${item.version.id}`}>
      {content}
    </Link>
  )
}

const Activity = ({ id }: { id: string }) => {
  const isValidId = isUuid(id)
  const { user, error: meError } = useMe()
  const [project, setProject] = useState<ProjectDetail>()
  const [items, setItems] = useState<ActivityItem[]>([])
  const [notFound, setNotFound] = useState(false)
  const [loadError, setLoadError] = useState<ReactNode>()

  // 로그인 확인을 기다리지 않고 같이 부른다. 둘 중 하나라도 실패하면 오류 하나로 보여 준다.
  useEffect(() => {
    if (!isValidId) return
    Promise.all([getProject(id), listActivity(id)])
      .then(([loadedProject, loadedItems]) => {
        setProject(loadedProject)
        setItems(loadedItems)
      })
      .catch((caught) => {
        // 남의 프로젝트도 서버가 없는 것과 같은 404로 답해서, 있는지조차 알 수 없다.
        if (caught instanceof ApiError && caught.status === 404) return setNotFound(true)
        setLoadError(toMessage(caught))
      })
  }, [id, isValidId])

  if (user === null) return <Navigate to="/login" replace />
  // 확인 중 오류여도 로그인 화면으로 보내지 않는다. 서버가 잠깐 멈춘 것일 수 있다.
  if (user === undefined) return <p>{meError ?? '확인하는 중이에요.'}</p>
  if (!isValidId || notFound) return <ProjectNotFound />
  if (loadError) return <ErrorText message={loadError} />
  if (!project) return <p>불러오는 중이에요.</p>

  return (
    <section className={styles.panel}>
      <Link to={`/projects/${id}`}>검수실</Link>
      <h1>{project.name} 활동 일지</h1>
      {items.length === 0 ? (
        <p>아직 기록이 없어요.</p>
      ) : (
        // 서버가 최신순으로 보내서 그대로 늘어놓는다.
        <ul className={styles.list}>
          {items.map((item) => (
            <li key={item.id}>
              <ActivityRow projectId={id} item={item} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

// 다른 프로젝트 일지로 바로 가면 이전 프로젝트의 줄이 남지 않게, id가 바뀌면 새로 시작한다(검수실과 같다).
export const ActivityPage = () => {
  const { id = '' } = useParams()
  return <Activity key={id} id={id} />
}
