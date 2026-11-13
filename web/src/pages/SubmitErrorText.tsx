import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { projectStatusError } from '../api/projects.ts'
import { ErrorText } from '../components/ErrorText.tsx'
import type { SubmitError } from '../hooks/useLockedSubmit.ts'
import styles from './SubmitErrorText.module.css'

type SubmitErrorTextProps = {
  error: SubmitError
  // 저장됐는지 몰라서 글을 잠근 상태인가(기획 정할 것 12).
  locked: boolean
  onGoLatest: () => void
}

// 쪽지 쓰기와 댓글 쓰기가 같은 문구로 실패를 알린다. 어떤 실패든 쓰던 글은 화면에 그대로 남는다.
export const SubmitErrorText = ({ error, locked, onGoLatest }: SubmitErrorTextProps) => {
  const describe = (): ReactNode => {
    if (error.kind === 'unknown') {
      return locked
        ? '연결을 확인하고 다시 보내 주세요. 저장됐는지 확인하지 못해서, 같은 글을 다시 보낼 때까지 고칠 수 없어요.'
        : '연결을 확인하고 다시 시도해 주세요'
    }
    if (error.kind === 'session') {
      // 같은 탭에서 로그인하러 가면 쓰던 글과 요청 번호가 사라진다. 그래서 로그인 화면을 새 탭으로 연다.
      return (
        <>
          로그인이 끝났어요. 다른 탭에서 로그인한 뒤 다시 눌러 주세요{' '}
          <Link to="/login" target="_blank" rel="noreferrer">
            새 탭에서 로그인하기
          </Link>
        </>
      )
    }
    if (error.kind === 'conflict' && error.code === 'VERSION_CHANGED') {
      return (
        <>
          새 버전이 올라왔어요. 쓰던 글은 그대로 남아 있어요.{' '}
          <button type="button" className={styles.link} onClick={onGoLatest}>
            최신 버전 보기
          </button>
        </>
      )
    }
    if (error.kind === 'conflict' && error.code === 'VERSION_NOT_IN_REVIEW') {
      return '승인된 버전이라 더 쓸 수 없어요.'
    }
    if (error.kind === 'rejected' && error.status === 422) return '입력한 내용을 확인해 주세요'
    if (error.kind === 'rejected' && error.status === 404) return '찾을 수 없어요. 화면을 새로 고쳐 주세요'
    // 보관·삭제 대기 프로젝트의 쓰기는 서버가 409로 막는다. 승인 창도 모르는 409를 여기로 넘겨서 같은 문구가 보인다.
    const statusError = error.kind === 'conflict' ? projectStatusError(error.code) : undefined
    return statusError ?? '잠시 뒤 다시 시도해 주세요'
  }

  return <ErrorText message={describe()} />
}
