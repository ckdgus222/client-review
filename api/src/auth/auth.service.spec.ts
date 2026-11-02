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
    [codeHash, nextCodeHash] = await Promise.all([
      bcrypt.hash(code, 12),
      bcrypt.hash(nextCode, 12),
    ]);
  });

  beforeEach(async () => {
    randomIntMock.mockReset().mockReturnValue(42);
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

  it('기존 사용자는 이름 없이 로그인하고 DB에는 토큰 해시와 DB 시각 기준 7일 세션만 저장한다', async () => {
    const user = await prisma.user.create({
      data: { email, name: '기존 사용자' },
    });
    await service.requestCode(email);
    const mailedCode = sendLoginCode.mock.calls[0][1];
    const [{ now: before }] = await prisma.$queryRaw<
      { now: Date }[]
    >`SELECT now()`;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2100-01-01T00:00:00Z'));

    const result = await service.verifyCode(email, mailedCode);

    const [{ now: after }] = await prisma.$queryRaw<
      { now: Date }[]
    >`SELECT now()`;
    expect(result).toEqual({
      user: { id: user.id, email, name: user.name },
      token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    expect(await prisma.user.findMany()).toEqual([user]);
    const sessions = await prisma.session.findMany();
    expect(sessions).toHaveLength(1);
    const [session] = sessions;
    expect(session.userId).toBe(user.id);
    expect(session.tokenHash).toBe(
      createHash('sha256').update(result.token).digest('hex'),
    );
    expect(session.expiresAt.getTime() - session.createdAt.getTime()).toBe(
      7 * 24 * 60 * 60 * 1000,
    );
    expect(session.createdAt.getTime()).toBeGreaterThanOrEqual(
      before.getTime(),
    );
    expect(session.createdAt.getTime()).toBeLessThanOrEqual(after.getTime());
    const loginCode = await prisma.loginCode.findUniqueOrThrow({
      where: { email },
    });
    expect(loginCode).toMatchObject({ attempts: 1, usedAt: expect.any(Date) });
    expect(loginCode.usedAt!.getTime()).toBeGreaterThanOrEqual(
      before.getTime(),
    );
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

    const result = await service.verifyCode(
      email,
      sendLoginCode.mock.calls[0][1],
      name,
    );

    expect(result).toEqual({
      user: { id: expect.any(String), email, name },
      token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    expect(await prisma.user.findMany()).toEqual([
      expect.objectContaining(result.user),
    ]);
    expect(await prisma.session.findMany()).toEqual([
      expect.objectContaining({
        userId: result.user.id,
        tokenHash: createHash('sha256').update(result.token).digest('hex'),
      }),
    ]);
    expect(
      await prisma.loginCode.findUniqueOrThrow({ where: { email } }),
    ).toMatchObject({
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
      const error = await service
        .verifyCode(email, code)
        .catch((error: unknown) => error);
      expectCodeError(error, 'NAME_REQUIRED');
      expect(
        await prisma.loginCode.findUniqueOrThrow({ where: { email } }),
      ).toEqual(before);
      expect(await prisma.user.count()).toBe(0);
      expect(await prisma.session.count()).toBe(0);
    }

    const result = await service.verifyCode(email, code, name);

    expect(result.user).toEqual({ id: expect.any(String), email, name });
    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.session.count()).toBe(1);
    expect(
      await prisma.loginCode.findUniqueOrThrow({ where: { email } }),
    ).toMatchObject({
      attempts: 1,
      usedAt: expect.any(Date),
    });
  });

  it('네 번 틀린 새 사용자도 다섯 번째에 맞힌 뒤 이름을 더해 가입할 수 있다', async () => {
    await createLoginCode();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const error = await service
        .verifyCode(email, wrongCode)
        .catch((error: unknown) => error);
      expectCodeError(error, 'CODE_WRONG');
    }

    const error = await service
      .verifyCode(email, code)
      .catch((error: unknown) => error);

    expectCodeError(error, 'NAME_REQUIRED');
    expect(
      await prisma.loginCode.findUniqueOrThrow({ where: { email } }),
    ).toMatchObject({
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
    expect(
      await prisma.loginCode.findUniqueOrThrow({ where: { email } }),
    ).toMatchObject({
      attempts: 5,
      usedAt: expect.any(Date),
    });
  });

  it.each([undefined, name])(
    '틀린 코드는 이름 %s을 보내도 가입이나 세션을 만들지 않는다',
    async (inputName) => {
      await createLoginCode();

      const error = await service
        .verifyCode(email, wrongCode, inputName)
        .catch((error: unknown) => error);

      expectCodeError(error, 'CODE_WRONG');
      expect(
        await prisma.loginCode.findUniqueOrThrow({ where: { email } }),
      ).toMatchObject({
        attempts: 1,
        usedAt: null,
      });
      expect(await prisma.user.count()).toBe(0);
      expect(await prisma.session.count()).toBe(0);
    },
  );

  it('틀린 코드 다섯 번 뒤에는 맞는 코드도 비교하지 않고 CODE_EXPIRED를 돌려준다', async () => {
    await createLoginCode();
    const compare = vi.spyOn(bcrypt, 'compare');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const error = await service
        .verifyCode(email, wrongCode, name)
        .catch((error: unknown) => error);
      expectCodeError(error, 'CODE_WRONG');
    }
    const before = await prisma.loginCode.findUniqueOrThrow({
      where: { email },
    });
    expect(before).toMatchObject({ attempts: 5, usedAt: null });
    compare.mockClear();

    const error = await service
      .verifyCode(email, code, name)
      .catch((error: unknown) => error);

    expectCodeError(error, 'CODE_EXPIRED');
    expect(compare).not.toHaveBeenCalled();
    expect(
      await prisma.loginCode.findUniqueOrThrow({ where: { email } }),
    ).toEqual(before);
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.session.count()).toBe(0);
  });

  it('틀린 코드를 동시에 열 번 보내도 비교는 다섯 번이고 시도 횟수는 5다', async () => {
    await createLoginCode();
    const compare = vi.spyOn(bcrypt, 'compare');

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        service.verifyCode(email, wrongCode, name),
      ),
    );

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(0);
    const failures = results.filter((result) => result.status === 'rejected');
    const errorCodes = failures.map(({ reason }) => {
      expect(reason).toBeInstanceOf(UnprocessableEntityException);
      return (reason as UnprocessableEntityException).getResponse() as {
        code: string;
      };
    });
    expect(errorCodes.filter(({ code }) => code === 'CODE_WRONG')).toHaveLength(
      5,
    );
    expect(
      errorCodes.filter(({ code }) => code === 'CODE_EXPIRED'),
    ).toHaveLength(5);
    failures.forEach(({ reason }, index) =>
      expectCodeError(reason, errorCodes[index].code),
    );
    expect(compare).toHaveBeenCalledTimes(5);
    expect(compare.mock.calls).toEqual(
      Array.from({ length: 5 }, () => [wrongCode, codeHash]),
    );
    expect(
      await prisma.loginCode.findUniqueOrThrow({ where: { email } }),
    ).toMatchObject({
      attempts: 5,
      usedAt: null,
    });
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.session.count()).toBe(0);
  });

  it.each(['기존 사용자', '새 사용자'])(
    '%s가 맞는 코드를 동시에 두 번 보내면 하나만 성공한다',
    async (state) => {
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
        service.verifyCode(
          email,
          code,
          state === '새 사용자' ? name : undefined,
        ),
        service.verifyCode(
          email,
          code,
          state === '새 사용자' ? name : undefined,
        ),
      ]);

      const successes = results.filter(
        (result) => result.status === 'fulfilled',
      );
      const failures = results.filter((result) => result.status === 'rejected');
      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);
      expectCodeError(failures[0].reason, 'CODE_EXPIRED');
      expect(await prisma.user.findMany()).toEqual([
        expect.objectContaining(successes[0].value.user),
      ]);
      expect(await prisma.session.findMany()).toEqual([
        expect.objectContaining({
          userId: successes[0].value.user.id,
          tokenHash: createHash('sha256')
            .update(successes[0].value.token)
            .digest('hex'),
        }),
      ]);
      expect(
        await prisma.loginCode.findUniqueOrThrow({ where: { email } }),
      ).toMatchObject({
        attempts: 2,
        usedAt: expect.any(Date),
      });
    },
  );

  it.each([0, 1])(
    '만료 시각이 DB 현재보다 %s초 전이면 비교하지 않고 거부한다',
    async (seconds) => {
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

      const error = await service
        .verifyCode(email, code, name)
        .catch((error: unknown) => error);

      expectCodeError(error, 'CODE_EXPIRED');
      expect(compare).not.toHaveBeenCalled();
      expect(
        await prisma.loginCode.findUniqueOrThrow({ where: { email } }),
      ).toEqual(before);
      expect(await prisma.user.count()).toBe(0);
      expect(await prisma.session.count()).toBe(0);
    },
  );

  it('쓴 코드는 다시 비교하지 않고 기존 사용자와 세션도 그대로 둔다', async () => {
    await createLoginCode();
    await service.verifyCode(email, code, name);
    const before = await prisma.loginCode.findUniqueOrThrow({
      where: { email },
    });
    const users = await prisma.user.findMany();
    const sessions = await prisma.session.findMany();
    const compare = vi.spyOn(bcrypt, 'compare');

    const error = await service
      .verifyCode(email, code, name)
      .catch((error: unknown) => error);

    expectCodeError(error, 'CODE_EXPIRED');
    expect(compare).not.toHaveBeenCalled();
    expect(
      await prisma.loginCode.findUniqueOrThrow({ where: { email } }),
    ).toEqual(before);
    expect(await prisma.user.findMany()).toEqual(users);
    expect(await prisma.session.findMany()).toEqual(sessions);
  });

  it('코드가 없는 이메일은 다른 이메일의 코드로 로그인할 수 없다', async () => {
    await createLoginCode();
    const before = await prisma.loginCode.findMany();
    const compare = vi.spyOn(bcrypt, 'compare');

    const error = await service
      .verifyCode('missing@example.com', code, name)
      .catch((error: unknown) => error);

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

    const error = await service
      .verifyCode(email, code, name)
      .catch((error: unknown) => error);

    expectCodeError(error, 'CODE_WRONG');
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.session.count()).toBe(0);
    await expect(
      service.verifyCode(email, nextCode, name),
    ).resolves.toMatchObject({
      user: { email, name },
    });
    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.session.count()).toBe(1);
  });

  it('비교 중 재발급되면 옛 코드는 CODE_EXPIRED이고 새 코드는 시도 0번부터 쓸 수 있다', async () => {
    await createLoginCode();
    const originalCompare = bcrypt.compare;
    const compare = vi
      .spyOn(bcrypt, 'compare')
      .mockImplementationOnce(async (input, hash) => {
        await prisma.$executeRaw`
        UPDATE login_codes
        SET code_hash = ${nextCodeHash}, attempts = 0, used_at = NULL,
            created_at = now(), expires_at = now() + interval '10 minutes'
        WHERE email = ${email}
      `;
        return originalCompare(input, hash);
      });

    const error = await service
      .verifyCode(email, code, name)
      .catch((error: unknown) => error);

    expectCodeError(error, 'CODE_EXPIRED');
    expect(compare).toHaveBeenCalledExactlyOnceWith(code, codeHash);
    expect(
      await prisma.loginCode.findUniqueOrThrow({ where: { email } }),
    ).toMatchObject({
      codeHash: nextCodeHash,
      attempts: 0,
      usedAt: null,
    });
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.session.count()).toBe(0);
    await expect(
      service.verifyCode(email, nextCode, name),
    ).resolves.toMatchObject({
      user: { email, name },
    });
    expect(compare).toHaveBeenLastCalledWith(nextCode, nextCodeHash);
    expect(
      await prisma.loginCode.findUniqueOrThrow({ where: { email } }),
    ).toMatchObject({
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
      const error = await service
        .verifyCode(email, wrongCode, name)
        .catch((error: unknown) => error);
      expectCodeError(error, 'CODE_WRONG');
      return originalCompare(input, hash);
    });

    const error = await service
      .verifyCode(email, code)
      .catch((error: unknown) => error);

    expectCodeError(error, 'NAME_REQUIRED');
    expect(
      await prisma.loginCode.findUniqueOrThrow({ where: { email } }),
    ).toMatchObject({
      codeHash: nextCodeHash,
      attempts: 1,
      usedAt: null,
    });
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.session.count()).toBe(0);
    await expect(
      service.verifyCode(email, nextCode, name),
    ).resolves.toMatchObject({
      user: { email, name },
    });
    expect(
      await prisma.loginCode.findUniqueOrThrow({ where: { email } }),
    ).toMatchObject({
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

    const error = await service
      .verifyCode(email, code, name)
      .catch((error: unknown) => error);

    expectCodeError(error, 'CODE_EXPIRED');
    expect(
      await prisma.loginCode.findUniqueOrThrow({ where: { email } }),
    ).toMatchObject({
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
    const createToken = vi
      .spyOn(sessionTokens, 'createSessionToken')
      .mockReturnValue(token);

    await expect(service.verifyCode(email, code, name)).rejects.toThrow();

    expect(createToken).toHaveBeenCalledOnce();
    expect(
      await prisma.loginCode.findUniqueOrThrow({ where: { email } }),
    ).toMatchObject({
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

    const result = await service.verifyCode(email, code, '바꿀 이름');

    expect(result.user).toEqual({ id: user.id, email, name: user.name });
    expect(await prisma.user.findMany()).toEqual([user]);
    expect(await prisma.session.findMany()).toEqual([
      expect.objectContaining({ userId: user.id }),
    ]);
  });
});
