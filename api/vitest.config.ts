import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library`. Requires Vite 8, which ships this option.
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.spec.ts'],
    // 테스트는 실제 DB에 붙어서 DATABASE_URL이 필요하다. 루트 .env 값을 테스트에 넘긴다.
    // 세 번째 인자 ''는 "이름 앞부분 조건 없이 전부"라는 뜻이다(기본값은 VITE_로 시작하는 것만).
    env: loadEnv('test', '..', ''),
  },
});
