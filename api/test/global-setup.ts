import { execFileSync } from 'node:child_process';

// 테스트 전에 한 번, 테스트 DB를 최신 표 설계에 맞춘다. DB가 없으면 migrate deploy가 만든다.
// DATABASE_URL은 vitest.config.ts가 이미 검사를 통과한 테스트 DB 주소로 바꿔 두었다.
export default () => {
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], { stdio: 'pipe' });
};
