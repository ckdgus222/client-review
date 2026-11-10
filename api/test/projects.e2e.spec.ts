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

describe('프로젝트 API (e2e)', () => {
  let app: INestApplication | undefined;
  let server: Server;
  let prisma: PrismaService;
  let userId: string;
  let otherUserId: string;
  let cookie: string;
  const sendLoginCode = vi.fn<MailService['sendLoginCode']>();

  const login = async (memberUserId: string) => {
    const token = createSessionToken();
    await prisma.session.create({
      data: {
        userId: memberUserId,
        tokenHash: hashSessionToken(token),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    return `sid=${token}`;
  };

  const createProject = (name: string, developerId = userId) =>
    prisma.project.create({
      data: { name, members: { create: { userId: developerId, role: 'DEVELOPER' } } },
    });

  const post = () => request(server).post('/api/projects').set('Origin', origin).set('Cookie', cookie);

  beforeEach(async () => {
    vi.stubEnv('APP_ORIGINS', origin);
    vi.stubEnv('COOKIE_SECURE', undefined);
    vi.stubEnv('DEVELOPER_EMAIL', 'user@example.com');
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
    const user = await prisma.user.create({ data: { email: 'user@example.com', name: '사용자' } });
    const otherUser = await prisma.user.create({ data: { email: 'other@example.com', name: '다른 사용자' } });
    userId = user.id;
    otherUserId = otherUser.id;
    cookie = await login(userId);
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

  it('목록은 두 역할의 내 프로젝트만 가입 순서와 무관하게 프로젝트를 새로 만든 순으로 돌려준다', async () => {
    // 입력 순서와 멤버 가입 시각을 프로젝트 생성 시각의 정렬 순서와 다르게 둔다.
    const developerProject = await prisma.project.create({
      data: { name: '직접 만든 프로젝트', createdAt: new Date('2026-01-01T00:00:00Z') },
    });
    const clientProject = await prisma.project.create({
      data: { name: '클라이언트로 참여', createdAt: new Date('2026-01-02T00:00:00Z') },
    });
    const otherProject = await prisma.project.create({
      data: { name: '남의 프로젝트', createdAt: new Date('2026-01-03T00:00:00Z') },
    });
    await prisma.projectMember.createMany({
      data: [
        {
          projectId: developerProject.id,
          userId,
          role: 'DEVELOPER',
          createdAt: new Date('2026-01-05T00:00:00Z'),
        },
        { projectId: developerProject.id, userId: otherUserId, role: 'CLIENT' },
        { projectId: clientProject.id, userId: otherUserId, role: 'DEVELOPER' },
        {
          projectId: clientProject.id,
          userId,
          role: 'CLIENT',
          createdAt: new Date('2026-01-04T00:00:00Z'),
        },
        { projectId: otherProject.id, userId: otherUserId, role: 'DEVELOPER' },
      ],
    });

    await request(server)
      .get('/api/projects')
      .set('Cookie', cookie)
      .expect(200)
      .expect([
        {
          id: clientProject.id,
          name: clientProject.name,
          myRole: 'CLIENT',
          createdAt: clientProject.createdAt.toISOString(),
        },
        {
          id: developerProject.id,
          name: developerProject.name,
          myRole: 'DEVELOPER',
          createdAt: developerProject.createdAt.toISOString(),
        },
      ]);
  });

  it('내 멤버 줄이 없으면 남의 프로젝트가 있어도 빈 목록을 돌려준다', async () => {
    await createProject('남의 프로젝트', otherUserId);

    await request(server).get('/api/projects').set('Cookie', cookie).expect(200).expect([]);
  });

  it('생성은 이름의 앞뒤 공백을 지우고 내 DEVELOPER 멤버 줄을 저장하며 목록과 상세에 바로 보인다', async () => {
    const response = await post().send({ name: ' \t쇼핑몰  리뉴얼\n ' }).expect(201);
    expect(response.body).toEqual({
      id: expect.any(String),
      name: '쇼핑몰  리뉴얼',
      myRole: 'DEVELOPER',
      createdAt: expect.any(String),
    });
    const [project] = await prisma.project.findMany();
    expect(await prisma.project.count()).toBe(1);
    expect(response.body).toEqual({
      id: project.id,
      name: project.name,
      myRole: 'DEVELOPER',
      createdAt: project.createdAt.toISOString(),
    });
    expect(await prisma.projectMember.findMany()).toEqual([
      {
        id: expect.any(String),
        projectId: project.id,
        userId,
        role: 'DEVELOPER',
        revokedAt: null,
        createdAt: expect.any(Date),
      },
    ]);

    await request(server).get('/api/projects').set('Cookie', cookie).expect(200).expect([response.body]);
    await request(server)
      .get(`/api/projects/${project.id}`)
      .set('Cookie', cookie)
      .expect(200)
      .expect({ id: project.id, name: project.name, myRole: 'DEVELOPER', currentVersion: null, approver: null });
  });

  it.each(['가', '가'.repeat(60)])('이름 경계값 %s는 앞뒤 공백을 지운 뒤 허용한다', async (name) => {
    const response = await post()
      .send({ name: `  ${name}  ` })
      .expect(201);
    expect(response.body).toEqual({
      id: expect.any(String),
      name,
      myRole: 'DEVELOPER',
      createdAt: expect.any(String),
    });
    expect(await prisma.project.findMany()).toEqual([
      { id: response.body.id, name, currentVersionId: null, approverMemberId: null, createdAt: expect.any(Date) },
    ]);
  });

  it('다른 이메일로 로그인하면 생성은 403이고 프로젝트와 멤버를 만들지 않는다', async () => {
    const otherCookie = await login(otherUserId);

    await request(server)
      .post('/api/projects')
      .set('Origin', origin)
      .set('Cookie', otherCookie)
      .send({ name: '만들 수 없는 프로젝트' })
      .expect(403)
      .expect({ statusCode: 403, message: '프로젝트는 개발자만 만들 수 있어요', error: 'Forbidden' });

    expect(await prisma.project.count()).toBe(0);
    expect(await prisma.projectMember.count()).toBe(0);
  });

  it.each([
    { label: '빈 문자열', value: '' },
    { label: '공백만', value: ' \t\n ' },
    { label: '없음', value: undefined },
  ])('개발자 이메일 설정이 $label이면 생성은 403이고 프로젝트와 멤버를 만들지 않는다', async ({ value }) => {
    vi.stubEnv('DEVELOPER_EMAIL', value);

    await post()
      .send({ name: '만들 수 없는 프로젝트' })
      .expect(403)
      .expect({ statusCode: 403, message: '프로젝트는 개발자만 만들 수 있어요', error: 'Forbidden' });

    expect(await prisma.project.count()).toBe(0);
    expect(await prisma.projectMember.count()).toBe(0);
  });

  it.each(['user@example.com', 'User@Example.COM', '  user@example.com  ', '  User@Example.COM  '])(
    '개발자 이메일 설정이 "%s"이면 user@example.com은 프로젝트와 DEVELOPER 멤버를 만든다',
    async (developerEmail) => {
      vi.stubEnv('DEVELOPER_EMAIL', developerEmail);

      const response = await post().send({ name: '개발자 프로젝트' }).expect(201);

      expect(response.body).toEqual({
        id: expect.any(String),
        name: '개발자 프로젝트',
        myRole: 'DEVELOPER',
        createdAt: expect.any(String),
      });
      expect(await prisma.project.findMany()).toEqual([
        {
          id: response.body.id,
          name: '개발자 프로젝트',
          currentVersionId: null,
          approverMemberId: null,
          createdAt: new Date(response.body.createdAt),
        },
      ]);
      expect(await prisma.projectMember.findMany()).toEqual([
        {
          id: expect.any(String),
          projectId: response.body.id,
          userId,
          role: 'DEVELOPER',
          revokedAt: null,
          createdAt: expect.any(Date),
        },
      ]);
    },
  );

  it('개발자 이메일 설정이 바뀌면 다음 요청부터 새 이메일만 만들 수 있고 기존 데이터는 보존한다', async () => {
    await post().send({ name: '기존 개발자의 프로젝트' }).expect(201);
    const existingProjects = await prisma.project.findMany();
    const existingMembers = await prisma.projectMember.findMany();
    vi.stubEnv('DEVELOPER_EMAIL', 'other@example.com');

    await post()
      .send({ name: '만들 수 없는 프로젝트' })
      .expect(403)
      .expect({ statusCode: 403, message: '프로젝트는 개발자만 만들 수 있어요', error: 'Forbidden' });

    expect(await prisma.project.findMany()).toEqual(existingProjects);
    expect(await prisma.projectMember.findMany()).toEqual(existingMembers);

    const otherCookie = await login(otherUserId);
    const response = await request(server)
      .post('/api/projects')
      .set('Origin', origin)
      .set('Cookie', otherCookie)
      .send({ name: '새 개발자의 프로젝트' })
      .expect(201);

    expect(response.body).toEqual({
      id: expect.any(String),
      name: '새 개발자의 프로젝트',
      myRole: 'DEVELOPER',
      createdAt: expect.any(String),
    });
    expect(await prisma.project.count()).toBe(2);
    expect(await prisma.projectMember.count()).toBe(2);
    expect(await prisma.projectMember.findMany({ where: { projectId: response.body.id } })).toEqual([
      {
        id: expect.any(String),
        projectId: response.body.id,
        userId: otherUserId,
        role: 'DEVELOPER',
        revokedAt: null,
        createdAt: expect.any(Date),
      },
    ]);
  });

  it.each([
    { label: '다른 이메일', value: 'other@example.com' },
    { label: '없음', value: undefined },
  ])('개발자 이메일 설정이 $label이어도 클라이언트로 참여한 프로젝트 목록과 상세를 볼 수 있다', async ({ value }) => {
    vi.stubEnv('DEVELOPER_EMAIL', value);
    const project = await createProject('클라이언트로 참여', otherUserId);
    await prisma.projectMember.create({ data: { projectId: project.id, userId, role: 'CLIENT' } });
    await createProject('참여하지 않은 프로젝트', otherUserId);

    await request(server)
      .get('/api/projects')
      .set('Cookie', cookie)
      .expect(200)
      .expect([{ id: project.id, name: project.name, myRole: 'CLIENT', createdAt: project.createdAt.toISOString() }]);
    await request(server)
      .get(`/api/projects/${project.id}`)
      .set('Cookie', cookie)
      .expect(200)
      .expect({ id: project.id, name: project.name, myRole: 'CLIENT', currentVersion: null, approver: null });
  });

  it.each([
    { label: '없음', value: undefined },
    { label: '빈 문자열', value: '' },
    { label: '공백만', value: ' \t\n ' },
    { label: '61자', value: '가'.repeat(61) },
    { label: '공백 제거 뒤 61자', value: `  ${'가'.repeat(61)}  ` },
    { label: '숫자', value: 123 },
    { label: '불리언', value: true },
    { label: '배열', value: ['프로젝트'] },
    { label: '객체', value: { name: '프로젝트' } },
    { label: 'null', value: null },
  ])('이름이 $label이면 422이고 프로젝트와 멤버를 만들지 않는다', async ({ value }) => {
    const response = await post().send({ name: value }).expect(422);

    expect(response.body.statusCode).toBe(422);
    expect(response.body.message).toEqual(expect.any(Array));
    expect(await prisma.project.count()).toBe(0);
    expect(await prisma.projectMember.count()).toBe(0);
  });

  it.each([
    { label: '모르는 칸', body: { name: '프로젝트', myRole: 'CLIENT' } },
    { label: '배열 본문', body: [{ name: '프로젝트' }] },
  ])('$label을 보내면 422이고 프로젝트와 멤버를 만들지 않는다', async ({ body }) => {
    const response = await post().send(body).expect(422);

    expect(response.body.statusCode).toBe(422);
    expect(response.body.message).toEqual(expect.any(Array));
    expect(await prisma.project.count()).toBe(0);
    expect(await prisma.projectMember.count()).toBe(0);
  });

  it.each(['DEVELOPER', 'CLIENT'] as const)(
    '상세는 요청한 멤버의 %s 역할과 id, name, currentVersion을 돌려준다',
    async (role) => {
      const project = await createProject('함께 보는 프로젝트');
      await prisma.projectMember.create({
        data: { projectId: project.id, userId: otherUserId, role: 'CLIENT' },
      });
      const memberCookie = role === 'DEVELOPER' ? cookie : await login(otherUserId);

      await request(server)
        .get(`/api/projects/${project.id}`)
        .set('Cookie', memberCookie)
        .expect(200)
        .expect({ id: project.id, name: project.name, myRole: role, currentVersion: null, approver: null });
    },
  );

  it('상세는 두 역할 모두에게 승인자의 멤버 id와 이름만 주고 지정 해제 뒤에는 null을 준다', async () => {
    const project = await createProject('승인자가 있는 프로젝트');
    const member = await prisma.projectMember.create({
      data: { projectId: project.id, userId: otherUserId, role: 'CLIENT' },
    });
    await prisma.project.update({ where: { id: project.id }, data: { approverMemberId: member.id } });
    const clientCookie = await login(otherUserId);

    for (const role of ['DEVELOPER', 'CLIENT'] as const) {
      await request(server)
        .get(`/api/projects/${project.id}`)
        .set('Cookie', role === 'DEVELOPER' ? cookie : clientCookie)
        .expect(200)
        .expect({
          id: project.id,
          name: project.name,
          myRole: role,
          currentVersion: null,
          approver: { memberId: member.id, name: '다른 사용자' },
        });
    }

    await prisma.project.update({ where: { id: project.id }, data: { approverMemberId: null } });
    await request(server)
      .get(`/api/projects/${project.id}`)
      .set('Cookie', clientCookie)
      .expect(200)
      .expect({ id: project.id, name: project.name, myRole: 'CLIENT', currentVersion: null, approver: null });
  });

  it('남의 프로젝트, 없는 UUID, 틀린 모양 id는 모두 같은 404 본문을 돌려준다', async () => {
    await createProject('내 프로젝트');
    const otherProject = await createProject('남의 프로젝트', otherUserId);

    for (const id of [otherProject.id, missingId, 'abc']) {
      const response = await request(server).get(`/api/projects/${id}`).set('Cookie', cookie).expect(404);
      expect(response.body).toEqual({
        statusCode: 404,
        message: '없는 프로젝트예요',
        error: 'Not Found',
      });
    }
  });

  it.each([
    { method: 'get', detail: false, label: '목록' },
    { method: 'post', detail: false, label: '생성' },
    { method: 'get', detail: true, label: '상세' },
  ] as const)('로그인하지 않으면 $label 경로는 401이다', async ({ method, detail }) => {
    const project = await createProject('기존 프로젝트');
    const path = detail ? `/api/projects/${project.id}` : '/api/projects';
    const pending = request(server)[method](path).set('Origin', origin);
    if (method === 'post') pending.send({ name: '만들 수 없는 프로젝트' });

    await pending.expect(401);
    expect(await prisma.project.count()).toBe(1);
    expect(await prisma.projectMember.count()).toBe(1);
  });

  it('세션이 만료되면 쿠키가 있어도 세 경로 모두 401이고 새 프로젝트는 생기지 않는다', async () => {
    const project = await createProject('기존 프로젝트');
    await prisma.session.updateMany({ data: { expiresAt: new Date(Date.now() - 60_000) } });

    await request(server).get('/api/projects').set('Cookie', cookie).expect(401);
    await post().send({ name: '만들 수 없는 프로젝트' }).expect(401);
    await request(server).get(`/api/projects/${project.id}`).set('Cookie', cookie).expect(401);
    expect(await prisma.project.count()).toBe(1);
    expect(await prisma.projectMember.count()).toBe(1);
  });

  it.each([
    { label: '다른 Origin', value: 'https://other.example' },
    { label: '포트만 다른 Origin', value: 'http://localhost:5174' },
    { label: 'Origin 없음', value: undefined },
  ])('$label의 생성 요청은 로그인해도 403이고 프로젝트와 멤버를 만들지 않는다', async ({ value }) => {
    const pending = request(server).post('/api/projects').set('Cookie', cookie);
    if (value !== undefined) pending.set('Origin', value);

    await pending.send({ name: '만들 수 없는 프로젝트' }).expect(403);
    expect(await prisma.project.count()).toBe(0);
    expect(await prisma.projectMember.count()).toBe(0);
  });
});
