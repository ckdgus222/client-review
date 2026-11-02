import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

// Docker는 환경 변수를 직접 넘기고 .env 파일이 없다. 맥에서만 루트 .env를 읽는다.
// 경로는 api 폴더 기준이라 Prisma 명령은 api 폴더에서 실행한다.
if (existsSync('../.env')) process.loadEnvFile('../.env');

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    // Docker 빌드의 prisma generate는 주소 없이 돌아야 한다. Prisma의 env()는 값이 없으면 오류를 내서 쓰지 않는다.
    url: process.env.DATABASE_URL ?? '',
  },
});
