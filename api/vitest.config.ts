import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// 테스트는 실제 DB에 붙어서 DATABASE_URL이 필요하다. prisma.config.ts와 같은 방법으로 루트 .env를 읽는다.
if (existsSync('../.env')) process.loadEnvFile('../.env');

export default defineConfig({
  test: {
    globals: true,
    include: ['**/*.spec.ts'],
  },
});
