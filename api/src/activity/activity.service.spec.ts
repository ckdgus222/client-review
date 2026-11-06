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
        createdAt: expect.any(Date),
      },
    ]);
    await expect(service.listForMember(projectId, clientId)).resolves.toEqual([
      {
        id: events[0].id,
        type: 'VERSION_PUBLISHED',
        createdAt: events[0].createdAt,
        actorName: '개발자',
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
        createdAt: expect.any(Date),
      },
    ]);
    await expect(service.listForMember(projectId, clientId)).resolves.toEqual([
      {
        id: events[0].id,
        type: 'VERSION_PUBLISHED',
        createdAt: events[0].createdAt,
        actorName: '개발자',
        version: null,
      },
    ]);
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
    'listForMember는 %s에게 해당 프로젝트 사건만 최신순으로 정해진 다섯 칸을 돌려준다',
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
          version: { id: secondVersion.id, number: 2 },
        },
        {
          id: middle.id,
          type: 'VERSION_PUBLISHED',
          createdAt: middle.createdAt,
          actorName: '개발자',
          version: { id: firstVersion.id, number: 1 },
        },
        {
          id: oldest.id,
          type: 'VERSION_PUBLISHED',
          createdAt: oldest.createdAt,
          actorName: '개발자',
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
