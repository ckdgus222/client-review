import { createHash } from 'node:crypto';
import { HttpException, UnprocessableEntityException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import bcrypt from 'bcrypt';
import { resetDatabase } from '../../test/reset-database.js';
import { MailService } from '../mail/mail.service.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuthService } from './auth.service.js';
import * as sessionTokens from './token.js';

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
    vi.stubEnv('DEVELOPER_EMAIL', email);
    randomIntMock.mockReset().mockReturnValue(123456);
    sendLoginCode.mockReset();
    await resetDatabase(prisma);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
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
    expect(sendLoginCode).toHaveBeenCalledExactlyOnceWith(email, expect.stringMatching(/^\d{6}$/));
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
    expect(after.createdAt.getTime()).toBeGreaterThan(before.createdAt.getTime());
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
  ])('발급 시각이 $seconds초 전이면 재발급 허용은 $allowed다', async ({ seconds, allowed }) => {
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
  });

  it.each(['처음 발급', '재발급'])('%s을 동시에 두 번 요청해도 하나만 성공하고 하나는 429다', async (state) => {
    if (state === '재발급') {
      await prisma.$executeRaw`
        INSERT INTO login_codes (email, code_hash, expires_at, created_at)
        VALUES (${email}, 'previous-hash', now(), now() - interval '61 seconds')
      `;
    }
    randomIntMock.mockReturnValueOnce(123456).mockReturnValueOnce(654321);

    const results = await Promise.allSettled([service.requestCode(email), service.requestCode(email)]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.any(HttpException) }),
    ]);
    expect(results.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ status: 429 }),
      }),
    ]);
    expect(sendLoginCode).toHaveBeenCalledExactlyOnceWith(email, expect.stringMatching(/^\d{6}$/));
    const rows = await prisma.loginCode.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email, attempts: 0, usedAt: null });
    expect(await bcrypt.compare(sendLoginCode.mock.calls[0][1], rows[0].codeHash)).toBe(true);
  });

  it('다른 이메일은 서로 막지 않고 가입 여부와 무관하게 같은 결과를 받는다', async () => {
    const existingEmail = 'existing@example.com';
    const user = await prisma.user.create({
      data: { email: existingEmail, name: '기존 사용자' },
    });
    randomIntMock.mockReturnValueOnce(123456).mockReturnValueOnce(654321);

    const results = await Promise.all([service.requestCode(email), service.requestCode(existingEmail)]);

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
  ])('무작위 값 $value를 6자리 코드 $code로 보낸다', async ({ value, code }) => {
    randomIntMock.mockReturnValue(value);

    await service.requestCode(email);

    expect(sendLoginCode).toHaveBeenCalledExactlyOnceWith(email, code);
    const row = await prisma.loginCode.findUniqueOrThrow({
      where: { email },
    });
    expect(await bcrypt.compare(code, row.codeHash)).toBe(true);
  });

  it.each(['사용함', '5회 실패', '만료됨'])('기존 코드가 %s이어도 60초 제한은 유지한다', async (state) => {
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
  });
});

