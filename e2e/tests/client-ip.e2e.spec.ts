import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import type { APIRequestContext, APIResponse } from '@playwright/test'
import { test, expect, resetDatabase } from './fixtures.ts'

test.use({ baseURL: 'http://localhost:4103' })

test.beforeEach(async () => {
  await resetDatabase()
})

// DB를 비워도 nginx의 IP별 횟수는 남는다. 테스트마다 다른 문서용 IP를 쓴다.
// 이메일은 요청마다 달라야 api의 이메일별 60초 제한과 구별할 수 있다.
const requestCode = (request: APIRequestContext, ip: string, path = '/api/auth/email-code') =>
  request.post(path, {
    headers: { Origin: 'http://localhost:4103', 'X-Forwarded-For': ip },
    data: {
      email: `client-ip-${randomUUID()}@example.com`,
      privacyAgreed: true,
    },
  })

const fillIpLimit = async (request: APIRequestContext, ip: string) => {
  const responses = await Promise.all(Array.from({ length: 6 }, () => requestCode(request, ip)))
  expect(responses.map((response) => response.status())).toEqual([204, 204, 204, 204, 204, 204])
}

const expectIpLimited = async (response: APIResponse) => {
  expect(response.status()).toBe(429)
  expect(response.headers()['content-type']).toContain('application/json')
  expect(await response.json()).toEqual({
    statusCode: 429,
    code: 'IP_RATE_LIMITED',
  })
}

test('같은 IP에서 로그인 코드를 너무 자주 요청하면 429다', async ({ request }) => {
  const ip = '203.0.113.11'
  await fillIpLimit(request, ip)

  await expectIpLimited(await requestCode(request, ip))
  await expectIpLimited(await requestCode(request, ip))

  // 서버의 실제 시간이 지나야 한 번을 다시 받을 수 있다. 가짜 시계나 재시도로 제한을 우회하지 않는다.
  await delay(6_100)
  expect((await requestCode(request, ip)).status()).toBe(204)
  await expectIpLimited(await requestCode(request, ip))
})

test('주소의 대소문자나 끝의 /를 바꿔도 같은 IP 제한에 걸린다', async ({ request }) => {
  const ip = '203.0.113.12'
  const paths = ['/api/auth/email-code', '/api/auth/EMAIL-CODE', '/api/auth/email-code/']
  const responses = await Promise.all(
    Array.from({ length: 6 }, (_, index) => requestCode(request, ip, paths[index % paths.length])),
  )
  expect(responses.map((response) => response.status())).toEqual([204, 204, 204, 204, 204, 204])

  for (const path of [...paths, '/api/auth/EMAIL-CODE/', '/api//auth/email-code', '/api/auth/email%2Dcode']) {
    await expectIpLimited(await requestCode(request, ip, path))
  }
})

test('한 IP가 막혀도 다른 IP의 고객은 코드를 받는다', async ({ request }) => {
  const blockedIp = '203.0.113.13'
  await fillIpLimit(request, blockedIp)
  await expectIpLimited(await requestCode(request, blockedIp))

  expect((await requestCode(request, '198.51.100.13')).status()).toBe(204)
  await expectIpLimited(await requestCode(request, blockedIp))
})

test('믿는 앞단이 아닌 곳에서 보낸 X-Forwarded-For로는 제한을 피할 수 없다', async () => {
  const runFile = promisify(execFile)
  const { stdout } = await runFile('docker', [
    'inspect',
    '-f',
    '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
    'client-review-e2e-nginx',
  ])
  const nginxIp = stdout.trim()
  expect(nginxIp).toMatch(/^\d+\.\d+\.\d+\.\d+$/)
  const containerName = `client-review-ip-test-${randomUUID()}`

  // 한 컨테이너에서 직접 보내야 실제 출발 IP는 같고 위조한 머리글만 달라진다.
  // wget은 429에서 실패하므로 계속 요청하되, -S가 출력한 실제 HTTP 상태를 모두 검사한다.
  try {
    const { stderr } = await runFile(
      'docker',
      [
        'run',
        '--rm',
        '--name',
        containerName,
        '--network',
        'bridge',
        'nginx:1.30-alpine',
        'sh',
        '-c',
        String.raw`for attempt in 1 2 3 4 5 6 7 8; do
          wget -S -O /dev/null -T 5 \
            --header='Content-Type: application/json' \
            --header='Origin: http://localhost:4103' \
            --header="X-Forwarded-For: 198.51.100.$attempt" \
            --post-data="{\"email\":\"$2-$attempt@example.com\",\"privacyAgreed\":true}" \
            "http://$1/api/auth/email-code" || true
        done`,
        'sh',
        nginxIp,
        randomUUID(),
      ],
      { timeout: 20_000 },
    )

    // 429에서는 wget이 오류 줄("wget: server returned error: HTTP/1.1 429 ...")에도 상태를 한 번 더 찍는다.
    // -S가 찍은 줄(줄 맨 앞이 HTTP)만 센다.
    const statuses = [...stderr.matchAll(/^\s*HTTP\/1\.[01]\s+(\d{3})/gm)].map((match) => Number(match[1]))
    expect(statuses, stderr).toEqual([204, 204, 204, 204, 204, 204, 429, 429])
  } finally {
    // 명령이 시간 초과로 끊겨도 테스트가 만든 컨테이너를 남기지 않는다.
    await runFile('docker', ['rm', '-f', containerName], { timeout: 5_000 })
  }
})

test('IP 제한에 걸리면 로그인 화면에 요청이 너무 많다는 문구가 보인다', async ({ page, request }) => {
  const ip = '203.0.113.15'
  await page.setExtraHTTPHeaders({ 'X-Forwarded-For': ip })
  await page.goto('/app/login')
  await page.getByLabel('이메일', { exact: true }).fill(`client-ip-${randomUUID()}@example.com`)
  await page
    .getByRole('checkbox', {
      name: '개인정보 수집·이용에 동의해요(필수)',
      exact: true,
    })
    .check()
  await fillIpLimit(request, ip)

  const responsePromise = page.waitForResponse(
    (response) =>
      response.url() === 'http://localhost:4103/api/auth/email-code' && response.request().method() === 'POST',
  )
  await page.getByRole('button', { name: '코드 받기', exact: true }).click()
  const response = await responsePromise

  expect(response.status()).toBe(429)
  expect(await response.json()).toEqual({
    statusCode: 429,
    code: 'IP_RATE_LIMITED',
  })
  await expect(
    page.getByText('요청이 너무 많아요. 잠시 뒤 다시 시도해 주세요', {
      exact: true,
    }),
  ).toBeVisible()
  await expect(page.getByText('코드는 1분에 한 번만 받을 수 있어요', { exact: true })).toHaveCount(0)
  await expect(page.getByLabel('로그인 코드', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '코드 받기', exact: true })).toBeEnabled()
})

test('IP 제한은 코드 요청에만 걸리고 다른 요청은 그대로다', async ({ request }) => {
  const ip = '203.0.113.16'
  await fillIpLimit(request, ip)
  await expectIpLimited(await requestCode(request, ip))

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const response = await request.get('/api/health', {
      headers: { 'X-Forwarded-For': ip },
    })
    expect(response.status()).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok' })
  }
  await expectIpLimited(await requestCode(request, ip))
})
