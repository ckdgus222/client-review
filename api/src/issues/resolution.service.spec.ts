import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { resetDatabase } from '../../test/reset-database.js';
import { ActivityService } from '../activity/activity.service.js';
import type { ActivityType, DeliveryVersion, IssueStatus, Prisma, User } from '../generated/prisma/client.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { IssuesService, type IssueDetail } from './issues.service.js';
import { ResolutionService } from './resolution.service.js';

const missingId = '00000000-0000-4000-8000-000000000001';
const notFound = { status: 404, response: { statusCode: 404, message: '없는 쪽지예요', error: 'Not Found' } };
const forbidden = { status: 403, response: { statusCode: 403, error: 'Forbidden' } };
const conflict = (code: string) => ({ status: 409, response: { statusCode: 409, code } });
const actions = ['submit', 'verify', 'reopen', 'reopenWithoutAttempt', 'withdraw'] as const;
type Action = (typeof actions)[number];
const allowedStatus: Record<Action, IssueStatus> = {
  submit: 'OPEN',
  verify: 'READY_FOR_REVIEW',
  reopen: 'READY_FOR_REVIEW',
  reopenWithoutAttempt: 'VERIFIED',
  withdraw: 'OPEN',
};
const nextStatus: Record<Action, IssueStatus> = {
  submit: 'READY_FOR_REVIEW',
  verify: 'VERIFIED',
  reopen: 'OPEN',
  reopenWithoutAttempt: 'OPEN',
  withdraw: 'WITHDRAWN',
};
const eventType: Record<Action, ActivityType> = {
  submit: 'RESOLUTION_SUBMITTED',
  verify: 'ISSUE_VERIFIED',
  reopen: 'ISSUE_REOPENED',
  reopenWithoutAttempt: 'ISSUE_REOPENED',
  withdraw: 'ISSUE_WITHDRAWN',
};

