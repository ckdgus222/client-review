import type { ReactNode } from 'react'
import { Link } from 'react-router'
import type { ProjectDetail } from '../api/projects.ts'
import styles from './PageLayout.module.css'

type PageLayoutProps = {
  children: ReactNode
}

export const PageLayout = ({ children }: PageLayoutProps) => (
  <>
    <header className={styles.header}>
      <a className={styles.brand} href="/">
        <img src={`${import.meta.env.BASE_URL}favicon.svg`} width="28" height="28" alt="" />
        <span>Client Review</span>
      </a>
    </header>
    <main className={styles.main}>{children}</main>
  </>
)

type ManagementPage = 'projects' | 'draft' | 'settings' | 'activity'
type SectionLink = { id: string; title: string; count: number }

type ManagementLayoutProps = PageLayoutProps & {
  active: ManagementPage
  project?: ProjectDetail
  sections?: SectionLink[]
}

export const ManagementLayout = ({ active, project, sections = [], children }: ManagementLayoutProps) => {
  const projectPath = project ? `/projects/${project.id}` : ''
  return (
    <div className={styles.workspace}>
      <nav className={styles.menu} aria-label="프로젝트 메뉴">
        <Link to="/" aria-current={active === 'projects' ? 'page' : undefined}>내 프로젝트</Link>
        {sections.filter(({ count }) => count > 0).map(({ id, title, count }) => (
          <a href={`#${id}`} key={id}>{title} <span>{count}</span></a>
        ))}
        {project && (
          <>
            <Link to={projectPath}>검수실</Link>
            {project.myRole === 'DEVELOPER' && (
              <>
                <Link to={`${projectPath}/draft`} aria-current={active === 'draft' ? 'page' : undefined}>버전 준비</Link>
                <Link to={`${projectPath}/settings`} aria-current={active === 'settings' ? 'page' : undefined}>프로젝트 설정</Link>
              </>
            )}
            <Link to={`${projectPath}/activity`} aria-current={active === 'activity' ? 'page' : undefined}>활동 일지</Link>
          </>
        )}
      </nav>
      <div className={styles.content}>{children}</div>
    </div>
  )
}
