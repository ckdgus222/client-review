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
import type { VersionDetail } from '../src/versions/versions.service.js';
import { resetDatabase } from './reset-database.js';

const origin = 'http://localhost:5173';
const missingId = '00000000-0000-4000-8000-000000000001';
const emptySummary = {
  currentVersion: null,
  screenCount: 0,
  thumbnailAssetId: null,
  issueCounts: { total: 0, resolved: 0, readyForReview: 0 },
};
const assetNotFoundBody = { statusCode: 404, message: '없는 사진이에요', error: 'Not Found' };

describe('프로젝트 API (e2e)', () => {
  let app: INestApplication | undefined;
  let server: Server;
  let prisma: PrismaService;
  let userId: string;
  let otherUserId: string;
  let cookie: string;
  let directory: string;
  let photo: Buffer;
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

  const postPath = (path: string, memberCookie = cookie) =>
    request(server).post(path).set('Origin', origin).set('Cookie', memberCookie);

  const list = (memberCookie = cookie) => request(server).get('/api/projects').set('Cookie', memberCookie);

  const uploadPhoto = (versionId: string, screenId: string, memberCookie = cookie) =>
    request(server)
      .put(`/api/versions/${versionId}/screens/${screenId}/asset`)
      .set('Origin', origin)
      .set('Cookie', memberCookie)
      .attach('file', photo, 'screen.png')
      .expect(200);

  const createPhotoDraft = async (projectId: string, names = ['첫 화면'], memberCookie = cookie) => {
    let draft: Pick<VersionDetail, 'id' | 'screens'> = (
      await postPath(`/api/projects/${projectId}/versions`, memberCookie).expect(201)
    ).body;
    for (const name of names) {
      const screen = await postPath(`/api/projects/${projectId}/screens`, memberCookie)
        .send({ name, viewport: 'PC' })
        .expect(201);
      draft = (await uploadPhoto(draft.id, screen.body.id, memberCookie)).body;
    }
    return draft;
  };

  const expectPhoto = async (assetId: string, memberCookie: string) => {
    const response = await request(server)
      .get(`/api/assets/${assetId}`)
      .set('Cookie', memberCookie)
      .expect(200)
      .expect('Content-Type', /image\/png/);
    expect(Buffer.isBuffer(response.body)).toBe(true);
    // MIME 문자열만 맞춘 오류 응답이 아니라 실제로 읽히는 사진이어야 한다.
    expect(await sharp(response.body).raw().toBuffer()).toEqual(await sharp(photo).raw().toBuffer());
  };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'projects-e2e-'));
    vi.stubEnv('ASSET_DIR', directory);
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
    photo = await sharp({ create: { width: 32, height: 24, channels: 3, background: 'red' } })
      .png()
      .toBuffer();
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
          status: 'ACTIVE',
          purgeAfter: null,
          currentVersion: null,
          screenCount: 0,
          thumbnailAssetId: null,
          issueCounts: { total: 0, resolved: 0, readyForReview: 0 },
          createdAt: clientProject.createdAt.toISOString(),
        },
        {
          id: developerProject.id,
          name: developerProject.name,
          myRole: 'DEVELOPER',
          status: 'ACTIVE',
          purgeAfter: null,
          currentVersion: null,
          screenCount: 0,
          thumbnailAssetId: null,
          issueCounts: { total: 0, resolved: 0, readyForReview: 0 },
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
      status: 'ACTIVE',
      purgeAfter: null,
      currentVersion: null,
      screenCount: 0,
      thumbnailAssetId: null,
      issueCounts: { total: 0, resolved: 0, readyForReview: 0 },
      createdAt: expect.any(String),
    });
    const [project] = await prisma.project.findMany();
    expect(await prisma.project.count()).toBe(1);
    expect(response.body).toEqual({
      id: project.id,
      name: project.name,
      myRole: 'DEVELOPER',
      status: 'ACTIVE',
      purgeAfter: null,
      currentVersion: null,
      screenCount: 0,
      thumbnailAssetId: null,
      issueCounts: { total: 0, resolved: 0, readyForReview: 0 },
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
      .expect({
        id: project.id,
        name: project.name,
        myRole: 'DEVELOPER',
        status: 'ACTIVE',
        purgeAfter: null,
        currentVersion: null,
        approver: null,
        isApprover: false,
      });
  });

  it.each(['가', '가'.repeat(60)])('이름 경계값 %s는 앞뒤 공백을 지운 뒤 허용한다', async (name) => {
    const response = await post()
      .send({ name: `  ${name}  ` })
      .expect(201);
    expect(response.body).toEqual({
      id: expect.any(String),
      name,
      myRole: 'DEVELOPER',
      status: 'ACTIVE',
      purgeAfter: null,
      currentVersion: null,
      screenCount: 0,
      thumbnailAssetId: null,
      issueCounts: { total: 0, resolved: 0, readyForReview: 0 },
      createdAt: expect.any(String),
    });
    expect(await prisma.project.findMany()).toEqual([
      {
        id: response.body.id,
        name,
        currentVersionId: null,
        approverMemberId: null,
        createdAt: expect.any(Date),
        status: 'ACTIVE',
        statusBeforeDelete: null,
        deleteRequestedAt: null,
      },
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
        status: 'ACTIVE',
        purgeAfter: null,
        currentVersion: null,
        screenCount: 0,
        thumbnailAssetId: null,
        issueCounts: { total: 0, resolved: 0, readyForReview: 0 },
        createdAt: expect.any(String),
      });
      expect(await prisma.project.findMany()).toEqual([
        {
          id: response.body.id,
          name: '개발자 프로젝트',
          currentVersionId: null,
          approverMemberId: null,
          createdAt: new Date(response.body.createdAt),
          status: 'ACTIVE',
          statusBeforeDelete: null,
          deleteRequestedAt: null,
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
      status: 'ACTIVE',
      purgeAfter: null,
      currentVersion: null,
      screenCount: 0,
      thumbnailAssetId: null,
      issueCounts: { total: 0, resolved: 0, readyForReview: 0 },
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
      .expect([
        {
          id: project.id,
          name: project.name,
          myRole: 'CLIENT',
          createdAt: project.createdAt.toISOString(),
          status: 'ACTIVE',
          purgeAfter: null,
          currentVersion: null,
          screenCount: 0,
          thumbnailAssetId: null,
          issueCounts: { total: 0, resolved: 0, readyForReview: 0 },
        },
      ]);
    await request(server)
      .get(`/api/projects/${project.id}`)
      .set('Cookie', cookie)
      .expect(200)
      .expect({
        id: project.id,
        name: project.name,
        myRole: 'CLIENT',
        status: 'ACTIVE',
        purgeAfter: null,
        currentVersion: null,
        approver: null,
        isApprover: false,
      });
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
        .expect({
          id: project.id,
          name: project.name,
          myRole: role,
          status: 'ACTIVE',
          purgeAfter: null,
          currentVersion: null,
          approver: null,
          isApprover: false,
        });
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
          status: 'ACTIVE',
          purgeAfter: null,
          currentVersion: null,
          approver: { memberId: member.id, name: '다른 사용자' },
          isApprover: role === 'CLIENT',
        });
    }

    await prisma.project.update({ where: { id: project.id }, data: { approverMemberId: null } });
    await request(server)
      .get(`/api/projects/${project.id}`)
      .set('Cookie', clientCookie)
      .expect(200)
      .expect({
        id: project.id,
        name: project.name,
        myRole: 'CLIENT',
        status: 'ACTIVE',
        purgeAfter: null,
        currentVersion: null,
        approver: null,
        isApprover: false,
      });
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

  it('게시 전 사진이 있는 프로젝트는 두 역할의 목록에 빈 버전 요약으로 보인다', async () => {
    const project = await createProject('사진이 있는 초안');
    await prisma.projectMember.create({ data: { projectId: project.id, userId: otherUserId, role: 'CLIENT' } });
    const clientCookie = await login(otherUserId);
    const draft = await createPhotoDraft(project.id);
    const assetId = draft.screens[0].asset.id;

    for (const [myRole, memberCookie] of [
      ['DEVELOPER', cookie],
      ['CLIENT', clientCookie],
    ]) {
      await list(memberCookie)
        .expect(200)
        .expect([
          {
            id: project.id,
            name: project.name,
            createdAt: project.createdAt.toISOString(),
            myRole,
            status: 'ACTIVE',
            purgeAfter: null,
            ...emptySummary,
          },
        ]);
    }
    await expectPhoto(assetId, cookie);
    await request(server)
      .get(`/api/assets/${assetId}`)
      .set('Cookie', clientCookie)
      .expect(404)
      .expect(assetNotFoundBody);
  });

  it('다음 초안을 고쳐도 게시된 0번 버전의 사진과 화면 수를 유지한다', async () => {
    const project = await createProject('게시와 준비를 구분');
    await prisma.projectMember.create({ data: { projectId: project.id, userId: otherUserId, role: 'CLIENT' } });
    const clientCookie = await login(otherUserId);
    const first = await createPhotoDraft(project.id, ['첫 화면', '둘째 화면']);
    const published = await postPath(`/api/versions/${first.id}/publish`).expect(200);
    expect(published.body).toMatchObject({ id: first.id, number: 0, status: 'IN_REVIEW' });
    const expected = {
      id: project.id,
      name: project.name,
      createdAt: project.createdAt.toISOString(),
      myRole: 'CLIENT',
      status: 'ACTIVE',
      purgeAfter: null,
      currentVersion: { id: first.id, number: 0, status: 'IN_REVIEW' },
      screenCount: 2,
      thumbnailAssetId: first.screens[0].asset.id,
      issueCounts: { total: 0, resolved: 0, readyForReview: 0 },
    };
    await list(clientCookie).expect(200).expect([expected]);

    const next = await createPhotoDraft(project.id, ['다음 초안에만 있는 화면']);
    const replaced = await uploadPhoto(next.id, first.screens[0].screenId);
    const changedAssetId = replaced.body.screens[0].asset.id;
    expect(changedAssetId).not.toBe(first.screens[0].asset.id);
    expect(replaced.body.screens).toHaveLength(3);
    expect(replaced.body).toMatchObject({ id: next.id, status: 'DRAFT', number: null });

    await list(clientCookie).expect(200).expect([expected]);
    await list()
      .expect(200)
      .expect([{ ...expected, myRole: 'DEVELOPER' }]);
    await expectPhoto(first.screens[0].asset.id, clientCookie);
    await request(server)
      .get(`/api/assets/${changedAssetId}`)
      .set('Cookie', clientCookie)
      .expect(404)
      .expect(assetNotFoundBody);
    await request(server)
      .get(`/api/versions/${first.id}`)
      .set('Cookie', clientCookie)
      .expect(200)
      .expect(published.body);
    // 상세 응답에는 목록용 상태·화면·집계 필드를 추가하지 않는다.
    await request(server)
      .get(`/api/projects/${project.id}`)
      .set('Cookie', clientCookie)
      .expect(200)
      .expect({
        id: project.id,
        name: project.name,
        myRole: 'CLIENT',
        status: 'ACTIVE',
        purgeAfter: null,
        currentVersion: { id: first.id, number: 0 },
        approver: null,
        isApprover: false,
      });
  });

  it('게시 버전의 첫 화면과 전체 쪽지 집계를 프로젝트마다 구분하고 클라이언트가 그 사진을 받는다', async () => {
    const firstProject = await createProject('여러 차수의 쪽지');
    const secondProject = await createProject('승인된 프로젝트');
    const emptyProject = await createProject('쪽지와 화면이 없는 게시 버전');
    await prisma.projectMember.createMany({
      data: [firstProject, secondProject, emptyProject].map(({ id }) => ({
        projectId: id,
        userId: otherUserId,
        role: 'CLIENT',
      })),
    });
    const clientCookie = await login(otherUserId);
    const oldVersion = await createPhotoDraft(firstProject.id);
    await postPath(`/api/versions/${oldVersion.id}/publish`).expect(200);
    const current = await createPhotoDraft(firstProject.id, ['추가 화면']);
    await postPath(`/api/versions/${current.id}/publish`).expect(200);
    const second = await createPhotoDraft(secondProject.id);
    await postPath(`/api/versions/${second.id}/publish`).expect(200);
    const empty = await prisma.deliveryVersion.create({
      data: {
        projectId: emptyProject.id,
        status: 'IN_REVIEW',
        number: 0,
        publishedAt: new Date(),
      },
    });
    await prisma.project.update({ where: { id: emptyProject.id }, data: { currentVersionId: empty.id } });

    // 모든 상태와 과거 차수를 섞는다. 최신 차수만 세거나 프로젝트를 섞으면 세 숫자가 모두 달라진다.
    await prisma.issue.createMany({
      data: [
        ...(['OPEN', 'IN_PROGRESS', 'READY_FOR_REVIEW', 'VERIFIED', 'WITHDRAWN', 'VERIFIED'] as const).map(
          (status, index) => ({
            projectId: firstProject.id,
            number: index + 1,
            originVersionId: index < 5 ? oldVersion.id : current.id,
            authorId: otherUserId,
            requestId: randomUUID(),
            title: `첫 프로젝트 ${index}`,
            body: '검수 쪽지',
            status,
          }),
        ),
        ...(['WITHDRAWN', 'WITHDRAWN'] as const).map((status, index) => ({
          projectId: secondProject.id,
          number: index + 1,
          originVersionId: second.id,
          authorId: otherUserId,
          requestId: randomUUID(),
          title: `둘째 프로젝트 ${index}`,
          body: '검수 쪽지',
          status,
        })),
      ],
    });
    const approver = await prisma.projectMember.findUniqueOrThrow({
      where: { projectId_userId: { projectId: secondProject.id, userId: otherUserId } },
    });
    await postPath(`/api/projects/${secondProject.id}/approver`).send({ memberId: approver.id }).expect(200);
    const check = await request(server)
      .get(`/api/versions/${second.id}/approval-check`)
      .set('Cookie', clientCookie)
      .expect(200);
    await postPath(`/api/versions/${second.id}/approve`, clientCookie)
      .send({ seenAt: check.body.serverTime })
      .expect(200);

    const expected = [
      {
        project: firstProject,
        currentVersion: { id: current.id, number: 1, status: 'IN_REVIEW' },
        screenCount: 2,
        thumbnailAssetId: oldVersion.screens[0].asset.id,
        issueCounts: { total: 6, resolved: 3, readyForReview: 1 },
      },
      {
        project: secondProject,
        currentVersion: { id: second.id, number: 0, status: 'APPROVED' },
        screenCount: 1,
        thumbnailAssetId: second.screens[0].asset.id,
        issueCounts: { total: 2, resolved: 2, readyForReview: 0 },
      },
      {
        project: emptyProject,
        currentVersion: { id: empty.id, number: 0, status: 'IN_REVIEW' },
        screenCount: 0,
        thumbnailAssetId: null,
        issueCounts: { total: 0, resolved: 0, readyForReview: 0 },
      },
    ];
    for (const [myRole, memberCookie] of [
      ['DEVELOPER', cookie],
      ['CLIENT', clientCookie],
    ]) {
      const response = await list(memberCookie).expect(200);
      expect(response.body).toHaveLength(3);
      expect(response.body).toEqual(
        expect.arrayContaining(
          expected.map(({ project, ...summary }) => ({
            id: project.id,
            name: project.name,
            createdAt: project.createdAt.toISOString(),
            myRole,
            status: 'ACTIVE',
            purgeAfter: null,
            ...summary,
          })),
        ),
      );
    }
    await expectPhoto(oldVersion.screens[0].asset.id, clientCookie);
    await expectPhoto(second.screens[0].asset.id, clientCookie);
  });

  it('화면 등록 시각이 같거나 게시 뒤 첫 이름표를 숨겨도 목록과 검수실의 첫 사진과 화면 수가 일치한다', async () => {
    const project = await createProject('첫 사진 정렬');
    await prisma.projectMember.create({ data: { projectId: project.id, userId: otherUserId, role: 'CLIENT' } });
    const clientCookie = await login(otherUserId);
    const screenIds = [
      '00000000-0000-4000-8000-000000000011',
      '00000000-0000-4000-8000-000000000012',
      '00000000-0000-4000-8000-000000000013',
    ];
    await prisma.screen.createMany({
      data: screenIds.map((id, index) => ({
        id,
        projectId: project.id,
        name: `화면 ${index}`,
        viewport: 'PC',
        createdAt: new Date(index === 0 ? '2026-01-02T00:00:00Z' : '2026-01-01T00:00:00Z'),
      })),
    });
    const draft = await postPath(`/api/projects/${project.id}/versions`).expect(201);
    const assets = new Map<string, string>();
    // 동률인 두 화면의 업로드 순서도 ID 정렬과 반대로 둔다.
    for (const screenId of [...screenIds].reverse()) {
      const uploaded = await uploadPhoto(draft.body.id, screenId);
      const screens: VersionDetail['screens'] = uploaded.body.screens;
      assets.set(screenId, screens.find((screen) => screen.screenId === screenId)!.asset.id);
    }
    await postPath(`/api/versions/${draft.body.id}/publish`).expect(200);
    const expected = {
      id: project.id,
      name: project.name,
      createdAt: project.createdAt.toISOString(),
      myRole: 'CLIENT',
      status: 'ACTIVE',
      purgeAfter: null,
      currentVersion: { id: draft.body.id, number: 0, status: 'IN_REVIEW' },
      screenCount: 3,
      thumbnailAssetId: assets.get(screenIds[1]),
      issueCounts: { total: 0, resolved: 0, readyForReview: 0 },
    };
    const before = await request(server).get(`/api/versions/${draft.body.id}`).set('Cookie', clientCookie).expect(200);
    expect(before.body.screens).toEqual(
      [screenIds[1], screenIds[2], screenIds[0]].map((screenId) => ({
        screenId,
        name: `화면 ${screenIds.indexOf(screenId)}`,
        viewport: 'PC',
        hiddenAt: null,
        asset: { id: assets.get(screenId), width: 32, height: 24 },
      })),
    );
    await list(clientCookie).expect(200).expect([expected]);
    await postPath(`/api/screens/${screenIds[1]}/hide`).expect(200);

    await list(clientCookie).expect(200).expect([expected]);
    const after = await request(server).get(`/api/versions/${draft.body.id}`).set('Cookie', clientCookie).expect(200);
    expect(after.body).toEqual({
      ...before.body,
      screens: [{ ...before.body.screens[0], hiddenAt: expect.any(String) }, ...before.body.screens.slice(1)],
    });
    await expectPhoto(assets.get(screenIds[1])!, clientCookie);
  });

  it('남의 프로젝트와 철회 및 삭제 대기 프로젝트의 목록과 사진을 권한별로 격리한다', async () => {
    const shared = await createProject('접근 철회할 프로젝트');
    const pending = await createProject('삭제할 프로젝트');
    const outsider = await prisma.user.create({ data: { email: 'outsider@example.com', name: '외부 개발자' } });
    const privateProject = await createProject('남의 프로젝트', outsider.id);
    const sharedMember = await prisma.projectMember.create({
      data: { projectId: shared.id, userId: otherUserId, role: 'CLIENT' },
    });
    await prisma.projectMember.create({ data: { projectId: pending.id, userId: otherUserId, role: 'CLIENT' } });
    const clientCookie = await login(otherUserId);
    const outsiderCookie = await login(outsider.id);
    const sharedVersion = await createPhotoDraft(shared.id);
    const pendingVersion = await createPhotoDraft(pending.id);
    const privateVersion = await createPhotoDraft(privateProject.id, ['남의 사진'], outsiderCookie);
    await postPath(`/api/versions/${sharedVersion.id}/publish`).expect(200);
    await postPath(`/api/versions/${pendingVersion.id}/publish`).expect(200);
    await postPath(`/api/versions/${privateVersion.id}/publish`, outsiderCookie).expect(200);
    const sharedRow = {
      id: shared.id,
      name: shared.name,
      createdAt: shared.createdAt.toISOString(),
      myRole: 'DEVELOPER',
      status: 'ACTIVE',
      purgeAfter: null,
      currentVersion: { id: sharedVersion.id, number: 0, status: 'IN_REVIEW' },
      screenCount: 1,
      thumbnailAssetId: sharedVersion.screens[0].asset.id,
      issueCounts: { total: 0, resolved: 0, readyForReview: 0 },
    };
    const pendingRow = {
      ...sharedRow,
      id: pending.id,
      name: pending.name,
      createdAt: pending.createdAt.toISOString(),
      currentVersion: { id: pendingVersion.id, number: 0, status: 'IN_REVIEW' },
      thumbnailAssetId: pendingVersion.screens[0].asset.id,
    };
    for (const [myRole, memberCookie] of [
      ['DEVELOPER', cookie],
      ['CLIENT', clientCookie],
    ]) {
      const response = await list(memberCookie).expect(200);
      expect(response.body).toHaveLength(2);
      expect(response.body).toEqual(
        expect.arrayContaining([
          { ...sharedRow, myRole },
          { ...pendingRow, myRole },
        ]),
      );
      await expectPhoto(sharedVersion.screens[0].asset.id, memberCookie);
      await expectPhoto(pendingVersion.screens[0].asset.id, memberCookie);
      await request(server)
        .get(`/api/assets/${privateVersion.screens[0].asset.id}`)
        .set('Cookie', memberCookie)
        .expect(404)
        .expect(assetNotFoundBody);
    }
    await expectPhoto(privateVersion.screens[0].asset.id, outsiderCookie);

    await postPath(`/api/members/${sharedMember.id}/revoke`).expect(204);
    expect((await prisma.projectMember.findUniqueOrThrow({ where: { id: sharedMember.id } })).revokedAt).toBeInstanceOf(
      Date,
    );
    await list(clientCookie)
      .expect(200)
      .expect([{ ...pendingRow, myRole: 'CLIENT' }]);
    const developerAfterRevoke = await list().expect(200);
    expect(developerAfterRevoke.body).toHaveLength(2);
    expect(developerAfterRevoke.body).toEqual(expect.arrayContaining([sharedRow, pendingRow]));
    await request(server)
      .get(`/api/assets/${sharedVersion.screens[0].asset.id}`)
      .set('Cookie', clientCookie)
      .expect(404)
      .expect(assetNotFoundBody);
    await expectPhoto(sharedVersion.screens[0].asset.id, cookie);

    // 개발자 멤버도 철회된 줄이면 목록과 사진 모두 제외해야 한다.
    await prisma.projectMember.update({
      where: { projectId_userId: { projectId: shared.id, userId } },
      data: { revokedAt: new Date() },
    });
    await list().expect(200).expect([pendingRow]);
    await request(server)
      .get(`/api/assets/${sharedVersion.screens[0].asset.id}`)
      .set('Cookie', cookie)
      .expect(404)
      .expect(assetNotFoundBody);

    await postPath(`/api/projects/${pending.id}/delete`).send({ name: pending.name }).expect(204);
    const deleted = await prisma.project.findUniqueOrThrow({ where: { id: pending.id } });
    expect(deleted.deleteRequestedAt).toBeInstanceOf(Date);
    const purgeAfter = new Date(deleted.deleteRequestedAt!.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await list()
      .expect(200)
      .expect([{ ...pendingRow, status: 'DELETE_PENDING', purgeAfter }]);
    await list(clientCookie).expect(200).expect([]);
    await expectPhoto(pendingVersion.screens[0].asset.id, cookie);
    await request(server)
      .get(`/api/assets/${pendingVersion.screens[0].asset.id}`)
      .set('Cookie', clientCookie)
      .expect(404)
      .expect(assetNotFoundBody);
    const outsiderList = await list(outsiderCookie).expect(200);
    expect(outsiderList.body).toHaveLength(1);
    expect(outsiderList.body[0].id).toBe(privateProject.id);
    await request(server)
      .get(`/api/assets/${pendingVersion.screens[0].asset.id}`)
      .set('Cookie', outsiderCookie)
      .expect(404)
      .expect(assetNotFoundBody);
  });

  it('현재 버전이 미게시이거나 다른 프로젝트 소속이면 버전과 화면 정보를 비운다', async () => {
    const project = await createProject('잘못된 포인터');
    await prisma.projectMember.create({ data: { projectId: project.id, userId: otherUserId, role: 'CLIENT' } });
    const clientCookie = await login(otherUserId);
    const original = await createPhotoDraft(project.id);
    await postPath(`/api/versions/${original.id}/publish`).expect(200);
    const draft = await createPhotoDraft(project.id, ['아직 게시하지 않은 사진']);
    const outsider = await prisma.user.create({ data: { email: 'foreign@example.com', name: '다른 개발자' } });
    const outsiderCookie = await login(outsider.id);
    const foreignProject = await createProject('다른 소속 버전', outsider.id);
    const foreign = await createPhotoDraft(foreignProject.id, ['다른 소속 사진'], outsiderCookie);
    await postPath(`/api/versions/${foreign.id}/publish`, outsiderCookie).expect(200);
    await prisma.issue.createMany({
      data: [
        ...(['READY_FOR_REVIEW', 'VERIFIED'] as const).map((status, index) => ({
          projectId: project.id,
          number: index + 1,
          originVersionId: original.id,
          authorId: userId,
          requestId: randomUUID(),
          title: `내 쪽지 ${index}`,
          body: '',
          status,
        })),
        {
          projectId: foreignProject.id,
          number: 1,
          originVersionId: foreign.id,
          authorId: outsider.id,
          requestId: randomUUID(),
          title: '남의 쪽지',
          body: '',
          status: 'WITHDRAWN',
        },
      ],
    });
    // currentVersionId는 고유하므로 다른 프로젝트의 포인터를 먼저 비운 뒤 잘못된 연결을 구성한다.
    await prisma.project.update({ where: { id: foreignProject.id }, data: { currentVersionId: null } });
    for (const invalidVersion of [draft, foreign]) {
      await prisma.project.update({ where: { id: project.id }, data: { currentVersionId: invalidVersion.id } });
      for (const [myRole, memberCookie] of [
        ['DEVELOPER', cookie],
        ['CLIENT', clientCookie],
      ]) {
        await list(memberCookie)
          .expect(200)
          .expect([
            {
              id: project.id,
              name: project.name,
              createdAt: project.createdAt.toISOString(),
              myRole,
              status: 'ACTIVE',
              purgeAfter: null,
              ...emptySummary,
              issueCounts: { total: 2, resolved: 1, readyForReview: 1 },
            },
          ]);
      }
    }
    await request(server)
      .get(`/api/assets/${foreign.screens[0].asset.id}`)
      .set('Cookie', cookie)
      .expect(404)
      .expect(assetNotFoundBody);
  });

  it('게시와 동시에 읽는 목록은 버전과 확인 요청 수를 같은 시점으로 반환한다', async () => {
    const project = await createProject('동시 게시와 목록 조회');
    await prisma.projectMember.create({ data: { projectId: project.id, userId: otherUserId, role: 'CLIENT' } });
    const clientCookie = await login(otherUserId);
    const current = await createPhotoDraft(project.id);
    await postPath(`/api/versions/${current.id}/publish`).expect(200);
    const issue = await postPath(`/api/projects/${project.id}/issues`, clientCookie)
      .send({
        requestId: randomUUID(),
        versionId: current.id,
        title: '확인할 수정',
        body: '이전 화면을 확인 중',
      })
      .expect(201);
    await postPath(`/api/issues/${issue.body.id}/submit-resolution`)
      .send({
        versionId: current.id,
        summary: '수정한 화면을 확인해 주세요',
      })
      .expect(200);
    const next = await createPhotoDraft(project.id, ['다음 차수에 추가한 화면']);
    const replacement = await uploadPhoto(next.id, current.screens[0].screenId);
    const nextAssetId = replacement.body.screens[0].asset.id;
    expect(nextAssetId).not.toBe(current.screens[0].asset.id);
    const before = {
      id: project.id,
      name: project.name,
      createdAt: project.createdAt.toISOString(),
      myRole: 'CLIENT',
      status: 'ACTIVE',
      purgeAfter: null,
      currentVersion: { id: current.id, number: 0, status: 'IN_REVIEW' },
      screenCount: 1,
      thumbnailAssetId: current.screens[0].asset.id,
      issueCounts: { total: 1, resolved: 0, readyForReview: 1 },
    };
    const after = {
      ...before,
      currentVersion: { id: next.id, number: 1, status: 'IN_REVIEW' },
      screenCount: 2,
      thumbnailAssetId: nextAssetId,
      issueCounts: { total: 1, resolved: 0, readyForReview: 0 },
    };
    await list(clientCookie).expect(200).expect([before]);

    // 중간에 await로 기다리지 않고 실제 HTTP 요청들을 동시에 보낸다.
    const [published, ...responses] = await Promise.all([
      postPath(`/api/versions/${next.id}/publish`).expect(200),
      ...Array.from({ length: 12 }, () => list(clientCookie).expect(200)),
    ]);

    expect(published.body).toMatchObject({ id: next.id, number: 1, status: 'IN_REVIEW' });
    for (const response of responses) {
      // 버전·사진·화면 수·쪽지 수는 게시 전이나 후의 한 세트여야 한다.
      expect([[before], [after]]).toContainEqual(response.body);
    }
    await list(clientCookie).expect(200).expect([after]);
    await list()
      .expect(200)
      .expect([{ ...after, myRole: 'DEVELOPER' }]);
    await expectPhoto(nextAssetId, clientCookie);
    expect((await prisma.issue.findUniqueOrThrow({ where: { id: issue.body.id } })).status).toBe('IN_PROGRESS');
  });
});