describe('ResolutionService', () => {
  let module: TestingModule | undefined;
  let prisma: PrismaService;
  let service: ResolutionService;
  let issues: IssuesService;
  let developer: User;
  let client: User;
  let approver: User;
  let outsider: User;
  let projectId: string;
  let issueId: string;
  let origin: DeliveryVersion;
  let current: DeliveryVersion;

  const readState = async (db: Prisma.TransactionClient = prisma) => ({
    issues: await db.issue.findMany({ orderBy: { id: 'asc' } }),
    attempts: await db.resolutionAttempt.findMany({ orderBy: { id: 'asc' } }),
    comments: await db.comment.findMany({ orderBy: { id: 'asc' } }),
    events: await db.activityEvent.findMany({ orderBy: { id: 'asc' } }),
  });
  const readEvents = async () => prisma.activityEvent.findMany({ orderBy: { createdAt: 'asc' } });
  const createIssue = async (authorId = client.id) =>
    prisma.issue.create({
      data: {
        projectId,
        originVersionId: origin.id,
        authorId,
        requestId: randomUUID(),
        number: (await prisma.issue.count({ where: { projectId } })) + 1,
        title: '버튼 수정',
        body: '버튼 글자를 확인해 주세요',
      },
    });
  const attachScreen = async (versionId: string, targetProjectId = projectId) => {
    const screen = await prisma.screen.create({
      data: { projectId: targetProjectId, name: `상품 상세 ${randomUUID()}`, viewport: 'PC' },
    });
    const asset = await prisma.asset.create({
      data: {
        projectId: targetProjectId,
        storageKey: `${targetProjectId}/${randomUUID()}.png`,
        mime: 'image/png',
        bytes: 100,
        width: 1200,
        height: 800,
      },
    });
    const versionScreen = await prisma.versionScreen.create({
      data: { versionId, screenId: screen.id, assetId: asset.id },
    });
    return { screen, asset, versionScreen };
  };
  const seedAttempt = async (status: IssueStatus = 'READY_FOR_REVIEW', targetIssueId = issueId) => {
    await prisma.issue.update({ where: { id: targetIssueId }, data: { status } });
    return prisma.resolutionAttempt.create({
      data: {
        issueId: targetIssueId,
        versionId: current.id,
        summary: '첫 번째 수정',
        submittedById: developer.id,
        ...(status === 'VERIFIED' ? { result: 'VERIFIED', reviewedById: client.id, reviewedAt: new Date() } : {}),
      },
    });
  };
  // 여러 요청에 같은 권한·순서 검사를 적용한다. HTTP와 DTO 검사는 조각 4에서 쓴다.
  const request = async (
    action: Action,
    options: {
      targetIssueId?: string;
      userId?: string;
      versionId?: string;
      attemptId?: string;
    } = {},
  ) => {
    const id = options.targetIssueId ?? issueId;
    const userId = options.userId ?? (action === 'submit' ? developer.id : client.id);
    const versionId = options.versionId ?? current.id;
    const attemptId = options.attemptId ?? missingId;
    switch (action) {
      case 'submit':
        return service.submit(id, userId, { versionId, summary: '버튼을 고쳤어요' });
      case 'verify':
        return service.verify(id, userId, { versionId, attemptId });
      case 'reopen':
        return service.reopen(id, userId, { versionId, attemptId, reason: '다시 확인해 주세요' });
      case 'reopenWithoutAttempt':
        return service.reopen(id, userId, { versionId, reason: '다시 확인해 주세요' });
      case 'withdraw':
        return service.withdraw(id, userId, { versionId, reason: '요청을 취소해요' });
    }
  };
  const expectEvent = async (type: ActivityType, actorId: string) => {
    expect(await prisma.activityEvent.findMany({ where: { type } })).toEqual([
      {
        id: expect.any(String),
        projectId,
        actorId,
        type,
        issueId,
        versionId: null,
        memberId: null,
        createdAt: expect.any(Date),
      },
    ]);
  };

  // 실제로 잠금을 기다리는 것을 본 뒤 다른 연결에서 변경한다. 실행 순서를 시간 추측으로 정하지 않는다.
  const requestWhileLocked = async (
    action: Action,
    attemptId: string,
    change: (tx: Prisma.TransactionClient) => Promise<unknown>,
  ) => {
    let pending: Promise<{ detail: IssueDetail } | { error: unknown }> | undefined;
    let settled = false;
    let stateBeforeRelease: Awaited<ReturnType<typeof readState>> | undefined;
    let beforeRelease: Date | undefined;
    const runRequest = async () => {
      try {
        return { detail: await request(action, { attemptId }) };
      } catch (error) {
        return { error };
      } finally {
        settled = true;
      }
    };
    try {
      await prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM projects WHERE id = ${projectId}::uuid FOR UPDATE`;
          const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          pending = runRequest();
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
          await change(tx);
          stateBeforeRelease = await readState(tx);
          [{ time: beforeRelease }] = await tx.$queryRaw<{ time: Date }[]>`SELECT clock_timestamp() AS time`;
        },
        { maxWait: 5_000, timeout: 10_000 },
      );
    } finally {
      await pending;
    }
    return { outcome: await pending, stateBeforeRelease, beforeRelease: beforeRelease! };
  };

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [ResolutionService, IssuesService, ProjectsService, ActivityService],
    }).compile();
    prisma = module.get(PrismaService);
    service = module.get(ResolutionService);
    issues = module.get(IssuesService);
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    developer = await prisma.user.create({ data: { email: 'developer@example.com', name: '개발자' } });
    client = await prisma.user.create({ data: { email: 'client@example.com', name: '클라이언트' } });
    approver = await prisma.user.create({ data: { email: 'approver@example.com', name: '승인자' } });
    outsider = await prisma.user.create({ data: { email: 'outsider@example.com', name: '외부인' } });
    const project = await prisma.project.create({
      data: {
        name: '고쳤어요 검수',
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
    origin = await prisma.deliveryVersion.create({
      data: { projectId, number: 1, status: 'IN_REVIEW', publishedAt: new Date() },
    });
    current = await prisma.deliveryVersion.create({
      data: { projectId, number: 2, status: 'IN_REVIEW', publishedAt: new Date() },
    });
    await prisma.project.update({
      where: { id: projectId },
      data: {
        approverMemberId: project.members.find(({ userId }) => userId === approver.id)!.id,
        currentVersionId: current.id,
      },
    });
    issueId = (await createIssue()).id;
  });

  afterAll(async () => {
    await module?.close();
  });

  describe.each(actions)('%s 검사 순서', (action) => {
    it.each(['없는 쪽지', '멤버 아님', '철회된 멤버', '철회된 승인자'] as const)(
      '멤버가 아니거나 접근이 철회된 사람과 없는 쪽지는 네 요청 모두 404다 (%s)',
      async (scenario) => {
        const actor = scenario === '멤버 아님' ? outsider : scenario === '철회된 승인자' ? approver : developer;
        if (scenario.startsWith('철회된')) {
          await prisma.projectMember.update({
            where: { projectId_userId: { projectId, userId: actor.id } },
            data: { revokedAt: new Date() },
          });
        }
        const before = await readState();
        await expect(
          request(action, {
            targetIssueId: scenario === '없는 쪽지' ? missingId : issueId,
            userId: actor.id,
            versionId: missingId,
          }),
        ).rejects.toMatchObject(notFound);
        expect(await readState()).toEqual(before);
      },
    );

    it('권한이 없으면 틀린 버전·쪽지 상태·고쳤어요 줄보다 먼저 403이다', async () => {
      await prisma.issue.update({ where: { id: issueId }, data: { status: 'WITHDRAWN' } });
      const before = await readState();
      await expect(
        request(action, {
          userId: action === 'submit' ? client.id : developer.id,
          versionId: missingId,
        }),
      ).rejects.toMatchObject(forbidden);
      expect(await readState()).toEqual(before);
    });

    it.each(['지난 버전', '승인된 현재 버전', '지난 버전과 승인된 현재 버전'] as const)(
      '보고 있던 버전이 현재 버전이 아니거나 승인됐으면 네 요청 모두 409이고 아무것도 바뀌지 않는다 (%s)',
      async (scenario) => {
        // 상태와 attemptId도 틀리게 해서 버전 검사가 먼저인지 본다.
        const status = action === 'reopenWithoutAttempt' ? 'OPEN' : 'WITHDRAWN';
        await prisma.issue.update({ where: { id: issueId }, data: { status } });
        if (scenario !== '지난 버전') {
          await prisma.deliveryVersion.update({ where: { id: current.id }, data: { status: 'APPROVED' } });
        }
        const before = await readState();
        await expect(
          request(action, {
            versionId: scenario === '승인된 현재 버전' ? current.id : origin.id,
          }),
        ).rejects.toMatchObject(
          conflict(scenario === '승인된 현재 버전' ? 'VERSION_NOT_IN_REVIEW' : 'VERSION_CHANGED'),
        );
        expect(await readState()).toEqual(before);
      },
    );
  });

  it('클라이언트와 승인자가 고쳤어요를 보내면 403이고 아무것도 바뀌지 않는다', async () => {
    const before = await readState();
    for (const actor of [client, approver]) {
      await expect(request('submit', { userId: actor.id })).rejects.toMatchObject(forbidden);
      expect(await readState()).toEqual(before);
    }
  });

  describe.each(['verify', 'reopen', 'reopenWithoutAttempt', 'withdraw'] as const)('%s 권한', (action) => {
    it.each(['클라이언트', '개발자'] as const)(
      '개발자가 확인 완료·재요청·철회를 하면 403이고 아무것도 바뀌지 않는다 (%s가 쓴 쪽지)',
      async (author) => {
        await prisma.issue.update({
          where: { id: issueId },
          data: { authorId: author === '개발자' ? developer.id : client.id },
        });
        const attempt = await seedAttempt(allowedStatus[action]);
        const before = await readState();
        await expect(request(action, { userId: developer.id, attemptId: attempt.id })).rejects.toMatchObject(forbidden);
        expect(await readState()).toEqual(before);
      },
    );

    it('클라이언트가 남이 쓴 쪽지를 확인 완료·재요청·철회하면 403이고 아무것도 바뀌지 않는다', async () => {
      await prisma.issue.update({ where: { id: issueId }, data: { authorId: approver.id } });
      const attempt = await seedAttempt(allowedStatus[action]);
      const before = await readState();
      await expect(request(action, { attemptId: attempt.id })).rejects.toMatchObject(forbidden);
      expect(await readState()).toEqual(before);
    });

    it.each(['클라이언트', '개발자'] as const)(
      '승인자는 남이 쓴 쪽지와 개발자가 쓴 쪽지도 확인 완료·재요청·철회한다 (%s가 쓴 쪽지)',
      async (author) => {
        await prisma.issue.update({
          where: { id: issueId },
          data: { authorId: author === '개발자' ? developer.id : client.id },
        });
        const attempt = await seedAttempt(allowedStatus[action]);
        const result = await request(action, { userId: approver.id, attemptId: attempt.id });
        expect(result).toMatchObject({ status: nextStatus[action], canReview: true, isMine: false });
        expect(result).toEqual(await issues.getDetail(issueId, approver.id));
        await expectEvent(eventType[action], approver.id);
      },
    );

    it('개발자가 쓴 쪽지는 승인자만 확인하고 승인자가 없으면 누구도 확인할 수 없다', async () => {
      await prisma.issue.update({ where: { id: issueId }, data: { authorId: developer.id } });
      await prisma.project.update({ where: { id: projectId }, data: { approverMemberId: null } });
      const attempt = await seedAttempt(allowedStatus[action]);
      const before = await readState();
      for (const actor of [developer, client, approver]) {
        expect((await issues.getDetail(issueId, actor.id)).canReview).toBe(false);
        await expect(request(action, { userId: actor.id, attemptId: attempt.id })).rejects.toMatchObject(forbidden);
        expect(await readState()).toEqual(before);
      }
    });
  });

  it.each([
    ['submit', 'READY_FOR_REVIEW'],
    ['submit', 'VERIFIED'],
    ['submit', 'WITHDRAWN'],
    ['verify', 'OPEN'],
    ['verify', 'IN_PROGRESS'],
    ['verify', 'VERIFIED'],
    ['verify', 'WITHDRAWN'],
    ['reopen', 'OPEN'],
    ['reopen', 'IN_PROGRESS'],
    ['reopen', 'VERIFIED'],
    ['reopen', 'WITHDRAWN'],
    ['reopenWithoutAttempt', 'OPEN'],
    ['reopenWithoutAttempt', 'IN_PROGRESS'],
    ['reopenWithoutAttempt', 'READY_FOR_REVIEW'],
    ['withdraw', 'VERIFIED'],
    ['withdraw', 'WITHDRAWN'],
  ] as const)(
    '상태가 맞지 않는 요청 (%s, %s)는 409 ISSUE_STATE_CHANGED이고 아무것도 바뀌지 않는다',
    async (action, status) => {
      await seedAttempt(status);
      const before = await readState();
      // 없는 attemptId와 상태가 겹쳐도 상태 검사가 먼저다.
      await expect(request(action)).rejects.toMatchObject(conflict('ISSUE_STATE_CHANGED'));
      expect(await readState()).toEqual(before);
    },
  );

  it('attemptId 없이 확인 요청 쪽지를 재요청하거나 attemptId와 함께 확인 완료된 쪽지를 재요청하면 409이고 아무것도 바뀌지 않는다', async () => {
    const attempt = await seedAttempt();
    const ready = await readState();
    await expect(request('reopenWithoutAttempt')).rejects.toMatchObject(conflict('ISSUE_STATE_CHANGED'));
    expect(await readState()).toEqual(ready);
    await request('verify', { attemptId: attempt.id });
    const verified = await readState();
    await expect(request('reopen', { attemptId: attempt.id })).rejects.toMatchObject(conflict('ISSUE_STATE_CHANGED'));
    expect(await readState()).toEqual(verified);
  });

  it.each(['OPEN', 'IN_PROGRESS'] as const)(
    '%s에서 고쳤어요를 보내면 현재 버전의 줄과 일지 하나를 남기고 바뀐 상세를 돌려준다',
    async (status) => {
      const { screen, asset, versionScreen } = await attachScreen(current.id);
      const original = await attachScreen(origin.id);
      await prisma.issue.update({
        where: { id: issueId },
        data: { status, originVersionScreenId: original.versionScreen.id, xRatio: 0.2, yRatio: 0.8 },
      });
      const before = await prisma.issue.findUniqueOrThrow({ where: { id: issueId } });
      const detail = await service.submit(issueId, developer.id, {
        versionId: current.id,
        screenId: screen.id,
        summary: '버튼 크기를 고쳤어요\n확인해 주세요',
      });
      expect(detail).toMatchObject({
        status: 'READY_FOR_REVIEW',
        canReview: false,
        comments: [],
        commentCount: 0,
        projectId,
      });
      expect(detail.attempts).toEqual([
        {
          id: expect.any(String),
          versionId: current.id,
          versionNumber: 2,
          screen: {
            screenId: screen.id,
            screenName: screen.name,
            viewport: screen.viewport,
            asset: { id: asset.id, width: 1200, height: 800 },
          },
          summary: '버튼 크기를 고쳤어요\n확인해 주세요',
          submittedByName: developer.name,
          createdAt: expect.any(Date),
          result: null,
          reviewedByName: null,
          reviewedAt: null,
        },
      ]);
      expect(await prisma.resolutionAttempt.findMany()).toEqual([
        {
          id: detail.attempts[0].id,
          issueId,
          versionId: current.id,
          versionScreenId: versionScreen.id,
          summary: detail.attempts[0].summary,
          submittedById: developer.id,
          createdAt: detail.attempts[0].createdAt,
          result: null,
          reviewedById: null,
          reviewedAt: null,
        },
      ]);
      expect(await prisma.issue.findUniqueOrThrow({ where: { id: issueId } })).toEqual({
        ...before,
        status: 'READY_FOR_REVIEW',
      });
      expect(detail).toEqual(await issues.getDetail(issueId, developer.id));
      await expectEvent('RESOLUTION_SUBMITTED', developer.id);
      expect(await prisma.activityEvent.count()).toBe(1);
    },
  );

  it('현재 버전에 없는 화면으로 고쳤어요를 보내면 404이고 핀이 있는 쪽지에 화면 없이 보내면 422다', async () => {
    const old = await attachScreen(origin.id);
    const foreignProject = await prisma.project.create({ data: { name: '남의 프로젝트' } });
    const foreignVersion = await prisma.deliveryVersion.create({
      data: { projectId: foreignProject.id, number: 1, status: 'IN_REVIEW', publishedAt: new Date() },
    });
    const foreign = await attachScreen(foreignVersion.id, foreignProject.id);
    await prisma.issue.update({
      where: { id: issueId },
      data: { originVersionScreenId: old.versionScreen.id, xRatio: 0, yRatio: 1 },
    });
    const before = await readState();
    for (const screenId of [old.screen.id, foreign.screen.id, missingId]) {
      await expect(
        service.submit(issueId, developer.id, { versionId: current.id, summary: '고쳤어요', screenId }),
      ).rejects.toMatchObject({
        status: 404,
        response: { statusCode: 404, message: '없는 화면이에요', error: 'Not Found' },
      });
      expect(await readState()).toEqual(before);
    }
    await expect(request('submit')).rejects.toMatchObject({ status: 422 });
    expect(await readState()).toEqual(before);
  });

  it.each([false, true])(
    '위치 없는 쪽지는 화면 없이도 화면과 함께도 고쳤어요를 보낸다 (화면: %s)',
    async (withScreen) => {
      const { screen, versionScreen } = await attachScreen(current.id);
      const detail = await service.submit(issueId, developer.id, {
        versionId: current.id,
        summary: '기능을 고쳤어요',
        ...(withScreen ? { screenId: screen.id } : {}),
      });
      expect(detail.status).toBe('READY_FOR_REVIEW');
      expect(detail.attempts).toHaveLength(1);
      expect(detail.attempts[0].screen).toEqual(withScreen ? expect.objectContaining({ screenId: screen.id }) : null);
      expect(await prisma.resolutionAttempt.findMany()).toEqual([
        expect.objectContaining({ versionScreenId: withScreen ? versionScreen.id : null }),
      ]);
    },
  );

  it.each(['verify', 'reopen'] as const)(
    '%s는 대문자 attemptId도 같은 줄로 받아 결과와 바뀐 상세를 돌려준다',
    async (action) => {
      const attempt = await seedAttempt();
      const detail = await request(action, { attemptId: attempt.id.toUpperCase() });
      const answered = await prisma.resolutionAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
      expect(answered).toEqual({
        ...attempt,
        result: action === 'verify' ? 'VERIFIED' : 'REOPENED',
        reviewedById: client.id,
        reviewedAt: expect.any(Date),
      });
      expect(detail).toMatchObject({ status: nextStatus[action], canReview: true, projectId });
      expect(detail.attempts).toEqual([
        {
          id: attempt.id,
          versionId: current.id,
          versionNumber: 2,
          screen: null,
          summary: attempt.summary,
          submittedByName: developer.name,
          createdAt: attempt.createdAt,
          result: answered.result,
          reviewedByName: client.name,
          reviewedAt: answered.reviewedAt,
        },
      ]);
      expect(detail.comments).toHaveLength(action === 'reopen' ? 1 : 0);
      expect(detail).toEqual(await issues.getDetail(issueId, client.id));
      await expectEvent(eventType[action], client.id);
      expect(await prisma.activityEvent.count()).toBe(1);
    },
  );

  describe.each(['verify', 'reopen'] as const)('%s 고쳤어요 줄 검사', (action) => {
    it('옛 attemptId로 확인 완료하거나 재요청하면 409 ATTEMPT_CHANGED이고 아무것도 바뀌지 않는다', async () => {
      const old = await seedAttempt();
      await request('reopen', { attemptId: old.id });
      await request('submit');
      const before = await readState();
      await expect(request(action, { attemptId: old.id })).rejects.toMatchObject(conflict('ATTEMPT_CHANGED'));
      expect(await readState()).toEqual(before);
    });

    it.each(['없는 줄', '다른 쪽지의 줄', '결과 없는 옛 줄', '이미 답한 최근 줄', '줄 없음'] as const)(
      '%s이면 409 ATTEMPT_CHANGED이고 아무것도 바뀌지 않는다',
      async (scenario) => {
        let attemptId = missingId;
        if (scenario !== '줄 없음') attemptId = (await seedAttempt()).id;
        if (scenario === '없는 줄') attemptId = missingId;
        if (scenario === '다른 쪽지의 줄')
          attemptId = (await seedAttempt('READY_FOR_REVIEW', (await createIssue()).id)).id;
        if (scenario === '결과 없는 옛 줄') {
          await prisma.resolutionAttempt.update({
            where: { id: attemptId },
            data: { createdAt: new Date('2020-01-01') },
          });
          await seedAttempt();
        }
        if (scenario === '이미 답한 최근 줄') {
          await prisma.resolutionAttempt.update({
            where: { id: attemptId },
            data: { result: 'VERIFIED', reviewedById: client.id, reviewedAt: new Date() },
          });
        }
        await prisma.issue.update({ where: { id: issueId }, data: { status: 'READY_FOR_REVIEW' } });
        const before = await readState();
        await expect(request(action, { attemptId })).rejects.toMatchObject(conflict('ATTEMPT_CHANGED'));
        expect(await readState()).toEqual(before);
      },
    );
  });

  it('고쳤어요를 재요청 뒤에 다시 보내면 줄이 2개 쌓이고 첫 줄은 바뀌지 않는다', async () => {
    const first = await request('submit');
    await request('reopen', { attemptId: first.attempts[0].id });
    const old = await prisma.resolutionAttempt.findUniqueOrThrow({ where: { id: first.attempts[0].id } });
    const second = await service.submit(issueId, developer.id, {
      versionId: current.id,
      summary: '두 번째로 고쳤어요',
    });
    expect(await prisma.resolutionAttempt.findUniqueOrThrow({ where: { id: old.id } })).toEqual(old);
    expect(second.attempts.map(({ id, summary, result }) => ({ id, summary, result }))).toEqual([
      { id: old.id, summary: old.summary, result: 'REOPENED' },
      { id: expect.any(String), summary: '두 번째로 고쳤어요', result: null },
    ]);
    expect(second.attempts[1].id).not.toBe(old.id);
    expect(await prisma.resolutionAttempt.count()).toBe(2);
    expect((await readEvents()).map(({ type }) => type)).toEqual([
      'RESOLUTION_SUBMITTED',
      'ISSUE_REOPENED',
      'RESOLUTION_SUBMITTED',
    ]);
  });

  it('확인 완료된 쪽지를 다시 열어도 지난 줄의 결과는 그대로다', async () => {
    const attempt = await seedAttempt();
    await request('verify', { attemptId: attempt.id });
    const before = await prisma.resolutionAttempt.findMany();
    const detail = await request('reopenWithoutAttempt');
    expect(detail).toMatchObject({ status: 'OPEN', canReview: true, commentCount: 1 });
    expect(detail.attempts[0]).toMatchObject({ result: 'VERIFIED', reviewedByName: client.name });
    expect(await prisma.resolutionAttempt.findMany()).toEqual(before);
    expect(detail).toEqual(await issues.getDetail(issueId, client.id));
  });

  it('고쳤어요 없이 철회한 쪽지도 다시 열 수 있다', async () => {
    await request('withdraw');
    const detail = await request('reopenWithoutAttempt', { userId: approver.id });
    expect(detail).toMatchObject({ status: 'OPEN', attempts: [], canReview: true, commentCount: 2 });
    expect(detail.comments.map(({ body }) => body)).toEqual([
      '철회 사유: 요청을 취소해요',
      '다시 연 사유: 다시 확인해 주세요',
    ]);
    expect(await prisma.resolutionAttempt.count()).toBe(0);
    await expectEvent('ISSUE_REOPENED', approver.id);
  });

  it.each(['OPEN', 'IN_PROGRESS', 'READY_FOR_REVIEW'] as const)(
    '%s에서 철회하면 줄을 건드리지 않고 사유·일지·바뀐 상세를 남긴다',
    async (status) => {
      const attempt = await seedAttempt(status);
      const detail = await request('withdraw');
      expect(detail).toMatchObject({ status: 'WITHDRAWN', canReview: true, commentCount: 1 });
      expect(detail.attempts[0]).toMatchObject({ result: null, reviewedByName: null, reviewedAt: null });
      expect(await prisma.resolutionAttempt.findMany()).toEqual([attempt]);
      expect(detail).toEqual(await issues.getDetail(issueId, client.id));
      await expectEvent('ISSUE_WITHDRAWN', client.id);
      expect(await prisma.activityEvent.count()).toBe(1);
      const reopened = await request('reopenWithoutAttempt');
      expect(reopened.status).toBe('OPEN');
      expect(await prisma.resolutionAttempt.findMany()).toEqual([attempt]);
    },
  );

  it.each([
    ['reopen', 'READY_FOR_REVIEW', '재요청 사유'],
    ['reopenWithoutAttempt', 'VERIFIED', '다시 연 사유'],
    ['reopenWithoutAttempt', 'WITHDRAWN', '다시 연 사유'],
    ['withdraw', 'READY_FOR_REVIEW', '철회 사유'],
  ] as const)(
    '재요청·철회·다시 열기의 사유가 종류가 붙은 댓글로 그 사람 이름과 현재 버전으로 남는다 (%s, %s)',
    async (action, status, label) => {
      const attempt = await seedAttempt(status);
      const detail = await request(action, { userId: approver.id, attemptId: attempt.id });
      const body = `${label}: ${action === 'withdraw' ? '요청을 취소해요' : '다시 확인해 주세요'}`;
      expect(await prisma.comment.findMany()).toEqual([
        {
          id: expect.any(String),
          issueId,
          authorId: approver.id,
          versionId: current.id,
          requestId: null,
          body,
          createdAt: expect.any(Date),
        },
      ]);
      expect(detail.comments).toEqual([
        {
          id: expect.any(String),
          body,
          authorName: approver.name,
          versionNumber: 2,
          createdAt: expect.any(Date),
        },
      ]);
      expect(detail.commentCount).toBe(1);
      expect(detail.canReview).toBe(true);
      await expectEvent(eventType[action], approver.id);
    },
  );

  it.each(actions)(
    '저장된 고쳤어요·확인 완료·재요청·철회를 다시 보내면 409이고 줄과 댓글과 일지가 하나씩만 남는다 (%s)',
    async (action) => {
      const attempt =
        action === 'submit' || action === 'withdraw' ? undefined : await seedAttempt(allowedStatus[action]);
      const options = { attemptId: attempt?.id };
      await request(action, options);
      const before = await readState();
      expect(before.attempts).toHaveLength(action === 'withdraw' ? 0 : 1);
      expect(before.comments).toHaveLength(['reopen', 'reopenWithoutAttempt', 'withdraw'].includes(action) ? 1 : 0);
      expect(before.events).toHaveLength(1);
      await expect(request(action, options)).rejects.toMatchObject(conflict('ISSUE_STATE_CHANGED'));
      expect(await readState()).toEqual(before);
    },
  );

  it('저장된 고쳤어요를 재요청 뒤에 다시 보내면 새 줄이 생기고 저장된 철회를 다시 연 뒤에 다시 보내면 다시 철회된다', async () => {
    const first = await request('submit');
    await request('reopen', { userId: approver.id, attemptId: first.attempts[0].id });
    const old = await prisma.resolutionAttempt.findUniqueOrThrow({ where: { id: first.attempts[0].id } });
    const second = await request('submit');
    expect(second.attempts).toHaveLength(2);
    expect(await prisma.resolutionAttempt.findUniqueOrThrow({ where: { id: old.id } })).toEqual(old);
    await request('withdraw');
    await request('reopenWithoutAttempt', { userId: approver.id });
    const withdrawn = await request('withdraw');
    expect(withdrawn.status).toBe('WITHDRAWN');
    expect(withdrawn.comments.map(({ body }) => body)).toEqual([
      '재요청 사유: 다시 확인해 주세요',
      '철회 사유: 요청을 취소해요',
      '다시 연 사유: 다시 확인해 주세요',
      '철회 사유: 요청을 취소해요',
    ]);
    expect((await readEvents()).map(({ type }) => type)).toEqual([
      'RESOLUTION_SUBMITTED',
      'ISSUE_REOPENED',
      'RESOLUTION_SUBMITTED',
      'ISSUE_WITHDRAWN',
      'ISSUE_REOPENED',
      'ISSUE_WITHDRAWN',
    ]);
    expect(await prisma.resolutionAttempt.count()).toBe(2);
  });

  it('저장된 다시 열기를 철회 뒤에 다시 보내면 다시 열리고 저장된 확인 완료를 새 고쳤어요 뒤에 다시 보내면 409 ATTEMPT_CHANGED다', async () => {
    const attempt = await seedAttempt();
    await request('verify', { attemptId: attempt.id });
    await request('reopenWithoutAttempt');
    await request('withdraw', { userId: approver.id });
    const reopened = await request('reopenWithoutAttempt');
    expect(reopened).toMatchObject({ status: 'OPEN', commentCount: 3 });
    expect(reopened.comments.map(({ body }) => body)).toEqual([
      '다시 연 사유: 다시 확인해 주세요',
      '철회 사유: 요청을 취소해요',
      '다시 연 사유: 다시 확인해 주세요',
    ]);
    await request('submit');
    const before = await readState();
    await expect(request('verify', { attemptId: attempt.id })).rejects.toMatchObject(conflict('ATTEMPT_CHANGED'));
    expect(await readState()).toEqual(before);
    expect((await readEvents()).map(({ type }) => type)).toEqual([
      'ISSUE_VERIFIED',
      'ISSUE_REOPENED',
      'ISSUE_WITHDRAWN',
      'ISSUE_REOPENED',
      'RESOLUTION_SUBMITTED',
    ]);
  });

  it('고쳤어요를 동시에 두 번 보내면 하나만 성공하고 줄은 하나다', async () => {
    const results = await Promise.allSettled([request('submit'), request('submit')]);
    const succeeded = results.filter((result) => result.status === 'fulfilled');
    const failed = results.filter((result) => result.status === 'rejected');
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].reason).toMatchObject(conflict('ISSUE_STATE_CHANGED'));
    expect(succeeded[0].value).toMatchObject({
      status: 'READY_FOR_REVIEW',
      attempts: [expect.objectContaining({ result: null })],
    });
    expect(await prisma.resolutionAttempt.count()).toBe(1);
    expect(await prisma.comment.count()).toBe(0);
    expect(await prisma.activityEvent.count()).toBe(1);
    await expectEvent('RESOLUTION_SUBMITTED', developer.id);
  });

  it('확인 완료와 재요청을 동시에 보내면 하나만 성공하고 결과는 그 하나만 적힌다', async () => {
    const attempt = await seedAttempt();
    const results = await Promise.allSettled([
      request('verify', { attemptId: attempt.id }),
      request('reopen', { attemptId: attempt.id, userId: approver.id }),
    ]);
    const succeeded = results.filter((result) => result.status === 'fulfilled');
    const failed = results.filter((result) => result.status === 'rejected');
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].reason).toMatchObject(conflict('ISSUE_STATE_CHANGED'));
    const verified = results[0].status === 'fulfilled';
    expect(succeeded[0].value.status).toBe(verified ? 'VERIFIED' : 'OPEN');
    expect(await prisma.resolutionAttempt.findMany()).toEqual([
      {
        ...attempt,
        result: verified ? 'VERIFIED' : 'REOPENED',
        reviewedById: verified ? client.id : approver.id,
        reviewedAt: expect.any(Date),
      },
    ]);
    expect(await prisma.comment.count()).toBe(verified ? 0 : 1);
    expect(await prisma.activityEvent.count()).toBe(1);
    await expectEvent(verified ? 'ISSUE_VERIFIED' : 'ISSUE_REOPENED', verified ? client.id : approver.id);
  });

  describe.each(actions)('%s 잠금 뒤 재검사', (action) => {
    it.each(['멤버 철회', '권한 변경', '새 버전', '버전 승인', '쪽지 상태'] as const)(
      'Project 잠금을 기다리는 동안 %s 상황이 생기면 새 값으로 거절하고 아무것도 쓰지 않는다',
      async (change) => {
        if (change === '권한 변경' && action !== 'submit') {
          await prisma.issue.update({ where: { id: issueId }, data: { authorId: developer.id } });
          const member = await prisma.projectMember.findUniqueOrThrow({
            where: { projectId_userId: { projectId, userId: client.id } },
          });
          await prisma.project.update({ where: { id: projectId }, data: { approverMemberId: member.id } });
        }
        const attempt = await seedAttempt(allowedStatus[action]);
        const actor = action === 'submit' ? developer : client;
        const result = await requestWhileLocked(action, attempt.id, async (tx) => {
          if (change === '멤버 철회') {
            return tx.projectMember.update({
              where: { projectId_userId: { projectId, userId: actor.id } },
              data: { revokedAt: new Date() },
            });
          }
          if (change === '권한 변경' && action === 'submit') {
            return tx.projectMember.update({
              where: { projectId_userId: { projectId, userId: actor.id } },
              data: { role: 'CLIENT' },
            });
          }
          if (change === '권한 변경') {
            return tx.project.update({ where: { id: projectId }, data: { approverMemberId: null } });
          }
          if (change === '새 버전') {
            const version = await tx.deliveryVersion.create({
              data: { projectId, number: 3, status: 'IN_REVIEW', publishedAt: new Date() },
            });
            return tx.project.update({ where: { id: projectId }, data: { currentVersionId: version.id } });
          }
          if (change === '버전 승인') {
            return tx.deliveryVersion.update({ where: { id: current.id }, data: { status: 'APPROVED' } });
          }
          return tx.issue.update({
            where: { id: issueId },
            data: { status: action === 'reopenWithoutAttempt' ? 'OPEN' : 'WITHDRAWN' },
          });
        });
        const expected = {
          '멤버 철회': notFound,
          '권한 변경': forbidden,
          '새 버전': conflict('VERSION_CHANGED'),
          '버전 승인': conflict('VERSION_NOT_IN_REVIEW'),
          '쪽지 상태': conflict('ISSUE_STATE_CHANGED'),
        }[change];
        expect(result.outcome).toMatchObject({ error: expected });
        expect(await readState()).toEqual(result.stateBeforeRelease);
      },
      20_000,
    );
  });

  it.each(['verify', 'reopen'] as const)(
    '%s는 잠금을 기다리는 동안 새 고쳤어요가 오면 옛 줄을 바꾸지 않는다',
    async (action) => {
      const attempt = await seedAttempt();
      const result = await requestWhileLocked(action, attempt.id, async (tx) => {
        await tx.resolutionAttempt.update({
          where: { id: attempt.id },
          data: { result: 'REOPENED', reviewedById: approver.id, reviewedAt: new Date() },
        });
        await tx.resolutionAttempt.create({
          data: {
            issueId,
            versionId: current.id,
            submittedById: developer.id,
            summary: '잠금을 기다리는 사이 새로 고쳤어요',
          },
        });
      });
      expect(result.outcome).toMatchObject({ error: conflict('ATTEMPT_CHANGED') });
      expect(await readState()).toEqual(result.stateBeforeRelease);
    },
    20_000,
  );

  it.each(actions)(
    '%s의 줄·확인·사유 시각은 서버 시계가 달라도 잠금을 얻은 뒤의 DB 시각이다',
    async (action) => {
      const attempt = action === 'submit' ? undefined : await seedAttempt(allowedStatus[action]);
      try {
        const result = await requestWhileLocked(action, attempt?.id ?? missingId, async (tx) => {
          // 트랜잭션 시작 시각(now)과 잠금 해제 뒤 시각(clock_timestamp)을 구별한다.
          await tx.$queryRaw`SELECT 1 FROM pg_sleep(0.03)`;
          vi.useFakeTimers({ toFake: ['Date'] });
          vi.setSystemTime(new Date('2000-01-01T00:00:00Z'));
        });
        expect(result.outcome).toMatchObject({ detail: { status: nextStatus[action] } });
        const [{ time: after }] = await prisma.$queryRaw<{ time: Date }[]>`SELECT clock_timestamp() AS time`;
        const state = await readState();
        const timestamps = state.comments.map(({ createdAt }) => createdAt);
        if (action === 'submit') timestamps.push(state.attempts[0].createdAt);
        if (action === 'verify' || action === 'reopen') timestamps.push(state.attempts[0].reviewedAt!);
        expect(timestamps.length).toBeGreaterThan(0);
        for (const timestamp of timestamps) {
          expect(timestamp.getTime()).toBeGreaterThanOrEqual(result.beforeRelease.getTime());
          expect(timestamp.getTime()).toBeLessThanOrEqual(after.getTime());
        }
      } finally {
        vi.useRealTimers();
      }
    },
    20_000,
  );

  describe('저장 실패 되돌림', () => {
    it.each([
      ['submit', 'activity_events'],
      ['verify', 'activity_events'],
      ['reopen', 'activity_events'],
      ['reopenWithoutAttempt', 'activity_events'],
      ['withdraw', 'activity_events'],
      ['reopen', 'comments'],
      ['reopenWithoutAttempt', 'comments'],
      ['withdraw', 'comments'],
    ] as const)('사유 댓글이나 일지 저장이 실패하면 상태와 줄도 바뀌지 않는다 (%s, %s)', async (action, table) => {
      const attempt = action === 'submit' ? undefined : await seedAttempt(allowedStatus[action]);
      const before = await readState();
      try {
        await prisma.$executeRaw`
          CREATE FUNCTION resolution_service_fail_insert() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            RAISE EXCEPTION 'resolution service insert failure';
          END;
          $$
        `;
        // table은 위 테스트 목록의 고정된 두 값뿐이다. 사용자 입력이 아니다.
        await prisma.$executeRawUnsafe(`
          CREATE TRIGGER resolution_service_fail_insert BEFORE INSERT ON ${table}
          FOR EACH ROW EXECUTE FUNCTION resolution_service_fail_insert()
        `);
        await expect(request(action, { attemptId: attempt?.id })).rejects.toThrow('resolution service insert failure');
        expect(await readState()).toEqual(before);
      } finally {
        try {
          await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS resolution_service_fail_insert ON ${table}`);
        } finally {
          await prisma.$executeRaw`DROP FUNCTION IF EXISTS resolution_service_fail_insert()`;
        }
      }
      const detail = await request(action, { attemptId: attempt?.id });
      expect(detail.status).toBe(nextStatus[action]);
      await expectEvent(eventType[action], action === 'submit' ? developer.id : client.id);
    });
  });
});
