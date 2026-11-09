import { Route, Routes } from 'react-router'
import { PageLayout } from './components/PageLayout.tsx'
import { ActivityPage } from './pages/ActivityPage.tsx'
import { DraftPage } from './pages/DraftPage.tsx'
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
      <Route path="/login" element={<LoginPage />} />
      {/* 다른 어느 주소와도 맞지 않으면 여기로 온다. */}
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  </PageLayout>
)

export default App
