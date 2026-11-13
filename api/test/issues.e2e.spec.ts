import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
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
const projectNotFoundBody = { statusCode: 404, message: '없는 프로젝트예요', error: 'Not Found' };
const issueNotFoundBody = { statusCode: 404, message: '없는 쪽지예요', error: 'Not Found' };
const screenNotFoundBody = { statusCode: 404, message: '없는 화면이에요', error: 'Not Found' };
const versionChangedBody = { statusCode: 409, message: '새 버전이 올라왔어요', code: 'VERSION_CHANGED' };

describe('쪽지 API (e2e)', () => {
  let app: INestApplication | undefined;
  let server: Server;
  let prisma: PrismaService;
  let directory: string;
  let projectId: string;
  let otherProjectId: string;
  let versionId: string;
  let screenId: string;
  let assetId: string;
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

  const publishOtherProject = async () => {
    const screen = await prisma.screen.create({
      data: { projectId: otherProjectId, name: '다른 화면', viewport: 'MOBILE' },
    });
    const draft = await createDraft(otherProjectId);
    await upload(draft.body.id, screen.id);
    const published = await publish(draft.body.id);
    return { versionId: published.body.id as string, screenId: screen.id };
  };

  const readIssueState = async () => ({
    issues: await prisma.issue.findMany({ orderBy: { id: 'asc' } }),
    events: await prisma.activityEvent.findMany({ orderBy: { id: 'asc' } }),
  });

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'issues-e2e-'));
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
    const uploaded = await upload(versionId, screenId);
    assetId = uploaded.body.screens[0].asset.id;
    await publish(versionId);
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

  it.each(['개발자', '클라이언트', '승인자'] as const)(
    '%s가 쪽지를 쓰면 201이고 목록·상세에 그 이름으로 보인다',
    async (role) => {
      const authorCookie = { 개발자: cookie, 클라이언트: clientCookie, 승인자: approverCookie }[role];
      await get(`/api/projects/${projectId}/issues`, authorCookie).expect(200).expect([]);
      const input = issueInput();
      const created = await createIssue(input, authorCookie).expect(201);
      const summary = {
        id: expect.any(String),
        number: 1,
        title: input.title,
        status: 'OPEN',
        category: 'BUG',
        scope: 'IN_SCOPE',
        dueDate: null,
        authorName: role,
        createdAt: expect.any(String),
        commentCount: 0,
        originVersion: { id: versionId, number: 0 },
        origin: null,
      };
      expect(created.body).toEqual({
        ...summary,
        body: input.body,
        isMine: true,
        attachments: [],
        comments: [],
        attempts: [],
        canReview: role !== '개발자',
        projectId,
      });
      expect(new Date(created.body.createdAt).toISOString()).toBe(created.body.createdAt);
      const list = await get(`/api/projects/${projectId}/issues`, authorCookie).expect(200);
      expect(list.body).toEqual([summary]);
      await get(`/api/issues/${created.body.id}`, authorCookie).expect(200).expect(created.body);
      const readerCookie = role === '개발자' ? clientCookie : cookie;
      await get(`/api/issues/${created.body.id}`, readerCookie)
        .expect(200)
        .expect({ ...created.body, isMine: false, canReview: false });
      expect(await prisma.issue.count()).toBe(1);
      expect(await prisma.activityEvent.findMany({ where: { type: 'ISSUE_CREATED' } })).toEqual([
        expect.objectContaining({ projectId, issueId: created.body.id }),
      ]);
    },
  );

  it.each([
    [0, 1],
    [1, 0],
  ])('핀 경계값 x=%s, y=%s는 201이고 목록·상세에 처음 위치와 사진을 준다', async (xRatio, yRatio) => {
    const input = issueInput({ screenId, xRatio, yRatio });
    const created = await createIssue(input).expect(201);
    const summary = {
      id: created.body.id,
      number: 1,
      title: input.title,
      status: 'OPEN',
      category: 'BUG',
      scope: 'IN_SCOPE',
      dueDate: null,
      authorName: '개발자',
      createdAt: created.body.createdAt,
      commentCount: 0,
      originVersion: { id: versionId, number: 0 },
      origin: {
        screenId,
        screenName: '첫 화면',
        viewport: 'PC',
        asset: { id: assetId, width: 32, height: 24 },
        xRatio,
        yRatio,
      },
    };
    expect(created.body).toEqual({
      ...summary,
      body: input.body,
      isMine: true,
      attachments: [],
      comments: [],
      attempts: [],
      canReview: false,
      projectId,
    });
    await get(`/api/projects/${projectId}/issues`).expect(200).expect([summary]);
    await get(`/api/issues/${created.body.id}`).expect(200).expect(created.body);
  });

  it('쪽지 쓰기에 scope를 넣으면 422이고 저장하지 않는다', async () => {
    const before = await readIssueState();
    for (const scope of ['IN_SCOPE', 'OUT_OF_SCOPE', null]) {
      await createIssue(issueInput({ category: 'DESIGN', scope }), clientCookie).expect(422);
      expect(await readIssueState()).toEqual(before);
    }
  });

  it('쪽지 쓰기에 dueDate를 넣으면 422이고 저장하지 않는다', async () => {
    const before = await readIssueState();
    for (const dueDate of ['2026-11-15', null]) {
      await createIssue(issueInput({ category: 'COPY', dueDate }), clientCookie).expect(422);
      expect(await readIssueState()).toEqual(before);
    }
  });

  it('분류를 골라 쓰면 그 분류로 저장되고 고르지 않으면 버그, 하자 수정, 마감일 없음이다', async () => {
    for (const category of [undefined, 'BUG', 'DESIGN', 'COPY', 'OTHER']) {
      const created = await createIssue(issueInput(category === undefined ? {} : { category }), clientCookie).expect(
        201,
      );
      const triage = { category: category ?? 'BUG', scope: 'IN_SCOPE', dueDate: null };
      expect(created.body).toMatchObject({ ...triage, comments: [] });
      expect(await prisma.issue.findUniqueOrThrow({ where: { id: created.body.id } })).toMatchObject(triage);
      await get(`/api/issues/${created.body.id}`, clientCookie).expect(200).expect(created.body);
      const list = await get(`/api/projects/${projectId}/issues`, clientCookie).expect(200);
      expect(list.body).toContainEqual(expect.objectContaining({ id: created.body.id, ...triage }));
    }
    expect(await prisma.issue.count()).toBe(5);
    expect(await prisma.comment.count()).toBe(0);
  });

  it('쪽지 쓰기에 없는 분류를 넣으면 422이고 저장하지 않는다', async () => {
    const before = await readIssueState();
    for (const category of ['FEATURE', null, 0, 'bug', '', ' BUG ', ['BUG'], { category: 'BUG' }, false]) {
      await createIssue(issueInput({ category }), clientCookie).expect(422);
      expect(await readIssueState()).toEqual(before);
    }
  });

  it.each([undefined, 'DESIGN'])(
    '처음 분류가 %s인 쪽지를 같은 requestId로 다른 분류와 함께 다시 보내면 처음 분류가 남는다',
    async (category) => {
      const input = issueInput(category === undefined ? {} : { category });
      const first = await createIssue(input, clientCookie).expect(201);
      expect(first.body.category).toBe(category ?? 'BUG');
      const before = await readIssueState();
      await createIssue({ ...input, category: 'OTHER' }, clientCookie)
        .expect(201)
        .expect(first.body);
      expect(await readIssueState()).toEqual(before);
      expect(before.issues).toHaveLength(1);
      expect(before.events.filter((event) => event.type === 'ISSUE_CREATED')).toHaveLength(1);
    },
  );

  it('같은 requestId로 다시 보내면 201이고 처음 쪽지를 돌려주며 쪽지·일지는 하나다', async () => {
    const input = issueInput({ screenId, xRatio: 0.25, yRatio: 0.75 });
    const first = await createIssue(input).expect(201);
    const before = await readIssueState();
    await createIssue(input).expect(201).expect(first.body);
    // 같은 번호로 글·핀을 바꿔 보내도 처음 저장한 내용이 기준이다.
    await createIssue({ ...input, title: '다른 제목', body: '다른 본문', xRatio: 0.9 })
      .expect(201)
      .expect(first.body);
    expect(await readIssueState()).toEqual(before);
    expect(before.issues).toHaveLength(1);
    expect(before.events.filter((event) => event.type === 'ISSUE_CREATED')).toHaveLength(1);
  });

  it('같은 requestId로 동시에 두 번 보내면 둘 다 같은 쪽지를 받고 쪽지·일지는 하나다', async () => {
    const input = issueInput({ screenId, xRatio: 0.3, yRatio: 0.6 });
    const responses = await Promise.all([createIssue(input), createIssue(input)]);
    expect(responses.map(({ status }) => status)).toEqual([201, 201]);
    expect(responses[0].body).toEqual(responses[1].body);
    expect(await prisma.issue.findMany()).toEqual([
      expect.objectContaining({ id: responses[0].body.id, requestId: input.requestId, number: 1 }),
    ]);
    expect(await prisma.activityEvent.findMany({ where: { type: 'ISSUE_CREATED' } })).toEqual([
      expect.objectContaining({ issueId: responses[0].body.id, projectId, actorId: developerId }),
    ]);
  });

  it('저장된 뒤 새 버전이 게시돼도 같은 requestId는 409가 아니라 처음 쪽지를 받는다', async () => {
    const input = issueInput({ screenId, xRatio: 0.2, yRatio: 0.8 });
    const first = await createIssue(input).expect(201);
    const draft = await createDraft();
    await publish(draft.body.id);
    const before = await readIssueState();
    await createIssue(input).expect(201).expect(first.body);
    expect(await readIssueState()).toEqual(before);
    expect(before.issues).toHaveLength(1);
    expect(before.events.filter((event) => event.type === 'ISSUE_CREATED')).toHaveLength(1);
  });

  it('다른 프로젝트에 쓴 requestId는 409 REQUEST_ID_REUSED이고 그 쪽지 내용을 돌려주지 않는다', async () => {
    const other = await publishOtherProject();
    const input = issueInput({ title: '다른 프로젝트의 비공개 제목', body: '다른 프로젝트의 비공개 본문' });
    const first = await createIssue(input).expect(201);
    const before = await readIssueState();
    const response = await createIssue({ ...input, versionId: other.versionId }, cookie, otherProjectId).expect(409);
    expect(response.body).toEqual({ statusCode: 409, message: '이미 쓴 요청 번호예요', code: 'REQUEST_ID_REUSED' });
    expect(response.text).not.toContain(first.body.id);
    expect(response.text).not.toContain(input.title);
    expect(response.text).not.toContain(input.body);
    expect(await readIssueState()).toEqual(before);
    await get(`/api/projects/${otherProjectId}/issues`).expect(200).expect([]);
  });

  it('다른 사람이 같은 requestId를 써도 각자 쪽지가 생긴다', async () => {
    const input = issueInput();
    const [developerIssue, clientIssue] = await Promise.all([createIssue(input), createIssue(input, clientCookie)]);
    expect([developerIssue.status, clientIssue.status]).toEqual([201, 201]);
    expect(developerIssue.body.id).not.toBe(clientIssue.body.id);
    expect(developerIssue.body.authorName).toBe('개발자');
    expect(clientIssue.body.authorName).toBe('클라이언트');
    expect(await prisma.issue.count({ where: { requestId: input.requestId } })).toBe(2);
    expect(await prisma.activityEvent.count({ where: { type: 'ISSUE_CREATED' } })).toBe(2);
    await createIssue(input).expect(201).expect(developerIssue.body);
    await createIssue(input, clientCookie).expect(201).expect(clientIssue.body);
  });

  it('보던 버전 뒤에 새 버전이 게시되면 쪽지 쓰기는 409 VERSION_CHANGED이고 쪽지·일지가 없다', async () => {
    const input = issueInput({ screenId, xRatio: 0.5, yRatio: 0.5 });
    const draft = await createDraft();
    await publish(draft.body.id);
    const before = await readIssueState();
    await createIssue(input).expect(409).expect(versionChangedBody);
    expect(await readIssueState()).toEqual(before);
    expect(await prisma.issue.count()).toBe(0);
    expect(await prisma.activityEvent.count({ where: { type: 'ISSUE_CREATED' } })).toBe(0);
  });

  it('쪽지 쓰기와 게시를 동시에 보내면 쪽지는 보던 버전에 저장되거나 409이고 새 버전의 쪽지가 되지 않는다', async () => {
    const draft = await createDraft();
    const replacement = await sharp({ create: { width: 64, height: 48, channels: 3, background: 'blue' } })
      .png()
      .toBuffer();
    await upload(draft.body.id, screenId, replacement);
    const input = issueInput({ screenId, xRatio: 0.25, yRatio: 0.75 });
    const [issue, published] = await Promise.all([createIssue(input), publish(draft.body.id)]);
    expect(published.status).toBe(200);
    expect([201, 409]).toContain(issue.status);
    expect((await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).currentVersionId).toBe(draft.body.id);
    expect(await prisma.issue.count({ where: { originVersionId: draft.body.id } })).toBe(0);
    if (issue.status === 409) {
      expect(issue.body).toEqual(versionChangedBody);
      expect(await prisma.issue.count()).toBe(0);
      expect(await prisma.activityEvent.count({ where: { type: 'ISSUE_CREATED' } })).toBe(0);
      return;
    }
    expect(issue.body).toMatchObject({
      originVersion: { id: versionId, number: 0 },
      origin: { screenId, asset: { id: assetId, width: 32, height: 24 }, xRatio: 0.25, yRatio: 0.75 },
    });
    expect(await prisma.issue.findMany()).toEqual([
      expect.objectContaining({ id: issue.body.id, originVersionId: versionId }),
    ]);
    expect(await prisma.activityEvent.findMany({ where: { type: 'ISSUE_CREATED' } })).toEqual([
      expect.objectContaining({ issueId: issue.body.id }),
    ]);
    await get(`/api/issues/${issue.body.id}`).expect(200).expect(issue.body);
  });

  it.each(['게시 전 버전', '지난 버전', '남의 프로젝트 버전', '없는 id', '게시한 버전이 없는 프로젝트'] as const)(
    'versionId가 %s이면 409 VERSION_CHANGED이고 저장하지 않는다',
    async (state) => {
      let targetProjectId = projectId;
      let targetVersionId = missingId;
      if (state === '게시 전 버전') targetVersionId = (await createDraft()).body.id;
      if (state === '지난 버전') {
        targetVersionId = versionId;
        const draft = await createDraft();
        await publish(draft.body.id);
      }
      if (state === '남의 프로젝트 버전') targetVersionId = (await publishOtherProject()).versionId;
      if (state === '게시한 버전이 없는 프로젝트') {
        targetProjectId = otherProjectId;
        targetVersionId = (await createDraft(otherProjectId)).body.id;
      }
      const before = await readIssueState();
      await createIssue(issueInput({ versionId: targetVersionId }), cookie, targetProjectId)
        .expect(409)
        .expect(versionChangedBody);
      expect(await readIssueState()).toEqual(before);
    },
  );

  it.each<[string, Record<string, unknown>]>([
    ['x가 0 미만', { xRatio: -0.01 }],
    ['x가 1 초과', { xRatio: 1.01 }],
    ['y가 0 미만', { yRatio: -0.01 }],
    ['y가 1 초과', { yRatio: 1.01 }],
    ['x가 문자열', { xRatio: '0.5' }],
    ['y가 문자열', { yRatio: '0.5' }],
    ['x가 null', { xRatio: null }],
    ['y가 null', { yRatio: null }],
    ['x가 boolean', { xRatio: true }],
    ['y가 배열', { yRatio: [0.5] }],
    ['화면만', { xRatio: undefined, yRatio: undefined }],
    ['좌표만', { screenId: undefined }],
    ['x만', { screenId: undefined, yRatio: undefined }],
    ['y만', { screenId: undefined, xRatio: undefined }],
    ['화면과 x만', { yRatio: undefined }],
    ['화면과 y만', { xRatio: undefined }],
    ['화면이 null', { screenId: null }],
    ['화면이 UUID 아님', { screenId: 'not-a-uuid' }],
    ['셋 다 null', { screenId: null, xRatio: null, yRatio: null }],
  ])('핀 입력 %s는 422이고 저장하지 않는다', async (_name, changes) => {
    const before = await readIssueState();
    await createIssue(issueInput({ screenId, xRatio: 0.5, yRatio: 0.5, ...changes })).expect(422);
    expect(await readIssueState()).toEqual(before);
  });

  it.each(['남의 프로젝트 화면', '이번 버전에서 뺀 화면', '없는 id'] as const)(
    '현재 버전에 없는 화면(%s)에 핀을 꽂으면 404이고 저장하지 않는다',
    async (state) => {
      let targetScreenId = missingId;
      let currentVersionId = versionId;
      if (state === '남의 프로젝트 화면') targetScreenId = (await publishOtherProject()).screenId;
      if (state === '이번 버전에서 뺀 화면') {
        const second = await prisma.screen.create({ data: { projectId, name: '남길 화면', viewport: 'MOBILE' } });
        const draft = await createDraft();
        await upload(draft.body.id, second.id);
        await request(server)
          .delete(`/api/versions/${draft.body.id}/screens/${screenId}`)
          .set('Origin', origin)
          .set('Cookie', cookie)
          .expect(200);
        await publish(draft.body.id);
        currentVersionId = draft.body.id;
        targetScreenId = screenId;
      }
      const before = await readIssueState();
      await createIssue(issueInput({ versionId: currentVersionId, screenId: targetScreenId, xRatio: 0.5, yRatio: 0.5 }))
        .expect(404)
        .expect(screenNotFoundBody);
      expect(await readIssueState()).toEqual(before);
    },
  );

  it.each<[string, Record<string, unknown>]>([
    ['제목 빈 문자열', { title: '' }],
    ['제목 공백', { title: ' \n\t ' }],
    ['제목 121자', { title: '가'.repeat(121) }],
    ['제목 없음', { title: undefined }],
    ['제목이 문자열 아님', { title: 123 }],
    ['본문 4,001자', { body: '가'.repeat(4001) }],
    ['본문 없음', { body: undefined }],
    ['본문이 수', { body: 123 }],
    ['본문이 null', { body: null }],
    ['본문이 배열', { body: ['글'] }],
    ['본문이 객체', { body: { text: '글' } }],
    ['requestId가 UUID 아님', { requestId: 'not-a-uuid' }],
    ['requestId 없음', { requestId: undefined }],
    ['versionId가 UUID 아님', { versionId: 'not-a-uuid' }],
    ['versionId 없음', { versionId: undefined }],
    ['모르는 칸 status', { status: 'IN_PROGRESS' }],
    ['모르는 칸 number', { number: 99 }],
    ['모르는 칸 authorId', { authorId: missingId }],
    ['모르는 칸 scope', { scope: 'OUT_OF_SCOPE' }],
    ['모르는 칸 dueDate', { dueDate: '2026-12-31' }],
  ])('잘못된 본문 %s는 422이고 저장하지 않는다', async (_name, changes) => {
    const before = await readIssueState();
    await createIssue(issueInput(changes)).expect(422);
    expect(await readIssueState()).toEqual(before);
  });

  it('제목 120자·본문 4,000자·빈 본문은 201이고 제목 앞뒤 공백을 지운다', async () => {
    const title = '가'.repeat(120);
    for (const body of ['나'.repeat(4000), '']) {
      const created = await createIssue(issueInput({ title: ` \n${title}\t `, body })).expect(201);
      expect(created.body).toMatchObject({ title, body, originVersion: { id: versionId, number: 0 }, origin: null });
      await get(`/api/issues/${created.body.id}`).expect(200).expect(created.body);
      expect(await prisma.issue.findUniqueOrThrow({ where: { id: created.body.id } })).toMatchObject({ title, body });
    }
    expect(await prisma.issue.count()).toBe(2);
  });

  it('동시에 다섯 개를 써도 번호는 1~5로 겹치지 않고 다른 프로젝트는 다시 1부터다', async () => {
    const responses = await Promise.all(
      Array.from({ length: 5 }, (_, index) => createIssue(issueInput({ title: `쪽지 ${index}` }))),
    );
    expect(responses.map(({ status }) => status)).toEqual([201, 201, 201, 201, 201]);
    expect(responses.map(({ body }) => body.number).sort((a: number, b: number) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(responses.map(({ body }) => body.id)).size).toBe(5);
    const other = await publishOtherProject();
    const otherIssue = await createIssue(issueInput({ versionId: other.versionId }), cookie, otherProjectId).expect(
      201,
    );
    expect(otherIssue.body.number).toBe(1);
    const list = await get(`/api/projects/${projectId}/issues`).expect(200);
    expect(list.body.map((issue: { number: number }) => issue.number)).toEqual([5, 4, 3, 2, 1]);
    expect(
      list.body.map((issue: { id: string }) => issue.id).sort((a: string, b: string) => a.localeCompare(b)),
    ).toEqual(responses.map(({ body }) => body.id).sort((a: string, b: string) => a.localeCompare(b)));
    const otherList = await get(`/api/projects/${otherProjectId}/issues`).expect(200);
    expect(otherList.body).toEqual([expect.objectContaining({ id: otherIssue.body.id, number: 1 })]);
    expect(await prisma.issue.count({ where: { projectId } })).toBe(5);
    expect(await prisma.activityEvent.count({ where: { projectId, type: 'ISSUE_CREATED' } })).toBe(5);
  });

  it('쪽지 쓰기가 일지 저장에서 실패하면 쪽지가 없고 다음 쪽지가 그 번호를 쓴다', async () => {
    const first = await createIssue(issueInput()).expect(201);
    const failedInput = issueInput({ title: '실패할 쪽지' });
    const before = await readIssueState();
    try {
      await prisma.$executeRaw`
        CREATE FUNCTION issues_e2e_fail_create_event() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'issues e2e create event failure';
        END;
        $$
      `;
      await prisma.$executeRaw`
        CREATE TRIGGER issues_e2e_fail_create_event
        BEFORE INSERT ON activity_events FOR EACH ROW
        EXECUTE FUNCTION issues_e2e_fail_create_event()
      `;
      await createIssue(failedInput).expect(500);
      expect(await readIssueState()).toEqual(before);
      expect(await prisma.issue.count({ where: { requestId: failedInput.requestId } })).toBe(0);
    } finally {
      await prisma.$executeRaw`DROP TRIGGER IF EXISTS issues_e2e_fail_create_event ON activity_events`;
      await prisma.$executeRaw`DROP FUNCTION IF EXISTS issues_e2e_fail_create_event()`;
    }
    const next = await createIssue(issueInput({ title: '다음 쪽지' })).expect(201);
    expect(next.body.number).toBe(first.body.number + 1);
    expect(await prisma.issue.count()).toBe(2);
    expect(await prisma.activityEvent.count({ where: { type: 'ISSUE_CREATED' } })).toBe(2);
    await get(`/api/issues/${first.body.id}`).expect(200).expect(first.body);
  });

  it('새 버전을 게시하고 화면을 숨겨도 예전 쪽지의 처음 위치와 사진은 그대로다', async () => {
    const pinned = await createIssue(issueInput({ screenId, xRatio: 0.25, yRatio: 0.75 }), clientCookie).expect(201);
    const unpinned = await createIssue(issueInput(), clientCookie).expect(201);
    const originalList = await get(`/api/projects/${projectId}/issues`, clientCookie).expect(200);
    const draft = await createDraft();
    const replacement = await sharp({ create: { width: 64, height: 48, channels: 3, background: 'blue' } })
      .png()
      .toBuffer();
    const uploaded = await upload(draft.body.id, screenId, replacement);
    expect(uploaded.body.screens[0].asset.id).not.toBe(assetId);
    await publish(draft.body.id);
    await post(`/api/screens/${screenId}/hide`).expect(200);
    expect((await prisma.screen.findUniqueOrThrow({ where: { id: screenId } })).hiddenAt).not.toBeNull();
    await get(`/api/projects/${projectId}/issues`, clientCookie).expect(200).expect(originalList.body);
    await get(`/api/issues/${pinned.body.id}`, clientCookie).expect(200).expect(pinned.body);
    await get(`/api/issues/${unpinned.body.id}`, clientCookie).expect(200).expect(unpinned.body);
    expect(pinned.body.origin).toEqual({
      screenId,
      screenName: '첫 화면',
      viewport: 'PC',
      asset: { id: assetId, width: 32, height: 24 },
      xRatio: 0.25,
      yRatio: 0.75,
    });
    const oldPhoto = await get(`/api/assets/${assetId}`, clientCookie).expect(200);
    expect(await sharp(oldPhoto.body as Buffer).metadata()).toMatchObject({ width: 32, height: 24 });
  });

  it.each(['not-a-uuid', missingId])('목록·쓰기·상세의 경로 id=%s는 같은 종류의 없는 자원과 같은 404다', async (id) => {
    const before = await readIssueState();
    await get(`/api/projects/${id}/issues`).expect(404).expect(projectNotFoundBody);
    await createIssue(issueInput(), cookie, id).expect(404).expect(projectNotFoundBody);
    await get(`/api/issues/${id}`).expect(404).expect(issueNotFoundBody);
    expect(await readIssueState()).toEqual(before);
  });

  it.each(['클라이언트', '개발자'] as const)(
    '개발자는 %s가 쓴 접수 쪽지를 시작하면 200이고 상세·목록·일지에 수정 중과 쪽지 번호가 남는다',
    async (author) => {
      const created = await createIssue(
        issueInput({ screenId, xRatio: 0.25, yRatio: 0.75 }),
        author === '개발자' ? cookie : clientCookie,
      ).expect(201);
      const before = await readIssueState();
      const expected = { ...created.body, status: 'IN_PROGRESS', isMine: author === '개발자', canReview: false };
      await post(`/api/issues/${created.body.id}/start`).send({ versionId }).expect(200).expect(expected);
      await get(`/api/issues/${created.body.id}`).expect(200).expect(expected);
      const list = await get(`/api/projects/${projectId}/issues`).expect(200);
      expect(list.body).toEqual([expect.objectContaining({ id: created.body.id, status: 'IN_PROGRESS' })]);
      const after = await readIssueState();
      expect(after.issues).toEqual(before.issues.map((issue) => ({ ...issue, status: 'IN_PROGRESS' })));
      expect(after.events).toEqual(expect.arrayContaining(before.events));
      expect(after.events).toHaveLength(before.events.length + 1);
      expect(after.events.filter(({ type }) => type === 'ISSUE_STARTED')).toEqual([
        expect.objectContaining({ projectId, actorId: developerId, issueId: created.body.id }),
      ]);
      const activity = await get(`/api/projects/${projectId}/activity`, clientCookie).expect(200);
      expect(activity.body.filter((event: { type: string }) => event.type === 'ISSUE_STARTED')).toEqual([
        {
          id: expect.any(String),
          type: 'ISSUE_STARTED',
          createdAt: expect.any(String),
          actorName: '개발자',
          version: null,
          memberName: null,
          issue: { id: created.body.id, number: created.body.number },
        },
      ]);
    },
  );

  it('보던 버전 뒤에 새 버전이 게시되면 수정 시작은 409 VERSION_CHANGED이고 상태가 그대로다', async () => {
    const created = await createIssue(issueInput(), clientCookie).expect(201);
    const draft = await createDraft();
    await publish(draft.body.id);
    const before = await readIssueState();
    await post(`/api/issues/${created.body.id}/start`).send({ versionId }).expect(409).expect(versionChangedBody);
    expect(await readIssueState()).toEqual(before);
    await get(`/api/issues/${created.body.id}`, clientCookie).expect(200).expect(created.body);
  });

  it('지난 버전에서 시작한 쪽지도 현재 버전 id로 수정 시작하고 처음 위치는 그대로다', async () => {
    const created = await createIssue(issueInput({ screenId, xRatio: 0.2, yRatio: 0.8 }), clientCookie).expect(201);
    const draft = await createDraft();
    await publish(draft.body.id);
    const expected = { ...created.body, status: 'IN_PROGRESS', isMine: false, canReview: false };
    await post(`/api/issues/${created.body.id}/start`).send({ versionId: draft.body.id }).expect(200).expect(expected);
    await get(`/api/issues/${created.body.id}`).expect(200).expect(expected);
    expect(await prisma.activityEvent.count({ where: { issueId: created.body.id, type: 'ISSUE_STARTED' } })).toBe(1);
  });

  it('클라이언트와 승인자의 수정 시작은 403이고 상태·일지가 그대로다', async () => {
    const created = await createIssue(issueInput(), clientCookie).expect(201);
    const draft = await createDraft();
    await publish(draft.body.id);
    const before = await readIssueState();
    // 지난 버전을 보내도 역할 검사가 먼저라 409가 아닌 403이다.
    for (const memberCookie of [clientCookie, approverCookie]) {
      for (const viewedVersionId of [versionId, draft.body.id]) {
        await post(`/api/issues/${created.body.id}/start`, memberCookie)
          .send({ versionId: viewedVersionId })
          .expect(403)
          .expect({ statusCode: 403, message: '개발자만 할 수 있어요', error: 'Forbidden' });
      }
    }
    expect(await readIssueState()).toEqual(before);
  });

  it('수정 시작을 동시에 두 번 보내면 200과 409 ISSUE_NOT_OPEN이고 일지는 하나다', async () => {
    const created = await createIssue(issueInput(), clientCookie).expect(201);
    const responses = await Promise.all([
      post(`/api/issues/${created.body.id}/start`).send({ versionId }),
      post(`/api/issues/${created.body.id}/start`).send({ versionId }),
    ]);
    expect(responses.map(({ status }) => status).sort((a, b) => a - b)).toEqual([200, 409]);
    expect(responses.find(({ status }) => status === 200)?.body).toEqual({
      ...created.body,
      status: 'IN_PROGRESS',
      isMine: false,
      canReview: false,
    });
    expect(responses.find(({ status }) => status === 409)?.body).toEqual({
      statusCode: 409,
      code: 'ISSUE_NOT_OPEN',
      message: '접수 상태의 쪽지만 시작할 수 있어요',
    });
    expect(await prisma.activityEvent.findMany({ where: { type: 'ISSUE_STARTED' } })).toEqual([
      expect.objectContaining({ projectId, actorId: developerId, issueId: created.body.id }),
    ]);
    const before = await readIssueState();
    // 동시에 보낸 경우뿐 아니라 이미 수정 중인 쪽지를 다시 눌러도 거절한다.
    await post(`/api/issues/${created.body.id}/start`).send({ versionId }).expect(409).expect({
      statusCode: 409,
      code: 'ISSUE_NOT_OPEN',
      message: '접수 상태의 쪽지만 시작할 수 있어요',
    });
    expect(await readIssueState()).toEqual(before);
    await get(`/api/issues/${created.body.id}`, clientCookie)
      .expect(200)
      .expect({ ...created.body, status: 'IN_PROGRESS' });
  });

  it('수정 시작이 일지 저장에서 실패하면 상태가 접수 그대로다', async () => {
    const created = await createIssue(issueInput(), clientCookie).expect(201);
    const before = await readIssueState();
    try {
      await prisma.$executeRaw`
        CREATE FUNCTION issues_e2e_fail_start_event() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.type = 'ISSUE_STARTED' THEN
            RAISE EXCEPTION 'issues e2e start event failure';
          END IF;
          RETURN NEW;
        END;
        $$
      `;
      await prisma.$executeRaw`
        CREATE TRIGGER issues_e2e_fail_start_event
        BEFORE INSERT ON activity_events FOR EACH ROW
        EXECUTE FUNCTION issues_e2e_fail_start_event()
      `;
      await post(`/api/issues/${created.body.id}/start`).send({ versionId }).expect(500);
      expect(await readIssueState()).toEqual(before);
      await get(`/api/issues/${created.body.id}`, clientCookie).expect(200).expect(created.body);
    } finally {
      try {
        await prisma.$executeRaw`DROP TRIGGER IF EXISTS issues_e2e_fail_start_event ON activity_events`;
      } finally {
        await prisma.$executeRaw`DROP FUNCTION IF EXISTS issues_e2e_fail_start_event()`;
      }
    }
    await post(`/api/issues/${created.body.id}/start`).send({ versionId }).expect(200);
    expect(await prisma.activityEvent.count({ where: { issueId: created.body.id, type: 'ISSUE_STARTED' } })).toBe(1);
  });

  it.each(['멤버가 아닌 사람', '접근이 철회된 사람', '없는 프로젝트·쪽지', '틀린 모양의 id'] as const)(
    '%s는 목록·상세·쓰기·수정 시작이 모두 같은 404다',
    async (scenario) => {
      const input = issueInput();
      const created = await createIssue(input, clientCookie).expect(201);
      let memberCookie = clientCookie;
      let targetProjectId = projectId;
      let targetIssueId = created.body.id as string;
      if (scenario === '멤버가 아닌 사람') {
        const outsider = await prisma.user.create({ data: { email: 'outsider@example.com', name: '외부인' } });
        memberCookie = await login(outsider.id);
      }
      if (scenario === '접근이 철회된 사람') {
        const issue = await prisma.issue.findUniqueOrThrow({ where: { id: targetIssueId } });
        await prisma.projectMember.update({
          where: { projectId_userId: { projectId, userId: issue.authorId } },
          data: { revokedAt: new Date() },
        });
      }
      if (scenario === '없는 프로젝트·쪽지') targetProjectId = targetIssueId = missingId;
      if (scenario === '틀린 모양의 id') targetProjectId = targetIssueId = 'not-a-uuid';
      const before = await readIssueState();
      await get(`/api/projects/${targetProjectId}/issues`, memberCookie).expect(404).expect(projectNotFoundBody);
      await get(`/api/issues/${targetIssueId}`, memberCookie).expect(404).expect(issueNotFoundBody);
      // 철회된 작성자도 같은 requestId로 처음 쪽지를 다시 받을 수 없다.
      await createIssue(input, memberCookie, targetProjectId).expect(404).expect(projectNotFoundBody);
      await createIssue(issueInput(), memberCookie, targetProjectId).expect(404).expect(projectNotFoundBody);
      // 버전과 개발자 검사가 멤버 확인보다 먼저 실행되면 이 기대값을 만족하지 못한다.
      await post(`/api/issues/${targetIssueId}/start`, memberCookie)
        .send({ versionId: missingId })
        .expect(404)
        .expect(issueNotFoundBody);
      expect(await readIssueState()).toEqual(before);
    },
  );

  it.each(['목록', '상세', '쓰기', '수정 시작'] as const)('%s는 로그인하지 않으면 401이다', async (operation) => {
    const created = await createIssue(issueInput()).expect(201);
    const before = await readIssueState();
    const requests = {
      목록: () => request(server).get(`/api/projects/${projectId}/issues`),
      상세: () => request(server).get(`/api/issues/${created.body.id}`),
      쓰기: () => request(server).post(`/api/projects/${projectId}/issues`).send(issueInput()),
      '수정 시작': () => request(server).post(`/api/issues/${created.body.id}/start`).send({ versionId }),
    };
    await requests[operation]().set('Origin', origin).expect(401);
    expect(await readIssueState()).toEqual(before);
  });

  it.each(['쓰기', '수정 시작'] as const)('%s는 다른 Origin이면 403이고 아무것도 바뀌지 않는다', async (operation) => {
    const created = await createIssue(issueInput()).expect(201);
    const before = await readIssueState();
    for (const requestOrigin of [undefined, 'https://other.example.com']) {
      const pending =
        operation === '쓰기'
          ? request(server).post(`/api/projects/${projectId}/issues`).send(issueInput())
          : request(server).post(`/api/issues/${created.body.id}/start`).send({ versionId });
      pending.set('Cookie', cookie);
      if (requestOrigin) pending.set('Origin', requestOrigin);
      await pending.expect(403);
      expect(await readIssueState()).toEqual(before);
    }
  });

  it.each(['쪽지 쓰기', '수정 시작', '댓글', '참고 사진'] as const)(
    '현재 버전이 승인된 뒤 %s는 409 VERSION_NOT_IN_REVIEW이고 아무것도 바뀌지 않는다',
    async (operation) => {
      const created = await createIssue(issueInput()).expect(201);
      await prisma.deliveryVersion.update({ where: { id: versionId }, data: { status: 'APPROVED' } });
      const before = await readIssueState();
      const commentsBefore = await prisma.comment.findMany({ orderBy: { id: 'asc' } });
      const attachmentsBefore = await prisma.issueAttachment.findMany({ orderBy: { id: 'asc' } });
      const assetsBefore = await prisma.asset.findMany({ orderBy: { id: 'asc' } });
      const filesBefore = (await readdir(directory, { recursive: true, withFileTypes: true }))
        .filter((entry) => entry.isFile())
        .map((entry) => join(entry.parentPath, entry.name))
        .sort();
      const requests = {
        '쪽지 쓰기': () => createIssue(issueInput()),
        '수정 시작': () => post(`/api/issues/${created.body.id}/start`).send({ versionId }),
        댓글: () =>
          post(`/api/issues/${created.body.id}/comments`).send({ versionId, requestId: randomUUID(), body: '댓글' }),
        '참고 사진': () => post(`/api/issues/${created.body.id}/attachments`).attach('file', photo, 'reference.png'),
      };
      const pending = requests[operation]();
      await pending.expect(409).expect({
        statusCode: 409,
        code: 'VERSION_NOT_IN_REVIEW',
        message: '검수 중인 버전이 아니에요',
      });
      expect(await readIssueState()).toEqual(before);
      expect(await prisma.comment.findMany({ orderBy: { id: 'asc' } })).toEqual(commentsBefore);
      expect(await prisma.asset.findMany({ orderBy: { id: 'asc' } })).toEqual(assetsBefore);
      expect(await prisma.issueAttachment.findMany({ orderBy: { id: 'asc' } })).toEqual(attachmentsBefore);
      expect(
        (await readdir(directory, { recursive: true, withFileTypes: true }))
          .filter((entry) => entry.isFile())
          .map((entry) => join(entry.parentPath, entry.name))
          .sort(),
      ).toEqual(filesBefore);
      expect((await prisma.deliveryVersion.findUniqueOrThrow({ where: { id: versionId } })).status).toBe('APPROVED');
    },
  );

  it('철회된 사람의 쪽지·댓글은 그 이름으로 남고 다시 들어오면 isMine이 참이며 참고 사진을 붙일 수 있다', async () => {
    vi.stubEnv('APP_URL', 'https://review.example.com');
    const created = await createIssue(issueInput(), clientCookie).expect(201);
    await post(`/api/issues/${created.body.id}/comments`, clientCookie)
      .send({ versionId, requestId: randomUUID(), body: '예전 댓글' })
      .expect(201);
    const before = await get(`/api/issues/${created.body.id}`, clientCookie).expect(200);
    const issueBefore = await prisma.issue.findUniqueOrThrow({ where: { id: created.body.id } });
    const commentsBefore = await prisma.comment.findMany({ where: { issueId: created.body.id } });
    const author = await prisma.user.findUniqueOrThrow({ where: { email: 'client@example.com' } });
    const member = await prisma.projectMember.findUniqueOrThrow({
      where: { projectId_userId: { projectId, userId: author.id } },
    });
    await post(`/api/members/${member.id}/revoke`).expect(204);
    await get(`/api/issues/${created.body.id}`, clientCookie).expect(404).expect(issueNotFoundBody);
    await get(`/api/issues/${created.body.id}`)
      .expect(200)
      .expect({ ...before.body, isMine: false, canReview: false });
    const list = await get(`/api/projects/${projectId}/issues`).expect(200);
    expect(list.body).toEqual([
      expect.objectContaining({ id: created.body.id, authorName: '클라이언트', commentCount: 1 }),
    ]);
    expect(before.body.comments).toEqual([expect.objectContaining({ authorName: '클라이언트', body: '예전 댓글' })]);
    await post(`/api/issues/${created.body.id}/attachments`, clientCookie)
      .attach('file', photo, 'reference.png')
      .expect(404)
      .expect(issueNotFoundBody);
    const invitation = await post(`/api/projects/${projectId}/invitations`).send({ email: author.email }).expect(201);
    const token = new URL(invitation.body.link).pathname.split('/').at(-1)!;
    await post('/api/invitations/accept', clientCookie).send({ token }).expect(200).expect({ projectId });
    await get(`/api/issues/${created.body.id}`, clientCookie).expect(200).expect(before.body);
    const attached = await post(`/api/issues/${created.body.id}/attachments`, clientCookie)
      .attach('file', photo, 'reference.png')
      .expect(201);
    expect(attached.body).toEqual({
      ...before.body,
      attachments: [{ id: expect.any(String), assetId: expect.any(String), width: 32, height: 24 }],
    });
    await get(`/api/issues/${created.body.id}`, clientCookie).expect(200).expect(attached.body);
    expect(await prisma.issue.count()).toBe(1);
    expect(await prisma.comment.count()).toBe(1);
    expect(await prisma.issueAttachment.count({ where: { issueId: created.body.id } })).toBe(1);
    expect(await prisma.issue.findUniqueOrThrow({ where: { id: created.body.id } })).toMatchObject({
      authorId: author.id,
    });
    expect(await prisma.comment.findMany()).toEqual([expect.objectContaining({ authorId: author.id })]);
    expect(await prisma.issue.findUniqueOrThrow({ where: { id: created.body.id } })).toEqual(issueBefore);
    expect(await prisma.comment.findMany({ where: { issueId: created.body.id } })).toEqual(commentsBefore);
    expect(await prisma.projectMember.findUniqueOrThrow({ where: { id: member.id } })).toMatchObject({
      userId: author.id,
      revokedAt: null,
    });
  });

  it('쪽지 작성과 수정 시작은 일지에 쪽지 번호와 함께 남고 댓글은 남지 않는다', async () => {
    const created = await createIssue(issueInput(), clientCookie).expect(201);
    await post(`/api/issues/${created.body.id}/start`).send({ versionId }).expect(200);
    const before = await get(`/api/projects/${projectId}/activity`).expect(200);
    expect(before.body.filter((event: { issue: unknown }) => event.issue !== null)).toEqual([
      {
        id: expect.any(String),
        type: 'ISSUE_STARTED',
        createdAt: expect.any(String),
        actorName: '개발자',
        version: null,
        memberName: null,
        issue: { id: created.body.id, number: created.body.number },
      },
      {
        id: expect.any(String),
        type: 'ISSUE_CREATED',
        createdAt: expect.any(String),
        actorName: '클라이언트',
        version: null,
        memberName: null,
        issue: { id: created.body.id, number: created.body.number },
      },
    ]);
    const events = await prisma.activityEvent.findMany({ orderBy: { id: 'asc' } });
    await post(`/api/issues/${created.body.id}/comments`, approverCookie)
      .send({ versionId, requestId: randomUUID(), body: '확인했어요' })
      .expect(201);
    expect(await prisma.comment.count()).toBe(1);
    await get(`/api/projects/${projectId}/activity`).expect(200).expect(before.body);
    expect(await prisma.activityEvent.findMany({ orderBy: { id: 'asc' } })).toEqual(events);
  });

  it.each<[string, Record<string, unknown>]>([
    ['versionId가 UUID 아님', { versionId: 'not-a-uuid' }],
    ['versionId 없음', { versionId: undefined }],
    ['versionId가 null', { versionId: null }],
    ['versionId가 수', { versionId: 123 }],
    ['versionId가 배열', { versionId: [missingId] }],
    ['모르는 칸 status', { status: 'IN_PROGRESS' }],
    ['모르는 칸 requestId', { requestId: missingId }],
    ['모르는 칸 authorId', { authorId: missingId }],
  ])('수정 시작 입력 %s는 422이고 상태·일지가 그대로다', async (_name, changes) => {
    const created = await createIssue(issueInput()).expect(201);
    const before = await readIssueState();
    await post(`/api/issues/${created.body.id}/start`)
      .send({ versionId, ...changes })
      .expect(422);
    expect(await readIssueState()).toEqual(before);
  });

  it.each(['게시 전 버전', '남의 프로젝트 버전', '없는 id', '현재 버전 없음'] as const)(
    '수정 시작의 versionId가 %s이면 409 VERSION_CHANGED이고 상태·일지가 그대로다',
    async (scenario) => {
      const created = await createIssue(issueInput()).expect(201);
      let viewedVersionId = missingId;
      if (scenario === '게시 전 버전') viewedVersionId = (await createDraft()).body.id;
      if (scenario === '남의 프로젝트 버전') viewedVersionId = (await publishOtherProject()).versionId;
      if (scenario === '현재 버전 없음') {
        viewedVersionId = versionId;
        await prisma.project.update({ where: { id: projectId }, data: { currentVersionId: null } });
      }
      const before = await readIssueState();
      await post(`/api/issues/${created.body.id}/start`)
        .send({ versionId: viewedVersionId })
        .expect(409)
        .expect(versionChangedBody);
      expect(await readIssueState()).toEqual(before);
    },
  );
});
