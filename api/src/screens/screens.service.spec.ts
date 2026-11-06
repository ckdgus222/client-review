import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { resetDatabase } from '../../test/reset-database.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { ScreensService } from './screens.service.js';

describe('ScreensService', () => {
  let module: TestingModule | undefined;
  let prisma: PrismaService;
  let service: ScreensService;
  let projects: ProjectsService;
  let developerId: string;
  let clientId: string;
  let outsiderId: string;
  let projectId: string;
  let otherProjectId: string;
  const missingId = '00000000-0000-4000-8000-000000000001';
  const firstHiddenAt = new Date('2026-01-01T00:00:00Z');

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [ScreensService, ProjectsService],
    }).compile();
    prisma = module.get(PrismaService);
    service = module.get(ScreensService);
    projects = module.get(ProjectsService);
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
      data: { email: 'outsider@example.com', name: '다른 프로젝트 개발자' },
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

  it.each(['DEVELOPER', 'CLIENT'] as const)(
    'list는 %s에게 해당 프로젝트의 숨긴 화면까지 만든 순으로 네 칸만 돌려준다',
    async (role) => {
      // 저장 순서와 이름순을 생성 시각순과 다르게 둔다.
      const newer = await prisma.screen.create({
        data: { projectId, name: '가', viewport: 'PC', createdAt: new Date('2026-01-03T00:00:00Z') },
      });
      const older = await prisma.screen.create({
        data: {
          projectId,
          name: '나',
          viewport: 'MOBILE',
          hiddenAt: firstHiddenAt,
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
      });
      await prisma.screen.create({
        data: {
          projectId: otherProjectId,
          name: '다른 프로젝트 화면',
          viewport: 'PC',
          createdAt: new Date('2026-01-02T00:00:00Z'),
        },
      });
      const userId = role === 'DEVELOPER' ? developerId : clientId;

      await expect(service.list(projectId, userId)).resolves.toEqual([
        { id: older.id, name: '나', viewport: 'MOBILE', hiddenAt: firstHiddenAt },
        { id: newer.id, name: '가', viewport: 'PC', hiddenAt: null },
      ]);
    },
  );

  it.each(['DEVELOPER', 'CLIENT'] as const)('list는 화면이 없으면 %s에게 빈 배열을 돌려준다', async (role) => {
    const userId = role === 'DEVELOPER' ? developerId : clientId;

    await expect(service.list(projectId, userId)).resolves.toEqual([]);
  });

  it('list는 다른 프로젝트의 개발자여도 이 프로젝트의 멤버가 아니면 404를 던진다', async () => {
    await prisma.screen.create({ data: { projectId, name: '메인', viewport: 'PC' } });

    await expect(service.list(projectId, outsiderId)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('list는 UUID 모양이 맞아도 없는 프로젝트면 404를 던진다', async () => {
    await expect(service.list(missingId, developerId)).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each(['PC', 'MOBILE'] as const)('create는 개발자가 %s 화면을 만들면 저장하고 목록에 보인다', async (viewport) => {
    const result = await service.create(projectId, developerId, '메인', viewport);

    expect(result).toEqual({ id: expect.any(String), name: '메인', viewport, hiddenAt: null });
    expect(await prisma.screen.findMany()).toEqual([{ ...result, projectId, createdAt: expect.any(Date) }]);
    await expect(service.list(projectId, clientId)).resolves.toEqual([result]);
  });

  it('create는 CLIENT에게 403을 던지고 화면을 만들지 않는다', async () => {
    await expect(service.create(projectId, clientId, '메인', 'PC')).rejects.toBeInstanceOf(ForbiddenException);

    expect(await prisma.screen.count()).toBe(0);
  });

  it('create는 다른 프로젝트의 개발자여도 여기서 CLIENT면 403을 던진다', async () => {
    await expect(service.create(otherProjectId, developerId, '메인', 'PC')).rejects.toBeInstanceOf(ForbiddenException);

    expect(await prisma.screen.count()).toBe(0);
  });

  it('create는 다른 프로젝트의 개발자여도 멤버가 아니면 404를 던지고 화면을 만들지 않는다', async () => {
    await expect(service.create(projectId, outsiderId, '메인', 'PC')).rejects.toBeInstanceOf(NotFoundException);

    expect(await prisma.screen.count()).toBe(0);
  });

  it('create는 UUID 모양이 맞아도 없는 프로젝트면 404를 던지고 화면을 만들지 않는다', async () => {
    await expect(service.create(missingId, developerId, '메인', 'PC')).rejects.toBeInstanceOf(NotFoundException);

    expect(await prisma.screen.count()).toBe(0);
  });

  it.each([null, firstHiddenAt])(
    'create는 hiddenAt=%s인 같은 이름·기기의 화면도 SCREEN_EXISTS로 거절한다',
    async (hiddenAt) => {
      const existing = await prisma.screen.create({
        data: { projectId, name: '메인', viewport: 'PC', hiddenAt },
      });

      const error = await service.create(projectId, developerId, '메인', 'PC').catch((error: unknown) => error);

      expect(error).toBeInstanceOf(ConflictException);
      if (!(error instanceof ConflictException)) throw new Error('409 오류가 필요해요');
      expect(error.getResponse()).toEqual({ statusCode: 409, message: '이미 있는 화면이에요', code: 'SCREEN_EXISTS' });
      expect(await prisma.screen.findMany()).toEqual([existing]);
    },
  );

  it('create는 같은 프로젝트의 같은 이름이어도 기기가 다르면 허용한다', async () => {
    const pc = await service.create(projectId, developerId, '메인', 'PC');
    const mobile = await service.create(projectId, developerId, '메인', 'MOBILE');

    expect(mobile).toEqual({ id: expect.any(String), name: '메인', viewport: 'MOBILE', hiddenAt: null });
    expect(mobile.id).not.toBe(pc.id);
    expect(await prisma.screen.count({ where: { projectId, name: '메인' } })).toBe(2);
  });

  it('create는 같은 이름·기기여도 프로젝트가 다르면 허용한다', async () => {
    const first = await service.create(projectId, developerId, '메인', 'PC');
    const second = await service.create(otherProjectId, outsiderId, '메인', 'PC');

    expect(second).toEqual({ id: expect.any(String), name: '메인', viewport: 'PC', hiddenAt: null });
    expect(second.id).not.toBe(first.id);
    expect(await prisma.screen.findUnique({ where: { id: second.id } })).toEqual({
      ...second,
      projectId: otherProjectId,
      createdAt: expect.any(Date),
    });
    expect(await prisma.screen.count()).toBe(2);
  });

  it('create를 같은 이름·기기로 동시에 두 번 요청하면 하나만 저장되고 다른 하나는 SCREEN_EXISTS다', async () => {
    // 두 요청의 성공과 실패를 모두 기다려 다음 테스트의 DB 초기화와 겹치지 않게 한다.
    const results = await Promise.all([
      service.create(projectId, developerId, '메인', 'PC').catch((error: unknown) => error),
      service.create(projectId, developerId, '메인', 'PC').catch((error: unknown) => error),
    ]);

    const saved = await prisma.screen.findMany();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toEqual({
      id: expect.any(String),
      projectId,
      name: '메인',
      viewport: 'PC',
      hiddenAt: null,
      createdAt: expect.any(Date),
    });
    const errors = results.filter((result) => result instanceof ConflictException);
    expect(errors).toHaveLength(1);
    expect(errors[0].getResponse()).toEqual({
      statusCode: 409,
      message: '이미 있는 화면이에요',
      code: 'SCREEN_EXISTS',
    });
    expect(results).toContainEqual({ id: saved[0].id, name: '메인', viewport: 'PC', hiddenAt: null });
  });

  it('setHidden은 개발자가 숨기고 다시 보이게 한 상태를 저장하고 목록에도 반영한다', async () => {
    const screen = await prisma.screen.create({ data: { projectId, name: '메인', viewport: 'PC' } });
    const untouched = await prisma.screen.create({ data: { projectId, name: '다른 화면', viewport: 'MOBILE' } });

    const hidden = await service.setHidden(screen.id, developerId, true);

    expect(hidden).toEqual({ id: screen.id, name: '메인', viewport: 'PC', hiddenAt: expect.any(Date) });
    expect(await prisma.screen.findUnique({ where: { id: screen.id } })).toEqual({
      ...screen,
      hiddenAt: hidden.hiddenAt,
    });
    expect(await service.list(projectId, clientId)).toContainEqual(hidden);

    const shown = await service.setHidden(screen.id, developerId, false);

    expect(shown).toEqual({ id: screen.id, name: '메인', viewport: 'PC', hiddenAt: null });
    expect(await prisma.screen.findUnique({ where: { id: screen.id } })).toEqual(screen);
    expect(await service.list(projectId, clientId)).toContainEqual(shown);
    expect(await prisma.screen.findUnique({ where: { id: untouched.id } })).toEqual(untouched);
  });

  it('setHidden은 이미 숨긴 화면을 다시 숨겨도 처음 숨긴 시각을 그대로 돌려준다', async () => {
    const screen = await prisma.screen.create({
      data: { projectId, name: '메인', viewport: 'PC', hiddenAt: firstHiddenAt },
    });

    const first = await service.setHidden(screen.id, developerId, true);
    const second = await service.setHidden(screen.id, developerId, true);

    expect(first).toEqual({ id: screen.id, name: '메인', viewport: 'PC', hiddenAt: firstHiddenAt });
    expect(second).toEqual(first);
    expect(await prisma.screen.findUnique({ where: { id: screen.id } })).toEqual(screen);
  });

  it('setHidden은 보이는 화면을 다시 보이게 해도 지금 상태를 그대로 돌려준다', async () => {
    const screen = await prisma.screen.create({ data: { projectId, name: '메인', viewport: 'MOBILE' } });

    await expect(service.setHidden(screen.id, developerId, false)).resolves.toEqual({
      id: screen.id,
      name: '메인',
      viewport: 'MOBILE',
      hiddenAt: null,
    });
    expect(await prisma.screen.findUnique({ where: { id: screen.id } })).toEqual(screen);
  });

  it.each([
    { hiddenAt: null, hidden: true },
    { hiddenAt: firstHiddenAt, hidden: false },
    { hiddenAt: firstHiddenAt, hidden: true },
    { hiddenAt: null, hidden: false },
  ])(
    'setHidden은 CLIENT의 hiddenAt=$hiddenAt → hidden=$hidden 요청을 403으로 거절하고 상태를 보존한다',
    async ({ hiddenAt, hidden }) => {
      const screen = await prisma.screen.create({ data: { projectId, name: '메인', viewport: 'PC', hiddenAt } });

      await expect(service.setHidden(screen.id, clientId, hidden)).rejects.toBeInstanceOf(ForbiddenException);

      expect(await prisma.screen.findUnique({ where: { id: screen.id } })).toEqual(screen);
    },
  );

  it.each([true, false])('setHidden(%s)은 다른 프로젝트의 개발자여도 여기서 CLIENT면 403을 던진다', async (hidden) => {
    const screen = await prisma.screen.create({
      data: { projectId: otherProjectId, name: '메인', viewport: 'PC', hiddenAt: hidden ? null : firstHiddenAt },
    });

    await expect(service.setHidden(screen.id, developerId, hidden)).rejects.toBeInstanceOf(ForbiddenException);

    expect(await prisma.screen.findUnique({ where: { id: screen.id } })).toEqual(screen);
  });

  it.each([true, false])('setHidden(%s)은 남의 프로젝트 화면이면 404를 던지고 상태를 보존한다', async (hidden) => {
    const screen = await prisma.screen.create({
      data: { projectId, name: '메인', viewport: 'PC', hiddenAt: hidden ? null : firstHiddenAt },
    });

    await expect(service.setHidden(screen.id, outsiderId, hidden)).rejects.toBeInstanceOf(NotFoundException);

    expect(await prisma.screen.findUnique({ where: { id: screen.id } })).toEqual(screen);
  });

  it.each([true, false])(
    'setHidden(%s)은 UUID 모양이 맞아도 없는 화면이면 정해진 404 오류를 던진다',
    async (hidden) => {
      const request = service.setHidden(missingId, developerId, hidden);

      await expect(request).rejects.toBeInstanceOf(NotFoundException);
      await expect(request).rejects.toThrow('없는 화면이에요');
    },
  );

  it.each([true, false])('setHidden(%s)은 남의 화면과 없는 화면의 404 응답 본문이 완전히 같다', async (hidden) => {
    const screen = await prisma.screen.create({
      data: { projectId, name: '메인', viewport: 'PC', hiddenAt: hidden ? null : firstHiddenAt },
    });

    const outsiderError = await service.setHidden(screen.id, outsiderId, hidden).catch((error: unknown) => error);
    const missingError = await service.setHidden(missingId, outsiderId, hidden).catch((error: unknown) => error);

    expect(outsiderError).toBeInstanceOf(NotFoundException);
    expect(missingError).toBeInstanceOf(NotFoundException);
    if (!(outsiderError instanceof NotFoundException)) throw new Error('남의 화면은 404 오류가 필요해요');
    if (!(missingError instanceof NotFoundException)) throw new Error('없는 화면은 404 오류가 필요해요');
    expect(outsiderError.getResponse()).toStrictEqual(missingError.getResponse());
    expect(outsiderError.getResponse()).toStrictEqual({
      statusCode: 404,
      message: '없는 화면이에요',
      error: 'Not Found',
    });
  });

  it.each([true, false])('setHidden(%s)은 CLIENT 멤버의 오류를 404로 바꾸지 않고 403으로 유지한다', async (hidden) => {
    const screen = await prisma.screen.create({
      data: { projectId, name: '메인', viewport: 'PC', hiddenAt: hidden ? null : firstHiddenAt },
    });

    const error = await service.setHidden(screen.id, clientId, hidden).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(ForbiddenException);
    expect(error).not.toBeInstanceOf(NotFoundException);
    if (!(error instanceof ForbiddenException)) throw new Error('CLIENT 멤버는 403 오류가 필요해요');
    expect(error.getStatus()).toBe(403);
    expect(error.getResponse()).toMatchObject({ statusCode: 403 });
  });

  it.each([null, firstHiddenAt])(
    'setHidden은 hiddenAt=%s에서 숨기기와 보이기를 동시에 요청해도 둘 다 끝난다',
    async (hiddenAt) => {
      const screen = await prisma.screen.create({ data: { projectId, name: '메인', viewport: 'PC', hiddenAt } });

      const [hidden, shown] = await Promise.all([
        service.setHidden(screen.id, developerId, true),
        service.setHidden(screen.id, developerId, false),
      ]);

      expect(hidden).toEqual({ id: screen.id, name: '메인', viewport: 'PC', hiddenAt: expect.any(Date) });
      expect(shown).toEqual({ id: screen.id, name: '메인', viewport: 'PC', hiddenAt: null });
      const saved = await prisma.screen.findUniqueOrThrow({ where: { id: screen.id } });
      expect([hidden.hiddenAt, shown.hiddenAt]).toContainEqual(saved.hiddenAt);
      expect(saved).toEqual({ ...screen, hiddenAt: saved.hiddenAt });
      expect(await prisma.screen.count()).toBe(1);
    },
  );

  it('setHidden으로 동시에 두 번 숨겨도 두 응답과 저장된 숨긴 시각이 같다', async () => {
    const screen = await prisma.screen.create({ data: { projectId, name: '메인', viewport: 'PC' } });

    const [first, second] = await Promise.all([
      service.setHidden(screen.id, developerId, true),
      service.setHidden(screen.id, developerId, true),
    ]);

    expect(first).toEqual({ id: screen.id, name: '메인', viewport: 'PC', hiddenAt: expect.any(Date) });
    expect(second).toEqual(first);
    expect(await prisma.screen.findUnique({ where: { id: screen.id } })).toEqual({
      ...screen,
      hiddenAt: first.hiddenAt,
    });
  });

  it('같은 프로젝트 줄이 잠겨 있으면 숨기기와 만들기는 잠금이 풀릴 때까지 상태를 바꾸지 않는다', async () => {
    const screen = await prisma.screen.create({ data: { projectId, name: '메인', viewport: 'PC' } });
    let hideSettled = false;
    let createSettled = false;
    let requests: Promise<unknown>[] = [];

    try {
      await prisma.$transaction(
        async (tx) => {
          // 잠금을 얻은 뒤 요청을 시작하므로 두 요청의 실행 순서에 기대지 않는다.
          await tx.$queryRaw`SELECT id FROM projects WHERE id = ${projectId}::uuid FOR UPDATE`;
          requests = [
            service
              .setHidden(screen.id, developerId, true)
              .catch((error: unknown) => error)
              .finally(() => {
                hideSettled = true;
              }),
            service
              .create(projectId, developerId, '새 화면', 'MOBILE')
              .catch((error: unknown) => error)
              .finally(() => {
                createSettled = true;
              }),
          ];

          await new Promise<void>((resolve) => {
            setTimeout(resolve, 200);
          });

          expect(hideSettled).toBe(false);
          expect(createSettled).toBe(false);
          expect(await tx.screen.findMany({ where: { projectId } })).toEqual([screen]);
        },
        { maxWait: 5_000, timeout: 10_000 },
      );
    } finally {
      // 검증이 실패해도 트랜잭션이 끝나 잠금이 풀린 뒤 요청들을 정리한다.
      await Promise.all(requests);
    }

    const [hidden, created] = await Promise.all(requests);
    expect(hidden).toEqual({ id: screen.id, name: '메인', viewport: 'PC', hiddenAt: expect.any(Date) });
    expect(created).toEqual({ id: expect.any(String), name: '새 화면', viewport: 'MOBILE', hiddenAt: null });
    expect(hideSettled).toBe(true);
    expect(createSettled).toBe(true);
    expect(await service.list(projectId, developerId)).toEqual(expect.arrayContaining([hidden, created]));
    expect(await prisma.screen.count({ where: { projectId } })).toBe(2);
  }, 20_000);

  it('다른 프로젝트 줄이 잠겨 있어도 숨기기와 만들기는 그 잠금이 풀리기 전에 끝난다', async () => {
    const screen = await prisma.screen.create({ data: { projectId, name: '메인', viewport: 'PC' } });
    const otherScreen = await prisma.screen.create({
      data: { projectId: otherProjectId, name: '다른 프로젝트 화면', viewport: 'PC' },
    });
    let requests: Promise<unknown>[] = [];
    let deadline: ReturnType<typeof setTimeout> | undefined;

    try {
      await prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM projects WHERE id = ${otherProjectId}::uuid FOR UPDATE`;
          requests = [
            service.setHidden(screen.id, developerId, true).catch((error: unknown) => error),
            service.create(projectId, developerId, '새 화면', 'MOBILE').catch((error: unknown) => error),
          ];
          const [hidden, created] = await Promise.race([
            Promise.all(requests),
            new Promise<never>((_, reject) => {
              deadline = setTimeout(() => {
                reject(new Error('다른 프로젝트의 잠금을 기다리면 안 돼요'));
              }, 2_000);
            }),
          ]);

          expect(hidden).toEqual({ id: screen.id, name: '메인', viewport: 'PC', hiddenAt: expect.any(Date) });
          expect(created).toEqual({ id: expect.any(String), name: '새 화면', viewport: 'MOBILE', hiddenAt: null });
          expect(await tx.screen.findUnique({ where: { id: screen.id } })).toEqual({
            ...screen,
            hiddenAt: expect.any(Date),
          });
          expect(await tx.screen.findMany({ where: { projectId, name: '새 화면' } })).toEqual([
            {
              id: expect.any(String),
              projectId,
              name: '새 화면',
              viewport: 'MOBILE',
              hiddenAt: null,
              createdAt: expect.any(Date),
            },
          ]);
          expect(await tx.screen.findMany({ where: { projectId: otherProjectId } })).toEqual([otherScreen]);
        },
        { maxWait: 5_000, timeout: 10_000 },
      );
    } finally {
      clearTimeout(deadline);
      await Promise.all(requests);
    }
  }, 20_000);

  it.each(['DEVELOPER', 'CLIENT'] as const)(
    'requireMemberRole은 전달받은 트랜잭션에서 아직 커밋하지 않은 %s 멤버를 읽는다',
    async (role) => {
      await prisma.$transaction(async (tx) => {
        const project = await tx.project.create({ data: { name: '트랜잭션 안의 프로젝트' } });
        await tx.projectMember.create({ data: { projectId: project.id, userId: developerId, role } });

        await expect(projects.requireMemberRole(project.id, developerId, tx)).resolves.toBe(role);
      });
    },
  );

  it('requireMemberRole은 전달받은 트랜잭션 안에서 멤버를 지웠으면 404를 던진다', async () => {
    await prisma.$transaction(async (tx) => {
      await tx.projectMember.delete({ where: { projectId_userId: { projectId, userId: clientId } } });

      await expect(projects.requireMemberRole(projectId, clientId, tx)).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
