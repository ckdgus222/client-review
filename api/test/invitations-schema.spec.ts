import type { Prisma } from '../src/generated/prisma/client.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { resetDatabase } from './reset-database.js';

describe('초대와 참여자 테이블', () => {
  const prisma = new PrismaService();
  const missingId = '00000000-0000-4000-8000-000000000001';
  const expiresAt = new Date('2030-01-01T00:00:00.000Z');
  const changedAt = new Date('2026-11-09T00:00:00.000Z');
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  let invitationData: Prisma.InvitationUncheckedCreateInput;

  const createMember = (projectId = invitationData.projectId) =>
    prisma.projectMember.create({
      data: {
        project: { connect: { id: projectId } },
        role: 'CLIENT',
        user: { create: { email: `client-${projectId}@example.com`, name: '클라이언트' } },
      },
    });

  beforeEach(async () => {
    await resetDatabase(prisma);
    const project = await prisma.project.create({ data: { name: '프로젝트' } });
    const inviter = await prisma.user.create({
      data: { email: 'inviter@example.com', name: '초대한 사람' },
    });
    invitationData = {
      projectId: project.id,
      email: 'invited@example.com',
      tokenHash: 'first-token-hash',
      invitedById: inviter.id,
      expiresAt,
    };
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('초대의 UUID와 생성 시각은 DB가 만들고 수락·무효 시각은 비어 있다', async () => {
    const { projectId, email, tokenHash, invitedById } = invitationData;
    const [row] = await prisma.$queryRaw<{ id: string; created_at_is_now: boolean }[]>`
      INSERT INTO invitations (project_id, email, token_hash, invited_by_id, expires_at)
      VALUES (${projectId}::uuid, ${email}, ${tokenHash}, ${invitedById}::uuid, ${expiresAt})
      RETURNING id, created_at = now() AS created_at_is_now
    `;

    expect(row.id).toMatch(uuidPattern);
    expect(row.created_at_is_now).toBe(true);
    expect(await prisma.invitation.findUniqueOrThrow({ where: { id: row.id } })).toEqual({
      ...invitationData,
      id: row.id,
      acceptedAt: null,
      revokedAt: null,
      createdAt: expect.any(Date),
    });
  });

  it('같은 프로젝트와 이메일에 쓰지 않은 초대를 두 개 만들 수 없다', async () => {
    const first = await prisma.invitation.create({ data: invitationData });

    await expect(
      prisma.invitation.create({ data: { ...invitationData, tokenHash: 'second-token-hash' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(await prisma.invitation.findMany()).toEqual([first]);
  });

  it('만료되어도 수락·무효 시각이 없으면 같은 프로젝트와 이메일의 새 초대를 막는다', async () => {
    const first = await prisma.invitation.create({ data: invitationData });
    await prisma.$executeRaw`
      UPDATE invitations SET expires_at = now() - interval '1 second' WHERE id = ${first.id}::uuid
    `;

    await expect(
      prisma.invitation.create({ data: { ...invitationData, tokenHash: 'second-token-hash' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(await prisma.invitation.count()).toBe(1);
  });

  it('동시에 같은 프로젝트와 이메일의 초대를 만들면 한 개만 저장된다', async () => {
    const results = await Promise.allSettled(
      ['first-token-hash', 'second-token-hash'].map((tokenHash) =>
        prisma.invitation.create({ data: { ...invitationData, tokenHash } }),
      ),
    );

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: 'P2002' }) }),
    ]);
    expect(await prisma.invitation.findMany()).toEqual([
      expect.objectContaining({ projectId: invitationData.projectId, email: invitationData.email }),
    ]);
  });

  it.each(['acceptedAt', 'revokedAt'] as const)(
    '%s이 있는 초대는 같은 프로젝트와 이메일로 여러 개 저장하고 새 대기 초대도 만들 수 있다',
    async (field) => {
      await prisma.invitation.createMany({
        data: ['first-token-hash', 'second-token-hash'].map((tokenHash) => ({
          ...invitationData,
          tokenHash,
          [field]: changedAt,
        })),
      });
      const pending = await prisma.invitation.create({
        data: { ...invitationData, tokenHash: 'pending-token-hash' },
      });

      expect(await prisma.invitation.count({ where: { [field]: changedAt } })).toBe(2);
      expect(await prisma.invitation.findMany({ where: { acceptedAt: null, revokedAt: null } })).toEqual([pending]);
      expect(await prisma.invitation.count()).toBe(3);
    },
  );

  it.each(['acceptedAt', 'revokedAt'] as const)(
    '대기 초대에 %s을 적으면 같은 프로젝트와 이메일로 다시 초대할 수 있다',
    async (field) => {
      const first = await prisma.invitation.create({ data: invitationData });
      const changed = await prisma.invitation.update({ where: { id: first.id }, data: { [field]: changedAt } });
      const pending = await prisma.invitation.create({
        data: { ...invitationData, tokenHash: 'second-token-hash' },
      });

      await expect(
        prisma.invitation.update({ where: { id: first.id }, data: { [field]: null } }),
      ).rejects.toMatchObject({ code: 'P2002' });
      expect(await prisma.invitation.findUnique({ where: { id: first.id } })).toEqual(changed);
      expect(await prisma.invitation.findMany({ where: { acceptedAt: null, revokedAt: null } })).toEqual([pending]);
    },
  );

  it('다른 프로젝트에는 같은 이메일의 대기 초대를 만들 수 있다', async () => {
    const otherProject = await prisma.project.create({ data: { name: '다른 프로젝트' } });
    await prisma.invitation.create({ data: invitationData });
    await prisma.invitation.create({
      data: { ...invitationData, projectId: otherProject.id, tokenHash: 'second-token-hash' },
    });

    expect(await prisma.invitation.count({ where: { email: invitationData.email } })).toBe(2);
  });

  it('같은 프로젝트라도 이메일이 다르면 대기 초대를 만들 수 있다', async () => {
    await prisma.invitation.create({ data: invitationData });
    await prisma.invitation.create({
      data: { ...invitationData, email: 'other@example.com', tokenHash: 'second-token-hash' },
    });

    expect(await prisma.invitation.count({ where: { projectId: invitationData.projectId } })).toBe(2);
  });

  it.each([
    { acceptedAt: null, revokedAt: null },
    { acceptedAt: changedAt, revokedAt: null },
    { acceptedAt: null, revokedAt: changedAt },
  ])('초대 상태가 $acceptedAt/$revokedAt이어도 token_hash는 다른 프로젝트에서 재사용할 수 없다', async (state) => {
    const first = await prisma.invitation.create({ data: { ...invitationData, ...state } });
    const otherProject = await prisma.project.create({ data: { name: '다른 프로젝트' } });

    await expect(
      prisma.invitation.create({
        data: { ...invitationData, projectId: otherProject.id, email: 'other@example.com' },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(await prisma.invitation.findMany()).toEqual([first]);
  });

  it('DB는 수락 시각과 무효 시각이 함께 있는 새 초대를 거부한다', async () => {
    const { projectId, email, tokenHash, invitedById } = invitationData;

    await expect(prisma.$executeRaw`
      INSERT INTO invitations (project_id, email, token_hash, invited_by_id, expires_at, accepted_at, revoked_at)
      VALUES (${projectId}::uuid, ${email}, ${tokenHash}, ${invitedById}::uuid, ${expiresAt}, ${changedAt}, ${changedAt})
    `).rejects.toMatchObject({ code: 'P2010', message: expect.stringContaining('23514') });
    expect(await prisma.invitation.count()).toBe(0);
  });

  it.each(['acceptedAt', 'revokedAt'] as const)(
    'DB는 %s이 있는 초대를 수락과 무효가 함께 있는 상태로 바꾸지 못하게 한다',
    async (field) => {
      const first = await prisma.invitation.create({ data: { ...invitationData, [field]: changedAt } });

      await expect(prisma.$executeRaw`
        UPDATE invitations SET accepted_at = ${changedAt}, revoked_at = ${changedAt} WHERE id = ${first.id}::uuid
      `).rejects.toMatchObject({ code: 'P2010', message: expect.stringContaining('23514') });
      expect(await prisma.invitation.findMany()).toEqual([first]);
    },
  );

  it.each(['projectId', 'invitedById'] as const)('없는 %s을 가리키는 초대를 만들 수 없다', async (field) => {
    await expect(prisma.invitation.create({ data: { ...invitationData, [field]: missingId } })).rejects.toMatchObject({
      code: 'P2003',
    });
    expect(await prisma.invitation.count()).toBe(0);
  });

  it('초대가 가리키는 초대한 사용자는 지울 수 없다', async () => {
    const invitation = await prisma.invitation.create({ data: invitationData });

    await expect(prisma.user.delete({ where: { id: invitationData.invitedById } })).rejects.toMatchObject({
      code: 'P2003',
    });
    expect(await prisma.invitation.findMany()).toEqual([invitation]);
    expect(await prisma.user.count()).toBe(1);
  });

  it('같은 프로젝트의 멤버를 승인자로 지정하고 다시 비울 수 있다', async () => {
    const member = await createMember();
    await prisma.project.update({ where: { id: member.projectId }, data: { approverMemberId: member.id } });

    expect(
      await prisma.project.findUniqueOrThrow({ where: { id: member.projectId }, include: { approver: true } }),
    ).toMatchObject({ approverMemberId: member.id, approver: member });

    await prisma.project.update({ where: { id: member.projectId }, data: { approverMemberId: null } });

    expect(
      await prisma.project.findUniqueOrThrow({ where: { id: member.projectId }, include: { approver: true } }),
    ).toMatchObject({ approverMemberId: null, approver: null });
    expect(await prisma.projectMember.findMany()).toEqual([member]);
  });

  it('다른 프로젝트의 멤버를 승인자로 넣으면 기존 승인자를 보존하고 거부한다', async () => {
    const member = await createMember();
    const otherProject = await prisma.project.create({ data: { name: '다른 프로젝트' } });
    const otherMember = await createMember(otherProject.id);
    const project = await prisma.project.update({
      where: { id: member.projectId },
      data: { approverMemberId: member.id },
    });

    await expect(
      prisma.project.update({ where: { id: project.id }, data: { approverMemberId: otherMember.id } }),
    ).rejects.toMatchObject({ code: 'P2003' });
    expect(await prisma.project.findUnique({ where: { id: project.id } })).toEqual(project);
  });

  it('없는 멤버를 승인자로 지정할 수 없다', async () => {
    await expect(
      prisma.project.update({ where: { id: invitationData.projectId }, data: { approverMemberId: missingId } }),
    ).rejects.toMatchObject({ code: 'P2003' });
    expect(await prisma.project.findUniqueOrThrow({ where: { id: invitationData.projectId } })).toMatchObject({
      approverMemberId: null,
    });
  });

  it('승인자가 가리키는 멤버만 따로 지울 수 없다', async () => {
    const member = await createMember();
    const project = await prisma.project.update({
      where: { id: member.projectId },
      data: { approverMemberId: member.id },
    });

    await expect(prisma.projectMember.delete({ where: { id: member.id } })).rejects.toMatchObject({ code: 'P2003' });
    expect(await prisma.projectMember.findMany()).toEqual([member]);
    expect(await prisma.project.findUnique({ where: { id: project.id } })).toEqual(project);
  });

  it('철회된 멤버도 같은 프로젝트와 사용자의 중복을 막고 기존 줄을 되살릴 수 있다', async () => {
    const member = await createMember();
    const revoked = await prisma.projectMember.update({ where: { id: member.id }, data: { revokedAt: changedAt } });

    await expect(
      prisma.projectMember.create({ data: { projectId: member.projectId, userId: member.userId, role: 'CLIENT' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(await prisma.projectMember.findMany()).toEqual([revoked]);

    await prisma.projectMember.update({ where: { id: member.id }, data: { revokedAt: null } });

    expect(await prisma.projectMember.findMany()).toEqual([member]);
    expect(await prisma.project.findUniqueOrThrow({ where: { id: member.projectId } })).toMatchObject({
      approverMemberId: null,
    });
  });

  it.each(['INVITATION_CREATED', 'INVITATION_ACCEPTED', 'MEMBER_REVOKED', 'APPROVER_CHANGED'] as const)(
    '새 사건 종류 %s을 DB에 저장할 수 있다',
    async (type) => {
      const event = await prisma.activityEvent.create({
        data: { projectId: invitationData.projectId, actorId: invitationData.invitedById, type },
      });

      expect(await prisma.activityEvent.findMany()).toEqual([
        {
          id: event.id,
          projectId: invitationData.projectId,
          actorId: invitationData.invitedById,
          type,
          versionId: null,
          memberId: null,
          createdAt: expect.any(Date),
        },
      ]);
    },
  );

  it('없는 멤버를 가리키는 일지를 만들 수 없다', async () => {
    await expect(
      prisma.activityEvent.create({
        data: {
          projectId: invitationData.projectId,
          actorId: invitationData.invitedById,
          type: 'MEMBER_REVOKED',
          memberId: missingId,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
    expect(await prisma.activityEvent.count()).toBe(0);
  });

  it('일지가 가리키는 멤버만 따로 지울 수 없다', async () => {
    const member = await createMember();
    const event = await prisma.activityEvent.create({
      data: {
        projectId: member.projectId,
        actorId: invitationData.invitedById,
        type: 'MEMBER_REVOKED',
        memberId: member.id,
      },
    });

    await expect(prisma.projectMember.delete({ where: { id: member.id } })).rejects.toMatchObject({ code: 'P2003' });
    expect(await prisma.projectMember.findMany()).toEqual([member]);
    expect(await prisma.activityEvent.findMany()).toEqual([event]);
  });

  it('프로젝트를 지우면 승인자 연결·멤버·초대·멤버 일지가 함께 지워지고 다른 프로젝트와 사용자는 남는다', async () => {
    const otherProject = await prisma.project.create({ data: { name: '남길 프로젝트' } });
    for (const projectId of [invitationData.projectId, otherProject.id]) {
      const member = await createMember(projectId);
      await prisma.project.update({ where: { id: projectId }, data: { approverMemberId: member.id } });
      await prisma.invitation.create({ data: { ...invitationData, projectId, tokenHash: `hash-${projectId}` } });
      await prisma.activityEvent.create({
        data: { projectId, actorId: invitationData.invitedById, type: 'APPROVER_CHANGED', memberId: member.id },
      });
    }
    const remaining = await prisma.project.findUniqueOrThrow({
      where: { id: otherProject.id },
      include: { approver: true, members: true, invitations: true, activities: true },
    });
    const users = await prisma.user.findMany({ orderBy: { id: 'asc' } });

    await prisma.project.delete({ where: { id: invitationData.projectId } });

    expect(
      await prisma.project.findMany({
        include: { approver: true, members: true, invitations: true, activities: true },
      }),
    ).toEqual([remaining]);
    expect(await prisma.projectMember.findMany()).toEqual(remaining.members);
    expect(await prisma.invitation.findMany()).toEqual(remaining.invitations);
    expect(await prisma.activityEvent.findMany()).toEqual(remaining.activities);
    expect(await prisma.user.findMany({ orderBy: { id: 'asc' } })).toEqual(users);
  });

  it('사용자의 마지막 접속 시각은 저장되고 세션을 지워도 남는다', async () => {
    const user = await prisma.user.update({
      where: { id: invitationData.invitedById },
      data: { lastSeenAt: changedAt },
    });
    const session = await prisma.session.create({ data: { userId: user.id, tokenHash: 'session-hash', expiresAt } });

    await prisma.session.delete({ where: { id: session.id } });

    expect(await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({ lastSeenAt: changedAt });
    expect(await prisma.session.count()).toBe(0);
  });

  it('resetDatabase는 초대와 승인자·멤버 일지 연결도 비우며 빈 DB에서 다시 실행할 수 있다', async () => {
    const member = await createMember();
    await prisma.project.update({ where: { id: member.projectId }, data: { approverMemberId: member.id } });
    await prisma.invitation.create({ data: invitationData });
    await prisma.activityEvent.create({
      data: {
        projectId: member.projectId,
        actorId: invitationData.invitedById,
        type: 'APPROVER_CHANGED',
        memberId: member.id,
      },
    });

    await resetDatabase(prisma);

    expect(await prisma.invitation.count()).toBe(0);
    expect(await prisma.project.count()).toBe(0);
    expect(await prisma.projectMember.count()).toBe(0);
    expect(await prisma.activityEvent.count()).toBe(0);
    expect(await prisma.user.count()).toBe(0);
    await expect(resetDatabase(prisma)).resolves.toBeUndefined();
  });
});
