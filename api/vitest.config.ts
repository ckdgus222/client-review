import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import { assertTestDatabaseUrl } from './test/test-database-url.js';

// 테스트는 실제 DB에 붙는다. prisma.config.ts와 같은 방법으로 루트 .env를 읽는다.
if (existsSync('../.env')) process.loadEnvFile('../.env');

// 테스트는 표를 비우므로 개발 DB 대신 테스트 DB에 붙인다. 검사를 통과한 주소만 쓴다.
// 여기서 바꾸면 globalSetup(마이그레이션)과 테스트 파일이 모두 이 주소를 물려받는다.
process.env.DATABASE_URL = assertTestDatabaseUrl(process.env.TEST_DATABASE_URL);
// 루트 .env에 실제 SMTP 값을 넣어도 테스트는 메일을 보내지 않고 로그에 찍는다(docs/mail.md).
process.env.MAIL_MODE = 'log';

export default defineConfig({
  test: {
    globals: true,
    include: ['**/*.spec.ts'],
    globalSetup: ['./test/global-setup.ts'],
    // 테스트 파일마다 표를 비운다. 동시에 돌면 서로 데이터를 지워서 하나씩 차례로 돌린다.
    fileParallelism: false,
    // .only가 남으면 다른 테스트가 조용히 빠진다. 남아 있으면 실행을 실패시킨다.
    allowOnly: false,
    // 커밋 검사(verify.mjs)가 이 JSON에서 어떤 e2e 테스트가 통과했는지 읽는다.
    reporters: ['default', 'json'],
    outputFile: { json: '../.e2e-results/api.json' },
  },
});
