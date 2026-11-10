import { createHash, randomUUID } from 'node:crypto';
import { UnprocessableEntityException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import bcrypt from 'bcrypt';
import { resetDatabase } from '../../test/reset-database.js';
import { MailService } from '../mail/mail.service.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuthService } from './auth.service.js';

const code = '000042';
const wrongCode = '999999';
const email = 'invited@example.com';
const name = '초대받은 사람';
type InvitationState = '유효' | '만료' | '무효' | '수락';

const codeErrorBody = (error: unknown) => {
  expect(error).toBeInstanceOf(UnprocessableEntityException);
  const exception = error as UnprocessableEntityException;
  expect(exception.getStatus()).toBe(422);
  return exception.getResponse();
};

describe('AuthService 초대에 따른 메일·가입 제한', () => {
  let module: TestingModule | undefined;
  let prisma: PrismaService;
  let service: AuthService;
  let codeHash: string;
  const sendLoginCode = vi.fn<MailService['sendLoginCode']>();

  const createInvitation = async (state: InvitationState = '유효', address = email) => {
    const inviter = await prisma.user.upsert({
      where: { email: 'developer@example.com' },
      create: { email: 'developer@example.com', name: '개발자' },
      update: {},
    });
    const project = await prisma.project.create({ data: { name: '초대 테스트' } });
    const tokenHash = createHash('sha256').update(randomUUID()).digest('hex');
    const [invitation] = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO invitations (project_id, email, token_hash, invited_by_id, expires_at, accepted_at, revoked_at)
      VALUES (${project.id}::uuid, ${address}, ${tokenHash}, ${inviter.id}::uuid,
              now() + ${state === '만료' ? 0 : 604800} * interval '1 second',
              CASE WHEN ${state === '수락'} THEN now() ELSE NULL END,
              CASE WHEN ${state === '무효'} THEN now() ELSE NULL END)
      RETURNING id
    `;
    return invitation.id;
  };

  const createLoginCode = async () => {
    await prisma.$executeRaw`
      INSERT INTO login_codes (email, code_hash, expires_at)
      VALUES (${email}, ${codeHash}, now() + interval '10 minutes')
    `;
  };

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [AuthService, { provide: MailService, useValue: { sendLoginCode } }],
    }).compile();
    prisma = module.get(PrismaService);
    service = module.get(AuthService);
    codeHash = await bcrypt.hash(code, 12);
  });

  beforeEach(async () => {
    vi.stubEnv('DEVELOPER_EMAIL', 'developer@example.com');
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

  it.each([
    { state: '가입한 사람', sendsMail: true },
    { state: '개발자 이메일', sendsMail: true },
    { state: '유효', sendsMail: true },
    { state: '모르는 이메일', sendsMail: false },
    { state: '만료', sendsMail: false },
    { state: '무효', sendsMail: false },
    { state: '수락', sendsMail: false },
    { state: '다른 이메일의 초대', sendsMail: false },
  ] as const)('$state의 메일 발송 여부는 $sendsMail이고 코드 저장·60초 제한은 같다', async ({ state, sendsMail }) => {
    if (state === '가입한 사람') await prisma.user.create({ data: { email, name } });
    if (state === '개발자 이메일') vi.stubEnv('DEVELOPER_EMAIL', email);
    if (state === '다른 이메일의 초대') await createInvitation('유효', 'other@example.com');
    if (state === '유효' || state === '만료' || state === '무효' || state === '수락') await createInvitation(state);
    const users = await prisma.user.findMany();
    const invitations = await prisma.invitation.findMany();
    // 앱 시계로 만료를 판단하면 유효한 초대까지 거부하게 된다.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2100-01-01T00:00:00Z'));

    await expect(service.requestCode(email)).resolves.toBeUndefined();

    const stored = await prisma.loginCode.findUniqueOrThrow({ where: { email } });
    expect(stored).toMatchObject({ attempts: 0, usedAt: null });
    expect(bcrypt.getRounds(stored.codeHash)).toBe(12);
    expect(stored.expiresAt.getTime() - stored.createdAt.getTime()).toBe(600_000);
    expect(sendLoginCode).toHaveBeenCalledTimes(sendsMail ? 1 : 0);
    if (sendsMail) {
      expect(sendLoginCode).toHaveBeenCalledWith(email, expect.stringMatching(/^\d{6}$/));
      expect(await bcrypt.compare(sendLoginCode.mock.calls[0][1], stored.codeHash)).toBe(true);
    }
    await expect(service.requestCode(email)).rejects.toMatchObject({ status: 429 });
    expect(await prisma.loginCode.findMany()).toEqual([stored]);
    expect(sendLoginCode).toHaveBeenCalledTimes(sendsMail ? 1 : 0);
    expect(await prisma.user.findMany()).toEqual(users);
    expect(await prisma.invitation.findMany()).toEqual(invitations);
    expect(await prisma.session.count()).toBe(0);
  });

  it.each([undefined, name])(
    '모르는 이메일은 이름 %s와 맞는 코드를 보내도 틀린 코드와 같은 본문이고 시도를 센다',
    async (inputName) => {
      await createLoginCode();
      const wrong = await service.verifyCode(email, wrongCode, inputName).catch((error: unknown) => error);
      expect(codeErrorBody(wrong)).toEqual({ statusCode: 422, message: '코드가 맞지 않아요', code: 'CODE_WRONG' });
      const before = await prisma.loginCode.findUniqueOrThrow({ where: { email } });

      const correct = await service.verifyCode(email, code, inputName).catch((error: unknown) => error);

      expect(codeErrorBody(correct)).toEqual(codeErrorBody(wrong));
      expect(await prisma.loginCode.findUniqueOrThrow({ where: { email } })).toEqual({
        ...before,
        attempts: before.attempts + 1,
      });
      expect(await prisma.user.count()).toBe(0);
      expect(await prisma.session.count()).toBe(0);
    },
  );

  it.each(['만료', '무효', '수락', '다른 이메일'] as const)(
    '%s 초대만 있으면 맞는 코드와 이름으로도 가입할 수 없다',
    async (state) => {
      await createInvitation(
        state === '다른 이메일' ? '유효' : state,
        state === '다른 이메일' ? 'other@example.com' : email,
      );
      await createLoginCode();
      const users = await prisma.user.findMany();
      const invitations = await prisma.invitation.findMany();
      // 만료된 초대를 앱의 과거 시계로 되살릴 수 없다.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2000-01-01T00:00:00Z'));

      const error = await service.verifyCode(email, code, name).catch((error: unknown) => error);

      expect(codeErrorBody(error)).toEqual({ statusCode: 422, message: '코드가 맞지 않아요', code: 'CODE_WRONG' });
      expect(await prisma.user.findMany()).toEqual(users);
      expect(await prisma.session.count()).toBe(0);
      expect(await prisma.invitation.findMany()).toEqual(invitations);
      expect(await prisma.loginCode.findUniqueOrThrow({ where: { email } })).toMatchObject({
        attempts: 1,
        usedAt: null,
      });
    },
  );

  it('초대받은 사람은 NAME_REQUIRED 뒤 같은 코드와 이름으로 가입하며 초대는 아직 수락하지 않는다', async () => {
    await createInvitation();
    const invitations = await prisma.invitation.findMany();
    await service.requestCode(email);
    const mailedCode = sendLoginCode.mock.calls[0][1];
    const before = await prisma.loginCode.findUniqueOrThrow({ where: { email } });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2100-01-01T00:00:00Z'));

    const error = await service.verifyCode(email, mailedCode).catch((error: unknown) => error);

    expect(codeErrorBody(error)).toMatchObject({ code: 'NAME_REQUIRED' });
    expect(await prisma.loginCode.findUniqueOrThrow({ where: { email } })).toEqual(before);
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
    expect(await prisma.session.count()).toBe(0);
    const result = await service.verifyCode(email, mailedCode, name);
    expect(result.user).toEqual({ id: expect.any(String), email, name });
    await expect(service.findSessionUser(result.token)).resolves.toEqual(result.user);
    expect(await prisma.loginCode.findUniqueOrThrow({ where: { email } })).toMatchObject({
      attempts: 1,
      usedAt: expect.any(Date),
    });
    expect(await prisma.invitation.findMany()).toEqual(invitations);
    expect(await prisma.projectMember.count()).toBe(0);
  });

  it.each(['만료', '무효', '수락'] as const)(
    'NAME_REQUIRED 뒤 초대가 %s 상태가 되면 이름을 보내도 가입하지 않는다',
    async (state) => {
      const invitationId = await createInvitation();
      await createLoginCode();
      const first = await service.verifyCode(email, code).catch((error: unknown) => error);
      expect(codeErrorBody(first)).toMatchObject({ code: 'NAME_REQUIRED' });
      await prisma.$executeRaw`
      UPDATE invitations
      SET expires_at = CASE WHEN ${state === '만료'} THEN now() ELSE expires_at END,
          revoked_at = CASE WHEN ${state === '무효'} THEN now() ELSE NULL END,
          accepted_at = CASE WHEN ${state === '수락'} THEN now() ELSE NULL END
      WHERE id = ${invitationId}::uuid
    `;

      const error = await service.verifyCode(email, code, name).catch((error: unknown) => error);

      expect(codeErrorBody(error)).toMatchObject({ code: 'CODE_WRONG' });
      expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
      expect(await prisma.session.count()).toBe(0);
      expect(await prisma.loginCode.findUniqueOrThrow({ where: { email } })).toMatchObject({
        attempts: 1,
        usedAt: null,
      });
    },
  );

  it.each(['만료', '무효', '수락'] as const)(
    '가입 트랜잭션 직전에 초대가 %s 상태가 되면 거부하고 코드 사용도 되돌린다',
    async (state) => {
      const invitationId = await createInvitation();
      await createLoginCode();
      const runTransaction = prisma.$transaction.bind(prisma);
      // 첫 가입 허용 검사와 저장 사이에 다른 요청이 초대를 바꾸는 순서만 고정한다.
      // 허용 판정과 가입·롤백은 실제 DB와 서비스가 수행한다.
      vi.spyOn(prisma, '$transaction').mockImplementationOnce(async (operation) => {
        await prisma.$executeRaw`
        UPDATE invitations
        SET expires_at = CASE WHEN ${state === '만료'} THEN now() ELSE expires_at END,
            revoked_at = CASE WHEN ${state === '무효'} THEN now() ELSE NULL END,
            accepted_at = CASE WHEN ${state === '수락'} THEN now() ELSE NULL END
        WHERE id = ${invitationId}::uuid
      `;
        return runTransaction(operation);
      });

      const error = await service.verifyCode(email, code, name).catch((error: unknown) => error);

      expect(codeErrorBody(error)).toMatchObject({ code: 'CODE_WRONG' });
      expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
      expect(await prisma.session.count()).toBe(0);
      expect(await prisma.loginCode.findUniqueOrThrow({ where: { email } })).toMatchObject({
        attempts: 1,
        usedAt: null,
      });
      // 새 초대를 받으면 앞에서 거부된 코드로 다시 가입할 수 있다.
      await createInvitation();
      await expect(service.verifyCode(email, code, name)).resolves.toMatchObject({ user: { email, name } });
      expect(await prisma.loginCode.findUniqueOrThrow({ where: { email } })).toMatchObject({
        attempts: 2,
        usedAt: expect.any(Date),
      });
    },
  );

  it('쓸 수 없는 옛 초대가 여럿이어도 다른 프로젝트의 유효한 초대 하나로 메일을 받고 가입한다', async () => {
    await createInvitation('만료');
    await createInvitation('무효');
    await createInvitation('수락');
    await createInvitation();

    await service.requestCode(email);
    expect(sendLoginCode).toHaveBeenCalledExactlyOnceWith(email, expect.stringMatching(/^\d{6}$/));
    await expect(service.verifyCode(email, sendLoginCode.mock.calls[0][1], name)).resolves.toMatchObject({
      user: { email, name },
    });
    expect(await prisma.session.count()).toBe(1);
  });

  it.each(['초대 없음', '만료', '무효', '수락'] as const)(
    '이미 가입한 사람은 %s 상태여도 메일을 받고 이름 없이 로그인한다',
    async (state) => {
      const user = await prisma.user.create({ data: { email, name } });
      if (state !== '초대 없음') await createInvitation(state);

      await service.requestCode(email);
      expect(sendLoginCode).toHaveBeenCalledExactlyOnceWith(email, expect.stringMatching(/^\d{6}$/));
      const result = await service.verifyCode(email, sendLoginCode.mock.calls[0][1]);
      expect(result.user).toEqual({ id: user.id, email, name });
      expect(await prisma.user.count({ where: { email } })).toBe(1);
      await expect(service.findSessionUser(result.token)).resolves.toEqual(result.user);
    },
  );

  it.each([undefined, '', ' \t\n '])(
    '개발자 설정이 %s이고 초대가 없으면 메일과 가입 모두 허용하지 않는다',
    async (developerEmail) => {
      vi.stubEnv('DEVELOPER_EMAIL', developerEmail);
      await service.requestCode(email);
      expect(sendLoginCode).not.toHaveBeenCalled();
      // 메일 없이 정답을 알고 있다는 상황을 준비한다.
      await prisma.loginCode.update({ where: { email }, data: { codeHash } });

      const error = await service.verifyCode(email, code, name).catch((error: unknown) => error);

      expect(codeErrorBody(error)).toMatchObject({ code: 'CODE_WRONG' });
      expect(await prisma.user.count()).toBe(0);
      expect(await prisma.session.count()).toBe(0);
    },
  );
});
