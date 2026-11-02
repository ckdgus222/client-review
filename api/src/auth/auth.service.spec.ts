import { HttpException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import bcrypt from 'bcrypt';
import { resetDatabase } from '../../test/reset-database.js';
import { MailService } from '../mail/mail.service.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuthService } from './auth.service.js';

const { randomIntMock } = vi.hoisted(() => ({
  randomIntMock: vi.fn(() => 123456),
}));

vi.mock('node:crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:crypto')>()),
  randomInt: randomIntMock,
}));

describe('AuthService.requestCode', () => {
  let module: TestingModule | undefined;
  let prisma: PrismaService;
  let service: AuthService;
  const email = 'login@example.com';
  const sendLoginCode = vi.fn<MailService['sendLoginCode']>();

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [AuthService, MailService],
    })
      .overrideProvider(MailService)
      .useValue({ sendLoginCode })
      .compile();
    prisma = module.get(PrismaService);
    service = module.get(AuthService);
  });

  beforeEach(async () => {
    randomIntMock.mockReset().mockReturnValue(123456);
    sendLoginCode.mockReset();
    await resetDatabase(prisma);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await module?.close();
  });

  it('비용 12의 해시 한 줄을 저장하고 6자리 코드를 한 번 보낸다', async () => {
    const [{ now: before }] = await prisma.$queryRaw<{ now: Date }[]>`
      SELECT now()
    `;
    // 서버 시계가 달라도 발급·만료 시각은 DB 시계를 따라야 한다.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2000-01-01T00:00:00Z'));

    await expect(service.requestCode(email)).resolves.toBeUndefined();

    const [{ now: after }] = await prisma.$queryRaw<{ now: Date }[]>`
      SELECT now()
    `;
    expect(sendLoginCode).toHaveBeenCalledExactlyOnceWith(
      email,
      expect.stringMatching(/^\d{6}$/),
    );
    const code = sendLoginCode.mock.calls[0][1];
    const rows = await prisma.loginCode.findMany();
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).toMatchObject({ email, attempts: 0, usedAt: null });
    expect(row.codeHash).not.toContain(code);
    expect(bcrypt.getRounds(row.codeHash)).toBe(12);
    expect(await bcrypt.compare(code, row.codeHash)).toBe(true);
    expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(row.createdAt.getTime()).toBeLessThanOrEqual(after.getTime());
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(600_000);
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.session.count()).toBe(0);
  });

  it('60초 안에 다시 요청하면 429이고 기존 줄과 메일 횟수를 유지한다', async () => {
    await service.requestCode(email);
    const before = await prisma.loginCode.findUniqueOrThrow({
      where: { email },
    });
    randomIntMock.mockReturnValue(654321);

    await expect(service.requestCode(email)).rejects.toMatchObject({
      status: 429,
    });

    expect(await prisma.loginCode.findMany()).toEqual([before]);
    expect(sendLoginCode).toHaveBeenCalledTimes(1);
  });

  it('61초 뒤 재발급하면 같은 줄의 해시·만료 시각을 바꾸고 사용 상태를 초기화한다', async () => {
    await service.requestCode(email);
    const oldCode = sendLoginCode.mock.calls[0][1];
    await prisma.$executeRaw`
      UPDATE login_codes
      SET created_at = now() - interval '61 seconds',
          expires_at = now() - interval '1 second',
          attempts = 5, used_at = now()
      WHERE email = ${email}
    `;
    const before = await prisma.loginCode.findUniqueOrThrow({
      where: { email },
    });
    randomIntMock.mockReturnValue(654321);
    const [{ now }] = await prisma.$queryRaw<{ now: Date }[]>`SELECT now()`;

    await service.requestCode(email);

    const after = await prisma.loginCode.findUniqueOrThrow({
      where: { email },
    });
    expect(await prisma.loginCode.count()).toBe(1);
    expect(after).toMatchObject({
      id: before.id,
      email,
      attempts: 0,
      usedAt: null,
    });
    expect(after.codeHash).not.toBe(before.codeHash);
    expect(after.createdAt.getTime()).toBeGreaterThan(
      before.createdAt.getTime(),
    );
    expect(after.createdAt.getTime()).toBeGreaterThanOrEqual(now.getTime());
    expect(after.expiresAt.getTime() - after.createdAt.getTime()).toBe(600_000);
    expect(sendLoginCode).toHaveBeenCalledTimes(2);
    expect(sendLoginCode).toHaveBeenLastCalledWith(email, '654321');
    expect(await bcrypt.compare('654321', after.codeHash)).toBe(true);
    expect(await bcrypt.compare(oldCode, after.codeHash)).toBe(false);

    // 재발급 시각을 갱신하지 않으면 이 요청도 성공해 버린다.
    await expect(service.requestCode(email)).rejects.toMatchObject({
      status: 429,
    });
    expect(await prisma.loginCode.findMany()).toEqual([after]);
    expect(sendLoginCode).toHaveBeenCalledTimes(2);
  });

  it.each([
    { seconds: 59, allowed: false },
    { seconds: 60, allowed: true },
  ])(
    '발급 시각이 $seconds초 전이면 재발급 허용은 $allowed다',
    async ({ seconds, allowed }) => {
      await prisma.$executeRaw`
      INSERT INTO login_codes (email, code_hash, expires_at, created_at)
      VALUES (${email}, 'previous-hash', now() + interval '10 minutes',
              now() - ${seconds} * interval '1 second')
    `;
      const before = await prisma.loginCode.findUniqueOrThrow({
        where: { email },
      });

      if (!allowed) {
        await expect(service.requestCode(email)).rejects.toMatchObject({
          status: 429,
        });
        expect(await prisma.loginCode.findMany()).toEqual([before]);
        expect(sendLoginCode).not.toHaveBeenCalled();
        return;
      }

      await expect(service.requestCode(email)).resolves.toBeUndefined();
      const after = await prisma.loginCode.findUniqueOrThrow({
        where: { email },
      });
      expect(after.id).toBe(before.id);
      expect(after.codeHash).not.toBe(before.codeHash);
      expect(sendLoginCode).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['처음 발급', '재발급'])(
    '%s을 동시에 두 번 요청해도 하나만 성공하고 하나는 429다',
    async (state) => {
      if (state === '재발급') {
        await prisma.$executeRaw`
        INSERT INTO login_codes (email, code_hash, expires_at, created_at)
        VALUES (${email}, 'previous-hash', now(), now() - interval '61 seconds')
      `;
      }
      randomIntMock.mockReturnValueOnce(123456).mockReturnValueOnce(654321);

      const results = await Promise.allSettled([
        service.requestCode(email),
        service.requestCode(email),
      ]);

      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toEqual([
        expect.objectContaining({ reason: expect.any(HttpException) }),
      ]);
      expect(results.filter((result) => result.status === 'rejected')).toEqual([
        expect.objectContaining({
          reason: expect.objectContaining({ status: 429 }),
        }),
      ]);
      expect(sendLoginCode).toHaveBeenCalledExactlyOnceWith(
        email,
        expect.stringMatching(/^\d{6}$/),
      );
      const rows = await prisma.loginCode.findMany();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ email, attempts: 0, usedAt: null });
      expect(
        await bcrypt.compare(sendLoginCode.mock.calls[0][1], rows[0].codeHash),
      ).toBe(true);
    },
  );

  it('다른 이메일은 서로 막지 않고 가입 여부와 무관하게 같은 결과를 받는다', async () => {
    const existingEmail = 'existing@example.com';
    const user = await prisma.user.create({
      data: { email: existingEmail, name: '기존 사용자' },
    });
    randomIntMock.mockReturnValueOnce(123456).mockReturnValueOnce(654321);

    const results = await Promise.all([
      service.requestCode(email),
      service.requestCode(existingEmail),
    ]);

    expect(results).toEqual([undefined, undefined]);
    expect(sendLoginCode).toHaveBeenCalledTimes(2);
    expect(sendLoginCode).toHaveBeenCalledWith(email, '123456');
    expect(sendLoginCode).toHaveBeenCalledWith(existingEmail, '654321');
    const rows = await prisma.loginCode.findMany({ orderBy: { email: 'asc' } });
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.email)).toEqual([existingEmail, email]);
    expect(await bcrypt.compare('654321', rows[0].codeHash)).toBe(true);
    expect(await bcrypt.compare('123456', rows[1].codeHash)).toBe(true);
    expect(await prisma.user.findMany()).toEqual([user]);
    expect(await prisma.session.count()).toBe(0);
  });

  it.each([
    { value: 0, code: '000000' },
    { value: 42, code: '000042' },
    { value: 999999, code: '999999' },
  ])(
    '무작위 값 $value를 6자리 코드 $code로 보낸다',
    async ({ value, code }) => {
      randomIntMock.mockReturnValue(value);

      await service.requestCode(email);

      expect(sendLoginCode).toHaveBeenCalledExactlyOnceWith(email, code);
      const row = await prisma.loginCode.findUniqueOrThrow({
        where: { email },
      });
      expect(await bcrypt.compare(code, row.codeHash)).toBe(true);
    },
  );

  it.each(['사용함', '5회 실패', '만료됨'])(
    '기존 코드가 %s이어도 60초 제한은 유지한다',
    async (state) => {
      await prisma.$executeRaw`
      INSERT INTO login_codes (email, code_hash, expires_at, attempts, used_at)
      VALUES (${email}, 'previous-hash',
              now() + ${state === '만료됨' ? -1 : 600} * interval '1 second',
              ${state === '5회 실패' ? 5 : 0},
              CASE WHEN ${state === '사용함'} THEN now() ELSE NULL END)
    `;
      const before = await prisma.loginCode.findUniqueOrThrow({
        where: { email },
      });

      await expect(service.requestCode(email)).rejects.toMatchObject({
        status: 429,
      });

      expect(await prisma.loginCode.findMany()).toEqual([before]);
      expect(sendLoginCode).not.toHaveBeenCalled();
    },
  );
});
