import { Link } from 'react-router'
import styles from './NotFoundPage.module.css'

export const NotFoundPage = () => (
  <section className={styles.card}>
    <span className={styles.code} aria-hidden="true">404</span>
    <h1>없는 화면이에요</h1>
    <p>주소가 맞는지 확인해 주세요.</p>
    <Link className={styles.action} to="/">첫 화면으로 가기</Link>
  </section>
)
