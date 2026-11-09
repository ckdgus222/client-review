import { type ChangeEvent, type DragEvent, type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router'
import { ApiError } from '../api/client.ts'
import { isUuid } from '../api/ids.ts'
import { getProject, listScreens, type ProjectDetail, type Screen, screenLabel } from '../api/projects.ts'
import {
  assetUrl,
  createDraft,
  getVersion,
  listVersions,
  publishVersion,
  putScreenPhoto,
  removeDraftScreen,
  updateDraft,
  versionLabel,
  type VersionDetail,
} from '../api/versions.ts'
import { Button } from '../components/Button.tsx'
import { ErrorText, SessionEnded } from '../components/ErrorText.tsx'
import { TextField } from '../components/TextField.tsx'
import { ProjectNotFound } from '../components/ProjectNotFound.tsx'
import { useMe } from '../hooks/useMe.ts'
import styles from './DraftPage.module.css'

// 서버 제한과 같다. 큰 파일을 다 보낸 뒤에 거절당하지 않게 보내기 전에 막는다.
const MAX_PHOTO_BYTES = 20 * 1024 * 1024

const toMessage = (error: unknown): ReactNode => {
  if (!(error instanceof ApiError)) return '연결을 확인하고 다시 시도해 주세요'
  if (error.status === 401) return <SessionEnded />
  if (error.code === 'VERSION_NOT_DRAFT') return '이미 게시된 버전이에요. 새로고침해 주세요'
  if (error.code === 'DRAFT_EXISTS') return '이미 준비 중인 버전이 있어요. 새로고침해 주세요'
  if (error.code === 'SCREEN_HIDDEN') return '숨긴 화면에는 사진을 올릴 수 없어요'
  if (error.code === 'TOO_MANY_SCREENS') return '화면은 20개까지 올릴 수 있어요'
  if (error.code === 'NO_SCREENS') return '사진을 올린 화면이 없어요'
  // 20 MB를 넘는 파일은 보내기 전에 막으므로, 서버의 413은 픽셀 수나 프로젝트 용량 때문이다.
  if (error.status === 413) return '사진 크기(픽셀)가 너무 크거나 프로젝트 사진 용량(1 GB)이 찼어요'
  if (error.status === 415) return 'PNG, JPG, WebP 사진만 올릴 수 있어요(움직이는 사진 제외)'
  if (error.status === 422) return '설명은 1,000자까지, 테스트 주소는 https://로 시작하는 주소로 써 주세요'
  return '잠시 뒤 다시 시도해 주세요'
}

// 게시에서 숨긴 화면 409는 "올릴 수 없다"가 아니라 "빼고 게시하라"는 뜻이다.
const toPublishMessage = (error: unknown): ReactNode =>
  error instanceof ApiError && error.code === 'SCREEN_HIDDEN' ? '숨긴 화면을 빼고 게시해 주세요' : toMessage(error)

const DraftEditor = ({ id }: { id: string }) => {
  const navigate = useNavigate()
  const isValidId = isUuid(id)
  const { user, error: meError } = useMe()
  const [project, setProject] = useState<ProjectDetail>()
  const [screens, setScreens] = useState<Screen[]>([])
  // undefined는 불러오는 중, null은 아직 준비 중인 버전이 없음이다.
  const [draft, setDraft] = useState<VersionDetail | null>()
  const [notFound, setNotFound] = useState(false)
  const [loadError, setLoadError] = useState<ReactNode>()
  const [summary, setSummary] = useState('')
  const [testUrl, setTestUrl] = useState('')
  // 요청 하나가 끝날 때까지 모든 버튼을 잠가서, 사진 올리기와 게시가 엇갈리지 않게 한다.
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<ReactNode>()
  const [dropTargetId, setDropTargetId] = useState<string>()
  // 게시 응답을 기다리는 사이 다른 화면으로 떠났으면, 늦게 온 응답이 검수실로 끌고 가지 않게 한다.
  const isOpen = useRef(true)
  useEffect(() => {
    isOpen.current = true
    return () => {
      isOpen.current = false
    }
  }, [])

  // 카드 밖에 사진을 떨어뜨리면 브라우저가 그 파일을 열면서 이 화면을 떠나고, 저장하지 않은 설명이 사라진다.
  useEffect(() => {
    const stayOnPage = (event: globalThis.DragEvent) => event.preventDefault()
    window.addEventListener('dragover', stayOnPage)
    window.addEventListener('drop', stayOnPage)
    return () => {
      window.removeEventListener('dragover', stayOnPage)
      window.removeEventListener('drop', stayOnPage)
    }
  }, [])

  // 불러오거나 저장한 값으로 칸을 채운다. 사진을 올리거나 뺄 때는 부르지 않아서, 쓰고 있던 설명이 지워지지 않는다.
  const fillForm = (detail: VersionDetail | null) => {
    setDraft(detail)
    setSummary(detail?.summary ?? '')
    setTestUrl(detail?.testUrl ?? '')
  }

  useEffect(() => {
    if (!isValidId) return
    // 개발 모드(StrictMode)는 이 조회를 두 번 한다. 늦게 온 첫 응답이 그사이 쓴 설명·주소를 되돌리지 않게,
    // 정리된 조회의 응답은 버린다. getVersion을 기다린 뒤에도 다시 본다.
    let ignore = false
    Promise.all([getProject(id), listVersions(id), listScreens(id)])
      .then(async ([loadedProject, versions, loadedScreens]) => {
        // 클라이언트 목록에는 게시 전 버전이 없어서 늘 null이 된다.
        const existing = versions.find((version) => version.status === 'DRAFT')
        const detail = existing ? await getVersion(existing.id) : null
        if (ignore) return
        setProject(loadedProject)
        setScreens(loadedScreens)
        fillForm(detail)
      })
      .catch((caught) => {
        if (ignore) return
        if (caught instanceof ApiError && caught.status === 404) return setNotFound(true)
        setLoadError(toMessage(caught))
      })
    return () => {
      ignore = true
    }
  }, [id, isValidId])

  // 시작·저장·올리기·빼기·게시가 같이 쓴다. 어떤 일을 시작하든 지난 오류를 지운다.
  const run = async (work: () => Promise<void>, describe = toMessage) => {
    setBusy(true)
    setActionError(undefined)
    try {
      await work()
    } catch (caught) {
      setActionError(describe(caught))
    } finally {
      setBusy(false)
    }
  }

  if (user === null) return <Navigate to="/login" replace />
  // 확인 중 오류여도 로그인 화면으로 보내지 않는다. 서버가 잠깐 멈춘 것일 수 있다.
  if (user === undefined) return <p>{meError ?? '확인하는 중이에요.'}</p>
  if (!isValidId || notFound) return <ProjectNotFound />
  if (loadError) return <ErrorText message={loadError} />
  if (!project || draft === undefined) return <p>불러오는 중이에요.</p>

  const roomLink = <Link to={`/projects/${id}`}>검수실</Link>
  if (project.myRole !== 'DEVELOPER') {
    return (
      <section className={styles.page}>
        {roomLink}
        <h1>개발자만 준비할 수 있어요</h1>
      </section>
    )
  }

  // 현재 버전은 가장 최근에 게시한 버전이라, 준비하는 버전은 그 번호 + 1이다.
  const nextNumber = project.currentVersion ? project.currentVersion.number + 1 : 0
  const label = versionLabel(nextNumber)

  if (!draft) {
    return (
      <section className={styles.page}>
        {roomLink}
        <h1>{project.name}</h1>
        <p>
          준비를 시작하면 지금 버전의 화면 구성과 테스트 주소를 그대로 가져와요. 바뀐 화면만 새 사진으로 바꾸면 돼요.
        </p>
        {actionError && <ErrorText message={actionError} />}
        <div>
          <Button disabled={busy} onClick={() => run(async () => fillForm(await createDraft(id)))}>
            {label} 준비 시작
          </Button>
        </div>
      </section>
    )
  }

  const isDirty = summary !== draft.summary || testUrl !== (draft.testUrl ?? '')

  const handleSave = (event: FormEvent) => {
    event.preventDefault()
    run(async () => fillForm(await updateDraft(draft.id, { summary, testUrl })))
  }

  const upload = (screenId: string, file: File) => {
    if (file.size > MAX_PHOTO_BYTES) {
      setActionError('사진이 20 MB를 넘어요. JPG나 WebP로 저장하면 크기가 크게 줄어요.')
      return
    }
    run(async () => setDraft(await putScreenPhoto(draft.id, screenId, file)))
  }

  const handleFileChange = (screenId: string, event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    // 같은 파일을 다시 골라도 바뀐 것으로 알도록 비운다.
    event.target.value = ''
    if (file) upload(screenId, file)
  }

  const handleDrop = (screenId: string, event: DragEvent) => {
    event.preventDefault()
    setDropTargetId(undefined)
    if (busy) return
    const files = event.dataTransfer.files
    if (files.length !== 1) {
      setActionError('한 장씩 올려 주세요')
      return
    }
    upload(screenId, files[0])
  }

  const handleRemove = (screenId: string) => run(async () => setDraft(await removeDraftScreen(draft.id, screenId)))

  const handlePublish = () => {
    // "초안"은 받침이 있어 "으로", "1차"·"2차"는 "로"다.
    const particle = nextNumber === 0 ? '으로' : '로'
    if (!window.confirm(`게시하면 고칠 수 없어요. ${label}${particle} 게시할까요?`)) return
    run(async () => {
      await publishVersion(draft.id)
      if (isOpen.current) navigate(`/projects/${id}`)
    }, toPublishMessage)
  }

  // 숨긴 화면은 이미 들어 있을 때만 보여 준다. 그래야 빼고 게시할 수 있다.
  const cards = screens.flatMap((screen) => {
    const asset = draft.screens.find((item) => item.screenId === screen.id)?.asset
    return screen.hiddenAt && !asset ? [] : [{ screen, asset }]
  })

  return (
    <section className={styles.page}>
      {roomLink}
      <div className={styles.top}>
        <h1>
          {project.name} · {label} 준비 중
        </h1>
        <Button disabled={busy || isDirty} onClick={handlePublish}>
          {label} 게시
        </Button>
      </div>
      {isDirty && <p className={styles.hint}>저장한 뒤 게시해 주세요.</p>}
      <form className={styles.form} onSubmit={handleSave} noValidate>
        <label className={styles.summary}>
          설명
          <textarea value={summary} onChange={(event) => setSummary(event.target.value)} disabled={busy} rows={3} />
        </label>
        <TextField label="테스트 주소" value={testUrl} onChange={setTestUrl} disabled={busy} />
        <div>
          <Button type="submit" variant="secondary" disabled={busy || !isDirty}>
            저장
          </Button>
        </div>
      </form>
      {actionError && <ErrorText message={actionError} />}
      {cards.length === 0 ? (
        <p>
          화면 이름표가 없어요. <Link to={`/projects/${id}/settings`}>설정</Link>에서 먼저 만들어 주세요.
        </p>
      ) : (
        <ul className={styles.cards}>
          {cards.map(({ screen, asset }) => {
            const name = screenLabel(screen)
            const canUpload = !screen.hiddenAt
            const pickText = asset ? '사진 바꾸기' : '사진 선택'
            return (
              <li
                key={screen.id}
                className={dropTargetId === screen.id ? `${styles.card} ${styles.dropping}` : styles.card}
                onDragOver={(event) => {
                  if (!canUpload) return
                  event.preventDefault()
                  setDropTargetId(screen.id)
                }}
                onDragLeave={(event) => {
                  // 카드 안의 사진·버튼으로 옮겨 갈 때도 leave가 일어나서, 카드를 정말 벗어났을 때만 강조를 끈다.
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTargetId(undefined)
                }}
                onDrop={(event) => canUpload && handleDrop(screen.id, event)}
              >
                <h2>
                  {name}
                  {screen.hiddenAt && <span className={styles.hiddenTag}>숨김</span>}
                </h2>
                {asset ? (
                  // 화면 아래쪽 카드의 큰 사진은 보일 때 받는다.
                  <img src={assetUrl(asset.id)} width={asset.width} height={asset.height} alt={name} loading="lazy" />
                ) : (
                  <p className={styles.empty}>사진 없음 · 여기에 끌어다 놓아도 돼요</p>
                )}
                <div className={styles.cardActions}>
                  {canUpload && (
                    <label className={busy ? `${styles.fileButton} ${styles.fileButtonDisabled}` : styles.fileButton}>
                      {pickText}
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        aria-label={`${name} ${pickText}`}
                        disabled={busy}
                        onChange={(event) => handleFileChange(screen.id, event)}
                      />
                    </label>
                  )}
                  {asset && (
                    <Button variant="secondary" disabled={busy} onClick={() => handleRemove(screen.id)}>
                      빼기
                    </Button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

// 다른 프로젝트의 준비 화면으로 바로 가면 React가 이 화면을 다시 써서 이전 프로젝트의 칸과 사진이 남는다.
// key를 id로 주면 id가 바뀔 때 새로 시작하고, 이전 화면에 늦게 온 응답은 버려진다.
export const DraftPage = () => {
  const { id = '' } = useParams()
  return <DraftEditor key={id} id={id} />
}
