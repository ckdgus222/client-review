import { Route, Routes } from 'react-router'
import { PageLayout } from './components/PageLayout.tsx'
import { HomePage } from './pages/HomePage.tsx'
import { LoginPage } from './pages/LoginPage.tsx'
import { NotFoundPage } from './pages/NotFoundPage.tsx'

const App = () => (
  <PageLayout>
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/login" element={<LoginPage />} />
      {/* 다른 어느 주소와도 맞지 않으면 여기로 온다. */}
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  </PageLayout>
)

export default App
