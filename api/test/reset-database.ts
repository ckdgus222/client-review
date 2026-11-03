import type { PrismaClient } from '../src/generated/prisma/client.js';
import { TEST_DATABASE_NAME } from './test-database-url.js';

// 테스트가 시작할 때 쓰는 표를 비운다. 주소 검사와 별개로, 실제로 붙은 DB 이름을 한 번 더 확인한다.
// 주소에 다른 DB를 고르는 옵션이 붙어 있어도 개발 DB는 지우지 않는다.
export const resetDatabase = async (prisma: PrismaClient) => {
  const [{ name }] = await prisma.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
  if (name !== TEST_DATABASE_NAME)
    throw new Error(`테스트 DB가 아니라서 표를 비우지 않아요: ${name}`);

  // 표를 새로 만들면 여기에 더한다. 다른 표가 users를 가리키는데 빠뜨리면 TRUNCATE가 실패해서 알 수 있다.
  await prisma.$executeRaw`TRUNCATE users, login_codes, sessions`;
};
