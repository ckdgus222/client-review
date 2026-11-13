import { PrismaService } from '../src/prisma/prisma.service.js';
import { resetDatabase } from './reset-database.js';

describe('로그인 표와 테스트 DB', () => {
  const prisma = new PrismaService();
  const expiresAt = new Date('2030-01-01T00:00:00.000Z');
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('실제 연결된 DB는 client_review_test다', async () => {
    const result = await prisma.$queryRaw<{ name: string }[]>`
      SELECT current_database() AS name
    `;

    expect(result).toEqual([{ name: 'client_review_test' }]);
  });

  it('같은 이메일로 사용자를 두 번 만들 수 없다', async () => {
    await prisma.user.create({
      data: { email: 'user@example.com', name: '첫 사용자' },
    });

    await expect(
      prisma.user.create({
        data: { email: 'user@example.com', name: '다른 사용자' },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(await prisma.user.count()).toBe(1);
  });

  it('같은 이메일로 로그인 코드를 두 줄 만들 수 없다', async () => {
    await prisma.loginCode.create({
      data: {
        email: 'new@example.com',
        codeHash: 'first-code-hash',
        expiresAt,
      },
    });

    await expect(
      prisma.loginCode.create({
        data: {
          email: 'new@example.com',
          codeHash: 'second-code-hash',
          expiresAt,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(await prisma.loginCode.count()).toBe(1);
  });

  it('동시에 같은 이메일의 코드를 저장해도 한 줄만 생긴다', async () => {
    const results = await Promise.allSettled(
      ['first-code-hash', 'second-code-hash'].map((codeHash) =>
        prisma.loginCode.create({
          data: { email: 'new@example.com', codeHash, expiresAt },
        }),
      ),
    );

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ code: 'P2002' }),
      }),
    ]);
    expect(await prisma.loginCode.count()).toBe(1);
  });

  it('다른 사용자라도 같은 토큰 해시의 세션을 만들 수 없다', async () => {
    const firstUser = await prisma.user.create({
      data: { email: 'first@example.com', name: '첫 사용자' },
    });
    const secondUser = await prisma.user.create({
      data: { email: 'second@example.com', name: '둘째 사용자' },
    });
    await prisma.session.create({
      data: { userId: firstUser.id, tokenHash: 'same-token-hash', expiresAt },
    });

    await expect(
      prisma.session.create({
        data: {
          userId: secondUser.id,
          tokenHash: 'same-token-hash',
          expiresAt,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(await prisma.session.count()).toBe(1);
  });

  it('없는 사용자의 id로 세션을 만들 수 없다', async () => {
    await expect(
      prisma.session.create({
        data: {
          userId: '00000000-0000-4000-8000-000000000001',
          tokenHash: 'orphan-token-hash',
          expiresAt,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
    expect(await prisma.session.count()).toBe(0);
  });

  it('사용자를 지우면 그 사람의 모든 세션만 지워진다', async () => {
    const removedUser = await prisma.user.create({
      data: { email: 'removed@example.com', name: '삭제할 사용자' },
    });
    const remainingUser = await prisma.user.create({
      data: { email: 'remaining@example.com', name: '남길 사용자' },
    });
    await prisma.session.createMany({
      data: [
        { userId: removedUser.id, tokenHash: 'first-token-hash', expiresAt },
        { userId: removedUser.id, tokenHash: 'second-token-hash', expiresAt },
        {
          userId: remainingUser.id,
          tokenHash: 'remaining-token-hash',
          expiresAt,
        },
      ],
    });
    expect(await prisma.session.count()).toBe(3);

    await prisma.user.delete({ where: { id: removedUser.id } });

    expect(await prisma.session.findMany()).toEqual([
      expect.objectContaining({
        userId: remainingUser.id,
        tokenHash: 'remaining-token-hash',
      }),
    ]);
    expect(await prisma.user.findUnique({ where: { id: remainingUser.id } })).not.toBeNull();
  });

  it('users의 id와 created_at을 생략하면 DB가 UUID와 현재 시각을 만든다', async () => {
    // Prisma의 기본값 처리를 거치지 않고 DB 자체의 기본값을 검사한다.
    const [row] = await prisma.$queryRaw<{ id: string; created_at_is_now: boolean }[]>`
      INSERT INTO users (email, name)
      VALUES ('user@example.com', '사용자')
      RETURNING id, created_at = now() AS created_at_is_now
    `;

    expect(row.id).toMatch(uuidPattern);
    expect(row.created_at_is_now).toBe(true);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: row.id } })).toEqual({
      id: row.id,
      email: 'user@example.com',
      name: '사용자',
      lastSeenAt: null,
      privacyAgreedAt: null,
      createdAt: expect.any(Date),
    });
  });

  it('가입 전 코드도 저장되고 DB가 UUID·발급 시각·시도 0번·미사용 기본값을 만든다', async () => {
    const [row] = await prisma.$queryRaw<{ id: string; created_at_is_now: boolean }[]>`
      INSERT INTO login_codes (email, code_hash, expires_at)
      VALUES ('new@example.com', 'test-code-hash', ${expiresAt})
      RETURNING id, created_at = now() AS created_at_is_now
    `;

    expect(row.id).toMatch(uuidPattern);
    expect(row.created_at_is_now).toBe(true);
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.loginCode.findUniqueOrThrow({ where: { id: row.id } })).toEqual({
      id: row.id,
      email: 'new@example.com',
      codeHash: 'test-code-hash',
      expiresAt,
      attempts: 0,
      usedAt: null,
      privacyAgreed: false,
      createdAt: expect.any(Date),
    });
  });

  it('sessions의 UUID·생성 시각·마지막 사용 시각은 DB가 만든다', async () => {
    const user = await prisma.user.create({
      data: { email: 'user@example.com', name: '사용자' },
    });
    const [row] = await prisma.$queryRaw<
      {
        id: string;
        created_at_is_now: boolean;
        last_seen_at_is_now: boolean;
      }[]
    >`
      INSERT INTO sessions (user_id, token_hash, expires_at)
      VALUES (${user.id}::uuid, 'test-token-hash', ${expiresAt})
      RETURNING id, created_at = now() AS created_at_is_now,
        last_seen_at = now() AS last_seen_at_is_now
    `;

    expect(row.id).toMatch(uuidPattern);
    expect(row.created_at_is_now).toBe(true);
    expect(row.last_seen_at_is_now).toBe(true);
    expect(await prisma.session.findUniqueOrThrow({ where: { id: row.id } })).toEqual({
      id: row.id,
      userId: user.id,
      tokenHash: 'test-token-hash',
      expiresAt,
      lastSeenAt: expect.any(Date),
      createdAt: expect.any(Date),
    });
  });

  it('resetDatabase는 세 표를 모두 비우고 빈 표에서도 다시 실행할 수 있다', async () => {
    const user = await prisma.user.create({
      data: { email: 'user@example.com', name: '사용자' },
    });
    await prisma.loginCode.create({
      data: { email: user.email, codeHash: 'test-code-hash', expiresAt },
    });
    await prisma.session.create({
      data: { userId: user.id, tokenHash: 'test-token-hash', expiresAt },
    });
    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.loginCode.count()).toBe(1);
    expect(await prisma.session.count()).toBe(1);

    await resetDatabase(prisma);

    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.loginCode.count()).toBe(0);
    expect(await prisma.session.count()).toBe(0);
    await expect(resetDatabase(prisma)).resolves.toBeUndefined();
  });
});
