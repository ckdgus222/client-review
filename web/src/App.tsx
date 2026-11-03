import { Route, Routes } from 'react-router'
import { PageLayout } from './components/PageLayout.tsx'
import { NotFoundPage } from './pages/NotFoundPage.tsx'

const App = () => (
  <PageLayout>
    <Routes>
      <Route path="/" element={<p>준비 중이에요.</p>} />
      {/* 다른 어느 주소와도 맞지 않으면 여기로 온다. */}
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  </PageLayout>
)

export default App
