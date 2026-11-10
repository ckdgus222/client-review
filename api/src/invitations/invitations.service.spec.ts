import { createHash } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { resetDatabase } from '../../test/reset-database.js';
import { ActivityService } from '../activity/activity.service.js';
import { MailService } from '../mail/mail.service.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { InvitationsService } from './invitations.service.js';

const tokenFromLink = (link: string) => new URL(link).pathname.split('/').at(-1)!;
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

// 토큰은 테스트에서 만든 링크에서만 읽는다. 메일 외에는 실제 서비스와 DB를 쓴다.
describe('InvitationsService', () => {
  let module: TestingModule | undefined;
  let prisma: PrismaService;
  let service: InvitationsService;
  let activity: ActivityService;
  let developer: { id: string; email: string };
  let invited: { id: string; email: string };
  let outsider: { id: string; email: string };
  let projectId: string;
  const appUrl = 'https://review.example.com';
  const missingId = '00000000-0000-4000-8000-000000000001';
  const mail = { sendInvitation: vi.fn<MailService['sendInvitation']>() };

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [InvitationsService, ProjectsService, ActivityService, { provide: MailService, useValue: mail }],
    }).compile();
    prisma = module.get(PrismaService);
    service = module.get(InvitationsService);
    activity = module.get(ActivityService);
  });

  beforeEach(async () => {
    vi.stubEnv('APP_URL', appUrl);
    mail.sendInvitation.mockReset();
    await resetDatabase(prisma);
    developer = await prisma.user.create({ data: { email: 'developer@example.com', name: '개발자' } });
    invited = await prisma.user.create({ data: { email: 'invited@example.com', name: '초대받은 사람' } });
    outsider = await prisma.user.create({ data: { email: 'outsider@example.com', name: '다른 사람' } });
    const project = await prisma.project.create({
      data: { name: '쇼핑몰 리뉴얼', members: { create: { userId: developer.id, role: 'DEVELOPER' } } },
    });
    projectId = project.id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await module?.close();
  });

  const createInvitation = async (email = invited.email, targetProjectId = projectId) => {
    const result = await service.create(targetProjectId, developer.id, email);
    return { ...result, token: tokenFromLink(result.link) };
  };

  const addClients = async (count: number, targetProjectId = projectId) => {
    const members = [];
    for (let index = 0; index < count; index += 1) {
      members.push(
        await prisma.projectMember.create({
          data: {
            project: { connect: { id: targetProjectId } },
            role: 'CLIENT',
            user: { create: { email: `client-${index}-${targetProjectId}@example.com`, name: `클라이언트 ${index}` } },
          },
        }),
      );
    }
    return members;
  };

  const readState = async () => ({
    invitations: await prisma.invitation.findMany({ orderBy: { id: 'asc' } }),
    members: await prisma.projectMember.findMany({ orderBy: { id: 'asc' } }),
    events: await prisma.activityEvent.findMany({ orderBy: { id: 'asc' } }),
    projects: await prisma.project.findMany({ orderBy: { id: 'asc' } }),
  });

  const expireInvitation = (token: string) => prisma.$executeRaw`
    UPDATE invitations SET expires_at = now() - interval '1 second'
    WHERE token_hash = ${tokenHash(token)}
  `;

  it('create는 APP_URL의 링크와 세 칸을 반환하고 DB에는 원본 대신 SHA-256 해시와 DB 시각 기준 7일 만료를 저장한다', async () => {
    const result = await service.create(projectId, developer.id, invited.email);
    const token = tokenFromLink(result.link);
    const stored = await prisma.invitation.findFirstOrThrow();

    expect(result).toEqual({
      email: invited.email,
      expiresAt: stored.expiresAt,
      link: `${appUrl}/app/invite/${token}`,
    });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(stored).toEqual({
      id: expect.any(String),
      projectId,
      email: invited.email,
      tokenHash: tokenHash(token),
      invitedById: developer.id,
      expiresAt: result.expiresAt,
      acceptedAt: null,
      revokedAt: null,
      createdAt: expect.any(Date),
    });
    expect(JSON.stringify(stored)).not.toContain(token);
    const [expiration] = await prisma.$queryRaw<{ seven_days: boolean }[]>`
      SELECT expires_at = created_at + interval '7 days' AS seven_days FROM invitations WHERE id = ${stored.id}::uuid
    `;
    expect(expiration.seven_days).toBe(true);
    expect(await prisma.activityEvent.findMany()).toEqual([
      {
        id: expect.any(String),
        projectId,
        actorId: developer.id,
        type: 'INVITATION_CREATED',
        memberId: null,
        versionId: null,
        createdAt: expect.any(Date),
      },
    ]);
    expect(mail.sendInvitation).toHaveBeenCalledExactlyOnceWith(invited.email, result.link, '쇼핑몰 리뉴얼', '개발자');
    expect(await prisma.projectMember.count()).toBe(1);
  });

  it.each([undefined, ''])('create는 APP_URL=%s이면 저장하거나 메일을 보내지 않는다', async (appUrlValue) => {
    vi.stubEnv('APP_URL', appUrlValue);
    const before = await readState();

    await expect(createInvitation()).rejects.toThrow();

    expect(await readState()).toEqual(before);
    expect(mail.sendInvitation).not.toHaveBeenCalled();
  });

  it('create는 아직 가입하지 않은 이메일에도 초대하고 사용자를 미리 만들지 않는다', async () => {
    const email = 'new-client@example.com';
    const usersBefore = await prisma.user.findMany({ orderBy: { id: 'asc' } });

    const invitation = await createInvitation(email);

    expect(await prisma.user.findMany({ orderBy: { id: 'asc' } })).toEqual(usersBefore);
    await expect(service.preview(invitation.token)).resolves.toMatchObject({ email, status: 'PENDING' });
    expect(mail.sendInvitation).toHaveBeenCalledExactlyOnceWith(email, invitation.link, '쇼핑몰 리뉴얼', '개발자');
  });

  it('create는 실제 트랜잭션 커밋이 끝난 뒤에만 메일을 보낸다', async () => {
    const transaction = prisma.$transaction.bind(prisma);
    let committed = false;
    vi.spyOn(prisma, '$transaction').mockImplementationOnce(async (work) => {
      const result = await transaction(work);
      committed = true;
      return result;
    });
    mail.sendInvitation.mockImplementationOnce(() => {
      expect(committed).toBe(true);
    });

    await createInvitation();

    expect(mail.sendInvitation).toHaveBeenCalledTimes(1);
    expect(await prisma.invitation.count()).toBe(1);
    expect(await prisma.activityEvent.count()).toBe(1);
  });

  it.each([false, true])(
    'create는 만료 여부=%s인 같은 이메일의 예전 초대를 무효로 하고 새 링크만 허용한다',
    async (expired) => {
      const first = await createInvitation();
      if (expired) await expireInvitation(first.token);
      const second = await createInvitation();

      expect(second.token).not.toBe(first.token);
      expect(await prisma.invitation.findUniqueOrThrow({ where: { tokenHash: tokenHash(first.token) } })).toMatchObject(
        {
          acceptedAt: null,
          revokedAt: expect.any(Date),
        },
      );
      await expect(service.preview(first.token)).rejects.toMatchObject({ status: 404 });
      await expect(service.accept(first.token, invited)).rejects.toMatchObject({ status: 404 });
      await expect(service.preview(second.token)).resolves.toMatchObject({ status: 'PENDING' });
      expect(await prisma.invitation.count({ where: { acceptedAt: null, revokedAt: null } })).toBe(1);
      expect(await prisma.activityEvent.count({ where: { type: 'INVITATION_CREATED', memberId: null } })).toBe(2);
      expect(mail.sendInvitation).toHaveBeenCalledTimes(2);
    },
  );

  it('create는 같은 이메일이라도 다른 프로젝트의 초대와 멤버를 건드리지 않는다', async () => {
    const otherProject = await prisma.project.create({
      data: {
        name: '다른 프로젝트',
        members: {
          create: [
            { userId: developer.id, role: 'DEVELOPER' },
            { userId: invited.id, role: 'CLIENT' },
          ],
        },
      },
    });
    const otherInvitation = await createInvitation(outsider.email, otherProject.id);
    const otherRow = await prisma.invitation.findUniqueOrThrow({
      where: { tokenHash: tokenHash(otherInvitation.token) },
    });

    await createInvitation(outsider.email);
    await createInvitation(invited.email);

    expect(await prisma.invitation.findUnique({ where: { id: otherRow.id } })).toEqual(otherRow);
    await expect(service.preview(otherInvitation.token)).resolves.toMatchObject({
      projectName: '다른 프로젝트',
      status: 'PENDING',
    });
  });

  it.each(['DEVELOPER', 'CLIENT'] as const)('create는 활성 %s 이메일을 ALREADY_MEMBER로 거절한다', async (role) => {
    if (role === 'CLIENT') await prisma.projectMember.create({ data: { projectId, userId: invited.id, role } });
    const before = await readState();
    const email = role === 'DEVELOPER' ? developer.email : invited.email;

    await expect(createInvitation(email)).rejects.toMatchObject({ status: 409, response: { code: 'ALREADY_MEMBER' } });

    expect(await readState()).toEqual(before);
    expect(mail.sendInvitation).not.toHaveBeenCalled();
  });

  it('create는 활성 클라이언트 5명이면 PROJECT_FULL이고 기존 초대도 무효로 만들지 않는다', async () => {
    const first = await createInvitation();
    await addClients(5);
    const before = await readState();
    mail.sendInvitation.mockClear();

    await expect(createInvitation()).rejects.toMatchObject({ status: 409, response: { code: 'PROJECT_FULL' } });

    expect(await readState()).toEqual(before);
    expect(mail.sendInvitation).not.toHaveBeenCalled();
    await expect(service.preview(first.token)).resolves.toMatchObject({ status: 'PENDING' });
  });

  it('create는 정원이 꽉 차도 활성 멤버 이메일이면 ALREADY_MEMBER를 먼저 반환한다', async () => {
    await addClients(5);
    await expect(createInvitation(developer.email)).rejects.toMatchObject({
      status: 409,
      response: { code: 'ALREADY_MEMBER' },
    });
    expect(await prisma.invitation.count()).toBe(0);
    expect(await prisma.activityEvent.count()).toBe(0);
    expect(mail.sendInvitation).not.toHaveBeenCalled();
  });

  it('create는 개발자·철회된 클라이언트·대기 초대·다른 프로젝트 멤버를 정원에 세지 않는다', async () => {
    const clients = await addClients(5);
    await prisma.projectMember.update({ where: { id: clients[0].id }, data: { revokedAt: new Date() } });
    const otherProject = await prisma.project.create({ data: { name: '다른 프로젝트' } });
    await addClients(5, otherProject.id);

    await createInvitation();
    await expect(createInvitation(outsider.email)).resolves.toMatchObject({ email: outsider.email });
    expect(await prisma.invitation.count()).toBe(2);
  });

  it.each([
    { role: 'CLIENT', revoked: false, status: 403 },
    { role: 'CLIENT', revoked: true, status: 404 },
    { role: 'DEVELOPER', revoked: true, status: 404 },
    { role: 'OUTSIDER', revoked: false, status: 404 },
    { role: 'MISSING_PROJECT', revoked: false, status: 404 },
  ] as const)(
    'create는 $role / 철회=$revoked 요청을 $status로 거부하고 아무것도 쓰지 않는다',
    async ({ role, revoked, status }) => {
      if (role === 'CLIENT')
        await prisma.projectMember.create({
          data: { projectId, userId: outsider.id, role, revokedAt: revoked ? new Date() : null },
        });
      if (role === 'DEVELOPER')
        await prisma.projectMember.update({
          where: { projectId_userId: { projectId, userId: developer.id } },
          data: { revokedAt: new Date() },
        });
      const before = await readState();
      const targetId = role === 'MISSING_PROJECT' ? missingId : projectId;
      const actorId = role === 'DEVELOPER' || role === 'MISSING_PROJECT' ? developer.id : outsider.id;

      await expect(service.create(targetId, actorId, invited.email)).rejects.toMatchObject({ status });

      expect(await readState()).toEqual(before);
      expect(mail.sendInvitation).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'create는 일지 저장 뒤 실패하면 기존 초대 유무=%s와 무관하게 초대·일지를 되돌리고 메일을 보내지 않는다',
    async (hasPrevious) => {
      if (hasPrevious) await createInvitation();
      const before = await readState();
      mail.sendInvitation.mockClear();
      const record = activity.record.bind(activity);
      vi.spyOn(activity, 'record').mockImplementationOnce(async (tx, event) => {
        await record(tx, event);
        throw new Error('일지 저장 후 실패');
      });

      await expect(createInvitation()).rejects.toThrow('일지 저장 후 실패');

      expect(await readState()).toEqual(before);
      expect(mail.sendInvitation).not.toHaveBeenCalled();
    },
  );

  it('preview는 로그인 정보 없이 PENDING의 네 칸만 반환한다', async () => {
    const invitation = await createInvitation();
    await expect(service.preview(invitation.token)).resolves.toEqual({
      projectName: '쇼핑몰 리뉴얼',
      inviterName: '개발자',
      email: invited.email,
      status: 'PENDING',
    });
  });

  it.each([false, true])(
    'preview는 수락된 초대의 만료 여부=%s와 무관하게 ACCEPTED의 네 칸만 반환한다',
    async (expired) => {
      const invitation = await createInvitation();
      await service.accept(invitation.token, invited);
      if (expired) await expireInvitation(invitation.token);

      await expect(service.preview(invitation.token)).resolves.toEqual({
        projectName: '쇼핑몰 리뉴얼',
        inviterName: '개발자',
        email: invited.email,
        status: 'ACCEPTED',
      });
    },
  );

  it.each([
    { state: 'expired', status: 410 },
    { state: 'revoked', status: 404 },
    { state: 'revoked-expired', status: 404 },
    { state: 'missing', status: 404 },
  ])('preview는 $state인 초대를 $status로 거절한다', async ({ state, status }) => {
    const invitation = await createInvitation();
    if (state.includes('expired')) await expireInvitation(invitation.token);
    if (state.startsWith('revoked'))
      await prisma.invitation.update({
        where: { tokenHash: tokenHash(invitation.token) },
        data: { revokedAt: new Date() },
      });
    const token = state === 'missing' ? 'unknown-invitation' : invitation.token;
    const before = await readState();

    await expect(service.preview(token)).rejects.toMatchObject({ status });

    expect(await readState()).toEqual(before);
  });

  it('accept는 CLIENT와 DB 수락 시각·멤버를 가리키는 일지를 함께 저장하며 승인자를 만들지 않는다', async () => {
    const invitation = await createInvitation();
    mail.sendInvitation.mockClear();

    await expect(service.accept(invitation.token, invited)).resolves.toEqual({ projectId });

    const member = await prisma.projectMember.findUniqueOrThrow({
      where: { projectId_userId: { projectId, userId: invited.id } },
    });
    expect(member).toMatchObject({ role: 'CLIENT', revokedAt: null });
    const accepted = await prisma.invitation.findUniqueOrThrow({ where: { tokenHash: tokenHash(invitation.token) } });
    expect(accepted).toMatchObject({ acceptedAt: expect.any(Date), revokedAt: null });
    expect(await prisma.activityEvent.findMany({ where: { type: 'INVITATION_ACCEPTED' } })).toEqual([
      {
        id: expect.any(String),
        projectId,
        actorId: invited.id,
        type: 'INVITATION_ACCEPTED',
        memberId: member.id,
        versionId: null,
        createdAt: expect.any(Date),
      },
    ]);
    expect(await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).toMatchObject({
      approverMemberId: null,
    });
    expect(mail.sendInvitation).not.toHaveBeenCalled();
  });

  it('accept는 다른 이메일을 EMAIL_MISMATCH로 거절하고 맞는 이메일은 같은 링크로 참여할 수 있다', async () => {
    const invitation = await createInvitation();
    const before = await readState();

    await expect(service.accept(invitation.token, outsider)).rejects.toMatchObject({
      status: 403,
      response: { code: 'EMAIL_MISMATCH' },
    });

    expect(await readState()).toEqual(before);
    await expect(service.accept(invitation.token, invited)).resolves.toEqual({ projectId });
  });

  it.each([
    { state: 'expired', status: 410 },
    { state: 'revoked', status: 404 },
    { state: 'revoked-expired', status: 404 },
    { state: 'accepted', status: 404 },
    { state: 'accepted-expired', status: 404 },
    { state: 'missing', status: 404 },
  ])(
    'accept는 $state 상태를 이메일·활성 멤버·정원 확인보다 먼저 검사하여 $status로 거절한다',
    async ({ state, status }) => {
      const invitation = await createInvitation();
      if (state.startsWith('accepted')) await service.accept(invitation.token, invited);
      if (state.includes('expired')) await expireInvitation(invitation.token);
      if (state.startsWith('revoked'))
        await prisma.invitation.update({
          where: { tokenHash: tokenHash(invitation.token) },
          data: { revokedAt: new Date() },
        });
      if (!state.startsWith('accepted'))
        await prisma.projectMember.create({ data: { projectId, userId: invited.id, role: 'CLIENT' } });
      await addClients(4);
      const token = state === 'missing' ? 'unknown-invitation' : invitation.token;
      const before = await readState();
      mail.sendInvitation.mockClear();

      await expect(service.accept(token, invited)).rejects.toMatchObject({ status });
      await expect(service.accept(token, outsider)).rejects.toMatchObject({ status });

      expect(await readState()).toEqual(before);
      expect(mail.sendInvitation).not.toHaveBeenCalled();
    },
  );

  it('accept는 이메일 불일치를 이미 활성 멤버·정원 초과보다 먼저 검사한다', async () => {
    const invitation = await createInvitation();
    await addClients(5);
    const before = await readState();

    await expect(service.accept(invitation.token, developer)).rejects.toMatchObject({
      status: 403,
      response: { code: 'EMAIL_MISMATCH' },
    });

    expect(await readState()).toEqual(before);
  });

  it.each([false, true])(
    'accept는 이미 활성 멤버면 정원 초과=%s여도 ALREADY_MEMBER이고 초대를 소모하지 않는다',
    async (full) => {
      const invitation = await createInvitation();
      await prisma.projectMember.create({ data: { projectId, userId: invited.id, role: 'CLIENT' } });
      if (full) await addClients(4);
      const before = await readState();

      await expect(service.accept(invitation.token, invited)).rejects.toMatchObject({
        status: 409,
        response: { code: 'ALREADY_MEMBER' },
      });

      expect(await readState()).toEqual(before);
    },
  );

  it('accept는 5명이면 PROJECT_FULL이며 한 명을 철회하면 같은 초대로 다섯 번째 클라이언트가 된다', async () => {
    const invitation = await createInvitation();
    const clients = await addClients(5);
    const before = await readState();

    await expect(service.accept(invitation.token, invited)).rejects.toMatchObject({
      status: 409,
      response: { code: 'PROJECT_FULL' },
    });
    expect(await readState()).toEqual(before);
    await prisma.projectMember.update({ where: { id: clients[0].id }, data: { revokedAt: new Date() } });

    await expect(service.accept(invitation.token, invited)).resolves.toEqual({ projectId });
    expect(await prisma.projectMember.count({ where: { projectId, role: 'CLIENT', revokedAt: null } })).toBe(5);
  });

  it('철회된 사람은 새 초대를 받아 같은 멤버 id로 돌아오며 예전 링크와 승인자는 복구되지 않는다', async () => {
    const first = await createInvitation();
    await service.accept(first.token, invited);
    const member = await prisma.projectMember.findUniqueOrThrow({
      where: { projectId_userId: { projectId, userId: invited.id } },
    });
    await prisma.project.update({ where: { id: projectId }, data: { approverMemberId: member.id } });
    // 철회 서비스는 다음 조각이다. 여기서는 철회가 끝난 DB 상태를 준비한다.
    await prisma.$transaction(async (tx) => {
      await tx.projectMember.update({ where: { id: member.id }, data: { revokedAt: new Date() } });
      await tx.project.update({ where: { id: projectId }, data: { approverMemberId: null } });
    });
    const second = await createInvitation();

    await expect(service.accept(first.token, invited)).rejects.toMatchObject({ status: 404 });
    await expect(service.accept(second.token, invited)).resolves.toEqual({ projectId });

    expect(await prisma.projectMember.findUnique({ where: { id: member.id } })).toEqual(member);
    expect(await prisma.projectMember.count({ where: { projectId, userId: invited.id } })).toBe(1);
    expect(await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).toMatchObject({
      approverMemberId: null,
    });
    expect(await prisma.activityEvent.count({ where: { type: 'INVITATION_ACCEPTED', memberId: member.id } })).toBe(2);
    expect(await prisma.invitation.findUniqueOrThrow({ where: { tokenHash: tokenHash(first.token) } })).toMatchObject({
      acceptedAt: expect.any(Date),
      revokedAt: null,
    });
  });

  it('accept는 다른 프로젝트 멤버 수를 세지 않고 기존 승인자를 바꾸지 않는다', async () => {
    const [approver] = await addClients(1);
    await prisma.project.update({ where: { id: projectId }, data: { approverMemberId: approver.id } });
    const otherProject = await prisma.project.create({ data: { name: '다른 프로젝트' } });
    await addClients(5, otherProject.id);
    const invitation = await createInvitation();

    await expect(service.accept(invitation.token, invited)).resolves.toEqual({ projectId });

    expect(await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).toMatchObject({
      approverMemberId: approver.id,
    });
  });

  it.each([false, true])(
    'accept는 일지 저장 뒤 실패하면 기존 철회 멤버 유무=%s와 무관하게 수락·멤버·일지를 되돌린다',
    async (revokedMember) => {
      if (revokedMember)
        await prisma.projectMember.create({
          data: { projectId, userId: invited.id, role: 'CLIENT', revokedAt: new Date() },
        });
      const invitation = await createInvitation();
      const before = await readState();
      const record = activity.record.bind(activity);
      vi.spyOn(activity, 'record').mockImplementationOnce(async (tx, event) => {
        await record(tx, event);
        throw new Error('수락 일지 저장 후 실패');
      });
      mail.sendInvitation.mockClear();

      await expect(service.accept(invitation.token, invited)).rejects.toThrow('수락 일지 저장 후 실패');

      expect(await readState()).toEqual(before);
      expect(mail.sendInvitation).not.toHaveBeenCalled();
      await expect(service.accept(invitation.token, invited)).resolves.toEqual({ projectId });
    },
  );

  it('같은 이메일로 동시에 두 번 만들면 둘 다 성공하고 쓸 수 있는 링크는 하나만 남는다', async () => {
    const results = await Promise.allSettled([createInvitation(), createInvitation()]);
    expect(results.map(({ status }) => status)).toEqual(['fulfilled', 'fulfilled']);
    const invitations = results.map((result) => {
      if (result.status !== 'fulfilled') throw result.reason;
      return result.value;
    });
    const previews = await Promise.allSettled(invitations.map(({ token }) => service.preview(token)));

    expect(new Set(invitations.map(({ token }) => token)).size).toBe(2);
    expect(previews.filter(({ status }) => status === 'fulfilled')).toEqual([
      { status: 'fulfilled', value: expect.objectContaining({ status: 'PENDING' }) },
    ]);
    expect(previews.filter(({ status }) => status === 'rejected')).toEqual([
      { status: 'rejected', reason: expect.objectContaining({ status: 404 }) },
    ]);
    expect(await prisma.invitation.count({ where: { acceptedAt: null, revokedAt: null } })).toBe(1);
    expect(await prisma.invitation.count({ where: { revokedAt: { not: null } } })).toBe(1);
    expect(await prisma.activityEvent.count({ where: { type: 'INVITATION_CREATED' } })).toBe(2);
    expect(mail.sendInvitation).toHaveBeenCalledTimes(2);
  });

  it('같은 링크를 동시에 두 번 수락하면 하나만 성공하고 두 번째는 ALREADY_MEMBER 대신 404다', async () => {
    const invitation = await createInvitation();

    const results = await Promise.allSettled([
      service.accept(invitation.token, invited),
      service.accept(invitation.token, invited),
    ]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toEqual([
      { status: 'fulfilled', value: { projectId } },
    ]);
    expect(results.filter(({ status }) => status === 'rejected')).toEqual([
      { status: 'rejected', reason: expect.objectContaining({ status: 404 }) },
    ]);
    expect(await prisma.projectMember.count({ where: { projectId, userId: invited.id, revokedAt: null } })).toBe(1);
    expect(await prisma.invitation.count({ where: { acceptedAt: { not: null } } })).toBe(1);
    expect(await prisma.activityEvent.count({ where: { type: 'INVITATION_ACCEPTED' } })).toBe(1);
  });

  it('활성 클라이언트가 4명일 때 두 사람이 동시에 수락하면 하나만 성공하고 다른 초대는 PROJECT_FULL로 남는다', async () => {
    await addClients(4);
    const first = await createInvitation();
    const second = await createInvitation(outsider.email);

    const results = await Promise.allSettled([
      service.accept(first.token, invited),
      service.accept(second.token, outsider),
    ]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toEqual([
      { status: 'fulfilled', value: { projectId } },
    ]);
    expect(results.filter(({ status }) => status === 'rejected')).toEqual([
      {
        status: 'rejected',
        reason: expect.objectContaining({ status: 409, response: expect.objectContaining({ code: 'PROJECT_FULL' }) }),
      },
    ]);
    expect(await prisma.projectMember.count({ where: { projectId, role: 'CLIENT', revokedAt: null } })).toBe(5);
    expect(await prisma.invitation.count({ where: { acceptedAt: { not: null } } })).toBe(1);
    expect(await prisma.invitation.count({ where: { acceptedAt: null, revokedAt: null } })).toBe(1);
    expect(await prisma.activityEvent.count({ where: { type: 'INVITATION_ACCEPTED' } })).toBe(1);
  });

  it('수락과 같은 이메일의 재초대가 경쟁하면 수락 성공 또는 새 초대 중 하나만 유효하다', async () => {
    const first = await createInvitation();
    mail.sendInvitation.mockClear();

    const [acceptance, creation] = await Promise.allSettled([service.accept(first.token, invited), createInvitation()]);

    if (acceptance.status === 'fulfilled') {
      expect(acceptance.value).toEqual({ projectId });
      expect(creation).toMatchObject({
        status: 'rejected',
        reason: { status: 409, response: { code: 'ALREADY_MEMBER' } },
      });
      expect(await prisma.invitation.count()).toBe(1);
      expect(await prisma.projectMember.count({ where: { userId: invited.id } })).toBe(1);
      expect(await prisma.activityEvent.count({ where: { type: 'INVITATION_ACCEPTED' } })).toBe(1);
      expect(mail.sendInvitation).not.toHaveBeenCalled();
      return;
    }
    expect(acceptance.reason).toMatchObject({ status: 404 });
    expect(creation.status).toBe('fulfilled');
    if (creation.status !== 'fulfilled') throw new Error('재초대가 성공해야 해요');
    await expect(service.preview(first.token)).rejects.toMatchObject({ status: 404 });
    await expect(service.preview(creation.value.token)).resolves.toMatchObject({ status: 'PENDING' });
    expect(await prisma.projectMember.count({ where: { userId: invited.id } })).toBe(0);
    expect(await prisma.activityEvent.count({ where: { type: 'INVITATION_ACCEPTED' } })).toBe(0);
    expect(await prisma.invitation.count({ where: { acceptedAt: null, revokedAt: null } })).toBe(1);
    expect(mail.sendInvitation).toHaveBeenCalledTimes(1);
  });

  it.each([
    { change: 'accepted', status: 404 },
    { change: 'revoked', status: 404 },
    { change: 'expired', status: 410 },
    { change: 'full', status: 409 },
  ])(
    'accept는 프로젝트 잠금을 기다린 뒤 $change 상태를 다시 읽어 $status로 거절한다',
    async ({ change, status }) => {
      const invitation = await createInvitation();
      const clients = await addClients(5);
      await prisma.projectMember.update({ where: { id: clients[0].id }, data: { revokedAt: new Date() } });
      let request: Promise<unknown> | undefined;
      let settled = false;

      try {
        await prisma.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT id FROM projects WHERE id = ${projectId}::uuid FOR UPDATE`;
            request = service
              .accept(invitation.token, invited)
              .catch((error: unknown) => error)
              .finally(() => {
                settled = true;
              });
            await new Promise<void>((resolve) => {
              setTimeout(resolve, 200);
            });
            expect(settled).toBe(false);
            if (change === 'accepted')
              await tx.invitation.update({
                where: { tokenHash: tokenHash(invitation.token) },
                data: { acceptedAt: new Date() },
              });
            if (change === 'revoked')
              await tx.invitation.update({
                where: { tokenHash: tokenHash(invitation.token) },
                data: { revokedAt: new Date() },
              });
            if (change === 'expired')
              await tx.$executeRaw`UPDATE invitations SET expires_at = now() - interval '1 day' WHERE token_hash = ${tokenHash(invitation.token)}`;
            if (change === 'full')
              await tx.projectMember.update({ where: { id: clients[0].id }, data: { revokedAt: null } });
          },
          { maxWait: 5_000, timeout: 10_000 },
        );
      } finally {
        await request;
      }

      expect(await request).toMatchObject({ status });
      if (change === 'full') expect(await request).toMatchObject({ response: { code: 'PROJECT_FULL' } });
      const stored = await prisma.invitation.findUniqueOrThrow({ where: { tokenHash: tokenHash(invitation.token) } });
      expect(stored.acceptedAt).toEqual(change === 'accepted' ? expect.any(Date) : null);
      expect(await prisma.projectMember.count({ where: { projectId, userId: invited.id } })).toBe(0);
      expect(await prisma.activityEvent.count({ where: { type: 'INVITATION_ACCEPTED' } })).toBe(0);
    },
    20_000,
  );
});
