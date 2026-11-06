import type { ReactNode } from 'react'
import { Link } from 'react-router'
import styles from './ErrorText.module.css'

// 세션이 끝났을 때(401) 보여 줄 문구다. 로그인 화면으로 바로 보내지 않고 링크만 붙여서, 쓰던 글이 화면에 남는다.
// 화면마다 다르게 보이지 않게 이 부품 하나를 같이 쓴다.
export const SessionEnded = () => (
  <>
    로그인이 끝났어요. 다시 로그인해 주세요 <Link to="/login">다시 로그인하기</Link>
  </>
)

// role="alert"라서 화면을 못 보는 사람에게도 오류가 생기자마자 읽어 준다.
export const ErrorText = ({ message }: { message: ReactNode }) => (
  <p className={styles.error} role="alert">
    {message}
  </p>
)
