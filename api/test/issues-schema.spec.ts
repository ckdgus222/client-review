import { randomUUID } from 'node:crypto';
import type { Prisma } from '../src/generated/prisma/client.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { resetDatabase } from './reset-database.js';

describe('쪽지와 댓글 테이블', () => {
  const prisma = new PrismaService();
  const missingId = '00000000-0000-4000-8000-000000000001';
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const imageData = { mime: 'image/png', bytes: 100, width: 10, height: 20 };
  let issueData: Prisma.IssueUncheckedCreateInput;
  let versionScreenId: string;

  const createVersionScreen = async () => {
    const project = await prisma.project.create({ data: { name: '프로젝트' } });
    const version = await prisma.deliveryVersion.create({ data: { projectId: project.id } });
    const screen = await prisma.screen.create({ data: { projectId: project.id, name: '메인', viewport: 'PC' } });
    const asset = await prisma.asset.create({
      data: { projectId: project.id, storageKey: `${project.id}/screen.png`, ...imageData },
    });
    const versionScreen = await prisma.versionScreen.create({
      data: { versionId: version.id, screenId: screen.id, assetId: asset.id },
    });
    return { project, version, screen, asset, versionScreen };
  };

  const createIssueWithRelations = async (data = issueData) => {
    const issue = await prisma.issue.create({ data });
    const comment = await prisma.comment.create({
      data: { issueId: issue.id, authorId: data.authorId, versionId: data.originVersionId, body: '댓글' },
    });
    const asset = await prisma.asset.create({
      data: { projectId: data.projectId, storageKey: `${issue.id}/reference.png`, ...imageData },
    });
    const attachment = await prisma.issueAttachment.create({ data: { issueId: issue.id, assetId: asset.id } });
    const event = await prisma.activityEvent.create({
      data: { projectId: data.projectId, actorId: data.authorId, type: 'ISSUE_CREATED', issueId: issue.id },
    });
    return { issue, comment, asset, attachment, event };
  };

  beforeEach(async () => {
    await resetDatabase(prisma);
    const { project, version, versionScreen } = await createVersionScreen();
    const author = await prisma.user.create({ data: { email: 'author@example.com', name: '작성자' } });
    versionScreenId = versionScreen.id;
    issueData = {
      projectId: project.id,
      originVersionId: version.id,
      authorId: author.id,
      number: 1,
      title: '수정해 주세요',
      body: '',
      requestId: randomUUID(),
    };
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('쪽지의 UUID와 생성 시각은 DB가 만들고 상태는 OPEN이며 위치는 비워 둘 수 있다', async () => {
    const { projectId, originVersionId, authorId, number, title, body, requestId } = issueData;
    const [row] = await prisma.$queryRaw<{ id: string; created_at_is_now: boolean }[]>`
      INSERT INTO issues (project_id, origin_version_id, author_id, number, title, body, request_id)
      VALUES (${projectId}::uuid, ${originVersionId}::uuid, ${authorId}::uuid, ${number}, ${title}, ${body}, ${requestId}::uuid)
      RETURNING id, created_at = now() AS created_at_is_now
    `;

    expect(row.id).toMatch(uuidPattern);
    expect(row.created_at_is_now).toBe(true);
    expect(await prisma.issue.findUniqueOrThrow({ where: { id: row.id } })).toEqual({
      ...issueData,
      id: row.id,
      status: 'OPEN',
      category: 'BUG',
      scope: 'IN_SCOPE',
      dueDate: null,
      originVersionScreenId: null,
      xRatio: null,
      yRatio: null,
      createdAt: expect.any(Date),
    });
  });

  it.each([
    ['화면만', true, null, null],
    ['x만', false, 0.5, null],
    ['y만', false, null, 0.5],
    ['화면과 x만', true, 0.5, null],
    ['화면과 y만', true, null, 0.5],
    ['x와 y만', false, 0.5, 0.5],
  ] as const)('핀에 %s 있으면 DB가 거부한다', async (_, hasScreen, xRatio, yRatio) => {
    const { projectId, originVersionId, authorId, requestId } = issueData;
    const screenId = hasScreen ? versionScreenId : null;

    await expect(prisma.$executeRaw`
      INSERT INTO issues (project_id, origin_version_id, author_id, number, title, body, request_id,
                          origin_version_screen_id, x_ratio, y_ratio)
      VALUES (${projectId}::uuid, ${originVersionId}::uuid, ${authorId}::uuid, 1, '핀 쪽지', '', ${requestId}::uuid,
              ${screenId}::uuid, ${xRatio}::double precision, ${yRatio}::double precision)
    `).rejects.toMatchObject({ code: 'P2010', message: expect.stringContaining('23514') });
    expect(await prisma.issue.count()).toBe(0);
  });

  it.each([
    ['x가 0 미만', '-0.001', '0.5'],
    ['x가 1 초과', '1.001', '0.5'],
    ['y가 0 미만', '0.5', '-0.001'],
    ['y가 1 초과', '0.5', '1.001'],
    ['x가 NaN', 'NaN', '0.5'],
    ['y가 NaN', '0.5', 'NaN'],
    ['x가 양의 무한대', 'Infinity', '0.5'],
    ['y가 음의 무한대', '0.5', '-Infinity'],
  ])('핀 비율 %s로 바꾸면 DB가 거부하고 기존 위치를 보존한다', async (_, xRatio, yRatio) => {
    const issue = await prisma.issue.create({
      data: { ...issueData, originVersionScreenId: versionScreenId, xRatio: 0.5, yRatio: 0.5 },
    });

    await expect(prisma.$executeRaw`
      UPDATE issues SET x_ratio = ${xRatio}::double precision, y_ratio = ${yRatio}::double precision
      WHERE id = ${issue.id}::uuid
    `).rejects.toMatchObject({ code: 'P2010', message: expect.stringContaining('23514') });
    expect(await prisma.issue.findMany()).toEqual([issue]);
  });

  it.each([
    [0, 0],
    [0, 1],
    [1, 0],
    [1, 1],
    [0.25, 0.75],
  ])('핀 비율 (%s, %s)는 저장된다', async (xRatio, yRatio) => {
    const issue = await prisma.issue.create({
      data: { ...issueData, originVersionScreenId: versionScreenId, xRatio, yRatio },
    });

    expect(await prisma.issue.findMany()).toEqual([
      { ...issue, originVersionScreenId: versionScreenId, xRatio, yRatio },
    ]);
  });

  it('같은 작성자와 request_id의 쪽지는 다른 프로젝트에서도 중복될 수 없다', async () => {
    const first = await prisma.issue.create({ data: issueData });
    const other = await createVersionScreen();

    await expect(prisma.issue.create({ data: { ...issueData, number: 2 } })).rejects.toMatchObject({ code: 'P2002' });
    await expect(
      prisma.issue.create({
        data: { ...issueData, projectId: other.project.id, originVersionId: other.version.id },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(await prisma.issue.findMany()).toEqual([first]);
  });

  it('다른 작성자는 같은 request_id로 쪽지를 쓸 수 있다', async () => {
    const other = await prisma.user.create({ data: { email: 'other@example.com', name: '다른 작성자' } });
    const first = await prisma.issue.create({ data: issueData });
    const second = await prisma.issue.create({ data: { ...issueData, authorId: other.id, number: 2 } });

    expect(await prisma.issue.findMany({ orderBy: { number: 'asc' } })).toEqual([first, second]);
  });

  it('같은 프로젝트의 쪽지 번호는 중복될 수 없고 다른 프로젝트는 같은 번호를 쓴다', async () => {
    const first = await prisma.issue.create({ data: issueData });
    await expect(
      prisma.issue.create({
        data: { ...issueData, requestId: randomUUID() },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    const other = await createVersionScreen();
    const second = await prisma.issue.create({
      data: { ...issueData, projectId: other.project.id, originVersionId: other.version.id, requestId: randomUUID() },
    });

    expect(await prisma.issue.findMany({ where: { projectId: first.projectId } })).toEqual([first]);
    expect(await prisma.issue.findMany({ where: { projectId: second.projectId } })).toEqual([second]);
  });

  it('다른 프로젝트의 버전을 쪽지의 시작 버전으로 넣을 수 없다', async () => {
    const other = await createVersionScreen();

    await expect(
      prisma.issue.create({
        data: { ...issueData, originVersionId: other.version.id },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
    expect(await prisma.issue.count()).toBe(0);
  });

  it('같은 프로젝트라도 다른 버전의 화면을 쪽지의 시작 화면으로 넣을 수 없다', async () => {
    const otherVersion = await prisma.deliveryVersion.create({
      data: { projectId: issueData.projectId, status: 'IN_REVIEW', number: 1, publishedAt: new Date() },
    });

    await expect(
      prisma.issue.create({
        data: {
          ...issueData,
          originVersionId: otherVersion.id,
          originVersionScreenId: versionScreenId,
          xRatio: 0,
          yRatio: 1,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
    expect(await prisma.issue.count()).toBe(0);
  });

  it.each(['projectId', 'originVersionId', 'authorId', 'originVersionScreenId'] as const)(
    '없는 %s를 가리키는 쪽지를 만들 수 없다',
    async (field) => {
      await expect(
        prisma.issue.create({
          data: { ...issueData, originVersionScreenId: versionScreenId, xRatio: 0, yRatio: 1, [field]: missingId },
        }),
      ).rejects.toMatchObject({ code: 'P2003' });
      expect(await prisma.issue.count()).toBe(0);
    },
  );

  it('같은 사진을 같은 쪽지에 두 번 붙이거나 다른 쪽지에 붙일 수 없다', async () => {
    const { issue, asset, attachment } = await createIssueWithRelations();
    const other = await prisma.issue.create({ data: { ...issueData, number: 2, requestId: randomUUID() } });

    for (const issueId of [issue.id, other.id]) {
      await expect(prisma.issueAttachment.create({ data: { issueId, assetId: asset.id } })).rejects.toMatchObject({
        code: 'P2002',
      });
    }
    expect(await prisma.issueAttachment.findMany()).toEqual([attachment]);
  });

  it('같은 작성자와 request_id의 댓글은 다른 쪽지에서도 중복될 수 없고 다른 작성자는 쓸 수 있다', async () => {
    const issue = await prisma.issue.create({ data: issueData });
    const otherIssue = await prisma.issue.create({ data: { ...issueData, number: 2, requestId: randomUUID() } });
    const otherAuthor = await prisma.user.create({ data: { email: 'other@example.com', name: '다른 작성자' } });
    const data = {
      issueId: issue.id,
      authorId: issueData.authorId,
      versionId: issueData.originVersionId,
      body: '댓글',
      requestId: randomUUID(),
    };
    const first = await prisma.comment.create({ data });

    for (const issueId of [issue.id, otherIssue.id]) {
      await expect(prisma.comment.create({ data: { ...data, issueId } })).rejects.toMatchObject({ code: 'P2002' });
    }
    const second = await prisma.comment.create({ data: { ...data, authorId: otherAuthor.id } });

    expect(await prisma.comment.findMany({ orderBy: { createdAt: 'asc' } })).toEqual([first, second]);
  });

  it('댓글 created_at 기본값은 now()가 아니라 clock_timestamp()라 트랜잭션 안에서 기다린 뒤의 시각이다', async () => {
    const issue = await prisma.issue.create({ data: issueData });
    const { authorId, originVersionId } = issueData;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_sleep(0.05)`;
      // created_at을 생략하여 서비스가 아니라 DB 기본값 자체를 검사한다.
      const [row] = await tx.$queryRaw<{ after_start: boolean }[]>`
        INSERT INTO comments (issue_id, author_id, version_id, body)
        VALUES (${issue.id}::uuid, ${authorId}::uuid, ${originVersionId}::uuid, '기다린 뒤 댓글')
        RETURNING created_at > now() AS after_start
      `;
      expect(row.after_start).toBe(true);
    });
  });

  it('같은 작성자의 request_id가 비어 있는 댓글은 같은 쪽지에도 여러 개 저장된다', async () => {
    const issue = await prisma.issue.create({ data: issueData });
    const data = {
      issueId: issue.id,
      authorId: issueData.authorId,
      versionId: issueData.originVersionId,
      body: '자동 댓글',
    };
    const first = await prisma.comment.create({ data });
    const second = await prisma.comment.create({ data: { ...data, requestId: null } });

    expect(await prisma.comment.findMany({ orderBy: { createdAt: 'asc' } })).toEqual([
      { ...first, requestId: null },
      { ...second, requestId: null },
    ]);
  });

  it.each(['issueId', 'authorId', 'versionId'] as const)('없는 %s를 가리키는 댓글을 만들 수 없다', async (field) => {
    const issue = await prisma.issue.create({ data: issueData });

    await expect(
      prisma.comment.create({
        data: {
          issueId: issue.id,
          authorId: issue.authorId,
          versionId: issue.originVersionId,
          body: '댓글',
          [field]: missingId,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
    expect(await prisma.comment.count()).toBe(0);
  });

  it.each(['issueId', 'assetId'] as const)('없는 %s를 가리키는 참고 사진을 만들 수 없다', async (field) => {
    const issue = await prisma.issue.create({ data: issueData });
    const asset = await prisma.asset.create({
      data: { projectId: issue.projectId, storageKey: 'reference.png', ...imageData },
    });

    await expect(
      prisma.issueAttachment.create({
        data: { issueId: issue.id, assetId: asset.id, [field]: missingId },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
    expect(await prisma.issueAttachment.count()).toBe(0);
  });

  it('멤버의 접근을 철회하고 다시 허용해도 쪽지와 댓글의 작성자는 같은 사용자다', async () => {
    const member = await prisma.projectMember.create({
      data: { projectId: issueData.projectId, userId: issueData.authorId, role: 'CLIENT' },
    });
    const { issue, comment } = await createIssueWithRelations();
    const author = await prisma.user.findUniqueOrThrow({ where: { id: issueData.authorId } });

    for (const revokedAt of [new Date(), null]) {
      await prisma.projectMember.update({ where: { id: member.id }, data: { revokedAt } });

      expect(await prisma.issue.findUnique({ where: { id: issue.id }, include: { author: true } })).toEqual({
        ...issue,
        author,
      });
      expect(await prisma.comment.findUnique({ where: { id: comment.id }, include: { author: true } })).toEqual({
        ...comment,
        author,
      });
    }
  });

  it.each(['ISSUE_CREATED', 'ISSUE_STARTED'] as const)('일지 사건 %s와 issue_id가 저장된다', async (type) => {
    const issue = await prisma.issue.create({ data: issueData });
    const event = await prisma.activityEvent.create({
      data: { projectId: issue.projectId, actorId: issue.authorId, type, issueId: issue.id },
    });

    expect(await prisma.activityEvent.findMany()).toEqual([
      {
        id: event.id,
        projectId: issue.projectId,
        actorId: issue.authorId,
        type,
        issueId: issue.id,
        versionId: null,
        memberId: null,
        createdAt: expect.any(Date),
      },
    ]);
  });

  it('쪽지 상태 IN_PROGRESS를 저장할 수 있다', async () => {
    const issue = await prisma.issue.create({ data: issueData });
    await prisma.issue.update({ where: { id: issue.id }, data: { status: 'IN_PROGRESS' } });

    expect(await prisma.issue.findMany()).toEqual([{ ...issue, status: 'IN_PROGRESS' }]);
  });

  it('쪽지에 붙어 쓰이는 사진만 따로 지우면 거부하고 첨부와 사진을 보존한다', async () => {
    const { asset, attachment } = await createIssueWithRelations();
    expect(await prisma.versionScreen.count({ where: { assetId: asset.id } })).toBe(0);

    await expect(prisma.asset.delete({ where: { id: asset.id } })).rejects.toMatchObject({ code: 'P2003' });
    expect(await prisma.asset.findUnique({ where: { id: asset.id } })).toEqual(asset);
    expect(await prisma.issueAttachment.findMany()).toEqual([attachment]);
  });

  it('일지가 가리키는 쪽지만 따로 지울 수 없다', async () => {
    const { issue, comment, attachment, event } = await createIssueWithRelations();

    await expect(prisma.issue.delete({ where: { id: issue.id } })).rejects.toMatchObject({ code: 'P2003' });
    expect(await prisma.issue.findMany()).toEqual([issue]);
    expect(await prisma.comment.findMany()).toEqual([comment]);
    expect(await prisma.issueAttachment.findMany()).toEqual([attachment]);
    expect(await prisma.activityEvent.findMany()).toEqual([event]);
  });

  it('쪽지를 지우면 댓글과 참고 사진 줄이 함께 지워지고 사진 원본과 다른 쪽지의 줄은 남는다', async () => {
    const removed = await createIssueWithRelations();
    const remaining = await createIssueWithRelations({ ...issueData, number: 2, requestId: randomUUID() });
    await prisma.activityEvent.delete({ where: { id: removed.event.id } });

    await prisma.issue.delete({ where: { id: removed.issue.id } });

    expect(await prisma.issue.findMany()).toEqual([remaining.issue]);
    expect(await prisma.comment.findMany()).toEqual([remaining.comment]);
    expect(await prisma.issueAttachment.findMany()).toEqual([remaining.attachment]);
    expect(await prisma.activityEvent.findMany()).toEqual([remaining.event]);
    expect(await prisma.asset.findUnique({ where: { id: removed.asset.id } })).toEqual(removed.asset);
    expect(await prisma.asset.count()).toBe(3);
  });

  it('프로젝트를 지우면 쪽지·댓글·참고 사진·쪽지 일지를 모두 지우고 다른 프로젝트와 사용자는 남는다', async () => {
    await createIssueWithRelations({ ...issueData, originVersionScreenId: versionScreenId, xRatio: 0, yRatio: 1 });
    const other = await createVersionScreen();
    const remaining = await createIssueWithRelations({
      ...issueData,
      projectId: other.project.id,
      originVersionId: other.version.id,
      originVersionScreenId: other.versionScreen.id,
      xRatio: 1,
      yRatio: 0,
      requestId: randomUUID(),
    });
    const users = await prisma.user.findMany();

    await prisma.project.delete({ where: { id: issueData.projectId } });

    expect(await prisma.project.findMany()).toEqual([other.project]);
    expect(await prisma.issue.findMany()).toEqual([remaining.issue]);
    expect(await prisma.comment.findMany()).toEqual([remaining.comment]);
    expect(await prisma.issueAttachment.findMany()).toEqual([remaining.attachment]);
    expect(await prisma.activityEvent.findMany()).toEqual([remaining.event]);
    expect(await prisma.deliveryVersion.findMany()).toEqual([other.version]);
    expect(await prisma.screen.findMany()).toEqual([other.screen]);
    expect(await prisma.versionScreen.findMany()).toEqual([other.versionScreen]);
    expect(await prisma.asset.findMany()).toEqual(expect.arrayContaining([other.asset, remaining.asset]));
    expect(await prisma.asset.count()).toBe(2);
    expect(await prisma.user.findMany()).toEqual(users);
  });

  it.each(['시작 버전', '시작 화면', '댓글 버전', '참고 사진', '일지 쪽지'] as const)(
    '%s 외래키 위반은 트랜잭션 중에는 허용하고 커밋 때 거부한다',
    async (relation) => {
      const { issue, comment, attachment, event } = await createIssueWithRelations();
      let reachedCommit = false;

      const transaction = prisma.$transaction(async (tx) => {
        if (relation === '시작 버전')
          await tx.issue.update({ where: { id: issue.id }, data: { originVersionId: missingId } });
        if (relation === '시작 화면')
          await tx.issue.update({
            where: { id: issue.id },
            data: { originVersionScreenId: missingId, xRatio: 0, yRatio: 1 },
          });
        if (relation === '댓글 버전')
          await tx.comment.update({ where: { id: comment.id }, data: { versionId: missingId } });
        if (relation === '참고 사진')
          await tx.issueAttachment.update({ where: { id: attachment.id }, data: { assetId: missingId } });
        if (relation === '일지 쪽지')
          await tx.activityEvent.update({ where: { id: event.id }, data: { issueId: missingId } });
        reachedCommit = true;
      });

      // 커밋 때 나는 위반은 Prisma가 P2003으로 바꾸지 않고 DB 오류(23503, 외래키 위반)를 그대로 올린다.
      await expect(transaction).rejects.toMatchObject({ cause: { originalCode: '23503' } });
      expect(reachedCommit).toBe(true);
      expect(await prisma.issue.findMany()).toEqual([issue]);
      expect(await prisma.comment.findMany()).toEqual([comment]);
      expect(await prisma.issueAttachment.findMany()).toEqual([attachment]);
      expect(await prisma.activityEvent.findMany()).toEqual([event]);
    },
  );

  it('resetDatabase는 쪽지·댓글·참고 사진·일지 연결을 비우고 다시 실행할 수 있다', async () => {
    await createIssueWithRelations({ ...issueData, originVersionScreenId: versionScreenId, xRatio: 0, yRatio: 1 });

    await resetDatabase(prisma);

    expect(await prisma.issue.count()).toBe(0);
    expect(await prisma.comment.count()).toBe(0);
    expect(await prisma.issueAttachment.count()).toBe(0);
    expect(await prisma.activityEvent.count()).toBe(0);
    expect(await prisma.asset.count()).toBe(0);
    expect(await prisma.project.count()).toBe(0);
    expect(await prisma.user.count()).toBe(0);
    await expect(resetDatabase(prisma)).resolves.toBeUndefined();
  });
});
