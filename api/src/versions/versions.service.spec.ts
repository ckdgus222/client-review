import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { resetDatabase } from '../../test/reset-database.js';
import { ActivityService } from '../activity/activity.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { VersionsService } from './versions.service.js';

const expectConflict = (error: unknown, code: string) => {
  expect(error).toBeInstanceOf(ConflictException);
  if (!(error instanceof ConflictException)) throw new Error('409 오류가 필요해요');
  expect(error.getStatus()).toBe(409);
  expect(error.getResponse()).toEqual({ statusCode: 409, message: expect.any(String), code });
};

const expectNotFound = (error: unknown, message: string) => {
  expect(error).toBeInstanceOf(NotFoundException);
  if (!(error instanceof NotFoundException)) throw new Error('404 오류가 필요해요');
  expect(error.getResponse()).toEqual({ statusCode: 404, message, error: 'Not Found' });
};

describe('VersionsService', () => {
  let module: TestingModule | undefined;
  let prisma: PrismaService;
  let service: VersionsService;
  let activity: ActivityService;
  let developerId: string;
  let clientId: string;
  let outsiderId: string;
  let projectId: string;
  let otherProjectId: string;
  const missingId = '00000000-0000-4000-8000-000000000001';
  const publishedAt = new Date('2026-01-01T00:00:00Z');
  const hiddenAt = new Date('2026-01-02T00:00:00Z');

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [VersionsService, ProjectsService, ActivityService],
    }).compile();
    prisma = module.get(PrismaService);
    service = module.get(VersionsService);
    activity = module.get(ActivityService);
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    const developer = await prisma.user.create({ data: { email: 'developer@example.com', name: '개발자' } });
    const client = await prisma.user.create({ data: { email: 'client@example.com', name: '클라이언트' } });
    const outsider = await prisma.user.create({ data: { email: 'outsider@example.com', name: '다른 개발자' } });
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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await module?.close();
  });

  // 파일 처리는 다음 조각의 책임이다. 여기서는 실제 DB에 화면·사진·버전 연결만 준비한다.
  const attachScreen = async (versionId: string, screenData: Omit<Prisma.ScreenUncheckedCreateInput, 'projectId'>) => {
    const screen = await prisma.screen.create({ data: { projectId, ...screenData } });
    const asset = await prisma.asset.create({
      data: {
        projectId,
        storageKey: `${projectId}/${randomUUID()}.png`,
        mime: 'image/png',
        bytes: 100,
        width: 800,
        height: 600,
      },
    });
    const link = await prisma.versionScreen.create({ data: { versionId, screenId: screen.id, assetId: asset.id } });
    return { screen, asset, link };
  };

  it.each(['DEVELOPER', 'CLIENT'] as const)(
    'list는 %s에게 초안 먼저, 번호 내림차순으로 네 칸만 반환한다',
    async (role) => {
      const second = await prisma.deliveryVersion.create({
        data: { projectId, number: 2, status: 'IN_REVIEW', publishedAt },
      });
      const draft = await prisma.deliveryVersion.create({ data: { projectId } });
      const first = await prisma.deliveryVersion.create({
        data: { projectId, number: 1, status: 'APPROVED', publishedAt },
      });
      await prisma.deliveryVersion.create({
        data: { projectId: otherProjectId, number: 99, status: 'IN_REVIEW', publishedAt },
      });
      await prisma.deliveryVersion.create({ data: { projectId: otherProjectId } });
      const expected = [second, first].map(({ id, number, status, publishedAt }) => ({
        id,
        number,
        status,
        publishedAt,
      }));
      if (role === 'DEVELOPER') expected.unshift({ id: draft.id, number: null, status: 'DRAFT', publishedAt: null });

      await expect(service.list(projectId, role === 'DEVELOPER' ? developerId : clientId)).resolves.toEqual(expected);
    },
  );

  it('list는 버전이 없거나 클라이언트에게 초안만 있으면 빈 배열이다', async () => {
    await expect(service.list(projectId, developerId)).resolves.toEqual([]);
    await expect(service.list(projectId, clientId)).resolves.toEqual([]);
    await prisma.deliveryVersion.create({ data: { projectId } });
    await expect(service.list(projectId, clientId)).resolves.toEqual([]);
  });

  it.each(['list', 'createDraft'] as const)('%s는 비멤버와 없는 프로젝트에 같은 404를 반환한다', async (method) => {
    expectNotFound(await service[method](projectId, outsiderId).catch((error: unknown) => error), '없는 프로젝트예요');
    expectNotFound(await service[method](missingId, developerId).catch((error: unknown) => error), '없는 프로젝트예요');
    expect(await prisma.deliveryVersion.count()).toBe(0);
  });

  it('createDraft는 현재 버전이 없으면 번호와 게시 시각 없는 빈 초안을 만든다', async () => {
    const result = await service.createDraft(projectId, developerId);

    expect(result).toEqual({
      id: expect.any(String),
      projectId,
      number: null,
      status: 'DRAFT',
      summary: '',
      testUrl: null,
      publishedAt: null,
      screens: [],
    });
    expect(await prisma.deliveryVersion.findMany()).toEqual([
      {
        id: result.id,
        projectId,
        number: null,
        status: 'DRAFT',
        summary: '',
        testUrl: null,
        publishedAt: null,
        createdAt: expect.any(Date),
      },
    ]);
    expect(await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).toMatchObject({
      currentVersionId: null,
    });
    expect(await prisma.activityEvent.count()).toBe(0);
  });

  it('createDraft는 현재 버전의 보이는 화면만 같은 Asset으로 복사하고 원본과 현재 버전을 보존한다', async () => {
    const current = await prisma.deliveryVersion.create({
      data: {
        projectId,
        number: 2,
        status: 'IN_REVIEW',
        publishedAt,
        summary: '원본 설명',
        testUrl: 'https://example.com/old',
      },
    });
    const visible = await attachScreen(current.id, { name: '현재 화면', viewport: 'PC' });
    const hidden = await attachScreen(current.id, { name: '숨긴 화면', viewport: 'MOBILE', hiddenAt });
    const previous = await prisma.deliveryVersion.create({
      data: { projectId, number: 1, status: 'IN_REVIEW', publishedAt },
    });
    await attachScreen(previous.id, { name: '지난 버전에만 있는 화면', viewport: 'PC' });
    await prisma.project.update({ where: { id: projectId }, data: { currentVersionId: current.id } });
    const assetsBefore = await prisma.asset.findMany({ orderBy: { id: 'asc' } });

    const draft = await service.createDraft(projectId, developerId);

    expect(draft).toEqual({
      id: expect.any(String),
      projectId,
      number: null,
      status: 'DRAFT',
      summary: '',
      testUrl: 'https://example.com/old',
      publishedAt: null,
      screens: [
        {
          screenId: visible.screen.id,
          name: '현재 화면',
          viewport: 'PC',
          hiddenAt: null,
          asset: { id: visible.asset.id, width: 800, height: 600 },
        },
      ],
    });
    expect(await prisma.versionScreen.findMany({ where: { versionId: draft.id } })).toEqual([
      {
        id: expect.any(String),
        versionId: draft.id,
        screenId: visible.screen.id,
        assetId: visible.asset.id,
        createdAt: expect.any(Date),
      },
    ]);
    expect(
      await prisma.versionScreen.findMany({ where: { versionId: current.id }, orderBy: { screenId: 'asc' } }),
    ).toEqual([visible.link, hidden.link].sort((a, b) => a.screenId.localeCompare(b.screenId)));
    expect(await prisma.deliveryVersion.findUnique({ where: { id: current.id } })).toEqual(current);
    expect(await prisma.asset.findMany({ orderBy: { id: 'asc' } })).toEqual(assetsBefore);
    expect(await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).toMatchObject({
      currentVersionId: current.id,
    });
    expect(await prisma.activityEvent.count()).toBe(0);
  });

  it.each([null, 'https://example.com/previous'])(
    'createDraft는 현재 주소가 null이면 지난 주소(%s)를 가져오지 않고 설명도 비운다',
    async (previousTestUrl) => {
      const previous = await prisma.deliveryVersion.create({
        data: {
          projectId,
          number: 0,
          status: 'IN_REVIEW',
          publishedAt,
          summary: '지난 설명',
          testUrl: previousTestUrl,
        },
      });
      const current = await prisma.deliveryVersion.create({
        data: { projectId, number: 1, status: 'IN_REVIEW', publishedAt, summary: '현재 설명', testUrl: null },
      });
      await prisma.project.update({ where: { id: projectId }, data: { currentVersionId: current.id } });

      const draft = await service.createDraft(projectId, developerId);

      expect(draft).toMatchObject({ summary: '', testUrl: null });
      expect(await prisma.deliveryVersion.findUniqueOrThrow({ where: { id: draft.id } })).toMatchObject({
        summary: '',
        testUrl: null,
      });
      expect(await prisma.deliveryVersion.findUniqueOrThrow({ where: { id: current.id } })).toEqual(current);
      expect(await prisma.deliveryVersion.findUniqueOrThrow({ where: { id: previous.id } })).toEqual(previous);
    },
  );

  it.each(['https://example.com/new', null])(
    '이어받은 테스트 주소를 updateDraft로 %s로 바꿔도 현재 버전의 주소와 설명은 그대로다',
    async (testUrl) => {
      const current = await prisma.deliveryVersion.create({
        data: {
          projectId,
          number: 0,
          status: 'IN_REVIEW',
          publishedAt,
          summary: '게시한 설명',
          testUrl: 'https://example.com/current',
        },
      });
      await prisma.project.update({ where: { id: projectId }, data: { currentVersionId: current.id } });
      const draft = await service.createDraft(projectId, developerId);
      expect(draft).toMatchObject({ summary: '', testUrl: current.testUrl });

      const updated = await service.updateDraft(draft.id, developerId, { testUrl });

      expect(updated).toEqual({ ...draft, testUrl });
      expect(await service.getDetail(draft.id, developerId)).toEqual(updated);
      expect(await prisma.deliveryVersion.findUniqueOrThrow({ where: { id: current.id } })).toEqual(current);
      expect(await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).toMatchObject({
        currentVersionId: current.id,
      });
    },
  );

  it('createDraft는 현재 버전의 모든 화면이 숨겨졌으면 빈 초안을 만든다', async () => {
    const current = await prisma.deliveryVersion.create({
      data: { projectId, number: 1, status: 'IN_REVIEW', publishedAt },
    });
    await attachScreen(current.id, { name: '숨긴 화면', viewport: 'PC', hiddenAt });
    await prisma.project.update({ where: { id: projectId }, data: { currentVersionId: current.id } });

    expect(await service.createDraft(projectId, developerId)).toMatchObject({ screens: [] });
    expect(await prisma.asset.count()).toBe(1);
  });

  it('createDraft는 현재 버전의 모든 화면이 숨겨져도 테스트 주소는 복사하고 설명은 비운다', async () => {
    const current = await prisma.deliveryVersion.create({
      data: {
        projectId,
        number: 0,
        status: 'IN_REVIEW',
        publishedAt,
        summary: '숨기기 전 설명',
        testUrl: 'https://example.com/current',
      },
    });
    await attachScreen(current.id, { name: '숨긴 화면', viewport: 'PC', hiddenAt });
    await prisma.project.update({ where: { id: projectId }, data: { currentVersionId: current.id } });

    const draft = await service.createDraft(projectId, developerId);

    expect(draft).toMatchObject({ screens: [], summary: '', testUrl: current.testUrl });
    expect(await service.getDetail(draft.id, developerId)).toEqual(draft);
    expect(await prisma.deliveryVersion.findUniqueOrThrow({ where: { id: current.id } })).toEqual(current);
  });

  it('createDraft는 기존 초안이 있으면 DRAFT_EXISTS이며 기존 내용과 화면을 보존한다', async () => {
    const draft = await prisma.deliveryVersion.create({ data: { projectId, summary: '작성 중' } });
    const { link } = await attachScreen(draft.id, { name: '메인', viewport: 'PC' });

    expectConflict(await service.createDraft(projectId, developerId).catch((error: unknown) => error), 'DRAFT_EXISTS');
    expect(await prisma.deliveryVersion.findMany()).toEqual([draft]);
    expect(await prisma.versionScreen.findMany()).toEqual([link]);
  });

  it('createDraft를 동시에 두 번 요청하면 초안 하나와 DRAFT_EXISTS 하나가 남는다', async () => {
    const results = await Promise.allSettled([
      service.createDraft(projectId, developerId),
      service.createDraft(projectId, developerId),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const failures = results.filter((result) => result.status === 'rejected');
    expect(failures).toHaveLength(1);
    expectConflict(failures[0].reason, 'DRAFT_EXISTS');
    const saved = await prisma.deliveryVersion.findMany();
    expect(saved).toHaveLength(1);
    expect(results).toContainEqual({
      status: 'fulfilled',
      value: {
        id: saved[0].id,
        projectId,
        number: null,
        status: 'DRAFT',
        summary: '',
        testUrl: null,
        publishedAt: null,
        screens: [],
      },
    });
  });

  it('createDraft는 프로젝트마다 초안을 하나씩 허용한다', async () => {
    const first = await service.createDraft(projectId, developerId);
    const second = await service.createDraft(otherProjectId, outsiderId);
    expect(first.projectId).toBe(projectId);
    expect(second.projectId).toBe(otherProjectId);
    expect(await prisma.deliveryVersion.count({ where: { status: 'DRAFT' } })).toBe(2);
  });

  it.each([false, true])(
    'createDraft는 기존 초안 유무(%s)와 관계없이 클라이언트에게 403을 반환한다',
    async (hasDraft) => {
      if (hasDraft) await prisma.deliveryVersion.create({ data: { projectId: otherProjectId } });
      const before = await prisma.deliveryVersion.findMany();
      await expect(service.createDraft(otherProjectId, developerId)).rejects.toBeInstanceOf(ForbiddenException);
      expect(await prisma.deliveryVersion.findMany()).toEqual(before);
    },
  );

  it.each(['getDetail', 'loadDetail'] as const)(
    '%s는 화면을 이름표 생성순으로 반환하고 숨긴 화면도 유지한다',
    async (method) => {
      const version = await prisma.deliveryVersion.create({
        data: { projectId, summary: '설명', testUrl: 'https://example.com' },
      });
      const newer = await attachScreen(version.id, {
        name: '가',
        viewport: 'PC',
        createdAt: new Date('2026-01-03T00:00:00Z'),
      });
      const older = await attachScreen(version.id, {
        name: '나',
        viewport: 'MOBILE',
        hiddenAt,
        createdAt: publishedAt,
      });
      const result =
        method === 'getDetail'
          ? await service.getDetail(version.id, developerId)
          : await service.loadDetail(version.id);

      expect(result).toEqual({
        id: version.id,
        projectId,
        number: null,
        status: 'DRAFT',
        summary: '설명',
        testUrl: 'https://example.com',
        publishedAt: null,
        screens: [
          {
            screenId: older.screen.id,
            name: '나',
            viewport: 'MOBILE',
            hiddenAt,
            asset: { id: older.asset.id, width: 800, height: 600 },
          },
          {
            screenId: newer.screen.id,
            name: '가',
            viewport: 'PC',
            hiddenAt: null,
            asset: { id: newer.asset.id, width: 800, height: 600 },
          },
        ],
      });
    },
  );

  it.each(['IN_REVIEW', 'APPROVED'] as const)(
    'getDetail은 클라이언트에게 지난 %s 버전과 숨긴 화면도 보여 준다',
    async (status) => {
      const version = await prisma.deliveryVersion.create({ data: { projectId, number: 1, status, publishedAt } });
      const { screen, asset } = await attachScreen(version.id, { name: '메인', viewport: 'PC', hiddenAt });
      const current = await prisma.deliveryVersion.create({
        data: { projectId, number: 2, status: 'IN_REVIEW', publishedAt },
      });
      await prisma.project.update({ where: { id: projectId }, data: { currentVersionId: current.id } });

      await expect(service.getDetail(version.id, clientId)).resolves.toEqual({
        id: version.id,
        projectId,
        number: 1,
        status,
        summary: '',
        testUrl: null,
        publishedAt,
        screens: [
          {
            screenId: screen.id,
            name: '메인',
            viewport: 'PC',
            hiddenAt,
            asset: { id: asset.id, width: 800, height: 600 },
          },
        ],
      });
    },
  );

  const versionRequests = [
    { name: 'getDetail', run: (id: string, userId: string) => service.getDetail(id, userId) },
    {
      name: 'updateDraft',
      run: (id: string, userId: string) => service.updateDraft(id, userId, { summary: '바꾸기' }),
    },
    { name: 'publish', run: (id: string, userId: string) => service.publish(id, userId) },
    { name: 'requireDeveloperOf', run: (id: string, userId: string) => service.requireDeveloperOf(id, userId) },
    {
      name: 'lockDraft',
      run: (id: string, userId: string) => prisma.$transaction((tx) => service.lockDraft(tx, id, userId)),
    },
  ];

  it.each(versionRequests)('$name은 클라이언트의 초안·비멤버의 버전·없는 id에 같은 404를 반환한다', async ({ run }) => {
    const draft = await prisma.deliveryVersion.create({ data: { projectId } });
    const published = await prisma.deliveryVersion.create({
      data: { projectId, number: 1, status: 'IN_REVIEW', publishedAt },
    });
    expectNotFound(await run(draft.id, clientId).catch((error: unknown) => error), '없는 버전이에요');
    expectNotFound(await run(draft.id, outsiderId).catch((error: unknown) => error), '없는 버전이에요');
    expectNotFound(await run(published.id, outsiderId).catch((error: unknown) => error), '없는 버전이에요');
    expectNotFound(await run(missingId, developerId).catch((error: unknown) => error), '없는 버전이에요');
    expect(await prisma.deliveryVersion.findUnique({ where: { id: draft.id } })).toEqual(draft);
    expect(await prisma.deliveryVersion.findUnique({ where: { id: published.id } })).toEqual(published);
    expect(await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).toMatchObject({
      currentVersionId: null,
    });
    expect(await prisma.activityEvent.count()).toBe(0);
  });

  it.each(versionRequests.filter(({ name }) => name !== 'getDetail'))(
    '$name은 다른 프로젝트의 개발자라도 여기서 클라이언트면 초안 404·게시 버전 403이다',
    async ({ run }) => {
      const draft = await prisma.deliveryVersion.create({ data: { projectId: otherProjectId } });
      const published = await prisma.deliveryVersion.create({
        data: { projectId: otherProjectId, number: 1, status: 'IN_REVIEW', publishedAt },
      });
      expectNotFound(await run(draft.id, developerId).catch((error: unknown) => error), '없는 버전이에요');
      await expect(run(published.id, developerId)).rejects.toBeInstanceOf(ForbiddenException);
      expect(await prisma.deliveryVersion.findUnique({ where: { id: draft.id } })).toEqual(draft);
      expect(await prisma.deliveryVersion.findUnique({ where: { id: published.id } })).toEqual(published);
      expect(await prisma.activityEvent.count()).toBe(0);
    },
  );

  it.each(['IN_REVIEW', 'APPROVED'] as const)(
    'updateDraft·publish·lockDraft는 %s를 개발자 409·클라이언트 403으로 거절한다',
    async (status) => {
      const version = await prisma.deliveryVersion.create({ data: { projectId, number: 1, status, publishedAt } });
      // 화면이 없는 게시 버전이어도 권한과 DRAFT 검사가 NO_SCREENS보다 먼저다.
      for (const { run } of versionRequests.filter(({ name }) =>
        ['updateDraft', 'publish', 'lockDraft'].includes(name),
      )) {
        expectConflict(await run(version.id, developerId).catch((error: unknown) => error), 'VERSION_NOT_DRAFT');
        await expect(run(version.id, clientId)).rejects.toBeInstanceOf(ForbiddenException);
      }
      expect(await prisma.deliveryVersion.findUnique({ where: { id: version.id } })).toEqual(version);
      expect(await prisma.activityEvent.count()).toBe(0);
    },
  );

  it.each([
    {
      changes: { summary: '새 설명', testUrl: 'https://example.com/new' },
      summary: '새 설명',
      testUrl: 'https://example.com/new',
    },
    { changes: { summary: '' }, summary: '', testUrl: 'https://example.com/old' },
    { changes: { testUrl: 'https://example.com/new' }, summary: '기존 설명', testUrl: 'https://example.com/new' },
    { changes: { testUrl: null }, summary: '기존 설명', testUrl: null },
    { changes: {}, summary: '기존 설명', testUrl: 'https://example.com/old' },
  ])('updateDraft는 $changes만 바꾸고 생략한 칸·화면·상태를 보존한다', async ({ changes, summary, testUrl }) => {
    const draft = await prisma.deliveryVersion.create({
      data: { projectId, summary: '기존 설명', testUrl: 'https://example.com/old' },
    });
    const { link } = await attachScreen(draft.id, { name: '메인', viewport: 'PC' });
    const before = await service.getDetail(draft.id, developerId);

    await expect(service.updateDraft(draft.id, developerId, changes)).resolves.toEqual({ ...before, summary, testUrl });
    expect(await prisma.deliveryVersion.findUnique({ where: { id: draft.id } })).toEqual({
      ...draft,
      summary,
      testUrl,
    });
    expect(await prisma.versionScreen.findMany()).toEqual([link]);
    expect(await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).toMatchObject({
      currentVersionId: null,
    });
    expect(await prisma.activityEvent.count()).toBe(0);
  });

  it('publish는 1차·2차 번호와 게시 시각·현재 버전·일지를 저장하며 지난 사진을 유지한다', async () => {
    const draft = await service.createDraft(projectId, developerId);
    const { screen, asset, link } = await attachScreen(draft.id, { name: '메인', viewport: 'PC' });
    await service.updateDraft(draft.id, developerId, { summary: '첫 설명', testUrl: 'https://example.com' });
    const startedAt = Date.now();

    const first = await service.publish(draft.id, developerId);

    expect(first).toEqual({
      id: draft.id,
      projectId,
      number: 0,
      status: 'IN_REVIEW',
      summary: '첫 설명',
      testUrl: 'https://example.com',
      publishedAt: expect.any(Date),
      screens: [
        {
          screenId: screen.id,
          name: '메인',
          viewport: 'PC',
          hiddenAt: null,
          asset: { id: asset.id, width: 800, height: 600 },
        },
      ],
    });
    expect(first.publishedAt!.getTime()).toBeGreaterThanOrEqual(startedAt);
    expect(first.publishedAt!.getTime()).toBeLessThanOrEqual(Date.now());
    expect(await prisma.deliveryVersion.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({
      number: 0,
      status: 'IN_REVIEW',
      publishedAt: first.publishedAt,
    });
    expect(await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).toMatchObject({
      currentVersionId: first.id,
    });
    const next = await service.createDraft(projectId, developerId);
    expect(next.screens).toEqual(first.screens);
    const second = await service.publish(next.id, developerId);
    expect(second).toEqual({ ...next, number: 1, status: 'IN_REVIEW', publishedAt: expect.any(Date) });
    expect(await service.getDetail(first.id, clientId)).toEqual(first);
    expect(await service.getDetail(second.id, clientId)).toEqual(second);
    expect(await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).toMatchObject({
      currentVersionId: second.id,
    });
    expect(await prisma.versionScreen.findUnique({ where: { id: link.id } })).toEqual(link);
    expect(await prisma.asset.findMany()).toEqual([asset]);
    const events = await prisma.activityEvent.findMany({ orderBy: { version: { number: 'asc' } } });
    expect(events).toEqual(
      [first, second].map((version) => ({
        id: expect.any(String),
        projectId,
        actorId: developerId,
        type: 'VERSION_PUBLISHED',
        versionId: version.id,
        memberId: null,
        issueId: null,
        createdAt: expect.any(Date),
      })),
    );
  });

  it('publish는 이 프로젝트의 확인 요청 쪽지만 모두 수정 중으로 바꾸고 고쳤어요 줄과 다른 쪽지는 보존한다', async () => {
    const current = await prisma.deliveryVersion.create({
      data: { projectId, number: 2, status: 'IN_REVIEW', publishedAt },
    });
    await prisma.project.update({ where: { id: projectId }, data: { currentVersionId: current.id } });
    const { link } = await attachScreen(current.id, { name: '메인', viewport: 'PC' });
    const statuses = ['READY_FOR_REVIEW', 'READY_FOR_REVIEW', 'OPEN', 'IN_PROGRESS', 'VERIFIED', 'WITHDRAWN'] as const;
    for (const [index, status] of statuses.entries()) {
      await prisma.issue.create({
        data: {
          projectId,
          originVersionId: current.id,
          authorId: clientId,
          requestId: randomUUID(),
          number: index + 1,
          title: `게시 전 ${status} 쪽지 ${index + 1}`,
          body: '쪽지 내용도 그대로 남아요',
          status,
          attempts: {
            create: {
              versionId: current.id,
              versionScreenId: link.id,
              summary: '고친 내용',
              submittedById: developerId,
              ...(status === 'VERIFIED' ? { result: 'VERIFIED', reviewedById: clientId, reviewedAt: publishedAt } : {}),
              ...(status === 'OPEN' ? { result: 'REOPENED', reviewedById: clientId, reviewedAt: publishedAt } : {}),
            },
          },
        },
      });
    }
    const otherVersion = await prisma.deliveryVersion.create({
      data: { projectId: otherProjectId, number: 2, status: 'IN_REVIEW', publishedAt },
    });
    await prisma.issue.create({
      data: {
        projectId: otherProjectId,
        originVersionId: otherVersion.id,
        authorId: developerId,
        requestId: randomUUID(),
        number: 1,
        title: '다른 프로젝트의 확인 요청',
        body: '다른 프로젝트를 게시해도 그대로예요',
        status: 'READY_FOR_REVIEW',
        attempts: {
          create: { versionId: otherVersion.id, summary: '다른 수정', submittedById: outsiderId },
        },
      },
    });
    const draft = await service.createDraft(projectId, developerId);
    const issuesBefore = await prisma.issue.findMany({ orderBy: { id: 'asc' } });
    const attemptsBefore = await prisma.resolutionAttempt.findMany({ orderBy: { id: 'asc' } });

    expect(await service.publish(draft.id, developerId)).toMatchObject({ number: 3, status: 'IN_REVIEW' });

    expect(await prisma.issue.findMany({ orderBy: { id: 'asc' } })).toEqual(
      issuesBefore.map((issue) => ({
        ...issue,
        status: issue.projectId === projectId && issue.status === 'READY_FOR_REVIEW' ? 'IN_PROGRESS' : issue.status,
      })),
    );
    expect(await prisma.resolutionAttempt.findMany({ orderBy: { id: 'asc' } })).toEqual(attemptsBefore);
    expect(await prisma.comment.count()).toBe(0);
    expect(await prisma.activityEvent.findMany()).toEqual([
      expect.objectContaining({
        projectId,
        actorId: developerId,
        type: 'VERSION_PUBLISHED',
        versionId: draft.id,
        issueId: null,
      }),
    ]);
  });

  it.each([false, true])(
    'publish의 일지 저장 실패(저장 후 실패=%s)는 확인 요청 쪽지와 고쳤어요 줄도 되돌린다',
    async (failAfterWrite) => {
      const current = await prisma.deliveryVersion.create({
        data: { projectId, number: 2, status: 'IN_REVIEW', publishedAt },
      });
      await prisma.project.update({ where: { id: projectId }, data: { currentVersionId: current.id } });
      await attachScreen(current.id, { name: '메인', viewport: 'PC' });
      for (const number of [1, 2]) {
        await prisma.issue.create({
          data: {
            projectId,
            originVersionId: current.id,
            authorId: clientId,
            requestId: randomUUID(),
            number,
            title: `확인 요청 ${number}`,
            body: '게시가 실패하면 확인 요청 그대로예요',
            status: 'READY_FOR_REVIEW',
            attempts: {
              create: { versionId: current.id, summary: '고친 내용', submittedById: developerId },
            },
          },
        });
      }
      const oldEvent = await prisma.activityEvent.create({
        data: { projectId, actorId: developerId, type: 'VERSION_PUBLISHED', versionId: current.id },
      });
      const draft = await service.createDraft(projectId, developerId);
      const issuesBefore = await prisma.issue.findMany({ orderBy: { id: 'asc' } });
      const attemptsBefore = await prisma.resolutionAttempt.findMany({ orderBy: { id: 'asc' } });
      const failure = new Error('게시 일지 저장 실패');
      const record = activity.record.bind(activity);
      vi.spyOn(activity, 'record').mockImplementationOnce(async (tx, event) => {
        if (failAfterWrite) await record(tx, event);
        throw failure;
      });

      await expect(service.publish(draft.id, developerId)).rejects.toBe(failure);

      expect(await service.getDetail(draft.id, developerId)).toEqual(draft);
      expect(await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).toMatchObject({
        currentVersionId: current.id,
      });
      expect(await prisma.issue.findMany({ orderBy: { id: 'asc' } })).toEqual(issuesBefore);
      expect(await prisma.resolutionAttempt.findMany({ orderBy: { id: 'asc' } })).toEqual(attemptsBefore);
      expect(await prisma.activityEvent.findMany()).toEqual([oldEvent]);
      expect(await prisma.comment.count()).toBe(0);

      expect(await service.publish(draft.id, developerId)).toMatchObject({ number: 3, status: 'IN_REVIEW' });
      expect(await prisma.issue.findMany({ orderBy: { id: 'asc' } })).toEqual(
        issuesBefore.map((issue) => ({ ...issue, status: 'IN_PROGRESS' })),
      );
      expect(await prisma.resolutionAttempt.findMany({ orderBy: { id: 'asc' } })).toEqual(attemptsBefore);
      expect(await prisma.activityEvent.count()).toBe(2);
    },
  );

  it('publish는 현재 버전이나 개수가 아닌 이 프로젝트의 최대 번호에 1을 더한다', async () => {
    const current = await prisma.deliveryVersion.create({
      data: { projectId, number: 1, status: 'IN_REVIEW', publishedAt },
    });
    await prisma.deliveryVersion.create({ data: { projectId, number: 7, status: 'APPROVED', publishedAt } });
    await prisma.deliveryVersion.create({
      data: { projectId: otherProjectId, number: 99, status: 'IN_REVIEW', publishedAt },
    });
    await prisma.project.update({ where: { id: projectId }, data: { currentVersionId: current.id } });
    const draft = await prisma.deliveryVersion.create({ data: { projectId } });
    await attachScreen(draft.id, { name: '메인', viewport: 'PC' });

    expect(await service.publish(draft.id, developerId)).toMatchObject({ number: 8, status: 'IN_REVIEW' });
  });

  it('publish는 화면 20개도 모두 보존하며 게시한다', async () => {
    const draft = await prisma.deliveryVersion.create({ data: { projectId } });
    for (let index = 0; index < 20; index += 1) {
      await attachScreen(draft.id, {
        name: `화면 ${index}`,
        viewport: 'PC',
        createdAt: new Date(publishedAt.getTime() + index),
      });
    }
    const before = await service.getDetail(draft.id, developerId);
    expect(await service.publish(draft.id, developerId)).toEqual({
      ...before,
      number: 0,
      status: 'IN_REVIEW',
      publishedAt: expect.any(Date),
    });
    expect(await prisma.versionScreen.count({ where: { versionId: draft.id } })).toBe(20);
  });

  it.each(['NO_SCREENS', 'SCREEN_HIDDEN'] as const)(
    'publish가 %s면 번호·현재 버전·일지와 화면을 바꾸지 않는다',
    async (code) => {
      const current = await prisma.deliveryVersion.create({
        data: { projectId, number: 1, status: 'IN_REVIEW', publishedAt },
      });
      await prisma.project.update({ where: { id: projectId }, data: { currentVersionId: current.id } });
      const draft = await prisma.deliveryVersion.create({ data: { projectId, summary: '작성 중' } });
      if (code === 'SCREEN_HIDDEN') {
        await attachScreen(draft.id, { name: '보이는 화면', viewport: 'PC' });
        const { screen } = await attachScreen(draft.id, { name: '나중에 숨긴 화면', viewport: 'MOBILE' });
        await prisma.screen.update({ where: { id: screen.id }, data: { hiddenAt } });
      }
      const links = await prisma.versionScreen.findMany({ orderBy: { id: 'asc' } });

      expectConflict(await service.publish(draft.id, developerId).catch((error: unknown) => error), code);
      expect(await prisma.deliveryVersion.findUnique({ where: { id: draft.id } })).toEqual(draft);
      expect(await prisma.deliveryVersion.findUnique({ where: { id: current.id } })).toEqual(current);
      expect(await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).toMatchObject({
        currentVersionId: current.id,
      });
      expect(await prisma.activityEvent.count()).toBe(0);
      expect(await prisma.versionScreen.findMany({ orderBy: { id: 'asc' } })).toEqual(links);
    },
  );

  it('publish를 동시에 두 번 요청하면 한 번만 게시하고 다른 요청은 VERSION_NOT_DRAFT다', async () => {
    const draft = await prisma.deliveryVersion.create({ data: { projectId } });
    await attachScreen(draft.id, { name: '메인', viewport: 'PC' });
    const results = await Promise.allSettled([
      service.publish(draft.id, developerId),
      service.publish(draft.id, developerId),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const failures = results.filter((result) => result.status === 'rejected');
    expect(failures).toHaveLength(1);
    expectConflict(failures[0].reason, 'VERSION_NOT_DRAFT');
    expect(await prisma.deliveryVersion.findUniqueOrThrow({ where: { id: draft.id } })).toMatchObject({
      number: 0,
      status: 'IN_REVIEW',
      publishedAt: expect.any(Date),
    });
    expect(await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).toMatchObject({
      currentVersionId: draft.id,
    });
    expect(await prisma.activityEvent.findMany()).toEqual([
      {
        id: expect.any(String),
        projectId,
        actorId: developerId,
        type: 'VERSION_PUBLISHED',
        versionId: draft.id,
        memberId: null,
        issueId: null,
        createdAt: expect.any(Date),
      },
    ]);
  });

  it.each([false, true])(
    '첫 게시의 일지 저장 실패(저장 후 실패=%s)도 번호를 소비하지 않고 재시도는 0부터 시작한다',
    async (failAfterWrite) => {
      const draft = await service.createDraft(projectId, developerId);
      await attachScreen(draft.id, { name: '메인', viewport: 'PC' });
      const failure = new Error('첫 게시 일지 저장 실패');
      const record = activity.record.bind(activity);
      vi.spyOn(activity, 'record').mockImplementationOnce(async (tx, event) => {
        if (failAfterWrite) await record(tx, event);
        throw failure;
      });

      await expect(service.publish(draft.id, developerId)).rejects.toBe(failure);
      expect(await prisma.deliveryVersion.findUniqueOrThrow({ where: { id: draft.id } })).toMatchObject({
        number: null,
        status: 'DRAFT',
        publishedAt: null,
      });
      expect(await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).toMatchObject({
        currentVersionId: null,
      });
      expect(await prisma.activityEvent.count()).toBe(0);

      expect(await service.publish(draft.id, developerId)).toMatchObject({ number: 0, status: 'IN_REVIEW' });
      const next = await service.createDraft(projectId, developerId);
      expect(await service.publish(next.id, developerId)).toMatchObject({ number: 1, status: 'IN_REVIEW' });
      expect(
        await prisma.deliveryVersion.findMany({
          where: { projectId },
          orderBy: { number: 'asc' },
          select: { id: true, number: true },
        }),
      ).toEqual([
        { id: draft.id, number: 0 },
        { id: next.id, number: 1 },
      ]);
      expect(await prisma.activityEvent.count()).toBe(2);
    },
  );

  it.each([false, true])(
    '일지 저장 실패(저장 후 실패=%s)는 게시 전체를 취소하고 재시도 때 같은 다음 번호를 쓴다',
    async (failAfterWrite) => {
      const current = await prisma.deliveryVersion.create({
        data: { projectId, number: 1, status: 'IN_REVIEW', publishedAt },
      });
      await prisma.project.update({ where: { id: projectId }, data: { currentVersionId: current.id } });
      const oldEvent = await prisma.activityEvent.create({
        data: { projectId, actorId: developerId, type: 'VERSION_PUBLISHED', versionId: current.id },
      });
      const draft = await prisma.deliveryVersion.create({ data: { projectId, summary: '두 번째' } });
      const { link, asset } = await attachScreen(draft.id, { name: '메인', viewport: 'PC' });
      const failure = new Error('일지 저장 실패');
      const record = activity.record.bind(activity);
      vi.spyOn(activity, 'record').mockImplementationOnce(async (tx, event) => {
        if (failAfterWrite) await record(tx, event);
        throw failure;
      });

      await expect(service.publish(draft.id, developerId)).rejects.toBe(failure);

      expect(await prisma.deliveryVersion.findUnique({ where: { id: draft.id } })).toEqual(draft);
      expect(await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).toMatchObject({
        currentVersionId: current.id,
      });
      expect(await prisma.activityEvent.findMany()).toEqual([oldEvent]);
      expect(await prisma.versionScreen.findMany()).toEqual([link]);
      expect(await prisma.asset.findMany()).toEqual([asset]);
      expect(await service.publish(draft.id, developerId)).toMatchObject({ number: 2, status: 'IN_REVIEW' });
      expect(await prisma.activityEvent.count()).toBe(2);
    },
  );

  it.each(['DRAFT', 'IN_REVIEW', 'APPROVED'] as const)(
    'requireDeveloperOf는 개발자에게 %s의 프로젝트와 상태를 반환한다',
    async (status) => {
      const version = await prisma.deliveryVersion.create({
        data: {
          projectId,
          status,
          number: status === 'DRAFT' ? null : 1,
          publishedAt: status === 'DRAFT' ? null : publishedAt,
        },
      });
      await expect(service.requireDeveloperOf(version.id, developerId)).resolves.toEqual({ projectId, status });
    },
  );

  it('공용 함수는 전달된 트랜잭션의 아직 커밋하지 않은 버전과 역할·상세를 읽는다', async () => {
    await prisma.$transaction(async (tx) => {
      // 바깥 DB 연결에는 아직 이 역할 변경과 버전이 보이지 않는다.
      await tx.projectMember.delete({ where: { projectId_userId: { projectId, userId: developerId } } });
      await tx.projectMember.update({
        where: { projectId_userId: { projectId, userId: clientId } },
        data: { role: 'DEVELOPER' },
      });
      const draft = await tx.deliveryVersion.create({ data: { projectId, summary: '커밋 전' } });

      await expect(service.requireDeveloperOf(draft.id, clientId, tx)).resolves.toEqual({ projectId, status: 'DRAFT' });
      await expect(service.lockDraft(tx, draft.id, clientId)).resolves.toBe(projectId);
      await expect(service.loadDetail(draft.id, tx)).resolves.toEqual({
        id: draft.id,
        projectId,
        number: null,
        status: 'DRAFT',
        summary: '커밋 전',
        testUrl: null,
        publishedAt: null,
        screens: [],
      });
    });
  });

  it.each(['updateDraft', 'publish', 'lockDraft'] as const)(
    '%s는 프로젝트 잠금을 기다린 뒤 이미 게시된 상태를 다시 확인한다',
    async (method) => {
      const draft = await prisma.deliveryVersion.create({ data: { projectId, summary: '원래 설명' } });
      await attachScreen(draft.id, { name: '메인', viewport: 'PC' });
      let request: Promise<unknown> | undefined;
      let settled = false;

      try {
        await prisma.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT id FROM projects WHERE id = ${projectId}::uuid FOR UPDATE`;
            const operation = versionRequests.find(({ name }) => name === method)!;
            request = operation
              .run(draft.id, developerId)
              .catch((error: unknown) => error)
              .finally(() => {
                settled = true;
              });
            await new Promise<void>((resolve) => {
              setTimeout(resolve, 200);
            });
            expect(settled).toBe(false);
            expect(await tx.deliveryVersion.findUnique({ where: { id: draft.id } })).toEqual(draft);
            // 먼저 잠근 게시 작업이 끝난 상황을 만든다.
            await tx.deliveryVersion.update({
              where: { id: draft.id },
              data: { number: 1, status: 'IN_REVIEW', publishedAt },
            });
            await tx.project.update({ where: { id: projectId }, data: { currentVersionId: draft.id } });
            await activity.record(tx, {
              projectId,
              actorId: developerId,
              type: 'VERSION_PUBLISHED',
              versionId: draft.id,
            });
          },
          { maxWait: 5_000, timeout: 10_000 },
        );
      } finally {
        // 검증이 실패해도 잠금이 풀린 뒤 요청을 끝내 다음 DB 초기화와 겹치지 않게 한다.
        await request;
      }

      expectConflict(await request, 'VERSION_NOT_DRAFT');
      expect(await prisma.deliveryVersion.findUnique({ where: { id: draft.id } })).toEqual({
        ...draft,
        number: 1,
        status: 'IN_REVIEW',
        publishedAt,
      });
      expect(await prisma.activityEvent.count()).toBe(1);
    },
    20_000,
  );

  it.each(['createDraft', 'updateDraft', 'publish'] as const)(
    '%s는 잠금을 기다리는 동안 멤버가 제거되면 404이고 아무것도 쓰지 않는다',
    async (method) => {
      const draft = method === 'createDraft' ? null : await prisma.deliveryVersion.create({ data: { projectId } });
      if (draft) await attachScreen(draft.id, { name: '메인', viewport: 'PC' });
      const versionsBefore = await prisma.deliveryVersion.findMany();
      let request: Promise<unknown> | undefined;
      let settled = false;

      try {
        await prisma.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT id FROM projects WHERE id = ${projectId}::uuid FOR UPDATE`;
            const operation =
              method === 'createDraft'
                ? service.createDraft(projectId, developerId)
                : versionRequests.find(({ name }) => name === method)!.run(draft!.id, developerId);
            request = operation
              .catch((error: unknown) => error)
              .finally(() => {
                settled = true;
              });
            await new Promise<void>((resolve) => {
              setTimeout(resolve, 200);
            });
            expect(settled).toBe(false);
            await tx.projectMember.delete({ where: { projectId_userId: { projectId, userId: developerId } } });
          },
          { maxWait: 5_000, timeout: 10_000 },
        );
      } finally {
        await request;
      }

      expectNotFound(await request, method === 'createDraft' ? '없는 프로젝트예요' : '없는 버전이에요');
      expect(await prisma.deliveryVersion.findMany()).toEqual(versionsBefore);
      expect(await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).toMatchObject({
        currentVersionId: null,
      });
      expect(await prisma.activityEvent.count()).toBe(0);
    },
    20_000,
  );
});
