import { randomUUID } from 'node:crypto';
import type { Prisma } from '../src/generated/prisma/client.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { resetDatabase } from './reset-database.js';

describe('고쳤어요 테이블', () => {
  const prisma = new PrismaService();
  const missingId = '00000000-0000-4000-8000-000000000001';
  const partialReviews = [
    ['결과만', true, false, false],
    ['확인한 사람만', false, true, false],
    ['확인 시각만', false, false, true],
    ['결과와 확인한 사람만', true, true, false],
    ['결과와 확인 시각만', true, false, true],
    ['확인한 사람과 확인 시각만', false, true, true],
  ] as const;
  let attemptData: Prisma.ResolutionAttemptUncheckedCreateInput;
  let projectId: string;
  let versionScreenId: string;
  let reviewerId: string;

  const createIssueWithScreen = async (authorId: string) => {
    const project = await prisma.project.create({ data: { name: '프로젝트' } });
    const originVersion = await prisma.deliveryVersion.create({
      data: { projectId: project.id, status: 'IN_REVIEW', number: 1, publishedAt: new Date() },
    });
    // 고친 버전은 쪽지의 시작 버전과 다르다. 삭제 거절이 기존 쪽지 외래키 때문이면 안 된다.
    const version = await prisma.deliveryVersion.create({ data: { projectId: project.id } });
    const screen = await prisma.screen.create({ data: { projectId: project.id, name: '메인', viewport: 'PC' } });
    const asset = await prisma.asset.create({
      data: { projectId: project.id, storageKey: `${project.id}/screen.png`, mime: 'image/png', bytes: 100, width: 10, height: 20 },
    });
    const versionScreen = await prisma.versionScreen.create({
      data: { versionId: version.id, screenId: screen.id, assetId: asset.id },
    });
    const issue = await prisma.issue.create({
      data: { projectId: project.id, originVersionId: originVersion.id, authorId, number: 1, title: '수정해 주세요', body: '', requestId: randomUUID() },
    });
    return { project, originVersion, version, screen, asset, versionScreen, issue };
  };

  beforeEach(async () => {
    await resetDatabase(prisma);
    const author = await prisma.user.create({ data: { email: 'author@example.com', name: '작성자' } });
    const submitter = await prisma.user.create({ data: { email: 'submitter@example.com', name: '개발자' } });
    const reviewer = await prisma.user.create({ data: { email: 'reviewer@example.com', name: '확인한 사람' } });
    const fixture = await createIssueWithScreen(author.id);
    projectId = fixture.project.id;
    versionScreenId = fixture.versionScreen.id;
    reviewerId = reviewer.id;
    attemptData = {
      issueId: fixture.issue.id,
      versionId: fixture.version.id,
      summary: '버튼을 고쳤어요',
      submittedById: submitter.id,
    };
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('UUID와 created_at은 DB가 만들고 결과·확인한 사람·확인 시각은 비어 있다', async () => {
    const { issueId, versionId, summary, submittedById } = attemptData;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_sleep(0.05)`;
      const [row] = await tx.$queryRaw<{ id: string; after_start: boolean; before_read: boolean }[]>`
        INSERT INTO resolution_attempts (issue_id, version_id, summary, submitted_by)
        VALUES (${issueId}::uuid, ${versionId}::uuid, ${summary}, ${submittedById}::uuid)
        RETURNING id, created_at > now() AS after_start, created_at <= clock_timestamp() AS before_read
      `;

      expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      expect(row.after_start).toBe(true);
      expect(row.before_read).toBe(true);
      expect(await tx.resolutionAttempt.findUniqueOrThrow({ where: { id: row.id } })).toEqual({
        ...attemptData,
        id: row.id,
        versionScreenId: null,
        createdAt: expect.any(Date),
        result: null,
        reviewedById: null,
        reviewedAt: null,
      });
    });
  });

  it.each(['VERIFIED', 'REOPENED'] as const)('결과 %s와 확인한 사람·확인 시각이 모두 있으면 저장된다', async (result) => {
    const data = { ...attemptData, result, reviewedById: reviewerId, reviewedAt: new Date('2026-11-13T00:00:00.000Z') };
    const attempt = await prisma.resolutionAttempt.create({ data });

    expect(await prisma.resolutionAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).toMatchObject(data);
  });

  it.each(['VERIFIED', 'REOPENED'] as const)('결과 없는 줄에 %s와 확인한 사람·DB 시각을 함께 적을 수 있다', async (result) => {
    const attempt = await prisma.resolutionAttempt.create({ data: attemptData });
    await prisma.$executeRaw`
      UPDATE resolution_attempts
      SET result = ${result}::resolution_result, reviewed_by = ${reviewerId}::uuid, reviewed_at = clock_timestamp()
      WHERE id = ${attempt.id}::uuid
    `;

    const reviewed = await prisma.resolutionAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(reviewed).toEqual({ ...attempt, result, reviewedById: reviewerId, reviewedAt: expect.any(Date) });
    expect(reviewed.reviewedAt!.getTime()).toBeGreaterThanOrEqual(attempt.createdAt.getTime());
  });

  it.each(partialReviews)('%s 있는 줄을 넣으면 CHECK가 거부한다', async (_, hasResult, hasReviewer, hasReviewedAt) => {
    const { issueId, versionId, summary, submittedById } = attemptData;
    const result = hasResult ? 'VERIFIED' : null;
    const reviewedBy = hasReviewer ? reviewerId : null;
    const reviewedAt = hasReviewedAt ? new Date() : null;

    await expect(prisma.$executeRaw`
      INSERT INTO resolution_attempts (issue_id, version_id, summary, submitted_by, result, reviewed_by, reviewed_at)
      VALUES (${issueId}::uuid, ${versionId}::uuid, ${summary}, ${submittedById}::uuid,
              ${result}::resolution_result, ${reviewedBy}::uuid, ${reviewedAt}::timestamptz)
    `).rejects.toMatchObject({
      code: 'P2010',
      message: expect.stringContaining('23514'),
    });
    expect(await prisma.resolutionAttempt.count()).toBe(0);
  });

  it.each(partialReviews)('%s 있도록 바꾸면 CHECK가 거부하고 기존 결과를 보존한다', async (_, hasResult, hasReviewer, hasReviewedAt) => {
    const attempt = await prisma.resolutionAttempt.create({
      data: { ...attemptData, result: 'REOPENED', reviewedById: reviewerId, reviewedAt: new Date() },
    });
    const result = hasResult ? 'VERIFIED' : null;
    const reviewedBy = hasReviewer ? reviewerId : null;
    const reviewedAt = hasReviewedAt ? new Date() : null;

    await expect(prisma.$executeRaw`
      UPDATE resolution_attempts
      SET result = ${result}::resolution_result, reviewed_by = ${reviewedBy}::uuid, reviewed_at = ${reviewedAt}::timestamptz
      WHERE id = ${attempt.id}::uuid
    `).rejects.toMatchObject({ code: 'P2010', message: expect.stringContaining('23514') });
    expect(await prisma.resolutionAttempt.findMany()).toEqual([attempt]);
  });

  it.each([true, false])('같은 버전의 화면을 고르는 경우(%s)와 화면을 비우는 경우 모두 저장된다', async (hasScreen) => {
    const data = { ...attemptData, versionScreenId: hasScreen ? versionScreenId : null };
    const attempt = await prisma.resolutionAttempt.create({ data });

    expect(await prisma.resolutionAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).toMatchObject(data);
  });

  it.each(['같은 프로젝트의 다른 버전', '다른 프로젝트의 버전'] as const)(
    '%s의 화면을 넣으면 트랜잭션 중에는 허용하고 커밋 때 거부한다',
    async (relation) => {
      const screen = await prisma.versionScreen.findUniqueOrThrow({ where: { id: versionScreenId } });
      const issue = await prisma.issue.findUniqueOrThrow({ where: { id: attemptData.issueId } });
      const otherScreen = relation === '다른 프로젝트의 버전'
        ? (await createIssueWithScreen(reviewerId)).versionScreen
        : await prisma.versionScreen.create({
          data: { versionId: issue.originVersionId, screenId: screen.screenId, assetId: screen.assetId },
        });
      let reachedCommit = false;

      const transaction = prisma.$transaction(async (tx) => {
        await tx.resolutionAttempt.create({ data: { ...attemptData, versionScreenId: otherScreen.id } });
        reachedCommit = true;
      });

      await expect(transaction).rejects.toMatchObject({ cause: { originalCode: '23503' } });
      expect(reachedCommit).toBe(true);
      expect(await prisma.resolutionAttempt.count()).toBe(0);
    },
  );

  it.each(['versionId', 'versionScreenId'] as const)('없는 %s를 가리키면 커밋 때 거부한다', async (field) => {
    let reachedCommit = false;
    const transaction = prisma.$transaction(async (tx) => {
      await tx.resolutionAttempt.create({ data: { ...attemptData, [field]: missingId } });
      reachedCommit = true;
    });

    await expect(transaction).rejects.toMatchObject({ cause: { originalCode: '23503' } });
    expect(reachedCommit).toBe(true);
    expect(await prisma.resolutionAttempt.count()).toBe(0);
  });

  it.each(['issueId', 'submittedById', 'reviewedById'] as const)('없는 %s를 가리키는 줄은 저장할 수 없다', async (field) => {
    await expect(prisma.resolutionAttempt.create({
      data: { ...attemptData, result: 'VERIFIED', reviewedById: reviewerId, reviewedAt: new Date(), [field]: missingId },
    })).rejects.toMatchObject({ code: 'P2003' });
    expect(await prisma.resolutionAttempt.count()).toBe(0);
  });

  it('같은 쪽지와 버전으로 여러 줄을 쌓아도 지난 결과는 그대로다', async () => {
    const first = await prisma.resolutionAttempt.create({
      data: { ...attemptData, result: 'REOPENED', reviewedById: reviewerId, reviewedAt: new Date() },
    });
    const second = await prisma.resolutionAttempt.create({ data: { ...attemptData, summary: '다시 고쳤어요' } });

    expect(second.id).not.toBe(first.id);
    expect(await prisma.resolutionAttempt.count({ where: { issueId: attemptData.issueId } })).toBe(2);
    expect(await prisma.resolutionAttempt.findUnique({ where: { id: first.id } })).toEqual(first);
    expect(await prisma.resolutionAttempt.findUnique({ where: { id: second.id } })).toEqual(second);
  });

  it('쪽지를 지우면 그 줄만 함께 지워지고 다른 쪽지의 줄과 버전·화면·사용자는 남는다', async () => {
    const issue = await prisma.issue.findUniqueOrThrow({ where: { id: attemptData.issueId } });
    const otherIssue = await prisma.issue.create({
      data: { projectId, originVersionId: issue.originVersionId, authorId: issue.authorId, number: 2, title: '다른 쪽지', body: '', requestId: randomUUID() },
    });
    await prisma.resolutionAttempt.create({ data: { ...attemptData, versionScreenId } });
    await prisma.resolutionAttempt.create({
      data: { ...attemptData, result: 'VERIFIED', reviewedById: reviewerId, reviewedAt: new Date() },
    });
    const remaining = await prisma.resolutionAttempt.create({ data: { ...attemptData, issueId: otherIssue.id } });

    await prisma.issue.delete({ where: { id: issue.id } });

    expect(await prisma.issue.findMany()).toEqual([otherIssue]);
    expect(await prisma.resolutionAttempt.findMany()).toEqual([remaining]);
    expect(await prisma.deliveryVersion.count()).toBe(2);
    expect(await prisma.versionScreen.count()).toBe(1);
    expect(await prisma.user.count()).toBe(3);
  });

  it('고쳤어요가 있는 프로젝트를 DB에서 지우면 줄도 함께 지워진다', async () => {
    await prisma.resolutionAttempt.create({ data: { ...attemptData, versionScreenId } });
    await prisma.resolutionAttempt.create({
      data: { ...attemptData, result: 'VERIFIED', reviewedById: reviewerId, reviewedAt: new Date() },
    });
    const other = await createIssueWithScreen(reviewerId);
    const remaining = await prisma.resolutionAttempt.create({
      data: { ...attemptData, issueId: other.issue.id, versionId: other.version.id, versionScreenId: other.versionScreen.id },
    });

    await prisma.$executeRaw`DELETE FROM projects WHERE id = ${projectId}::uuid`;

    expect(await prisma.resolutionAttempt.findMany()).toEqual([remaining]);
    expect(await prisma.project.findMany()).toEqual([other.project]);
    expect(await prisma.issue.findMany()).toEqual([other.issue]);
    expect(await prisma.deliveryVersion.findMany()).toEqual(expect.arrayContaining([other.originVersion, other.version]));
    expect(await prisma.deliveryVersion.count()).toBe(2);
    expect(await prisma.versionScreen.findMany()).toEqual([other.versionScreen]);
    expect(await prisma.screen.findMany()).toEqual([other.screen]);
    expect(await prisma.asset.findMany()).toEqual([other.asset]);
    expect(await prisma.user.count()).toBe(3);
  });

  it.each(['버전', '버전 화면'] as const)('줄이 가리키는 %s만 따로 지우면 커밋 때 거부하고 줄과 대상을 보존한다', async (target) => {
    // 버전만 검사할 때는 화면을 비워 두어 두 칸짜리 외래키가 대신 막지 않게 한다.
    const attempt = await prisma.resolutionAttempt.create({
      data: { ...attemptData, versionScreenId: target === '버전 화면' ? versionScreenId : null },
    });
    const version = await prisma.deliveryVersion.findUniqueOrThrow({ where: { id: attempt.versionId } });
    const screen = await prisma.versionScreen.findUniqueOrThrow({ where: { id: versionScreenId } });
    let reachedCommit = false;
    const transaction = prisma.$transaction(async (tx) => {
      if (target === '버전') await tx.deliveryVersion.delete({ where: { id: version.id } });
      if (target === '버전 화면') await tx.versionScreen.delete({ where: { id: screen.id } });
      reachedCommit = true;
    });

    await expect(transaction).rejects.toMatchObject({ cause: { originalCode: '23503' } });
    expect(reachedCommit).toBe(true);
    expect(await prisma.resolutionAttempt.findMany()).toEqual([attempt]);
    expect(await prisma.deliveryVersion.findUnique({ where: { id: version.id } })).toEqual(version);
    expect(await prisma.versionScreen.findUnique({ where: { id: screen.id } })).toEqual(screen);
  });

  it.each(['submittedById', 'reviewedById'] as const)('줄의 %s가 가리키는 사용자는 RESTRICT로 지울 수 없다', async (field) => {
    const attempt = await prisma.resolutionAttempt.create({
      data: { ...attemptData, result: 'VERIFIED', reviewedById: reviewerId, reviewedAt: new Date() },
    });
    const userId = attempt[field]!;
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

    // 작성자·멤버·일지와 연결되지 않은 사용자라 고쳤어요 외래키만 삭제를 막는다.
    await expect(prisma.$executeRaw`DELETE FROM users WHERE id = ${userId}::uuid`).rejects.toMatchObject({
      code: 'P2010', message: expect.stringContaining('23503'),
    });
    expect(await prisma.user.findUnique({ where: { id: userId } })).toEqual(user);
    expect(await prisma.resolutionAttempt.findMany()).toEqual([attempt]);
  });

  it('resolution_result에 없는 값은 DB가 거부하고 기존 결과를 보존한다', async () => {
    const attempt = await prisma.resolutionAttempt.create({
      data: { ...attemptData, result: 'VERIFIED', reviewedById: reviewerId, reviewedAt: new Date() },
    });

    // 명시적으로 enum 형변환을 하지 않아 result 칸 자체가 값을 제한하는지 본다.
    await expect(prisma.$executeRaw`
      UPDATE resolution_attempts SET result = 'UNKNOWN' WHERE id = ${attempt.id}::uuid
    `).rejects.toMatchObject({ code: 'P2010', message: expect.stringContaining('22P02') });
    expect(await prisma.resolutionAttempt.findMany()).toEqual([attempt]);
  });

  it.each(['READY_FOR_REVIEW', 'VERIFIED', 'WITHDRAWN'] as const)('쪽지 상태 %s를 저장하고 그대로 읽는다', async (status) => {
    const issue = await prisma.issue.findUniqueOrThrow({ where: { id: attemptData.issueId } });
    await prisma.issue.update({ where: { id: issue.id }, data: { status } });

    expect(await prisma.issue.findMany()).toEqual([{ ...issue, status }]);
  });

  it.each(['RESOLUTION_SUBMITTED', 'ISSUE_VERIFIED', 'ISSUE_REOPENED', 'ISSUE_WITHDRAWN'] as const)(
    '일지 사건 %s와 쪽지·버전이 저장된다',
    async (type) => {
      const data = { projectId, actorId: attemptData.submittedById, type, issueId: attemptData.issueId, versionId: attemptData.versionId };
      const event = await prisma.activityEvent.create({ data });

      expect(await prisma.activityEvent.findMany()).toEqual([
        { ...data, id: event.id, memberId: null, createdAt: expect.any(Date) },
      ]);
    },
  );

  it('고쳤어요 이력을 찾는 인덱스는 issue_id와 created_at 순서다', async () => {
    const indexes = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = current_schema() AND tablename = 'resolution_attempts'
    `;

    expect(indexes).toEqual(expect.arrayContaining([
      { indexdef: expect.stringMatching(/\(issue_id, created_at\)$/) },
    ]));
  });

  it('resetDatabase는 고쳤어요 줄과 연결된 표도 비우고 다시 실행할 수 있다', async () => {
    await prisma.resolutionAttempt.create({ data: { ...attemptData, versionScreenId } });
    await prisma.resolutionAttempt.create({
      data: { ...attemptData, result: 'VERIFIED', reviewedById: reviewerId, reviewedAt: new Date() },
    });

    await resetDatabase(prisma);

    expect(await prisma.resolutionAttempt.count()).toBe(0);
    expect(await prisma.issue.count()).toBe(0);
    expect(await prisma.deliveryVersion.count()).toBe(0);
    expect(await prisma.versionScreen.count()).toBe(0);
    expect(await prisma.project.count()).toBe(0);
    expect(await prisma.user.count()).toBe(0);
    await resetDatabase(prisma);
    expect(await prisma.resolutionAttempt.count()).toBe(0);
  });
});
