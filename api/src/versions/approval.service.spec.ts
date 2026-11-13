import { randomUUID } from 'node:crypto';
import { UnprocessableEntityException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { resetDatabase } from '../../test/reset-database.js';
import { ActivityService } from '../activity/activity.service.js';
import type { DeliveryVersion, Issue, Prisma, User } from '../generated/prisma/client.js';
import { CommentsService } from '../issues/comments.service.js';
import { IssueTriageService } from '../issues/issue-triage.service.js';
import { IssuesService } from '../issues/issues.service.js';
import { ResolutionService } from '../issues/resolution.service.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { ApprovalService } from './approval.service.js';
import { VersionsService } from './versions.service.js';

const missingId = '00000000-0000-4000-8000-000000000001';
const past = '2000-01-01T00:00:00.000000Z';
const future = '9999-01-01T00:00:00.000000Z';
const notFound = { status: 404, response: { statusCode: 404, message: '없는 버전이에요', error: 'Not Found' } };
const forbidden = { status: 403, response: { statusCode: 403, error: 'Forbidden' } };
const conflict = (code: string) => ({ status: 409, response: { statusCode: 409, code } });
const checkIssue = ({ id, number, title, status }: Issue) => ({ id, number, title, status });
const summaryIssue = ({ number, title, category, scope, status }: Issue) => ({
  number,
  title,
  category,
  scope,
  status,
});

// Promise.all로 실제 요청을 함께 시작하면서 실패도 결과로 받아 두 요청의 최종 상태를 검사한다.
const outcome = async <T>(pending: Promise<T>) => {
  try {
    return { ok: true as const, value: await pending };
  } catch (error) {
    return { ok: false as const, error };
  }
};

describe('ApprovalService', () => {
  let module: TestingModule | undefined;
  let prisma: PrismaService;
  let service: ApprovalService;
  let versions: VersionsService;
  let issues: IssuesService;
  let comments: CommentsService;
  let triage: IssueTriageService;
  let resolution: ResolutionService;
  let developer: User;
  let client: User;
  let approver: User;
  let outsider: User;
  let projectId: string;
  let approverMemberId: string;
  let clientMemberId: string;
  let origin: DeliveryVersion;
  let current: DeliveryVersion;

  const readState = async (db: Prisma.TransactionClient = prisma) => ({
    projects: await db.project.findMany({ orderBy: { id: 'asc' } }),
    members: await db.projectMember.findMany({ orderBy: { id: 'asc' } }),
    versions: await db.deliveryVersion.findMany({ orderBy: { id: 'asc' } }),
    approvals: await db.approval.findMany({ orderBy: { id: 'asc' } }),
    issues: await db.issue.findMany({ orderBy: { id: 'asc' } }),
    comments: await db.comment.findMany({ orderBy: { id: 'asc' } }),
    events: await db.activityEvent.findMany({ orderBy: { id: 'asc' } }),
  });
  const dbTime = async (db: Prisma.TransactionClient = prisma) => {
    const [{ time }] = await db.$queryRaw<{ time: string }[]>`
      SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS time
    `;
    return time;
  };
  const createIssue = async (data: Partial<Prisma.IssueUncheckedCreateInput> = {}) =>
    prisma.issue.create({
      data: {
        projectId,
        originVersionId: current.id,
        authorId: client.id,
        requestId: randomUUID(),
        number: (await prisma.issue.count({ where: { projectId: data.projectId ?? projectId } })) + 1,
        title: '버튼 수정',
        body: '버튼 글자를 확인해 주세요',
        ...data,
      },
    });
  const attachScreen = async (versionId: string) => {
    const screen = await prisma.screen.create({
      data: { projectId, name: `상품 상세 ${randomUUID()}`, viewport: 'PC' },
    });
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
    const versionScreen = await prisma.versionScreen.create({
      data: { versionId, screenId: screen.id, assetId: asset.id },
    });
    return { screen, versionScreen };
  };
  const createOtherProject = async () => {
    const project = await prisma.project.create({
      data: { name: '다른 프로젝트', members: { create: { userId: developer.id, role: 'DEVELOPER' } } },
    });
    const version = await prisma.deliveryVersion.create({
      data: { projectId: project.id, number: 0, status: 'IN_REVIEW', publishedAt: new Date() },
    });
    await prisma.project.update({ where: { id: project.id }, data: { currentVersionId: version.id } });
    return { project, version };
  };
  const request = async (action: 'check' | 'approve', versionId = current.id, userId = approver.id, seenAt = past) => {
    if (action === 'check') return service.check(versionId, userId);
    return service.approve(versionId, userId, seenAt);
  };
  const expectApproval = async (expectedIssues: ReturnType<typeof summaryIssue>[] = []) => {
    const approvals = await prisma.approval.findMany();
    expect(approvals).toEqual([
      {
        id: expect.any(String),
        versionId: current.id,
        approverId: approver.id,
        approvedAt: expect.any(Date),
        summary: { issues: expectedIssues },
      },
    ]);
    expect(await prisma.deliveryVersion.findUniqueOrThrow({ where: { id: current.id } })).toEqual({
      ...current,
      status: 'APPROVED',
    });
    expect(await prisma.activityEvent.findMany({ where: { type: 'VERSION_APPROVED' } })).toEqual([
      {
        id: expect.any(String),
        projectId,
        actorId: approver.id,
        type: 'VERSION_APPROVED',
        versionId: current.id,
        issueId: null,
        memberId: null,
        createdAt: expect.any(Date),
      },
    ]);
    return approvals[0];
  };

  // 잠금을 실제로 기다리는지 DB에서 확인한 뒤 변경한다. sleep으로 요청 순서를 추측하지 않는다.
  const whileProjectLocked = async <T>(
    run: () => Promise<T>,
    change: (tx: Prisma.TransactionClient) => Promise<unknown>,
  ) => {
    let pending: ReturnType<typeof outcome<T>> | undefined;
    let settled = false;
    let stateBeforeRelease: Awaited<ReturnType<typeof readState>> | undefined;
    let timeBeforeRelease = '';
    const start = async () => {
      try {
        return await outcome(run());
      } finally {
        settled = true;
      }
    };
    try {
      await prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM projects WHERE id = ${projectId}::uuid FOR UPDATE`;
          const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          pending = start();
          await vi.waitFor(
            async () => {
              const [{ waiting }] = await prisma.$queryRaw<{ waiting: boolean }[]>`
            SELECT EXISTS (
              SELECT 1 FROM pg_stat_activity
              WHERE datname = current_database() AND ${pid}::int = ANY(pg_blocking_pids(pid))
                AND query ILIKE '%projects%'
            ) AS waiting
          `;
              expect(settled).toBe(false);
              expect(waiting).toBe(true);
            },
            { timeout: 2_000, interval: 20 },
          );
          await change(tx);
          stateBeforeRelease = await readState(tx);
          timeBeforeRelease = await dbTime(tx);
        },
        { maxWait: 5_000, timeout: 10_000 },
      );
    } finally {
      await pending;
    }
    return { result: (await pending)!, stateBeforeRelease, timeBeforeRelease };
  };

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [
        ApprovalService,
        VersionsService,
        ActivityService,
        ProjectsService,
        IssuesService,
        CommentsService,
        IssueTriageService,
        ResolutionService,
      ],
    }).compile();
    prisma = module.get(PrismaService);
    service = module.get(ApprovalService);
    versions = module.get(VersionsService);
    issues = module.get(IssuesService);
    comments = module.get(CommentsService);
    triage = module.get(IssueTriageService);
    resolution = module.get(ResolutionService);
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    developer = await prisma.user.create({ data: { email: 'developer@example.com', name: '개발자' } });
    client = await prisma.user.create({ data: { email: 'client@example.com', name: '클라이언트' } });
    approver = await prisma.user.create({ data: { email: 'approver@example.com', name: '승인자' } });
    outsider = await prisma.user.create({ data: { email: 'outsider@example.com', name: '외부인' } });
    const project = await prisma.project.create({
      data: {
        name: '승인 검수',
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
    approverMemberId = project.members.find(({ userId }) => userId === approver.id)!.id;
    clientMemberId = project.members.find(({ userId }) => userId === client.id)!.id;
    origin = await prisma.deliveryVersion.create({
      data: { projectId, number: 0, status: 'IN_REVIEW', publishedAt: new Date() },
    });
    current = await prisma.deliveryVersion.create({
      data: { projectId, number: 1, status: 'IN_REVIEW', publishedAt: new Date() },
    });
    await prisma.project.update({ where: { id: projectId }, data: { approverMemberId, currentVersionId: current.id } });
  });

  afterAll(async () => {
    await module?.close();
  });

  describe.each(['check', 'approve'] as const)('%s 권한과 검사 순서', (action) => {
    it('멤버가 아니거나 없는 버전이면 승인과 승인 검토가 404다', async () => {
      const other = await createOtherProject();
      const before = await readState();
      for (const [versionId, userId] of [
        [missingId, developer.id],
        [current.id, outsider.id],
        [other.version.id, approver.id],
      ]) {
        await expect(request(action, versionId, userId, future)).rejects.toMatchObject(notFound);
        expect(await readState()).toEqual(before);
      }
    });

    it('개발자와 승인자가 아닌 클라이언트가 승인하거나 승인 검토를 조회하면 403이고 아무것도 바뀌지 않는다', async () => {
      await createIssue();
      const before = await readState();
      for (const actor of [developer, client]) {
        // 현재 버전과 지난 버전 모두 권한을 먼저 보고 미래 seenAt 검사보다도 먼저 거절한다.
        await expect(request(action, current.id, actor.id, future)).rejects.toMatchObject(forbidden);
        await expect(request(action, origin.id, actor.id, future)).rejects.toMatchObject(forbidden);
        expect(await readState()).toEqual(before);
      }
    });

    it('승인자가 바뀌면 이전 승인자는 403이고 접근이 철회된 승인자는 404다', async () => {
      await prisma.project.update({ where: { id: projectId }, data: { approverMemberId: clientMemberId } });
      let before = await readState();
      await expect(request(action, current.id, approver.id, future)).rejects.toMatchObject(forbidden);
      expect(await readState()).toEqual(before);
      await prisma.projectMember.update({ where: { id: approverMemberId }, data: { revokedAt: new Date() } });
      before = await readState();
      await expect(request(action, current.id, approver.id, future)).rejects.toMatchObject(notFound);
      expect(await readState()).toEqual(before);
    });

    it('승인자가 없으면 활성 클라이언트도 403이다', async () => {
      await prisma.project.update({ where: { id: projectId }, data: { approverMemberId: null } });
      const before = await readState();
      await expect(request(action)).rejects.toMatchObject(forbidden);
      expect(await readState()).toEqual(before);
    });

    it('지난 버전·이미 승인된 버전·게시 전 버전은 승인과 승인 검토가 409이거나 404다', async () => {
      await service.approve(current.id, approver.id, past);
      const draft = await versions.createDraft(projectId, developer.id);
      // 버전 검사가 미해결·새 댓글 검사보다 먼저다.
      const issue = await createIssue();
      await prisma.comment.create({
        data: { issueId: issue.id, versionId: current.id, authorId: developer.id, body: '새 댓글' },
      });
      const before = await readState();
      await expect(request(action, origin.id)).rejects.toMatchObject(conflict('VERSION_CHANGED'));
      await expect(request(action)).rejects.toMatchObject(conflict('VERSION_NOT_IN_REVIEW'));
      await expect(request(action, draft.id)).rejects.toMatchObject(notFound);
      await expect(request(action, draft.id, client.id)).rejects.toMatchObject(notFound);
      await expect(request(action, draft.id, developer.id)).rejects.toMatchObject(forbidden);
      expect(await readState()).toEqual(before);
      await prisma.project.update({ where: { id: projectId }, data: { currentVersionId: origin.id } });
      const afterPublish = await readState();
      await expect(request(action, current.id)).rejects.toMatchObject(conflict('VERSION_CHANGED'));
      expect(await readState()).toEqual(afterPublish);
    });

    it.each(['승인자 교체', '접근 철회', '현재 버전 변경', '승인 완료'] as const)(
      '프로젝트 잠금을 기다리는 동안 %s가 일어나면 잠근 뒤의 상태로 거절한다',
      async (change) => {
        const { result, stateBeforeRelease } = await whileProjectLocked(
          async () => request(action),
          async (tx) => {
            if (change === '승인자 교체')
              return tx.project.update({ where: { id: projectId }, data: { approverMemberId: clientMemberId } });
            if (change === '접근 철회')
              return tx.projectMember.update({ where: { id: approverMemberId }, data: { revokedAt: new Date() } });
            if (change === '현재 버전 변경')
              return tx.project.update({ where: { id: projectId }, data: { currentVersionId: origin.id } });
            await tx.approval.create({
              data: { versionId: current.id, approverId: approver.id, summary: { issues: [] } },
            });
            await tx.deliveryVersion.update({ where: { id: current.id }, data: { status: 'APPROVED' } });
            return tx.activityEvent.create({
              data: { projectId, actorId: approver.id, versionId: current.id, type: 'VERSION_APPROVED' },
            });
          },
        );
        const expected = {
          '승인자 교체': forbidden,
          '접근 철회': notFound,
          '현재 버전 변경': conflict('VERSION_CHANGED'),
          '승인 완료': conflict('VERSION_NOT_IN_REVIEW'),
        };
        expect(result).toMatchObject({ ok: false, error: expected[change] });
        expect(await readState()).toEqual(stateBeforeRelease);
      },
      15_000,
    );
  });

  it('seenAt이 DB의 지금 시각보다 2초 뒤이면 422이고 승인 줄·버전 상태·일지가 그대로다', async () => {
    const before = await readState();
    const [{ seenAt }] = await prisma.$queryRaw<{ seenAt: string }[]>`
      SELECT to_char((clock_timestamp() + interval '2 seconds') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "seenAt"
    `;

    await expect(service.approve(current.id, approver.id, seenAt)).rejects.toMatchObject({ status: 422 });

    expect(await readState()).toEqual(before);
  });

  it('seenAt이 요청 직전에 읽은 DB의 지금 시각이면 승인된다', async () => {
    const seenAt = await dbTime();
    const result = await service.approve(current.id, approver.id, seenAt);

    expect(result).toMatchObject({ id: current.id, status: 'APPROVED' });
    await expectApproval();
  });

  it('미래 seenAt은 버전·미해결·댓글 검사보다 먼저 422이고 아무것도 바뀌지 않는다', async () => {
    await createIssue();
    const before = await readState();
    for (const versionId of [current.id, origin.id]) {
      const result = await outcome(service.approve(versionId, approver.id, future));
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('미래 시각으로 승인됐어요');
      expect(result.error).toBeInstanceOf(UnprocessableEntityException);
      expect(result.error).toMatchObject({ status: 422 });
      expect(await readState()).toEqual(before);
    }
  });

  it.each(['OPEN', 'IN_PROGRESS', 'READY_FOR_REVIEW'] as const)(
    '범위 안의 끝나지 않은 쪽지 (%s)가 있으면 409 UNRESOLVED_ISSUES이고 아무것도 바뀌지 않는다',
    async (status) => {
      const issue = await createIssue({ status });
      const { serverTime, unresolved } = await service.check(current.id, approver.id);
      expect(unresolved).toEqual([checkIssue(issue)]);
      await comments.create(issue.id, developer.id, {
        versionId: current.id,
        requestId: randomUUID(),
        body: '새 댓글도 있어요',
      });
      const before = await readState();
      await expect(service.approve(current.id, approver.id, serverTime)).rejects.toMatchObject(
        conflict('UNRESOLVED_ISSUES'),
      );
      expect(await readState()).toEqual(before);
    },
  );

  it('지난 버전에서 시작한 끝나지 않은 쪽지도 승인을 막는다', async () => {
    const issue = await createIssue({ originVersionId: origin.id });
    const before = await readState();
    expect((await service.check(current.id, approver.id)).unresolved).toEqual([checkIssue(issue)]);
    await expect(service.approve(current.id, approver.id, past)).rejects.toMatchObject(conflict('UNRESOLVED_ISSUES'));
    expect(await readState()).toEqual(before);
  });

  it('숨긴 화면에서 시작한 끝나지 않은 쪽지도 승인 검토 목록에 있고 승인을 막는다', async () => {
    const { screen, versionScreen } = await attachScreen(origin.id);
    const issue = await createIssue({
      originVersionId: origin.id,
      originVersionScreenId: versionScreen.id,
      xRatio: 0.2,
      yRatio: 0.8,
    });
    await prisma.screen.update({ where: { id: screen.id }, data: { hiddenAt: new Date() } });
    const before = await readState();
    expect((await service.check(current.id, approver.id)).unresolved).toEqual([checkIssue(issue)]);
    await expect(service.approve(current.id, approver.id, past)).rejects.toMatchObject(conflict('UNRESOLVED_ISSUES'));
    expect(await readState()).toEqual(before);
  });

  it('범위 밖 쪽지만 남아 있으면 승인되고 승인 검토에 그 목록이 온다', async () => {
    const open = [];
    for (const status of ['OPEN', 'IN_PROGRESS', 'READY_FOR_REVIEW'] as const)
      open.push(await createIssue({ status, scope: 'OUT_OF_SCOPE' }));
    const verified = await createIssue({ status: 'VERIFIED', scope: 'OUT_OF_SCOPE' });
    const withdrawn = await createIssue({ status: 'WITHDRAWN', scope: 'OUT_OF_SCOPE' });
    const before = await readState();
    const check = await service.check(current.id, approver.id);
    expect(check).toEqual({
      serverTime: expect.any(String),
      unresolved: [],
      outOfScope: open.map(checkIssue),
      comments: [],
    });
    expect(await readState()).toEqual(before);
    await service.approve(current.id, approver.id, check.serverTime);
    await expectApproval([...open, verified, withdrawn].map(summaryIssue));
  });

  describe.each(['쪽지 없음', '확인 완료·철회만 있음'] as const)('%s', (scenario) => {
    it('쪽지가 없거나 확인 완료·철회된 쪽지만 있으면 승인되고 버전이 APPROVED가 된다', async () => {
      const completed = [];
      if (scenario !== '쪽지 없음') {
        completed.push(await createIssue({ status: 'VERIFIED' }));
        completed.push(await createIssue({ status: 'WITHDRAWN' }));
      }
      const check = await service.check(current.id, approver.id);
      expect(check.unresolved).toEqual([]);
      expect(check.outOfScope).toEqual([]);
      const beforeDetail = await versions.getDetail(current.id, approver.id);
      const detail = await service.approve(current.id, approver.id, check.serverTime);
      const approval = await expectApproval(completed.map(summaryIssue));
      expect(detail).toEqual({
        ...beforeDetail,
        status: 'APPROVED',
        approval: { approverName: approver.name, approvedAt: approval.approvedAt },
      });
    });
  });

  describe.each(['다른 사람', '승인자 자신'] as const)('%s 댓글', (author) => {
    it('seenAt 뒤에 다른 사람의 댓글이 있으면 409 NEW_COMMENTS이고 승인자 자신의 댓글만 있으면 승인된다', async () => {
      const issue = await createIssue({ status: 'VERIFIED' });
      const check = await service.check(current.id, approver.id);
      await comments.create(issue.id, author === '다른 사람' ? developer.id : approver.id, {
        versionId: current.id,
        requestId: randomUUID(),
        body: '승인 전 확인해 주세요',
      });
      const before = await readState();
      if (author === '다른 사람') {
        await expect(service.approve(current.id, approver.id, check.serverTime)).rejects.toMatchObject(
          conflict('NEW_COMMENTS'),
        );
        expect(await readState()).toEqual(before);
        return;
      }
      await service.approve(current.id, approver.id, check.serverTime);
      await expectApproval([summaryIssue(issue)]);
    });
  });

  it('승인 검토를 연 뒤 개발자가 쪽지 범위를 바꾸면 자동 댓글 때문에 승인이 409다', async () => {
    const issue = await createIssue();
    const check = await service.check(current.id, approver.id);
    await triage.update(issue.id, developer.id, { versionId: current.id, scope: 'OUT_OF_SCOPE' });
    const before = await readState();
    expect(before.comments).toEqual([
      expect.objectContaining({ requestId: null, body: '범위: 하자 수정 → 추가 요청' }),
    ]);
    await expect(service.approve(current.id, approver.id, check.serverTime)).rejects.toMatchObject(
      conflict('NEW_COMMENTS'),
    );
    expect(await readState()).toEqual(before);
    expect((await service.check(current.id, approver.id)).comments).toEqual([
      {
        id: before.comments[0].id,
        issueId: issue.id,
        issueNumber: issue.number,
        issueTitle: issue.title,
        authorName: developer.name,
        body: before.comments[0].body,
        createdAt: before.comments[0].createdAt,
      },
    ]);
  });

  it('승인 검토 뒤 마감일 자동 댓글도 새 댓글로 센다', async () => {
    const issue = await createIssue({ status: 'VERIFIED' });
    const check = await service.check(current.id, approver.id);
    await triage.update(issue.id, developer.id, { versionId: current.id, dueDate: '2026-12-01' });
    const before = await readState();
    expect(before.comments).toHaveLength(1);
    expect(before.comments[0].requestId).toBeNull();
    await expect(service.approve(current.id, approver.id, check.serverTime)).rejects.toMatchObject(
      conflict('NEW_COMMENTS'),
    );
    expect(await readState()).toEqual(before);
  });

  describe.each(['철회', '새 쪽지'] as const)('%s', (change) => {
    it('승인 검토를 연 뒤 다른 사람이 쪽지를 철회하거나 새 쪽지를 쓰면 승인이 409다', async () => {
      const issue = await createIssue({ scope: 'OUT_OF_SCOPE' });
      const check = await service.check(current.id, approver.id);
      if (change === '철회')
        await resolution.withdraw(issue.id, client.id, { versionId: current.id, reason: '필요 없어졌어요' });
      if (change === '새 쪽지')
        await issues.create(projectId, client.id, {
          versionId: current.id,
          requestId: randomUUID(),
          title: '새 요청',
          body: '확인해 주세요',
        });
      const before = await readState();
      await expect(service.approve(current.id, approver.id, check.serverTime)).rejects.toMatchObject(
        conflict(change === '철회' ? 'NEW_COMMENTS' : 'UNRESOLVED_ISSUES'),
      );
      expect(await readState()).toEqual(before);
    });
  });

  it('범위 밖 쪽지의 재요청 사유 댓글도 새 댓글로 센다', async () => {
    const issue = await createIssue({ status: 'READY_FOR_REVIEW', scope: 'OUT_OF_SCOPE' });
    const attempt = await prisma.resolutionAttempt.create({
      data: { issueId: issue.id, versionId: current.id, summary: '고쳤어요', submittedById: developer.id },
    });
    const check = await service.check(current.id, approver.id);
    await resolution.reopen(issue.id, client.id, {
      versionId: current.id,
      attemptId: attempt.id,
      reason: '다시 확인해 주세요',
    });
    const before = await readState();
    await expect(service.approve(current.id, approver.id, check.serverTime)).rejects.toMatchObject(
      conflict('NEW_COMMENTS'),
    );
    expect(await readState()).toEqual(before);
  });

  it.each([
    ['같은 마이크로초', '2026-01-01T00:00:00.123456Z', true],
    ['1마이크로초 앞', '2026-01-01T00:00:00.123455Z', false],
  ] as const)('seenAt이 댓글과 %s이면 마이크로초를 잃지 않고 비교한다', async (_label, seenAt, succeeds) => {
    const issue = await createIssue({ status: 'VERIFIED' });
    const comment = await prisma.comment.create({
      data: { issueId: issue.id, versionId: current.id, authorId: developer.id, body: '마이크로초 경계' },
    });
    await prisma.$executeRaw`UPDATE comments SET created_at = '2026-01-01T00:00:00.123456Z'::timestamptz WHERE id = ${comment.id}::uuid`;
    const before = await readState();
    if (!succeeds) {
      await expect(service.approve(current.id, approver.id, seenAt)).rejects.toMatchObject(conflict('NEW_COMMENTS'));
      expect(await readState()).toEqual(before);
      return;
    }
    await service.approve(current.id, approver.id, seenAt);
    await expectApproval([summaryIssue(issue)]);
  });

  it('새 댓글 검사는 지난 버전의 댓글도 포함하고 다른 프로젝트의 댓글과 미해결 쪽지는 세지 않는다', async () => {
    const local = await createIssue({ status: 'VERIFIED', originVersionId: origin.id });
    const other = await createOtherProject();
    const foreign = await createIssue({ projectId: other.project.id, originVersionId: other.version.id });
    const check = await service.check(current.id, approver.id);
    await prisma.comment.create({
      data: { issueId: foreign.id, versionId: other.version.id, authorId: developer.id, body: '남의 프로젝트 댓글' },
    });
    const oldVersionComment = await prisma.comment.create({
      data: { issueId: local.id, versionId: origin.id, authorId: developer.id, body: '지난 버전의 새 댓글' },
    });
    const before = await readState();
    await expect(service.approve(current.id, approver.id, check.serverTime)).rejects.toMatchObject(
      conflict('NEW_COMMENTS'),
    );
    expect(await readState()).toEqual(before);
    // 지난 버전 댓글만 이미 읽은 시각으로 옮긴다. 남의 프로젝트 미해결·새 댓글은 그대로 남긴다.
    await prisma.$executeRaw`UPDATE comments SET created_at = ${past}::timestamptz WHERE id = ${oldVersionComment.id}::uuid`;
    await service.approve(current.id, approver.id, check.serverTime);
    await expectApproval([summaryIssue(local)]);
    expect(await prisma.issue.findUniqueOrThrow({ where: { id: foreign.id } })).toEqual(foreign);
  });

  it('승인 검토는 이 프로젝트의 쪽지와 이번 버전의 댓글만 오래된 순으로 준다', async () => {
    const second = await createIssue({
      number: 2,
      status: 'IN_PROGRESS',
      originVersionId: origin.id,
      title: '지난 차수 쪽지',
    });
    const first = await createIssue({ number: 1, title: '이번 차수 쪽지' });
    const fourth = await createIssue({ number: 4, scope: 'OUT_OF_SCOPE' });
    const third = await createIssue({ number: 3, status: 'READY_FOR_REVIEW', scope: 'OUT_OF_SCOPE' });
    for (const scope of ['IN_SCOPE', 'OUT_OF_SCOPE'] as const) {
      await createIssue({ status: 'VERIFIED', scope });
      await createIssue({ status: 'WITHDRAWN', scope });
    }
    const other = await createOtherProject();
    const foreign = await createIssue({ projectId: other.project.id, originVersionId: other.version.id });
    await prisma.comment.create({
      data: { issueId: foreign.id, versionId: other.version.id, authorId: developer.id, body: '남의 댓글' },
    });
    await prisma.comment.create({
      data: { issueId: second.id, versionId: origin.id, authorId: developer.id, body: '지난 댓글' },
    });
    const recent = await prisma.comment.create({
      data: {
        issueId: first.id,
        versionId: current.id,
        authorId: approver.id,
        requestId: randomUUID(),
        body: '최근 댓글',
        createdAt: new Date('2026-01-02T00:00:00Z'),
      },
    });
    const older = await prisma.comment.create({
      data: {
        issueId: second.id,
        versionId: current.id,
        authorId: developer.id,
        body: '자동 댓글',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    });
    const before = await readState();
    const timeBefore = await dbTime();
    const check = await service.check(current.id, approver.id);
    const timeAfter = await dbTime();
    expect(check.serverTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    expect(check.serverTime >= timeBefore).toBe(true);
    expect(check.serverTime <= timeAfter).toBe(true);
    expect(check).toEqual({
      serverTime: check.serverTime,
      unresolved: [first, second].map(checkIssue),
      outOfScope: [third, fourth].map(checkIssue),
      comments: [
        {
          id: older.id,
          issueId: second.id,
          issueNumber: second.number,
          issueTitle: second.title,
          authorName: developer.name,
          body: older.body,
          createdAt: older.createdAt,
        },
        {
          id: recent.id,
          issueId: first.id,
          issueNumber: first.number,
          issueTitle: first.title,
          authorName: approver.name,
          body: recent.body,
          createdAt: recent.createdAt,
        },
      ],
    });
    expect(await readState()).toEqual(before);
  });

  it('대문자 버전 id의 승인 검토는 같은 목록이고 받은 serverTime 그대로 승인할 수 있다', async () => {
    const issue = await createIssue({ status: 'VERIFIED' });
    await comments.create(issue.id, developer.id, {
      versionId: current.id,
      requestId: randomUUID(),
      body: '이미 읽은 댓글',
    });
    const lower = await service.check(current.id, approver.id);
    const upper = await service.check(current.id.toUpperCase(), approver.id);
    expect({ ...upper, serverTime: lower.serverTime }).toEqual(lower);
    const result = await service.approve(current.id.toUpperCase(), approver.id, upper.serverTime);
    expect(result.id).toBe(current.id);
    await expectApproval([summaryIssue(issue)]);
  });

  it('승인하면 그 시점의 쪽지 목록이 summary에 번호 순으로 저장된다', async () => {
    const { screen, versionScreen } = await attachScreen(origin.id);
    await prisma.screen.update({ where: { id: screen.id }, data: { hiddenAt: new Date() } });
    const fourth = await createIssue({
      number: 4,
      title: '추가 기능',
      category: 'OTHER',
      scope: 'OUT_OF_SCOPE',
      status: 'READY_FOR_REVIEW',
    });
    const second = await createIssue({ number: 2, title: '철회한 문구', category: 'COPY', status: 'WITHDRAWN' });
    const first = await createIssue({
      number: 1,
      title: '지난 화면 디자인',
      category: 'DESIGN',
      status: 'VERIFIED',
      originVersionId: origin.id,
      originVersionScreenId: versionScreen.id,
      xRatio: 0,
      yRatio: 1,
    });
    const third = await createIssue({ number: 3, title: '추가 오류', scope: 'OUT_OF_SCOPE' });
    const other = await createOtherProject();
    await createIssue({ projectId: other.project.id, originVersionId: other.version.id });
    const expected = [first, second, third, fourth].map(summaryIssue);
    await service.approve(current.id, approver.id, past);
    const approval = await expectApproval(expected);
    // 다음 버전에서 실제 서비스로 다시 열어도 승인 당시 목록은 바뀌지 않는다.
    const draft = await versions.createDraft(projectId, developer.id);
    await attachScreen(draft.id);
    await versions.publish(draft.id, developer.id);
    await resolution.reopen(first.id, client.id, { versionId: draft.id, reason: '다음 차수에서 다시 확인' });
    expect(await prisma.approval.findUniqueOrThrow({ where: { id: approval.id } })).toEqual(approval);
  });

  it('일지 저장이 실패하면 버전은 검수 중 그대로이고 승인 줄도 없다', async () => {
    const before = await readState();
    try {
      await prisma.$executeRaw`
        CREATE FUNCTION approval_service_fail_insert() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'approval service activity failure';
        END;
        $$
      `;
      await prisma.$executeRaw`
        CREATE TRIGGER approval_service_fail_insert BEFORE INSERT ON activity_events
        FOR EACH ROW EXECUTE FUNCTION approval_service_fail_insert()
      `;
      await expect(service.approve(current.id, approver.id, past)).rejects.toThrow('approval service activity failure');
      expect(await readState()).toEqual(before);
    } finally {
      try {
        await prisma.$executeRaw`DROP TRIGGER IF EXISTS approval_service_fail_insert ON activity_events`;
      } finally {
        await prisma.$executeRaw`DROP FUNCTION IF EXISTS approval_service_fail_insert()`;
      }
    }
    await service.approve(current.id, approver.id, past);
    await expectApproval();
  });

  it('승인을 동시에 두 번 보내거나 다시 보내면 하나만 성공하고 승인 줄과 일지가 하나씩만 남는다', async () => {
    const results = await Promise.all([
      outcome(service.approve(current.id, approver.id, past)),
      outcome(service.approve(current.id, approver.id, past)),
    ]);
    expect(results.filter(({ ok }) => ok)).toHaveLength(1);
    expect(results.filter(({ ok }) => !ok)).toMatchObject([{ ok: false, error: conflict('VERSION_NOT_IN_REVIEW') }]);
    await expectApproval();
    const before = await readState();
    await expect(service.approve(current.id, approver.id, past)).rejects.toMatchObject(
      conflict('VERSION_NOT_IN_REVIEW'),
    );
    expect(await readState()).toEqual(before);
  });

  it('승인과 새 버전 게시를 동시에 보내면 승인되거나 409 VERSION_CHANGED다', async () => {
    const draft = await versions.createDraft(projectId, developer.id);
    await attachScreen(draft.id);
    const [approval, published] = await Promise.all([
      outcome(service.approve(current.id, approver.id, past)),
      versions.publish(draft.id, developer.id),
    ]);
    expect(published.status).toBe('IN_REVIEW');
    expect(published.approval).toBeNull();
    expect((await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).currentVersionId).toBe(draft.id);
    expect(await prisma.activityEvent.count({ where: { type: 'VERSION_PUBLISHED' } })).toBe(1);
    if (approval.ok) {
      await expectApproval();
      return;
    }
    expect(approval.error).toMatchObject(conflict('VERSION_CHANGED'));
    expect(await prisma.approval.count()).toBe(0);
    expect(await prisma.activityEvent.count({ where: { type: 'VERSION_APPROVED' } })).toBe(0);
    expect(await prisma.deliveryVersion.findUniqueOrThrow({ where: { id: current.id } })).toEqual(current);
  });

  it('승인과 댓글 저장을 동시에 보내면 하나만 성공하고 저장된 댓글을 놓친 승인은 없다', async () => {
    const issue = await createIssue({ status: 'VERIFIED' });
    const { serverTime } = await service.check(current.id, approver.id);
    const [approval, comment] = await Promise.all([
      outcome(service.approve(current.id, approver.id, serverTime)),
      outcome(
        comments.create(issue.id, developer.id, { versionId: current.id, requestId: randomUUID(), body: '동시 댓글' }),
      ),
    ]);
    expect(Number(approval.ok) + Number(comment.ok)).toBe(1);
    if (approval.ok) {
      expect(comment).toMatchObject({ ok: false, error: conflict('VERSION_NOT_IN_REVIEW') });
      expect(await prisma.comment.count()).toBe(0);
      await expectApproval([summaryIssue(issue)]);
      return;
    }
    expect(approval.error).toMatchObject(conflict('NEW_COMMENTS'));
    expect(await prisma.comment.count()).toBe(1);
    expect(await prisma.approval.count()).toBe(0);
    expect(await prisma.activityEvent.count()).toBe(0);
    expect(await prisma.deliveryVersion.findUniqueOrThrow({ where: { id: current.id } })).toEqual(current);
  });

  it('댓글 저장과 승인 검토 조회를 동시에 보내면 그 댓글은 목록에 들어가거나 승인이 409로 막힌다', async () => {
    const issue = await createIssue({ status: 'VERIFIED' });
    const [check, comment] = await Promise.all([
      service.check(current.id, approver.id),
      comments.create(issue.id, developer.id, {
        versionId: current.id,
        requestId: randomUUID(),
        body: '조회와 동시 댓글',
      }),
    ]);
    if (check.comments.some(({ id }) => id === comment.id)) {
      await service.approve(current.id, approver.id, check.serverTime);
      await expectApproval([summaryIssue(issue)]);
      return;
    }
    const before = await readState();
    await expect(service.approve(current.id, approver.id, check.serverTime)).rejects.toMatchObject(
      conflict('NEW_COMMENTS'),
    );
    expect(await readState()).toEqual(before);
  });

  it('저장 중인 댓글의 프로젝트 잠금을 기다린 승인 검토는 그 댓글과 잠금 뒤의 serverTime을 준다', async () => {
    const issue = await createIssue({ status: 'VERIFIED' });
    const { result, stateBeforeRelease, timeBeforeRelease } = await whileProjectLocked(
      async () => service.check(current.id, approver.id),
      async (tx) =>
        tx.comment.create({
          data: { issueId: issue.id, versionId: current.id, authorId: developer.id, body: '저장 중인 댓글' },
        }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.value.serverTime >= timeBeforeRelease).toBe(true);
    expect(result.value.comments).toEqual([
      {
        id: stateBeforeRelease!.comments[0].id,
        issueId: issue.id,
        issueNumber: issue.number,
        issueTitle: issue.title,
        authorName: developer.name,
        body: '저장 중인 댓글',
        createdAt: stateBeforeRelease!.comments[0].createdAt,
      },
    ]);
    expect(await readState()).toEqual(stateBeforeRelease);
    await service.approve(current.id, approver.id, result.value.serverTime);
    await expectApproval([summaryIssue(issue)]);
  }, 15_000);

  it('승인 시각은 트랜잭션을 시작한 때가 아니라 프로젝트 잠금을 얻은 뒤 DB가 적은 시각이다', async () => {
    const { result, timeBeforeRelease } = await whileProjectLocked(
      async () => service.approve(current.id, approver.id, past),
      async () => undefined,
    );
    expect(result.ok).toBe(true);
    await expectApproval();
    const [{ afterLock, beforeNow }] = await prisma.$queryRaw<{ afterLock: boolean; beforeNow: boolean }[]>`
      SELECT approved_at >= ${timeBeforeRelease}::timestamptz AS "afterLock",
             approved_at <= clock_timestamp() AS "beforeNow"
      FROM approvals WHERE version_id = ${current.id}::uuid
    `;
    expect({ afterLock, beforeNow }).toEqual({ afterLock: true, beforeNow: true });
  }, 15_000);

  it.each(['새 범위 안 쪽지', '새 댓글'] as const)(
    '승인 잠금을 기다리는 동안 생긴 %s도 잠근 뒤에 검사한다',
    async (change) => {
      const issue = await createIssue({ status: 'VERIFIED' });
      const { serverTime } = await service.check(current.id, approver.id);
      const { result, stateBeforeRelease } = await whileProjectLocked(
        async () => service.approve(current.id, approver.id, serverTime),
        async (tx) => {
          if (change === '새 댓글') {
            return tx.comment.create({
              data: {
                issueId: issue.id,
                versionId: current.id,
                authorId: developer.id,
                body: '잠금을 기다리는 동안 쓴 댓글',
              },
            });
          }
          return tx.issue.create({
            data: {
              projectId,
              originVersionId: current.id,
              authorId: client.id,
              requestId: randomUUID(),
              number: 2,
              title: '새 범위 안 쪽지',
              body: '승인 전에 확인해 주세요',
            },
          });
        },
      );
      expect(result).toMatchObject({
        ok: false,
        error: conflict(change === '새 댓글' ? 'NEW_COMMENTS' : 'UNRESOLVED_ISSUES'),
      });
      expect(await readState()).toEqual(stateBeforeRelease);
    },
    15_000,
  );

  it('승인과 새 쪽지를 동시에 보내면 하나만 성공하고 승인된 버전에 범위 안 미해결 쪽지가 남지 않는다', async () => {
    const [approval, issue] = await Promise.all([
      outcome(service.approve(current.id, approver.id, past)),
      outcome(
        issues.create(projectId, client.id, {
          versionId: current.id,
          requestId: randomUUID(),
          title: '동시 요청',
          body: '새 쪽지',
        }),
      ),
    ]);
    expect(Number(approval.ok) + Number(issue.ok)).toBe(1);
    if (approval.ok) {
      expect(issue).toMatchObject({ ok: false, error: conflict('VERSION_NOT_IN_REVIEW') });
      expect(await prisma.issue.count()).toBe(0);
      expect(await prisma.activityEvent.count({ where: { type: 'ISSUE_CREATED' } })).toBe(0);
      await expectApproval();
      return;
    }
    expect(approval.error).toMatchObject(conflict('UNRESOLVED_ISSUES'));
    expect(await prisma.issue.count({ where: { scope: 'IN_SCOPE', status: 'OPEN' } })).toBe(1);
    expect(await prisma.activityEvent.count({ where: { type: 'ISSUE_CREATED' } })).toBe(1);
    expect(await prisma.approval.count()).toBe(0);
    expect(await prisma.activityEvent.count({ where: { type: 'VERSION_APPROVED' } })).toBe(0);
    expect(await prisma.deliveryVersion.findUniqueOrThrow({ where: { id: current.id } })).toEqual(current);
  });

  describe.each(['IN_SCOPE', 'OUT_OF_SCOPE'] as const)('범위를 %s에서 변경', (scope) => {
    it('승인과 범위 바꾸기를 동시에 보내면 둘 중 하나만 반영된 상태로 끝난다', async () => {
      const issue = await createIssue({ scope });
      const { serverTime } = await service.check(current.id, approver.id);
      const target = scope === 'IN_SCOPE' ? 'OUT_OF_SCOPE' : 'IN_SCOPE';
      const [approval, changed] = await Promise.all([
        outcome(service.approve(current.id, approver.id, serverTime)),
        outcome(triage.update(issue.id, developer.id, { versionId: current.id, scope: target })),
      ]);
      expect(Number(approval.ok) + Number(changed.ok)).toBe(1);
      if (approval.ok) {
        expect(changed).toMatchObject({ ok: false, error: conflict('VERSION_NOT_IN_REVIEW') });
        expect(await prisma.issue.findUniqueOrThrow({ where: { id: issue.id } })).toEqual(issue);
        expect(await prisma.comment.count()).toBe(0);
        await expectApproval([summaryIssue(issue)]);
        return;
      }
      const code = (approval.error as { response: { code: string } }).response.code;
      expect(scope === 'IN_SCOPE' ? ['UNRESOLVED_ISSUES', 'NEW_COMMENTS'] : ['UNRESOLVED_ISSUES']).toContain(code);
      expect(approval.error).toMatchObject(conflict(code));
      expect((await prisma.issue.findUniqueOrThrow({ where: { id: issue.id } })).scope).toBe(target);
      expect(await prisma.comment.count()).toBe(1);
      expect(await prisma.approval.count()).toBe(0);
      expect(await prisma.activityEvent.count()).toBe(0);
      expect(await prisma.deliveryVersion.findUniqueOrThrow({ where: { id: current.id } })).toEqual(current);
    });
  });

  it('승인 뒤에도 다음 버전을 게시할 수 있고 새 버전에서 쪽지를 쓸 수 있다', async () => {
    await service.approve(current.id, approver.id, past);
    const approval = await expectApproval();
    const draft = await versions.createDraft(projectId, developer.id);
    await attachScreen(draft.id);
    const published = await versions.publish(draft.id, developer.id);
    expect(published).toMatchObject({ id: draft.id, status: 'IN_REVIEW', number: 2, approval: null });
    const issue = await issues.create(projectId, client.id, {
      versionId: draft.id,
      requestId: randomUUID(),
      title: '다음 차수 요청',
      body: '새 요청이에요',
    });
    expect(issue).toMatchObject({ status: 'OPEN', originVersion: { id: draft.id } });
    expect(await prisma.approval.findUniqueOrThrow({ where: { id: approval.id } })).toEqual(approval);
  });

  it('저장된 댓글과 쪽지를 승인 뒤에 같은 requestId로 다시 보내면 처음 결과를 돌려주고 새 요청은 409다', async () => {
    const input = { versionId: current.id, requestId: randomUUID(), title: '처음 요청', body: '확인해 주세요' };
    const issue = await issues.create(projectId, client.id, input);
    await triage.update(issue.id, developer.id, { versionId: current.id, scope: 'OUT_OF_SCOPE' });
    const commentInput = { versionId: current.id, requestId: randomUUID(), body: '처음 댓글' };
    const comment = await comments.create(issue.id, client.id, commentInput);
    const check = await service.check(current.id, approver.id);
    await service.approve(current.id, approver.id, check.serverTime);
    const before = await readState();
    expect((await issues.create(projectId, client.id, input)).id).toBe(issue.id);
    expect(await comments.create(issue.id, client.id, commentInput)).toEqual(comment);
    await expect(issues.create(projectId, client.id, { ...input, requestId: randomUUID() })).rejects.toMatchObject(
      conflict('VERSION_NOT_IN_REVIEW'),
    );
    await expect(
      comments.create(issue.id, client.id, { ...commentInput, requestId: randomUUID() }),
    ).rejects.toMatchObject(conflict('VERSION_NOT_IN_REVIEW'));
    expect(await readState()).toEqual(before);
  });
});
