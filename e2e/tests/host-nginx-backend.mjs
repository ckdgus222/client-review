import http from 'node:http'
import https from 'node:https'
import { readFileSync } from 'node:fs'

// nginx의 제한만 확인하는 합성 로그인 수신기다. 권한 요청은 실제 테스트 API로 보낸다.
if (process.argv[2] === 'serve') {
  http.createServer((request, response) => {
    if (request.url === '/api/health') {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ status: 'ok' }))
      return
    }
    if (/^\/api\/auth\/email-code\/?$/i.test(request.url)) {
      request.resume()
      response.writeHead(204, {
        'X-Test-Client-IP': request.headers['x-forwarded-for'] ?? '',
        'X-Test-Real-IP': request.headers['x-real-ip'] ?? '',
        'X-Test-Host': request.headers.host ?? '',
        'X-Test-Proto': request.headers['x-forwarded-proto'] ?? '',
      })
      response.end()
      return
    }
    const upstream = http.request({
      hostname: process.env.TEST_API_HOST, port: 4101,
      method: request.method, path: request.url, headers: request.headers,
    }, (result) => {
      response.writeHead(result.statusCode, result.headers)
      result.pipe(response)
    })
    upstream.on('error', () => { response.writeHead(502); response.end() })
    request.pipe(upstream)
  }).listen(14100, '127.0.0.1')
} else {
  const requests = JSON.parse(process.argv[2])
  const results = await Promise.all(requests.map((input) => new Promise((resolve, reject) => {
    const request = https.request({
      hostname: '127.0.0.1', port: input.port, servername: 'review.example.test',
      localAddress: input.ip, method: input.method ?? 'GET', path: input.path,
      ca: readFileSync('/certificates/ca.pem'), rejectUnauthorized: true,
      agent: false,
      headers: { Host: 'review.example.test', ...input.headers },
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve({
        status: response.statusCode, headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
      response.on('error', reject)
    })
    request.setTimeout(5_000, () => request.destroy(new Error('TLS request timed out')))
    request.on('error', reject)
    request.end(input.body)
  })))
  process.stdout.write(JSON.stringify(results))
}
