import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import apiConfig from '../../api/vitest.config.ts'
import browserConfig from '../playwright.config.ts'

test('테스트 DB가 아닌 주소면 설정을 읽을 때 멈춘다', () => {
  // 실제 비밀번호 대신 고유한 시험용 문자열을 써서 오류 출력의 노출 여부만 확인한다.
  const password = 'fake-password-for-config-test'
  const env = { ...process.env }
  env.TEST_DATABASE_URL = `postgresql://u:${password}@localhost:5434/client_review`
  // 부모가 검증한 DB 주소를 물려받아 잘못된 TEST_DATABASE_URL을 가리지 않게 한다.
  delete env.DATABASE_URL

  // --list는 서버와 브라우저를 띄우지 않으므로 설정을 읽는 단계의 실패만 확인할 수 있다.
  // 어떤 파일에도 맞지 않는 거르개를 줘서 시험 파일을 읽지 않게 한다. 이 파일이 가져오는 api 설정에도 같은 검사가 있어서,
  // 시험 파일까지 읽으면 Playwright 설정의 검사가 빠져도 그쪽이 대신 멈춰 이 시험이 통과해 버린다.
  const result = spawnSync('npx', ['playwright', 'test', '--list', 'no-test-file-matches-this'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env,
    encoding: 'utf8',
    timeout: 20_000,
  })
  const output = `${result.stdout}\n${result.stderr}`

  // 실행 실패나 시간 초과를 DB 주소 검사에 의한 종료로 잘못 판단하지 않게 한다.
  expect(result.error).toBeUndefined()
  expect(result.status).not.toBeNull()
  expect(result.status).not.toBe(0)
  expect(output).toContain('TEST_DATABASE_URL의 DB 이름은 client_review_test여야 해요')
  expect(output).not.toContain(password)
})

test('브라우저 테스트 설정은 .only를 허용하지 않는다', () => {
  expect(browserConfig.forbidOnly).toBe(true)
})

test('api 테스트 설정은 .only를 허용하지 않는다', () => {
  expect(apiConfig.test?.allowOnly).toBe(false)
})
