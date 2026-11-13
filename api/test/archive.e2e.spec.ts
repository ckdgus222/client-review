import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import sharp from 'sharp';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { createSessionToken, hashSessionToken } from '../src/auth/token.js';
import { MailService } from '../src/mail/mail.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { setupApp } from '../src/setup-app.js';
import { resetDatabase } from './reset-database.js';

const origin = 'http://localhost:5173';
const archivedBody = {
  statusCode: 409,
  message: '보관한 프로젝트예요. 보관을 풀어야 바꿀 수 있어요',
  code: 'PROJECT_ARCHIVED',
};
const deletePendingBody = {
  statusCode: 409,
  message: '삭제 대기 중인 프로젝트예요. 되살려야 바꿀 수 있어요',
  code: 'PROJECT_DELETE_PENDING',
};

type WriteRequest = {
  name: string;
  method: 'post' | 'patch' | 'put' | 'delete';
  path: string;
  actor: 'developer' | 'client' | 'invitee';
  body?: Record<string, unknown>;
  photo?: boolean;
  allowArchived?: boolean;
};

describe('보관과 삭제 (e2e)', () => {
  let app: INestApplication | undefined;
  let server: Server;
  let prisma: PrismaService;
  let directory: string;
  let projectId: string;
  let developerId: string;
  let clientId: string;
  let clientMemberId: string;
  let versionId: string;
  let draftId: string;
  let screenId: string;
  let hiddenScreenId: string;
  let assetId: string;
  let issueId: string;
  let reviewIssueId: string;
  let attemptId: string;
  let attachmentId: string;
  let attachmentAssetId: string;
  let invitationToken: string;
  let seenAt: string;
  let cookie: string;
  let clientCookie: string;
  let inviteeCookie: string;
  let outsiderCookie: string;
  let revokedCookie: string;
  let photo: Buffer;

  const login = async (userId: string) => {
    const token = createSessionToken();
    await prisma.session.create({
      data: { userId, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
    });
    return `sid=${token}`;
  };
  const get = (path: string, memberCookie = cookie) => request(server).get(path).set('Cookie', memberCookie);
  const post = (path: string, memberCookie = cookie) =>
    request(server).post(path).set('Origin', origin).set('Cookie', memberCookie);
  const patch = (path: string, memberCookie = cookie) =>
    request(server).patch(path).set('Origin', origin).set('Cookie', memberCookie);
  const issueInput = () => ({
    requestId: randomUUID(),
    versionId,
    title: '화면 수정 요청',
    body: '버튼을 고쳐 주세요',
  });
  const commentInput = () => ({ requestId: randomUUID(), versionId, body: '설명을 더 남겨요' });

  // 상태 API는 조각 3에서 생긴다. CHECK를 지키도록 삭제 시각·삭제 전 상태도 한 번에 바꾼다.
  const setStatus = async (status: 'ACTIVE' | 'ARCHIVED' | 'DELETE_PENDING', deletedAt = new Date()) => {
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    await prisma.project.update({
      where: { id: projectId },
      data: {
        status,
        statusBeforeDelete: status === 'DELETE_PENDING' ? project.status : null,
        deleteRequestedAt: status === 'DELETE_PENDING' ? deletedAt : null,
      },
    });
  };

  // 거절한 요청이 쪽지뿐 아니라 사진·초대·메일·일지를 남기거나 바꾸지 않았는지도 확인한다.
  const readState = async () => ({
    projects: await prisma.project.findMany({ orderBy: { id: 'asc' } }),
    members: await prisma.projectMember.findMany({ orderBy: { id: 'asc' } }),
    versions: await prisma.deliveryVersion.findMany({ orderBy: { id: 'asc' } }),
    screens: await prisma.screen.findMany({ orderBy: { id: 'asc' } }),
    versionScreens: await prisma.versionScreen.findMany({ orderBy: { id: 'asc' } }),
    assets: await prisma.asset.findMany({ orderBy: { id: 'asc' } }),
    attachments: await prisma.issueAttachment.findMany({ orderBy: { id: 'asc' } }),
    issues: await prisma.issue.findMany({ orderBy: { id: 'asc' } }),
    comments: await prisma.comment.findMany({ orderBy: { id: 'asc' } }),
    attempts: await prisma.resolutionAttempt.findMany({ orderBy: { id: 'asc' } }),
    approvals: await prisma.approval.findMany({ orderBy: { id: 'asc' } }),
    invitations: await prisma.invitation.findMany({ orderBy: { id: 'asc' } }),
    events: await prisma.activityEvent.findMany({ orderBy: { id: 'asc' } }),
    deliveries: await prisma.notificationDelivery.findMany({ orderBy: { id: 'asc' } }),
    files: (await readdir(directory, { recursive: true })).sort(),
  });

  // 프로젝트를 만드는 API는 기존 프로젝트에 쓰지 않는다. 그 API를 뺀 23개 경로다.
  // 재요청과 다시 열기는 같은 경로이며, 승인 창 조회는 읽기라 별도로 확인한다.
  const writeRequests = (): WriteRequest[] => [
    { name: '버전 만들기', method: 'post', path: `/api/projects/${projectId}/versions`, actor: 'developer' },
    {
      name: '버전 설명',
      method: 'patch',
      path: `/api/versions/${draftId}`,
      actor: 'developer',
      body: { summary: '새 설명' },
    },
    {
      name: '버전 사진',
      method: 'put',
      path: `/api/versions/${draftId}/screens/${screenId}/asset`,
      actor: 'developer',
      photo: true,
    },
    {
      name: '버전 화면 제거',
      method: 'delete',
      path: `/api/versions/${draftId}/screens/${screenId}`,
      actor: 'developer',
    },
    { name: '게시', method: 'post', path: `/api/versions/${draftId}/publish`, actor: 'developer' },
    { name: '승인', method: 'post', path: `/api/versions/${versionId}/approve`, actor: 'client', body: { seenAt } },
    {
      name: '화면 만들기',
      method: 'post',
      path: `/api/projects/${projectId}/screens`,
      actor: 'developer',
      body: { name: '새 화면', viewport: 'MOBILE' },
    },
    { name: '화면 숨기기', method: 'post', path: `/api/screens/${screenId}/hide`, actor: 'developer' },
    { name: '화면 보이기', method: 'post', path: `/api/screens/${hiddenScreenId}/show`, actor: 'developer' },
    {
      name: '승인자 바꾸기',
      method: 'post',
      path: `/api/projects/${projectId}/approver`,
      actor: 'developer',
      body: { memberId: null },
    },
    {
      name: '초대 만들기',
      method: 'post',
      path: `/api/projects/${projectId}/invitations`,
      actor: 'developer',
      body: { email: 'new@example.com' },
    },
    {
      name: '초대 수락',
      method: 'post',
      path: '/api/invitations/accept',
      actor: 'invitee',
      body: { token: invitationToken },
    },
    {
      name: '쪽지 쓰기',
      method: 'post',
      path: `/api/projects/${projectId}/issues`,
      actor: 'developer',
      body: issueInput(),
    },
    {
      name: '쪽지 바꾸기',
      method: 'patch',
      path: `/api/issues/${issueId}`,
      actor: 'developer',
      body: { versionId, category: 'DESIGN', scope: 'IN_SCOPE', dueDate: '2026-12-01' },
    },
    {
      name: '댓글 쓰기',
      method: 'post',
      path: `/api/issues/${issueId}/comments`,
      actor: 'developer',
      body: commentInput(),
    },
    {
      name: '수정 시작',
      method: 'post',
      path: `/api/issues/${issueId}/start`,
      actor: 'developer',
      body: { versionId },
    },
    {
      name: '고쳤어요',
      method: 'post',
      path: `/api/issues/${issueId}/submit-resolution`,
      actor: 'developer',
      body: { versionId, summary: '고쳤어요' },
    },
    {
      name: '확인 완료',
      method: 'post',
      path: `/api/issues/${reviewIssueId}/verify`,
      actor: 'client',
      body: { versionId, attemptId },
    },
    {
      name: '재요청',
      method: 'post',
      path: `/api/issues/${reviewIssueId}/reopen`,
      actor: 'client',
      body: { versionId, attemptId, reason: '다시 고쳐 주세요' },
    },
    {
      name: '철회',
      method: 'post',
      path: `/api/issues/${reviewIssueId}/withdraw`,
      actor: 'client',
      body: { versionId, reason: '요청을 취소해요' },
    },
    {
      name: '참고 사진 추가',
      method: 'post',
      path: `/api/issues/${issueId}/attachments`,
      actor: 'developer',
      photo: true,
    },
    {
      name: '참고 사진 제거',
      method: 'delete',
      path: `/api/issues/${issueId}/attachments/${attachmentId}`,
      actor: 'developer',
    },
    {
      name: '접근 철회',
      method: 'post',
      path: `/api/members/${clientMemberId}/revoke`,
      actor: 'developer',
      allowArchived: true,
    },
  ];

  const sendWrite = (
    operation: WriteRequest,
    memberCookie = { developer: cookie, client: clientCookie, invitee: inviteeCookie }[operation.actor],
  ) => {
    const outgoing = request(server)
      [operation.method](operation.path)
      .set('Origin', origin)
      .set('Cookie', memberCookie);
    if (operation.photo) return outgoing.attach('file', photo, 'screen.png');
    if (operation.body) return outgoing.send(operation.body);
    return outgoing;
  };

  const readPaths = () => [
    `/api/projects/${projectId}`,
    `/api/projects/${projectId}/versions`,
    `/api/versions/${versionId}`,
    `/api/projects/${projectId}/issues`,
    `/api/issues/${issueId}`,
    `/api/assets/${assetId}`,
    `/api/assets/${attachmentAssetId}`,
    `/api/projects/${projectId}/activity`,
    `/api/projects/${projectId}/screens`,
  ];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'archive-e2e-'));
    vi.stubEnv('ASSET_DIR', directory);
    vi.stubEnv('APP_ORIGINS', origin);
    vi.stubEnv('APP_URL', origin);
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
    const invitee = await prisma.user.create({ data: { email: 'invitee@example.com', name: '초대받은 사람' } });
    const outsider = await prisma.user.create({ data: { email: 'outsider@example.com', name: '외부인' } });
    const revoked = await prisma.user.create({ data: { email: 'revoked@example.com', name: '철회된 사람' } });
    developerId = developer.id;
    clientId = client.id;
    const project = await prisma.project.create({
      data: {
        name: '보관 검수 프로젝트',
        members: {
          create: [
            { userId: developer.id, role: 'DEVELOPER' },
            { userId: client.id, role: 'CLIENT' },
            { userId: revoked.id, role: 'CLIENT', revokedAt: new Date() },
          ],
        },
      },
      include: { members: true },
    });
    projectId = project.id;
    clientMemberId = project.members.find((member) => member.userId === client.id)!.id;
    await prisma.project.update({ where: { id: projectId }, data: { approverMemberId: clientMemberId } });
    cookie = await login(developer.id);
    clientCookie = await login(client.id);
    inviteeCookie = await login(invitee.id);
    outsiderCookie = await login(outsider.id);
    revokedCookie = await login(revoked.id);
    photo = await sharp({ create: { width: 32, height: 24, channels: 3, background: 'red' } })
      .png()
      .toBuffer();
    const screen = await prisma.screen.create({ data: { projectId, name: '첫 화면', viewport: 'PC' } });
    screenId = screen.id;
    hiddenScreenId = (
      await prisma.screen.create({ data: { projectId, name: '숨긴 화면', viewport: 'PC', hiddenAt: new Date() } })
    ).id;
    const draft = await post(`/api/projects/${projectId}/versions`).expect(201);
    versionId = draft.body.id;
    const uploaded = await request(server)
      .put(`/api/versions/${versionId}/screens/${screenId}/asset`)
      .set('Origin', origin)
      .set('Cookie', cookie)
      .attach('file', photo, 'screen.png')
      .expect(200);
    assetId = uploaded.body.screens[0].asset.id;
    await post(`/api/versions/${versionId}/publish`).expect(200);
    issueId = (await post(`/api/projects/${projectId}/issues`).send(issueInput()).expect(201)).body.id;
    reviewIssueId = (await post(`/api/projects/${projectId}/issues`, clientCookie).send(issueInput()).expect(201)).body
      .id;
    // 승인도 다른 오류 없이 가능한 준비 상태다. 범위 밖 쪽지는 미해결이어도 승인을 막지 않는다.
    for (const id of [issueId, reviewIssueId]) {
      await patch(`/api/issues/${id}`).send({ versionId, scope: 'OUT_OF_SCOPE' }).expect(200);
    }
    const attached = await post(`/api/issues/${issueId}/attachments`)
      .attach('file', photo, 'reference.png')
      .expect(201);
    attachmentId = attached.body.attachments[0].id;
    attachmentAssetId = attached.body.attachments[0].assetId;
    const resolution = await post(`/api/issues/${reviewIssueId}/submit-resolution`)
      .send({ versionId, summary: '확인해 주세요' })
      .expect(200);
    attemptId = resolution.body.attempts[0].id;
    draftId = (await post(`/api/projects/${projectId}/versions`).expect(201)).body.id;
    const invitation = await post(`/api/projects/${projectId}/invitations`).send({ email: invitee.email }).expect(201);
    invitationToken = invitation.body.link.split('/').at(-1);
    seenAt = (await get(`/api/versions/${versionId}/approval-check`, clientCookie).expect(200)).body.serverTime;
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

  it('보관하면 쪽지·댓글·게시·쪽지 바꾸기가 409로 막히고 보관을 풀면 다시 된다', async () => {
    const issue = issueInput();
    const comment = commentInput();
    const changes = [{ category: 'DESIGN' }, { scope: 'IN_SCOPE' }, { dueDate: '2026-12-01' }];
    await setStatus('ARCHIVED');
    const before = await readState();
    await post(`/api/projects/${projectId}/issues`, clientCookie).send(issue).expect(409).expect(archivedBody);
    await post(`/api/issues/${issueId}/comments`, clientCookie).send(comment).expect(409).expect(archivedBody);
    await post(`/api/versions/${draftId}/publish`).expect(409).expect(archivedBody);
    for (const change of changes) {
      await patch(`/api/issues/${issueId}`)
        .send({ versionId, ...change })
        .expect(409)
        .expect(archivedBody);
    }
    expect(await readState()).toEqual(before);

    await setStatus('ACTIVE');
    const created = await post(`/api/projects/${projectId}/issues`, clientCookie).send(issue).expect(201);
    expect(created.body).toMatchObject({ title: issue.title, body: issue.body });
    const commented = await post(`/api/issues/${issueId}/comments`, clientCookie).send(comment).expect(201);
    expect(commented.body.body).toBe(comment.body);
    for (const change of changes) {
      const changed = await patch(`/api/issues/${issueId}`)
        .send({ versionId, ...change })
        .expect(200);
      expect(changed.body).toMatchObject(change);
    }
    await post(`/api/versions/${draftId}/publish`).expect(200);
    expect(await prisma.issue.count({ where: { requestId: issue.requestId } })).toBe(1);
    expect(await prisma.comment.count({ where: { requestId: comment.requestId } })).toBe(1);
    expect(await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).toMatchObject({
      status: 'ACTIVE',
      currentVersionId: draftId,
    });
  });

  it('보관 중에는 그 API의 권한이 있는 사람의 새 쓰기 요청이 모든 쓰기 API에서 PROJECT_ARCHIVED로 막힌다', async () => {
    await setStatus('ARCHIVED');
    const operations = writeRequests();
    expect(operations).toHaveLength(23);
    const before = await readState();
    for (const operation of operations.filter((entry) => !entry.allowArchived)) {
      const response = await sendWrite(operation);
      expect(response.status, operation.name).toBe(409);
      expect(response.body, operation.name).toEqual(archivedBody);
    }
    // 승인 창은 읽기라서 보관 중에도 열린다.
    await get(`/api/versions/${versionId}/approval-check`, clientCookie).expect(200);
    expect(await readState()).toEqual(before);
    await sendWrite(operations.find((entry) => entry.allowArchived)!).expect(204);
    expect(await prisma.projectMember.findUniqueOrThrow({ where: { id: clientMemberId } })).toMatchObject({
      revokedAt: expect.any(Date),
    });
  });

  it('삭제 대기 중에는 개발자가 할 수 있는 모든 쓰기 API가 PROJECT_DELETE_PENDING으로 막히고 클라이언트는 404다', async () => {
    await setStatus('DELETE_PENDING');
    const operations = writeRequests();
    expect(operations).toHaveLength(23);
    const before = await readState();
    for (const operation of operations) {
      const response = await sendWrite(operation);
      expect(response.status, operation.name).toBe(operation.actor === 'developer' ? 409 : 404);
      if (operation.actor === 'developer') expect(response.body, operation.name).toEqual(deletePendingBody);
    }
    // 클라이언트는 원래 개발자 전용인 쓰기를 시도해도 403이 아닌 404를 받는다.
    for (const operation of operations.filter((entry) => entry.actor !== 'invitee')) {
      await sendWrite(operation, clientCookie).expect(404);
    }
    await get(`/api/versions/${versionId}/approval-check`, clientCookie).expect(404);
    expect(await readState()).toEqual(before);
  });

  it('멤버가 아니거나 철회된 사람이 보관·삭제 대기 프로젝트에 쓰면 409가 아니라 404다', async () => {
    for (const status of ['ARCHIVED', 'DELETE_PENDING'] as const) {
      await setStatus(status);
      const before = await readState();
      // 초대 수락은 아직 멤버가 아닌 초대받은 사람이 쓰는 API라 위의 별도 줄에서 확인한다.
      for (const operation of writeRequests().filter((entry) => entry.actor !== 'invitee')) {
        const responses = await Promise.all([
          sendWrite(operation, outsiderCookie),
          sendWrite(operation, revokedCookie),
        ]);
        expect(
          responses.map((response) => response.status),
          operation.name,
        ).toEqual([404, 404]);
        expect(
          responses.map((response) => response.body.code),
          operation.name,
        ).toEqual([undefined, undefined]);
      }
      expect(await readState()).toEqual(before);
    }
  }, 20_000);

  it('보관 중에도 게시 전 버전은 클라이언트에게 404, 권한 없는 쪽지 바꾸기는 403이다', async () => {
    await setStatus('ARCHIVED');
    const before = await readState();
    const draftWrites = writeRequests().filter((entry) => entry.path.startsWith(`/api/versions/${draftId}`));
    for (const operation of draftWrites) await sendWrite(operation, clientCookie).expect(404);
    await get(`/api/versions/${draftId}`, clientCookie).expect(404);
    await get(`/api/versions/${draftId}/approval-check`, clientCookie).expect(404);
    await post(`/api/versions/${draftId}/approve`, clientCookie).send({ seenAt }).expect(404);
    for (const change of [{ category: 'DESIGN' }, { scope: 'IN_SCOPE' }, { dueDate: '2026-12-01' }]) {
      await patch(`/api/issues/${issueId}`, clientCookie)
        .send({ versionId, ...change })
        .expect(403);
    }
    await post(`/api/issues/${issueId}/attachments`, clientCookie).attach('file', photo, 'reference.png').expect(403);
    await post(`/api/issues/${issueId}/start`, clientCookie).send({ versionId }).expect(403);
    await post(`/api/versions/${versionId}/approve`).send({ seenAt }).expect(403);
    // 자기가 쓴 쪽지의 분류를 바꿀 권한은 있으므로 보관 오류까지 도달한다.
    await patch(`/api/issues/${reviewIssueId}`, clientCookie)
      .send({ versionId, category: 'DESIGN' })
      .expect(409)
      .expect(archivedBody);
    expect(await readState()).toEqual(before);
  });

  it('보관한 프로젝트에서도 접근 철회는 된다', async () => {
    const token = createSessionToken();
    await prisma.invitation.create({
      data: {
        projectId,
        email: 'client@example.com',
        tokenHash: hashSessionToken(token),
        invitedById: developerId,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    await setStatus('ARCHIVED');
    await post(`/api/members/${clientMemberId}/revoke`).expect(204);
    expect(await prisma.projectMember.findUniqueOrThrow({ where: { id: clientMemberId } })).toMatchObject({
      revokedAt: expect.any(Date),
    });
    expect(await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).toMatchObject({
      status: 'ARCHIVED',
      approverMemberId: null,
    });
    expect(await prisma.invitation.findUniqueOrThrow({ where: { tokenHash: hashSessionToken(token) } })).toMatchObject({
      revokedAt: expect.any(Date),
    });
    expect(await prisma.activityEvent.findMany({ where: { projectId, type: 'MEMBER_REVOKED' } })).toEqual([
      expect.objectContaining({ actorId: developerId, memberId: clientMemberId }),
    ]);
    for (const path of readPaths()) await get(path, clientCookie).expect(404);
    await get('/api/projects', clientCookie).expect(200).expect([]);
  });

  it('쪽지 쓰기가 잠금을 기다리는 동안 보관되면 쪽지 쓰기는 409다', async () => {
    const input = issueInput();
    let pending: Promise<request.Response> | undefined;
    let settled = false;
    const before = await readState();
    try {
      await prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM projects WHERE id = ${projectId}::uuid FOR UPDATE`;
          pending = (async () => {
            try {
              return await post(`/api/projects/${projectId}/issues`).send(input);
            } finally {
              settled = true;
            }
          })();
          // 시간을 재서 추측하지 않고, 이 트랜잭션이 다른 연결을 실제로 막고 있음을 확인한다.
          const deadline = Date.now() + 5_000;
          let waiting = false;
          while (!waiting && Date.now() < deadline) {
            await tx.$executeRaw`SELECT pg_stat_clear_snapshot()`;
            const [row] = await tx.$queryRaw<{ waiting: boolean }[]>`
            SELECT EXISTS (
              SELECT 1 FROM pg_stat_activity
              WHERE datname = current_database()
                AND pg_backend_pid() = ANY(pg_blocking_pids(pid))
                AND query LIKE '%projects%' AND wait_event_type = 'Lock'
            ) AS waiting`;
            waiting = row.waiting;
            if (!waiting) await delay(20);
          }
          expect(waiting).toBe(true);
          expect(settled).toBe(false);
          await tx.project.update({ where: { id: projectId }, data: { status: 'ARCHIVED' } });
        },
        { timeout: 10_000 },
      );
    } finally {
      // 검증이 실패해도 잠금을 풀고 진행 중 요청을 거둔 뒤 앱과 DB를 정리한다.
      await pending;
    }
    const response = await pending;
    expect(response?.status).toBe(409);
    expect(response?.body).toEqual(archivedBody);
    expect(await readState()).toEqual({
      ...before,
      projects: before.projects.map((project) => ({ ...project, status: 'ARCHIVED' })),
    });
  }, 20_000);

  it('저장된 쪽지·댓글을 보관 뒤 같은 requestId로 다시 보내면 저장된 결과를 돌려준다', async () => {
    const saved = [];
    for (const memberCookie of [cookie, clientCookie]) {
      const issue = issueInput();
      const comment = commentInput();
      const created = await post(`/api/projects/${projectId}/issues`, memberCookie).send(issue).expect(201);
      const commented = await post(`/api/issues/${issueId}/comments`, memberCookie).send(comment).expect(201);
      saved.push({ memberCookie, issue, comment, created: created.body, commented: commented.body });
    }
    await setStatus('ARCHIVED');
    const before = await readState();
    for (const entry of saved) {
      await post(`/api/projects/${projectId}/issues`, entry.memberCookie)
        .send(entry.issue)
        .expect(201)
        .expect(entry.created);
      await post(`/api/issues/${issueId}/comments`, entry.memberCookie)
        .send(entry.comment)
        .expect(201)
        .expect(entry.commented);
      await post(`/api/projects/${projectId}/issues`, entry.memberCookie)
        .send(issueInput())
        .expect(409)
        .expect(archivedBody);
      await post(`/api/issues/${issueId}/comments`, entry.memberCookie)
        .send(commentInput())
        .expect(409)
        .expect(archivedBody);
    }
    expect(await readState()).toEqual(before);
  });

  it('개발자가 저장된 쪽지·댓글을 삭제 대기 뒤 같은 requestId로 다시 보내면 저장된 결과를 돌려준다', async () => {
    const issue = issueInput();
    const comment = commentInput();
    const created = await post(`/api/projects/${projectId}/issues`).send(issue).expect(201);
    const commented = await post(`/api/issues/${issueId}/comments`).send(comment).expect(201);
    await setStatus('DELETE_PENDING');
    const before = await readState();
    await post(`/api/projects/${projectId}/issues`).send(issue).expect(201).expect(created.body);
    await post(`/api/issues/${issueId}/comments`).send(comment).expect(201).expect(commented.body);
    await post(`/api/projects/${projectId}/issues`).send(issueInput()).expect(409).expect(deletePendingBody);
    await post(`/api/issues/${issueId}/comments`).send(commentInput()).expect(409).expect(deletePendingBody);
    expect(await readState()).toEqual(before);
  });

  it('삭제 대기 뒤 클라이언트의 같은 requestId 재전송도 쪽지·댓글 모두 404다', async () => {
    const issue = issueInput();
    const comment = commentInput();
    await post(`/api/projects/${projectId}/issues`, clientCookie).send(issue).expect(201);
    await post(`/api/issues/${issueId}/comments`, clientCookie).send(comment).expect(201);
    await setStatus('DELETE_PENDING');
    const before = await readState();
    await post(`/api/projects/${projectId}/issues`, clientCookie).send(issue).expect(404);
    await post(`/api/issues/${issueId}/comments`, clientCookie).send(comment).expect(404);
    expect(await readState()).toEqual(before);
  });

  it('삭제하면 클라이언트의 프로젝트·버전·쪽지·사진·일지 요청이 모두 404다', async () => {
    await post(`/api/versions/${versionId}/approve`, clientCookie).send({ seenAt }).expect(200);
    await get(`/api/versions/${versionId}/certificate`, clientCookie).expect(200);
    for (const path of readPaths()) await get(path, clientCookie).expect(200);
    await get(`/api/projects/${projectId}/members`, clientCookie).expect(403);
    await setStatus('DELETE_PENDING');
    for (const path of readPaths()) await get(path, clientCookie).expect(404);
    await get(`/api/versions/${versionId}/approval-check`, clientCookie).expect(404);
    await get(`/api/versions/${draftId}`, clientCookie).expect(404);
    await get(`/api/projects/${projectId}/members`, clientCookie).expect(404);
    await get(`/api/versions/${versionId}/certificate`, clientCookie).expect(404);
    await get(`/api/versions/${versionId}/certificate`).expect(200);
  });

  it('삭제 대기 프로젝트의 초대는 조회와 수락 모두 404다', async () => {
    await request(server).get(`/api/invitations/${invitationToken}`).expect(200);
    await setStatus('DELETE_PENDING');
    const before = await readState();
    const missing = await request(server).get(`/api/invitations/${createSessionToken()}`).expect(404);
    await request(server).get(`/api/invitations/${invitationToken}`).expect(404).expect(missing.body);
    await post('/api/invitations/accept', inviteeCookie)
      .send({ token: invitationToken })
      .expect(404)
      .expect(missing.body);
    expect(await readState()).toEqual(before);
  });

  it('개발자 목록에는 삭제 대기와 완전히 지울 날이 보이고 클라이언트 목록에서는 빠진다', async () => {
    for (const status of ['ACTIVE', 'ARCHIVED'] as const) {
      await setStatus(status);
      for (const memberCookie of [cookie, clientCookie]) {
        const list = await get('/api/projects', memberCookie).expect(200);
        expect(list.body).toEqual([expect.objectContaining({ id: projectId, status, purgeAfter: null })]);
        const detail = await get(`/api/projects/${projectId}`, memberCookie).expect(200);
        expect(detail.body).toMatchObject({ id: projectId, status, purgeAfter: null });
      }
    }
    // 삭제된 줄을 거르다가 다른 진행·보관 프로젝트까지 빠뜨리지 않아야 한다.
    const active = await prisma.project.create({
      data: {
        name: '남아 있는 진행 프로젝트',
        members: {
          create: [
            { userId: developerId, role: 'DEVELOPER' },
            { userId: clientId, role: 'CLIENT' },
          ],
        },
      },
    });
    const archived = await prisma.project.create({
      data: {
        name: '남아 있는 보관 프로젝트',
        status: 'ARCHIVED',
        members: {
          create: [
            { userId: developerId, role: 'DEVELOPER' },
            { userId: clientId, role: 'CLIENT' },
          ],
        },
      },
    });
    const deletedAt = new Date('2026-11-14T12:34:56.789Z');
    await setStatus('DELETE_PENDING', deletedAt);
    const developerList = await get('/api/projects').expect(200);
    expect(developerList.body).toHaveLength(3);
    expect(developerList.body).toContainEqual(
      expect.objectContaining({
        id: projectId,
        myRole: 'DEVELOPER',
        status: 'DELETE_PENDING',
        purgeAfter: '2026-11-21T12:34:56.789Z',
      }),
    );
    const detail = await get(`/api/projects/${projectId}`).expect(200);
    expect(detail.body).toMatchObject({ status: 'DELETE_PENDING', purgeAfter: '2026-11-21T12:34:56.789Z' });
    const clientList = await get('/api/projects', clientCookie).expect(200);
    expect(clientList.body).toHaveLength(2);
    expect(clientList.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: active.id, status: 'ACTIVE', purgeAfter: null }),
        expect.objectContaining({ id: archived.id, status: 'ARCHIVED', purgeAfter: null }),
      ]),
    );
    await get(`/api/projects/${projectId}`, clientCookie).expect(404);
  });

  it('개발자는 삭제 대기 프로젝트를 읽기만 하고 활동 일지에서 기록 메일 실패를 본다', async () => {
    await setStatus('DELETE_PENDING');
    const event = await prisma.activityEvent.create({
      data: {
        projectId,
        actorId: developerId,
        type: 'PROJECT_DELETE_REQUESTED',
        deliveries: { create: { toEmail: 'developer@example.com', status: 'FAILED', attempts: 5 } },
      },
    });
    const before = await readState();
    for (const path of readPaths()) await get(path).expect(200);
    await get(`/api/projects/${projectId}/members`).expect(200);
    await get(`/api/versions/${draftId}`).expect(200);
    const activity = await get(`/api/projects/${projectId}/activity`).expect(200);
    expect(activity.body).toContainEqual({
      id: event.id,
      type: 'PROJECT_DELETE_REQUESTED',
      createdAt: event.createdAt.toISOString(),
      actorName: '개발자',
      version: null,
      memberName: null,
      issue: null,
      mailFailedTo: ['developer@example.com'],
    });
    await post(`/api/issues/${issueId}/comments`).send(commentInput()).expect(409).expect(deletePendingBody);
    await get(`/api/projects/${projectId}/activity`, clientCookie).expect(404);
    expect(await readState()).toEqual(before);
  });
});
