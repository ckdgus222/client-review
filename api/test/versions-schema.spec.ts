import { PrismaService } from '../src/prisma/prisma.service.js';
import { resetDatabase } from './reset-database.js';

describe('버전과 사진 테이블', () => {
  const prisma = new PrismaService();
  const missingId = '00000000-0000-4000-8000-000000000001';
  const publishedAt = new Date('2026-11-06T00:00:00.000Z');
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const imageData = { mime: 'image/png', bytes: 100, width: 10, height: 20 };

  const createVersionScreen = async () => {
    const project = await prisma.project.create({ data: { name: '프로젝트' } });
    const version = await prisma.deliveryVersion.create({ data: { projectId: project.id } });
    const screen = await prisma.screen.create({
      data: { projectId: project.id, name: '메인', viewport: 'PC' },
    });
    const asset = await prisma.asset.create({
      data: { projectId: project.id, storageKey: `${project.id}/image.png`, ...imageData },
    });
    const versionScreen = await prisma.versionScreen.create({
      data: { versionId: version.id, screenId: screen.id, assetId: asset.id },
    });
    return { project, version, screen, asset, versionScreen };
  };

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it.each([
    { indexName: 'assets_project_id_idx', tableName: 'assets', columns: ['project_id'] },
    { indexName: 'version_screens_asset_id_idx', tableName: 'version_screens', columns: ['asset_id'] },
    { indexName: 'project_members_user_id_idx', tableName: 'project_members', columns: ['user_id'] },
    {
      indexName: 'activity_events_project_id_created_at_idx',
      tableName: 'activity_events',
      columns: ['project_id', 'created_at'],
    },
  ])('$indexName의 테이블·열 순서와 일반 인덱스 여부를 확인한다', async ({ indexName, tableName, columns }) => {
    const indexes = await prisma.$queryRaw<{ schemaname: string; tablename: string; indexdef: string }[]>`
      SELECT schemaname, tablename, indexdef
      FROM pg_indexes
      WHERE schemaname = current_schema() AND indexname = ${indexName}
    `;

    expect(indexes).toHaveLength(1);
    expect(indexes[0].tablename).toBe(tableName);
    expect(indexes[0].indexdef).toBe(
      `CREATE INDEX ${indexName} ON ${indexes[0].schemaname}.${tableName} USING btree (${columns.join(', ')})`,
    );
  });

  it('같은 프로젝트에는 초안을 두 개 만들 수 없다', async () => {
    const project = await prisma.project.create({ data: { name: '프로젝트' } });
    const draft = await prisma.deliveryVersion.create({ data: { projectId: project.id } });

    await expect(prisma.deliveryVersion.create({ data: { projectId: project.id } })).rejects.toMatchObject({
      code: 'P2002',
    });
    expect(await prisma.deliveryVersion.findMany()).toEqual([draft]);
  });

  it('서로 다른 프로젝트에는 초안을 하나씩 만들 수 있다', async () => {
    const firstProject = await prisma.project.create({ data: { name: '첫 프로젝트' } });
    const secondProject = await prisma.project.create({ data: { name: '둘째 프로젝트' } });

    await prisma.deliveryVersion.createMany({
      data: [{ projectId: firstProject.id }, { projectId: secondProject.id }],
    });

    expect(await prisma.deliveryVersion.count({ where: { projectId: firstProject.id, status: 'DRAFT' } })).toBe(1);
    expect(await prisma.deliveryVersion.count({ where: { projectId: secondProject.id, status: 'DRAFT' } })).toBe(1);
  });

  it('동시에 같은 프로젝트의 초안을 만들면 하나만 저장된다', async () => {
    const project = await prisma.project.create({ data: { name: '프로젝트' } });
    const data = { projectId: project.id };

    const results = await Promise.allSettled([
      prisma.deliveryVersion.create({ data }),
      prisma.deliveryVersion.create({ data }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: 'P2002' }) }),
    ]);
    expect(await prisma.deliveryVersion.findMany()).toEqual([
      expect.objectContaining({ projectId: project.id, status: 'DRAFT', number: null, publishedAt: null }),
    ]);
  });

  it('한 프로젝트에 초안 하나와 IN_REVIEW·APPROVED 버전 여러 개를 함께 둘 수 있다', async () => {
    const project = await prisma.project.create({ data: { name: '프로젝트' } });

    await prisma.deliveryVersion.createMany({
      data: [
        { projectId: project.id },
        { projectId: project.id, status: 'IN_REVIEW', number: 1, publishedAt },
        { projectId: project.id, status: 'IN_REVIEW', number: 2, publishedAt },
        { projectId: project.id, status: 'APPROVED', number: 3, publishedAt },
        { projectId: project.id, status: 'APPROVED', number: 4, publishedAt },
      ],
    });

    expect(await prisma.deliveryVersion.count({ where: { status: 'DRAFT' } })).toBe(1);
    expect(await prisma.deliveryVersion.count({ where: { status: 'IN_REVIEW' } })).toBe(2);
    expect(await prisma.deliveryVersion.count({ where: { status: 'APPROVED' } })).toBe(2);
  });

  it('초안을 게시 상태로 바꾸면 같은 프로젝트에 다음 초안을 만들 수 있다', async () => {
    const project = await prisma.project.create({ data: { name: '프로젝트' } });
    const draft = await prisma.deliveryVersion.create({ data: { projectId: project.id } });

    const published = await prisma.deliveryVersion.update({
      where: { id: draft.id },
      data: { status: 'IN_REVIEW', number: 1, publishedAt },
    });
    const nextDraft = await prisma.deliveryVersion.create({ data: { projectId: project.id } });

    expect(published).toMatchObject({ status: 'IN_REVIEW', number: 1, publishedAt });
    expect(nextDraft).toMatchObject({ status: 'DRAFT', number: null, publishedAt: null });
    expect(await prisma.deliveryVersion.count()).toBe(2);
  });

  it('초안이 이미 있으면 다른 버전을 초안으로 바꾸는 것도 거부한다', async () => {
    const project = await prisma.project.create({ data: { name: '프로젝트' } });
    await prisma.deliveryVersion.create({ data: { projectId: project.id } });
    const published = await prisma.deliveryVersion.create({
      data: { projectId: project.id, status: 'IN_REVIEW', number: 1, publishedAt },
    });

    await expect(
      prisma.deliveryVersion.update({
        where: { id: published.id },
        data: { status: 'DRAFT', number: null, publishedAt: null },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(await prisma.deliveryVersion.findUnique({ where: { id: published.id } })).toEqual(published);
  });

  it.each(['IN_REVIEW', 'APPROVED'] as const)(
    '같은 프로젝트의 버전 번호는 %s 상태에서도 겹칠 수 없다',
    async (status) => {
      const project = await prisma.project.create({ data: { name: '프로젝트' } });
      const version = await prisma.deliveryVersion.create({
        data: { projectId: project.id, status: 'IN_REVIEW', number: 1, publishedAt },
      });

      await expect(
        prisma.deliveryVersion.create({
          data: { projectId: project.id, status, number: 1, publishedAt },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
      expect(await prisma.deliveryVersion.findMany()).toEqual([version]);
    },
  );

  it('다른 프로젝트는 같은 버전 번호를 쓸 수 있다', async () => {
    const firstProject = await prisma.project.create({ data: { name: '첫 프로젝트' } });
    const secondProject = await prisma.project.create({ data: { name: '둘째 프로젝트' } });

    await prisma.deliveryVersion.createMany({
      data: [
        { projectId: firstProject.id, status: 'IN_REVIEW', number: 1, publishedAt },
        { projectId: secondProject.id, status: 'IN_REVIEW', number: 1, publishedAt },
      ],
    });

    expect(await prisma.deliveryVersion.count({ where: { number: 1 } })).toBe(2);
  });

  it('초안을 이미 쓰는 번호로 게시 상태로 바꾸면 거부하고 초안을 그대로 둔다', async () => {
    const project = await prisma.project.create({ data: { name: '프로젝트' } });
    await prisma.deliveryVersion.create({
      data: { projectId: project.id, status: 'IN_REVIEW', number: 1, publishedAt },
    });
    const draft = await prisma.deliveryVersion.create({ data: { projectId: project.id } });

    await expect(
      prisma.deliveryVersion.update({
        where: { id: draft.id },
        data: { status: 'IN_REVIEW', number: 1, publishedAt },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(await prisma.deliveryVersion.findUnique({ where: { id: draft.id } })).toEqual(draft);
  });

  const invalidVersionShapes = [
    { status: 'DRAFT', number: 1, publishedAt: null },
    { status: 'DRAFT', number: null, publishedAt },
    { status: 'DRAFT', number: 1, publishedAt },
    { status: 'IN_REVIEW', number: null, publishedAt: null },
    { status: 'IN_REVIEW', number: 1, publishedAt: null },
    { status: 'IN_REVIEW', number: null, publishedAt },
    { status: 'APPROVED', number: null, publishedAt: null },
    { status: 'APPROVED', number: 1, publishedAt: null },
    { status: 'APPROVED', number: null, publishedAt },
  ];

  it.each(invalidVersionShapes)(
    'CHECK는 잘못된 버전 생성($status, 번호=$number, 게시 시각=$publishedAt)을 거부한다',
    async ({ status, number, publishedAt: timestamp }) => {
      const project = await prisma.project.create({ data: { name: '프로젝트' } });

      // Prisma의 입력 검사가 아니라 DB의 CHECK 위반(23514)인지 확인한다.
      await expect(prisma.$executeRaw`
        INSERT INTO delivery_versions (project_id, status, number, published_at)
        VALUES (${project.id}::uuid, ${status}::version_status, ${number}::integer, ${timestamp}::timestamptz)
      `).rejects.toMatchObject({ code: 'P2010', message: expect.stringContaining('23514') });
      expect(await prisma.deliveryVersion.count()).toBe(0);
    },
  );

  it.each(invalidVersionShapes)(
    'CHECK는 잘못된 버전 수정($status, 번호=$number, 게시 시각=$publishedAt)을 거부한다',
    async ({ status, number, publishedAt: timestamp }) => {
      const project = await prisma.project.create({ data: { name: '프로젝트' } });
      const draft = await prisma.deliveryVersion.create({ data: { projectId: project.id } });

      await expect(prisma.$executeRaw`
        UPDATE delivery_versions
        SET status = ${status}::version_status, number = ${number}::integer, published_at = ${timestamp}::timestamptz
        WHERE id = ${draft.id}::uuid
      `).rejects.toMatchObject({ code: 'P2010', message: expect.stringContaining('23514') });
      expect(await prisma.deliveryVersion.findMany()).toEqual([draft]);
    },
  );

  it.each([false, true])('사진 경로는 프로젝트가 달라도 고유해야 한다(다른 프로젝트: %s)', async (differentProject) => {
    const { project, asset } = await createVersionScreen();
    const targetProject = differentProject ? await prisma.project.create({ data: { name: '다른 프로젝트' } }) : project;

    await expect(
      prisma.asset.create({
        data: { projectId: targetProject.id, storageKey: asset.storageKey, ...imageData },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(await prisma.asset.findMany()).toEqual([asset]);
  });

  it('사진이 달라도 같은 버전과 화면을 두 번 연결할 수 없다', async () => {
    const { project, version, screen, versionScreen } = await createVersionScreen();
    const otherAsset = await prisma.asset.create({
      data: { projectId: project.id, storageKey: `${project.id}/other.png`, ...imageData },
    });

    await expect(
      prisma.versionScreen.create({
        data: { versionId: version.id, screenId: screen.id, assetId: otherAsset.id },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(await prisma.versionScreen.findMany()).toEqual([versionScreen]);
  });

  it('한 버전의 여러 화면과 다음 초안에서 같은 사진을 다시 쓸 수 있다', async () => {
    const { project, version, screen, asset } = await createVersionScreen();
    const secondScreen = await prisma.screen.create({
      data: { projectId: project.id, name: '상세', viewport: 'PC' },
    });
    await prisma.deliveryVersion.update({
      where: { id: version.id },
      data: { status: 'IN_REVIEW', number: 1, publishedAt },
    });
    const draft = await prisma.deliveryVersion.create({ data: { projectId: project.id } });

    await prisma.versionScreen.createMany({
      data: [
        { versionId: version.id, screenId: secondScreen.id, assetId: asset.id },
        { versionId: draft.id, screenId: screen.id, assetId: asset.id },
      ],
    });

    expect(await prisma.versionScreen.count({ where: { assetId: asset.id } })).toBe(3);
    expect(await prisma.asset.findMany()).toEqual([asset]);
  });

  it('버전 화면이 쓰는 사진 줄을 지울 수 없다', async () => {
    const { asset, versionScreen } = await createVersionScreen();

    await expect(prisma.asset.delete({ where: { id: asset.id } })).rejects.toMatchObject({ code: 'P2003' });
    expect(await prisma.asset.findMany()).toEqual([asset]);
    expect(await prisma.versionScreen.findMany()).toEqual([versionScreen]);
  });

  it('버전 화면이 쓰는 화면 이름표를 지울 수 없다', async () => {
    const { screen, versionScreen } = await createVersionScreen();

    await expect(prisma.screen.delete({ where: { id: screen.id } })).rejects.toMatchObject({ code: 'P2003' });
    expect(await prisma.screen.findMany()).toEqual([screen]);
    expect(await prisma.versionScreen.findMany()).toEqual([versionScreen]);
  });

  it('일지가 가리키는 버전은 지울 수 없다', async () => {
    const { project, version, versionScreen } = await createVersionScreen();
    const actor = await prisma.user.create({ data: { email: 'actor@example.com', name: '개발자' } });
    const published = await prisma.deliveryVersion.update({
      where: { id: version.id },
      data: { status: 'IN_REVIEW', number: 1, publishedAt },
    });
    const event = await prisma.activityEvent.create({
      data: { projectId: project.id, actorId: actor.id, type: 'VERSION_PUBLISHED', versionId: version.id },
    });

    await expect(prisma.deliveryVersion.delete({ where: { id: version.id } })).rejects.toMatchObject({ code: 'P2003' });
    expect(await prisma.deliveryVersion.findMany()).toEqual([published]);
    expect(await prisma.activityEvent.findMany()).toEqual([event]);
    expect(await prisma.versionScreen.findMany()).toEqual([versionScreen]);
  });

  it('프로젝트의 현재 버전은 일지가 없어도 지울 수 없다', async () => {
    const { project, version, versionScreen } = await createVersionScreen();
    const published = await prisma.deliveryVersion.update({
      where: { id: version.id },
      data: { status: 'IN_REVIEW', number: 1, publishedAt },
    });
    const currentProject = await prisma.project.update({
      where: { id: project.id },
      data: { currentVersionId: version.id },
    });

    await expect(prisma.deliveryVersion.delete({ where: { id: version.id } })).rejects.toMatchObject({ code: 'P2003' });
    expect(await prisma.deliveryVersion.findMany()).toEqual([published]);
    expect(await prisma.project.findMany()).toEqual([currentProject]);
    expect(await prisma.versionScreen.findMany()).toEqual([versionScreen]);
  });

  it('초안을 지우면 그 버전 화면만 지워지고 지난 버전이 쓰는 사진과 화면은 남는다', async () => {
    const { project, version, screen, asset, versionScreen } = await createVersionScreen();
    const published = await prisma.deliveryVersion.update({
      where: { id: version.id },
      data: { status: 'IN_REVIEW', number: 1, publishedAt },
    });
    const draft = await prisma.deliveryVersion.create({ data: { projectId: project.id } });
    await prisma.versionScreen.create({
      data: { versionId: draft.id, screenId: screen.id, assetId: asset.id },
    });

    await prisma.deliveryVersion.delete({ where: { id: draft.id } });

    expect(await prisma.deliveryVersion.findMany()).toEqual([published]);
    expect(await prisma.versionScreen.findMany()).toEqual([versionScreen]);
    expect(await prisma.screen.findMany()).toEqual([screen]);
    expect(await prisma.asset.findMany()).toEqual([asset]);
    await expect(prisma.asset.delete({ where: { id: asset.id } })).rejects.toMatchObject({ code: 'P2003' });
  });

  it('마지막 버전 화면을 지운 뒤에는 쓰이지 않는 사진과 화면을 지울 수 있다', async () => {
    const { version, screen, asset, versionScreen } = await createVersionScreen();

    await prisma.versionScreen.delete({ where: { id: versionScreen.id } });
    await prisma.asset.delete({ where: { id: asset.id } });
    await prisma.screen.delete({ where: { id: screen.id } });

    expect(await prisma.versionScreen.count()).toBe(0);
    expect(await prisma.asset.count()).toBe(0);
    expect(await prisma.screen.count()).toBe(0);
    expect(await prisma.deliveryVersion.findMany()).toEqual([version]);
  });

  it('현재 버전·일지·공유 사진이 있어도 프로젝트를 지우면 소속 줄만 모두 지워진다', async () => {
    const removed = await createVersionScreen();
    const remaining = await createVersionScreen();
    const actor = await prisma.user.create({ data: { email: 'actor@example.com', name: '개발자' } });
    for (const { project, version, screen, asset } of [removed, remaining]) {
      await prisma.deliveryVersion.update({
        where: { id: version.id },
        data: { status: 'IN_REVIEW', number: 1, publishedAt },
      });
      await prisma.project.update({ where: { id: project.id }, data: { currentVersionId: version.id } });
      const draft = await prisma.deliveryVersion.create({ data: { projectId: project.id } });
      await prisma.versionScreen.create({
        data: { versionId: draft.id, screenId: screen.id, assetId: asset.id },
      });
      await prisma.activityEvent.create({
        data: { projectId: project.id, actorId: actor.id, type: 'VERSION_PUBLISHED', versionId: version.id },
      });
    }
    const remainingProject = await prisma.project.findUniqueOrThrow({
      where: { id: remaining.project.id },
      include: { versions: true, assets: true, screens: true, activities: true },
    });
    const remainingVersionScreens = await prisma.versionScreen.findMany({
      where: { version: { projectId: remaining.project.id } },
    });
    expect(await prisma.deliveryVersion.count()).toBe(4);
    expect(await prisma.asset.count()).toBe(2);
    expect(await prisma.versionScreen.count()).toBe(4);
    expect(await prisma.activityEvent.count()).toBe(2);

    await prisma.project.delete({ where: { id: removed.project.id } });

    expect(await prisma.project.findMany()).toEqual([
      expect.objectContaining({ id: remaining.project.id, currentVersionId: remaining.version.id }),
    ]);
    expect(await prisma.deliveryVersion.count()).toBe(remainingProject.versions.length);
    expect(await prisma.deliveryVersion.findMany()).toEqual(expect.arrayContaining(remainingProject.versions));
    expect(await prisma.asset.findMany()).toEqual(remainingProject.assets);
    expect(await prisma.screen.findMany()).toEqual(remainingProject.screens);
    expect(await prisma.activityEvent.findMany()).toEqual(remainingProject.activities);
    expect(await prisma.versionScreen.count()).toBe(remainingVersionScreens.length);
    expect(await prisma.versionScreen.findMany()).toEqual(expect.arrayContaining(remainingVersionScreens));
    expect(await prisma.user.findMany()).toEqual([actor]);
  });

  it('없는 프로젝트의 버전을 만들 수 없다', async () => {
    await expect(prisma.deliveryVersion.create({ data: { projectId: missingId } })).rejects.toMatchObject({
      code: 'P2003',
    });
    expect(await prisma.deliveryVersion.count()).toBe(0);
  });

  it('없는 프로젝트의 사진을 만들 수 없다', async () => {
    await expect(
      prisma.asset.create({
        data: { projectId: missingId, storageKey: 'missing/image.png', ...imageData },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
    expect(await prisma.asset.count()).toBe(0);
  });

  it.each(['versionId', 'screenId', 'assetId'] as const)(
    '버전 화면의 %s가 없는 줄을 가리키면 거부한다',
    async (field) => {
      const { project, version, asset, versionScreen } = await createVersionScreen();
      const screen = await prisma.screen.create({
        data: { projectId: project.id, name: '상세', viewport: 'PC' },
      });

      await expect(
        prisma.versionScreen.create({
          data: { versionId: version.id, screenId: screen.id, assetId: asset.id, [field]: missingId },
        }),
      ).rejects.toMatchObject({ code: 'P2003' });
      expect(await prisma.versionScreen.findMany()).toEqual([versionScreen]);
    },
  );

  it.each(['projectId', 'actorId', 'versionId'] as const)('일지의 %s가 없는 줄을 가리키면 거부한다', async (field) => {
    const project = await prisma.project.create({ data: { name: '프로젝트' } });
    const version = await prisma.deliveryVersion.create({
      data: { projectId: project.id, status: 'IN_REVIEW', number: 1, publishedAt },
    });
    const actor = await prisma.user.create({ data: { email: 'actor@example.com', name: '개발자' } });

    await expect(
      prisma.activityEvent.create({
        data: {
          projectId: project.id,
          actorId: actor.id,
          type: 'VERSION_PUBLISHED',
          versionId: version.id,
          [field]: missingId,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
    expect(await prisma.activityEvent.count()).toBe(0);
  });

  it('없는 버전을 프로젝트의 현재 버전으로 지정할 수 없다', async () => {
    const project = await prisma.project.create({ data: { name: '프로젝트' } });

    await expect(
      prisma.project.update({
        where: { id: project.id },
        data: { currentVersionId: missingId },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
    expect(await prisma.project.findMany()).toEqual([project]);
  });

  it('일지의 작성자는 멤버 줄이 없어도 지울 수 없다', async () => {
    const project = await prisma.project.create({ data: { name: '프로젝트' } });
    const actor = await prisma.user.create({ data: { email: 'actor@example.com', name: '개발자' } });
    const event = await prisma.activityEvent.create({
      data: { projectId: project.id, actorId: actor.id, type: 'VERSION_PUBLISHED' },
    });

    await expect(prisma.user.delete({ where: { id: actor.id } })).rejects.toMatchObject({ code: 'P2003' });
    expect(await prisma.user.findMany()).toEqual([actor]);
    expect(await prisma.activityEvent.findMany()).toEqual([event]);
  });

  it('DB는 정해지지 않은 버전 상태를 거부한다', async () => {
    const project = await prisma.project.create({ data: { name: '프로젝트' } });

    await expect(prisma.$executeRaw`
      INSERT INTO delivery_versions (project_id, status)
      VALUES (${project.id}::uuid, 'PUBLISHED')
    `).rejects.toMatchObject({ code: 'P2010', message: expect.stringContaining('22P02') });
    expect(await prisma.deliveryVersion.count()).toBe(0);
  });

  it('DB는 정해지지 않은 사건 종류를 거부한다', async () => {
    const project = await prisma.project.create({ data: { name: '프로젝트' } });
    const actor = await prisma.user.create({ data: { email: 'actor@example.com', name: '개발자' } });

    await expect(prisma.$executeRaw`
      INSERT INTO activity_events (project_id, actor_id, type)
      VALUES (${project.id}::uuid, ${actor.id}::uuid, 'UNKNOWN')
    `).rejects.toMatchObject({ code: 'P2010', message: expect.stringContaining('22P02') });
    expect(await prisma.activityEvent.count()).toBe(0);
  });

  it('delivery_versions의 UUID·생성 시각·초안 상태·빈 설명은 DB 기본값이다', async () => {
    const project = await prisma.project.create({ data: { name: '프로젝트' } });
    const [row] = await prisma.$queryRaw<{ id: string; created_at_is_now: boolean }[]>`
      INSERT INTO delivery_versions (project_id)
      VALUES (${project.id}::uuid)
      RETURNING id, created_at = now() AS created_at_is_now
    `;

    expect(row.id).toMatch(uuidPattern);
    expect(row.created_at_is_now).toBe(true);
    expect(await prisma.deliveryVersion.findUniqueOrThrow({ where: { id: row.id } })).toEqual({
      id: row.id,
      projectId: project.id,
      status: 'DRAFT',
      number: null,
      summary: '',
      testUrl: null,
      publishedAt: null,
      createdAt: expect.any(Date),
    });
  });

  it('assets의 UUID와 생성 시각은 DB가 만든다', async () => {
    const project = await prisma.project.create({ data: { name: '프로젝트' } });
    const [row] = await prisma.$queryRaw<{ id: string; created_at_is_now: boolean }[]>`
      INSERT INTO assets (project_id, storage_key, mime, bytes, width, height)
      VALUES (${project.id}::uuid, 'image.png', 'image/png', 100, 10, 20)
      RETURNING id, created_at = now() AS created_at_is_now
    `;

    expect(row.id).toMatch(uuidPattern);
    expect(row.created_at_is_now).toBe(true);
    expect(await prisma.asset.findUniqueOrThrow({ where: { id: row.id } })).toEqual({
      id: row.id,
      projectId: project.id,
      storageKey: 'image.png',
      ...imageData,
      createdAt: expect.any(Date),
    });
  });

  it('version_screens의 UUID와 생성 시각은 DB가 만든다', async () => {
    const { project, version, asset } = await createVersionScreen();
    const screen = await prisma.screen.create({
      data: { projectId: project.id, name: '상세', viewport: 'PC' },
    });
    const [row] = await prisma.$queryRaw<{ id: string; created_at_is_now: boolean }[]>`
      INSERT INTO version_screens (version_id, screen_id, asset_id)
      VALUES (${version.id}::uuid, ${screen.id}::uuid, ${asset.id}::uuid)
      RETURNING id, created_at = now() AS created_at_is_now
    `;

    expect(row.id).toMatch(uuidPattern);
    expect(row.created_at_is_now).toBe(true);
    expect(await prisma.versionScreen.findUniqueOrThrow({ where: { id: row.id } })).toEqual({
      id: row.id,
      versionId: version.id,
      screenId: screen.id,
      assetId: asset.id,
      createdAt: expect.any(Date),
    });
  });

  it('activity_events의 UUID와 생성 시각은 DB가 만들고 version_id는 비워 둘 수 있다', async () => {
    const project = await prisma.project.create({ data: { name: '프로젝트' } });
    const actor = await prisma.user.create({ data: { email: 'actor@example.com', name: '개발자' } });
    // 생성 시각은 줄을 쓰는 순간의 DB 시각(clock_timestamp)이다. 트랜잭션 시작(now())과 지금 사이에 있다(docs/mail.md 정할 것 15).
    const [row] = await prisma.$queryRaw<{ id: string; created_at_is_db_clock: boolean }[]>`
      INSERT INTO activity_events (project_id, actor_id, type)
      VALUES (${project.id}::uuid, ${actor.id}::uuid, 'VERSION_PUBLISHED')
      RETURNING id, created_at BETWEEN now() AND clock_timestamp() AS created_at_is_db_clock
    `;

    expect(row.id).toMatch(uuidPattern);
    expect(row.created_at_is_db_clock).toBe(true);
    expect(await prisma.activityEvent.findUniqueOrThrow({ where: { id: row.id } })).toEqual({
      id: row.id,
      projectId: project.id,
      actorId: actor.id,
      type: 'VERSION_PUBLISHED',
      versionId: null,
      memberId: null,
      issueId: null,
      createdAt: expect.any(Date),
    });
  });

  it('resetDatabase는 현재 버전 연결이 있어도 새 표 네 개를 비우고 다시 실행할 수 있다', async () => {
    const { project, version } = await createVersionScreen();
    const actor = await prisma.user.create({ data: { email: 'actor@example.com', name: '개발자' } });
    await prisma.deliveryVersion.update({
      where: { id: version.id },
      data: { status: 'IN_REVIEW', number: 1, publishedAt },
    });
    await prisma.project.update({ where: { id: project.id }, data: { currentVersionId: version.id } });
    await prisma.activityEvent.create({
      data: { projectId: project.id, actorId: actor.id, type: 'VERSION_PUBLISHED', versionId: version.id },
    });
    expect(await prisma.deliveryVersion.count()).toBe(1);
    expect(await prisma.asset.count()).toBe(1);
    expect(await prisma.versionScreen.count()).toBe(1);
    expect(await prisma.activityEvent.count()).toBe(1);

    await resetDatabase(prisma);

    expect(await prisma.deliveryVersion.count()).toBe(0);
    expect(await prisma.asset.count()).toBe(0);
    expect(await prisma.versionScreen.count()).toBe(0);
    expect(await prisma.activityEvent.count()).toBe(0);
    expect(await prisma.project.count()).toBe(0);
    expect(await prisma.screen.count()).toBe(0);
    expect(await prisma.user.count()).toBe(0);
    await expect(resetDatabase(prisma)).resolves.toBeUndefined();
  });
});
