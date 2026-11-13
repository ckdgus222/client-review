import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import sharp from 'sharp';
import { AppModule } from '../src/app.module.js';
import { createSessionToken, hashSessionToken } from '../src/auth/token.js';
import { MailService } from '../src/mail/mail.service.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { setupApp } from '../src/setup-app.js';
import { resetDatabase } from './reset-database.js';

const origin = 'http://localhost:5173';
const missingId = '00000000-0000-4000-8000-000000000001';

describe('승인 API (e2e)', () => {
  let app: INestApplication | undefined;
  let server: Server;
  let prisma: PrismaService;
  let projectId: string;
  let developerCookie: string;
  let developerId: string;
  let firstClient: { id: string; name: string; memberId: string; cookie: string };
  let secondClient: { id: string; name: string; memberId: string; cookie: string };
  let directory: string;
  let versionId: string;
  let screenId: string;
  let versionScreenId: string;

  const post = (path: string, cookie = firstClient.cookie) =>
    request(server).post(path).set('Origin', origin).set('Cookie', cookie);
  const check = (cookie = firstClient.cookie, targetVersionId = versionId) =>
    request(server).get(`/api/versions/${targetVersionId}/approval-check`).set('Cookie', cookie);
  const approve = (seenAt: string, cookie = firstClient.cookie, targetVersionId = versionId) =>
    post(`/api/versions/${targetVersionId}/approve`, cookie).send({ seenAt });
  const updateIssue = (issueId: string, changes: Record<string, unknown>) =>
    request(server)
      .patch(`/api/issues/${issueId}`)
      .set('Origin', origin)
      .set('Cookie', developerCookie)
      .send({ versionId, ...changes });
  const issueInput = () => ({ requestId: randomUUID(), versionId, title: '버튼 수정', body: '크기를 고쳐 주세요' });
  const comment = (issueId: string, cookie = developerCookie, body = '검토해 주세요') =>
    post(`/api/issues/${issueId}/comments`, cookie).send({ requestId: randomUUID(), versionId, body });
  const createIssue = async (changes: Partial<Prisma.IssueUncheckedCreateInput> = {}) => {
    const { _max } = await prisma.issue.aggregate({ where: { projectId }, _max: { number: true } });
    return prisma.issue.create({
      data: {
        projectId,
        originVersionId: versionId,
        authorId: firstClient.id,
        number: (_max.number ?? 0) + 1,
        requestId: randomUUID(),
        title: '버튼 수정',
        body: '크기를 고쳐 주세요',
        ...changes,
      },
    });
  };
  const prepareVersion = async () => {
    const version = await prisma.deliveryVersion.create({
      data: { projectId, number: 1, status: 'IN_REVIEW', publishedAt: new Date('2026-01-01T00:00:00Z') },
    });
    versionId = version.id;
    await prisma.project.update({
      where: { id: projectId },
      data: {
        currentVersionId: versionId,
        approverMemberId: firstClient.memberId,
      },
    });
    const screen = await prisma.screen.create({ data: { projectId, name: '첫 화면', viewport: 'PC' } });
    screenId = screen.id;
    const asset = await prisma.asset.create({
      data: {
        projectId,
        storageKey: `${projectId}/screen.png`,
        mime: 'image/png',
        bytes: 100,
        width: 32,
        height: 24,
      },
    });
    const versionScreen = await prisma.versionScreen.create({ data: { versionId, screenId, assetId: asset.id } });
    versionScreenId = versionScreen.id;
  };
  const readState = async () => ({
    projects: await prisma.project.findMany({ orderBy: { id: 'asc' } }),
    versions: await prisma.deliveryVersion.findMany({ orderBy: { id: 'asc' } }),
    approvals: await prisma.approval.findMany({ orderBy: { id: 'asc' } }),
    issues: await prisma.issue.findMany({ orderBy: { id: 'asc' } }),
    comments: await prisma.comment.findMany({ orderBy: { id: 'asc' } }),
    attempts: await prisma.resolutionAttempt.findMany({ orderBy: { id: 'asc' } }),
    attachments: await prisma.issueAttachment.findMany({ orderBy: { id: 'asc' } }),
    assets: await prisma.asset.findMany({ orderBy: { id: 'asc' } }),
    events: await prisma.activityEvent.findMany({ orderBy: { id: 'asc' } }),
  });

  const login = async (userId: string) => {
    const token = createSessionToken();
    await prisma.session.create({
      data: { userId, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
    });
    return `sid=${token}`;
  };

  const getProject = (cookie: string, targetProjectId = projectId) =>
    request(server).get(`/api/projects/${targetProjectId}`).set('Cookie', cookie);

  const setApprover = (memberId: string | null, targetProjectId = projectId) =>
    request(server)
      .post(`/api/projects/${targetProjectId}/approver`)
      .set('Origin', origin)
      .set('Cookie', developerCookie)
      .send({ memberId });

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'approval-e2e-'));
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
    developerId = developer.id;
    const firstUser = await prisma.user.create({ data: { email: 'first@example.com', name: '첫 클라이언트' } });
    const secondUser = await prisma.user.create({ data: { email: 'second@example.com', name: '둘째 클라이언트' } });
    const project = await prisma.project.create({
      data: { name: '승인 검수 프로젝트', members: { create: { userId: developer.id, role: 'DEVELOPER' } } },
    });
    projectId = project.id;
    const firstMember = await prisma.projectMember.create({
      data: { projectId, userId: firstUser.id, role: 'CLIENT' },
    });
    const secondMember = await prisma.projectMember.create({
      data: { projectId, userId: secondUser.id, role: 'CLIENT' },
    });
    developerCookie = await login(developer.id);
    firstClient = {
      id: firstUser.id,
      name: firstUser.name,
      memberId: firstMember.id,
      cookie: await login(firstUser.id),
    };
    secondClient = {
      id: secondUser.id,
      name: secondUser.name,
      memberId: secondMember.id,
      cookie: await login(secondUser.id),
    };
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

  it('프로젝트 상세의 isApprover는 승인자에게만 참이다', async () => {
    const developer = await prisma.projectMember.findFirstOrThrow({ where: { projectId, role: 'DEVELOPER' } });
    const otherProject = await prisma.project.create({
      data: { name: '다른 프로젝트', members: { create: { userId: developer.userId, role: 'DEVELOPER' } } },
    });
    const otherApprover = await prisma.projectMember.create({
      data: { projectId: otherProject.id, userId: secondClient.id, role: 'CLIENT' },
    });
    await setApprover(otherApprover.id, otherProject.id).expect(200);

    // 승인자가 없는 때, 지정한 뒤, 교체한 뒤, 해제한 뒤를 각각 조회한다.
    for (const approver of [null, firstClient, secondClient, null]) {
      await setApprover(approver?.memberId ?? null).expect(200);
      for (const viewer of [
        { cookie: developerCookie, role: 'DEVELOPER', memberId: developer.id },
        { ...firstClient, role: 'CLIENT' },
        { ...secondClient, role: 'CLIENT' },
      ]) {
        await getProject(viewer.cookie)
          .expect(200)
          .expect({
            id: projectId,
            name: '승인 검수 프로젝트',
            myRole: viewer.role,
            currentVersion: null,
            approver: approver ? { memberId: approver.memberId, name: approver.name } : null,
            isApprover: approver !== null && viewer.memberId === approver.memberId,
          });
      }

      const otherDetail = await getProject(secondClient.cookie, otherProject.id).expect(200);
      expect(otherDetail.body.isApprover).toBe(true);
      expect(otherDetail.body.approver).toEqual({ memberId: otherApprover.id, name: secondClient.name });
    }
  });

  it('승인자의 접근을 철회하면 프로젝트 상세는 404이고 남은 멤버의 isApprover는 거짓이다', async () => {
    await setApprover(firstClient.memberId).expect(200);
    const before = await getProject(firstClient.cookie).expect(200);
    expect(before.body.isApprover).toBe(true);

    await request(server)
      .post(`/api/members/${firstClient.memberId}/revoke`)
      .set('Origin', origin)
      .set('Cookie', developerCookie)
      .expect(204);

    await getProject(firstClient.cookie).expect(404).expect({
      statusCode: 404,
      message: '없는 프로젝트예요',
      error: 'Not Found',
    });
    for (const cookie of [developerCookie, secondClient.cookie]) {
      const detail = await getProject(cookie).expect(200);
      expect(detail.body.approver).toBeNull();
      expect(detail.body.isApprover).toBe(false);
    }
  });

  it('쪽지 상세의 currentVersion은 프로젝트의 현재 버전과 그 상태다', async () => {
    await prepareVersion();
    const originalVersionId = versionId;
    const created = await post(`/api/projects/${projectId}/issues`).send(issueInput()).expect(201);
    expect(created.body.currentVersion).toEqual({ id: originalVersionId, status: 'IN_REVIEW' });

    // 같은 멤버가 참여한 다른 프로젝트도 현재 버전과 쪽지를 가진다.
    const otherProject = await prisma.project.create({
      data: {
        name: '별도 검수 프로젝트',
        members: {
          create: [
            { userId: developerId, role: 'DEVELOPER' },
            { userId: firstClient.id, role: 'CLIENT' },
          ],
        },
      },
    });
    const otherVersion = await prisma.deliveryVersion.create({
      data: { projectId: otherProject.id, number: 0, status: 'IN_REVIEW', publishedAt: new Date() },
    });
    await prisma.project.update({ where: { id: otherProject.id }, data: { currentVersionId: otherVersion.id } });
    const otherIssue = await post(`/api/projects/${otherProject.id}/issues`)
      .send({ ...issueInput(), versionId: otherVersion.id })
      .expect(201);
    expect(otherIssue.body.currentVersion).toEqual({ id: otherVersion.id, status: 'IN_REVIEW' });

    const draft = await post(`/api/projects/${projectId}/versions`, developerCookie).expect(201);
    expect(draft.body.id).not.toBe(originalVersionId);
    for (const cookie of [firstClient.cookie, secondClient.cookie, developerCookie]) {
      const detail = await request(server).get(`/api/issues/${created.body.id}`).set('Cookie', cookie).expect(200);
      expect(detail.body.currentVersion).toEqual({ id: originalVersionId, status: 'IN_REVIEW' });
    }
    await post(`/api/versions/${draft.body.id}/publish`, developerCookie).expect(200);
    versionId = draft.body.id;
    const nextDraft = await post(`/api/projects/${projectId}/versions`, developerCookie).expect(201);
    const currentVersion = { id: versionId, status: 'IN_REVIEW' };
    for (const cookie of [firstClient.cookie, secondClient.cookie, developerCookie]) {
      const detail = await request(server).get(`/api/issues/${created.body.id}`).set('Cookie', cookie).expect(200);
      expect(detail.body.currentVersion).toEqual(currentVersion);
      expect(detail.body.originVersion).toEqual({ id: originalVersionId, number: 1 });
    }

    for (const changes of [{ category: 'DESIGN' }, { scope: 'OUT_OF_SCOPE' }, { dueDate: '2027-01-01' }]) {
      const updated = await updateIssue(created.body.id, changes).expect(200);
      expect(updated.body.currentVersion).toEqual(currentVersion);
    }
    const photo = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#ffffff' } })
      .png()
      .toBuffer();
    const attached = await post(`/api/issues/${created.body.id}/attachments`)
      .attach('file', photo, 'reference.png')
      .expect(201);
    expect(attached.body.currentVersion).toEqual(currentVersion);
    const removed = await request(server)
      .delete(`/api/issues/${created.body.id}/attachments/${attached.body.attachments[0].id}`)
      .set('Origin', origin)
      .set('Cookie', firstClient.cookie)
      .expect(200);
    expect(removed.body.currentVersion).toEqual(currentVersion);
    const started = await post(`/api/issues/${created.body.id}/start`, developerCookie).send({ versionId }).expect(200);
    expect(started.body.currentVersion).toEqual(currentVersion);

    const ready = await post(`/api/issues/${created.body.id}/submit-resolution`, developerCookie)
      .send({ versionId, summary: '크기를 고쳤어요', screenId })
      .expect(200);
    expect(ready.body.currentVersion).toEqual(currentVersion);
    const reopened = await post(`/api/issues/${created.body.id}/reopen`)
      .send({ versionId, attemptId: ready.body.attempts[0].id, reason: '조금 더 크게 해 주세요' })
      .expect(200);
    expect(reopened.body.currentVersion).toEqual(currentVersion);
    const readyAgain = await post(`/api/issues/${created.body.id}/submit-resolution`, developerCookie)
      .send({ versionId, summary: '다시 고쳤어요', screenId })
      .expect(200);
    expect(readyAgain.body.currentVersion).toEqual(currentVersion);
    const verified = await post(`/api/issues/${created.body.id}/verify`)
      .send({ versionId, attemptId: readyAgain.body.attempts.at(-1).id })
      .expect(200);
    expect(verified.body.currentVersion).toEqual(currentVersion);
    const openAgain = await post(`/api/issues/${created.body.id}/reopen`)
      .send({ versionId, reason: '다시 살펴봐 주세요' })
      .expect(200);
    expect(openAgain.body.currentVersion).toEqual(currentVersion);
    const withdrawn = await post(`/api/issues/${created.body.id}/withdraw`)
      .send({ versionId, reason: '추가 요청을 취소해요' })
      .expect(200);
    expect(withdrawn.body.currentVersion).toEqual(currentVersion);

    // 범위 밖 확인 요청은 남긴 채 승인할 수 있다. 비교 화면이 이 상태를 읽는다.
    await post(`/api/issues/${created.body.id}/reopen`).send({ versionId, reason: '추가 요청으로 남겨요' }).expect(200);
    await post(`/api/issues/${created.body.id}/submit-resolution`, developerCookie)
      .send({ versionId, summary: '다음 차수에서 확인해 주세요', screenId })
      .expect(200);
    const review = await check().expect(200);
    await approve(review.body.serverTime).expect(200);
    for (const cookie of [firstClient.cookie, secondClient.cookie, developerCookie]) {
      const detail = await request(server).get(`/api/issues/${created.body.id}`).set('Cookie', cookie).expect(200);
      expect(detail.body.currentVersion).toEqual({ id: versionId, status: 'APPROVED' });
      expect(detail.body.status).toBe('READY_FOR_REVIEW');
      expect(detail.body.originVersion).toEqual({ id: originalVersionId, number: 1 });
    }
    for (const cookie of [firstClient.cookie, developerCookie]) {
      const detail = await request(server).get(`/api/issues/${otherIssue.body.id}`).set('Cookie', cookie).expect(200);
      expect(detail.body.currentVersion).toEqual({ id: otherVersion.id, status: 'IN_REVIEW' });
    }
    await post(`/api/versions/${nextDraft.body.id}/publish`, developerCookie).expect(200);
    const latest = await request(server)
      .get(`/api/issues/${created.body.id}`)
      .set('Cookie', firstClient.cookie)
      .expect(200);
    expect(latest.body.currentVersion).toEqual({ id: nextDraft.body.id, status: 'IN_REVIEW' });
  });

  it('개발자와 승인자가 아닌 클라이언트가 승인하거나 승인 검토를 조회하면 403이고 아무것도 바뀌지 않는다', async () => {
    await prepareVersion();
    const review = await check().expect(200);
    const before = await readState();
    for (const cookie of [developerCookie, secondClient.cookie]) {
      await check(cookie).expect(403);
      await approve(review.body.serverTime, cookie).expect(403);
      expect(await readState()).toEqual(before);
    }
  });

  it('승인자가 바뀌면 이전 승인자는 403이고 접근이 철회된 승인자는 404다', async () => {
    await prepareVersion();
    const review = await check().expect(200);
    await setApprover(secondClient.memberId).expect(200);
    const changed = await readState();
    await check().expect(403);
    await approve(review.body.serverTime).expect(403);
    expect(await readState()).toEqual(changed);

    const nextReview = await check(secondClient.cookie).expect(200);
    await post(`/api/members/${secondClient.memberId}/revoke`, developerCookie).expect(204);
    const revoked = await readState();
    await check(secondClient.cookie).expect(404);
    await approve(nextReview.body.serverTime, secondClient.cookie).expect(404);
    expect(await readState()).toEqual(revoked);
  });

  it.each(['OPEN', 'IN_PROGRESS', 'READY_FOR_REVIEW'] as const)(
    '범위 안의 끝나지 않은 쪽지 (%s)가 있으면 409 UNRESOLVED_ISSUES이고 아무것도 바뀌지 않는다',
    async (status) => {
      await prepareVersion();
      const issue = await createIssue({ status });
      const before = await readState();
      const review = await check().expect(200);
      expect(review.body.unresolved).toEqual([{ id: issue.id, number: issue.number, title: issue.title, status }]);
      await approve(review.body.serverTime)
        .expect(409)
        .expect(({ body }) => {
          expect(body.code).toBe('UNRESOLVED_ISSUES');
        });
      expect(await readState()).toEqual(before);
    },
  );

  it('지난 버전에서 시작한 끝나지 않은 쪽지도 승인을 막는다', async () => {
    await prepareVersion();
    const old = await prisma.deliveryVersion.create({
      data: {
        projectId,
        number: 0,
        status: 'IN_REVIEW',
        publishedAt: new Date('2025-12-01T00:00:00Z'),
      },
    });
    const issue = await createIssue({ originVersionId: old.id });
    const review = await check().expect(200);
    expect(review.body.unresolved).toEqual([
      { id: issue.id, number: issue.number, title: issue.title, status: 'OPEN' },
    ]);
    const before = await readState();
    await approve(review.body.serverTime)
      .expect(409)
      .expect(({ body }) => {
        expect(body.code).toBe('UNRESOLVED_ISSUES');
      });
    expect(await readState()).toEqual(before);
  });

  it('숨긴 화면에서 시작한 끝나지 않은 쪽지도 승인 검토 목록에 있고 승인을 막는다', async () => {
    await prepareVersion();
    const issue = await createIssue({ originVersionScreenId: versionScreenId, xRatio: 0.5, yRatio: 0.5 });
    await prisma.screen.update({ where: { id: screenId }, data: { hiddenAt: new Date() } });
    const review = await check().expect(200);
    expect(review.body.unresolved).toEqual([
      { id: issue.id, number: issue.number, title: issue.title, status: 'OPEN' },
    ]);
    const before = await readState();
    await approve(review.body.serverTime)
      .expect(409)
      .expect(({ body }) => {
        expect(body.code).toBe('UNRESOLVED_ISSUES');
      });
    expect(await readState()).toEqual(before);
  });

  it('범위 밖 쪽지만 남아 있으면 승인되고 승인 검토에 그 목록이 온다', async () => {
    await prepareVersion();
    const ready = await createIssue({ number: 3, scope: 'OUT_OF_SCOPE', status: 'READY_FOR_REVIEW' });
    const open = await createIssue({ number: 1, scope: 'OUT_OF_SCOPE' });
    const started = await createIssue({ number: 2, scope: 'OUT_OF_SCOPE', status: 'IN_PROGRESS' });
    await createIssue({ scope: 'OUT_OF_SCOPE', status: 'VERIFIED' });
    await createIssue({ scope: 'OUT_OF_SCOPE', status: 'WITHDRAWN' });
    const review = await check().expect(200);
    expect(review.body.unresolved).toEqual([]);
    expect(review.body.outOfScope).toEqual(
      [open, started, ready].map(({ id, number, title, status }) => ({ id, number, title, status })),
    );
    const approved = await approve(review.body.serverTime).expect(200);
    expect(approved.body).toMatchObject({
      id: versionId,
      status: 'APPROVED',
      approval: { approverName: firstClient.name, approvedAt: expect.any(String) },
    });
    expect((await prisma.issue.findUniqueOrThrow({ where: { id: ready.id } })).status).toBe('READY_FOR_REVIEW');
  });

  it('쪽지가 없거나 확인 완료·철회된 쪽지만 있으면 승인되고 버전이 APPROVED가 된다', async () => {
    await prepareVersion();
    const emptyReview = await check().expect(200);
    expect(emptyReview.body).toEqual({ serverTime: expect.any(String), unresolved: [], outOfScope: [], comments: [] });
    await approve(emptyReview.body.serverTime)
      .expect(200)
      .expect(({ body }) => {
        expect(body.status).toBe('APPROVED');
      });
    expect((await prisma.approval.findUniqueOrThrow({ where: { versionId } })).summary).toEqual({ issues: [] });

    const draft = await post(`/api/projects/${projectId}/versions`, developerCookie).expect(201);
    await post(`/api/versions/${draft.body.id}/publish`, developerCookie).expect(200);
    versionId = draft.body.id;
    await createIssue({ status: 'VERIFIED' });
    await createIssue({ status: 'WITHDRAWN' });
    const review = await check().expect(200);
    expect(review.body.unresolved).toEqual([]);
    await approve(review.body.serverTime)
      .expect(200)
      .expect(({ body }) => {
        expect(body.status).toBe('APPROVED');
      });
    expect((await prisma.deliveryVersion.findUniqueOrThrow({ where: { id: versionId } })).status).toBe('APPROVED');
  });

  it('지난 버전·이미 승인된 버전·게시 전 버전은 승인과 승인 검토가 409이거나 404다', async () => {
    await prepareVersion();
    const review = await check().expect(200);
    const old = await prisma.deliveryVersion.create({
      data: {
        projectId,
        number: 0,
        status: 'IN_REVIEW',
        publishedAt: new Date('2025-12-01T00:00:00Z'),
      },
    });
    const draft = await post(`/api/projects/${projectId}/versions`, developerCookie).expect(201);
    const before = await readState();
    await check(firstClient.cookie, old.id)
      .expect(409)
      .expect(({ body }) => {
        expect(body.code).toBe('VERSION_CHANGED');
      });
    await approve(review.body.serverTime, firstClient.cookie, old.id)
      .expect(409)
      .expect(({ body }) => {
        expect(body.code).toBe('VERSION_CHANGED');
      });
    await check(firstClient.cookie, draft.body.id).expect(404);
    await approve(review.body.serverTime, firstClient.cookie, draft.body.id).expect(404);
    expect(await readState()).toEqual(before);
    await approve(review.body.serverTime).expect(200);
    const approved = await readState();
    await check()
      .expect(409)
      .expect(({ body }) => {
        expect(body.code).toBe('VERSION_NOT_IN_REVIEW');
      });
    await approve(review.body.serverTime)
      .expect(409)
      .expect(({ body }) => {
        expect(body.code).toBe('VERSION_NOT_IN_REVIEW');
      });
    expect(await readState()).toEqual(approved);
  });

  it('seenAt 뒤에 다른 사람의 댓글이 있으면 409 NEW_COMMENTS이고 승인자 자신의 댓글만 있으면 승인된다', async () => {
    await prepareVersion();
    const issue = await createIssue({ status: 'VERIFIED' });
    const review = await check().expect(200);
    await comment(issue.id).expect(201);
    const before = await readState();
    await approve(review.body.serverTime)
      .expect(409)
      .expect(({ body }) => {
        expect(body.code).toBe('NEW_COMMENTS');
      });
    expect(await readState()).toEqual(before);
    const refreshed = await check().expect(200);
    await comment(issue.id, firstClient.cookie, '제가 확인했어요').expect(201);
    await approve(refreshed.body.serverTime).expect(200);
  });

  it('승인 검토를 연 뒤 개발자가 쪽지 범위를 바꾸면 자동 댓글 때문에 승인이 409다', async () => {
    await prepareVersion();
    const issue = await createIssue();
    const review = await check().expect(200);
    await updateIssue(issue.id, { scope: 'OUT_OF_SCOPE' }).expect(200);
    const before = await readState();
    expect(before.comments).toHaveLength(1);
    expect(before.comments[0].requestId).toBeNull();
    await approve(review.body.serverTime)
      .expect(409)
      .expect(({ body }) => {
        expect(body.code).toBe('NEW_COMMENTS');
      });
    expect(await readState()).toEqual(before);
    const refreshed = await check().expect(200);
    expect(refreshed.body.comments).toEqual([
      expect.objectContaining({ id: before.comments[0].id, body: before.comments[0].body }),
    ]);
    await approve(refreshed.body.serverTime).expect(200);
  });

  it('승인 검토를 연 뒤 다른 사람이 쪽지를 철회하거나 새 쪽지를 쓰면 승인이 409다', async () => {
    await prepareVersion();
    const issue = await createIssue({ authorId: secondClient.id, scope: 'OUT_OF_SCOPE' });
    const review = await check().expect(200);
    await post(`/api/issues/${issue.id}/withdraw`, secondClient.cookie)
      .send({ versionId, reason: '더는 필요 없어요' })
      .expect(200);
    const withdrawn = await readState();
    await approve(review.body.serverTime)
      .expect(409)
      .expect(({ body }) => {
        expect(body.code).toBe('NEW_COMMENTS');
      });
    expect(await readState()).toEqual(withdrawn);
    const refreshed = await check().expect(200);
    await post(`/api/projects/${projectId}/issues`, secondClient.cookie).send(issueInput()).expect(201);
    const created = await readState();
    await approve(refreshed.body.serverTime)
      .expect(409)
      .expect(({ body }) => {
        expect(body.code).toBe('UNRESOLVED_ISSUES');
      });
    expect(await readState()).toEqual(created);
  });

  it.each<[string, Record<string, unknown>]>([
    ['없음', {}],
    ['null', { seenAt: null }],
    ['빈 글자', { seenAt: '' }],
    ['숫자', { seenAt: 123 }],
    ['배열', { seenAt: ['2026-01-01T00:00:00.000000Z'] }],
    ['객체', { seenAt: {} }],
    ['밀리초 3자리', { seenAt: '2026-01-01T00:00:00.123Z' }],
    ['소수 7자리', { seenAt: '2026-01-01T00:00:00.1234567Z' }],
    ['Z 없음', { seenAt: '2026-01-01T00:00:00.123456' }],
    ['시간대 오프셋', { seenAt: '2026-01-01T00:00:00.123456+09:00' }],
    ['소문자 z', { seenAt: '2026-01-01T00:00:00.123456z' }],
    ['공백 구분', { seenAt: '2026-01-01 00:00:00.123456Z' }],
    ['날짜만', { seenAt: '2026-01-01' }],
    ['앞 공백', { seenAt: ' 2026-01-01T00:00:00.000000Z' }],
    ['뒤 공백', { seenAt: '2026-01-01T00:00:00.000000Z ' }],
    ['뒤 줄바꿈', { seenAt: '2026-01-01T00:00:00.000000Z\n' }],
    ['미래', { seenAt: '9999-12-31T23:59:59.999999Z' }],
    ['모르는 칸', { seenAt: '2026-01-01T00:00:00.123456Z', status: 'APPROVED' }],
  ])('틀린 입력 (%s)는 422이고 아무것도 바뀌지 않는다', async (_name, input) => {
    await prepareVersion();
    const before = await readState();
    await post(`/api/versions/${versionId}/approve`).send(input).expect(422);
    expect(await readState()).toEqual(before);
  });

  it.each([
    '2026-02-30T00:00:00.000000Z',
    '2027-02-29T00:00:00.000000Z',
    '1900-02-29T00:00:00.000000Z',
    '2026-13-01T00:00:00.000000Z',
    '2026-00-01T00:00:00.000000Z',
    '2026-01-00T00:00:00.000000Z',
    '2026-01-32T00:00:00.000000Z',
    '2026-04-31T00:00:00.000000Z',
    '2026-01-01T24:00:00.000000Z',
    '2026-01-01T25:00:00.000000Z',
    '2026-01-01T00:60:00.000000Z',
    '2026-01-01T00:00:60.000000Z',
    '0999-01-01T00:00:00.000000Z',
  ])('없는 날짜나 시각의 seenAt (%s)는 422이고 버전은 검수 중 그대로다', async (seenAt) => {
    await prepareVersion();
    const before = await readState();
    await approve(seenAt).expect(422);
    expect(await readState()).toEqual(before);
    expect((await prisma.deliveryVersion.findUniqueOrThrow({ where: { id: versionId } })).status).toBe('IN_REVIEW');
  });

  it('seenAt이 DB의 지금 시각보다 2초 뒤이면 422이고 버전·승인 줄·일지가 그대로다', async () => {
    await prepareVersion();
    const before = await readState();
    const [{ seenAt }] = await prisma.$queryRaw<{ seenAt: string }[]>`
      SELECT to_char((clock_timestamp() + interval '2 seconds') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "seenAt"
    `;

    await approve(seenAt).expect(422);

    expect(await readState()).toEqual(before);
  });

  it('주소의 버전 id가 대문자여도 승인 검토 조회는 200이고 승인도 200 APPROVED다', async () => {
    await prepareVersion();
    const uppercaseVersionId = versionId.toUpperCase();

    const review = await check(firstClient.cookie, uppercaseVersionId).expect(200);
    const approved = await approve(review.body.serverTime, firstClient.cookie, uppercaseVersionId).expect(200);

    expect(approved.body).toMatchObject({ id: versionId, status: 'APPROVED' });
    expect((await prisma.deliveryVersion.findUniqueOrThrow({ where: { id: versionId } })).status).toBe('APPROVED');
    expect(await prisma.approval.count({ where: { versionId } })).toBe(1);
  });

  it('저장 중인 댓글이 끝날 때까지 승인 검토 조회가 기다리고 그 댓글이 목록에 들어 있다', async () => {
    await prepareVersion();
    const issue = await createIssue({ status: 'VERIFIED' });
    const commentId = randomUUID();
    const body = '저장 중인 개발자 댓글';
    let settled = false;
    let pendingReview: Promise<PromiseSettledResult<request.Response>[]> | undefined;

    try {
      await prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM projects WHERE id = ${projectId}::uuid FOR UPDATE`;
          const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          await tx.comment.create({
            data: { id: commentId, issueId: issue.id, versionId, authorId: developerId, requestId: randomUUID(), body },
          });

          // await로 HTTP 요청을 시작하고, 실패해도 트랜잭션을 정리한 뒤 결과를 확인한다.
          pendingReview = Promise.allSettled([
            (async () => {
              try {
                return await check().timeout({ deadline: 5_000 });
              } finally {
                settled = true;
              }
            })(),
          ]);
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
          await delay(300);
          expect(settled).toBe(false);
        },
        { maxWait: 5_000, timeout: 10_000 },
      );
    } finally {
      await pendingReview;
    }

    const [result] = await pendingReview!;
    if (result.status === 'rejected') throw result.reason;
    const review = result.value;
    expect(review.status).toBe(200);
    expect(review.body.comments).toEqual([expect.objectContaining({ id: commentId, issueId: issue.id, body })]);
    expect(review.body.serverTime).toMatch(/^[1-9]\d{3}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    const [{ includesCommentTime }] = await prisma.$queryRaw<{ includesCommentTime: boolean }[]>`
      SELECT ${review.body.serverTime}::text >=
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "includesCommentTime"
      FROM comments WHERE id = ${commentId}::uuid
    `;
    expect(includesCommentTime).toBe(true);

    const approved = await approve(review.body.serverTime).expect(200);
    expect(approved.body).toMatchObject({ id: versionId, status: 'APPROVED' });
  }, 15_000);

  it('댓글 저장과 승인 검토 조회를 동시에 보내면 그 댓글은 목록에 들어가거나 승인이 409로 막힌다', async () => {
    await prepareVersion();
    const issue = await createIssue({ status: 'VERIFIED' });
    const [saved, review] = await Promise.all([comment(issue.id).expect(201), check().expect(200)]);
    expect(review.body.serverTime).toMatch(/^[1-9]\d{3}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    const listed = review.body.comments.some((entry: { id: string }) => entry.id === saved.body.id);
    const result = await approve(review.body.serverTime);
    if (listed) {
      expect(result.status).toBe(200);
      expect(result.body.status).toBe('APPROVED');
      return;
    }
    expect(result.status).toBe(409);
    expect(result.body.code).toBe('NEW_COMMENTS');
    expect(await prisma.approval.count()).toBe(0);
    expect((await prisma.deliveryVersion.findUniqueOrThrow({ where: { id: versionId } })).status).toBe('IN_REVIEW');
  });

  it('승인과 새 쪽지를 동시에 보내면 하나만 성공하고 승인된 버전에 범위 안 미해결 쪽지가 남지 않는다', async () => {
    await prepareVersion();
    const review = await check().expect(200);
    const [approved, created] = await Promise.all([
      approve(review.body.serverTime),
      post(`/api/projects/${projectId}/issues`, secondClient.cookie).send(issueInput()),
    ]);
    const version = await prisma.deliveryVersion.findUniqueOrThrow({ where: { id: versionId } });
    const unresolved = await prisma.issue.count({
      where: { projectId, scope: 'IN_SCOPE', status: { in: ['OPEN', 'IN_PROGRESS', 'READY_FOR_REVIEW'] } },
    });
    if (approved.status === 200) {
      expect(created.status).toBe(409);
      expect(created.body.code).toBe('VERSION_NOT_IN_REVIEW');
      expect(version.status).toBe('APPROVED');
      expect(unresolved).toBe(0);
      expect(await prisma.approval.count()).toBe(1);
      return;
    }
    expect(approved.status).toBe(409);
    expect(approved.body.code).toBe('UNRESOLVED_ISSUES');
    expect(created.status).toBe(201);
    expect(version.status).toBe('IN_REVIEW');
    expect(unresolved).toBe(1);
    expect(await prisma.approval.count()).toBe(0);
    expect(await prisma.activityEvent.count({ where: { type: 'VERSION_APPROVED' } })).toBe(0);
  });

  it('승인과 범위 바꾸기를 동시에 보내면 둘 중 하나만 반영된 상태로 끝난다', async () => {
    await prepareVersion();
    const issue = await createIssue({ scope: 'OUT_OF_SCOPE' });
    const review = await check().expect(200);
    const [approved, changed] = await Promise.all([
      approve(review.body.serverTime),
      updateIssue(issue.id, { scope: 'IN_SCOPE' }),
    ]);
    const stored = await prisma.issue.findUniqueOrThrow({ where: { id: issue.id } });
    const version = await prisma.deliveryVersion.findUniqueOrThrow({ where: { id: versionId } });
    if (approved.status === 200) {
      expect(changed.status).toBe(409);
      expect(changed.body.code).toBe('VERSION_NOT_IN_REVIEW');
      expect(stored.scope).toBe('OUT_OF_SCOPE');
      expect(version.status).toBe('APPROVED');
      expect(await prisma.comment.count()).toBe(0);
      expect(await prisma.approval.count()).toBe(1);
      return;
    }
    expect(approved.status).toBe(409);
    expect(approved.body.code).toBe('UNRESOLVED_ISSUES');
    expect(changed.status).toBe(200);
    expect(stored.scope).toBe('IN_SCOPE');
    expect(version.status).toBe('IN_REVIEW');
    expect(await prisma.comment.count()).toBe(1);
    expect(await prisma.approval.count()).toBe(0);
    expect(await prisma.activityEvent.count({ where: { type: 'VERSION_APPROVED' } })).toBe(0);
  });

  it('승인을 동시에 두 번 보내거나 다시 보내면 하나만 성공하고 승인 줄과 일지가 하나씩만 남는다', async () => {
    await prepareVersion();
    const review = await check().expect(200);
    const responses = await Promise.all([approve(review.body.serverTime), approve(review.body.serverTime)]);
    expect(responses.map(({ status }) => status).sort()).toEqual([200, 409]);
    expect(responses.find(({ status }) => status === 409)!.body.code).toBe('VERSION_NOT_IN_REVIEW');
    const before = await readState();
    await approve(review.body.serverTime)
      .expect(409)
      .expect(({ body }) => {
        expect(body.code).toBe('VERSION_NOT_IN_REVIEW');
      });
    expect(await readState()).toEqual(before);
    expect(before.approvals).toHaveLength(1);
    expect(before.approvals[0]).toMatchObject({ versionId, approverId: firstClient.id });
    const events = before.events.filter(({ type }) => type === 'VERSION_APPROVED');
    expect(events).toHaveLength(1);
    const activity = await request(server)
      .get(`/api/projects/${projectId}/activity`)
      .set('Cookie', secondClient.cookie)
      .expect(200);
    expect(activity.body).toEqual([
      {
        id: events[0].id,
        type: 'VERSION_APPROVED',
        actorName: firstClient.name,
        createdAt: events[0].createdAt.toISOString(),
        mailFailedTo: [],
        version: { id: versionId, number: 1 },
        issue: null,
        memberName: null,
      },
    ]);
  });

  it('승인과 새 버전 게시를 동시에 보내면 승인되거나 409 VERSION_CHANGED다', async () => {
    await prepareVersion();
    const draft = await post(`/api/projects/${projectId}/versions`, developerCookie).expect(201);
    const review = await check().expect(200);
    const [approved, published] = await Promise.all([
      approve(review.body.serverTime),
      post(`/api/versions/${draft.body.id}/publish`, developerCookie),
    ]);
    expect(published.status).toBe(200);
    expect(published.body).toMatchObject({ id: draft.body.id, number: 2, status: 'IN_REVIEW', approval: null });
    expect((await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).currentVersionId).toBe(draft.body.id);
    const old = await prisma.deliveryVersion.findUniqueOrThrow({ where: { id: versionId } });
    if (approved.status === 200) {
      expect(old.status).toBe('APPROVED');
      expect(await prisma.approval.count({ where: { versionId } })).toBe(1);
      expect(await prisma.activityEvent.count({ where: { versionId, type: 'VERSION_APPROVED' } })).toBe(1);
      return;
    }
    expect(approved.status).toBe(409);
    expect(approved.body.code).toBe('VERSION_CHANGED');
    expect(old.status).toBe('IN_REVIEW');
    expect(await prisma.approval.count()).toBe(0);
    expect(await prisma.activityEvent.count({ where: { type: 'VERSION_APPROVED' } })).toBe(0);
  });

  it('일지 저장이 실패하면 버전은 검수 중 그대로이고 승인 줄도 없다', async () => {
    await prepareVersion();
    await createIssue({ status: 'VERIFIED' });
    const review = await check().expect(200);
    const before = await readState();
    try {
      await prisma.$executeRaw`
        CREATE FUNCTION approval_e2e_fail_event() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'approval e2e activity failure'; END;
        $$
      `;
      await prisma.$executeRaw`
        CREATE TRIGGER approval_e2e_fail_event BEFORE INSERT ON activity_events
        FOR EACH ROW WHEN (NEW.type = 'VERSION_APPROVED')
        EXECUTE FUNCTION approval_e2e_fail_event()
      `;
      await approve(review.body.serverTime).expect(500);
      expect(await readState()).toEqual(before);
      expect(await prisma.approval.count()).toBe(0);
      expect((await prisma.deliveryVersion.findUniqueOrThrow({ where: { id: versionId } })).status).toBe('IN_REVIEW');
    } finally {
      try {
        await prisma.$executeRaw`DROP TRIGGER IF EXISTS approval_e2e_fail_event ON activity_events`;
      } finally {
        await prisma.$executeRaw`DROP FUNCTION IF EXISTS approval_e2e_fail_event()`;
      }
    }
    await approve(review.body.serverTime).expect(200);
    expect(await prisma.approval.count()).toBe(1);
    expect(await prisma.activityEvent.count({ where: { type: 'VERSION_APPROVED' } })).toBe(1);
  });

  it('승인하면 그 시점의 쪽지 목록이 summary에 번호 순으로 저장된다', async () => {
    await prepareVersion();
    const old = await prisma.deliveryVersion.create({
      data: {
        projectId,
        number: 0,
        status: 'IN_REVIEW',
        publishedAt: new Date('2025-12-01T00:00:00Z'),
      },
    });
    await createIssue({
      number: 3,
      title: '남은 추가 요청',
      category: 'COPY',
      scope: 'OUT_OF_SCOPE',
      status: 'READY_FOR_REVIEW',
    });
    const completed = await createIssue({
      number: 1,
      originVersionId: old.id,
      title: '지난 버전 수정',
      category: 'DESIGN',
      status: 'VERIFIED',
    });
    await createIssue({ number: 2, title: '철회한 수정', category: 'OTHER', status: 'WITHDRAWN' });
    const review = await check().expect(200);
    await approve(review.body.serverTime).expect(200);
    const approval = await prisma.approval.findUniqueOrThrow({ where: { versionId } });
    expect(approval.summary).toEqual({
      issues: [
        { number: 1, title: '지난 버전 수정', category: 'DESIGN', scope: 'IN_SCOPE', status: 'VERIFIED' },
        { number: 2, title: '철회한 수정', category: 'OTHER', scope: 'IN_SCOPE', status: 'WITHDRAWN' },
        { number: 3, title: '남은 추가 요청', category: 'COPY', scope: 'OUT_OF_SCOPE', status: 'READY_FOR_REVIEW' },
      ],
    });
    const draft = await post(`/api/projects/${projectId}/versions`, developerCookie).expect(201);
    await post(`/api/versions/${draft.body.id}/publish`, developerCookie).expect(200);
    await post(`/api/issues/${completed.id}/reopen`)
      .send({ versionId: draft.body.id, reason: '다음 버전에서 다시 확인해요' })
      .expect(200);
    expect((await prisma.issue.findUniqueOrThrow({ where: { id: completed.id } })).status).toBe('OPEN');
    expect(await prisma.approval.findUniqueOrThrow({ where: { versionId } })).toEqual(approval);
  });

  it('승인된 버전에서는 쪽지·댓글·참고 사진·정리·수정 시작·고쳤어요·확인·재요청·철회가 모두 409다', async () => {
    await prepareVersion();
    const open = await createIssue({ scope: 'OUT_OF_SCOPE' });
    const ready = await createIssue({ scope: 'OUT_OF_SCOPE' });
    const closed = await createIssue({ status: 'VERIFIED' });
    const submitted = await post(`/api/issues/${ready.id}/submit-resolution`, developerCookie)
      .send({ versionId, summary: '고쳤어요', screenId })
      .expect(200);
    const attemptId = submitted.body.attempts[0].id;
    const photo = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#ffffff' } })
      .png()
      .toBuffer();
    const attached = await post(`/api/issues/${open.id}/attachments`)
      .attach('file', photo, 'reference.png')
      .expect(201);
    const attachmentId = attached.body.attachments[0].id;
    const review = await check().expect(200);
    await approve(review.body.serverTime).expect(200);
    const before = await readState();
    const filesBefore = (await readdir(directory, { recursive: true })).sort();
    const writes = [
      () => post(`/api/projects/${projectId}/issues`).send(issueInput()),
      () => comment(open.id, firstClient.cookie),
      () => post(`/api/issues/${open.id}/attachments`).attach('file', photo, 'new.png'),
      () =>
        request(server)
          .delete(`/api/issues/${open.id}/attachments/${attachmentId}`)
          .set('Origin', origin)
          .set('Cookie', firstClient.cookie),
      () => updateIssue(open.id, { category: 'DESIGN' }),
      () => updateIssue(open.id, { scope: 'IN_SCOPE' }),
      () => updateIssue(open.id, { dueDate: '2027-01-01' }),
      () => post(`/api/issues/${open.id}/start`, developerCookie).send({ versionId }),
      () =>
        post(`/api/issues/${open.id}/submit-resolution`, developerCookie).send({
          versionId,
          summary: '수정했어요',
          screenId,
        }),
      () => post(`/api/issues/${ready.id}/verify`).send({ versionId, attemptId }),
      () => post(`/api/issues/${ready.id}/reopen`).send({ versionId, attemptId, reason: '다시 고쳐 주세요' }),
      () => post(`/api/issues/${closed.id}/reopen`).send({ versionId, reason: '다시 열어 주세요' }),
      () => post(`/api/issues/${open.id}/withdraw`).send({ versionId, reason: '철회해요' }),
    ];
    for (const write of writes) {
      await write()
        .expect(409)
        .expect(({ body }) => {
          expect(body.code).toBe('VERSION_NOT_IN_REVIEW');
        });
      expect(await readState()).toEqual(before);
      expect((await readdir(directory, { recursive: true })).sort()).toEqual(filesBefore);
    }
  });

  it('승인 뒤에도 다음 버전을 게시할 수 있고 새 버전에서 쪽지를 쓸 수 있다', async () => {
    await prepareVersion();
    const review = await check().expect(200);
    const approved = await approve(review.body.serverTime).expect(200);
    const draft = await post(`/api/projects/${projectId}/versions`, developerCookie).expect(201);
    expect(draft.body).toMatchObject({ status: 'DRAFT', approval: null });
    const published = await post(`/api/versions/${draft.body.id}/publish`, developerCookie).expect(200);
    expect(published.body).toMatchObject({ number: 2, status: 'IN_REVIEW', approval: null });
    const issue = await post(`/api/projects/${projectId}/issues`, secondClient.cookie)
      .send({ ...issueInput(), versionId: draft.body.id })
      .expect(201);
    expect(issue.body).toMatchObject({ status: 'OPEN', scope: 'IN_SCOPE', originVersion: { id: draft.body.id } });
    await post(`/api/issues/${issue.body.id}/comments`, secondClient.cookie)
      .send({ requestId: randomUUID(), versionId: draft.body.id, body: '새 버전 댓글' })
      .expect(201);
    await request(server)
      .get(`/api/versions/${versionId}`)
      .set('Cookie', firstClient.cookie)
      .expect(200)
      .expect(approved.body);
    expect((await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).currentVersionId).toBe(draft.body.id);
  });

  it('멤버가 아니거나 없는 버전이면 승인과 승인 검토가 404다', async () => {
    await prepareVersion();
    const review = await check().expect(200);
    const outsider = await prisma.user.create({ data: { email: 'outsider@example.com', name: '외부인' } });
    const outsiderCookie = await login(outsider.id);
    const otherProject = await prisma.project.create({
      data: { name: '남의 프로젝트', members: { create: { userId: developerId, role: 'DEVELOPER' } } },
    });
    const otherVersion = await prisma.deliveryVersion.create({
      data: {
        projectId: otherProject.id,
        number: 0,
        status: 'IN_REVIEW',
        publishedAt: new Date(),
      },
    });
    await post(`/api/members/${secondClient.memberId}/revoke`, developerCookie).expect(204);
    const before = await readState();
    for (const [id, cookie] of [
      [versionId, outsiderCookie],
      [versionId, secondClient.cookie],
      [missingId, firstClient.cookie],
      ['not-a-uuid', firstClient.cookie],
      [otherVersion.id, firstClient.cookie],
    ]) {
      const absent = { statusCode: 404, message: '없는 버전이에요', error: 'Not Found' };
      await check(cookie, id).expect(404).expect(absent);
      await approve(review.body.serverTime, cookie, id).expect(404).expect(absent);
      expect(await readState()).toEqual(before);
    }
  });

  it('로그인하지 않으면 401이고 다른 Origin에서 온 승인은 403이다', async () => {
    await prepareVersion();
    const review = await check().expect(200);
    const before = await readState();
    await request(server).get(`/api/versions/${versionId}/approval-check`).expect(401);
    await request(server)
      .post(`/api/versions/${versionId}/approve`)
      .set('Origin', origin)
      .send({ seenAt: review.body.serverTime })
      .expect(401);
    await request(server)
      .post(`/api/versions/${versionId}/approve`)
      .set('Cookie', firstClient.cookie)
      .set('Origin', 'https://other.example.com')
      .send({ seenAt: review.body.serverTime })
      .expect(403);
    await request(server)
      .post(`/api/versions/${versionId}/approve`)
      .set('Cookie', firstClient.cookie)
      .send({ seenAt: review.body.serverTime })
      .expect(403);
    expect(await readState()).toEqual(before);
  });

  it('승인 검토는 이 프로젝트의 쪽지와 이번 버전의 댓글만 오래된 순으로 준다', async () => {
    await prepareVersion();
    const old = await prisma.deliveryVersion.create({
      data: {
        projectId,
        number: 0,
        status: 'IN_REVIEW',
        publishedAt: new Date('2025-12-01T00:00:00Z'),
      },
    });
    const laterIssue = await createIssue({ number: 3, title: '세 번째 쪽지' });
    const oldIssue = await createIssue({ number: 1, originVersionId: old.id, title: '지난 차수에서 시작한 쪽지' });
    const outside = await createIssue({ number: 2, scope: 'OUT_OF_SCOPE' });
    await createIssue({ status: 'VERIFIED' });
    await createIssue({ scope: 'OUT_OF_SCOPE', status: 'WITHDRAWN' });
    const otherProject = await prisma.project.create({
      data: { name: '다른 프로젝트', members: { create: { userId: developerId, role: 'DEVELOPER' } } },
    });
    const otherVersion = await prisma.deliveryVersion.create({
      data: {
        projectId: otherProject.id,
        number: 0,
        status: 'IN_REVIEW',
        publishedAt: new Date('2025-12-01T00:00:00Z'),
      },
    });
    const otherIssue = await createIssue({
      projectId: otherProject.id,
      originVersionId: otherVersion.id,
      number: 1,
      authorId: developerId,
    });
    await prisma.comment.create({
      data: {
        issueId: otherIssue.id,
        versionId: otherVersion.id,
        authorId: developerId,
        body: '남의 프로젝트 댓글',
      },
    });
    await prisma.comment.create({
      data: { issueId: oldIssue.id, versionId: old.id, authorId: secondClient.id, body: '지난 차수 댓글' },
    });
    // 넣은 순서와 시각 순서를 다르게 해서 오래된 순 정렬도 확인한다. 자동·사유 댓글은 requestId가 없다.
    const last = await prisma.comment.create({
      data: {
        issueId: outside.id,
        versionId,
        authorId: secondClient.id,
        body: '철회 사유',
        createdAt: new Date('2026-01-03T00:00:00Z'),
      },
    });
    const first = await prisma.comment.create({
      data: {
        issueId: oldIssue.id,
        versionId,
        authorId: firstClient.id,
        requestId: randomUUID(),
        body: '확인했어요',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    });
    const middle = await prisma.comment.create({
      data: {
        issueId: laterIssue.id,
        versionId,
        authorId: secondClient.id,
        body: '범위 변경 안내',
        createdAt: new Date('2026-01-02T00:00:00Z'),
      },
    });
    const before = await readState();
    const review = await check().expect(200);
    expect(review.body.serverTime).toMatch(/^[1-9]\d{3}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    expect(review.body.unresolved).toEqual(
      [oldIssue, laterIssue].map(({ id, number, title, status }) => ({ id, number, title, status })),
    );
    expect(review.body.outOfScope).toEqual([
      { id: outside.id, number: outside.number, title: outside.title, status: 'OPEN' },
    ]);
    expect(review.body.comments).toEqual([
      {
        id: first.id,
        issueId: oldIssue.id,
        issueNumber: 1,
        issueTitle: oldIssue.title,
        authorName: firstClient.name,
        body: first.body,
        createdAt: first.createdAt.toISOString(),
      },
      {
        id: middle.id,
        issueId: laterIssue.id,
        issueNumber: 3,
        issueTitle: laterIssue.title,
        authorName: secondClient.name,
        body: middle.body,
        createdAt: middle.createdAt.toISOString(),
      },
      {
        id: last.id,
        issueId: outside.id,
        issueNumber: 2,
        issueTitle: outside.title,
        authorName: secondClient.name,
        body: last.body,
        createdAt: last.createdAt.toISOString(),
      },
    ]);
    expect(await readState()).toEqual(before);
  });

  it('승인이 있는 프로젝트를 DB에서 지우면 승인 줄도 함께 지워진다', async () => {
    await prepareVersion();
    const review = await check().expect(200);
    await approve(review.body.serverTime).expect(200);
    expect(await prisma.approval.count()).toBe(1);
    await prisma.project.delete({ where: { id: projectId } });
    expect(await prisma.approval.count()).toBe(0);
    expect(await prisma.deliveryVersion.count({ where: { projectId } })).toBe(0);
    expect(await prisma.user.findUnique({ where: { id: firstClient.id } })).not.toBeNull();
  });

  it('저장된 댓글과 쪽지를 승인 뒤에 같은 requestId로 다시 보내면 처음 결과를 돌려주고 새 요청은 409다', async () => {
    await prepareVersion();
    const input = issueInput();
    const created = await post(`/api/projects/${projectId}/issues`).send(input).expect(201);
    await updateIssue(created.body.id, { scope: 'OUT_OF_SCOPE' }).expect(200);
    const commentInput = { requestId: randomUUID(), versionId, body: '확인했어요' };
    const saved = await post(`/api/issues/${created.body.id}/comments`).send(commentInput).expect(201);
    const review = await check().expect(200);
    await approve(review.body.serverTime).expect(200);
    const before = await readState();
    const detail = await request(server)
      .get(`/api/issues/${created.body.id}`)
      .set('Cookie', firstClient.cookie)
      .expect(200);
    await post(`/api/projects/${projectId}/issues`).send(input).expect(201).expect(detail.body);
    expect(detail.body.id).toBe(created.body.id);
    await post(`/api/issues/${created.body.id}/comments`).send(commentInput).expect(201).expect(saved.body);
    await post(`/api/projects/${projectId}/issues`)
      .send({ ...input, requestId: randomUUID() })
      .expect(409)
      .expect(({ body }) => {
        expect(body.code).toBe('VERSION_NOT_IN_REVIEW');
      });
    await post(`/api/issues/${created.body.id}/comments`)
      .send({ ...commentInput, requestId: randomUUID() })
      .expect(409)
      .expect(({ body }) => {
        expect(body.code).toBe('VERSION_NOT_IN_REVIEW');
      });
    expect(await readState()).toEqual(before);
  });

  it('버전 상세의 approval은 승인 전에는 null이고 승인 뒤에는 승인자 이름과 승인 시각이다', async () => {
    await prepareVersion();
    const initial = await request(server)
      .get(`/api/versions/${versionId}`)
      .set('Cookie', firstClient.cookie)
      .expect(200);
    expect(initial.body.approval).toBeNull();
    const review = await check().expect(200);
    const approved = await approve(review.body.serverTime).expect(200);
    const stored = await prisma.approval.findUniqueOrThrow({ where: { versionId } });
    expect(approved.body).toEqual({
      ...initial.body,
      status: 'APPROVED',
      approval: {
        approverName: firstClient.name,
        approvedAt: stored.approvedAt.toISOString(),
      },
    });
    for (const cookie of [firstClient.cookie, secondClient.cookie, developerCookie]) {
      await request(server).get(`/api/versions/${versionId}`).set('Cookie', cookie).expect(200).expect(approved.body);
    }
    const draft = await post(`/api/projects/${projectId}/versions`, developerCookie).expect(201);
    expect(draft.body.approval).toBeNull();
    const published = await post(`/api/versions/${draft.body.id}/publish`, developerCookie).expect(200);
    expect(published.body.approval).toBeNull();
    await request(server)
      .get(`/api/versions/${draft.body.id}`)
      .set('Cookie', firstClient.cookie)
      .expect(200)
      .expect(published.body);
    await request(server)
      .get(`/api/versions/${versionId}`)
      .set('Cookie', firstClient.cookie)
      .expect(200)
      .expect(approved.body);
  });

  it.each([0, 1])(
    '다른 사람의 댓글 시각이 seenAt보다 %i마이크로초 뒤일 때 경계를 정확히 비교한다',
    async (microseconds) => {
      await prepareVersion();
      const issue = await createIssue({ status: 'VERIFIED' });
      const saved = await comment(issue.id).expect(201);
      const review = await check().expect(200);
      // Date로 만들면 마이크로초가 잘린다. DB에 경계값을 직접 넣고 HTTP로 비교 결과를 확인한다.
      await prisma.$executeRaw`
      UPDATE comments SET created_at = ${review.body.serverTime}::timestamptz + ${microseconds} * interval '1 microsecond'
      WHERE id = ${saved.body.id}::uuid
    `;
      const before = await readState();
      const response = await approve(review.body.serverTime);
      if (microseconds === 0) {
        expect(response.status).toBe(200);
        expect(response.body.status).toBe('APPROVED');
        return;
      }
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('NEW_COMMENTS');
      expect(await readState()).toEqual(before);
    },
  );

  it('승인 검토 뒤의 마감일 자동 댓글과 재요청 사유 댓글도 승인을 막는다', async () => {
    await prepareVersion();
    const issue = await createIssue({ scope: 'OUT_OF_SCOPE', authorId: secondClient.id });
    const submitted = await post(`/api/issues/${issue.id}/submit-resolution`, developerCookie)
      .send({ versionId, summary: '수정했어요' })
      .expect(200);
    const review = await check().expect(200);
    await updateIssue(issue.id, { dueDate: '2027-01-01' }).expect(200);
    const changed = await readState();
    await approve(review.body.serverTime)
      .expect(409)
      .expect(({ body }) => {
        expect(body.code).toBe('NEW_COMMENTS');
      });
    expect(await readState()).toEqual(changed);
    const refreshed = await check().expect(200);
    await post(`/api/issues/${issue.id}/reopen`, secondClient.cookie)
      .send({ versionId, attemptId: submitted.body.attempts[0].id, reason: '아직 버튼이 작아요' })
      .expect(200);
    const reopened = await readState();
    await approve(refreshed.body.serverTime)
      .expect(409)
      .expect(({ body }) => {
        expect(body.code).toBe('NEW_COMMENTS');
      });
    expect(await readState()).toEqual(reopened);
    const latest = await check().expect(200);
    expect(latest.body.comments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ body: '재요청 사유: 아직 버튼이 작아요', authorName: secondClient.name }),
      ]),
    );
    await approve(latest.body.serverTime).expect(200);
  });

  it('남의 프로젝트의 미해결 쪽지와 승인 검토 뒤 새 댓글은 이 프로젝트 승인을 막지 않는다', async () => {
    await prepareVersion();
    const otherProject = await prisma.project.create({
      data: {
        name: '다른 검수',
        members: { create: { userId: developerId, role: 'DEVELOPER' } },
      },
    });
    const otherVersion = await prisma.deliveryVersion.create({
      data: {
        projectId: otherProject.id,
        number: 0,
        status: 'IN_REVIEW',
        publishedAt: new Date(),
      },
    });
    await prisma.project.update({ where: { id: otherProject.id }, data: { currentVersionId: otherVersion.id } });
    const otherIssue = await post(`/api/projects/${otherProject.id}/issues`, developerCookie)
      .send({ ...issueInput(), versionId: otherVersion.id })
      .expect(201);
    const review = await check().expect(200);
    await post(`/api/issues/${otherIssue.body.id}/comments`, developerCookie)
      .send({ requestId: randomUUID(), versionId: otherVersion.id, body: '다른 검수 댓글' })
      .expect(201);
    await approve(review.body.serverTime).expect(200);
    expect((await prisma.approval.findUniqueOrThrow({ where: { versionId } })).summary).toEqual({ issues: [] });
    expect((await prisma.deliveryVersion.findUniqueOrThrow({ where: { id: otherVersion.id } })).status).toBe(
      'IN_REVIEW',
    );
  });

  it('승인자가 해제되면 이전 검토 시각으로 승인할 수 없다', async () => {
    await prepareVersion();
    const review = await check().expect(200);
    await setApprover(null).expect(200);
    const before = await readState();
    await check().expect(403);
    await approve(review.body.serverTime).expect(403);
    expect(await readState()).toEqual(before);
  });
});
