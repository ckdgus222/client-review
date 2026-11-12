import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
const missingId = '00000000-0000-4000-8000-000000000001';
const issueNotFoundBody = { statusCode: 404, message: '없는 쪽지예요', error: 'Not Found' };
const versionChangedBody = { statusCode: 409, message: '새 버전이 올라왔어요', code: 'VERSION_CHANGED' };

describe('쪽지 정리 API (e2e)', () => {
  let app: INestApplication | undefined;
  let server: Server;
  let prisma: PrismaService;
  let directory: string;
  let projectId: string;
  let versionId: string;
  let screenId: string;
  let issueId: string;
  let developerId: string;
  let clientId: string;
  let cookie: string;
  let clientCookie: string;
  let approverCookie: string;
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
  const createIssue = (body: Record<string, unknown>, memberCookie = cookie, targetProjectId = projectId) =>
    post(`/api/projects/${targetProjectId}/issues`, memberCookie).send(body);
  const issueInput = (changes: Record<string, unknown> = {}) => ({
    requestId: randomUUID(),
    versionId,
    title: '버튼을 고쳐 주세요',
    body: '  첫 줄\n둘째 줄  ',
    ...changes,
  });
  const upload = (targetVersionId: string, targetScreenId: string, image = photo) =>
    request(server)
      .put(`/api/versions/${targetVersionId}/screens/${targetScreenId}/asset`)
      .set('Origin', origin)
      .set('Cookie', cookie)
      .attach('file', image, 'screen.png')
      .expect(200);
  const createDraft = (targetProjectId = projectId) => post(`/api/projects/${targetProjectId}/versions`).expect(201);
  const publish = (targetVersionId: string) => post(`/api/versions/${targetVersionId}/publish`).expect(200);

  const readState = async () => ({
    comments: await prisma.comment.findMany({ orderBy: { id: 'asc' } }),
    issues: await prisma.issue.findMany({ orderBy: { id: 'asc' } }),
    events: await prisma.activityEvent.findMany({ orderBy: { id: 'asc' } }),
  });

  const update = (changes: Record<string, unknown>, memberCookie = cookie, targetIssueId = issueId) =>
    request(server)
      .patch(`/api/issues/${targetIssueId}`)
      .set('Origin', origin)
      .set('Cookie', memberCookie)
      .send({ versionId, ...changes });

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'issue-triage-e2e-'));
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
    developerId = developer.id;
    clientId = client.id;
    const project = await prisma.project.create({
      data: {
        name: '쪽지 검수 프로젝트',
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
      data: { approverMemberId: project.members.find((member) => member.userId === approver.id)!.id },
    });
    cookie = await login(developer.id);
    clientCookie = await login(client.id);
    approverCookie = await login(approver.id);
    const screen = await prisma.screen.create({ data: { projectId, name: '첫 화면', viewport: 'PC' } });
    screenId = screen.id;
    photo = await sharp({ create: { width: 32, height: 24, channels: 3, background: 'red' } })
      .png()
      .toBuffer();
    const draft = await createDraft();
    versionId = draft.body.id;
    await upload(versionId, screenId);
    await publish(versionId);
    const issue = await createIssue(issueInput(), clientCookie).expect(201);
    issueId = issue.body.id;
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

  it.each([
    ['클라이언트', '범위를', { scope: 'OUT_OF_SCOPE' }],
    ['클라이언트', '마감일을', { dueDate: '2026-11-15' }],
    ['승인자', '범위를', { scope: 'OUT_OF_SCOPE' }],
    ['승인자', '마감일을', { dueDate: '2026-11-15' }],
  ] as const)('%s가 %s 바꾸면 403이고 쪽지와 댓글이 그대로다', async (role, _field, changes) => {
    const before = await readState();
    await update(changes, role === '클라이언트' ? clientCookie : approverCookie).expect(403);
    expect(await readState()).toEqual(before);
  });

  it('클라이언트가 남이 쓴 쪽지의 분류를 바꾸면 403이고 분류가 그대로다', async () => {
    const other = await createIssue(issueInput()).expect(201);
    const before = await readState();
    await update({ category: 'DESIGN' }, clientCookie, other.body.id).expect(403);
    expect(await readState()).toEqual(before);
  });

  it('쓴 사람은 자기 쪽지의 분류를 바꾸고 개발자는 남의 쪽지의 분류도 바꾼다', async () => {
    const before = await readState();
    const own = await update({ category: 'DESIGN' }, clientCookie).expect(200);
    expect(own.body).toMatchObject({ id: issueId, category: 'DESIGN', scope: 'IN_SCOPE', dueDate: null, isMine: true });
    const developer = await update({ category: 'COPY' }).expect(200);
    expect(developer.body).toEqual({ ...own.body, category: 'COPY', isMine: false });
    await get(`/api/issues/${issueId}`).expect(200).expect(developer.body);
    const list = await get(`/api/projects/${projectId}/issues`).expect(200);
    expect(list.body).toEqual([
      expect.objectContaining({ id: issueId, category: 'COPY', scope: 'IN_SCOPE', dueDate: null }),
    ]);
    const after = await readState();
    expect(after.issues).toEqual(before.issues.map((issue) => ({ ...issue, category: 'COPY' })));
    expect(after.comments).toEqual(before.comments);
    expect(after.events).toEqual(before.events);
  });

  it('승인자도 자기 쪽지의 분류만 바꾸고 남의 쪽지 분류는 바꿀 수 없다', async () => {
    const own = await createIssue(issueInput(), approverCookie).expect(201);
    await update({ category: 'OTHER' }, approverCookie, own.body.id)
      .expect(200)
      .expect({ ...own.body, category: 'OTHER' });
    const before = await readState();
    await update({ category: 'OTHER' }, approverCookie).expect(403);
    expect(await readState()).toEqual(before);
  });

  it('권한 없는 칸이 섞인 요청은 403이고 바꿀 수 있는 칸도 저장하지 않는다', async () => {
    const before = await readState();
    for (const changes of [
      { category: 'DESIGN', scope: 'OUT_OF_SCOPE' },
      { category: 'COPY', dueDate: '2026-11-15' },
      { category: 'OTHER', scope: 'OUT_OF_SCOPE', dueDate: '2026-11-15' },
      { category: 'DESIGN', scope: 'IN_SCOPE', dueDate: null },
    ]) {
      await update(changes, clientCookie).expect(403);
      expect(await readState()).toEqual(before);
    }
  });

  it('범위를 바꾸면 바꾸기 전과 뒤 값이 적힌 댓글이 개발자 이름과 현재 버전으로 남는다', async () => {
    const before = await get(`/api/issues/${issueId}`).expect(200);
    const draft = await createDraft();
    const current = await publish(draft.body.id);
    const response = await update({ versionId: draft.body.id, scope: 'OUT_OF_SCOPE' }).expect(200);
    expect(response.body).toEqual({
      ...before.body,
      scope: 'OUT_OF_SCOPE',
      commentCount: 1,
      comments: [
        {
          id: expect.any(String),
          authorName: '개발자',
          versionNumber: current.body.number,
          body: '범위: 하자 수정 → 추가 요청',
          createdAt: expect.any(String),
        },
      ],
    });
    const [comment] = response.body.comments;
    expect(new Date(comment.createdAt).toISOString()).toBe(comment.createdAt);
    expect(await prisma.comment.findMany()).toEqual([
      expect.objectContaining({
        id: comment.id,
        issueId,
        authorId: developerId,
        versionId: draft.body.id,
        body: '범위: 하자 수정 → 추가 요청',
        requestId: null,
        createdAt: new Date(comment.createdAt),
      }),
    ]);
    await get(`/api/issues/${issueId}`).expect(200).expect(response.body);
    const list = await get(`/api/projects/${projectId}/issues`).expect(200);
    expect(list.body).toEqual([expect.objectContaining({ id: issueId, scope: 'OUT_OF_SCOPE', commentCount: 1 })]);
  });

  it('마감일을 정하고 바꾸고 지우면 댓글이 차례로 쌓이고 지난 댓글은 그대로다', async () => {
    const first = await update({ dueDate: '2026-11-10' }).expect(200);
    const savedFirst = (await readState()).comments;
    const second = await update({ dueDate: '2027-01-05' }).expect(200);
    expect(second.body.comments.slice(0, 1)).toEqual(first.body.comments);
    expect((await readState()).comments).toEqual(expect.arrayContaining(savedFirst));
    const savedSecond = (await readState()).comments;
    const third = await update({ dueDate: null }).expect(200);
    expect(third.body).toMatchObject({ dueDate: null, category: 'BUG', scope: 'IN_SCOPE', commentCount: 3 });
    expect(third.body.comments.slice(0, 2)).toEqual(second.body.comments);
    expect(third.body.comments.map((comment: { body: string }) => comment.body)).toEqual([
      '마감일: 없음 → 2026년 11월 10일',
      '마감일: 2026년 11월 10일 → 2027년 1월 5일',
      '마감일: 2027년 1월 5일 → 없음',
    ]);
    expect((await readState()).comments).toEqual(expect.arrayContaining(savedSecond));
    expect(await prisma.comment.count()).toBe(3);
    expect(await prisma.issue.findUniqueOrThrow({ where: { id: issueId } })).toMatchObject({ dueDate: null });
    await get(`/api/issues/${issueId}`).expect(200).expect(third.body);
    const list = await get(`/api/projects/${projectId}/issues`).expect(200);
    expect(list.body).toEqual([expect.objectContaining({ id: issueId, dueDate: null, commentCount: 3 })]);
  });

  it('범위와 마감일을 함께 바꾸면 범위 댓글과 마감일 댓글이 차례로 하나씩 남는다', async () => {
    const before = await get(`/api/issues/${issueId}`).expect(200);
    const response = await update({ category: 'OTHER', scope: 'OUT_OF_SCOPE', dueDate: '2026-11-15' }).expect(200);
    const comments = [
      {
        id: expect.any(String),
        authorName: '개발자',
        versionNumber: 0,
        body: '범위: 하자 수정 → 추가 요청',
        createdAt: expect.any(String),
      },
      {
        id: expect.any(String),
        authorName: '개발자',
        versionNumber: 0,
        body: '마감일: 없음 → 2026년 11월 15일',
        createdAt: expect.any(String),
      },
    ];
    expect(response.body).toEqual({
      ...before.body,
      category: 'OTHER',
      scope: 'OUT_OF_SCOPE',
      dueDate: '2026-11-15',
      commentCount: 2,
      comments,
    });
    expect(await prisma.comment.findMany({ orderBy: { createdAt: 'asc' } })).toEqual([
      expect.objectContaining({ body: comments[0].body, authorId: developerId, versionId, requestId: null }),
      expect.objectContaining({ body: comments[1].body, authorId: developerId, versionId, requestId: null }),
    ]);
    expect(await prisma.issue.findUniqueOrThrow({ where: { id: issueId } })).toMatchObject({
      category: 'OTHER',
      scope: 'OUT_OF_SCOPE',
      dueDate: new Date('2026-11-15T00:00:00.000Z'),
    });
    await get(`/api/issues/${issueId}`).expect(200).expect(response.body);
    const list = await get(`/api/projects/${projectId}/issues`).expect(200);
    expect(list.body).toEqual([
      expect.objectContaining({
        id: issueId,
        category: 'OTHER',
        scope: 'OUT_OF_SCOPE',
        dueDate: '2026-11-15',
        commentCount: 2,
      }),
    ]);
  });

  it('같은 값으로 바꾸면 200이고 댓글이 생기지 않는다', async () => {
    const initial = await get(`/api/issues/${issueId}`).expect(200);
    const before = await readState();
    for (const changes of [
      { category: 'BUG' },
      { scope: 'IN_SCOPE' },
      { dueDate: null },
      { category: 'BUG', scope: 'IN_SCOPE', dueDate: null },
    ]) {
      await update(changes).expect(200).expect(initial.body);
      expect(await readState()).toEqual(before);
    }
    const changes = { category: 'DESIGN', scope: 'OUT_OF_SCOPE', dueDate: '2026-11-15' };
    const changed = await update(changes).expect(200);
    const saved = await readState();
    await update(changes).expect(200).expect(changed.body);
    expect(await readState()).toEqual(saved);
    expect(saved.comments).toHaveLength(2);
  });

  it('저장된 범위 변경을 다시 보내면 댓글이 하나만 남고 그사이 다른 값으로 바뀌었으면 새 변경으로 저장되어 댓글이 차례로 이어진다', async () => {
    const input = { scope: 'OUT_OF_SCOPE' };
    const first = await update(input).expect(200);
    const saved = await readState();
    await update(input).expect(200).expect(first.body);
    expect(await readState()).toEqual(saved);
    expect(saved.comments).toHaveLength(1);
    const second = await update({ scope: 'IN_SCOPE' }).expect(200);
    const third = await update(input).expect(200);
    expect(third.body.scope).toBe('OUT_OF_SCOPE');
    expect(third.body.comments.slice(0, 2)).toEqual(second.body.comments);
    expect(third.body.comments.slice(0, 1)).toEqual(first.body.comments);
    expect(third.body.comments.map((comment: { body: string }) => comment.body)).toEqual([
      '범위: 하자 수정 → 추가 요청',
      '범위: 추가 요청 → 하자 수정',
      '범위: 하자 수정 → 추가 요청',
    ]);
    expect(await prisma.comment.count()).toBe(3);
    await get(`/api/issues/${issueId}`).expect(200).expect(third.body);
  });

  it('댓글 저장이 실패하면 범위와 마감일도 바뀌지 않는다', async () => {
    await post(`/api/issues/${issueId}/comments`, clientCookie)
      .send({ requestId: randomUUID(), versionId, body: '기존 댓글은 남아야 해요' })
      .expect(201);
    const before = await readState();
    const detail = await get(`/api/issues/${issueId}`).expect(200);
    try {
      // 두 번째 자동 댓글에서 실패시켜 앞서 저장한 범위 댓글도 함께 되돌아가는지 확인한다.
      await prisma.$executeRaw`
        CREATE FUNCTION issue_triage_e2e_fail_comment() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.body LIKE '마감일: %' THEN
            RAISE EXCEPTION 'issue triage e2e comment failure';
          END IF;
          RETURN NEW;
        END;
        $$
      `;
      await prisma.$executeRaw`
        CREATE TRIGGER issue_triage_e2e_fail_comment
        BEFORE INSERT ON comments FOR EACH ROW
        EXECUTE FUNCTION issue_triage_e2e_fail_comment()
      `;
      await update({ category: 'DESIGN', scope: 'OUT_OF_SCOPE', dueDate: '2026-11-15' }).expect(500);
      expect(await readState()).toEqual(before);
      await get(`/api/issues/${issueId}`).expect(200).expect(detail.body);
    } finally {
      try {
        await prisma.$executeRaw`DROP TRIGGER IF EXISTS issue_triage_e2e_fail_comment ON comments`;
      } finally {
        await prisma.$executeRaw`DROP FUNCTION IF EXISTS issue_triage_e2e_fail_comment()`;
      }
    }
    const retry = await update({ scope: 'OUT_OF_SCOPE', dueDate: '2026-11-15' }).expect(200);
    expect(retry.body).toMatchObject({ scope: 'OUT_OF_SCOPE', dueDate: '2026-11-15', commentCount: 3 });
    expect(retry.body.comments.slice(0, 1)).toEqual(detail.body.comments);
  });

  it('보고 있던 버전이 현재 버전이 아니면 409 VERSION_CHANGED이고 아무것도 바뀌지 않는다', async () => {
    const draft = await createDraft();
    await publish(draft.body.id);
    const before = await readState();
    for (const changes of [
      { category: 'DESIGN' },
      { scope: 'OUT_OF_SCOPE' },
      { dueDate: '2026-11-15' },
      { category: 'BUG', scope: 'IN_SCOPE', dueDate: null },
    ]) {
      await update(changes).expect(409).expect(versionChangedBody);
      expect(await readState()).toEqual(before);
    }
  });

  it('현재 버전이 승인됐으면 409 VERSION_NOT_IN_REVIEW이고 아무것도 바뀌지 않는다', async () => {
    await prisma.deliveryVersion.update({ where: { id: versionId }, data: { status: 'APPROVED' } });
    const before = await readState();
    for (const changes of [
      { category: 'DESIGN' },
      { scope: 'OUT_OF_SCOPE' },
      { dueDate: '2026-11-15' },
      { category: 'BUG', scope: 'IN_SCOPE', dueDate: null },
    ]) {
      await update(changes).expect(409).expect({
        statusCode: 409,
        code: 'VERSION_NOT_IN_REVIEW',
        message: '검수 중인 버전이 아니에요',
      });
      expect(await readState()).toEqual(before);
    }
    expect((await prisma.deliveryVersion.findUniqueOrThrow({ where: { id: versionId } })).status).toBe('APPROVED');
  });

  it('같은 범위로 동시에 두 번 바꾸면 댓글은 하나만 남는다', async () => {
    const before = await readState();
    const responses = await Promise.all([update({ scope: 'OUT_OF_SCOPE' }), update({ scope: 'OUT_OF_SCOPE' })]);
    expect(responses.map(({ status }) => status)).toEqual([200, 200]);
    expect(responses[0].body).toEqual(responses[1].body);
    expect(responses[0].body).toMatchObject({ scope: 'OUT_OF_SCOPE', commentCount: 1 });
    expect(await prisma.comment.findMany()).toEqual([
      expect.objectContaining({
        issueId,
        authorId: developerId,
        versionId,
        requestId: null,
        body: '범위: 하자 수정 → 추가 요청',
      }),
    ]);
    const after = await readState();
    expect(after.issues).toEqual(before.issues.map((issue) => ({ ...issue, scope: 'OUT_OF_SCOPE' })));
    expect(after.events).toEqual(before.events);
  });

  it('서로 다른 마감일로 동시에 바꾸면 댓글의 앞뒤 값이 차례로 이어진다', async () => {
    const responses = await Promise.all([update({ dueDate: '2026-11-10' }), update({ dueDate: '2026-11-15' })]);
    expect(responses.map(({ status }) => status)).toEqual([200, 200]);
    expect(responses.map(({ body }) => body.dueDate)).toEqual(['2026-11-10', '2026-11-15']);
    expect(responses.map(({ body }) => body.commentCount).sort((a, b) => a - b)).toEqual([1, 2]);
    const detail = await get(`/api/issues/${issueId}`).expect(200);
    const comments = await prisma.comment.findMany({ orderBy: { createdAt: 'asc' } });
    expect(comments).toHaveLength(2);
    const firstWasTen = comments[0].body === '마감일: 없음 → 2026년 11월 10일';
    const expectedBodies = firstWasTen
      ? ['마감일: 없음 → 2026년 11월 10일', '마감일: 2026년 11월 10일 → 2026년 11월 15일']
      : ['마감일: 없음 → 2026년 11월 15일', '마감일: 2026년 11월 15일 → 2026년 11월 10일'];
    expect(comments.map(({ body }) => body)).toEqual(expectedBodies);
    expect(detail.body.comments.map((comment: { body: string }) => comment.body)).toEqual(expectedBodies);
    const finalDate = firstWasTen ? '2026-11-15' : '2026-11-10';
    expect(detail.body.dueDate).toBe(finalDate);
    expect(await prisma.issue.findUniqueOrThrow({ where: { id: issueId } })).toMatchObject({
      dueDate: new Date(`${finalDate}T00:00:00.000Z`),
    });
  });

  it('범위 바꾸기와 새 버전 게시가 동시에 오면 바꾸기는 저장되거나 409이고 저장된 댓글의 버전은 바꿀 때의 현재 버전이다', async () => {
    const draft = await createDraft();
    const before = await readState();
    const [changed, published] = await Promise.all([update({ scope: 'OUT_OF_SCOPE' }), publish(draft.body.id)]);
    expect(published.status).toBe(200);
    expect((await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).currentVersionId).toBe(draft.body.id);
    expect([200, 409]).toContain(changed.status);
    const after = await readState();
    if (changed.status === 409) {
      expect(changed.body).toEqual(versionChangedBody);
      expect(after.issues).toEqual(before.issues);
      expect(after.comments).toEqual(before.comments);
      return;
    }
    expect(changed.body).toMatchObject({ scope: 'OUT_OF_SCOPE', commentCount: 1 });
    expect(changed.body.comments).toEqual([
      expect.objectContaining({ body: '범위: 하자 수정 → 추가 요청', authorName: '개발자', versionNumber: 0 }),
    ]);
    expect(after.issues).toEqual(before.issues.map((issue) => ({ ...issue, scope: 'OUT_OF_SCOPE' })));
    expect(after.comments).toEqual([
      expect.objectContaining({
        issueId,
        authorId: developerId,
        versionId,
        requestId: null,
        body: '범위: 하자 수정 → 추가 요청',
      }),
    ]);
    await get(`/api/issues/${issueId}`).expect(200).expect(changed.body);
  });

  it('멤버가 아닌 사람은 404이고 아무것도 바뀌지 않는다', async () => {
    const outsider = await prisma.user.create({ data: { email: 'outsider@example.com', name: '외부인' } });
    const outsiderCookie = await login(outsider.id);
    const before = await readState();
    // 멤버 확인이 역할·버전 확인보다 먼저여야 한다.
    await update({ versionId: missingId, scope: 'OUT_OF_SCOPE' }, outsiderCookie).expect(404).expect(issueNotFoundBody);
    await update({ category: 'DESIGN' }, outsiderCookie).expect(404).expect(issueNotFoundBody);
    expect(await readState()).toEqual(before);
  });

  it('접근이 철회된 작성자는 자기 쪽지의 분류도 바꿀 수 없고 404다', async () => {
    await prisma.projectMember.update({
      where: { projectId_userId: { projectId, userId: clientId } },
      data: { revokedAt: new Date() },
    });
    const before = await readState();
    await update({ category: 'DESIGN' }, clientCookie).expect(404).expect(issueNotFoundBody);
    await update({ versionId: missingId, category: 'DESIGN' }, clientCookie).expect(404).expect(issueNotFoundBody);
    expect(await readState()).toEqual(before);
  });

  it('없는 쪽지와 틀린 모양의 id는 404다', async () => {
    const before = await readState();
    for (const targetIssueId of [missingId, 'not-a-uuid']) {
      await update({ category: 'DESIGN' }, cookie, targetIssueId).expect(404).expect(issueNotFoundBody);
    }
    expect(await readState()).toEqual(before);
  });

  it('로그인하지 않으면 401이다', async () => {
    const before = await readState();
    await request(server)
      .patch(`/api/issues/${issueId}`)
      .set('Origin', origin)
      .send({ versionId, category: 'DESIGN' })
      .expect(401);
    expect(await readState()).toEqual(before);
  });

  it('다른 Origin에서 오면 403이고 아무것도 바뀌지 않는다', async () => {
    const before = await readState();
    for (const requestOrigin of [undefined, 'https://other.example.com']) {
      const pending = request(server)
        .patch(`/api/issues/${issueId}`)
        .set('Cookie', cookie)
        .send({ versionId, scope: 'OUT_OF_SCOPE' });
      if (requestOrigin) pending.set('Origin', requestOrigin);
      await pending.expect(403);
      expect(await readState()).toEqual(before);
    }
  });

  it.each<[string, Record<string, unknown>]>([
    ['바꿀 칸 없음', { category: undefined }],
    ['versionId 없음', { versionId: undefined }],
    ['versionId UUID 아님', { versionId: 'not-a-uuid' }],
    ['versionId null', { versionId: null }],
    ['versionId 숫자', { versionId: 123 }],
    ['없는 분류', { category: 'FEATURE' }],
    ['없는 범위', { scope: 'PAGE' }],
    ['null 분류', { category: null }],
    ['null 범위', { scope: null }],
    ['소문자 분류', { category: 'bug' }],
    ['소문자 범위', { scope: 'in_scope' }],
    ['배열 분류', { category: ['BUG'] }],
    ['숫자 범위', { scope: 0 }],
    ['2026-02-30', { dueDate: '2026-02-30' }],
    ['2026-13-01', { dueDate: '2026-13-01' }],
    ['2027-02-29', { dueDate: '2027-02-29' }],
    ['1900-02-29', { dueDate: '1900-02-29' }],
    ['2026-04-31', { dueDate: '2026-04-31' }],
    ['2026-00-15', { dueDate: '2026-00-15' }],
    ['2026-11-00', { dueDate: '2026-11-00' }],
    ['시각이 붙은 날짜', { dueDate: '2026-11-15T00:00:00.000Z' }],
    ['2026-1-5', { dueDate: '2026-1-5' }],
    ['20261115', { dueDate: '20261115' }],
    ['빈 날짜', { dueDate: '' }],
    ['숫자 날짜', { dueDate: 20261115 }],
    ['불리언 날짜', { dueDate: false }],
    ['배열 날짜', { dueDate: ['2026-11-15'] }],
    ['객체 날짜', { dueDate: { date: '2026-11-15' } }],
    ['공백 붙은 날짜', { dueDate: ' 2026-11-15 ' }],
    ['줄바꿈 붙은 날짜', { dueDate: '2026-11-15\n' }],
    ['모르는 칸 status', { status: 'IN_PROGRESS' }],
    ['모르는 칸 title', { title: '다른 제목' }],
    ['모르는 칸 number', { number: 100 }],
    ['모르는 칸 authorId', { authorId: missingId }],
    ['모르는 칸 requestId', { requestId: missingId }],
  ])('틀린 입력 %s는 422이고 아무것도 바뀌지 않는다', async (_name, changes) => {
    const before = await readState();
    await update({ category: 'DESIGN', ...changes }).expect(422);
    expect(await readState()).toEqual(before);
  });

  it('마감일은 보낸 날짜 그대로 저장되고 목록과 상세에 그대로 돌아온다', async () => {
    const cases = [
      { timezone: 'Asia/Seoul', dueDate: '2026-11-15', comment: '마감일: 없음 → 2026년 11월 15일' },
      { timezone: 'America/Los_Angeles', dueDate: '2027-01-05', comment: '마감일: 2026년 11월 15일 → 2027년 1월 5일' },
      { timezone: 'Pacific/Kiritimati', dueDate: '2028-02-29', comment: '마감일: 2027년 1월 5일 → 2028년 2월 29일' },
    ];
    for (const { timezone, dueDate, comment } of cases) {
      vi.stubEnv('TZ', timezone);
      const response = await update({ dueDate }).expect(200);
      expect(response.body).toMatchObject({ id: issueId, category: 'BUG', scope: 'IN_SCOPE', dueDate });
      expect(response.body.comments.at(-1)).toMatchObject({ body: comment });
      expect(await prisma.issue.findUniqueOrThrow({ where: { id: issueId } })).toMatchObject({
        dueDate: new Date(`${dueDate}T00:00:00.000Z`),
      });
      // date 칸의 글자를 직접 읽어, 응답만 날짜처럼 보이고 DB에는 다른 날이 저장되는 문제도 잡는다.
      expect(
        await prisma.$queryRaw<{ dueDate: string }[]>`
        SELECT due_date::text AS "dueDate" FROM issues WHERE id = ${issueId}::uuid
      `,
      ).toEqual([{ dueDate }]);
      await get(`/api/issues/${issueId}`).expect(200).expect(response.body);
      const list = await get(`/api/projects/${projectId}/issues`).expect(200);
      expect(list.body).toEqual([
        expect.objectContaining({ id: issueId, category: 'BUG', scope: 'IN_SCOPE', dueDate }),
      ]);
    }
  });

  it('분류를 바꾸면 댓글이 생기지 않고 분류·범위·마감일 변경은 활동 일지에 남지 않는다', async () => {
    const before = await readState();
    const activity = await get(`/api/projects/${projectId}/activity`).expect(200);
    await update({ category: 'DESIGN' }).expect(200);
    expect((await readState()).comments).toEqual(before.comments);
    await update({ scope: 'OUT_OF_SCOPE' }).expect(200);
    await update({ dueDate: '2026-11-15' }).expect(200);
    await update({ category: 'COPY', scope: 'IN_SCOPE', dueDate: null }).expect(200);
    const after = await readState();
    expect(after.comments).toHaveLength(4);
    expect(after.events).toEqual(before.events);
    await get(`/api/projects/${projectId}/activity`).expect(200).expect(activity.body);
  });

  it('칸을 정하지 않고 DB에 넣은 쪽지는 버그, 하자 수정, 마감일 없음으로 보인다', async () => {
    const issue = await prisma.issue.create({
      data: {
        projectId,
        number: 2,
        originVersionId: versionId,
        authorId: clientId,
        title: '기본값 쪽지',
        body: '',
        requestId: randomUUID(),
      },
    });
    expect(issue).toMatchObject({ category: 'BUG', scope: 'IN_SCOPE', dueDate: null });
    const detail = await get(`/api/issues/${issue.id}`).expect(200);
    expect(detail.body).toMatchObject({
      id: issue.id,
      category: 'BUG',
      scope: 'IN_SCOPE',
      dueDate: null,
      comments: [],
    });
    const list = await get(`/api/projects/${projectId}/issues`).expect(200);
    expect(list.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: issue.id, category: 'BUG', scope: 'IN_SCOPE', dueDate: null }),
      ]),
    );
  });

  it('수정 중인 쪽지도 세 칸을 바꾸고 지난 마감일을 정할 수 있다', async () => {
    const started = await post(`/api/issues/${issueId}/start`).send({ versionId }).expect(200);
    const before = await readState();
    const response = await update({ category: 'OTHER', scope: 'OUT_OF_SCOPE', dueDate: '2001-01-05' }).expect(200);
    expect(response.body).toMatchObject({
      id: issueId,
      status: 'IN_PROGRESS',
      category: 'OTHER',
      scope: 'OUT_OF_SCOPE',
      dueDate: '2001-01-05',
      originVersion: started.body.originVersion,
      origin: started.body.origin,
      commentCount: 2,
    });
    expect(response.body.comments.map((comment: { body: string }) => comment.body)).toEqual([
      '범위: 하자 수정 → 추가 요청',
      '마감일: 없음 → 2001년 1월 5일',
    ]);
    expect((await readState()).events).toEqual(before.events);
    await get(`/api/issues/${issueId}`).expect(200).expect(response.body);
  });

  it('지난 버전에서 시작한 쪽지도 현재 버전으로 분류를 바꾸며 처음 위치는 그대로다', async () => {
    const pinned = await createIssue(issueInput({ screenId, xRatio: 0.2, yRatio: 0.8 }), clientCookie).expect(201);
    const draft = await createDraft();
    await publish(draft.body.id);
    const response = await update({ versionId: draft.body.id, category: 'COPY' }, clientCookie, pinned.body.id).expect(
      200,
    );
    expect(response.body).toEqual({ ...pinned.body, category: 'COPY' });
    await get(`/api/issues/${pinned.body.id}`, clientCookie).expect(200).expect(response.body);
  });

  it('권한 검사는 버전 검사보다 먼저라 지난 버전이나 승인된 버전도 권한 없는 칸은 403이다', async () => {
    const draft = await createDraft();
    await publish(draft.body.id);
    await prisma.deliveryVersion.update({ where: { id: draft.body.id }, data: { status: 'APPROVED' } });
    const before = await readState();
    for (const viewedVersionId of [versionId, draft.body.id]) {
      await update({ versionId: viewedVersionId, scope: 'OUT_OF_SCOPE' }, clientCookie).expect(403);
      await update({ versionId: viewedVersionId, category: 'DESIGN' }, approverCookie).expect(403);
    }
    expect(await readState()).toEqual(before);
  });

  it.each(['게시 전 버전', '남의 프로젝트 버전', '없는 버전', '현재 버전 없음'] as const)(
    'versionId가 %s이면 409 VERSION_CHANGED이고 아무것도 바뀌지 않는다',
    async (scenario) => {
      let viewedVersionId = missingId;
      if (scenario === '게시 전 버전') viewedVersionId = (await createDraft()).body.id;
      if (scenario === '남의 프로젝트 버전') {
        const otherProject = await prisma.project.create({ data: { name: '다른 프로젝트' } });
        const otherVersion = await prisma.deliveryVersion.create({ data: { projectId: otherProject.id } });
        viewedVersionId = otherVersion.id;
      }
      if (scenario === '현재 버전 없음') {
        viewedVersionId = versionId;
        await prisma.project.update({ where: { id: projectId }, data: { currentVersionId: null } });
      }
      const before = await readState();
      await update({ versionId: viewedVersionId, category: 'DESIGN', scope: 'OUT_OF_SCOPE', dueDate: '2026-11-15' })
        .expect(409)
        .expect(versionChangedBody);
      expect(await readState()).toEqual(before);
    },
  );
});
