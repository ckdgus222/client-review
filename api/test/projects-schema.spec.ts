import { PrismaService } from '../src/prisma/prisma.service.js';
import { resetDatabase } from './reset-database.js';

describe('프로젝트와 화면 테이블', () => {
  const prisma = new PrismaService();
  const missingId = '00000000-0000-4000-8000-000000000001';
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('같은 프로젝트에 같은 이름과 기기의 화면을 두 번 만들 수 없다', async () => {
    const project = await prisma.project.create({ data: { name: '프로젝트' } });
    const data = { projectId: project.id, name: '메인', viewport: 'PC' as const };
    await prisma.screen.create({ data });

    await expect(prisma.screen.create({ data })).rejects.toMatchObject({ code: 'P2002' });
    expect(await prisma.screen.count()).toBe(1);
  });

  it('같은 이름이라도 PC와 MOBILE 화면을 각각 만들 수 있다', async () => {
    const project = await prisma.project.create({ data: { name: '프로젝트' } });

    await prisma.screen.createMany({
      data: [
        { projectId: project.id, name: '메인', viewport: 'PC' },
        { projectId: project.id, name: '메인', viewport: 'MOBILE' },
      ],
    });

    expect(await prisma.screen.findMany({ orderBy: { viewport: 'asc' } })).toEqual([
      expect.objectContaining({ projectId: project.id, name: '메인', viewport: 'PC' }),
      expect.objectContaining({ projectId: project.id, name: '메인', viewport: 'MOBILE' }),
    ]);
  });

  it('같은 프로젝트와 기기라도 이름이 다르면 화면을 만들 수 있다', async () => {
    const project = await prisma.project.create({ data: { name: '프로젝트' } });

    await prisma.screen.createMany({
      data: [
        { projectId: project.id, name: '메인', viewport: 'PC' },
        { projectId: project.id, name: '상품 상세', viewport: 'PC' },
      ],
    });

    expect(await prisma.screen.count()).toBe(2);
  });

  it('다른 프로젝트에는 같은 이름과 기기의 화면을 만들 수 있다', async () => {
    const firstProject = await prisma.project.create({ data: { name: '첫 프로젝트' } });
    const secondProject = await prisma.project.create({ data: { name: '둘째 프로젝트' } });

    await prisma.screen.createMany({
      data: [
        { projectId: firstProject.id, name: '메인', viewport: 'PC' },
        { projectId: secondProject.id, name: '메인', viewport: 'PC' },
      ],
    });

    expect(await prisma.screen.count({ where: { projectId: firstProject.id } })).toBe(1);
    expect(await prisma.screen.count({ where: { projectId: secondProject.id } })).toBe(1);
  });

  it('숨긴 화면도 같은 프로젝트의 이름과 기기 중복을 막는다', async () => {
    const project = await prisma.project.create({ data: { name: '프로젝트' } });
    const hiddenAt = new Date('2026-11-04T00:00:00.000Z');
    const screen = await prisma.screen.create({
      data: { projectId: project.id, name: '메인', viewport: 'PC', hiddenAt },
    });

    await expect(
      prisma.screen.create({
        data: { projectId: project.id, name: '메인', viewport: 'PC' },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(await prisma.screen.findMany()).toEqual([screen]);
  });

  it('동시에 같은 이름과 기기의 화면을 만들면 한 줄만 생긴다', async () => {
    const project = await prisma.project.create({ data: { name: '프로젝트' } });
    const data = { projectId: project.id, name: '메인', viewport: 'PC' as const };

    const results = await Promise.allSettled([prisma.screen.create({ data }), prisma.screen.create({ data })]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ code: 'P2002' }),
      }),
    ]);
    expect(await prisma.screen.findMany()).toEqual([expect.objectContaining(data)]);
  });

  it('다른 사용자라도 한 프로젝트에 DEVELOPER를 두 줄 만들 수 없다', async () => {
    const project = await prisma.project.create({ data: { name: '프로젝트' } });
    const firstUser = await prisma.user.create({
      data: { email: 'first@example.com', name: '첫 개발자' },
    });
    const secondUser = await prisma.user.create({
      data: { email: 'second@example.com', name: '둘째 개발자' },
    });
    const developer = await prisma.projectMember.create({
      data: { projectId: project.id, userId: firstUser.id, role: 'DEVELOPER' },
    });

    await expect(
      prisma.projectMember.create({
        data: { projectId: project.id, userId: secondUser.id, role: 'DEVELOPER' },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(await prisma.projectMember.findMany()).toEqual([developer]);
  });

  it('한 프로젝트에 DEVELOPER 한 명과 CLIENT 여러 명을 둘 수 있다', async () => {
    const project = await prisma.project.create({ data: { name: '프로젝트' } });
    const developer = await prisma.user.create({
      data: { email: 'developer@example.com', name: '개발자' },
    });
    const firstClient = await prisma.user.create({
      data: { email: 'first@example.com', name: '첫 클라이언트' },
    });
    const secondClient = await prisma.user.create({
      data: { email: 'second@example.com', name: '둘째 클라이언트' },
    });

    await prisma.projectMember.createMany({
      data: [
        { projectId: project.id, userId: developer.id, role: 'DEVELOPER' },
        { projectId: project.id, userId: firstClient.id, role: 'CLIENT' },
        { projectId: project.id, userId: secondClient.id, role: 'CLIENT' },
      ],
    });

    expect(await prisma.projectMember.count({ where: { role: 'DEVELOPER' } })).toBe(1);
    expect(await prisma.projectMember.count({ where: { role: 'CLIENT' } })).toBe(2);
  });

  it.each(['CLIENT', 'DEVELOPER'] as const)(
    '같은 사용자는 같은 프로젝트에 CLIENT와 %s 두 줄로 들어갈 수 없다',
    async (role) => {
      const project = await prisma.project.create({ data: { name: '프로젝트' } });
      const user = await prisma.user.create({
        data: { email: 'user@example.com', name: '사용자' },
      });
      const member = await prisma.projectMember.create({
        data: { projectId: project.id, userId: user.id, role: 'CLIENT' },
      });

      await expect(
        prisma.projectMember.create({ data: { projectId: project.id, userId: user.id, role } }),
      ).rejects.toMatchObject({ code: 'P2002' });
      expect(await prisma.projectMember.findMany()).toEqual([member]);
    },
  );

  it('같은 사용자가 서로 다른 프로젝트의 DEVELOPER가 될 수 있다', async () => {
    const user = await prisma.user.create({
      data: { email: 'user@example.com', name: '개발자' },
    });
    const firstProject = await prisma.project.create({ data: { name: '첫 프로젝트' } });
    const secondProject = await prisma.project.create({ data: { name: '둘째 프로젝트' } });

    await prisma.projectMember.createMany({
      data: [
        { projectId: firstProject.id, userId: user.id, role: 'DEVELOPER' },
        { projectId: secondProject.id, userId: user.id, role: 'DEVELOPER' },
      ],
    });

    expect(await prisma.projectMember.count({ where: { projectId: firstProject.id } })).toBe(1);
    expect(await prisma.projectMember.count({ where: { projectId: secondProject.id } })).toBe(1);
  });

  it('프로젝트를 지우면 그 프로젝트의 멤버와 화면만 지워지고 사용자는 남는다', async () => {
    const user = await prisma.user.create({
      data: { email: 'user@example.com', name: '개발자' },
    });
    const client = await prisma.user.create({
      data: { email: 'client@example.com', name: '클라이언트' },
    });
    const removedProject = await prisma.project.create({
      data: {
        name: '삭제할 프로젝트',
        members: {
          create: [
            { userId: user.id, role: 'DEVELOPER' },
            { userId: client.id, role: 'CLIENT' },
          ],
        },
        screens: {
          create: [
            { name: '메인', viewport: 'PC' },
            { name: '메인', viewport: 'MOBILE', hiddenAt: new Date() },
          ],
        },
      },
    });
    const remainingProject = await prisma.project.create({
      data: {
        name: '남길 프로젝트',
        members: { create: { userId: user.id, role: 'DEVELOPER' } },
        screens: { create: { name: '메인', viewport: 'PC' } },
      },
      include: { members: true, screens: true },
    });
    expect(await prisma.projectMember.count()).toBe(3);
    expect(await prisma.screen.count()).toBe(3);

    await prisma.project.delete({ where: { id: removedProject.id } });

    expect(await prisma.project.findMany({ include: { members: true, screens: true } })).toEqual([remainingProject]);
    expect(await prisma.projectMember.findMany()).toEqual(remainingProject.members);
    expect(await prisma.screen.findMany()).toEqual(remainingProject.screens);
    expect(await prisma.user.findMany()).toEqual(expect.arrayContaining([user, client]));
    expect(await prisma.user.count()).toBe(2);
  });

  it.each(['DEVELOPER', 'CLIENT'] as const)('%s 멤버 줄이 있는 사용자는 지울 수 없다', async (role) => {
    const user = await prisma.user.create({
      data: { email: 'user@example.com', name: '사용자' },
    });
    const project = await prisma.project.create({ data: { name: '프로젝트' } });
    const member = await prisma.projectMember.create({
      data: { projectId: project.id, userId: user.id, role },
    });

    await expect(prisma.user.delete({ where: { id: user.id } })).rejects.toMatchObject({ code: 'P2003' });
    expect(await prisma.user.findUnique({ where: { id: user.id } })).toEqual(user);
    expect(await prisma.projectMember.findMany()).toEqual([member]);
  });

  it('없는 프로젝트의 멤버를 만들 수 없다', async () => {
    const user = await prisma.user.create({
      data: { email: 'user@example.com', name: '사용자' },
    });

    await expect(
      prisma.projectMember.create({
        data: { projectId: missingId, userId: user.id, role: 'CLIENT' },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
    expect(await prisma.projectMember.count()).toBe(0);
  });

  it('없는 사용자를 프로젝트 멤버로 만들 수 없다', async () => {
    const project = await prisma.project.create({ data: { name: '프로젝트' } });

    await expect(
      prisma.projectMember.create({
        data: { projectId: project.id, userId: missingId, role: 'CLIENT' },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
    expect(await prisma.projectMember.count()).toBe(0);
  });

  it('없는 프로젝트의 화면을 만들 수 없다', async () => {
    await expect(
      prisma.screen.create({
        data: { projectId: missingId, name: '메인', viewport: 'PC' },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
    expect(await prisma.screen.count()).toBe(0);
  });

  it('프로젝트와 개발자를 중첩 생성하다 멤버 저장이 실패하면 프로젝트도 남지 않는다', async () => {
    await expect(
      prisma.project.create({
        data: {
          name: '실패할 프로젝트',
          members: { create: { userId: missingId, role: 'DEVELOPER' } },
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
    expect(await prisma.project.count()).toBe(0);
    expect(await prisma.projectMember.count()).toBe(0);
  });

  it('DB는 정해지지 않은 역할을 거부한다', async () => {
    const project = await prisma.project.create({ data: { name: '프로젝트' } });
    const user = await prisma.user.create({
      data: { email: 'user@example.com', name: '사용자' },
    });

    // Prisma 입력 검사 대신 DB enum이 잘못된 값을 막는지 확인한다.
    await expect(prisma.$executeRaw`
      INSERT INTO project_members (project_id, user_id, role)
      VALUES (${project.id}::uuid, ${user.id}::uuid, 'OWNER')
    `).rejects.toMatchObject({ code: 'P2010' });
    expect(await prisma.projectMember.count()).toBe(0);
  });

  it('DB는 정해지지 않은 기기를 거부한다', async () => {
    const project = await prisma.project.create({ data: { name: '프로젝트' } });

    await expect(prisma.$executeRaw`
      INSERT INTO screens (project_id, name, viewport)
      VALUES (${project.id}::uuid, '메인', 'TABLET')
    `).rejects.toMatchObject({ code: 'P2010' });
    expect(await prisma.screen.count()).toBe(0);
  });

  it('projects의 id와 created_at을 생략하면 DB가 UUID와 현재 시각을 만든다', async () => {
    const [row] = await prisma.$queryRaw<{ id: string; created_at_is_now: boolean }[]>`
      INSERT INTO projects (name)
      VALUES ('프로젝트')
      RETURNING id, created_at = now() AS created_at_is_now
    `;

    expect(row.id).toMatch(uuidPattern);
    expect(row.created_at_is_now).toBe(true);
    expect(await prisma.project.findUniqueOrThrow({ where: { id: row.id } })).toEqual({
      id: row.id,
      name: '프로젝트',
      createdAt: expect.any(Date),
    });
  });

  it('project_members의 id와 created_at을 생략하면 DB가 UUID와 현재 시각을 만든다', async () => {
    const project = await prisma.project.create({ data: { name: '프로젝트' } });
    const user = await prisma.user.create({
      data: { email: 'user@example.com', name: '개발자' },
    });
    const [row] = await prisma.$queryRaw<{ id: string; created_at_is_now: boolean }[]>`
      INSERT INTO project_members (project_id, user_id, role)
      VALUES (${project.id}::uuid, ${user.id}::uuid, 'DEVELOPER')
      RETURNING id, created_at = now() AS created_at_is_now
    `;

    expect(row.id).toMatch(uuidPattern);
    expect(row.created_at_is_now).toBe(true);
    expect(await prisma.projectMember.findUniqueOrThrow({ where: { id: row.id } })).toEqual({
      id: row.id,
      projectId: project.id,
      userId: user.id,
      role: 'DEVELOPER',
      createdAt: expect.any(Date),
    });
  });

  it('screens의 UUID와 생성 시각은 DB가 만들고 hidden_at은 비어 있다', async () => {
    const project = await prisma.project.create({ data: { name: '프로젝트' } });
    const [row] = await prisma.$queryRaw<{ id: string; created_at_is_now: boolean }[]>`
      INSERT INTO screens (project_id, name, viewport)
      VALUES (${project.id}::uuid, '메인', 'PC')
      RETURNING id, created_at = now() AS created_at_is_now
    `;

    expect(row.id).toMatch(uuidPattern);
    expect(row.created_at_is_now).toBe(true);
    expect(await prisma.screen.findUniqueOrThrow({ where: { id: row.id } })).toEqual({
      id: row.id,
      projectId: project.id,
      name: '메인',
      viewport: 'PC',
      hiddenAt: null,
      createdAt: expect.any(Date),
    });
  });

  it('resetDatabase는 새 테이블 세 개도 비우고 빈 테이블에서도 다시 실행할 수 있다', async () => {
    const user = await prisma.user.create({
      data: { email: 'user@example.com', name: '개발자' },
    });
    await prisma.project.create({
      data: {
        name: '프로젝트',
        members: { create: { userId: user.id, role: 'DEVELOPER' } },
        screens: { create: { name: '메인', viewport: 'PC' } },
      },
    });
    expect(await prisma.project.count()).toBe(1);
    expect(await prisma.projectMember.count()).toBe(1);
    expect(await prisma.screen.count()).toBe(1);

    await resetDatabase(prisma);

    expect(await prisma.project.count()).toBe(0);
    expect(await prisma.projectMember.count()).toBe(0);
    expect(await prisma.screen.count()).toBe(0);
    expect(await prisma.user.count()).toBe(0);
    await expect(resetDatabase(prisma)).resolves.toBeUndefined();
  });
});
