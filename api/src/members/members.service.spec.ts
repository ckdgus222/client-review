import { createHash, randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { resetDatabase } from '../../test/reset-database.js';
import { ActivityService } from '../activity/activity.service.js';
import type { Invitation, ProjectMember, User } from '../generated/prisma/client.js';
import { InvitationsService } from '../invitations/invitations.service.js';
import { MailService } from '../mail/mail.service.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { MembersService } from './members.service.js';

describe('MembersService', () => {
  let module: TestingModule | undefined;
  let prisma: PrismaService;
  let service: MembersService;
  let projects: ProjectsService;
  let invitations: InvitationsService;
  let activity: ActivityService;
  let developer: User;
  let client: User;
  let outsider: User;
  let developerMember: ProjectMember;
  let clientMember: ProjectMember;
  let projectId: string;
  const missingId = '00000000-0000-4000-8000-000000000001';
  const mail = { sendInvitation: vi.fn<MailService['sendInvitation']>() };

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [
        MembersService,
        ProjectsService,
        InvitationsService,
        ActivityService,
        { provide: MailService, useValue: mail },
      ],
    }).compile();
    prisma = module.get(PrismaService);
    service = module.get(MembersService);
    projects = module.get(ProjectsService);
    invitations = module.get(InvitationsService);
    activity = module.get(ActivityService);
  });

  beforeEach(async () => {
    vi.stubEnv('APP_URL', 'https://review.example.com');
    mail.sendInvitation.mockReset();
    await resetDatabase(prisma);
    developer = await prisma.user.create({ data: { email: 'developer@example.com', name: '개발자' } });
    client = await prisma.user.create({ data: { email: 'client@example.com', name: '클라이언트' } });
    outsider = await prisma.user.create({ data: { email: 'outsider@example.com', name: '다른 사람' } });
    const project = await prisma.project.create({ data: { name: '쇼핑몰 리뉴얼' } });
    projectId = project.id;
    developerMember = await prisma.projectMember.create({
      data: { projectId, userId: developer.id, role: 'DEVELOPER', createdAt: new Date('2026-01-03T00:00:00Z') },
    });
    clientMember = await prisma.projectMember.create({
      data: { projectId, userId: client.id, role: 'CLIENT', createdAt: new Date('2026-01-01T00:00:00Z') },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await module?.close();
  });

  const addClient = (targetProjectId = projectId) =>
    prisma.projectMember.create({
      data: {
        projectId: targetProjectId,
        userId: outsider.id,
        role: 'CLIENT',
        createdAt: new Date('2026-01-02T00:00:00Z'),
      },
    });

  const addInvitation = async (
    data: Partial<Pick<Invitation, 'projectId' | 'email' | 'createdAt' | 'acceptedAt' | 'revokedAt'>> = {},
  ) => {
    const token = randomUUID();
    const [{ expiresAt }] = await prisma.$queryRaw<{ expiresAt: Date }[]>`
      SELECT now() + interval '7 days' AS "expiresAt"
    `;
    const row = await prisma.invitation.create({
      data: {
        projectId,
        email: client.email,
        invitedById: developer.id,
        tokenHash: createHash('sha256').update(token).digest('hex'),
        expiresAt,
        ...data,
      },
    });
    return { row, token };
  };

  const readState = async () => ({
    members: await prisma.projectMember.findMany({ orderBy: { id: 'asc' } }),
    invitations: await prisma.invitation.findMany({ orderBy: { id: 'asc' } }),
    projects: await prisma.project.findMany({ orderBy: { id: 'asc' } }),
    events: await prisma.activityEvent.findMany({ orderBy: { id: 'asc' } }),
  });

  it('list는 개발자를 먼저, 클라이언트를 처음 참여한 순서로 반환하며 정해진 다섯 칸만 보여 준다', async () => {
    const second = await addClient();
    // 삽입 순서와 참여 순서를 다르게 만들어 정렬이 빠져도 우연히 통과하지 않게 한다.
    await prisma.projectMember.update({
      where: { id: second.id },
      data: { createdAt: new Date('2025-12-31T00:00:00Z') },
    });
    const lastSeenAt = new Date('2026-02-01T12:00:00Z');
    await prisma.user.update({ where: { id: client.id }, data: { lastSeenAt } });
    const otherProject = await prisma.project.create({ data: { name: '다른 프로젝트' } });
    await addClient(otherProject.id);

    expect(await service.list(projectId, developer.id)).toEqual({
      members: [
        { id: developerMember.id, name: developer.name, email: developer.email, role: 'DEVELOPER', lastSeenAt: null },
        { id: second.id, name: outsider.name, email: outsider.email, role: 'CLIENT', lastSeenAt: null },
        { id: clientMember.id, name: client.name, email: client.email, role: 'CLIENT', lastSeenAt },
      ],
      invitations: [],
    });
  });

  it('list는 철회된 멤버를 빼고 새 초대로 되살아나면 처음 참여한 순서와 id를 유지한다', async () => {
    const second = await addClient();
    await service.setApprover(projectId, developer.id, clientMember.id);
    await service.revoke(clientMember.id, developer.id);
    expect((await service.list(projectId, developer.id)).members.map(({ id }) => id)).toEqual([
      developerMember.id,
      second.id,
    ]);
    const invitation = await invitations.create(projectId, developer.id, client.email);
    const token = new URL(invitation.link).pathname.split('/').at(-1)!;

    await invitations.accept(token, client);

    expect((await service.list(projectId, developer.id)).members.map(({ id }) => id)).toEqual([
      developerMember.id,
      clientMember.id,
      second.id,
    ]);
    expect(await prisma.projectMember.findUnique({ where: { id: clientMember.id } })).toEqual(clientMember);
    expect(await prisma.projectMember.count({ where: { projectId, userId: client.id } })).toBe(1);
    expect((await projects.getForMember(projectId, client.id)).approver).toBeNull();
  });

  it('list는 쓸 수 있는 초대만 만든 순서대로 email·expiresAt 두 칸으로 반환한다', async () => {
    const later = await addInvitation({ email: 'a-later@example.com', createdAt: new Date('2026-01-02T00:00:00Z') });
    const earlier = await addInvitation({
      email: 'z-earlier@example.com',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    await addInvitation({ email: 'accepted@example.com', acceptedAt: new Date() });
    await addInvitation({ email: 'revoked@example.com', revokedAt: new Date() });
    const expired = await addInvitation({ email: 'expired@example.com' });
    await prisma.$executeRaw`UPDATE invitations SET expires_at = now() - interval '1 second' WHERE id = ${expired.row.id}::uuid`;
    const otherProject = await prisma.project.create({ data: { name: '다른 프로젝트' } });
    await addInvitation({ projectId: otherProject.id });

    expect((await service.list(projectId, developer.id)).invitations).toEqual([
      { email: earlier.row.email, expiresAt: earlier.row.expiresAt },
      { email: later.row.email, expiresAt: later.row.expiresAt },
    ]);
  });

  it.each([
    { actor: 'client', status: 403 },
    { actor: 'outsider', status: 404 },
    { actor: 'revoked-client', status: 404 },
    { actor: 'revoked-developer', status: 404 },
    { actor: 'missing-project', status: 404 },
  ])('list는 $actor 요청을 $status로 거절한다', async ({ actor, status }) => {
    if (actor === 'revoked-client' || actor === 'revoked-developer') {
      const memberId = actor === 'revoked-client' ? clientMember.id : developerMember.id;
      await prisma.projectMember.update({ where: { id: memberId }, data: { revokedAt: new Date() } });
    }
    const userId = actor === 'outsider' ? outsider.id : actor.includes('client') ? client.id : developer.id;
    const targetProjectId = actor === 'missing-project' ? missingId : projectId;

    await expect(service.list(targetProjectId, userId)).rejects.toMatchObject({ status });
  });

  it.each([false, true])(
    'revoke는 만료 여부=%s인 쓰지 않은 초대를 무효로 하고 승인자를 비우며 일지를 남긴다',
    async (expired) => {
      const pending = await addInvitation();
      if (expired) {
        await prisma.$executeRaw`UPDATE invitations SET expires_at = now() - interval '1 second' WHERE id = ${pending.row.id}::uuid`;
      }
      const accepted = await addInvitation({ acceptedAt: new Date() });
      const revoked = await addInvitation({ revokedAt: new Date('2026-01-01T00:00:00Z') });
      const otherEmail = await addInvitation({ email: outsider.email });
      const otherProject = await prisma.project.create({ data: { name: '다른 프로젝트' } });
      const otherProjectInvitation = await addInvitation({ projectId: otherProject.id });
      const otherMember = await addClient(otherProject.id);
      await prisma.project.update({ where: { id: projectId }, data: { approverMemberId: clientMember.id } });
      const foreignProject = await prisma.project.update({
        where: { id: otherProject.id },
        data: { approverMemberId: otherMember.id },
      });
      const before = new Date();

      await expect(service.revoke(clientMember.id, developer.id)).resolves.toBeUndefined();

      const member = await prisma.projectMember.findUniqueOrThrow({ where: { id: clientMember.id } });
      expect(member).toEqual({ ...clientMember, revokedAt: expect.any(Date) });
      expect(member.revokedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(member.revokedAt!.getTime()).toBeLessThanOrEqual(Date.now());
      expect(await prisma.invitation.findUniqueOrThrow({ where: { id: pending.row.id } })).toMatchObject({
        acceptedAt: null,
        revokedAt: expect.any(Date),
      });
      for (const { row } of [accepted, revoked, otherEmail, otherProjectInvitation]) {
        expect(await prisma.invitation.findUnique({ where: { id: row.id } })).toEqual(row);
      }
      expect(await prisma.project.findUnique({ where: { id: otherProject.id } })).toEqual(foreignProject);
      expect(await prisma.projectMember.findUnique({ where: { id: otherMember.id } })).toEqual(otherMember);
      expect((await projects.getForMember(projectId, developer.id)).approver).toBeNull();
      expect(await prisma.activityEvent.findMany()).toEqual([
        {
          id: expect.any(String),
          projectId,
          actorId: developer.id,
          type: 'MEMBER_REVOKED',
          memberId: clientMember.id,
          versionId: null,
          createdAt: expect.any(Date),
        },
      ]);
      await expect(projects.requireMemberRole(projectId, client.id)).rejects.toMatchObject({ status: 404 });
      await expect(projects.getForMember(projectId, client.id)).rejects.toMatchObject({ status: 404 });
      expect(await projects.listMine(client.id)).toEqual([]);
      await expect(invitations.preview(pending.token)).rejects.toMatchObject({ status: 404 });
      await expect(invitations.accept(pending.token, client)).rejects.toMatchObject({ status: 404 });
    },
  );

  it.each([false, true])('revoke는 대상이 승인자가 아니면 기존 승인자 유무=%s를 그대로 둔다', async (hasApprover) => {
    const second = await addClient();
    const approverMemberId = hasApprover ? second.id : null;
    await prisma.project.update({ where: { id: projectId }, data: { approverMemberId } });

    await service.revoke(clientMember.id, developer.id);

    expect(await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).toMatchObject({ approverMemberId });
    expect(await prisma.projectMember.findUnique({ where: { id: second.id } })).toEqual(second);
    expect(await prisma.activityEvent.count({ where: { type: 'MEMBER_REVOKED', memberId: clientMember.id } })).toBe(1);
    expect(await prisma.activityEvent.count({ where: { type: 'APPROVER_CHANGED' } })).toBe(0);
  });

  it('revoke는 없는 id·남의 참여자·이미 철회된 참여자를 같은 404 본문으로 거절한다', async () => {
    const otherProject = await prisma.project.create({ data: { name: '남의 프로젝트' } });
    const foreignMember = await addClient(otherProject.id);
    await service.revoke(clientMember.id, developer.id);
    const before = await readState();

    for (const id of [missingId, foreignMember.id, clientMember.id]) {
      await expect(service.revoke(id, developer.id)).rejects.toMatchObject({
        status: 404,
        response: { statusCode: 404, message: '없는 참여자예요', error: 'Not Found' },
      });
    }

    expect(await readState()).toEqual(before);
  });

  it.each(['developer-target', 'client-actor', 'self-revoke'])(
    'revoke는 %s 요청을 403으로 거절하고 아무것도 바꾸지 않는다',
    async (scenario) => {
      const second = await addClient();
      await addInvitation();
      await prisma.project.update({ where: { id: projectId }, data: { approverMemberId: clientMember.id } });
      const actorId = scenario === 'developer-target' ? developer.id : client.id;
      const targetId =
        scenario === 'developer-target' ? developerMember.id : scenario === 'self-revoke' ? clientMember.id : second.id;
      const before = await readState();

      await expect(service.revoke(targetId, actorId)).rejects.toMatchObject({ status: 403 });

      expect(await readState()).toEqual(before);
    },
  );

  it.each(['outsider', 'revoked-client', 'revoked-developer'])(
    'revoke는 %s에게 참여자 존재를 숨기고 아무것도 바꾸지 않는다',
    async (actor) => {
      const second = await addClient();
      const actorId = actor === 'outsider' ? missingId : actor === 'revoked-client' ? client.id : developer.id;
      if (actor !== 'outsider') {
        const id = actor === 'revoked-client' ? clientMember.id : developerMember.id;
        await prisma.projectMember.update({ where: { id }, data: { revokedAt: new Date() } });
      }
      const before = await readState();

      await expect(service.revoke(second.id, actorId)).rejects.toMatchObject({
        status: 404,
        response: { message: '없는 참여자예요' },
      });

      expect(await readState()).toEqual(before);
    },
  );

  it('revoke는 일지를 저장한 뒤 실패해도 멤버·초대·승인자·일지를 모두 되돌린다', async () => {
    await addInvitation();
    await prisma.project.update({ where: { id: projectId }, data: { approverMemberId: clientMember.id } });
    const before = await readState();
    const record = activity.record.bind(activity);
    vi.spyOn(activity, 'record').mockImplementationOnce(async (tx, event) => {
      await record(tx, event);
      throw new Error('일지 저장 뒤 실패');
    });

    await expect(service.revoke(clientMember.id, developer.id)).rejects.toThrow('일지 저장 뒤 실패');

    expect(await readState()).toEqual(before);
    await expect(projects.requireMemberRole(projectId, client.id)).resolves.toBe('CLIENT');
  });

  it('setApprover는 활성 클라이언트를 지정·교체·해제하고 새 대상의 일지를 남긴다', async () => {
    const second = await addClient();
    for (const member of [clientMember, second, null]) {
      const memberId = member?.id ?? null;
      const name = member?.id === clientMember.id ? client.name : outsider.name;
      const expected = member ? { memberId, name } : null;

      expect(await service.setApprover(projectId, developer.id, memberId)).toEqual(expected);

      expect((await projects.getForMember(projectId, developer.id)).approver).toEqual(expected);
      expect((await projects.getForMember(projectId, client.id)).approver).toEqual(expected);
      expect(await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).toMatchObject({
        approverMemberId: memberId,
      });
      expect(await prisma.activityEvent.findMany({ where: { type: 'APPROVER_CHANGED', memberId } })).toEqual([
        {
          id: expect.any(String),
          projectId,
          actorId: developer.id,
          type: 'APPROVER_CHANGED',
          memberId,
          versionId: null,
          createdAt: expect.any(Date),
        },
      ]);
    }
    expect(await prisma.activityEvent.count()).toBe(3);
    expect(await prisma.projectMember.findUnique({ where: { id: clientMember.id } })).toEqual(clientMember);
    expect(await prisma.projectMember.findUnique({ where: { id: second.id } })).toEqual(second);
  });

  it.each([false, true])(
    'setApprover는 같은 값(승인자 있음=%s)을 저장하면 일지를 더 남기지 않는다',
    async (hasApprover) => {
      const memberId = hasApprover ? clientMember.id : null;
      if (hasApprover) await service.setApprover(projectId, developer.id, memberId);
      const before = await readState();

      expect(await service.setApprover(projectId, developer.id, memberId)).toEqual(
        hasApprover ? { memberId: clientMember.id, name: client.name } : null,
      );

      expect(await readState()).toEqual(before);
    },
  );

  it.each(['developer', 'revoked-client', 'foreign-client', 'missing-member'])(
    'setApprover는 %s를 422로 거절하고 기존 승인자와 일지를 보존한다',
    async (target) => {
      const second = await addClient();
      await service.setApprover(projectId, developer.id, second.id);
      let targetId = missingId;
      if (target === 'developer') targetId = developerMember.id;
      if (target === 'revoked-client') {
        await prisma.projectMember.update({ where: { id: clientMember.id }, data: { revokedAt: new Date() } });
        targetId = clientMember.id;
      }
      if (target === 'foreign-client') {
        const otherProject = await prisma.project.create({ data: { name: '다른 프로젝트' } });
        targetId = (await addClient(otherProject.id)).id;
      }
      const before = await readState();

      await expect(service.setApprover(projectId, developer.id, targetId)).rejects.toMatchObject({ status: 422 });

      expect(await readState()).toEqual(before);
    },
  );

  it.each([
    { actor: 'client', status: 403 },
    { actor: 'outsider', status: 404 },
    { actor: 'revoked-client', status: 404 },
    { actor: 'revoked-developer', status: 404 },
    { actor: 'missing-project', status: 404 },
  ])('setApprover는 $actor의 지정·해제를 $status로 거절한다', async ({ actor, status }) => {
    await service.setApprover(projectId, developer.id, clientMember.id);
    if (actor === 'revoked-client' || actor === 'revoked-developer') {
      const id = actor === 'revoked-client' ? clientMember.id : developerMember.id;
      await prisma.projectMember.update({ where: { id }, data: { revokedAt: new Date() } });
    }
    const userId = actor === 'outsider' ? outsider.id : actor.includes('client') ? client.id : developer.id;
    const targetProjectId = actor === 'missing-project' ? missingId : projectId;
    const before = await readState();

    await expect(service.setApprover(targetProjectId, userId, clientMember.id)).rejects.toMatchObject({ status });
    await expect(service.setApprover(targetProjectId, userId, null)).rejects.toMatchObject({ status });

    expect(await readState()).toEqual(before);
  });

  it.each([false, true])('setApprover는 일지 저장 뒤 실패하면 해제=%s 변경과 일지를 함께 되돌린다', async (clear) => {
    const second = await addClient();
    await service.setApprover(projectId, developer.id, clientMember.id);
    const before = await readState();
    const record = activity.record.bind(activity);
    vi.spyOn(activity, 'record').mockImplementationOnce(async (tx, event) => {
      await record(tx, event);
      throw new Error('일지 저장 뒤 실패');
    });

    await expect(service.setApprover(projectId, developer.id, clear ? null : second.id)).rejects.toThrow(
      '일지 저장 뒤 실패',
    );

    expect(await readState()).toEqual(before);
  });

  it('동시에 두 번 철회하면 하나만 성공하고 다른 요청은 404이며 일지는 한 번만 남는다', async () => {
    const results = await Promise.allSettled([
      service.revoke(clientMember.id, developer.id),
      service.revoke(clientMember.id, developer.id),
    ]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toEqual([{ status: 'fulfilled', value: undefined }]);
    expect(results.filter(({ status }) => status === 'rejected')).toEqual([
      { status: 'rejected', reason: expect.objectContaining({ status: 404 }) },
    ]);
    expect(await prisma.activityEvent.count({ where: { type: 'MEMBER_REVOKED', memberId: clientMember.id } })).toBe(1);
  });

  it('같은 승인자를 동시에 지정해도 변경 일지는 한 번만 남는다', async () => {
    const results = await Promise.all([
      service.setApprover(projectId, developer.id, clientMember.id),
      service.setApprover(projectId, developer.id, clientMember.id),
    ]);

    expect(results).toEqual([
      { memberId: clientMember.id, name: client.name },
      { memberId: clientMember.id, name: client.name },
    ]);
    expect(await prisma.activityEvent.count({ where: { type: 'APPROVER_CHANGED', memberId: clientMember.id } })).toBe(
      1,
    );
  });

  it.each(['revoke', 'setApprover'] as const)(
    '%s를 먼저 시작해도 철회와 승인자 지정이 동시에 끝나면 철회된 사람이 승인자로 남지 않는다',
    async (first) => {
      const results = await Promise.allSettled(
        first === 'revoke'
          ? [
              service.revoke(clientMember.id, developer.id),
              service.setApprover(projectId, developer.id, clientMember.id),
            ]
          : [
              service.setApprover(projectId, developer.id, clientMember.id),
              service.revoke(clientMember.id, developer.id),
            ],
      );
      const revocation = results[first === 'revoke' ? 0 : 1];
      const assignment = results[first === 'revoke' ? 1 : 0];

      expect(revocation).toEqual({ status: 'fulfilled', value: undefined });
      if (assignment.status === 'rejected') expect(assignment.reason).toMatchObject({ status: 422 });
      if (assignment.status === 'fulfilled')
        expect(assignment.value).toEqual({ memberId: clientMember.id, name: client.name });
      expect(await prisma.projectMember.findUniqueOrThrow({ where: { id: clientMember.id } })).toMatchObject({
        revokedAt: expect.any(Date),
      });
      expect((await projects.getForMember(projectId, developer.id)).approver).toBeNull();
      expect(await prisma.activityEvent.count({ where: { type: 'MEMBER_REVOKED', memberId: clientMember.id } })).toBe(
        1,
      );
      expect(await prisma.activityEvent.count({ where: { type: 'APPROVER_CHANGED', memberId: clientMember.id } })).toBe(
        assignment.status === 'fulfilled' ? 1 : 0,
      );
    },
  );

  it.each([
    { operation: 'revoke', status: 404 },
    { operation: 'setApprover', status: 422 },
  ])(
    '$operation는 프로젝트 잠금을 기다린 뒤 철회 상태를 다시 확인한다',
    async ({ operation, status }) => {
      let request: Promise<unknown> | undefined;
      let settled = false;
      try {
        await prisma.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT id FROM projects WHERE id = ${projectId}::uuid FOR UPDATE`;
            request = (
              operation === 'revoke'
                ? service.revoke(clientMember.id, developer.id)
                : service.setApprover(projectId, developer.id, clientMember.id)
            )
              .catch((error: unknown) => error)
              .finally(() => {
                settled = true;
              });
            await new Promise<void>((resolve) => {
              setTimeout(resolve, 200);
            });
            expect(settled).toBe(false);
            await tx.projectMember.update({ where: { id: clientMember.id }, data: { revokedAt: new Date() } });
          },
          { maxWait: 5_000, timeout: 10_000 },
        );
      } finally {
        await request;
      }

      expect(await request).toMatchObject({ status });
      expect((await projects.getForMember(projectId, developer.id)).approver).toBeNull();
      expect(await prisma.activityEvent.count()).toBe(0);
    },
    20_000,
  );
});
