import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  // 빌드 파일 주소가 /app/... 이 된다. nginx가 /app/ 아래에서 이 앱을 보낸다.
  base: '/app/',
  plugins: [react()],
  server: {
    // 개발 중 /api 요청을 맥에서 켠 api로 넘긴다. 같은 주소처럼 보여서 CORS 설정이 필요 없다.
    proxy: { '/api': 'http://localhost:4100' },
  },
})
