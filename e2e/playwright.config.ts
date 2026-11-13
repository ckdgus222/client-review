import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'
import { assertTestDatabaseUrl } from '../api/test/test-database-url.ts'

// 개발 서버(api 4100, web 5173)를 켜 둔 채로 돌려도 부딪치지 않게 다른 포트를 쓴다.
const API_PORT = 4101
const WEB_PORT = 5174
const WEB_ORIGIN = `http://localhost:${WEB_PORT}`
// 소개·약관 테스트는 배포와 같은 nginx 이미지(nginx/Dockerfile과 같은 판)로 띄운다(docs/landing.md 정할 것 3). 앱·api도 이 주소로 넘겨서
// 소개 → 로그인 → 방침을 한 주소에서 실제로 눌러 간다.
const NGINX_PORT = 4103
const NGINX_ORIGIN = `http://localhost:${NGINX_PORT}`
const NGINX_CONTAINER = 'client-review-e2e-nginx'
const repoPath = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url))

// api 테스트(vitest.config.ts)와 같은 방법으로 루트 .env를 읽는다. 이미 있는 환경 변수는 덮지 않는다.
const envFile = fileURLToPath(new URL('../.env', import.meta.url))
if (existsSync(envFile)) process.loadEnvFile(envFile)

// 테스트는 표를 비우므로 개발 DB 대신 테스트 DB에 붙인다. 검사를 통과한 주소만 쓴다.
// 여기서 바꾸면 서버(마이그레이션 포함)와 테스트 도우미가 모두 이 주소를 물려받는다.
// 주소가 틀리면 설정을 읽다가 멈춰서 서버도 마이그레이션도 시작하지 않는다.
process.env.DATABASE_URL = assertTestDatabaseUrl(process.env.TEST_DATABASE_URL)

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.e2e.spec.ts',
  // 테스트가 DB를 비워서 동시에 돌면 서로 데이터를 지운다(api 테스트의 fileParallelism: false와 같은 이유).
  workers: 1,
  // .only가 남으면 다른 테스트가 조용히 빠진다. 남아 있으면 실행을 실패시킨다.
  forbidOnly: true,
  // 다시 시도하면 가끔 실패하는 테스트가 통과로 보인다. 커밋 검사가 결과를 그대로 믿도록 한 번만 돌린다.
  retries: 0,
  // 커밋 검사(verify.mjs)가 이 JSON에서 어떤 테스트가 통과했는지 읽는다.
  reporter: [['list'], ['json', { outputFile: '../.e2e-results/browser.json' }]],
  use: {
    baseURL: WEB_ORIGIN,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // 마이그레이션을 서버 바로 앞에서 돌린다. webServer가 globalSetup보다 먼저 뜨기 때문에,
      // 테스트 DB가 없을 때 globalSetup에서 만들면 api가 먼저 켜지다 실패한다.
      command: 'npx prisma migrate deploy && npm run start',
      cwd: '../api',
      url: `http://localhost:${API_PORT}/api/health`,
      // 켜 둔 개발 서버를 잘못 쓰지 않게 늘 새로 띄운다.
      reuseExistingServer: false,
      // nest start가 먼저 빌드해서 시간이 걸린다.
      timeout: 120_000,
      env: {
        PORT: String(API_PORT),
        // nginx 주소(4103)에서 연 로그인 화면의 요청도 다른 사이트 요청 막기(OriginGuard)를 통과해야 한다.
        APP_ORIGINS: `${WEB_ORIGIN},${NGINX_ORIGIN}`,
        // 서버가 뒤에 /app/invite/<토큰>을 붙인다. 브라우저가 여는 앱 주소(/app/)와 다르다.
        APP_URL: WEB_ORIGIN,
        ASSET_DIR: fileURLToPath(new URL('./.assets', import.meta.url)),
        // 루트 .env에 실제 SMTP 값을 넣어도 테스트의 api는 메일을 보내지 않고 로그에 찍는다(docs/mail.md).
        MAIL_MODE: 'log',
      },
    },
    {
      // Vite는 localhost를 IPv6(::1)로만 연다. Docker 안의 nginx는 맥의 IPv4 루프백에만 닿아서 127.0.0.1로 연다.
      command: `npm run dev -- --host 127.0.0.1 --port ${WEB_PORT} --strictPort`,
      cwd: '../web',
      url: `${WEB_ORIGIN}/app/`,
      reuseExistingServer: false,
      env: { API_PROXY_TARGET: `http://localhost:${API_PORT}` },
    },
    {
      // 지난 실행이 남긴 컨테이너를 먼저 지운다. 끝낼 때는 SIGTERM을 docker가 컨테이너로 넘기고 --rm이 지운다.
      command: [
        `docker rm -f ${NGINX_CONTAINER} >/dev/null 2>&1;`,
        // 127.0.0.1에만 연다. 모든 주소로 열면 같은 망의 다른 기기가 nginx를 거쳐 개발 서버에 닿는다.
        `exec docker run --rm --name ${NGINX_CONTAINER} -p 127.0.0.1:${NGINX_PORT}:80`,
        '--add-host=host.docker.internal:host-gateway',
        `-v ${repoPath('landing')}:/usr/share/nginx/html:ro`,
        `-v ${repoPath('nginx/landing.conf')}:/etc/nginx/landing.conf:ro`,
        `-v ${repoPath('e2e/nginx.e2e.conf')}:/etc/nginx/conf.d/default.conf:ro`,
        'nginx:1.30-alpine',
      ].join(' '),
      url: `${NGINX_ORIGIN}/`,
      reuseExistingServer: false,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
    },
  ],
})
