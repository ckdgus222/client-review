import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* 브라우저 주소를 읽는 Router는 여기 한 곳에만 둔다. 테스트는 App을 MemoryRouter로 감싼다.
        basename은 vite.config.ts의 base(/app/)와 맞춘다. 끝에 /를 붙이면 /app 주소를 못 찾는다. */}
    <BrowserRouter basename="/app">
      <App />
    </BrowserRouter>
  </StrictMode>,
)
