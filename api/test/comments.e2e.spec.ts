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

describe('댓글 API (e2e)', () => {
  let app: INestApplication | undefined;
  let server: Server;
  let prisma: PrismaService;
  let directory: string;
  let projectId: string;
  let otherProjectId: string;
  let versionId: string;
  let screenId: string;
  let issueId: string;
  let developerId: string;
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

  const commentInput = (changes: Record<string, unknown> = {}) => ({
    requestId: randomUUID(),
    versionId,
    body: '확인 부탁드려요',
    ...changes,
  });
  const comment = (body = commentInput(), memberCookie = cookie, targetIssueId = issueId) =>
    post(`/api/issues/${targetIssueId}/comments`, memberCookie).send(body);

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'comments-e2e-'));
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
    const otherProject = await prisma.project.create({
      data: { name: '다른 프로젝트', members: { create: { userId: developer.id, role: 'DEVELOPER' } } },
    });
    otherProjectId = otherProject.id;
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

  it('같은 requestId로 다시 보내면 201이고 처음 댓글을 돌려주며 댓글은 하나다', async () => {
    const input = commentInput();
    const first = await comment(input).expect(201);
    const before = await readState();
    await comment(input).expect(201).expect(first.body);
    await comment({ ...input, body: '다르게 보낸 글' })
      .expect(201)
      .expect(first.body);
    expect(before.comments).toHaveLength(1);
    expect(await readState()).toEqual(before);
  });

  it('같은 requestId로 동시에 두 번 보내면 댓글은 하나다', async () => {
    const input = commentInput();
    const before = await readState();
    const responses = await Promise.all([comment(input), comment(input)]);
    expect(responses.map(({ status }) => status)).toEqual([201, 201]);
    expect(responses[0].body).toEqual(responses[1].body);
    expect(await prisma.comment.findMany()).toEqual([
      expect.objectContaining({ id: responses[0].body.id, issueId, requestId: input.requestId, authorId: developerId }),
    ]);
    expect((await readState()).events).toEqual(before.events);
  });

  it('다른 쪽지에 쓴 requestId는 409 REQUEST_ID_REUSED다', async () => {
    const input = commentInput({ body: '첫 쪽지의 비공개 내용' });
    await comment(input).expect(201);
    const other = await createIssue(issueInput()).expect(201);
    const before = await readState();
    await comment(input, cookie, other.body.id).expect(409).expect({
      statusCode: 409,
      code: 'REQUEST_ID_REUSED',
      message: '이미 쓴 요청 번호예요',
    });
    expect(await readState()).toEqual(before);
    const detail = await get(`/api/issues/${other.body.id}`).expect(200);
    expect(detail.body.comments).toEqual([]);
  });

  it('다른 사람이 같은 requestId를 써도 각자 댓글이 생긴다', async () => {
    const input = commentInput();
    const first = await comment(input).expect(201);
    const second = await comment(input, clientCookie).expect(201);
    expect(first.body.id).not.toBe(second.body.id);
    expect(first.body.authorName).toBe('개발자');
    expect(second.body.authorName).toBe('클라이언트');
    expect(await prisma.comment.count()).toBe(2);
  });

  it('보던 버전 뒤에 새 버전이 게시되면 댓글은 409 VERSION_CHANGED이고 저장되지 않는다', async () => {
    const draft = await createDraft();
    await publish(draft.body.id);
    const before = await readState();
    await comment().expect(409).expect(versionChangedBody);
    expect(await readState()).toEqual(before);
  });

  it('저장된 뒤 새 버전이 게시돼도 같은 requestId는 409가 아니라 처음 댓글을 받는다', async () => {
    const input = commentInput();
    const first = await comment(input).expect(201);
    const draft = await createDraft();
    await publish(draft.body.id);
    const before = await readState();
    await comment(input).expect(201).expect(first.body);
    expect(await readState()).toEqual(before);
    expect(before.comments).toEqual([expect.objectContaining({ versionId, requestId: input.requestId })]);
  });

  it('저장된 뒤 현재 버전이 승인돼도 같은 requestId는 처음 댓글을 받는다', async () => {
    const input = commentInput();
    const first = await comment(input).expect(201);
    await prisma.deliveryVersion.update({ where: { id: versionId }, data: { status: 'APPROVED' } });
    const before = await readState();
    await comment(input).expect(201).expect(first.body);
    expect(await readState()).toEqual(before);
  });

  it.each<[string, Record<string, unknown>]>([
    ['빈 글', { body: '' }],
    ['공백만', { body: ' \n\t ' }],
    ['2,001자', { body: '가'.repeat(2001) }],
    ['문자열 아님', { body: 123 }],
    ['본문 없음', { body: undefined }],
    ['본문 null', { body: null }],
    ['본문 배열', { body: ['댓글'] }],
    ['본문 객체', { body: { text: '댓글' } }],
    ['requestId가 UUID 아님', { requestId: 'not-a-uuid' }],
    ['requestId 없음', { requestId: undefined }],
    ['requestId null', { requestId: null }],
    ['versionId가 UUID 아님', { versionId: 'not-a-uuid' }],
    ['versionId 없음', { versionId: undefined }],
    ['versionId null', { versionId: null }],
    ['모르는 칸 status', { status: 'OPEN' }],
    ['모르는 칸 number', { number: 1 }],
    ['모르는 칸 authorId', { authorId: missingId }],
    ['모르는 칸 scope', { scope: 'PAGE' }],
    ['모르는 칸 dueDate', { dueDate: '2026-11-10' }],
  ])('잘못된 본문 %s는 422이고 저장하지 않는다', async (_name, changes) => {
    const before = await readState();
    await comment(commentInput(changes)).expect(422);
    expect(await readState()).toEqual(before);
  });

  it('2,000자 댓글은 201이다', async () => {
    const body = '가'.repeat(2000);
    const response = await comment(commentInput({ body: ` \n${body}\t ` })).expect(201);
    expect(response.body.body).toBe(body);
    expect(await prisma.comment.findMany()).toEqual([expect.objectContaining({ id: response.body.id, body })]);
  });

  it('댓글 앞뒤 공백을 지우고 한 글자와 본문 안의 줄바꿈은 저장한다', async () => {
    for (const body of ['가', '첫 줄\n둘째 줄']) {
      const input = commentInput({ body: ` \t${body}\n ` });
      const response = await comment(input).expect(201);
      expect(response.body).toEqual({
        id: expect.any(String),
        authorName: '개발자',
        versionNumber: 0,
        body,
        createdAt: expect.any(String),
      });
      expect(new Date(response.body.createdAt).toISOString()).toBe(response.body.createdAt);
      expect(await prisma.comment.findUniqueOrThrow({ where: { id: response.body.id } })).toMatchObject({
        issueId,
        authorId: developerId,
        versionId,
        body,
        requestId: input.requestId,
      });
    }
  });

  it('멤버가 아니거나 철회된 사람·없는 쪽지·틀린 id는 같은 404이고 저장하지 않는다', async () => {
    const outsider = await prisma.user.create({ data: { email: 'outsider@example.com', name: '외부인' } });
    const outsiderCookie = await login(outsider.id);
    const client = await prisma.user.findUniqueOrThrow({ where: { email: 'client@example.com' } });
    await prisma.projectMember.update({
      where: { projectId_userId: { projectId, userId: client.id } },
      data: { revokedAt: new Date() },
    });
    const before = await readState();
    for (const [memberCookie, targetIssueId] of [
      [outsiderCookie, issueId],
      [clientCookie, issueId],
      [cookie, missingId],
      [cookie, 'not-a-uuid'],
    ]) {
      await comment(commentInput(), memberCookie, targetIssueId).expect(404).expect(issueNotFoundBody);
      expect(await readState()).toEqual(before);
    }
  });

  it('댓글 저장 뒤 접근이 철회되면 같은 requestId라도 처음 댓글을 돌려주지 않는다', async () => {
    const input = commentInput();
    await comment(input, clientCookie).expect(201);
    const client = await prisma.user.findUniqueOrThrow({ where: { email: 'client@example.com' } });
    await prisma.projectMember.update({
      where: { projectId_userId: { projectId, userId: client.id } },
      data: { revokedAt: new Date() },
    });
    const before = await readState();
    await comment(input, clientCookie).expect(404).expect(issueNotFoundBody);
    expect(await readState()).toEqual(before);
  });

  it('다른 프로젝트의 현재 버전 id를 보내면 409 VERSION_CHANGED다', async () => {
    const screen = await prisma.screen.create({
      data: { projectId: otherProjectId, name: '다른 화면', viewport: 'MOBILE' },
    });
    const draft = await createDraft(otherProjectId);
    await upload(draft.body.id, screen.id);
    const other = await publish(draft.body.id);
    const before = await readState();
    await comment(commentInput({ versionId: other.body.id }))
      .expect(409)
      .expect(versionChangedBody);
    expect(await readState()).toEqual(before);
  });

  it.each(['게시 전 버전', '없는 id', '현재 버전 없음'] as const)(
    '댓글 versionId가 %s이면 409 VERSION_CHANGED이고 저장하지 않는다',
    async (scenario) => {
      let viewedVersionId = missingId;
      if (scenario === '게시 전 버전') viewedVersionId = (await createDraft()).body.id;
      if (scenario === '현재 버전 없음') {
        viewedVersionId = versionId;
        await prisma.project.update({ where: { id: projectId }, data: { currentVersionId: null } });
      }
      const before = await readState();
      await comment(commentInput({ versionId: viewedVersionId }))
        .expect(409)
        .expect(versionChangedBody);
      expect(await readState()).toEqual(before);
    },
  );

  it('로그인하지 않으면 401이고 댓글이 저장되지 않는다', async () => {
    const before = await readState();
    await request(server)
      .post(`/api/issues/${issueId}/comments`)
      .set('Origin', origin)
      .send(commentInput())
      .expect(401);
    expect(await readState()).toEqual(before);
  });

  it.each([undefined, 'https://other.example.com'])(
    'Origin이 %s이면 403이고 저장하지 않는다',
    async (requestOrigin) => {
      const before = await readState();
      const pending = request(server)
        .post(`/api/issues/${issueId}/comments`)
        .set('Cookie', cookie)
        .send(commentInput());
      if (requestOrigin) pending.set('Origin', requestOrigin);
      await pending.expect(403);
      expect(await readState()).toEqual(before);
    },
  );

  it('남이 쓴 쪽지에도 댓글을 쓰고 상세에 오래된 순으로 보인다', async () => {
    const before = await readState();
    const responses = [];
    for (const [memberCookie, authorName] of [
      [cookie, '개발자'],
      [approverCookie, '승인자'],
      [clientCookie, '클라이언트'],
    ]) {
      const response = await comment(commentInput({ body: `${authorName}의 댓글` }), memberCookie).expect(201);
      expect(response.body.authorName).toBe(authorName);
      responses.push(response.body);
    }
    // 삽입 순서와 시간순을 다르게 하여 정렬이 빠져도 우연히 통과하지 않게 한다.
    for (const [index, response] of responses.entries()) {
      const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, 3 - index));
      await prisma.comment.update({ where: { id: response.id }, data: { createdAt } });
      response.createdAt = createdAt.toISOString();
    }
    const other = await createIssue(issueInput()).expect(201);
    await comment(commentInput({ body: '다른 쪽지의 댓글' }), cookie, other.body.id).expect(201);
    const detail = await get(`/api/issues/${issueId}`).expect(200);
    expect(detail.body.comments).toEqual([...responses].reverse());
    expect(detail.body.commentCount).toBe(3);
    const list = await get(`/api/projects/${projectId}/issues`).expect(200);
    expect(list.body.find((issue: { id: string }) => issue.id === issueId).commentCount).toBe(3);
    expect((await readState()).events.filter((event) => event.issueId === issueId)).toEqual(
      before.events.filter((event) => event.issueId === issueId),
    );
  });

  it('댓글은 활동 일지에 남지 않는다', async () => {
    const before = await get(`/api/projects/${projectId}/activity`).expect(200);
    const events = await prisma.activityEvent.findMany({ orderBy: { id: 'asc' } });
    await comment().expect(201);
    await get(`/api/projects/${projectId}/activity`).expect(200).expect(before.body);
    expect(await prisma.activityEvent.findMany({ orderBy: { id: 'asc' } })).toEqual(events);
  });

  it('지난 버전에서 시작한 쪽지에도 현재 버전 id로 댓글을 쓰고 수정 시작을 한다', async () => {
    const original = await get(`/api/issues/${issueId}`).expect(200);
    const draft = await createDraft();
    await publish(draft.body.id);
    const response = await comment(commentInput({ versionId: draft.body.id })).expect(201);
    expect(response.body.versionNumber).toBe(1);
    expect(await prisma.comment.findUniqueOrThrow({ where: { id: response.body.id } })).toMatchObject({
      issueId,
      versionId: draft.body.id,
    });
    const started = await post(`/api/issues/${issueId}/start`).send({ versionId: draft.body.id }).expect(200);
    expect(started.body).toEqual({
      ...original.body,
      status: 'IN_PROGRESS',
      commentCount: 1,
      comments: [response.body],
    });
  });

  it('잠금을 기다린 댓글의 시각은 잠금이 풀린 뒤다', async () => {
    let pending: Promise<void> | undefined;
    let response: request.Response | undefined;
    let requestError: unknown;
    let finished = false;
    let releasedAt: string | undefined;
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM projects WHERE id = ${projectId}::uuid FOR UPDATE`;
        const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        pending = comment()
          .timeout({ deadline: 4_000 })
          .then(
            (result) => {
              response = result;
              finished = true;
            },
            (error: unknown) => {
              requestError = error;
              finished = true;
            },
          );
        await vi.waitFor(
          async () => {
            const [{ waiting }] = await prisma.$queryRaw<{ waiting: boolean }[]>`
            SELECT EXISTS (
              SELECT 1 FROM pg_stat_activity
              WHERE datname = current_database() AND ${pid}::int = ANY(pg_blocking_pids(pid))
                AND query ILIKE '%projects%' AND query ILIKE '%FOR UPDATE%'
            ) AS waiting
          `;
            expect(finished).toBe(false);
            expect(waiting).toBe(true);
          },
          { timeout: 2_000, interval: 25 },
        );
        // 잠금을 풀기 직전 DB 시각을 기록한다. JS Date로 바꾸지 않아 DB의 마이크로초 정밀도를 보존한다.
        const [release] = await tx.$queryRaw<{ at: string }[]>`SELECT clock_timestamp()::text AS at`;
        releasedAt = release.at;
      });
    } finally {
      await pending;
    }
    expect(requestError).toBeUndefined();
    expect(response?.status).toBe(201);
    const [timing] = await prisma.$queryRaw<{ after_release: boolean }[]>`
      SELECT created_at > ${releasedAt}::timestamptz AS after_release
      FROM comments WHERE id = ${response!.body.id}::uuid
    `;
    expect(timing.after_release).toBe(true);
    expect(await prisma.comment.count()).toBe(1);
  });
});
