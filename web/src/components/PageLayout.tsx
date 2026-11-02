import type { ReactNode } from 'react'
import styles from './PageLayout.module.css'

type PageLayoutProps = {
  children: ReactNode
}

export const PageLayout = ({ children }: PageLayoutProps) => (
  <>
    <header className={styles.header}>Client Review</header>
    <main className={styles.main}>{children}</main>
  </>
)
