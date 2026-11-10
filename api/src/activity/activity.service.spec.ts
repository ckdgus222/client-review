import { NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { resetDatabase } from '../../test/reset-database.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { ActivityService } from './activity.service.js';

describe('ActivityService', () => {
  let module: TestingModule | undefined;
  let prisma: PrismaService;
  let service: ActivityService;
  let developerId: string;
  let clientId: string;
  let outsiderId: string;
  let projectId: string;
  let otherProjectId: string;
  const missingId = '00000000-0000-4000-8000-000000000001';
  const publishedAt = new Date('2026-01-01T00:00:00Z');

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [ActivityService, ProjectsService],
    }).compile();
    prisma = module.get(PrismaService);
    service = module.get(ActivityService);
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    const developer = await prisma.user.create({
      data: { email: 'developer@example.com', name: '개발자' },
    });
    const client = await prisma.user.create({
      data: { email: 'client@example.com', name: '클라이언트' },
    });
    const outsider = await prisma.user.create({
      data: { email: 'outsider@example.com', name: '다른 개발자' },
    });
    developerId = developer.id;
    clientId = client.id;
    outsiderId = outsider.id;
    const project = await prisma.project.create({
      data: {
        name: '함께 보는 프로젝트',
        members: {
          create: [
            { userId: developerId, role: 'DEVELOPER' },
            { userId: clientId, role: 'CLIENT' },
          ],
        },
      },
    });
    const otherProject = await prisma.project.create({
      data: {
        name: '다른 프로젝트',
        members: {
          create: [
            { userId: outsiderId, role: 'DEVELOPER' },
            { userId: developerId, role: 'CLIENT' },
          ],
        },
      },
    });
    projectId = project.id;
    otherProjectId = otherProject.id;
  });

  afterAll(async () => {
    await module?.close();
  });

  it('record는 같은 트랜잭션에서 만든 버전을 가리키는 사건 한 줄을 커밋한다', async () => {
    const version = await prisma.$transaction(async (tx) => {
      const created = await tx.deliveryVersion.create({
        data: { projectId, number: 1, status: 'IN_REVIEW', publishedAt },
      });

      await service.record(tx, { projectId, actorId: developerId, type: 'VERSION_PUBLISHED', versionId: created.id });

      return created;
    });

    const events = await prisma.activityEvent.findMany();
    expect(events).toEqual([
      {
        id: expect.any(String),
        projectId,
        actorId: developerId,
        type: 'VERSION_PUBLISHED',
        versionId: version.id,
        memberId: null,
        issueId: null,
        createdAt: expect.any(Date),
      },
    ]);
    await expect(service.listForMember(projectId, clientId)).resolves.toEqual([
      {
        id: events[0].id,
        type: 'VERSION_PUBLISHED',
        createdAt: events[0].createdAt,
        actorName: '개발자',
        memberName: null,
        version: { id: version.id, number: 1 },
      },
    ]);
  });

  it('record 뒤에 오류가 나면 트랜잭션 안에서 보이던 사건도 되돌려진다', async () => {
    const version = await prisma.deliveryVersion.create({
      data: { projectId, number: 1, status: 'IN_REVIEW', publishedAt },
    });
    const failure = new Error('일지 작성 뒤 작업 실패');

    const request = prisma.$transaction(async (tx) => {
      await service.record(tx, { projectId, actorId: developerId, type: 'VERSION_PUBLISHED', versionId: version.id });

      expect(await tx.activityEvent.count({ where: { projectId } })).toBe(1);
      throw failure;
    });

    await expect(request).rejects.toBe(failure);
    expect(await prisma.activityEvent.count()).toBe(0);
    await expect(service.listForMember(projectId, developerId)).resolves.toEqual([]);
  });

  it('record에 versionId가 없으면 DB와 조회 결과에서 버전은 null이다', async () => {
    await prisma.$transaction(async (tx) => {
      await service.record(tx, { projectId, actorId: developerId, type: 'VERSION_PUBLISHED' });
    });

    const events = await prisma.activityEvent.findMany();
    expect(events).toEqual([
      {
        id: expect.any(String),
        projectId,
        actorId: developerId,
        type: 'VERSION_PUBLISHED',
        versionId: null,
        memberId: null,
        issueId: null,
        createdAt: expect.any(Date),
      },
    ]);
    await expect(service.listForMember(projectId, clientId)).resolves.toEqual([
      {
        id: events[0].id,
        type: 'VERSION_PUBLISHED',
        createdAt: events[0].createdAt,
        actorName: '개발자',
        memberName: null,
        version: null,
      },
    ]);
  });

  it.each([
    { type: 'INVITATION_CREATED', hasMember: false },
    { type: 'INVITATION_ACCEPTED', hasMember: true },
    { type: 'MEMBER_REVOKED', hasMember: true },
    { type: 'APPROVER_CHANGED', hasMember: true },
  ] as const)('record는 $type 사건의 대상 멤버를 저장하고 그 사용자 이름을 돌려준다', async ({ type, hasMember }) => {
    const member = await prisma.projectMember.findUniqueOrThrow({
      where: { projectId_userId: { projectId, userId: clientId } },
    });
    const memberId = hasMember ? member.id : undefined;

    await prisma.$transaction(async (tx) => {
      await service.record(tx, { projectId, actorId: developerId, type, memberId });
    });

    const events = await prisma.activityEvent.findMany();
    expect(events).toEqual([
      {
        id: expect.any(String),
        projectId,
        actorId: developerId,
        type,
        versionId: null,
        memberId: memberId ?? null,
        issueId: null,
        createdAt: expect.any(Date),
      },
    ]);
    await expect(service.listForMember(projectId, developerId)).resolves.toEqual([
      {
        id: events[0].id,
        type,
        createdAt: events[0].createdAt,
        actorName: '개발자',
        memberName: hasMember ? '클라이언트' : null,
        version: null,
      },
    ]);
    await expect(service.listForMember(projectId, outsiderId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.listForMember(otherProjectId, developerId)).resolves.toEqual([]);
  });

  it('승인자를 비운 사건은 memberId 없이 저장되고 memberName은 null이다', async () => {
    await prisma.$transaction(async (tx) => {
      await service.record(tx, { projectId, actorId: developerId, type: 'APPROVER_CHANGED' });
    });

    const event = await prisma.activityEvent.findFirstOrThrow({ where: { projectId } });
    expect(event.memberId).toBeNull();
    await expect(service.listForMember(projectId, clientId)).resolves.toEqual([
      {
        id: event.id,
        type: 'APPROVER_CHANGED',
        createdAt: event.createdAt,
        actorName: '개발자',
        memberName: null,
        version: null,
      },
    ]);
  });

  it.each(['기록 전', '기록 후'] as const)('대상 멤버를 %s에 철회해도 사건과 대상 이름이 보인다', async (timing) => {
    const member = await prisma.projectMember.findUniqueOrThrow({
      where: { projectId_userId: { projectId, userId: clientId } },
    });
    if (timing === '기록 전') {
      await prisma.projectMember.update({ where: { id: member.id }, data: { revokedAt: new Date() } });
    }

    await prisma.$transaction(async (tx) => {
      await service.record(tx, {
        projectId,
        actorId: developerId,
        type: 'MEMBER_REVOKED',
        memberId: member.id,
      });
    });
    if (timing === '기록 후') {
      await prisma.projectMember.update({ where: { id: member.id }, data: { revokedAt: new Date() } });
    }

    const event = await prisma.activityEvent.findFirstOrThrow({ where: { projectId } });
    expect(event.memberId).toBe(member.id);
    await expect(service.listForMember(projectId, developerId)).resolves.toEqual([
      {
        id: event.id,
        type: 'MEMBER_REVOKED',
        createdAt: event.createdAt,
        actorName: '개발자',
        memberName: '클라이언트',
        version: null,
      },
    ]);
  });

  it('같은 트랜잭션에서 멤버와 사건을 만든 뒤 실패하면 둘 다 남지 않는다', async () => {
    const failure = new Error('멤버 사건 기록 뒤 작업 실패');
    const request = prisma.$transaction(async (tx) => {
      const member = await tx.projectMember.create({
        data: { projectId, userId: outsiderId, role: 'CLIENT' },
      });
      await service.record(tx, {
        projectId,
        actorId: outsiderId,
        type: 'INVITATION_ACCEPTED',
        memberId: member.id,
      });

      expect(await tx.activityEvent.count({ where: { projectId, memberId: member.id } })).toBe(1);
      throw failure;
    });

    await expect(request).rejects.toBe(failure);
    expect(
      await prisma.projectMember.findUnique({
        where: { projectId_userId: { projectId, userId: outsiderId } },
      }),
    ).toBeNull();
    expect(await prisma.activityEvent.count()).toBe(0);
    await expect(service.listForMember(projectId, developerId)).resolves.toEqual([]);
  });

  it('없는 memberId는 외래키 오류를 전달하고 같은 트랜잭션의 앞선 사건도 되돌린다', async () => {
    const request = prisma.$transaction(async (tx) => {
      await service.record(tx, { projectId, actorId: developerId, type: 'INVITATION_CREATED' });
      await service.record(tx, {
        projectId,
        actorId: developerId,
        type: 'APPROVER_CHANGED',
        memberId: missingId,
      });
    });

    await expect(request).rejects.toMatchObject({ code: 'P2003' });
    expect(await prisma.activityEvent.count()).toBe(0);
    await expect(service.listForMember(projectId, developerId)).resolves.toEqual([]);
  });

  it('record로 새 사건을 쓰면 이전 사건을 바꾸거나 지우지 않고 한 줄을 더한다', async () => {
    const firstVersion = await prisma.deliveryVersion.create({
      data: { projectId, number: 1, status: 'IN_REVIEW', publishedAt },
    });
    const secondVersion = await prisma.deliveryVersion.create({
      data: { projectId, number: 2, status: 'IN_REVIEW', publishedAt },
    });
    const previous = await prisma.activityEvent.create({
      data: { projectId, actorId: developerId, type: 'VERSION_PUBLISHED', versionId: firstVersion.id },
    });

    await prisma.$transaction(async (tx) => {
      await service.record(tx, {
        projectId,
        actorId: developerId,
        type: 'VERSION_PUBLISHED',
        versionId: secondVersion.id,
      });
    });

    expect(await prisma.activityEvent.count()).toBe(2);
    expect(await prisma.activityEvent.findUnique({ where: { id: previous.id } })).toEqual(previous);
    expect(await prisma.activityEvent.findMany({ where: { versionId: secondVersion.id } })).toEqual([
      {
        id: expect.any(String),
        projectId,
        actorId: developerId,
        type: 'VERSION_PUBLISHED',
        versionId: secondVersion.id,
        memberId: null,
        issueId: null,
        createdAt: expect.any(Date),
      },
    ]);
  });

  it('record의 DB 저장이 실패하면 오류가 전달되고 같은 트랜잭션의 버전도 남지 않는다', async () => {
    const request = prisma.$transaction(async (tx) => {
      const version = await tx.deliveryVersion.create({
        data: { projectId, number: 1, status: 'IN_REVIEW', publishedAt },
      });

      await service.record(tx, { projectId, actorId: missingId, type: 'VERSION_PUBLISHED', versionId: version.id });
    });

    await expect(request).rejects.toMatchObject({ code: 'P2003' });
    expect(await prisma.activityEvent.count()).toBe(0);
    expect(await prisma.deliveryVersion.count()).toBe(0);
  });

  it.each(['DEVELOPER', 'CLIENT'] as const)(
    'listForMember는 %s에게 해당 프로젝트 사건만 최신순으로 정해진 여섯 칸을 돌려준다',
    async (role) => {
      const firstVersion = await prisma.deliveryVersion.create({
        data: { projectId, number: 1, status: 'IN_REVIEW', publishedAt },
      });
      const secondVersion = await prisma.deliveryVersion.create({
        data: { projectId, number: 2, status: 'IN_REVIEW', publishedAt },
      });
      // 저장 순서를 시각순과 다르게 두어 createdAt으로 정렬하는지 확인한다.
      const middle = await prisma.activityEvent.create({
        data: {
          projectId,
          actorId: developerId,
          type: 'VERSION_PUBLISHED',
          versionId: firstVersion.id,
          createdAt: new Date('2026-01-02T00:00:00Z'),
        },
      });
      const latest = await prisma.activityEvent.create({
        data: {
          projectId,
          actorId: developerId,
          type: 'VERSION_PUBLISHED',
          versionId: secondVersion.id,
          createdAt: new Date('2026-01-03T00:00:00Z'),
        },
      });
      const oldest = await prisma.activityEvent.create({
        data: {
          projectId,
          actorId: developerId,
          type: 'VERSION_PUBLISHED',
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
      });
      await prisma.activityEvent.create({
        data: {
          projectId: otherProjectId,
          actorId: outsiderId,
          type: 'VERSION_PUBLISHED',
          createdAt: new Date('2026-01-04T00:00:00Z'),
        },
      });
      const userId = role === 'DEVELOPER' ? developerId : clientId;

      await expect(service.listForMember(projectId, userId)).resolves.toEqual([
        {
          id: latest.id,
          type: 'VERSION_PUBLISHED',
          createdAt: latest.createdAt,
          actorName: '개발자',
          memberName: null,
          version: { id: secondVersion.id, number: 2 },
        },
        {
          id: middle.id,
          type: 'VERSION_PUBLISHED',
          createdAt: middle.createdAt,
          actorName: '개발자',
          memberName: null,
          version: { id: firstVersion.id, number: 1 },
        },
        {
          id: oldest.id,
          type: 'VERSION_PUBLISHED',
          createdAt: oldest.createdAt,
          actorName: '개발자',
          memberName: null,
          version: null,
        },
      ]);
    },
  );

  it('listForMember의 actorName은 조회한 사람이나 다른 프로젝트 개발자가 아닌 사건을 일으킨 사람 이름이다', async () => {
    const event = await prisma.activityEvent.create({
      data: { projectId: otherProjectId, actorId: outsiderId, type: 'VERSION_PUBLISHED' },
    });

    await expect(service.listForMember(otherProjectId, developerId)).resolves.toEqual([
      {
        id: event.id,
        type: 'VERSION_PUBLISHED',
        createdAt: event.createdAt,
        actorName: '다른 개발자',
        memberName: null,
        version: null,
      },
    ]);
  });

  it.each(['DEVELOPER', 'CLIENT'] as const)(
    'listForMember는 다른 프로젝트에 사건이 있어도 이 프로젝트가 비었으면 %s에게 빈 배열을 돌려준다',
    async (role) => {
      await prisma.activityEvent.create({
        data: { projectId: otherProjectId, actorId: outsiderId, type: 'VERSION_PUBLISHED' },
      });
      const userId = role === 'DEVELOPER' ? developerId : clientId;

      await expect(service.listForMember(projectId, userId)).resolves.toEqual([]);
    },
  );

  it.each([false, true])(
    'listForMember는 사건 유무(%s)와 관계없이 비멤버와 없는 프로젝트에 같은 404를 돌려준다',
    async (hasEvent) => {
      if (hasEvent) {
        await prisma.activityEvent.create({
          data: { projectId, actorId: developerId, type: 'VERSION_PUBLISHED' },
        });
      }

      const outsiderError = await service.listForMember(projectId, outsiderId).catch((error: unknown) => error);
      const missingError = await service.listForMember(missingId, outsiderId).catch((error: unknown) => error);

      expect(outsiderError).toBeInstanceOf(NotFoundException);
      expect(missingError).toBeInstanceOf(NotFoundException);
      if (!(outsiderError instanceof NotFoundException)) throw new Error('남의 프로젝트는 404 오류가 필요해요');
      if (!(missingError instanceof NotFoundException)) throw new Error('없는 프로젝트는 404 오류가 필요해요');
      expect(outsiderError.getStatus()).toBe(404);
      expect(missingError.getStatus()).toBe(404);
      expect(outsiderError.getResponse()).toStrictEqual(missingError.getResponse());
      expect(outsiderError.getResponse()).toStrictEqual({
        statusCode: 404,
        message: '없는 프로젝트예요',
        error: 'Not Found',
      });
    },
  );
});
