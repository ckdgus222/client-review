import { randomUUID } from 'node:crypto';
import { developerEmail, isDeveloper } from '../auth/developer.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

const WITHDRAWN_NAME = '탈퇴한 사용자';

// 탈퇴 처리의 본체. 부른 쪽의 트랜잭션 안에서 돈다: 탈퇴 스크립트(withdrawUser)는 이것 하나를 한 트랜잭션으로 돌리고,
// 복원 뒤 다시 적용 스크립트(replay-records)는 다른 기록들과 같은 트랜잭션에서 돌린다(docs/deploy.md 정할 것 16).
// 따로 확정하면 뒤의 기록이 실패해도 탈퇴만 남고, 같은 트랜잭션에서 방금 만든 사용자가 보이지 않는다.
// 쪽지·댓글·승인 기록 줄은 남고 작성자 이름만 WITHDRAWN_NAME으로 보인다(docs/landing.md 정할 것 13·14).
// revokedAt은 참여 철회 시각으로 적을 글자다. 다시 적용 스크립트는 기록의 시각을 넘긴다.
// 그때도 now()로 적으면 같은 기록을 다시 적용할 때마다 철회 시각이 달라진다.
export const withdrawUserIn = async (
  tx: Prisma.TransactionClient,
  rawEmail: string,
  revokedAt: string | null = null,
) => {
  const email = rawEmail.trim().toLowerCase();
  // 설정이 비어 있으면 isDeveloper가 늘 false라 개발자 계정을 지킬 수 없다. 그래서 아예 시작하지 않는다.
  if (!developerEmail()) throw new Error('DEVELOPER_EMAIL이 없어요');
  if (isDeveloper(email)) throw new Error('개발자 계정은 탈퇴 처리하지 않아요');

  const [user] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM users WHERE email = ${email} FOR UPDATE
  `;
  if (!user) throw new Error('그 이메일의 사용자가 없어요');

  // 승인자 칸이 참여 줄을 가리켜서, 참여를 철회하기 전에 비운다.
  const approverCleared = await tx.$executeRaw`
    UPDATE projects SET approver_member_id = NULL
    WHERE approver_member_id IN (SELECT id FROM project_members WHERE user_id = ${user.id}::uuid)
  `;
  const membershipsRevoked = await tx.$executeRaw`
    UPDATE project_members SET revoked_at = COALESCE(${revokedAt}::timestamptz, now())
    WHERE user_id = ${user.id}::uuid AND revoked_at IS NULL
  `;
  // .invalid는 메일이 갈 수 없는 예약 도메인이다. 사용자 id를 넣어 고유 제약을 지킨다.
  // 마지막 접속·동의 시각도 방침이 계정 정보로 적은 항목이라 함께 비운다.
  // 운영 기록에 적을 탈퇴 시각(위의 철회 시각과 같은 값)도 이 문장에서 함께 받는다. 확정한 뒤에 따로 읽다가 실패하면
  // 탈퇴는 됐는데 기록이 없어서, 복원 뒤 그 탈퇴를 다시 적용할 길이 없다.
  const [{ time }] = await tx.$queryRaw<{ time: string }[]>`
    UPDATE users
    SET name = ${WITHDRAWN_NAME}, email = 'withdrawn-' || id || '@invalid', last_seen_at = NULL, privacy_agreed_at = NULL
    WHERE id = ${user.id}::uuid
    RETURNING to_char(COALESCE(${revokedAt}::timestamptz, now()) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS time
  `;
  const sessions = await tx.$executeRaw`DELETE FROM sessions WHERE user_id = ${user.id}::uuid`;
  const loginCodes = await tx.$executeRaw`DELETE FROM login_codes WHERE email = ${email}`;
  const invitations = await tx.$executeRaw`DELETE FROM invitations WHERE email = ${email}`;
  const deliveries = await tx.$executeRaw`DELETE FROM notification_deliveries WHERE to_email = ${email}`;

  return {
    userId: user.id,
    time,
    approverCleared,
    membershipsRevoked,
    sessions,
    loginCodes,
    invitations,
    deliveries,
  };
};

// 탈퇴 요청을 손으로 처리하는 스크립트(docs/landing.md 정할 것 12, docs/operations.md 절차).
// api(반복 발송기 포함)를 멈춘 뒤 돌린다. 그래서 로그인·발송과 겹치지 않아 잠금 순서를 따로 맞추지 않는다.
// 한 트랜잭션이라 중간에 하나라도 실패하면 아무것도 바뀌지 않는다.
export const withdrawUser = (prisma: PrismaService, rawEmail: string) =>
  prisma.$transaction((tx) => withdrawUserIn(tx, rawEmail));

// 운영 기록(docs/operations.md)에 그대로 옮겨 적을 항목. 복원 뒤 다시 적용 스크립트가 이 모양을 읽는다.
// 이메일은 적지 않는다. 시각은 다른 기록과 순서를 맞출 수 있게 DB가 백만분의 1초까지 적은 글자다.
export const withdrawalRecord = (userId: string, time: string) =>
  ['사건: USER_WITHDRAWN', `사건 id: ${randomUUID()}`, `시각: ${time}`, `대상 사용자 id: ${userId}`].join('\n');

// npm run withdraw-user -- <이메일>로 직접 실행했을 때만 돈다(테스트는 함수만 가져다 쓴다).
if (import.meta.main) {
  const email = process.argv[2];
  if (!email) {
    console.error('사용: npm run withdraw-user -- <이메일>');
    process.exit(1);
  }
  const prisma = new PrismaService();
  try {
    const result = await withdrawUser(prisma, email);
    console.log(withdrawalRecord(result.userId, result.time));
    // 탈퇴 시각과 바꾸고 지운 개수. 결과 확인에 쓴다.
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