describe('AuthService.verifyCode', () => {
  let module: TestingModule | undefined;
  let prisma: PrismaService;
  let service: AuthService;
  let codeHash: string;
  let nextCodeHash: string;
  const email = 'verify@example.com';
  const code = '000042';
  const wrongCode = '999999';
  const nextCode = '654321';
  const name = '새 사용자';
  const sendLoginCode = vi.fn<MailService['sendLoginCode']>();

  const expectCodeError = (error: unknown, expectedCode: string) => {
    expect(error).toBeInstanceOf(UnprocessableEntityException);
    const exception = error as UnprocessableEntityException;
    expect(exception.getStatus()).toBe(422);
    expect(exception.getResponse()).toEqual({
      statusCode: 422,
      message: expect.stringMatching(/\S/),
      code: expectedCode,
    });
  };

  // 발급 자체는 조각 2에서 검사한다. 반복되는 실패·경합 테스트는 비용 12의
  // 해시를 한 번만 만들어 재사용하고, 시도 횟수와 유효시간은 매번 새로 저장한다.
  const createLoginCode = async () => {
    await prisma.$executeRaw`
      INSERT INTO login_codes (email, code_hash, expires_at)
      VALUES (${email}, ${codeHash}, now() + interval '10 minutes')
    `;
  };

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
    [codeHash, nextCodeHash] = await Promise.all([bcrypt.hash(code, 12), bcrypt.hash(nextCode, 12)]);
  });

  beforeEach(async () => {
    vi.stubEnv('DEVELOPER_EMAIL', email);
    randomIntMock.mockReset().mockReturnValue(42);
    sendLoginCode.mockReset();
    await resetDatabase(prisma);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await module?.close();
  });

  it('기존 사용자는 이름 없이 로그인하고 DB에는 토큰 해시와 DB 시각 기준 7일 세션만 저장한다', async () => {
    const user = await prisma.user.create({
      data: { email, name: '기존 사용자' },
    });
    await service.requestCode(email);
    const mailedCode = sendLoginCode.mock.calls[0][1];
    const [{ now: before }] = await prisma.$queryRaw<{ now: Date }[]>`SELECT now()`;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2100-01-01T00:00:00Z'));

    const result = await service.verifyCode(email, mailedCode);

    const [{ now: after }] = await prisma.$queryRaw<{ now: Date }[]>`SELECT now()`;
    expect(result).toEqual({
      user: { id: user.id, email, name: user.name },
      token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    const users = await prisma.user.findMany();
    expect(users).toEqual([{ ...user, lastSeenAt: expect.any(Date) }]);
    expect(users[0].lastSeenAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(users[0].lastSeenAt!.getTime()).toBeLessThanOrEqual(after.getTime());
    const sessions = await prisma.session.findMany();
    expect(sessions).toHaveLength(1);
    const [session] = sessions;
    expect(session.userId).toBe(user.id);
    expect(session.tokenHash).toBe(createHash('sha256').update(result.token).digest('hex'));
    expect(session.expiresAt.getTime() - session.createdAt.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
    expect(session.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(session.createdAt.getTime()).toBeLessThanOrEqual(after.getTime());
    const loginCode = await prisma.loginCode.findUniqueOrThrow({
      where: { email },
    });
    expect(loginCode).toMatchObject({ attempts: 1, usedAt: expect.any(Date) });
    expect(loginCode.usedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(loginCode.usedAt!.getTime()).toBeLessThanOrEqual(after.getTime());
    // Prisma가 읽지 않는 열까지 포함해 저장된 줄 전체에 토큰 원본이 없는지 확인한다.
    const storedRows = await prisma.$queryRaw<{ data: unknown }[]>`
      SELECT to_jsonb(s) AS data FROM sessions s
      UNION ALL SELECT to_jsonb(u) FROM users u
      UNION ALL SELECT to_jsonb(c) FROM login_codes c
    `;
    expect(JSON.stringify(storedRows)).not.toContain(result.token);
  });

  it('새 사용자는 앞자리 0이 있는 코드와 이름으로 가입하고 세션을 받는다', async () => {
    await service.requestCode(email);
    expect(sendLoginCode).toHaveBeenCalledExactlyOnceWith(email, code);
    const [{ now: before }] = await prisma.$queryRaw<{ now: Date }[]>`SELECT now()`;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2000-01-01T00:00:00Z'));

    const result = await service.verifyCode(email, sendLoginCode.mock.calls[0][1], name);

    const [{ now: after }] = await prisma.$queryRaw<{ now: Date }[]>`SELECT now()`;
    expect(result).toEqual({
      user: { id: expect.any(String), email, name },
      token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    const users = await prisma.user.findMany();
    expect(users).toEqual([expect.objectContaining({ ...result.user, lastSeenAt: expect.any(Date) })]);
    expect(users[0].lastSeenAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(users[0].lastSeenAt!.getTime()).toBeLessThanOrEqual(after.getTime());
    expect(await prisma.session.findMany()).toEqual([
      expect.objectContaining({
        userId: result.user.id,
        tokenHash: createHash('sha256').update(result.token).digest('hex'),
      }),
    ]);
    expect(await prisma.loginCode.findUniqueOrThrow({ where: { email } })).toMatchObject({
      attempts: 1,
      usedAt: expect.any(Date),
    });
  });

  it('이름 없이 여러 번 맞혀도 시도 횟수는 그대로이고 같은 코드에 이름을 더하면 가입된다', async () => {
    await createLoginCode();
    const before = await prisma.loginCode.findUniqueOrThrow({
      where: { email },
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const error = await service.verifyCode(email, code).catch((error: unknown) => error);
      expectCodeError(error, 'NAME_REQUIRED');
      expect(await prisma.loginCode.findUniqueOrThrow({ where: { email } })).toEqual(before);
      expect(await prisma.user.count()).toBe(0);
      expect(await prisma.session.count()).toBe(0);
    }

    const result = await service.verifyCode(email, code, name);

    expect(result.user).toEqual({ id: expect.any(String), email, name });
    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.session.count()).toBe(1);
    expect(await prisma.loginCode.findUniqueOrThrow({ where: { email } })).toMatchObject({
      attempts: 1,
      usedAt: expect.any(Date),
    });
  });

  it('네 번 틀린 새 사용자도 다섯 번째에 맞힌 뒤 이름을 더해 가입할 수 있다', async () => {
    await createLoginCode();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const error = await service.verifyCode(email, wrongCode).catch((error: unknown) => error);
      expectCodeError(error, 'CODE_WRONG');
    }

    const error = await service.verifyCode(email, code).catch((error: unknown) => error);

    expectCodeError(error, 'NAME_REQUIRED');
    expect(await prisma.loginCode.findUniqueOrThrow({ where: { email } })).toMatchObject({
      attempts: 4,
      usedAt: null,
    });
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.session.count()).toBe(0);

    await expect(service.verifyCode(email, code, name)).resolves.toMatchObject({
      user: { email, name },
    });
    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.session.count()).toBe(1);
    expect(await prisma.loginCode.findUniqueOrThrow({ where: { email } })).toMatchObject({
      attempts: 5,
      usedAt: expect.any(Date),
    });
  });

  it.each([undefined, name])('틀린 코드는 이름 %s을 보내도 가입이나 세션을 만들지 않는다', async (inputName) => {
    await createLoginCode();

    const error = await service.verifyCode(email, wrongCode, inputName).catch((error: unknown) => error);

    expectCodeError(error, 'CODE_WRONG');
    expect(await prisma.loginCode.findUniqueOrThrow({ where: { email } })).toMatchObject({
      attempts: 1,
      usedAt: null,
    });
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.session.count()).toBe(0);
  });

  it('틀린 코드 다섯 번 뒤에는 맞는 코드도 비교하지 않고 CODE_EXPIRED를 돌려준다', async () => {
    await createLoginCode();
    const compare = vi.spyOn(bcrypt, 'compare');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const error = await service.verifyCode(email, wrongCode, name).catch((error: unknown) => error);
      expectCodeError(error, 'CODE_WRONG');
    }
    const before = await prisma.loginCode.findUniqueOrThrow({
      where: { email },
    });
    expect(before).toMatchObject({ attempts: 5, usedAt: null });
    compare.mockClear();

    const error = await service.verifyCode(email, code, name).catch((error: unknown) => error);

    expectCodeError(error, 'CODE_EXPIRED');
    expect(compare).not.toHaveBeenCalled();
    expect(await prisma.loginCode.findUniqueOrThrow({ where: { email } })).toEqual(before);
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.session.count()).toBe(0);
  });

  it('틀린 코드를 동시에 열 번 보내도 비교는 다섯 번이고 시도 횟수는 5다', async () => {
    await createLoginCode();
    const compare = vi.spyOn(bcrypt, 'compare');

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => service.verifyCode(email, wrongCode, name)),
    );

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(0);
    const failures = results.filter((result) => result.status === 'rejected');
    const errorCodes = failures.map(({ reason }) => {
      expect(reason).toBeInstanceOf(UnprocessableEntityException);
      return (reason as UnprocessableEntityException).getResponse() as {
        code: string;
      };
    });
    expect(errorCodes.filter(({ code }) => code === 'CODE_WRONG')).toHaveLength(5);
    expect(errorCodes.filter(({ code }) => code === 'CODE_EXPIRED')).toHaveLength(5);
    failures.forEach(({ reason }, index) => expectCodeError(reason, errorCodes[index].code));
    expect(compare).toHaveBeenCalledTimes(5);
    expect(compare.mock.calls).toEqual(Array.from({ length: 5 }, () => [wrongCode, codeHash]));
    expect(await prisma.loginCode.findUniqueOrThrow({ where: { email } })).toMatchObject({
      attempts: 5,
      usedAt: null,
    });
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.session.count()).toBe(0);
  });

  it.each(['기존 사용자', '새 사용자'])('%s가 맞는 코드를 동시에 두 번 보내면 하나만 성공한다', async (state) => {
    if (state === '기존 사용자') {
      await prisma.user.create({ data: { email, name } });
    }
    await createLoginCode();
    // 두 요청 모두 비교 단계에 도착한 뒤 진행시켜 사용 처리의 경합을 재현한다.
    const originalCompare = bcrypt.compare;
    let releaseComparisons!: () => void;
    const bothComparing = new Promise<void>((resolve) => {
      releaseComparisons = resolve;
    });
    let comparing = 0;
    vi.spyOn(bcrypt, 'compare').mockImplementation(async (input, hash) => {
      comparing += 1;
      if (comparing === 2) releaseComparisons();
      await bothComparing;
      return originalCompare(input, hash);
    });

    const results = await Promise.allSettled([
      service.verifyCode(email, code, state === '새 사용자' ? name : undefined),
      service.verifyCode(email, code, state === '새 사용자' ? name : undefined),
    ]);

    const successes = results.filter((result) => result.status === 'fulfilled');
    const failures = results.filter((result) => result.status === 'rejected');
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expectCodeError(failures[0].reason, 'CODE_EXPIRED');
    expect(await prisma.user.findMany()).toEqual([expect.objectContaining(successes[0].value.user)]);
    expect(await prisma.session.findMany()).toEqual([
      expect.objectContaining({
        userId: successes[0].value.user.id,
        tokenHash: createHash('sha256').update(successes[0].value.token).digest('hex'),
      }),
    ]);
    expect(await prisma.loginCode.findUniqueOrThrow({ where: { email } })).toMatchObject({
      attempts: 2,
      usedAt: expect.any(Date),
    });
  });

  it.each([0, 1])('만료 시각이 DB 현재보다 %s초 전이면 비교하지 않고 거부한다', async (seconds) => {
    await createLoginCode();
    await prisma.$executeRaw`
      UPDATE login_codes
      SET created_at = now() - interval '10 minutes' - ${seconds} * interval '1 second',
          expires_at = now() - ${seconds} * interval '1 second'
      WHERE email = ${email}
    `;
    const before = await prisma.loginCode.findUniqueOrThrow({
      where: { email },
    });
    const compare = vi.spyOn(bcrypt, 'compare');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2000-01-01T00:00:00Z'));

    const error = await service.verifyCode(email, code, name).catch((error: unknown) => error);

    expectCodeError(error, 'CODE_EXPIRED');
    expect(compare).not.toHaveBeenCalled();
    expect(await prisma.loginCode.findUniqueOrThrow({ where: { email } })).toEqual(before);
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.session.count()).toBe(0);
  });

  it('쓴 코드는 다시 비교하지 않고 기존 사용자와 세션도 그대로 둔다', async () => {
    await createLoginCode();
    await service.verifyCode(email, code, name);
    const before = await prisma.loginCode.findUniqueOrThrow({
      where: { email },
    });
    const users = await prisma.user.findMany();
    const sessions = await prisma.session.findMany();
    const compare = vi.spyOn(bcrypt, 'compare');

    const error = await service.verifyCode(email, code, name).catch((error: unknown) => error);

    expectCodeError(error, 'CODE_EXPIRED');
    expect(compare).not.toHaveBeenCalled();
    expect(await prisma.loginCode.findUniqueOrThrow({ where: { email } })).toEqual(before);
    expect(await prisma.user.findMany()).toEqual(users);
    expect(await prisma.session.findMany()).toEqual(sessions);
  });

  it('코드가 없는 이메일은 다른 이메일의 코드로 로그인할 수 없다', async () => {
    await createLoginCode();
    const before = await prisma.loginCode.findMany();
    const compare = vi.spyOn(bcrypt, 'compare');

    const error = await service.verifyCode('missing@example.com', code, name).catch((error: unknown) => error);

    expectCodeError(error, 'CODE_EXPIRED');
    expect(compare).not.toHaveBeenCalled();
    expect(await prisma.loginCode.findMany()).toEqual(before);
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.session.count()).toBe(0);
  });

  it('새 코드 발급 뒤에는 옛 코드가 틀린 코드가 되고 새 코드로 로그인된다', async () => {
    await createLoginCode();
    await prisma.$executeRaw`
      UPDATE login_codes SET created_at = now() - interval '61 seconds'
      WHERE email = ${email}
    `;
    randomIntMock.mockReturnValue(654321);
    await service.requestCode(email);
    expect(sendLoginCode).toHaveBeenCalledExactlyOnceWith(email, nextCode);

    const error = await service.verifyCode(email, code, name).catch((error: unknown) => error);

    expectCodeError(error, 'CODE_WRONG');
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.session.count()).toBe(0);
    await expect(service.verifyCode(email, nextCode, name)).resolves.toMatchObject({
      user: { email, name },
    });
    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.session.count()).toBe(1);
  });

  it('비교 중 재발급되면 옛 코드는 CODE_EXPIRED이고 새 코드는 시도 0번부터 쓸 수 있다', async () => {
    await createLoginCode();
    const originalCompare = bcrypt.compare;
    const compare = vi.spyOn(bcrypt, 'compare').mockImplementationOnce(async (input, hash) => {
      await prisma.$executeRaw`
        UPDATE login_codes
        SET code_hash = ${nextCodeHash}, attempts = 0, used_at = NULL,
            created_at = now(), expires_at = now() + interval '10 minutes'
        WHERE email = ${email}
      `;
      return originalCompare(input, hash);
    });

    const error = await service.verifyCode(email, code, name).catch((error: unknown) => error);

    expectCodeError(error, 'CODE_EXPIRED');
    expect(compare).toHaveBeenCalledExactlyOnceWith(code, codeHash);
    expect(await prisma.loginCode.findUniqueOrThrow({ where: { email } })).toMatchObject({
      codeHash: nextCodeHash,
      attempts: 0,
      usedAt: null,
    });
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.session.count()).toBe(0);
    await expect(service.verifyCode(email, nextCode, name)).resolves.toMatchObject({
      user: { email, name },
    });
    expect(compare).toHaveBeenLastCalledWith(nextCode, nextCodeHash);
    expect(await prisma.loginCode.findUniqueOrThrow({ where: { email } })).toMatchObject({
      attempts: 1,
      usedAt: expect.any(Date),
    });
    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.session.count()).toBe(1);
  });

  it('옛 코드의 NAME_REQUIRED가 새 코드에서 이미 쓴 시도 횟수를 줄이지 않는다', async () => {
    await createLoginCode();
    const originalCompare = bcrypt.compare;
    vi.spyOn(bcrypt, 'compare').mockImplementationOnce(async (input, hash) => {
      await prisma.$executeRaw`
        UPDATE login_codes
        SET code_hash = ${nextCodeHash}, attempts = 0, used_at = NULL,
            created_at = now(), expires_at = now() + interval '10 minutes'
        WHERE email = ${email}
      `;
      // 0에서는 attempts > 0 조건만으로도 되돌림이 막힌다. 새 코드로 실제
      // 한 번 틀린 뒤 옛 요청을 이어가야 code_hash 조건 누락을 잡을 수 있다.
      const error = await service.verifyCode(email, wrongCode, name).catch((error: unknown) => error);
      expectCodeError(error, 'CODE_WRONG');
      return originalCompare(input, hash);
    });

    const error = await service.verifyCode(email, code).catch((error: unknown) => error);

    expectCodeError(error, 'NAME_REQUIRED');
    expect(await prisma.loginCode.findUniqueOrThrow({ where: { email } })).toMatchObject({
      codeHash: nextCodeHash,
      attempts: 1,
      usedAt: null,
    });
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.session.count()).toBe(0);
    await expect(service.verifyCode(email, nextCode, name)).resolves.toMatchObject({
      user: { email, name },
    });
    expect(await prisma.loginCode.findUniqueOrThrow({ where: { email } })).toMatchObject({
      attempts: 2,
      usedAt: expect.any(Date),
    });
    expect(await prisma.session.count()).toBe(1);
  });

  it('비교하는 사이 만료되면 사용 처리와 가입·세션 생성을 거부한다', async () => {
    await createLoginCode();
    const originalCompare = bcrypt.compare;
    vi.spyOn(bcrypt, 'compare').mockImplementationOnce(async (input, hash) => {
      await prisma.$executeRaw`
        UPDATE login_codes SET expires_at = now() WHERE email = ${email}
      `;
      return originalCompare(input, hash);
    });

    const error = await service.verifyCode(email, code, name).catch((error: unknown) => error);

    expectCodeError(error, 'CODE_EXPIRED');
    expect(await prisma.loginCode.findUniqueOrThrow({ where: { email } })).toMatchObject({
      attempts: 1,
      usedAt: null,
    });
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.session.count()).toBe(0);
  });

  it('세션 저장이 실패하면 코드 사용과 새 사용자 생성을 모두 되돌린다', async () => {
    await createLoginCode();
    const otherUser = await prisma.user.create({
      data: { email: 'other@example.com', name: '다른 사용자' },
    });
    const token = sessionTokens.createSessionToken();
    await prisma.$executeRaw`
      INSERT INTO sessions (user_id, token_hash, expires_at)
      VALUES (${otherUser.id}::uuid, ${createHash('sha256').update(token).digest('hex')},
              now() + interval '7 days')
    `;
    const sessions = await prisma.session.findMany();
    // 토큰 해시의 고유 제약을 이용해 실제 트랜잭션의 마지막 저장을 실패시킨다.
    const createToken = vi.spyOn(sessionTokens, 'createSessionToken').mockReturnValue(token);

    await expect(service.verifyCode(email, code, name)).rejects.toThrow();

    expect(createToken).toHaveBeenCalledOnce();
    expect(await prisma.loginCode.findUniqueOrThrow({ where: { email } })).toMatchObject({
      attempts: 1,
      usedAt: null,
    });
    expect(await prisma.user.findMany()).toEqual([otherUser]);
    expect(await prisma.session.findMany()).toEqual(sessions);
    createToken.mockRestore();

    await expect(service.verifyCode(email, code, name)).resolves.toMatchObject({
      user: { email, name },
    });
    expect(await prisma.user.count()).toBe(2);
    expect(await prisma.session.count()).toBe(2);
  });

  it('기존 사용자가 다른 이름을 보내도 저장된 이름을 바꾸지 않는다', async () => {
    const user = await prisma.user.create({
      data: { email, name: '원래 이름' },
    });
    await createLoginCode();
    const [{ now: before }] = await prisma.$queryRaw<{ now: Date }[]>`SELECT now()`;

    const result = await service.verifyCode(email, code, '바꿀 이름');

    const [{ now: after }] = await prisma.$queryRaw<{ now: Date }[]>`SELECT now()`;
    expect(result.user).toEqual({ id: user.id, email, name: user.name });
    const users = await prisma.user.findMany();
    expect(users).toEqual([{ ...user, lastSeenAt: expect.any(Date) }]);
    expect(users[0].lastSeenAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(users[0].lastSeenAt!.getTime()).toBeLessThanOrEqual(after.getTime());
    expect(await prisma.session.findMany()).toEqual([expect.objectContaining({ userId: user.id })]);
  });

  it.each(['새 사용자', '기존 사용자'])('%s가 로그인하고 5분 안에 로그아웃해도 접속 기록은 남는다', async (state) => {
    const otherUser = await prisma.user.create({
      data: { email: 'other@example.com', name: '다른 사용자' },
    });
    if (state === '기존 사용자') {
      await prisma.$executeRaw`
        INSERT INTO users (email, name, last_seen_at)
        VALUES (${email}, ${name}, now() - interval '1 day')
      `;
    }
    await createLoginCode();
    const [{ now: before }] = await prisma.$queryRaw<{ now: Date }[]>`SELECT now()`;

    const result = await service.verifyCode(email, code, name);

    const [{ now: after }] = await prisma.$queryRaw<{ now: Date }[]>`SELECT now()`;
    const loggedInUser = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(loggedInUser.lastSeenAt).toBeInstanceOf(Date);
    expect(loggedInUser.lastSeenAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(loggedInUser.lastSeenAt!.getTime()).toBeLessThanOrEqual(after.getTime());
    expect(await prisma.user.findUniqueOrThrow({ where: { id: otherUser.id } })).toEqual(otherUser);
    const session = await prisma.session.findUniqueOrThrow({
      where: { tokenHash: sessionTokens.hashSessionToken(result.token) },
    });
    expect(after.getTime() - session.lastSeenAt.getTime()).toBeLessThan(300_000);

    await service.deleteSession(result.token);

    expect(await prisma.session.count()).toBe(0);
    await expect(service.findSessionUser(result.token)).resolves.toBeNull();
    expect(await prisma.user.findUniqueOrThrow({ where: { email } })).toEqual(loggedInUser);
  });

  it('기존 사용자가 틀린 코드로 로그인하면 마지막 접속 시각을 바꾸지 않는다', async () => {
    await prisma.$executeRaw`
      INSERT INTO users (email, name, last_seen_at)
      VALUES (${email}, ${name}, now() - interval '1 day')
    `;
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    await createLoginCode();

    const error = await service.verifyCode(email, wrongCode).catch((error: unknown) => error);

    expectCodeError(error, 'CODE_WRONG');
    expect(await prisma.user.findMany()).toEqual([user]);
    expect(await prisma.session.count()).toBe(0);
  });

  it('기존 사용자의 세션 저장이 실패하면 마지막 접속 시각과 코드 사용을 되돌린다', async () => {
    await prisma.$executeRaw`
      INSERT INTO users (email, name, last_seen_at)
      VALUES (${email}, ${name}, now() - interval '1 day')
    `;
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    await createLoginCode();
    const token = sessionTokens.createSessionToken();
    await prisma.$executeRaw`
      INSERT INTO sessions (user_id, token_hash, expires_at)
      VALUES (${user.id}::uuid, ${sessionTokens.hashSessionToken(token)}, now() + interval '7 days')
    `;
    const sessions = await prisma.session.findMany();
    vi.spyOn(sessionTokens, 'createSessionToken').mockReturnValue(token);

    await expect(service.verifyCode(email, code)).rejects.toThrow();

    expect(await prisma.user.findMany()).toEqual([user]);
    expect(await prisma.session.findMany()).toEqual(sessions);
    expect(await prisma.loginCode.findUniqueOrThrow({ where: { email } })).toMatchObject({
      attempts: 1,
      usedAt: null,
    });
  });
});

