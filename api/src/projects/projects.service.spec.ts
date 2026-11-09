import { NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { resetDatabase } from '../../test/reset-database.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProjectsService } from './projects.service.js';

describe('ProjectsService', () => {
  let module: TestingModule | undefined;
  let prisma: PrismaService;
  let service: ProjectsService;
  let userId: string;
  let otherUserId: string;
  const missingId = '00000000-0000-4000-8000-000000000001';

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [ProjectsService],
    }).compile();
    prisma = module.get(PrismaService);
    service = module.get(ProjectsService);
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    const user = await prisma.user.create({
      data: { email: 'user@example.com', name: '사용자' },
    });
    const otherUser = await prisma.user.create({
      data: { email: 'other@example.com', name: '다른 사용자' },
    });
    userId = user.id;
    otherUserId = otherUser.id;
  });

  afterAll(async () => {
    await module?.close();
  });

  it('create는 프로젝트와 만든 사람의 DEVELOPER 멤버 줄을 함께 저장하고 정해진 네 칸만 돌려준다', async () => {
    const result = await service.create(userId, '쇼핑몰 리뉴얼');

    expect(result).toEqual({
      id: expect.any(String),
      name: '쇼핑몰 리뉴얼',
      myRole: 'DEVELOPER',
      createdAt: expect.any(Date),
    });
    expect(await prisma.project.findMany()).toEqual([
      { id: result.id, name: result.name, currentVersionId: null, approverMemberId: null, createdAt: result.createdAt },
    ]);
    expect(await prisma.projectMember.findMany()).toEqual([
      {
        id: expect.any(String),
        projectId: result.id,
        userId,
        role: 'DEVELOPER',
        revokedAt: null,
        createdAt: expect.any(Date),
      },
    ]);
  });

  it('create에서 없는 사용자의 멤버 저장이 실패하면 새 프로젝트도 남지 않고 기존 데이터는 유지된다', async () => {
    await service.create(userId, '기존 프로젝트');
    const projectsBefore = await prisma.project.findMany();
    const membersBefore = await prisma.projectMember.findMany();

    await expect(service.create(missingId, '실패할 프로젝트')).rejects.toMatchObject({
      code: 'P2003',
    });

    expect(await prisma.project.findMany()).toEqual(projectsBefore);
    expect(await prisma.projectMember.findMany()).toEqual(membersBefore);
  });

  it('listMine은 두 역할의 내 프로젝트만 가입 순서와 무관하게 프로젝트를 새로 만든 순으로 돌려준다', async () => {
    // 입력 순서와 멤버 가입 시각 모두 프로젝트 생성 시각의 정렬 순서와 다르게 둔다.
    const clientProject = await prisma.project.create({
      data: { name: '클라이언트로 참여', createdAt: new Date('2026-01-02T00:00:00Z') },
    });
    const developerProject = await prisma.project.create({
      data: { name: '직접 만든 프로젝트', createdAt: new Date('2026-01-01T00:00:00Z') },
    });
    const otherProject = await prisma.project.create({
      data: { name: '남의 프로젝트', createdAt: new Date('2026-01-03T00:00:00Z') },
    });
    await prisma.projectMember.createMany({
      data: [
        {
          projectId: developerProject.id,
          userId,
          role: 'DEVELOPER',
          createdAt: new Date('2026-01-05T00:00:00Z'),
        },
        { projectId: developerProject.id, userId: otherUserId, role: 'CLIENT' },
        { projectId: clientProject.id, userId: otherUserId, role: 'DEVELOPER' },
        {
          projectId: clientProject.id,
          userId,
          role: 'CLIENT',
          createdAt: new Date('2026-01-04T00:00:00Z'),
        },
        { projectId: otherProject.id, userId: otherUserId, role: 'DEVELOPER' },
      ],
    });

    await expect(service.listMine(userId)).resolves.toEqual([
      {
        id: clientProject.id,
        name: clientProject.name,
        myRole: 'CLIENT',
        createdAt: clientProject.createdAt,
      },
      {
        id: developerProject.id,
        name: developerProject.name,
        myRole: 'DEVELOPER',
        createdAt: developerProject.createdAt,
      },
    ]);
  });

  it('listMine은 남의 프로젝트가 있어도 내 멤버 줄이 없으면 빈 배열을 돌려준다', async () => {
    await service.create(otherUserId, '남의 프로젝트');

    await expect(service.listMine(userId)).resolves.toEqual([]);
  });

  it.each(['DEVELOPER', 'CLIENT'] as const)(
    'requireMemberRole은 같은 프로젝트에서 요청한 사람의 %s 역할을 돌려준다',
    async (role) => {
      const project = await service.create(userId, '함께 보는 프로젝트');
      await prisma.projectMember.create({
        data: { projectId: project.id, userId: otherUserId, role: 'CLIENT' },
      });
      const memberUserId = role === 'DEVELOPER' ? userId : otherUserId;

      await expect(service.requireMemberRole(project.id, memberUserId)).resolves.toBe(role);
    },
  );

  it('requireMemberRole은 다른 프로젝트의 개발자라도 요청한 프로젝트의 멤버가 아니면 404를 던진다', async () => {
    await service.create(userId, '내 프로젝트');
    const otherProject = await service.create(otherUserId, '남의 프로젝트');

    await expect(service.requireMemberRole(otherProject.id, userId)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('requireMemberRole은 UUID 모양이 맞아도 없는 프로젝트면 404를 던진다', async () => {
    await service.create(userId, '내 프로젝트');

    await expect(service.requireMemberRole(missingId, userId)).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each(['DEVELOPER', 'CLIENT'] as const)(
    'getForMember는 게시 전 %s 멤버에게 id, name, myRole과 currentVersion: null을 돌려준다',
    async (role) => {
      const project = await service.create(userId, '함께 보는 프로젝트');
      await prisma.projectMember.create({
        data: { projectId: project.id, userId: otherUserId, role: 'CLIENT' },
      });
      const memberUserId = role === 'DEVELOPER' ? userId : otherUserId;

      await expect(service.getForMember(project.id, memberUserId)).resolves.toEqual({
        id: project.id,
        name: '함께 보는 프로젝트',
        myRole: role,
        currentVersion: null,
      });
    },
  );

  it.each(['DEVELOPER', 'CLIENT'] as const)(
    'getForMember는 초안과 다른 프로젝트의 버전이 있어도 %s 멤버에게 현재 버전의 id와 번호만 돌려준다',
    async (role) => {
      const project = await service.create(userId, '함께 보는 프로젝트');
      await prisma.projectMember.create({
        data: { projectId: project.id, userId: otherUserId, role: 'CLIENT' },
      });
      const currentVersion = await prisma.deliveryVersion.create({
        data: {
          projectId: project.id,
          number: 1,
          status: 'IN_REVIEW',
          publishedAt: new Date(),
          summary: '상세 응답에 포함하지 않는 설명',
          testUrl: 'https://example.com/review',
        },
      });
      await prisma.project.update({
        where: { id: project.id },
        data: { currentVersionId: currentVersion.id },
      });
      await prisma.deliveryVersion.create({ data: { projectId: project.id } });
      const otherProject = await service.create(otherUserId, '남의 프로젝트');
      await prisma.deliveryVersion.create({
        data: { projectId: otherProject.id, number: 7, status: 'IN_REVIEW', publishedAt: new Date() },
      });
      const memberUserId = role === 'DEVELOPER' ? userId : otherUserId;

      await expect(service.getForMember(project.id, memberUserId)).resolves.toEqual({
        id: project.id,
        name: project.name,
        myRole: role,
        currentVersion: { id: currentVersion.id, number: 1 },
      });
    },
  );

  it('getForMember는 다른 프로젝트의 개발자라도 요청한 프로젝트의 멤버가 아니면 404를 던진다', async () => {
    await service.create(userId, '내 프로젝트');
    const otherProject = await service.create(otherUserId, '남의 프로젝트');

    await expect(service.getForMember(otherProject.id, userId)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('getForMember는 UUID 모양이 맞아도 없는 프로젝트면 404를 던진다', async () => {
    await service.create(userId, '내 프로젝트');

    await expect(service.getForMember(missingId, userId)).rejects.toBeInstanceOf(NotFoundException);
  });
});
