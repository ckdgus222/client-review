import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { resetDatabase } from '../../test/reset-database.js';
import { ActivityService } from '../activity/activity.service.js';
import type { DeliveryVersion, Prisma, User } from '../generated/prisma/client.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { VersionsService } from '../versions/versions.service.js';
import { IssueTriageService, type IssueChange } from './issue-triage.service.js';
import { IssuesService } from './issues.service.js';

const missingId = '00000000-0000-4000-8000-000000000001';
const notFound = { status: 404, response: { statusCode: 404, message: '없는 쪽지예요', error: 'Not Found' } };
const forbidden = { status: 403, response: { statusCode: 403, error: 'Forbidden' } };
const versionChanged = {
  status: 409,
  response: { statusCode: 409, code: 'VERSION_CHANGED', message: '새 버전이 올라왔어요' },
};
const versionNotInReview = {
  status: 409,
  response: { statusCode: 409, code: 'VERSION_NOT_IN_REVIEW', message: '검수 중인 버전이 아니에요' },
};

describe('IssueTriageService', () => {
  let module: TestingModule | undefined;
  let prisma: PrismaService;
  let service: IssueTriageService;
  let issues: IssuesService;
  let versions: VersionsService;
  let developer: User;
  let client: User;
  let approver: User;
  let outsider: User;
  let projectId: string;
  let issueId: string;
  let current: DeliveryVersion;

  const input = (changes: Partial<IssueChange> = {}): IssueChange => ({
    versionId: current.id,
    category: 'DESIGN',
    ...changes,
  });
  const readState = async () => ({
    issues: await prisma.issue.findMany({ orderBy: { id: 'asc' } }),
    comments: await prisma.comment.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
    events: await prisma.activityEvent.findMany({ orderBy: { id: 'asc' } }),
  });
  const publishVersion = async (number: number, targetProjectId = projectId) => {
    const version = await prisma.deliveryVersion.create({
      data: { projectId: targetProjectId, number, status: 'IN_REVIEW', publishedAt: new Date() },
    });
    await prisma.project.update({ where: { id: targetProjectId }, data: { currentVersionId: version.id } });
    return version;
  };

  // 별도 연결이 Project를 잠근 동안 update가 실제 DB 잠금을 기다리는지 확인한다.
  // 기다림을 확인한 다음 값을 바꿔야, 잠그기 전에 읽은 값을 쓰는 구현을 잡아낼 수 있다.
  const updateWhileLocked = async (
    userId: string,
    change: IssueChange,
    changeWhileLocked: (tx: Prisma.TransactionClient) => Promise<void>,
  ) => {
    let pending: Promise<unknown> | undefined;
    let settled = false;
    try {
      await prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM projects WHERE id = ${projectId}::uuid FOR UPDATE`;
          const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          pending = service
            .update(issueId, userId, change)
            .catch((error: unknown) => error)
            .finally(() => {
              settled = true;
            });
          await vi.waitFor(
            async () => {
              const [{ waiting }] = await prisma.$queryRaw<{ waiting: boolean }[]>`
                SELECT EXISTS (
                  SELECT 1 FROM pg_stat_activity
                  WHERE datname = current_database() AND ${pid}::int = ANY(pg_blocking_pids(pid))
                    AND query ILIKE '%projects%' AND query ILIKE '%FOR UPDATE%'
                ) AS waiting
              `;
              expect(settled).toBe(false);
              expect(waiting).toBe(true);
            },
            { timeout: 2_000, interval: 20 },
          );
          await changeWhileLocked(tx);
        },
        { maxWait: 5_000, timeout: 10_000 },
      );
    } finally {
      await pending;
    }
    return pending;
  };

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [IssueTriageService, IssuesService, ProjectsService, ActivityService, VersionsService],
    }).compile();
    prisma = module.get(PrismaService);
    service = module.get(IssueTriageService);
    issues = module.get(IssuesService);
    versions = module.get(VersionsService);
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    developer = await prisma.user.create({ data: { email: 'developer@example.com', name: '개발자' } });
    client = await prisma.user.create({ data: { email: 'client@example.com', name: '클라이언트' } });
    approver = await prisma.user.create({ data: { email: 'approver@example.com', name: '승인자' } });
    outsider = await prisma.user.create({ data: { email: 'outsider@example.com', name: '외부인' } });
    const project = await prisma.project.create({
      data: {
        name: '쪽지 정리 검수',
        members: {
          create: [
            { userId: developer.id, role: 'DEVELOPER' },
            { userId: client.id, role: 'CLIENT' },
            { userId: approver.id, role: 'CLIENT' },
          ],
        },
      },
      include: { members: true },
    });
    projectId = project.id;
    await prisma.project.update({
      where: { id: projectId },
      data: { approverMemberId: project.members.find(({ userId }) => userId === approver.id)!.id },
    });
    current = await publishVersion(0);
    const issue = await prisma.issue.create({
      data: {
        projectId,
        originVersionId: current.id,
        number: 1,
        authorId: client.id,
        requestId: randomUUID(),
        title: '버튼 수정',
        body: '버튼 글자를 확인해 주세요',
      },
    });
    issueId = issue.id;
  });

  afterAll(async () => {
    await module?.close();
  });

  it.each(['없는 쪽지', '멤버 아님', '철회된 작성자', '철회된 개발자'] as const)(
    '%s이면 권한·버전 검사보다 먼저 같은 404이고 아무것도 바뀌지 않는다',
    async (scenario) => {
      const actor = scenario === '멤버 아님' ? outsider : scenario === '철회된 개발자' ? developer : client;
      if (scenario === '철회된 작성자' || scenario === '철회된 개발자') {
        await prisma.projectMember.update({
          where: { projectId_userId: { projectId, userId: actor.id } },
          data: { revokedAt: new Date() },
        });
      }
      const before = await readState();
      await expect(
        service.update(scenario === '없는 쪽지' ? missingId : issueId, actor.id, input({ versionId: missingId })),
      ).rejects.toMatchObject(notFound);
      expect(await readState()).toEqual(before);
    },
  );

  // 기획 표의 이름을 유지한다. 이 조각은 서비스의 예외를 검사하며 HTTP 응답은 조각 4에서 검사한다.
  it.each([
    ['클라이언트', '범위', { scope: 'OUT_OF_SCOPE' }],
    ['클라이언트', '마감일', { dueDate: '2026-11-15' }],
    ['승인자', '범위', { scope: 'OUT_OF_SCOPE' }],
    ['승인자', '마감일', { dueDate: '2026-11-15' }],
  ] as const)('%s가 %s를 바꾸면 403이고 쪽지와 댓글이 그대로다', async (role, _field, change) => {
    const actor = role === '클라이언트' ? client : approver;
    // 승인자도 자기 쪽지라고 해서 범위·마감일 권한을 얻지 않는다.
    await prisma.issue.update({ where: { id: issueId }, data: { authorId: actor.id } });
    const before = await readState();
    await expect(service.update(issueId, actor.id, { versionId: current.id, ...change })).rejects.toMatchObject(
      forbidden,
    );
    expect(await readState()).toEqual(before);
  });

  it.each(['클라이언트', '승인자'] as const)(
    '%s가 남이 쓴 쪽지의 분류를 바꾸면 403이고 분류가 그대로다',
    async (role) => {
      await prisma.issue.update({ where: { id: issueId }, data: { authorId: developer.id } });
      const actor = role === '클라이언트' ? client : approver;
      const before = await readState();
      await expect(service.update(issueId, actor.id, input())).rejects.toMatchObject(forbidden);
      expect(await readState()).toEqual(before);
    },
  );

  it.each(['클라이언트', '승인자', '개발자'] as const)('%s는 자기 쪽지의 분류를 바꾼다', async (role) => {
    const actor = { 클라이언트: client, 승인자: approver, 개발자: developer }[role];
    await prisma.issue.update({ where: { id: issueId }, data: { authorId: actor.id } });
    const before = await readState();
    const result = await service.update(issueId, actor.id, input());
    expect(result).toMatchObject({ id: issueId, category: 'DESIGN', isMine: true, comments: [] });
    const after = await readState();
    expect(after.issues).toEqual(before.issues.map((issue) => ({ ...issue, category: 'DESIGN' })));
    expect(after.comments).toEqual(before.comments);
    expect(after.events).toEqual(before.events);
  });

  it('쓴 사람은 자기 쪽지의 분류를 바꾸고 개발자는 남의 쪽지의 분류도 바꾼다', async () => {
    expect(await service.update(issueId, client.id, input())).toMatchObject({ category: 'DESIGN', isMine: true });
    expect(await service.update(issueId, developer.id, input({ category: 'COPY' }))).toMatchObject({
      category: 'COPY',
      isMine: false,
    });
    expect((await readState()).issues[0].category).toBe('COPY');
    expect(await prisma.comment.count()).toBe(0);
  });

  it.each([
    ['범위', { scope: 'OUT_OF_SCOPE' }],
    ['마감일', { dueDate: '2026-11-15' }],
    ['마감일 지우기', { dueDate: null }],
    ['같은 범위', { scope: 'IN_SCOPE' }],
  ] as const)('권한 없는 칸이 섞인 요청은 403이고 바꿀 수 있는 칸도 저장하지 않는다: %s', async (_field, change) => {
    const before = await readState();
    await expect(service.update(issueId, client.id, input(change))).rejects.toMatchObject(forbidden);
    expect(await readState()).toEqual(before);
  });

  it.each([
    ['남의 분류', { category: 'DESIGN' }],
    ['범위', { scope: 'OUT_OF_SCOPE' }],
    ['마감일', { dueDate: '2026-11-15' }],
  ] as const)('%s의 권한 검사는 버전 검사보다 먼저다', async (_field, change) => {
    await prisma.issue.update({ where: { id: issueId }, data: { authorId: developer.id } });
    await prisma.deliveryVersion.update({ where: { id: current.id }, data: { status: 'APPROVED' } });
    const before = await readState();
    await expect(service.update(issueId, client.id, { versionId: missingId, ...change })).rejects.toMatchObject(
      forbidden,
    );
    await expect(service.update(issueId, client.id, { versionId: current.id, ...change })).rejects.toMatchObject(
      forbidden,
    );
    expect(await readState()).toEqual(before);
  });

  it.each(['지난 버전', '게시 전 버전', '다른 프로젝트 현재 버전', '없는 버전', '현재 버전 없음'] as const)(
    '%s이면 409 VERSION_CHANGED이고 아무것도 바뀌지 않는다',
    async (scenario) => {
      let versionId = missingId;
      if (scenario === '지난 버전') {
        versionId = current.id;
        await publishVersion(1);
      }
      if (scenario === '게시 전 버전') versionId = (await prisma.deliveryVersion.create({ data: { projectId } })).id;
      if (scenario === '다른 프로젝트 현재 버전') {
        const other = await prisma.project.create({ data: { name: '다른 프로젝트' } });
        versionId = (await publishVersion(0, other.id)).id;
      }
      if (scenario === '현재 버전 없음') {
        versionId = current.id;
        await prisma.project.update({ where: { id: projectId }, data: { currentVersionId: null } });
      }
      const before = await readState();
      await expect(
        service.update(issueId, developer.id, input({ versionId, scope: 'OUT_OF_SCOPE', dueDate: '2026-11-15' })),
      ).rejects.toMatchObject(versionChanged);
      expect(await readState()).toEqual(before);
    },
  );

  it('현재 버전이 승인됐으면 409 VERSION_NOT_IN_REVIEW이고 아무것도 바뀌지 않는다', async () => {
    await prisma.deliveryVersion.update({ where: { id: current.id }, data: { status: 'APPROVED' } });
    const before = await readState();
    await expect(
      service.update(issueId, developer.id, input({ scope: 'OUT_OF_SCOPE', dueDate: '2026-11-15' })),
    ).rejects.toMatchObject(versionNotInReview);
    // 버전이 다르면 상태 검사보다 VERSION_CHANGED가 먼저다.
    await expect(service.update(issueId, developer.id, input({ versionId: missingId }))).rejects.toMatchObject(
      versionChanged,
    );
    expect(await readState()).toEqual(before);
  });

  it.each(['새 버전 게시', '현재 버전 승인'] as const)(
    '같은 값을 다시 보내도 %s의 버전 검사를 생략하지 않는다',
    async (change) => {
      const request = input({ scope: 'OUT_OF_SCOPE', dueDate: '2026-11-15' });
      await service.update(issueId, developer.id, request);
      if (change === '새 버전 게시') await publishVersion(1);
      if (change === '현재 버전 승인') {
        await prisma.deliveryVersion.update({ where: { id: current.id }, data: { status: 'APPROVED' } });
      }
      const before = await readState();
      await expect(service.update(issueId, developer.id, request)).rejects.toMatchObject(
        change === '새 버전 게시' ? versionChanged : versionNotInReview,
      );
      expect(await readState()).toEqual(before);
    },
  );

  it.each([
    ['분류', { category: 'BUG' }],
    ['범위', { scope: 'IN_SCOPE' }],
    ['마감일', { dueDate: '2026-11-10' }],
    ['마감일 없음', { dueDate: null }],
  ] as const)('같은 값으로 바꾸면 200이고 댓글이 생기지 않는다: %s', async (field, change) => {
    if (field === '마감일') {
      await prisma.issue.update({ where: { id: issueId }, data: { dueDate: new Date('2026-11-10T00:00:00.000Z') } });
    }
    const detail = await issues.getDetail(issueId, developer.id);
    const before = await readState();
    try {
      // 같은 값을 UPDATE해도 행 내용은 같으므로, 저장 시도 자체를 트리거로 잡는다.
      await prisma.$executeRaw`
        CREATE FUNCTION issue_triage_reject_update() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'unchanged issue must not be updated';
        END;
        $$
      `;
      await prisma.$executeRaw`
        CREATE TRIGGER issue_triage_reject_update BEFORE UPDATE ON issues FOR EACH ROW
        EXECUTE FUNCTION issue_triage_reject_update()
      `;
      expect(await service.update(issueId, developer.id, { versionId: current.id, ...change })).toEqual(detail);
      expect(await readState()).toEqual(before);
    } finally {
      try {
        await prisma.$executeRaw`DROP TRIGGER IF EXISTS issue_triage_reject_update ON issues`;
      } finally {
        await prisma.$executeRaw`DROP FUNCTION IF EXISTS issue_triage_reject_update()`;
      }
    }
  });

  it.each(['BUG', 'DESIGN', 'COPY', 'OTHER'] as const)('분류 %s를 저장하고 다른 칸은 그대로 둔다', async (category) => {
    await prisma.issue.update({
      where: { id: issueId },
      data: {
        category: category === 'BUG' ? 'OTHER' : 'BUG',
        scope: 'OUT_OF_SCOPE',
        dueDate: new Date('2026-11-10T00:00:00.000Z'),
      },
    });
    const before = await readState();
    const result = await service.update(issueId, client.id, input({ category }));
    expect(result).toMatchObject({ category, scope: 'OUT_OF_SCOPE', dueDate: '2026-11-10', comments: [] });
    expect(await readState()).toEqual({ ...before, issues: before.issues.map((issue) => ({ ...issue, category })) });
  });

  it('범위를 바꾸면 바꾸기 전과 뒤 값이 적힌 댓글이 개발자 이름과 현재 버전으로 남는다', async () => {
    const next = await publishVersion(1);
    const before = await readState();
    const result = await service.update(issueId, developer.id, { versionId: next.id, scope: 'OUT_OF_SCOPE' });
    expect(result).toEqual({
      id: issueId,
      number: 1,
      title: '버튼 수정',
      body: '버튼 글자를 확인해 주세요',
      status: 'OPEN',
      category: 'BUG',
      scope: 'OUT_OF_SCOPE',
      dueDate: null,
      authorName: client.name,
      createdAt: before.issues[0].createdAt,
      commentCount: 1,
      originVersion: { id: current.id, number: 0 },
      origin: null,
      isMine: false,
      attempts: [],
      canReview: false,
      projectId,
      attachments: [],
      comments: [
        {
          id: expect.any(String),
          authorName: developer.name,
          versionNumber: 1,
          body: '범위: 하자 수정 → 추가 요청',
          createdAt: expect.any(Date),
        },
      ],
    });
    expect(await readState()).toEqual({
      issues: before.issues.map((issue) => ({ ...issue, scope: 'OUT_OF_SCOPE' })),
      comments: [
        {
          id: result.comments[0].id,
          issueId,
          authorId: developer.id,
          versionId: next.id,
          body: '범위: 하자 수정 → 추가 요청',
          requestId: null,
          createdAt: result.comments[0].createdAt,
        },
      ],
      events: before.events,
    });
  });

  it('지정한 쪽지만 바꾸고 기존 일반 댓글과 다른 쪽지는 그대로 둔다', async () => {
    const other = await prisma.issue.create({
      data: {
        projectId,
        originVersionId: current.id,
        number: 2,
        authorId: approver.id,
        requestId: randomUUID(),
        title: '다른 쪽지',
        body: '',
      },
    });
    await prisma.comment.createMany({
      data: [
        { issueId, authorId: client.id, versionId: current.id, requestId: randomUUID(), body: '먼저 남긴 댓글' },
        {
          issueId: other.id,
          authorId: approver.id,
          versionId: current.id,
          requestId: randomUUID(),
          body: '다른 쪽지 댓글',
        },
      ],
    });
    const before = await readState();
    const detail = await issues.getDetail(issueId, developer.id);
    const result = await service.update(issueId, developer.id, input({ scope: 'OUT_OF_SCOPE', dueDate: '2026-11-15' }));
    const after = await readState();
    expect(after.issues).toEqual(
      before.issues.map((issue) =>
        issue.id === issueId
          ? { ...issue, category: 'DESIGN', scope: 'OUT_OF_SCOPE', dueDate: new Date('2026-11-15T00:00:00.000Z') }
          : issue,
      ),
    );
    expect(after.comments.slice(0, 2)).toEqual(before.comments);
    expect(after.comments).toHaveLength(4);
    expect(after.events).toEqual(before.events);
    expect(result.comments.slice(0, 1)).toEqual(detail.comments);
    expect(result.comments.map(({ body }) => body)).toEqual([
      '먼저 남긴 댓글',
      '범위: 하자 수정 → 추가 요청',
      '마감일: 없음 → 2026년 11월 15일',
    ]);
    expect(result.commentCount).toBe(3);
    expect(result).toEqual(await issues.getDetail(issueId, developer.id));
  });

  it('마감일을 정하고 바꾸고 지우면 댓글이 차례로 쌓이고 지난 댓글은 그대로다', async () => {
    const first = await service.update(issueId, developer.id, { versionId: current.id, dueDate: '2026-11-10' });
    const savedFirst = (await readState()).comments;
    expect(first.comments.map(({ body }) => body)).toEqual(['마감일: 없음 → 2026년 11월 10일']);
    const second = await service.update(issueId, developer.id, { versionId: current.id, dueDate: '2026-11-15' });
    const savedSecond = (await readState()).comments;
    expect(second.comments.map(({ body }) => body)).toEqual([
      '마감일: 없음 → 2026년 11월 10일',
      '마감일: 2026년 11월 10일 → 2026년 11월 15일',
    ]);
    expect(second.comments[0]).toEqual(first.comments[0]);
    expect(savedSecond.slice(0, 1)).toEqual(savedFirst);
    const third = await service.update(issueId, developer.id, { versionId: current.id, dueDate: null });
    expect(third).toMatchObject({ dueDate: null, commentCount: 3 });
    expect(third.comments.map(({ body }) => body)).toEqual([
      '마감일: 없음 → 2026년 11월 10일',
      '마감일: 2026년 11월 10일 → 2026년 11월 15일',
      '마감일: 2026년 11월 15일 → 없음',
    ]);
    expect(third.comments.slice(0, 2)).toEqual(second.comments);
    expect((await readState()).comments.slice(0, 2)).toEqual(savedSecond);
    expect((await readState()).issues[0].dueDate).toBeNull();
  });

  it('범위와 마감일을 함께 바꾸면 범위 댓글과 마감일 댓글이 차례로 하나씩 남는다', async () => {
    const result = await service.update(issueId, developer.id, input({ scope: 'OUT_OF_SCOPE', dueDate: '2026-11-15' }));
    expect(result).toMatchObject({ category: 'DESIGN', scope: 'OUT_OF_SCOPE', dueDate: '2026-11-15', commentCount: 2 });
    expect(result.comments.map(({ body }) => body)).toEqual([
      '범위: 하자 수정 → 추가 요청',
      '마감일: 없음 → 2026년 11월 15일',
    ]);
    expect(result.comments[0].createdAt.getTime()).toBeLessThanOrEqual(result.comments[1].createdAt.getTime());
    expect((await readState()).comments).toEqual(
      result.comments.map((comment) => ({
        id: comment.id,
        issueId,
        authorId: developer.id,
        versionId: current.id,
        body: comment.body,
        requestId: null,
        createdAt: comment.createdAt,
      })),
    );
  });

  it('같은 칸과 달라진 칸을 함께 보내면 달라진 칸의 댓글만 남는다', async () => {
    const first = await service.update(
      issueId,
      developer.id,
      input({ category: 'BUG', scope: 'IN_SCOPE', dueDate: '2026-01-05' }),
    );
    expect(first.comments.map(({ body }) => body)).toEqual(['마감일: 없음 → 2026년 1월 5일']);
    const second = await service.update(
      issueId,
      developer.id,
      input({ category: 'BUG', scope: 'OUT_OF_SCOPE', dueDate: '2026-01-05' }),
    );
    expect(second.comments.map(({ body }) => body)).toEqual([
      '마감일: 없음 → 2026년 1월 5일',
      '범위: 하자 수정 → 추가 요청',
    ]);
    expect(second.comments[0]).toEqual(first.comments[0]);
  });

  it('저장된 범위 변경을 다시 보내면 댓글이 하나만 남고 그사이 다른 값으로 바뀌었으면 새 변경으로 저장되어 댓글이 차례로 이어진다', async () => {
    const request: IssueChange = { versionId: current.id, scope: 'OUT_OF_SCOPE' };
    const first = await service.update(issueId, developer.id, request);
    const beforeRetry = await readState();
    expect(await service.update(issueId, developer.id, request)).toEqual(first);
    expect(await readState()).toEqual(beforeRetry);
    const second = await service.update(issueId, developer.id, { versionId: current.id, scope: 'IN_SCOPE' });
    const third = await service.update(issueId, developer.id, request);
    expect(third.scope).toBe('OUT_OF_SCOPE');
    expect(third.comments.map(({ body }) => body)).toEqual([
      '범위: 하자 수정 → 추가 요청',
      '범위: 추가 요청 → 하자 수정',
      '범위: 하자 수정 → 추가 요청',
    ]);
    expect(third.comments.slice(0, 2)).toEqual(second.comments);
    expect(third.comments[0]).toEqual(first.comments[0]);
    const after = await readState();
    expect(after.comments[0]).toEqual(beforeRetry.comments[0]);
    expect(after.issues[0].scope).toBe('OUT_OF_SCOPE');
  });

  it('마감일 변경도 재전송은 한 번만 기록하고 중간에 다른 값이 저장되면 새 변경으로 남긴다', async () => {
    const request: IssueChange = { versionId: current.id, dueDate: '2026-11-15' };
    const first = await service.update(issueId, developer.id, request);
    const before = await readState();
    expect(await service.update(issueId, developer.id, request)).toEqual(first);
    expect(await readState()).toEqual(before);
    await service.update(issueId, developer.id, { versionId: current.id, dueDate: null });
    const result = await service.update(issueId, developer.id, request);
    expect(result.comments.map(({ body }) => body)).toEqual([
      '마감일: 없음 → 2026년 11월 15일',
      '마감일: 2026년 11월 15일 → 없음',
      '마감일: 없음 → 2026년 11월 15일',
    ]);
    expect(result.comments[0]).toEqual(first.comments[0]);
    expect(result.dueDate).toBe('2026-11-15');
  });

  it('분류를 바꾸면 댓글이 생기지 않고 분류·범위·마감일 변경은 활동 일지에 남지 않는다', async () => {
    const before = await readState();
    expect((await service.update(issueId, developer.id, input())).comments).toEqual([]);
    await service.update(issueId, developer.id, { versionId: current.id, scope: 'OUT_OF_SCOPE' });
    await service.update(issueId, developer.id, { versionId: current.id, dueDate: '2026-11-15' });
    const after = await readState();
    expect(after.events).toEqual(before.events);
    expect(after.comments).toHaveLength(2);
    expect(after.issues[0]).toMatchObject({
      category: 'DESIGN',
      scope: 'OUT_OF_SCOPE',
      dueDate: new Date('2026-11-15T00:00:00.000Z'),
    });
  });

  it.each(['OPEN', 'IN_PROGRESS'] as const)(
    '%s 상태에서도 분류·범위·마감일을 바꾸고 상태는 유지한다',
    async (status) => {
      await prisma.issue.update({ where: { id: issueId }, data: { status } });
      const result = await service.update(
        issueId,
        developer.id,
        input({ scope: 'OUT_OF_SCOPE', dueDate: '2026-11-15' }),
      );
      expect(result).toMatchObject({
        status,
        category: 'DESIGN',
        scope: 'OUT_OF_SCOPE',
        dueDate: '2026-11-15',
        commentCount: 2,
      });
      expect((await readState()).issues[0]).toMatchObject({
        status,
        category: 'DESIGN',
        scope: 'OUT_OF_SCOPE',
        dueDate: new Date('2026-11-15T00:00:00.000Z'),
      });
    },
  );

  it.each([
    ['UTC', 0],
    ['Asia/Seoul', -540],
    ['America/Los_Angeles', 480],
  ] as const)(
    '마감일은 서버 시간대 %s에서도 보낸 날짜 그대로 저장되고 목록과 상세에 그대로 돌아온다',
    async (timezone, offset) => {
      vi.stubEnv('TZ', timezone);
      try {
        expect(new Date('2026-01-01T00:00:00.000Z').getTimezoneOffset()).toBe(offset);
        for (const date of ['2026-01-01', '2028-02-29', '2026-12-31']) {
          const result = await service.update(issueId, developer.id, { versionId: current.id, dueDate: date });
          expect(result.dueDate).toBe(date);
          expect((await prisma.issue.findUniqueOrThrow({ where: { id: issueId } })).dueDate?.toISOString()).toBe(
            `${date}T00:00:00.000Z`,
          );
          expect((await issues.getDetail(issueId, developer.id)).dueDate).toBe(date);
          expect((await issues.list(projectId, developer.id))[0].dueDate).toBe(date);
        }
        expect((await issues.getDetail(issueId, developer.id)).comments.map(({ body }) => body)).toEqual([
          '마감일: 없음 → 2026년 1월 1일',
          '마감일: 2026년 1월 1일 → 2028년 2월 29일',
          '마감일: 2028년 2월 29일 → 2026년 12월 31일',
        ]);
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it('댓글 저장이 실패하면 범위와 마감일도 바뀌지 않는다', async () => {
    await service.update(issueId, developer.id, { versionId: current.id, dueDate: '2026-11-10' });
    const before = await readState();
    const request = input({ scope: 'OUT_OF_SCOPE', dueDate: '2026-11-15' });
    try {
      // 두 번째(마감일) 댓글에서 실패시켜 먼저 쓴 범위 댓글까지 되돌아가는지 확인한다.
      await prisma.$executeRaw`
        CREATE FUNCTION issue_triage_fail_comment() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.body LIKE '마감일:%' THEN
            RAISE EXCEPTION 'issue triage comment failure';
          END IF;
          RETURN NEW;
        END;
        $$
      `;
      await prisma.$executeRaw`
        CREATE TRIGGER issue_triage_fail_comment BEFORE INSERT ON comments FOR EACH ROW
        EXECUTE FUNCTION issue_triage_fail_comment()
      `;
      await expect(service.update(issueId, developer.id, request)).rejects.toThrow('issue triage comment failure');
      expect(await readState()).toEqual(before);
    } finally {
      try {
        await prisma.$executeRaw`DROP TRIGGER IF EXISTS issue_triage_fail_comment ON comments`;
      } finally {
        await prisma.$executeRaw`DROP FUNCTION IF EXISTS issue_triage_fail_comment()`;
      }
    }
    const result = await service.update(issueId, developer.id, request);
    expect(result).toMatchObject({ category: 'DESIGN', scope: 'OUT_OF_SCOPE', dueDate: '2026-11-15', commentCount: 3 });
    expect((await readState()).comments[0]).toEqual(before.comments[0]);
  });

  it.each([
    ['분류', { category: 'DESIGN' }, { category: 'DESIGN' }],
    ['범위', { scope: 'OUT_OF_SCOPE' }, { scope: 'OUT_OF_SCOPE' }],
    ['마감일', { dueDate: '2026-11-15' }, { dueDate: new Date('2026-11-15T00:00:00.000Z') }],
  ] as const)(
    'Project 잠금을 기다리는 동안 %s가 요청한 값으로 바뀌면 다시 쓰거나 댓글을 만들지 않는다',
    async (_field, change, data) => {
      const before = await readState();
      const result = await updateWhileLocked(developer.id, { versionId: current.id, ...change }, async (tx) => {
        await tx.issue.update({ where: { id: issueId }, data });
      });
      expect(result).toMatchObject({ ...change, commentCount: 0, comments: [] });
      expect(await readState()).toEqual({ ...before, issues: before.issues.map((issue) => ({ ...issue, ...data })) });
    },
  );

  it.each([
    ['분류', { category: 'BUG' }, { category: 'DESIGN' }, []],
    ['범위', { scope: 'IN_SCOPE' }, { scope: 'OUT_OF_SCOPE' }, ['범위: 추가 요청 → 하자 수정']],
    [
      '마감일',
      { dueDate: null },
      { dueDate: new Date('2026-11-15T00:00:00.000Z') },
      ['마감일: 2026년 11월 15일 → 없음'],
    ],
  ] as const)(
    'Project 잠금 전에는 같았던 %s가 대기 중 달라지면 잠근 뒤의 값에서 변경한다',
    async (_field, change, data, bodies) => {
      const before = await readState();
      const result = await updateWhileLocked(developer.id, { versionId: current.id, ...change }, async (tx) => {
        await tx.issue.update({ where: { id: issueId }, data });
      });
      expect(result).toMatchObject({ ...change, commentCount: bodies.length });
      const after = await readState();
      expect(after.issues).toEqual(before.issues);
      expect(after.events).toEqual(before.events);
      expect(after.comments.map(({ body }) => body)).toEqual(bodies);
    },
  );

  it.each(['멤버 철회', '개발자 권한 회수', '새 버전 게시', '현재 버전 승인'] as const)(
    'Project 잠금을 기다린 뒤 %s를 확인하고 아무것도 저장하지 않는다',
    async (scenario) => {
      const before = await readState();
      const result = await updateWhileLocked(
        developer.id,
        input({ scope: 'OUT_OF_SCOPE', dueDate: '2026-11-15' }),
        async (tx) => {
          if (scenario === '멤버 철회' || scenario === '개발자 권한 회수') {
            await tx.projectMember.update({
              where: { projectId_userId: { projectId, userId: developer.id } },
              data: scenario === '멤버 철회' ? { revokedAt: new Date() } : { role: 'CLIENT' },
            });
            return;
          }
          if (scenario === '현재 버전 승인') {
            await tx.deliveryVersion.update({ where: { id: current.id }, data: { status: 'APPROVED' } });
            return;
          }
          const next = await tx.deliveryVersion.create({
            data: { projectId, number: 1, status: 'IN_REVIEW', publishedAt: new Date() },
          });
          await tx.project.update({ where: { id: projectId }, data: { currentVersionId: next.id } });
        },
      );
      expect(result).toMatchObject(
        {
          '멤버 철회': notFound,
          '개발자 권한 회수': forbidden,
          '새 버전 게시': versionChanged,
          '현재 버전 승인': versionNotInReview,
        }[scenario],
      );
      expect(await readState()).toEqual(before);
    },
  );

  it('같은 범위로 동시에 두 번 바꾸면 댓글은 하나만 남는다', async () => {
    const request: IssueChange = { versionId: current.id, scope: 'OUT_OF_SCOPE' };
    const [first, second] = await Promise.all([
      service.update(issueId, developer.id, request),
      service.update(issueId, developer.id, request),
    ]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ scope: 'OUT_OF_SCOPE', commentCount: 1 });
    const after = await readState();
    expect(after.issues[0].scope).toBe('OUT_OF_SCOPE');
    expect(after.comments.map(({ body }) => body)).toEqual(['범위: 하자 수정 → 추가 요청']);
    expect(after.events).toEqual([]);
  });

  it('서로 다른 마감일로 동시에 바꾸면 댓글의 앞뒤 값이 차례로 이어진다', async () => {
    const results = await Promise.all([
      service.update(issueId, developer.id, { versionId: current.id, dueDate: '2026-11-10' }),
      service.update(issueId, developer.id, { versionId: current.id, dueDate: '2026-11-15' }),
    ]);
    expect(results[0].dueDate).toBe('2026-11-10');
    expect(results[1].dueDate).toBe('2026-11-15');
    const after = await readState();
    const finalDate = after.issues[0].dueDate?.toISOString().slice(0, 10);
    expect(['2026-11-10', '2026-11-15']).toContain(finalDate);
    const bodies =
      finalDate === '2026-11-15'
        ? ['마감일: 없음 → 2026년 11월 10일', '마감일: 2026년 11월 10일 → 2026년 11월 15일']
        : ['마감일: 없음 → 2026년 11월 15일', '마감일: 2026년 11월 15일 → 2026년 11월 10일'];
    expect(after.comments.map(({ body }) => body)).toEqual(bodies);
    expect(after.events).toEqual([]);
    expect((await issues.getDetail(issueId, developer.id)).comments.map(({ body }) => body)).toEqual(bodies);
  });

  it('범위 바꾸기와 새 버전 게시가 동시에 오면 바꾸기는 저장되거나 409이고 저장된 댓글의 버전은 바꿀 때의 현재 버전이다', async () => {
    const draft = await prisma.deliveryVersion.create({ data: { projectId } });
    const screen = await prisma.screen.create({ data: { projectId, name: '상품 상세', viewport: 'PC' } });
    const asset = await prisma.asset.create({
      data: {
        projectId,
        storageKey: `${projectId}/${randomUUID()}.png`,
        mime: 'image/png',
        bytes: 100,
        width: 1200,
        height: 800,
      },
    });
    await prisma.versionScreen.create({ data: { versionId: draft.id, screenId: screen.id, assetId: asset.id } });
    const before = await readState();
    const [update, publication] = await Promise.allSettled([
      service.update(issueId, developer.id, { versionId: current.id, scope: 'OUT_OF_SCOPE' }),
      versions.publish(draft.id, developer.id),
    ]);
    expect(publication.status).toBe('fulfilled');
    expect((await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).currentVersionId).toBe(draft.id);
    const after = await readState();
    expect(after.events).toEqual([expect.objectContaining({ type: 'VERSION_PUBLISHED', versionId: draft.id })]);
    if (update.status === 'rejected') {
      expect(update.reason).toMatchObject(versionChanged);
      expect(after.issues).toEqual(before.issues);
      expect(after.comments).toEqual(before.comments);
      return;
    }
    expect(update.value).toMatchObject({ scope: 'OUT_OF_SCOPE', commentCount: 1 });
    expect(update.value.comments[0]).toMatchObject({ versionNumber: 0, body: '범위: 하자 수정 → 추가 요청' });
    expect(after.issues).toEqual(before.issues.map((issue) => ({ ...issue, scope: 'OUT_OF_SCOPE' })));
    expect(after.comments).toEqual([
      expect.objectContaining({
        issueId,
        versionId: current.id,
        authorId: developer.id,
        requestId: null,
        body: '범위: 하자 수정 → 추가 요청',
      }),
    ]);
  });
});
