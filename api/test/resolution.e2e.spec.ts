import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { createSessionToken, hashSessionToken } from '../src/auth/token.js';
import type { IssueStatus } from '../src/generated/prisma/client.js';
import { MailService } from '../src/mail/mail.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { setupApp } from '../src/setup-app.js';
import { resetDatabase } from './reset-database.js';

const origin = 'http://localhost:5173';
const missingId = '00000000-0000-4000-8000-000000000001';
const actions = ['submit-resolution', 'verify', 'reopen', 'withdraw'] as const;
type Action = (typeof actions)[number];
const issueNotFoundBody = { statusCode: 404, message: '없는 쪽지예요', error: 'Not Found' };
const forbiddenReviewBody = {
  statusCode: 403,
  message: '쪽지를 쓴 사람과 승인자만 할 수 있어요',
  error: 'Forbidden',
};
const stateChangedBody = { statusCode: 409, code: 'ISSUE_STATE_CHANGED', message: '쪽지 상태가 바뀌었어요' };
const attemptChangedBody = { statusCode: 409, code: 'ATTEMPT_CHANGED', message: '새 고쳤어요가 왔어요' };

describe('고쳤어요 API (e2e)', () => {
  let app: INestApplication | undefined;
  let server: Server;
  let prisma: PrismaService;
  let directory: string;
  let projectId: string;
  let versionId: string;
  let oldVersionId: string;
  let screenId: string;
  let versionScreenId: string;
  let assetId: string;
  let issueId: string;
  let developerId: string;
  let clientId: string;
  let approverId: string;
  let approverMemberId: string;
  let cookie: string;
  let clientCookie: string;
  let approverCookie: string;
  let otherCookie: string;

  const login = async (userId: string) => {
    const token = createSessionToken();
    await prisma.session.create({
      data: { userId, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
    });
    return `sid=${token}`;
  };
  const get = (targetIssueId = issueId, memberCookie = clientCookie) =>
    request(server).get(`/api/issues/${targetIssueId}`).set('Cookie', memberCookie);
  const post = (path: string, memberCookie = cookie) =>
    request(server).post(path).set('Origin', origin).set('Cookie', memberCookie);
  const input = (action: Action, attemptId = missingId): Record<string, unknown> => {
    if (action === 'submit-resolution') return { versionId, summary: '버튼을 고쳤어요', screenId };
    if (action === 'verify') return { versionId, attemptId };
    if (action === 'reopen') return { versionId, attemptId, reason: '다시 고쳐 주세요' };
    return { versionId, reason: '필요 없어졌어요' };
  };
  const change = (
    action: Action,
    body = input(action),
    memberCookie = action === 'submit-resolution' ? cookie : clientCookie,
    targetIssueId = issueId,
  ) => post(`/api/issues/${targetIssueId}/${action}`, memberCookie).send(body);
  const createIssue = (memberCookie = clientCookie, changes: Record<string, unknown> = {}) =>
    post(`/api/projects/${projectId}/issues`, memberCookie)
      .send({
        requestId: randomUUID(),
        versionId: oldVersionId,
        title: '버튼을 고쳐 주세요',
        body: '버튼이 작아요',
        ...changes,
      })
      .expect(201);
  const submit = (targetIssueId = issueId, changes: Record<string, unknown> = {}) =>
    change('submit-resolution', { ...input('submit-resolution'), ...changes }, cookie, targetIssueId).expect(200);
  const readState = async () => ({
    issues: await prisma.issue.findMany({ orderBy: { id: 'asc' } }),
    attempts: await prisma.resolutionAttempt.findMany({ orderBy: { id: 'asc' } }),
    comments: await prisma.comment.findMany({ orderBy: { id: 'asc' } }),
    events: await prisma.activityEvent.findMany({ orderBy: { id: 'asc' } }),
  });
  const eventsForIssue = async (targetIssueId = issueId) =>
    prisma.activityEvent.findMany({ where: { issueId: targetIssueId }, orderBy: { createdAt: 'asc' } });

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'resolution-e2e-'));
    vi.stubEnv('ASSET_DIR', directory);
    vi.stubEnv('APP_ORIGINS', origin);
    vi.stubEnv('COOKIE_SECURE', undefined);
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MailService)
      .useValue({ sendLoginCode: vi.fn(), sendInvitation: vi.fn() })
      .compile();
    app = module.createNestApplication();
    setupApp(app);
    await app.init();
    server = app.getHttpServer() as Server;
    prisma = app.get(PrismaService);
    await resetDatabase(prisma);
    const developer = await prisma.user.create({ data: { email: 'developer@example.com', name: '개발자' } });
    const client = await prisma.user.create({ data: { email: 'client@example.com', name: '클라이언트' } });
    const approver = await prisma.user.create({ data: { email: 'approver@example.com', name: '승인자' } });
    const other = await prisma.user.create({ data: { email: 'other@example.com', name: '다른 클라이언트' } });
    developerId = developer.id;
    clientId = client.id;
    approverId = approver.id;
    const project = await prisma.project.create({
      data: {
        name: '고쳤어요 검수 프로젝트',
        members: {
          create: [
            { userId: developerId, role: 'DEVELOPER' },
            { userId: clientId, role: 'CLIENT' },
            { userId: approverId, role: 'CLIENT' },
            { userId: other.id, role: 'CLIENT' },
          ],
        },
      },
      include: { members: true },
    });
    projectId = project.id;
    approverMemberId = project.members.find((member) => member.userId === approverId)!.id;
    // 게시 처리는 조각 5에서 별도로 검사한다. 여기서는 게시된 1차·2차를 DB 제약에 맞게 준비한다.
    const oldVersion = await prisma.deliveryVersion.create({
      data: { projectId, status: 'IN_REVIEW', number: 1, publishedAt: new Date('2026-11-01T00:00:00Z') },
    });
    oldVersionId = oldVersion.id;
    await prisma.project.update({
      where: { id: projectId },
      data: { currentVersionId: oldVersionId, approverMemberId },
    });
    const screen = await prisma.screen.create({ data: { projectId, name: '첫 화면', viewport: 'PC' } });
    screenId = screen.id;
    const asset = await prisma.asset.create({
      data: { projectId, storageKey: `${projectId}/screen.png`, mime: 'image/png', bytes: 100, width: 32, height: 24 },
    });
    assetId = asset.id;
    await prisma.versionScreen.create({ data: { versionId: oldVersionId, screenId, assetId } });
    cookie = await login(developerId);
    clientCookie = await login(clientId);
    approverCookie = await login(approverId);
    otherCookie = await login(other.id);
    const issue = await createIssue();
    issueId = issue.body.id;
    const version = await prisma.deliveryVersion.create({
      data: { projectId, status: 'IN_REVIEW', number: 2, publishedAt: new Date('2026-11-02T00:00:00Z') },
    });
    versionId = version.id;
    const versionScreen = await prisma.versionScreen.create({ data: { versionId, screenId, assetId } });
    versionScreenId = versionScreen.id;
    await prisma.project.update({ where: { id: projectId }, data: { currentVersionId: versionId } });
  });

  afterEach(async () => {
    try {
      await app?.close();
    } finally {
      app = undefined;
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  });

  it('클라이언트와 승인자가 고쳤어요를 보내면 403이고 아무것도 바뀌지 않는다', async () => {
    const before = await readState();
    for (const memberCookie of [clientCookie, approverCookie]) {
      await change('submit-resolution', input('submit-resolution'), memberCookie)
        .expect(403)
        .expect({ statusCode: 403, message: '개발자만 할 수 있어요', error: 'Forbidden' });
      expect(await readState()).toEqual(before);
    }
  });

  it('개발자가 확인 완료·재요청·철회를 하면 403이고 아무것도 바뀌지 않는다', async () => {
    const ready = await submit();
    const before = await readState();
    for (const action of ['verify', 'reopen', 'withdraw'] as const) {
      await change(action, input(action, ready.body.attempts[0].id), cookie).expect(403).expect(forbiddenReviewBody);
      expect(await readState()).toEqual(before);
    }
  });

  it('클라이언트가 남이 쓴 쪽지를 확인 완료·재요청·철회하면 403이고 아무것도 바뀌지 않는다', async () => {
    const ready = await submit();
    const before = await readState();
    for (const action of ['verify', 'reopen', 'withdraw'] as const) {
      await change(action, input(action, ready.body.attempts[0].id), otherCookie)
        .expect(403)
        .expect(forbiddenReviewBody);
      expect(await readState()).toEqual(before);
    }
  });

  it('승인자는 남이 쓴 쪽지와 개발자가 쓴 쪽지도 확인 완료·재요청·철회한다', async () => {
    for (const authorCookie of [clientCookie, cookie]) {
      const issue = await createIssue(authorCookie, { versionId });
      const ready = await submit(issue.body.id);
      const verified = await change(
        'verify',
        input('verify', ready.body.attempts[0].id),
        approverCookie,
        issue.body.id,
      ).expect(200);
      expect(verified.body).toMatchObject({ id: issue.body.id, projectId, status: 'VERIFIED', canReview: true });
      expect(verified.body.attempts[0]).toMatchObject({
        result: 'VERIFIED',
        reviewedByName: '승인자',
        reviewedAt: expect.any(String),
      });
      await get(issue.body.id, approverCookie).expect(200).expect(verified.body);
      await change('reopen', { versionId, reason: '다시 열어요' }, approverCookie, issue.body.id).expect(200);
      const second = await submit(issue.body.id);
      const reopened = await change(
        'reopen',
        input('reopen', second.body.attempts[1].id),
        approverCookie,
        issue.body.id,
      ).expect(200);
      expect(reopened.body.status).toBe('OPEN');
      expect(reopened.body.attempts[1]).toMatchObject({ result: 'REOPENED', reviewedByName: '승인자' });
      await get(issue.body.id, approverCookie).expect(200).expect(reopened.body);
      const withdrawn = await change('withdraw', input('withdraw'), approverCookie, issue.body.id).expect(200);
      expect(withdrawn.body.status).toBe('WITHDRAWN');
      await get(issue.body.id, approverCookie).expect(200).expect(withdrawn.body);
    }
  });

  it('개발자가 쓴 쪽지는 승인자만 확인하고 승인자가 없으면 누구도 확인할 수 없다', async () => {
    const issue = await createIssue(cookie, { versionId });
    const ready = await submit(issue.body.id);
    const attemptId = ready.body.attempts[0].id;
    await get(issue.body.id, approverCookie)
      .expect(200)
      .expect((response) => expect(response.body.canReview).toBe(true));
    const before = await readState();
    for (const memberCookie of [cookie, clientCookie, otherCookie]) {
      await get(issue.body.id, memberCookie)
        .expect(200)
        .expect((response) => expect(response.body.canReview).toBe(false));
      await change('verify', input('verify', attemptId), memberCookie, issue.body.id)
        .expect(403)
        .expect(forbiddenReviewBody);
    }
    await prisma.project.update({ where: { id: projectId }, data: { approverMemberId: null } });
    for (const memberCookie of [cookie, clientCookie, otherCookie, approverCookie]) {
      await get(issue.body.id, memberCookie)
        .expect(200)
        .expect((response) => expect(response.body.canReview).toBe(false));
      await change('verify', input('verify', attemptId), memberCookie, issue.body.id)
        .expect(403)
        .expect(forbiddenReviewBody);
      await change('reopen', input('reopen', attemptId), memberCookie, issue.body.id)
        .expect(403)
        .expect(forbiddenReviewBody);
      await change('withdraw', input('withdraw'), memberCookie, issue.body.id).expect(403).expect(forbiddenReviewBody);
    }
    expect(await readState()).toEqual(before);
  });

  it('옛 attemptId로 확인 완료하거나 재요청하면 409 ATTEMPT_CHANGED이고 아무것도 바뀌지 않는다', async () => {
    const first = await submit();
    const attemptId = first.body.attempts[0].id;
    await change('reopen', input('reopen', attemptId)).expect(200);
    await submit();
    const other = await createIssue(clientCookie, { versionId });
    const otherReady = await submit(other.body.id);
    const before = await readState();
    for (const staleId of [attemptId, otherReady.body.attempts[0].id, missingId]) {
      await change('verify', input('verify', staleId)).expect(409).expect(attemptChangedBody);
      await change('reopen', input('reopen', staleId)).expect(409).expect(attemptChangedBody);
      expect(await readState()).toEqual(before);
    }
  });

  it('상태가 맞지 않는 요청 (각 경우)는 409 ISSUE_STATE_CHANGED이고 아무것도 바뀌지 않는다', async () => {
    const cases: [Action, IssueStatus, boolean?][] = [
      ['submit-resolution', 'READY_FOR_REVIEW'],
      ['submit-resolution', 'VERIFIED'],
      ['submit-resolution', 'WITHDRAWN'],
      ['verify', 'OPEN'],
      ['verify', 'IN_PROGRESS'],
      ['verify', 'VERIFIED'],
      ['verify', 'WITHDRAWN'],
      ['reopen', 'OPEN'],
      ['reopen', 'IN_PROGRESS'],
      ['reopen', 'VERIFIED'],
      ['reopen', 'WITHDRAWN'],
      ['reopen', 'OPEN', true],
      ['reopen', 'IN_PROGRESS', true],
      ['reopen', 'READY_FOR_REVIEW', true],
      ['withdraw', 'VERIFIED'],
      ['withdraw', 'WITHDRAWN'],
    ];
    for (const [action, status, withoutAttempt] of cases) {
      await prisma.issue.update({ where: { id: issueId }, data: { status } });
      const before = await readState();
      const body = input(action);
      if (withoutAttempt) delete body.attemptId;
      await change(action, body).expect(409).expect(stateChangedBody);
      expect(await readState(), `${action}: ${status}, attemptId 없음=${!!withoutAttempt}`).toEqual(before);
    }
  });

  it('attemptId 없이 확인 요청 쪽지를 재요청하거나 attemptId와 함께 확인 완료된 쪽지를 재요청하면 409이고 아무것도 바뀌지 않는다', async () => {
    const ready = await submit();
    const before = await readState();
    await change('reopen', { versionId, reason: '다시 열어요' }).expect(409).expect(stateChangedBody);
    expect(await readState()).toEqual(before);
    await change('verify', input('verify', ready.body.attempts[0].id)).expect(200);
    const verified = await readState();
    await change('reopen', input('reopen', ready.body.attempts[0].id)).expect(409).expect(stateChangedBody);
    expect(await readState()).toEqual(verified);
  });

  it('고쳤어요를 재요청 뒤에 다시 보내면 줄이 2개 쌓이고 첫 줄은 바뀌지 않는다', async () => {
    const first = await submit();
    const attemptId = first.body.attempts[0].id;
    const reopened = await change('reopen', input('reopen', attemptId)).expect(200);
    const saved = await prisma.resolutionAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    const second = await submit(issueId, { summary: '두 번째로 고쳤어요' });
    expect(second.body).toMatchObject({ status: 'READY_FOR_REVIEW', projectId, canReview: false });
    expect(second.body.attempts).toHaveLength(2);
    expect(second.body.attempts[0]).toEqual(reopened.body.attempts[0]);
    expect(second.body.attempts[1]).toMatchObject({
      summary: '두 번째로 고쳤어요',
      result: null,
      reviewedByName: null,
      reviewedAt: null,
    });
    expect(await prisma.resolutionAttempt.findUniqueOrThrow({ where: { id: attemptId } })).toEqual(saved);
    expect(await prisma.resolutionAttempt.count({ where: { issueId } })).toBe(2);
    await get(issueId, cookie).expect(200).expect(second.body);
  });

  it('확인 완료된 쪽지를 다시 열어도 지난 줄의 결과는 그대로다', async () => {
    const ready = await submit();
    const verified = await change('verify', input('verify', ready.body.attempts[0].id)).expect(200);
    const saved = await prisma.resolutionAttempt.findMany();
    const reopened = await change('reopen', { versionId, reason: '확인할 것이 남았어요' }).expect(200);
    expect(reopened.body).toMatchObject({ status: 'OPEN', attempts: verified.body.attempts });
    expect(await prisma.resolutionAttempt.findMany()).toEqual(saved);
    expect(saved[0]).toMatchObject({ result: 'VERIFIED', reviewedById: clientId, reviewedAt: expect.any(Date) });
    await get().expect(200).expect(reopened.body);
  });

  it('저장된 고쳤어요·확인 완료·재요청·철회를 다시 보내면 409이고 줄과 댓글과 일지가 하나씩만 남는다', async () => {
    const ready = await submit();
    const submitted = await readState();
    await change('submit-resolution').expect(409).expect(stateChangedBody);
    expect(await readState()).toEqual(submitted);
    expect(submitted.attempts).toHaveLength(1);
    expect(submitted.comments).toHaveLength(0);
    expect(submitted.events.filter((event) => event.type === 'RESOLUTION_SUBMITTED')).toHaveLength(1);
    const verifyInput = input('verify', ready.body.attempts[0].id);
    await change('verify', verifyInput).expect(200);
    const verified = await readState();
    await change('verify', verifyInput).expect(409).expect(stateChangedBody);
    expect(await readState()).toEqual(verified);
    expect(verified.events.filter((event) => event.type === 'ISSUE_VERIFIED')).toHaveLength(1);
    const reopenInput = { versionId, reason: '다시 확인해 주세요' };
    await change('reopen', reopenInput).expect(200);
    const reopened = await readState();
    await change('reopen', reopenInput).expect(409).expect(stateChangedBody);
    expect(await readState()).toEqual(reopened);
    expect(reopened.comments).toHaveLength(1);
    const second = await submit();
    const rejectInput = input('reopen', second.body.attempts[1].id);
    await change('reopen', rejectInput).expect(200);
    const rejected = await readState();
    await change('reopen', rejectInput).expect(409).expect(stateChangedBody);
    expect(await readState()).toEqual(rejected);
    expect(rejected.attempts).toHaveLength(2);
    expect(rejected.comments).toHaveLength(2);
    await change('withdraw').expect(200);
    const withdrawn = await readState();
    await change('withdraw').expect(409).expect(stateChangedBody);
    expect(await readState()).toEqual(withdrawn);
    expect(withdrawn.comments).toHaveLength(3);
    expect((await eventsForIssue()).map((event) => event.type)).toEqual([
      'ISSUE_CREATED',
      'RESOLUTION_SUBMITTED',
      'ISSUE_VERIFIED',
      'ISSUE_REOPENED',
      'RESOLUTION_SUBMITTED',
      'ISSUE_REOPENED',
      'ISSUE_WITHDRAWN',
    ]);
  });

  it('저장된 고쳤어요를 재요청 뒤에 다시 보내면 새 줄이 생기고 저장된 철회를 다시 연 뒤에 다시 보내면 다시 철회된다', async () => {
    const body = input('submit-resolution');
    const first = await change('submit-resolution', body).expect(200);
    const rejected = await change('reopen', input('reopen', first.body.attempts[0].id)).expect(200);
    const second = await change('submit-resolution', body).expect(200);
    expect(second.body.attempts).toHaveLength(2);
    expect(second.body.attempts[0]).toEqual(rejected.body.attempts[0]);
    expect(second.body.attempts[1]).toMatchObject({ summary: body.summary, result: null });
    expect(second.body.attempts[1].id).not.toBe(second.body.attempts[0].id);
    const attempts = await prisma.resolutionAttempt.findMany({ orderBy: { createdAt: 'asc' } });
    await change('withdraw').expect(200);
    await change('reopen', { versionId, reason: '다시 필요해요' }).expect(200);
    const withdrawn = await change('withdraw').expect(200);
    expect(withdrawn.body.status).toBe('WITHDRAWN');
    expect(await prisma.resolutionAttempt.findMany({ orderBy: { createdAt: 'asc' } })).toEqual(attempts);
    expect(withdrawn.body.comments.map((comment: { body: string }) => comment.body)).toEqual([
      '재요청 사유: 다시 고쳐 주세요',
      '철회 사유: 필요 없어졌어요',
      '다시 연 사유: 다시 필요해요',
      '철회 사유: 필요 없어졌어요',
    ]);
    expect((await eventsForIssue()).map((event) => event.type)).toEqual([
      'ISSUE_CREATED',
      'RESOLUTION_SUBMITTED',
      'ISSUE_REOPENED',
      'RESOLUTION_SUBMITTED',
      'ISSUE_WITHDRAWN',
      'ISSUE_REOPENED',
      'ISSUE_WITHDRAWN',
    ]);
    await get().expect(200).expect(withdrawn.body);
  });

  it('저장된 다시 열기를 철회 뒤에 다시 보내면 다시 열리고 저장된 확인 완료를 새 고쳤어요 뒤에 다시 보내면 409 ATTEMPT_CHANGED다', async () => {
    await change('withdraw').expect(200);
    const reopenInput = { versionId, reason: '다시 필요해요' };
    await change('reopen', reopenInput).expect(200);
    await change('withdraw').expect(200);
    const reopened = await change('reopen', reopenInput).expect(200);
    expect(reopened.body.status).toBe('OPEN');
    expect(reopened.body.comments.map((comment: { body: string }) => comment.body)).toEqual([
      '철회 사유: 필요 없어졌어요',
      '다시 연 사유: 다시 필요해요',
      '철회 사유: 필요 없어졌어요',
      '다시 연 사유: 다시 필요해요',
    ]);
    expect((await eventsForIssue()).map((event) => event.type)).toEqual([
      'ISSUE_CREATED',
      'ISSUE_WITHDRAWN',
      'ISSUE_REOPENED',
      'ISSUE_WITHDRAWN',
      'ISSUE_REOPENED',
    ]);
    const first = await submit();
    const verifyInput = input('verify', first.body.attempts[0].id);
    await change('verify', verifyInput).expect(200);
    await change('reopen', reopenInput).expect(200);
    await submit();
    const before = await readState();
    await change('verify', verifyInput).expect(409).expect(attemptChangedBody);
    expect(await readState()).toEqual(before);
  });

  it('고쳤어요를 동시에 두 번 보내면 하나만 성공하고 줄은 하나다', async () => {
    const before = await readState();
    const responses = await Promise.all([change('submit-resolution'), change('submit-resolution')]);
    expect(responses.map(({ status }) => status).sort((left, right) => left - right)).toEqual([200, 409]);
    expect(responses.find(({ status }) => status === 409)!.body).toEqual(stateChangedBody);
    const success = responses.find(({ status }) => status === 200)!;
    expect(success.body.status).toBe('READY_FOR_REVIEW');
    expect(success.body.attempts).toHaveLength(1);
    const after = await readState();
    expect(after.attempts).toHaveLength(1);
    expect(after.comments).toEqual(before.comments);
    expect(after.events).toHaveLength(before.events.length + 1);
    expect(after.events.filter((event) => event.type === 'RESOLUTION_SUBMITTED')).toEqual([
      expect.objectContaining({ issueId, projectId, actorId: developerId }),
    ]);
    await get(issueId, cookie).expect(200).expect(success.body);
  });

  it('확인 완료와 재요청을 동시에 보내면 하나만 성공하고 결과는 그 하나만 적힌다', async () => {
    const ready = await submit();
    const attemptId = ready.body.attempts[0].id;
    const before = await readState();
    const [verified, reopened] = await Promise.all([
      change('verify', input('verify', attemptId)),
      change('reopen', input('reopen', attemptId)),
    ]);
    expect([verified.status, reopened.status].sort((left, right) => left - right)).toEqual([200, 409]);
    const verificationWon = verified.status === 200;
    const success = verificationWon ? verified : reopened;
    const failure = verificationWon ? reopened : verified;
    expect(failure.body).toEqual(stateChangedBody);
    expect(success.body.status).toBe(verificationWon ? 'VERIFIED' : 'OPEN');
    const after = await readState();
    expect(after.attempts).toEqual([
      {
        ...before.attempts[0],
        result: verificationWon ? 'VERIFIED' : 'REOPENED',
        reviewedById: clientId,
        reviewedAt: expect.any(Date),
      },
    ]);
    expect(after.comments).toHaveLength(verificationWon ? 0 : 1);
    expect(after.events).toHaveLength(before.events.length + 1);
    expect(after.events.filter((event) => ['ISSUE_VERIFIED', 'ISSUE_REOPENED'].includes(event.type))).toEqual([
      expect.objectContaining({
        issueId,
        projectId,
        actorId: clientId,
        type: verificationWon ? 'ISSUE_VERIFIED' : 'ISSUE_REOPENED',
      }),
    ]);
    await get().expect(200).expect(success.body);
  });

  it('새 버전을 게시하면 확인 요청 쪽지만 수정 중으로 돌아가고 그 줄은 결과 없이 남는다', async () => {
    const ready = await submit();
    const secondIssue = await createIssue(clientCookie, { versionId });
    await submit(secondIssue.body.id, { screenId: undefined });
    await createIssue(clientCookie, { versionId, title: '접수 쪽지' });
    const inProgress = await createIssue(clientCookie, { versionId, title: '수정 중 쪽지' });
    await post(`/api/issues/${inProgress.body.id}/start`).send({ versionId }).expect(200);
    const verifiedIssue = await createIssue(clientCookie, { versionId, title: '확인 완료 쪽지' });
    const verifiedReady = await submit(verifiedIssue.body.id);
    await change(
      'verify',
      input('verify', verifiedReady.body.attempts[0].id),
      clientCookie,
      verifiedIssue.body.id,
    ).expect(200);
    const withdrawnIssue = await createIssue(clientCookie, { versionId, title: '철회 쪽지' });
    await submit(withdrawnIssue.body.id);
    await change('withdraw', input('withdraw'), clientCookie, withdrawnIssue.body.id).expect(200);
    const otherProject = await prisma.project.create({
      data: {
        name: '게시하지 않는 프로젝트',
        members: {
          create: [
            { userId: developerId, role: 'DEVELOPER' },
            { userId: clientId, role: 'CLIENT' },
          ],
        },
      },
    });
    const otherVersion = await prisma.deliveryVersion.create({
      data: { projectId: otherProject.id, number: 2, status: 'IN_REVIEW', publishedAt: new Date() },
    });
    await prisma.project.update({ where: { id: otherProject.id }, data: { currentVersionId: otherVersion.id } });
    const otherIssue = await prisma.issue.create({
      data: {
        projectId: otherProject.id,
        originVersionId: otherVersion.id,
        number: 1,
        authorId: clientId,
        requestId: randomUUID(),
        title: '다른 프로젝트의 확인 요청',
        body: '이 쪽지는 그대로예요',
        status: 'READY_FOR_REVIEW',
        attempts: { create: { versionId: otherVersion.id, summary: '다른 수정', submittedById: developerId } },
      },
    });
    const draft = await prisma.deliveryVersion.create({ data: { projectId } });
    const before = await readState();

    await post(`/api/versions/${draft.id}/publish`)
      .expect(409)
      .expect({ statusCode: 409, code: 'NO_SCREENS', message: '사진을 올린 화면이 없어요' });
    expect(await readState()).toEqual(before);
    expect(await prisma.deliveryVersion.findUniqueOrThrow({ where: { id: draft.id } })).toEqual(draft);
    expect(await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).toMatchObject({
      currentVersionId: versionId,
    });
    await prisma.versionScreen.create({ data: { versionId: draft.id, screenId, assetId } });

    const published = await post(`/api/versions/${draft.id}/publish`).expect(200);

    expect(published.body).toMatchObject({ id: draft.id, number: 3, status: 'IN_REVIEW' });
    expect(await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).toMatchObject({
      currentVersionId: draft.id,
    });
    const after = await readState();
    expect(after.issues).toEqual(
      before.issues.map((issue) => ({
        ...issue,
        status: issue.projectId === projectId && issue.status === 'READY_FOR_REVIEW' ? 'IN_PROGRESS' : issue.status,
      })),
    );
    expect(after.attempts).toEqual(before.attempts);
    expect(after.attempts.find((attempt) => attempt.id === ready.body.attempts[0].id)).toMatchObject({
      result: null,
      reviewedById: null,
      reviewedAt: null,
    });
    expect(after.comments).toEqual(before.comments);
    expect(after.events).toHaveLength(before.events.length + 1);
    expect(after.events).toEqual(expect.arrayContaining(before.events));
    expect(after.events.filter((event) => event.type === 'VERSION_PUBLISHED')).toEqual([
      expect.objectContaining({ projectId, actorId: developerId, versionId: draft.id, issueId: null }),
    ]);
    const detail = await get().expect(200);
    expect(detail.body).toMatchObject({ status: 'IN_PROGRESS', attempts: ready.body.attempts });
    await get(otherIssue.id)
      .expect(200)
      .expect((response) => expect(response.body.status).toBe('READY_FOR_REVIEW'));

    // 옛 화면의 확인 요청은 쪽지 상태보다 먼저 버전 차이로 거절한다.
    await change('verify', input('verify', ready.body.attempts[0].id))
      .expect(409)
      .expect({ statusCode: 409, code: 'VERSION_CHANGED', message: '새 버전이 올라왔어요' });
    expect(await readState()).toEqual(after);
    const resubmitted = await submit(issueId, { versionId: draft.id, summary: '3차에서도 고쳤어요' });
    expect(resubmitted.body.status).toBe('READY_FOR_REVIEW');
    expect(resubmitted.body.attempts).toHaveLength(2);
    expect(resubmitted.body.attempts[0]).toEqual(ready.body.attempts[0]);
    expect(resubmitted.body.attempts[1]).toMatchObject({
      versionId: draft.id,
      versionNumber: 3,
      summary: '3차에서도 고쳤어요',
      result: null,
      reviewedByName: null,
      reviewedAt: null,
    });
    const savedAttempts = await prisma.resolutionAttempt.findMany({
      where: { issueId },
      orderBy: { createdAt: 'asc' },
    });
    expect(savedAttempts).toHaveLength(2);
    expect(savedAttempts[0]).toEqual(before.attempts.find((attempt) => attempt.id === ready.body.attempts[0].id));
  });

  it('확인 완료와 새 버전 게시가 동시에 오면 확인 완료되거나 409이고 409면 쪽지는 수정 중이다', async () => {
    for (let round = 0; round < 6; round += 1) {
      const issue = await createIssue(clientCookie, { versionId });
      const ready = await submit(issue.body.id);
      const attemptId = ready.body.attempts[0].id;
      const draft = await post(`/api/projects/${projectId}/versions`).expect(201);
      const before = await readState();
      const publishRequest = post(`/api/versions/${draft.body.id}/publish`);
      const verifyRequest = change('verify', input('verify', attemptId), clientCookie, issue.body.id);
      // 보내는 순서를 번갈아 바꾸되, 어느 요청이 잠금을 먼저 얻는지는 가정하지 않는다.
      const responses = await Promise.all(
        round % 2 === 0 ? [publishRequest, verifyRequest] : [verifyRequest, publishRequest],
      );
      const [published, verified] = round % 2 === 0 ? responses : [responses[1], responses[0]];

      expect(published.status).toBe(200);
      expect(published.body).toMatchObject({ id: draft.body.id, number: 3 + round, status: 'IN_REVIEW' });
      expect([200, 409]).toContain(verified.status);
      const verificationWon = verified.status === 200;
      if (!verificationWon) {
        expect(verified.body).toEqual({ statusCode: 409, code: 'VERSION_CHANGED', message: '새 버전이 올라왔어요' });
      }
      const after = await readState();
      expect(after.issues).toEqual(
        before.issues.map((saved) => ({
          ...saved,
          status: saved.id === issue.body.id ? (verificationWon ? 'VERIFIED' : 'IN_PROGRESS') : saved.status,
        })),
      );
      expect(after.attempts).toEqual(
        before.attempts.map((attempt) => ({
          ...attempt,
          ...(attempt.id === attemptId && verificationWon
            ? { result: 'VERIFIED', reviewedById: clientId, reviewedAt: expect.any(Date) }
            : {}),
        })),
      );
      expect(after.comments).toEqual(before.comments);
      expect(after.events).toHaveLength(before.events.length + (verificationWon ? 2 : 1));
      expect(after.events).toEqual(expect.arrayContaining(before.events));
      expect(after.events.filter((event) => event.versionId === draft.body.id)).toEqual([
        expect.objectContaining({ type: 'VERSION_PUBLISHED', projectId, actorId: developerId, issueId: null }),
      ]);
      expect(
        after.events.filter((event) => event.issueId === issue.body.id && event.type === 'ISSUE_VERIFIED'),
      ).toHaveLength(verificationWon ? 1 : 0);
      expect(await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).toMatchObject({
        currentVersionId: draft.body.id,
      });
      const detail = await get(issue.body.id).expect(200);
      expect(detail.body.status).toBe(verificationWon ? 'VERIFIED' : 'IN_PROGRESS');
      expect(detail.body.attempts).toEqual([
        {
          ...ready.body.attempts[0],
          result: verificationWon ? 'VERIFIED' : null,
          reviewedByName: verificationWon ? '클라이언트' : null,
          reviewedAt: verificationWon ? expect.any(String) : null,
        },
      ]);
      if (verificationWon) {
        expect(verified.body).toEqual({
          ...detail.body,
          currentVersion: { id: versionId, status: 'IN_REVIEW' },
        });
      }
      versionId = draft.body.id;
    }
  });

  it('게시 일지 저장이 실패하면 확인 요청 쪽지와 고쳤어요 줄과 현재 버전이 모두 그대로다', async () => {
    const ready = await submit();
    expect(ready.body.status).toBe('READY_FOR_REVIEW');
    const draft = await post(`/api/projects/${projectId}/versions`).expect(201);
    const before = await readState();
    const versionBefore = await prisma.deliveryVersion.findUniqueOrThrow({ where: { id: draft.body.id } });
    try {
      await prisma.$executeRaw`
        CREATE FUNCTION resolution_e2e_fail_publish_event() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'resolution e2e publish activity failure'; END;
        $$
      `;
      await prisma.$executeRaw`
        CREATE TRIGGER resolution_e2e_fail_publish_event BEFORE INSERT ON activity_events
        FOR EACH ROW WHEN (NEW.type = 'VERSION_PUBLISHED')
        EXECUTE FUNCTION resolution_e2e_fail_publish_event()
      `;
      await post(`/api/versions/${draft.body.id}/publish`).expect(500);
      expect(await readState()).toEqual(before);
      expect(await prisma.deliveryVersion.findUniqueOrThrow({ where: { id: draft.body.id } })).toEqual(versionBefore);
      expect(await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).toMatchObject({
        currentVersionId: versionId,
      });
      await get(issueId, cookie).expect(200).expect(ready.body);
    } finally {
      try {
        await prisma.$executeRaw`DROP TRIGGER IF EXISTS resolution_e2e_fail_publish_event ON activity_events`;
      } finally {
        await prisma.$executeRaw`DROP FUNCTION IF EXISTS resolution_e2e_fail_publish_event()`;
      }
    }
    await post(`/api/versions/${draft.body.id}/publish`).expect(200);
    const detail = await get().expect(200);
    expect(detail.body).toMatchObject({ status: 'IN_PROGRESS', attempts: ready.body.attempts });
    expect(await prisma.resolutionAttempt.findMany({ orderBy: { id: 'asc' } })).toEqual(before.attempts);
    expect(await prisma.activityEvent.count()).toBe(before.events.length + 1);
  });

  it('보고 있던 버전이 현재 버전이 아니거나 승인됐으면 네 요청 모두 409이고 아무것도 바뀌지 않는다', async () => {
    const ready = await submit();
    const attemptId = ready.body.attempts[0].id;
    const before = await readState();
    for (const action of actions) {
      await change(action, { ...input(action, attemptId), versionId: oldVersionId })
        .expect(409)
        .expect({ statusCode: 409, message: '새 버전이 올라왔어요', code: 'VERSION_CHANGED' });
      expect(await readState()).toEqual(before);
    }
    await prisma.deliveryVersion.update({ where: { id: versionId }, data: { status: 'APPROVED' } });
    for (const action of actions) {
      await change(action, input(action, attemptId))
        .expect(409)
        .expect({ statusCode: 409, message: '검수 중인 버전이 아니에요', code: 'VERSION_NOT_IN_REVIEW' });
      expect(await readState()).toEqual(before);
    }
    expect((await prisma.deliveryVersion.findUniqueOrThrow({ where: { id: versionId } })).status).toBe('APPROVED');
  });

  it('현재 버전에 없는 화면으로 고쳤어요를 보내면 404이고 핀이 있는 쪽지에 화면 없이 보내면 422다', async () => {
    const oldScreen = await prisma.screen.create({ data: { projectId, name: '옛 화면', viewport: 'PC' } });
    await prisma.versionScreen.create({ data: { versionId: oldVersionId, screenId: oldScreen.id, assetId } });
    const foreignProject = await prisma.project.create({ data: { name: '남의 프로젝트' } });
    const foreignVersion = await prisma.deliveryVersion.create({ data: { projectId: foreignProject.id } });
    const foreignScreen = await prisma.screen.create({
      data: { projectId: foreignProject.id, name: '첫 화면', viewport: 'PC' },
    });
    const foreignAsset = await prisma.asset.create({
      data: {
        projectId: foreignProject.id,
        storageKey: `${foreignProject.id}/screen.png`,
        mime: 'image/png',
        bytes: 100,
        width: 10,
        height: 10,
      },
    });
    await prisma.versionScreen.create({
      data: { versionId: foreignVersion.id, screenId: foreignScreen.id, assetId: foreignAsset.id },
    });
    const pinned = await createIssue(clientCookie, { versionId, screenId, xRatio: 0.25, yRatio: 0.75 });
    const before = await readState();
    for (const invalidScreenId of [oldScreen.id, foreignScreen.id, missingId, versionScreenId]) {
      await change('submit-resolution', { ...input('submit-resolution'), screenId: invalidScreenId })
        .expect(404)
        .expect({ statusCode: 404, message: '없는 화면이에요', error: 'Not Found' });
      expect(await readState()).toEqual(before);
    }
    await change('submit-resolution', { versionId, summary: '고쳤어요' }, cookie, pinned.body.id).expect(422);
    expect(await readState()).toEqual(before);
    const accepted = await submit(pinned.body.id);
    expect(accepted.body).toMatchObject({ status: 'READY_FOR_REVIEW' });
    expect(accepted.body.attempts[0].screen.screenId).toBe(screenId);
  });

  it('위치 없는 쪽지는 화면 없이도 화면과 함께도 고쳤어요를 보낸다', async () => {
    const noScreen = await change('submit-resolution', { versionId, summary: '기능을 고쳤어요' }).expect(200);
    expect(noScreen.body).toMatchObject({ status: 'READY_FOR_REVIEW', origin: null });
    expect(noScreen.body.attempts[0].screen).toBeNull();
    expect(
      await prisma.resolutionAttempt.findUniqueOrThrow({ where: { id: noScreen.body.attempts[0].id } }),
    ).toMatchObject({ versionId, versionScreenId: null, submittedById: developerId });
    const other = await createIssue(clientCookie, { versionId });
    await post(`/api/issues/${other.body.id}/start`).send({ versionId }).expect(200);
    const withScreen = await submit(other.body.id);
    expect(withScreen.body).toMatchObject({ status: 'READY_FOR_REVIEW', origin: null });
    expect(withScreen.body.attempts[0].screen).toEqual({
      screenId,
      screenName: '첫 화면',
      viewport: 'PC',
      asset: { id: assetId, width: 32, height: 24 },
    });
    expect(
      await prisma.resolutionAttempt.findUniqueOrThrow({ where: { id: withScreen.body.attempts[0].id } }),
    ).toMatchObject({ versionId, versionScreenId, submittedById: developerId });
  });

  it('사유 댓글이나 일지 저장이 실패하면 상태와 줄도 바뀌지 않는다', async () => {
    const ready = await submit();
    const attemptId = ready.body.attempts[0].id;
    const openIssue = await createIssue(clientCookie, { versionId });
    const closedIssue = await createIssue(clientCookie, { versionId });
    await change('withdraw', input('withdraw'), clientCookie, closedIssue.body.id).expect(200);
    const commentRequests: [Action, string, Record<string, unknown>][] = [
      ['reopen', issueId, input('reopen', attemptId)],
      ['withdraw', issueId, input('withdraw')],
      ['reopen', closedIssue.body.id, { versionId, reason: '다시 열어요' }],
    ];
    const before = await readState();
    try {
      await prisma.$executeRaw`
        CREATE FUNCTION resolution_e2e_fail_comment() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'resolution e2e comment failure'; END;
        $$
      `;
      await prisma.$executeRaw`
        CREATE TRIGGER resolution_e2e_fail_comment BEFORE INSERT ON comments
        FOR EACH ROW EXECUTE FUNCTION resolution_e2e_fail_comment()
      `;
      for (const [action, targetIssueId, body] of commentRequests) {
        await change(action, body, clientCookie, targetIssueId).expect(500);
        expect(await readState()).toEqual(before);
      }
    } finally {
      try {
        await prisma.$executeRaw`DROP TRIGGER IF EXISTS resolution_e2e_fail_comment ON comments`;
      } finally {
        await prisma.$executeRaw`DROP FUNCTION IF EXISTS resolution_e2e_fail_comment()`;
      }
    }
    const eventRequests: [Action, string, Record<string, unknown>][] = [
      ['submit-resolution', openIssue.body.id, input('submit-resolution')],
      ['verify', issueId, input('verify', attemptId)],
      ...commentRequests,
    ];
    try {
      await prisma.$executeRaw`
        CREATE FUNCTION resolution_e2e_fail_event() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'resolution e2e activity failure'; END;
        $$
      `;
      await prisma.$executeRaw`
        CREATE TRIGGER resolution_e2e_fail_event BEFORE INSERT ON activity_events
        FOR EACH ROW EXECUTE FUNCTION resolution_e2e_fail_event()
      `;
      for (const [action, targetIssueId, body] of eventRequests) {
        await change(action, body, action === 'submit-resolution' ? cookie : clientCookie, targetIssueId).expect(500);
        expect(await readState()).toEqual(before);
      }
    } finally {
      try {
        await prisma.$executeRaw`DROP TRIGGER IF EXISTS resolution_e2e_fail_event ON activity_events`;
      } finally {
        await prisma.$executeRaw`DROP FUNCTION IF EXISTS resolution_e2e_fail_event()`;
      }
    }
    // 트리거를 걷은 뒤 같은 요청이 성공해야 실패 원인이 입력이나 상태가 아니었음을 알 수 있다.
    await change('reopen', input('reopen', attemptId)).expect(200);
    await change('withdraw').expect(200);
    await change('reopen', { versionId, reason: '다시 열어요' }, clientCookie, closedIssue.body.id).expect(200);
    const retried = await submit(openIssue.body.id);
    await change('verify', input('verify', retried.body.attempts[0].id), clientCookie, openIssue.body.id).expect(200);
  });

  it('재요청·철회·다시 열기의 사유가 종류가 붙은 댓글로 그 사람 이름과 현재 버전으로 남는다', async () => {
    const ready = await submit();
    await change('reopen', { versionId, attemptId: ready.body.attempts[0].id, reason: '  아직 작아요  ' }).expect(200);
    await change('withdraw', { versionId, reason: '  필요 없어졌어요  ' }, approverCookie).expect(200);
    const reopened = await change('reopen', { versionId, reason: '  다시 필요해요  ' }).expect(200);
    expect(reopened.body.comments).toEqual([
      {
        id: expect.any(String),
        authorName: '클라이언트',
        versionNumber: 2,
        body: '재요청 사유: 아직 작아요',
        createdAt: expect.any(String),
      },
      {
        id: expect.any(String),
        authorName: '승인자',
        versionNumber: 2,
        body: '철회 사유: 필요 없어졌어요',
        createdAt: expect.any(String),
      },
      {
        id: expect.any(String),
        authorName: '클라이언트',
        versionNumber: 2,
        body: '다시 연 사유: 다시 필요해요',
        createdAt: expect.any(String),
      },
    ]);
    const comments = await prisma.comment.findMany({ orderBy: { createdAt: 'asc' } });
    expect(comments).toEqual(
      reopened.body.comments.map((comment: { id: string; body: string; createdAt: string }, index: number) => ({
        id: comment.id,
        issueId,
        authorId: index === 1 ? approverId : clientId,
        versionId,
        body: comment.body,
        requestId: null,
        createdAt: new Date(comment.createdAt),
      })),
    );
    expect(
      (await eventsForIssue()).map(({ type, actorId, projectId: eventProjectId, issueId: eventIssueId }) => ({
        type,
        actorId,
        projectId: eventProjectId,
        issueId: eventIssueId,
      })),
    ).toEqual([
      { type: 'ISSUE_CREATED', actorId: clientId, projectId, issueId },
      { type: 'RESOLUTION_SUBMITTED', actorId: developerId, projectId, issueId },
      { type: 'ISSUE_REOPENED', actorId: clientId, projectId, issueId },
      { type: 'ISSUE_WITHDRAWN', actorId: approverId, projectId, issueId },
      { type: 'ISSUE_REOPENED', actorId: clientId, projectId, issueId },
    ]);
    await get().expect(200).expect(reopened.body);
  });

  it('고쳤어요 없이 철회한 쪽지도 다시 열 수 있다', async () => {
    const withdrawn = await change('withdraw').expect(200);
    expect(withdrawn.body).toMatchObject({ status: 'WITHDRAWN', attempts: [] });
    const reopened = await change('reopen', { versionId, reason: '다시 필요해요' }).expect(200);
    expect(reopened.body).toMatchObject({ status: 'OPEN', attempts: [], commentCount: 2 });
    expect(await prisma.resolutionAttempt.count()).toBe(0);
    expect((await prisma.issue.findUniqueOrThrow({ where: { id: issueId } })).status).toBe('OPEN');
    await get().expect(200).expect(reopened.body);
  });

  it('멤버가 아니거나 접근이 철회된 사람과 없는 쪽지는 네 요청 모두 404다', async () => {
    const ready = await submit();
    const outsider = await prisma.user.create({ data: { email: 'outsider@example.com', name: '외부인' } });
    const outsiderCookie = await login(outsider.id);
    await prisma.projectMember.update({ where: { id: approverMemberId }, data: { revokedAt: new Date() } });
    const before = await readState();
    for (const action of actions) {
      const body = input(action, ready.body.attempts[0].id);
      await change(action, body, outsiderCookie).expect(404).expect(issueNotFoundBody);
      await change(action, body, approverCookie).expect(404).expect(issueNotFoundBody);
      await change(action, body, undefined, missingId).expect(404).expect(issueNotFoundBody);
      await change(action, body, undefined, 'not-a-uuid').expect(404).expect(issueNotFoundBody);
      expect(await readState()).toEqual(before);
    }
    await get(issueId, approverCookie).expect(404).expect(issueNotFoundBody);
  });

  it('로그인하지 않으면 401이고 다른 Origin에서 오면 403이다', async () => {
    const ready = await submit();
    const before = await readState();
    for (const action of actions) {
      const path = `/api/issues/${issueId}/${action}`;
      const body = input(action, ready.body.attempts[0].id);
      const memberCookie = action === 'submit-resolution' ? cookie : clientCookie;
      await request(server).post(path).set('Origin', origin).send(body).expect(401);
      await request(server)
        .post(path)
        .set('Origin', 'http://localhost:5173.evil.com')
        .set('Cookie', memberCookie)
        .send(body)
        .expect(403);
      await request(server).post(path).set('Cookie', memberCookie).send(body).expect(403);
      expect(await readState()).toEqual(before);
    }
  });

  it('틀린 입력 (각 경우)는 422이고 아무것도 바뀌지 않는다', async () => {
    const ready = await submit();
    const before = await readState();
    for (const action of actions) {
      const valid = input(action, ready.body.attempts[0].id);
      const invalid: [string, Record<string, unknown>][] = [];
      const requiredFields =
        action === 'submit-resolution'
          ? ['versionId', 'summary']
          : action === 'verify'
            ? ['versionId', 'attemptId']
            : ['versionId', 'reason'];
      for (const field of requiredFields) {
        const body = { ...valid };
        delete body[field];
        invalid.push([`${field} 빠짐`, body]);
      }
      const uuidFields =
        action === 'submit-resolution'
          ? ['versionId', 'screenId']
          : action === 'withdraw'
            ? ['versionId']
            : ['versionId', 'attemptId'];
      const invalidUuidValues: unknown[] = ['not-a-uuid', '', null, 123, false, [], { id: versionId }];
      invalid.push(
        ...uuidFields.flatMap((field) =>
          invalidUuidValues.map((value): [string, Record<string, unknown>] => [
            `${field}=${JSON.stringify(value)}`,
            { ...valid, [field]: value },
          ]),
        ),
      );
      const textField = action === 'submit-resolution' ? 'summary' : 'reason';
      const invalidTexts: [string, unknown][] = [
        ['빈 글자', ''],
        ['공백만', ' \t\n '],
        ['2001자', '가'.repeat(2001)],
        ['숫자', 123],
        ['null', null],
        ['불리언', false],
        ['배열', ['글']],
        ['객체', { text: '글' }],
      ];
      if (action !== 'verify')
        invalid.push(
          ...invalidTexts.map(([name, value]): [string, Record<string, unknown>] => [
            `${textField} ${name}`,
            { ...valid, [textField]: value },
          ]),
        );
      invalid.push(
        ...['status', 'result', 'reviewedById', 'requestId'].map((field): [string, Record<string, unknown>] => [
          `모르는 ${field}`,
          { ...valid, [field]: 'VERIFIED' },
        ]),
      );
      for (const [name, body] of invalid) {
        const response = await change(action, body);
        expect(response.status, `${action}: ${name}`).toBe(422);
        expect(response.body.statusCode).toBe(422);
        expect(await readState(), `${action}: ${name}`).toEqual(before);
      }
    }
  }, 30_000);

  it('설명과 사유는 앞뒤 공백을 지운 1자와 2000자가 저장되고 네 주소는 쪽지 상세를 200으로 돌려준다', async () => {
    for (const length of [1, 2000]) {
      const text = '가'.repeat(length);
      const padded = ` \t${text}\n `;
      const issue = await createIssue(clientCookie, { versionId });
      const ready = await submit(issue.body.id, { summary: padded });
      expect(ready.body.attempts[0].summary).toBe(text);
      expect(
        await prisma.resolutionAttempt.findUniqueOrThrow({ where: { id: ready.body.attempts[0].id } }),
      ).toMatchObject({ summary: text });
      await get(issue.body.id, cookie).expect(200).expect(ready.body);
      const rejected = await change(
        'reopen',
        { versionId, attemptId: ready.body.attempts[0].id, reason: padded },
        clientCookie,
        issue.body.id,
      ).expect(200);
      expect(rejected.body.comments[0].body).toBe(`재요청 사유: ${text}`);
      await get(issue.body.id).expect(200).expect(rejected.body);
      const second = await submit(issue.body.id);
      const verified = await change(
        'verify',
        input('verify', second.body.attempts[1].id),
        clientCookie,
        issue.body.id,
      ).expect(200);
      expect(verified.body.status).toBe('VERIFIED');
      await get(issue.body.id).expect(200).expect(verified.body);
      const reopened = await change('reopen', { versionId, reason: padded }, clientCookie, issue.body.id).expect(200);
      expect(reopened.body.comments[1].body).toBe(`다시 연 사유: ${text}`);
      const withdrawn = await change('withdraw', { versionId, reason: padded }, clientCookie, issue.body.id).expect(
        200,
      );
      expect(withdrawn.body.comments[2].body).toBe(`철회 사유: ${text}`);
      expect(
        await prisma.comment.findMany({ where: { issueId: issue.body.id }, orderBy: { createdAt: 'asc' } }),
      ).toEqual([
        expect.objectContaining({ body: `재요청 사유: ${text}` }),
        expect.objectContaining({ body: `다시 연 사유: ${text}` }),
        expect.objectContaining({ body: `철회 사유: ${text}` }),
      ]);
      await get(issue.body.id).expect(200).expect(withdrawn.body);
    }
  });

  it('쪽지 상세에 고쳤어요 이력이 오래된 순으로 오고 canReview는 쓴 클라이언트와 승인자에게만 참이다', async () => {
    const first = await submit();
    const rejected = await change('reopen', input('reopen', first.body.attempts[0].id)).expect(200);
    const second = await change('submit-resolution', { versionId, summary: '두 번째 수정' }).expect(200);
    const withdrawn = await change('withdraw').expect(200);
    expect(withdrawn.body.attempts).toEqual([
      {
        id: first.body.attempts[0].id,
        versionId,
        versionNumber: 2,
        screen: { screenId, screenName: '첫 화면', viewport: 'PC', asset: { id: assetId, width: 32, height: 24 } },
        summary: '버튼을 고쳤어요',
        submittedByName: '개발자',
        createdAt: first.body.attempts[0].createdAt,
        result: 'REOPENED',
        reviewedByName: '클라이언트',
        reviewedAt: rejected.body.attempts[0].reviewedAt,
      },
      {
        id: second.body.attempts[1].id,
        versionId,
        versionNumber: 2,
        screen: null,
        summary: '두 번째 수정',
        submittedByName: '개발자',
        createdAt: second.body.attempts[1].createdAt,
        result: null,
        reviewedByName: null,
        reviewedAt: null,
      },
    ]);
    expect(Date.parse(first.body.attempts[0].createdAt)).toBeLessThanOrEqual(
      Date.parse(second.body.attempts[1].createdAt),
    );
    expect(Date.parse(rejected.body.attempts[0].reviewedAt)).toBeGreaterThanOrEqual(
      Date.parse(first.body.attempts[0].createdAt),
    );
    const unrelated = await createIssue(clientCookie, { versionId });
    await submit(unrelated.body.id, { summary: '다른 쪽지 이력' });
    const foreignProject = await prisma.project.create({ data: { name: '남의 프로젝트' } });
    const foreignVersion = await prisma.deliveryVersion.create({ data: { projectId: foreignProject.id } });
    const foreignIssue = await prisma.issue.create({
      data: {
        projectId: foreignProject.id,
        originVersionId: foreignVersion.id,
        number: 1,
        authorId: developerId,
        requestId: randomUUID(),
        title: '남의 쪽지',
        body: '',
      },
    });
    const foreignScreen = await prisma.screen.create({
      data: { projectId: foreignProject.id, name: '남의 화면', viewport: 'MOBILE' },
    });
    const foreignAsset = await prisma.asset.create({
      data: {
        projectId: foreignProject.id,
        storageKey: `${foreignProject.id}/screen.png`,
        mime: 'image/png',
        bytes: 100,
        width: 16,
        height: 32,
      },
    });
    const foreignVersionScreen = await prisma.versionScreen.create({
      data: { versionId: foreignVersion.id, screenId: foreignScreen.id, assetId: foreignAsset.id },
    });
    await prisma.resolutionAttempt.create({
      data: {
        issueId: foreignIssue.id,
        versionId: foreignVersion.id,
        versionScreenId: foreignVersionScreen.id,
        summary: '남의 이력',
        submittedById: developerId,
      },
    });
    for (const [memberCookie, canReview, isMine] of [
      [clientCookie, true, true],
      [approverCookie, true, false],
      [cookie, false, false],
      [otherCookie, false, false],
    ] as const) {
      const detail = await get(issueId, memberCookie).expect(200);
      expect(detail.body).toEqual({ ...withdrawn.body, canReview, isMine });
    }
    // 승인자 지정이 없어져도 쓴 클라이언트의 권한은 남고, 옛 승인자의 권한은 사라진다.
    await prisma.project.update({ where: { id: projectId }, data: { approverMemberId: null } });
    await get()
      .expect(200)
      .expect((response) => expect(response.body.canReview).toBe(true));
    await get(issueId, approverCookie)
      .expect(200)
      .expect((response) => expect(response.body.canReview).toBe(false));
  });

  it('고쳤어요가 있는 프로젝트를 DB에서 지우면 줄도 함께 지워진다', async () => {
    const ready = await submit();
    await change('reopen', input('reopen', ready.body.attempts[0].id)).expect(200);
    await submit();
    const saved = await prisma.resolutionAttempt.findMany({ where: { issueId } });
    expect(saved).toHaveLength(2);
    expect(saved[1].versionId).not.toBe(oldVersionId);
    await prisma.project.delete({ where: { id: projectId } });
    expect(await prisma.resolutionAttempt.count({ where: { id: { in: saved.map(({ id }) => id) } } })).toBe(0);
    expect(await prisma.issue.count({ where: { projectId } })).toBe(0);
    expect(await prisma.comment.count({ where: { issueId } })).toBe(0);
    expect(await prisma.activityEvent.count({ where: { projectId } })).toBe(0);
    expect(await prisma.deliveryVersion.count({ where: { projectId } })).toBe(0);
    await get().expect(404).expect(issueNotFoundBody);
  });

  it('확인 완료된 쪽지는 수정 시작이 409이고 댓글과 범위 변경은 된다', async () => {
    const ready = await submit();
    await change('verify', input('verify', ready.body.attempts[0].id)).expect(200);
    const before = await readState();
    await post(`/api/issues/${issueId}/start`).send({ versionId }).expect(409);
    expect(await readState()).toEqual(before);
    await post(`/api/issues/${issueId}/comments`, clientCookie)
      .send({ requestId: randomUUID(), versionId, body: '확인 뒤 남기는 댓글' })
      .expect(201);
    const changed = await request(server)
      .patch(`/api/issues/${issueId}`)
      .set('Origin', origin)
      .set('Cookie', cookie)
      .send({ versionId, category: 'OTHER', scope: 'OUT_OF_SCOPE', dueDate: '2026-12-31' })
      .expect(200);
    expect(changed.body).toMatchObject({
      status: 'VERIFIED',
      category: 'OTHER',
      scope: 'OUT_OF_SCOPE',
      dueDate: '2026-12-31',
      commentCount: 3,
    });
    expect(await prisma.resolutionAttempt.findMany({ orderBy: { id: 'asc' } })).toEqual(before.attempts);
    await get(issueId, cookie).expect(200).expect(changed.body);
  });

  it('수정 중인 쪽지는 철회할 수 있고 확인 요청에서 철회해도 고쳤어요 결과는 비어 있다', async () => {
    await post(`/api/issues/${issueId}/start`).send({ versionId }).expect(200);
    const withdrawn = await change('withdraw').expect(200);
    expect(withdrawn.body).toMatchObject({ status: 'WITHDRAWN', attempts: [] });
    await change('reopen', { versionId, reason: '다시 고쳐 주세요' }).expect(200);
    const ready = await submit();
    const attempts = await prisma.resolutionAttempt.findMany({ orderBy: { id: 'asc' } });
    const finished = await change('withdraw').expect(200);
    expect(finished.body).toMatchObject({ status: 'WITHDRAWN', attempts: ready.body.attempts });
    expect(finished.body.attempts[0]).toMatchObject({ result: null, reviewedByName: null, reviewedAt: null });
    expect(await prisma.resolutionAttempt.findMany({ orderBy: { id: 'asc' } })).toEqual(attempts);
  });

  it('확인 요청이어도 고쳤어요가 없거나 가장 최근 줄에 이미 결과가 있으면 409 ATTEMPT_CHANGED다', async () => {
    await prisma.issue.update({ where: { id: issueId }, data: { status: 'READY_FOR_REVIEW' } });
    const empty = await readState();
    await change('verify').expect(409).expect(attemptChangedBody);
    await change('reopen').expect(409).expect(attemptChangedBody);
    expect(await readState()).toEqual(empty);
    await prisma.issue.update({ where: { id: issueId }, data: { status: 'OPEN' } });
    const ready = await submit();
    const attemptId = ready.body.attempts[0].id;
    await change('verify', input('verify', attemptId)).expect(200);
    // 결과 없는 최신 줄 검사 자체가 사라져도 실패하도록 상태와 결과가 어긋난 데이터를 준비한다.
    await prisma.issue.update({ where: { id: issueId }, data: { status: 'READY_FOR_REVIEW' } });
    const answered = await readState();
    await change('verify', input('verify', attemptId)).expect(409).expect(attemptChangedBody);
    await change('reopen', input('reopen', attemptId)).expect(409).expect(attemptChangedBody);
    expect(await readState()).toEqual(answered);
  });
});
