/// <reference types="vitest/config" />
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
  test: {
    // 진짜 브라우저 없이 document를 흉내 내서 화면 부품을 그려 본다.
    environment: 'jsdom',
    // describe·it을 import 없이 쓴다(api와 같은 방식). Testing Library의 자동 정리도 이 설정이 있어야 동작한다.
    globals: true,
  },
})
