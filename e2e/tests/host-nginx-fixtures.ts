import { execFile } from 'node:child_process'
import { createHash, createPublicKey, randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { test as base, expect, chromium } from '@playwright/test'

const run = promisify(execFile)
const repo = fileURLToPath(new URL('../../', import.meta.url))
const nginxImage = 'nginx:1.30-alpine'
const nodeImage = 'node:24-bookworm-slim'
const domain = 'review.example.test'

type Input = {
  port: number
  ip?: string
  path: string
  method?: string
  headers?: Record<string, string>
  body?: string
}
export type HostResponse = { status: number; headers: Record<string, string>; body: string }
type HostNginx = {
  previewOrigin: string
  liveOrigin: string
  directory: string
  request: (inputs: Input[]) => Promise<HostResponse[]>
}

// 각 테스트는 새 nginx와 제한 카운터를 쓴다. 기존 e2e nginx·DB·운영 설정은 바꾸지 않는다.
export const test = base.extend<{ hostNginx: HostNginx }, { publicBuild: string }>({
  publicBuild: [async ({}, use) => {
    const output = await mkdtemp(path.join(tmpdir(), 'review-host-web-'))
    try {
      await run('npm', ['--prefix', path.join(repo, 'web'), 'run', 'build', '--', '--outDir', output], { timeout: 120_000 })
      await use(output)
    } finally {
      await rm(output, { recursive: true, force: true })
    }
  }, { scope: 'worker' }],
  hostNginx: async ({ publicBuild }, use) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'review-host-nginx-'))
    const name = `review-host-${randomUUID()}`
    const backend = `${name}-backend`
    const containers: string[] = []
    try {
      await run('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 10_000 })
      const certificates = path.join(directory, 'certificates')
      await mkdir(certificates)
      await mkdir(path.join(directory, 'acme'))
      await mkdir(path.join(directory, 'releases/current'), { recursive: true })
      await cp(path.join(repo, 'landing'), path.join(directory, 'releases/current'), { recursive: true })
      await cp(publicBuild, path.join(directory, 'releases/current/app'), { recursive: true })
      await run('python3', ['-c',
        "import runpy, sys; from pathlib import Path; runpy.run_path(sys.argv[1])['prepare_public_pages'](Path(sys.argv[2]))",
        path.join(repo, 'deploy/static-release.py'), path.join(directory, 'releases/current')])

      // 개인키는 임시 디렉터리에서만 만들고 테스트가 끝나면 지운다.
      await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
        '-subj', '/CN=Client Review e2e CA', '-addext', 'basicConstraints=critical,CA:TRUE',
        '-keyout', 'ca.key', '-out', 'ca.pem'], { cwd: certificates })
      await run('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${domain}`,
        '-keyout', 'privkey.pem', '-out', 'server.csr'], { cwd: certificates })
      await writeFile(path.join(certificates, 'extensions.cnf'), [
        `subjectAltName=DNS:${domain}`, 'basicConstraints=critical,CA:FALSE',
        'keyUsage=critical,digitalSignature,keyEncipherment', 'extendedKeyUsage=serverAuth', '',
      ].join('\n'))
      await run('openssl', ['x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key',
        '-CAcreateserial', '-days', '2', '-extfile', 'extensions.cnf', '-out', 'fullchain.pem'], { cwd: certificates })

      for (const [mode, httpPort, httpsPort] of [['preview', '8080', '8443'], ['live', '8081', '8444']]) {
        const { stdout } = await run('python3', [path.join(repo, 'nginx/host/render.py'),
          '--domain', domain, '--cert-name', domain, '--release-root', '/srv/review',
          '--acme-root', '/srv/acme', '--api-port', '14100', '--mode', mode,
          '--http-port', httpPort, '--https-port', httpsPort])
        await writeFile(path.join(directory, `${mode}.conf`), stdout)
      }
      // 원본의 location·헤더·제한은 그대로 두고 nginx의 http 컨텍스트만 제공한다.
      await writeFile(path.join(directory, 'nginx.conf'), [
        'events {}', 'http {', '  include /etc/nginx/mime.types;',
        '  include /test/preview.conf;', '  include /test/live.conf;', '}', '',
      ].join('\n'))
      containers.push(name)
      await run('docker', ['run', '-d', '--rm', '--name', name,
        '--add-host', 'host.docker.internal:host-gateway',
        '-p', '127.0.0.1::8443', '-p', '127.0.0.1::8444',
        '-v', `${directory}:/test:ro`, '-v', `${directory}/releases:/srv/review:ro`,
        '-v', `${directory}/acme:/srv/acme:ro`,
        '-v', `${certificates}:/etc/letsencrypt/live/${domain}:ro`,
        nginxImage, 'nginx', '-c', '/test/nginx.conf', '-g', 'daemon off;'], { timeout: 60_000 })
      await run('docker', ['exec', name, 'nginx', '-t', '-c', '/test/nginx.conf'])
      const apiHost = await run('docker', ['exec', name, 'getent', 'hosts', 'host.docker.internal'])
      containers.push(backend)
      await run('docker', ['run', '-d', '--rm', '--name', backend,
        '--network', `container:${name}`, '-e', `TEST_API_HOST=${apiHost.stdout.trim().split(/\s+/)[0]}`,
        '-v', `${certificates}:/certificates:ro`,
        '-v', `${repo}/e2e/tests/host-nginx-backend.mjs:/test/backend.mjs:ro`,
        nodeImage, 'node', '/test/backend.mjs', 'serve'], { timeout: 60_000 })
      const request = async (inputs: Input[]): Promise<HostResponse[]> => {
        const { stdout } = await run('docker', ['exec', backend, 'node', '/test/backend.mjs', JSON.stringify(inputs)], {
          timeout: 15_000, maxBuffer: 8 * 1024 * 1024,
        })
        return JSON.parse(stdout)
      }
      await expect.poll(async () => {
        const [response] = await request([{ port: 8443, path: '/api/health' }])
        return response.status
      }, { timeout: 10_000 }).toBe(200)
      const { stdout } = await run('docker', ['inspect', '--format', '{{json .NetworkSettings.Ports}}', name])
      const ports = JSON.parse(stdout)
      await use({
        previewOrigin: `https://${domain}:${ports['8443/tcp'][0].HostPort}`,
        liveOrigin: `https://${domain}:${ports['8444/tcp'][0].HostPort}`,
        directory, request,
      })
    } finally {
      const cleanup = await Promise.allSettled(containers.reverse().map((container) =>
        run('docker', ['rm', '-f', container], { timeout: 10_000 })))
      await rm(directory, { recursive: true, force: true })
      const failures = cleanup.filter((result) => result.status === 'rejected')
      if (failures.length) throw new AggregateError(failures.map((result) => result.reason), '시험 컨테이너 정리 실패')
    }
  },
  // Trust only this fixture's ephemeral public key, without changing the OS trust store.
  page: async ({ hostNginx }, use) => {
    const certificate = await readFile(path.join(hostNginx.directory, 'certificates/fullchain.pem'))
    const key = createPublicKey(certificate).export({ type: 'spki', format: 'der' })
    const pin = createHash('sha256').update(key).digest('base64')
    const browser = await chromium.launch({
      args: [`--host-resolver-rules=MAP ${domain} 127.0.0.1`, `--ignore-certificate-errors-spki-list=${pin}`, '--no-proxy-server'],
    })
    try {
      const context = await browser.newContext({ ignoreHTTPSErrors: false })
      await use(await context.newPage())
      await context.close()
    } finally {
      await browser.close()
    }
  },
})

export { expect }
