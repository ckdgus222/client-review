import { Route, Routes } from 'react-router'
import { PageLayout } from './components/PageLayout.tsx'
import { ActivityPage } from './pages/ActivityPage.tsx'
import { ComparePage } from './pages/ComparePage.tsx'
import { DraftPage } from './pages/DraftPage.tsx'
import { InvitePage } from './pages/InvitePage.tsx'
import { LoginPage } from './pages/LoginPage.tsx'
import { NotFoundPage } from './pages/NotFoundPage.tsx'
import { ProjectListPage } from './pages/ProjectListPage.tsx'
import { ProjectSettingsPage } from './pages/ProjectSettingsPage.tsx'
import { ReviewRoomPage } from './pages/ReviewRoomPage.tsx'

const App = () => (
  <PageLayout>
    <Routes>
      <Route path="/" element={<ProjectListPage />} />
      <Route path="/projects/:id" element={<ReviewRoomPage />} />
      <Route path="/projects/:id/settings" element={<ProjectSettingsPage />} />
      <Route path="/projects/:id/draft" element={<DraftPage />} />
      <Route path="/projects/:id/activity" element={<ActivityPage />} />
      {/* 쪽지의 처음 사진과 고친 사진을 나란히 본다. 쪽지 id만으로 열어서 프로젝트 id는 서버가 알려 준다. */}
      <Route path="/issues/:id/compare" element={<ComparePage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/invite/:token" element={<InvitePage />} />
      {/* 다른 어느 주소와도 맞지 않으면 여기로 온다. */}
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  </PageLayout>
)

export default App
