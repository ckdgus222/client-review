import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { createSessionToken, hashSessionToken } from '../src/auth/token.js';
import { MailService } from '../src/mail/mail.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { setupApp } from '../src/setup-app.js';
import { resetDatabase } from './reset-database.js';

const origin = 'http://localhost:5173';
const missingId = '00000000-0000-4000-8000-000000000001';
const firstHiddenAt = new Date('2026-01-04T00:00:00.123Z');
const screenExistsBody = { statusCode: 409, message: '이미 있는 화면이에요', code: 'SCREEN_EXISTS' };
const projectNotFoundBody = { statusCode: 404, message: '없는 프로젝트예요', error: 'Not Found' };
const screenNotFoundBody = { statusCode: 404, message: '없는 화면이에요', error: 'Not Found' };

describe('화면 API (e2e)', () => {
  let app: INestApplication | undefined;
  let server: Server;
  let prisma: PrismaService;
  let projectId: string;
  let otherProjectId: string;
  let cookie: string;
  let clientCookie: string;
  const sendLoginCode = vi.fn<MailService['sendLoginCode']>();

  const login = async (userId: string) => {
    const token = createSessionToken();
    await prisma.session.create({
      data: {
        userId,
        tokenHash: hashSessionToken(token),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    return `sid=${token}`;
  };

  const post = (path: string, memberCookie = cookie) =>
    request(server).post(path).set('Origin', origin).set('Cookie', memberCookie);

  const createScreen = (hiddenAt: Date | null = null, targetProjectId = projectId) =>
    prisma.screen.create({ data: { projectId: targetProjectId, name: '메인', viewport: 'PC', hiddenAt } });

  beforeEach(async () => {
    vi.stubEnv('APP_ORIGINS', origin);
    vi.stubEnv('COOKIE_SECURE', undefined);
    sendLoginCode.mockReset();
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MailService)
      .useValue({ sendLoginCode })
      .compile();

    app = module.createNestApplication();
    setupApp(app);
    await app.init();
    server = app.getHttpServer() as Server;
    prisma = app.get(PrismaService);
    await resetDatabase(prisma);
    const developer = await prisma.user.create({ data: { email: 'developer@example.com', name: '개발자' } });
    const client = await prisma.user.create({ data: { email: 'client@example.com', name: '클라이언트' } });
    const project = await prisma.project.create({
      data: {
        name: '함께 보는 프로젝트',
        members: {
          create: [
            { userId: developer.id, role: 'DEVELOPER' },
            { userId: client.id, role: 'CLIENT' },
          ],
        },
      },
    });
    // 다른 곳의 개발자라도 이 프로젝트에서는 CLIENT 권한만 있어야 한다.
    const otherProject = await prisma.project.create({
      data: { name: '남의 프로젝트', members: { create: { userId: client.id, role: 'DEVELOPER' } } },
    });
    projectId = project.id;
    otherProjectId = otherProject.id;
    cookie = await login(developer.id);
    clientCookie = await login(client.id);
  });

  afterEach(async () => {
    try {
      await app?.close();
    } finally {
      app = undefined;
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  });

  it.each(['DEVELOPER', 'CLIENT'] as const)(
    '목록은 %s에게 해당 프로젝트의 숨긴 화면까지 만든 순으로 네 칸만 돌려준다',
    async (role) => {
      // 입력 순서와 이름순을 createdAt 순서와 다르게 둔다.
      const newer = await prisma.screen.create({
        data: { projectId, name: '가', viewport: 'PC', createdAt: new Date('2026-01-03T00:00:00Z') },
      });
      const older = await prisma.screen.create({
        data: {
          projectId,
          name: '나',
          viewport: 'MOBILE',
          hiddenAt: firstHiddenAt,
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
      });
      await createScreen(null, otherProjectId);
      const memberCookie = role === 'DEVELOPER' ? cookie : clientCookie;

      await request(server)
        .get(`/api/projects/${projectId}/screens`)
        .set('Cookie', memberCookie)
        .expect(200)
        .expect([
          { id: older.id, name: '나', viewport: 'MOBILE', hiddenAt: firstHiddenAt.toISOString() },
          { id: newer.id, name: '가', viewport: 'PC', hiddenAt: null },
        ]);
    },
  );

  it.each(['DEVELOPER', 'CLIENT'] as const)('화면이 없으면 %s에게 빈 목록을 돌려준다', async (role) => {
    await createScreen(null, otherProjectId);
    const memberCookie = role === 'DEVELOPER' ? cookie : clientCookie;

    await request(server).get(`/api/projects/${projectId}/screens`).set('Cookie', memberCookie).expect(200).expect([]);
  });

  it.each(['PC', 'MOBILE'] as const)(
    '%s 화면을 만들면 앞뒤 공백만 지워 저장하고 클라이언트 목록에도 보인다',
    async (viewport) => {
      const response = await post(`/api/projects/${projectId}/screens`)
        .send({ name: ' \t상품  상세\n ', viewport })
        .expect(201);

      expect(response.body).toEqual({ id: expect.any(String), name: '상품  상세', viewport, hiddenAt: null });
      expect(await prisma.screen.findMany()).toEqual([{ ...response.body, projectId, createdAt: expect.any(Date) }]);
      await request(server)
        .get(`/api/projects/${projectId}/screens`)
        .set('Cookie', clientCookie)
        .expect(200)
        .expect([response.body]);
    },
  );

  it.each(['가', '가'.repeat(40)])('이름 경계값 %s는 공백을 지운 뒤 허용한다', async (name) => {
    const response = await post(`/api/projects/${projectId}/screens`)
      .send({ name: `  ${name}  `, viewport: 'PC' })
      .expect(201);

    expect(response.body).toEqual({ id: expect.any(String), name, viewport: 'PC', hiddenAt: null });
    expect(await prisma.screen.findMany()).toEqual([{ ...response.body, projectId, createdAt: expect.any(Date) }]);
  });

  it.each([
    { label: '없음', value: undefined },
    { label: '빈 문자열', value: '' },
    { label: '공백만', value: ' \t\n ' },
    { label: '41자', value: '가'.repeat(41) },
    { label: '공백 제거 뒤 41자', value: `  ${'가'.repeat(41)}  ` },
    { label: '숫자', value: 123 },
    { label: '불리언', value: true },
    { label: '배열', value: ['메인'] },
    { label: '객체', value: { name: '메인' } },
    { label: 'null', value: null },
  ])('이름이 $label이면 422이고 화면이 생기지 않는다', async ({ value }) => {
    const response = await post(`/api/projects/${projectId}/screens`).send({ name: value, viewport: 'PC' }).expect(422);

    expect(response.body.statusCode).toBe(422);
    expect(response.body.message).toEqual(expect.any(Array));
    expect(await prisma.screen.count()).toBe(0);
  });

  it.each([
    { label: '없음', value: undefined },
    { label: 'TABLET', value: 'TABLET' },
    { label: '소문자 pc', value: 'pc' },
    { label: '숫자', value: 1 },
    { label: '빈 문자열', value: '' },
    { label: '앞뒤 공백', value: ' PC ' },
    { label: '불리언', value: true },
    { label: '배열', value: ['PC'] },
    { label: '객체', value: { viewport: 'PC' } },
    { label: 'null', value: null },
  ])('viewport가 $label이면 422이고 화면이 생기지 않는다', async ({ value }) => {
    const response = await post(`/api/projects/${projectId}/screens`)
      .send({ name: '메인', viewport: value })
      .expect(422);

    expect(response.body.statusCode).toBe(422);
    expect(response.body.message).toEqual(expect.any(Array));
    expect(await prisma.screen.count()).toBe(0);
  });

  it.each([
    { label: '모르는 칸', body: { name: '메인', viewport: 'PC', unexpected: true } },
    { label: 'hiddenAt 지정', body: { name: '메인', viewport: 'PC', hiddenAt: firstHiddenAt.toISOString() } },
    { label: '배열 본문', body: [{ name: '메인', viewport: 'PC' }] },
    { label: '빈 객체', body: {} },
  ])('$label은 422이고 화면이 생기지 않는다', async ({ body }) => {
    const response = await post(`/api/projects/${projectId}/screens`).send(body).expect(422);

    expect(response.body.statusCode).toBe(422);
    expect(response.body.message).toEqual(expect.any(Array));
    expect(await prisma.screen.count()).toBe(0);
  });

  it('클라이언트는 다른 프로젝트의 개발자여도 생성이 403이고 화면이 생기지 않는다', async () => {
    await post(`/api/projects/${projectId}/screens`, clientCookie).send({ name: '메인', viewport: 'PC' }).expect(403);

    expect(await prisma.screen.count()).toBe(0);
  });

  it.each([null, firstHiddenAt])(
    'hiddenAt=%s인 같은 이름·기기는 공백을 지운 뒤 409이고 기존 화면을 보존한다',
    async (hiddenAt) => {
      const existing = await createScreen(hiddenAt);

      await post(`/api/projects/${projectId}/screens`)
        .send({ name: ' \t메인\n ', viewport: 'PC' })
        .expect(409)
        .expect(screenExistsBody);

      expect(await prisma.screen.findMany()).toEqual([existing]);
    },
  );

  it('같은 이름이라도 기기나 프로젝트가 다르면 만들 수 있다', async () => {
    const existing = await createScreen();
    const mobile = await post(`/api/projects/${projectId}/screens`)
      .send({ name: '메인', viewport: 'MOBILE' })
      .expect(201);
    const other = await post(`/api/projects/${otherProjectId}/screens`, clientCookie)
      .send({ name: '메인', viewport: 'PC' })
      .expect(201);

    expect(mobile.body).toEqual({ id: expect.any(String), name: '메인', viewport: 'MOBILE', hiddenAt: null });
    expect(other.body).toEqual({ id: expect.any(String), name: '메인', viewport: 'PC', hiddenAt: null });
    const saved = await prisma.screen.findMany();
    expect(saved).toHaveLength(3);
    expect(saved).toEqual(
      expect.arrayContaining([
        existing,
        { ...mobile.body, projectId, createdAt: expect.any(Date) },
        { ...other.body, projectId: otherProjectId, createdAt: expect.any(Date) },
      ]),
    );
  });

  it('같은 이름·기기를 동시에 생성하면 하나만 201이고 다른 하나는 SCREEN_EXISTS 409다', async () => {
    const responses = await Promise.all([
      post(`/api/projects/${projectId}/screens`).send({ name: '메인', viewport: 'PC' }),
      post(`/api/projects/${projectId}/screens`).send({ name: ' 메인 ', viewport: 'PC' }),
    ]);

    expect(responses.map(({ status }) => status).sort((left, right) => left - right)).toEqual([201, 409]);
    expect(responses.find(({ status }) => status === 409)?.body).toEqual(screenExistsBody);
    const [saved] = await prisma.screen.findMany();
    expect(await prisma.screen.count()).toBe(1);
    expect(saved).toEqual({
      id: expect.any(String),
      projectId,
      name: '메인',
      viewport: 'PC',
      hiddenAt: null,
      createdAt: expect.any(Date),
    });
    expect(responses.find(({ status }) => status === 201)?.body).toEqual({
      id: saved.id,
      name: '메인',
      viewport: 'PC',
      hiddenAt: null,
    });
  });

  it('숨기고 다시 보이면 각각 200으로 화면을 돌려주고 DB와 클라이언트 목록에 반영된다', async () => {
    const screen = await createScreen();
    const untouched = await prisma.screen.create({ data: { projectId, name: '다른 화면', viewport: 'MOBILE' } });
    const hidden = await post(`/api/screens/${screen.id}/hide`).expect(200);

    expect(hidden.body).toEqual({ id: screen.id, name: '메인', viewport: 'PC', hiddenAt: expect.any(String) });
    expect(new Date(hidden.body.hiddenAt).toISOString()).toBe(hidden.body.hiddenAt);
    expect(await prisma.screen.findUnique({ where: { id: screen.id } })).toEqual({
      ...screen,
      hiddenAt: new Date(hidden.body.hiddenAt),
    });
    const hiddenList = await request(server)
      .get(`/api/projects/${projectId}/screens`)
      .set('Cookie', clientCookie)
      .expect(200);
    expect(hiddenList.body).toContainEqual(hidden.body);
    await post(`/api/screens/${screen.id}/hide`).expect(200).expect(hidden.body);

    const shown = await post(`/api/screens/${screen.id}/show`).expect(200);

    expect(shown.body).toEqual({ id: screen.id, name: '메인', viewport: 'PC', hiddenAt: null });
    await post(`/api/screens/${screen.id}/show`).expect(200).expect(shown.body);
    expect(await prisma.screen.findUnique({ where: { id: screen.id } })).toEqual(screen);
    expect(await prisma.screen.findUnique({ where: { id: untouched.id } })).toEqual(untouched);
    const shownList = await request(server)
      .get(`/api/projects/${projectId}/screens`)
      .set('Cookie', clientCookie)
      .expect(200);
    expect(shownList.body).toContainEqual(shown.body);
  });

  it('이미 숨긴 화면을 두 번 더 숨겨도 처음 숨긴 시각을 그대로 보존한다', async () => {
    const screen = await createScreen(firstHiddenAt);
    const expected = { id: screen.id, name: '메인', viewport: 'PC', hiddenAt: firstHiddenAt.toISOString() };

    await post(`/api/screens/${screen.id}/hide`).expect(200).expect(expected);
    await post(`/api/screens/${screen.id}/hide`).expect(200).expect(expected);

    expect(await prisma.screen.findMany()).toEqual([screen]);
  });

  it.each([
    { action: 'hide', hiddenAt: null },
    { action: 'hide', hiddenAt: firstHiddenAt },
    { action: 'show', hiddenAt: firstHiddenAt },
    { action: 'show', hiddenAt: null },
  ])('클라이언트의 $action 요청은 hiddenAt=$hiddenAt에서도 403이고 상태를 보존한다', async ({ action, hiddenAt }) => {
    const screen = await createScreen(hiddenAt);

    await post(`/api/screens/${screen.id}/${action}`, clientCookie).expect(403);

    expect(await prisma.screen.findMany()).toEqual([screen]);
  });

  it('동시에 두 번 숨겨도 두 응답과 저장된 숨긴 시각이 같다', async () => {
    const screen = await createScreen();
    const [first, second] = await Promise.all([
      post(`/api/screens/${screen.id}/hide`),
      post(`/api/screens/${screen.id}/hide`),
    ]);

    expect([first.status, second.status]).toEqual([200, 200]);
    expect(first.body).toEqual({ id: screen.id, name: '메인', viewport: 'PC', hiddenAt: expect.any(String) });
    expect(new Date(first.body.hiddenAt).toISOString()).toBe(first.body.hiddenAt);
    expect(second.body).toEqual(first.body);
    expect(await prisma.screen.findMany()).toEqual([{ ...screen, hiddenAt: new Date(first.body.hiddenAt) }]);
  });

  it.each([null, firstHiddenAt])(
    'hiddenAt=%s에서 숨기기와 보이기를 동시에 요청해도 두 요청 모두 200이다',
    async (hiddenAt) => {
      const screen = await createScreen(hiddenAt);
      const [hidden, shown] = await Promise.all([
        post(`/api/screens/${screen.id}/hide`),
        post(`/api/screens/${screen.id}/show`),
      ]);

      expect([hidden.status, shown.status]).toEqual([200, 200]);
      expect(hidden.body).toEqual({ id: screen.id, name: '메인', viewport: 'PC', hiddenAt: expect.any(String) });
      expect(new Date(hidden.body.hiddenAt).toISOString()).toBe(hidden.body.hiddenAt);
      expect(shown.body).toEqual({ id: screen.id, name: '메인', viewport: 'PC', hiddenAt: null });
      const saved = await prisma.screen.findUniqueOrThrow({ where: { id: screen.id } });
      // 어느 요청이 먼저 잠금을 얻는지는 정하지 않는다. 두 순서 중 하나의 결과여야 한다.
      expect([hidden.body.hiddenAt, null]).toContain(saved.hiddenAt?.toISOString() ?? null);
      expect(await prisma.screen.findMany()).toEqual([{ ...screen, hiddenAt: saved.hiddenAt }]);
    },
  );

  it.each(['get', 'post'] as const)(
    '%s 프로젝트 경로는 남의 프로젝트·없는 UUID·abc에 같은 404를 돌려준다',
    async (method) => {
      const existing = await createScreen(null, otherProjectId);

      for (const id of [otherProjectId, missingId, 'abc']) {
        const pending = request(server)
          [method](`/api/projects/${id}/screens`)
          .set('Origin', origin)
          .set('Cookie', cookie);
        if (method === 'post') pending.send({ name: '새 화면', viewport: 'MOBILE' });
        await pending.expect(404).expect(projectNotFoundBody);
      }

      expect(await prisma.screen.findMany()).toEqual([existing]);
    },
  );

  it.each(['hide', 'show'] as const)('%s 경로는 남의 화면·없는 UUID·abc에 같은 404를 돌려준다', async (action) => {
    const existing = await createScreen(action === 'hide' ? null : firstHiddenAt, otherProjectId);

    for (const id of [existing.id, missingId, 'abc']) {
      await post(`/api/screens/${id}/${action}`).expect(404).expect(screenNotFoundBody);
    }

    expect(await prisma.screen.findMany()).toEqual([existing]);
  });

  it('기존 프로젝트 상세도 남의 프로젝트·없는 UUID·abc에 같은 404 본문을 유지한다', async () => {
    for (const id of [otherProjectId, missingId, 'abc']) {
      await request(server).get(`/api/projects/${id}`).set('Cookie', cookie).expect(404).expect(projectNotFoundBody);
    }
  });

  it.each(['로그인 안 함', '세션 만료'] as const)('%s이면 네 경로 모두 401이고 화면을 바꾸지 않는다', async (state) => {
    const visible = await createScreen();
    const hidden = await prisma.screen.create({
      data: { projectId, name: '숨긴 화면', viewport: 'MOBILE', hiddenAt: firstHiddenAt },
    });
    if (state === '세션 만료') {
      await prisma.session.updateMany({ data: { expiresAt: new Date(Date.now() - 60_000) } });
    }
    const routes = [
      { method: 'get', path: `/api/projects/${projectId}/screens` },
      { method: 'post', path: `/api/projects/${projectId}/screens`, body: { name: '새 화면', viewport: 'PC' } },
      { method: 'post', path: `/api/screens/${visible.id}/hide` },
      { method: 'post', path: `/api/screens/${hidden.id}/show` },
    ] as const;

    for (const route of routes) {
      const pending = request(server)[route.method](route.path).set('Origin', origin);
      if ('body' in route) pending.send(route.body);
      if (state === '세션 만료') pending.set('Cookie', cookie);
      await pending.expect(401);
    }

    const saved = await prisma.screen.findMany();
    expect(saved).toHaveLength(2);
    expect(saved).toEqual(expect.arrayContaining([visible, hidden]));
  });

  it.each([
    { label: '다른 Origin', value: 'https://other.example' },
    { label: '포트만 다른 Origin', value: 'http://localhost:5174' },
    { label: 'Origin 없음', value: undefined },
  ])('$label이면 POST 세 경로 모두 403이고 화면을 바꾸지 않는다', async ({ value }) => {
    const visible = await createScreen();
    const hidden = await prisma.screen.create({
      data: { projectId, name: '숨긴 화면', viewport: 'MOBILE', hiddenAt: firstHiddenAt },
    });
    const routes = [
      { path: `/api/projects/${projectId}/screens`, body: { name: '새 화면', viewport: 'PC' } },
      { path: `/api/screens/${visible.id}/hide` },
      { path: `/api/screens/${hidden.id}/show` },
    ];

    for (const route of routes) {
      const pending = request(server).post(route.path).set('Cookie', cookie);
      if (route.body) pending.send(route.body);
      if (value !== undefined) pending.set('Origin', value);
      await pending.expect(403);
    }

    const saved = await prisma.screen.findMany();
    expect(saved).toHaveLength(2);
    expect(saved).toEqual(expect.arrayContaining([visible, hidden]));
  });
});