describe('AuthService.findSessionUser', () => {
  let module: TestingModule | undefined;
  let prisma: PrismaService;
  let service: AuthService;
  let user: { id: string; email: string; name: string };
  const sessionId = 'session-token-for-test';
  const tokenHash = createHash('sha256').update(sessionId).digest('hex');

  // 세션 발급은 조각 3에서 검사한다. 여기서는 DB 시각으로 수명을 직접 정한다.
  const createSession = async (
    userId: string,
    token = sessionId,
    lastSeenSecondsAgo = 0,
    expiresInSeconds = 7 * 24 * 60 * 60,
  ) => {
    const hash = createHash('sha256').update(token).digest('hex');
    await prisma.$executeRaw`
      INSERT INTO sessions (user_id, token_hash, expires_at, last_seen_at)
      VALUES (${userId}::uuid, ${hash},
              now() + ${expiresInSeconds} * interval '1 second',
              now() - ${lastSeenSecondsAgo} * interval '1 second')
    `;
    return prisma.session.findUniqueOrThrow({ where: { tokenHash: hash } });
  };

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [AuthService, MailService],
    })
      .overrideProvider(MailService)
      .useValue({ sendLoginCode: vi.fn() })
      .compile();
    prisma = module.get(PrismaService);
    service = module.get(AuthService);
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    user = await prisma.user.create({
      data: { email: 'session@example.com', name: '세션 사용자' },
      select: { id: true, email: true, name: true },
    });
    await prisma.$executeRaw`
      UPDATE users SET last_seen_at = now() - interval '1 hour' WHERE id = ${user.id}::uuid
    `;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await module?.close();
  });

  it('원본 토큰의 SHA-256 해시로 세션을 찾아 사용자 필드 세 개만 돌려준다', async () => {
    const before = await createSession(user.id);

    await expect(service.findSessionUser(sessionId)).resolves.toEqual(user);

    expect(await prisma.session.findMany()).toEqual([before]);
  });

  it.each(['missing-session-token', '', "' OR 1=1 --"])(
    '저장되지 않은 토큰 %j로 다른 세션을 찾거나 바꾸지 못한다',
    async (token) => {
      const before = await createSession(user.id, sessionId, 360);
      const userBefore = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });

      await expect(service.findSessionUser(token)).resolves.toBeNull();

      expect(await prisma.session.findMany()).toEqual([before]);
      expect(await prisma.user.findMany()).toEqual([userBefore]);
    },
  );

  it('DB에 저장된 해시 자체를 토큰으로 보내도 인증되지 않는다', async () => {
    const before = await createSession(user.id, sessionId, 360);

    await expect(service.findSessionUser(tokenHash)).resolves.toBeNull();

    expect(await prisma.session.findMany()).toEqual([before]);
  });

  it('다른 사용자의 세션과 섞이지 않고 각 토큰의 주인을 돌려준다', async () => {
    const otherUser = await prisma.user.create({
      data: { email: 'other-session@example.com', name: '다른 사용자' },
      select: { id: true, email: true, name: true },
    });
    await createSession(user.id);
    await createSession(otherUser.id, 'other-session-token');

    await expect(service.findSessionUser('other-session-token')).resolves.toEqual(otherUser);
    await expect(service.findSessionUser(sessionId)).resolves.toEqual(user);
  });

  it('1초 전에 만료된 세션은 null이고 마지막 사용 시각을 갱신하지 않는다', async () => {
    const before = await createSession(user.id, sessionId, 360, -1);
    const userBefore = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });

    await expect(service.findSessionUser(sessionId)).resolves.toBeNull();

    expect(await prisma.session.findMany()).toEqual([before]);
    expect(await prisma.user.findMany()).toEqual([userBefore]);
  });

  it('24시간 1초 동안 쓰지 않은 세션은 null이고 되살리지 않는다', async () => {
    const before = await createSession(user.id, sessionId, 24 * 60 * 60 + 1);
    const userBefore = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });

    await expect(service.findSessionUser(sessionId)).resolves.toBeNull();

    expect(await prisma.session.findMany()).toEqual([before]);
    expect(await prisma.user.findMany()).toEqual([userBefore]);
  });

  it('24시간이 되기 1분 전인 세션은 사용자를 돌려준다', async () => {
    await createSession(user.id, sessionId, 24 * 60 * 60 - 60);

    await expect(service.findSessionUser(sessionId)).resolves.toEqual(user);
  });

  it('6분 지난 세션은 세션과 사용자의 마지막 사용 시각만 DB의 현재 시각으로 갱신한다', async () => {
    const before = await createSession(user.id, sessionId, 360);
    const userBefore = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    const [{ now: startedAt }] = await prisma.$queryRaw<{ now: Date }[]>`
      SELECT now()
    `;

    await expect(service.findSessionUser(sessionId)).resolves.toEqual(user);

    const [{ now: finishedAt }] = await prisma.$queryRaw<{ now: Date }[]>`
      SELECT now()
    `;
    const after = await prisma.session.findUniqueOrThrow({
      where: { tokenHash },
    });
    expect(after.lastSeenAt.getTime()).toBeGreaterThan(before.lastSeenAt.getTime());
    expect(after.lastSeenAt.getTime()).toBeGreaterThanOrEqual(startedAt.getTime());
    expect(after.lastSeenAt.getTime()).toBeLessThanOrEqual(finishedAt.getTime());
    // 활동해도 최초 만료 시각(최대 7일)은 늘어나지 않는다.
    expect(after).toEqual({ ...before, lastSeenAt: after.lastSeenAt });
    const userAfter = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(userAfter).toEqual({ ...userBefore, lastSeenAt: after.lastSeenAt });

    await expect(service.findSessionUser(sessionId)).resolves.toEqual(user);
    expect(await prisma.session.findUniqueOrThrow({ where: { tokenHash } })).toEqual(after);
    expect(await prisma.user.findMany()).toEqual([userAfter]);
  });

  it('조회 뒤 다른 요청이 먼저 갱신하면 마지막 사용 시각을 덮어쓰지 않는다', async () => {
    await createSession(user.id, sessionId, 360);
    const userBefore = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    const executeRaw = prisma.$executeRaw.bind(prisma);
    // 이 호출은 await만 하므로 PrismaPromise 대신 일반 Promise로 감쌀 수 있다.
    const sessionDatabase: {
      $executeRaw: (...args: Parameters<PrismaService['$executeRaw']>) => Promise<number>;
    } = prisma;
    let refreshedLastSeenAt: Date | undefined;
    const updateSession = vi.spyOn(sessionDatabase, '$executeRaw').mockImplementationOnce(async (...args) => {
      // SELECT는 6분 전 값을 봤지만, UPDATE 전에 다른 요청이 먼저 갱신한다.
      const [refreshed] = await prisma.$queryRaw<{ last_seen_at: Date }[]>`
          UPDATE sessions SET last_seen_at = now() - interval '1 minute'
          WHERE token_hash = ${tokenHash}
          RETURNING last_seen_at
        `;
      refreshedLastSeenAt = refreshed.last_seen_at;

      const updatedCount = await executeRaw(...args);
      expect(updatedCount).toBe(0);
      return updatedCount;
    });

    await expect(service.findSessionUser(sessionId)).resolves.toEqual(user);

    expect(updateSession).toHaveBeenCalledTimes(1);
    const after = await prisma.session.findUniqueOrThrow({
      where: { tokenHash },
    });
    expect(after.lastSeenAt).toEqual(refreshedLastSeenAt);
    // 세션 UPDATE가 0줄이면 사용자 기록도 바뀌면 안 된다.
    expect(await prisma.user.findMany()).toEqual([userBefore]);
  });

  it('4분 지난 세션은 마지막 사용 시각을 그대로 둔다', async () => {
    const before = await createSession(user.id, sessionId, 240);
    const userBefore = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });

    await expect(service.findSessionUser(sessionId)).resolves.toEqual(user);

    expect(await prisma.session.findMany()).toEqual([before]);
    expect(await prisma.user.findMany()).toEqual([userBefore]);
  });

  it.each([
    {
      label: '정확히 만료 시각',
      expiresInSeconds: 0,
      lastSeenSecondsAgo: 360,
      allowed: false,
    },
    {
      label: '정확히 24시간 미사용',
      expiresInSeconds: 86400,
      lastSeenSecondsAgo: 86400,
      allowed: false,
    },
    {
      label: '정확히 5분 미사용',
      expiresInSeconds: 86400,
      lastSeenSecondsAgo: 300,
      allowed: true,
    },
  ])(
    '$label 경계에서는 허용 여부가 $allowed이고 시각을 바꾸지 않는다',
    async ({ expiresInSeconds, lastSeenSecondsAgo, allowed }) => {
      // PostgreSQL의 now()는 한 트랜잭션 안에서 같다. 실제 대기 없이 등호 경계를 확인한다.
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`
          INSERT INTO sessions (user_id, token_hash, expires_at, last_seen_at)
          VALUES (${user.id}::uuid, ${tokenHash},
                  now() + ${expiresInSeconds} * interval '1 second',
                  now() - ${lastSeenSecondsAgo} * interval '1 second')
        `;
        const before = await tx.session.findUniqueOrThrow({
          where: { tokenHash },
        });
        const userBefore = await tx.user.findUniqueOrThrow({ where: { id: user.id } });
        const transactionService = new AuthService(tx as PrismaService, new MailService());

        await expect(transactionService.findSessionUser(sessionId)).resolves.toEqual(allowed ? user : null);

        expect(await tx.session.findMany()).toEqual([before]);
        expect(await tx.user.findMany()).toEqual([userBefore]);
      });
    },
  );

  it('마지막 사용 시각을 갱신할 때 같은 사용자와 다른 사용자의 나머지 세션은 그대로 둔다', async () => {
    const otherUser = await prisma.user.create({
      data: { email: 'other-session@example.com', name: '다른 사용자' },
    });
    const target = await createSession(user.id, sessionId, 360);
    const sameUserSession = await createSession(user.id, 'same-user-other-token', 360);
    const otherUserSession = await createSession(otherUser.id, 'other-user-token', 360);

    await expect(service.findSessionUser(sessionId)).resolves.toEqual(user);

    const after = await prisma.session.findUniqueOrThrow({
      where: { id: target.id },
    });
    expect(after.lastSeenAt.getTime()).toBeGreaterThan(target.lastSeenAt.getTime());
    expect(
      await prisma.session.findUniqueOrThrow({
        where: { id: sameUserSession.id },
      }),
    ).toEqual(sameUserSession);
    expect(
      await prisma.session.findUniqueOrThrow({
        where: { id: otherUserSession.id },
      }),
    ).toEqual(otherUserSession);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: otherUser.id } })).toEqual(otherUser);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({
      lastSeenAt: after.lastSeenAt,
    });
  });

  it.each(['2000-01-01T00:00:00Z', '2100-01-01T00:00:00Z'])(
    '서버 시계를 %s로 바꿔도 유효성·5분 갱신은 DB 시계를 따른다',
    async (serverTime) => {
      const stale = await createSession(user.id, sessionId, 360);
      const fresh = await createSession(user.id, 'fresh-session-token', 240);
      const expired = await createSession(user.id, 'expired-session-token', 360, -1);
      const idle = await createSession(user.id, 'idle-session-token', 86401);
      const [{ now: startedAt }] = await prisma.$queryRaw<{ now: Date }[]>`
        SELECT now()
      `;
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(serverTime));

      await expect(service.findSessionUser(sessionId)).resolves.toEqual(user);
      await expect(service.findSessionUser('fresh-session-token')).resolves.toEqual(user);
      await expect(service.findSessionUser('expired-session-token')).resolves.toBeNull();
      await expect(service.findSessionUser('idle-session-token')).resolves.toBeNull();

      const [{ now: finishedAt }] = await prisma.$queryRaw<{ now: Date }[]>`
        SELECT now()
      `;
      const after = await prisma.session.findUniqueOrThrow({
        where: { tokenHash },
      });
      expect(after.lastSeenAt.getTime()).toBeGreaterThanOrEqual(startedAt.getTime());
      expect(after.lastSeenAt.getTime()).toBeLessThanOrEqual(finishedAt.getTime());
      expect(after).toEqual({ ...stale, lastSeenAt: after.lastSeenAt });
      expect(await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({
        lastSeenAt: after.lastSeenAt,
      });
      expect(await prisma.session.findUniqueOrThrow({ where: { id: fresh.id } })).toEqual(fresh);
      expect(await prisma.session.findUniqueOrThrow({ where: { id: expired.id } })).toEqual(expired);
      expect(await prisma.session.findUniqueOrThrow({ where: { id: idle.id } })).toEqual(idle);
    },
  );

  it('로그아웃처럼 세션을 지우면 이전 토큰으로 다시 사용자를 찾을 수 없다', async () => {
    const session = await createSession(user.id);
    await expect(service.findSessionUser(sessionId)).resolves.toEqual(user);

    await prisma.session.delete({ where: { id: session.id } });

    await expect(service.findSessionUser(sessionId)).resolves.toBeNull();
    expect(await prisma.session.count()).toBe(0);
  });

  it('사용자가 삭제되어 세션도 지워지면 이전 토큰으로 인증되지 않는다', async () => {
    await createSession(user.id);

    await prisma.user.delete({ where: { id: user.id } });

    await expect(service.findSessionUser(sessionId)).resolves.toBeNull();
    expect(await prisma.session.count()).toBe(0);
  });

  it('6분 지난 같은 세션을 동시에 열 번 조회해도 모두 같은 사용자를 돌려주고 한 번만 갱신한다', async () => {
    const before = await createSession(user.id, sessionId, 360);
    const userBefore = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    const [{ now: startedAt }] = await prisma.$queryRaw<{ now: Date }[]>`
      SELECT now()
    `;
    const executeRaw = prisma.$executeRaw.bind(prisma);
    const updatedCounts: Promise<number>[] = [];
    // SQL을 가짜로 처리하지 않고 실제 DB가 바꾼 줄 수를 모은다.
    vi.spyOn(prisma, '$executeRaw').mockImplementation((...args) => {
      const result = executeRaw(...args);
      updatedCounts.push(result);
      return result;
    });

    const results = await Promise.all(Array.from({ length: 10 }, () => service.findSessionUser(sessionId)));

    expect(results).toEqual(Array.from({ length: 10 }, () => user));
    expect((await Promise.all(updatedCounts)).reduce((total, count) => total + count, 0)).toBe(1);
    const [{ now: finishedAt }] = await prisma.$queryRaw<{ now: Date }[]>`
      SELECT now()
    `;
    const after = await prisma.session.findUniqueOrThrow({
      where: { tokenHash },
    });
    expect(after.lastSeenAt.getTime()).toBeGreaterThanOrEqual(startedAt.getTime());
    expect(after.lastSeenAt.getTime()).toBeLessThanOrEqual(finishedAt.getTime());
    expect(await prisma.session.findMany()).toEqual([{ ...before, lastSeenAt: after.lastSeenAt }]);
    expect(await prisma.user.findMany()).toEqual([{ ...userBefore, lastSeenAt: after.lastSeenAt }]);
  });
});
