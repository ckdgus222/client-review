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
const projectNotFoundBody = { statusCode: 404, message: '없는 프로젝트예요', error: 'Not Found' };

describe('활동 일지 API (e2e)', () => {
  let app: INestApplication | undefined;
  let server: Server;
  let prisma: PrismaService;
  let directory: string;
  let developerId: string;
  let clientId: string;
  let projectId: string;
  let otherProjectId: string;
  let cookie: string;
  let clientCookie: string;
  let outsiderCookie: string;
  let photo: Buffer;
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

  const getActivity = (targetProjectId = projectId, memberCookie = clientCookie) =>
    request(server).get(`/api/projects/${targetProjectId}/activity`).set('Cookie', memberCookie);

  const createDraftWithPhoto = async (targetProjectId = projectId, memberCookie = cookie) => {
    const draft = await post(`/api/projects/${targetProjectId}/versions`, memberCookie).expect(201);
    const screen = await prisma.screen.create({
      data: { projectId: targetProjectId, name: `화면 ${randomUUID()}`, viewport: 'PC' },
    });
    const versionId: string = draft.body.id;
    await request(server)
      .put(`/api/versions/${versionId}/screens/${screen.id}/asset`)
      .set('Origin', origin)
      .set('Cookie', memberCookie)
      .attach('file', photo, 'screen.png')
      .expect(200);
    return { versionId, screenId: screen.id };
  };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'activity-e2e-'));
    vi.stubEnv('ASSET_DIR', directory);
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
    const outsider = await prisma.user.create({ data: { email: 'outsider@example.com', name: '다른 개발자' } });
    developerId = developer.id;
    clientId = client.id;
    const project = await prisma.project.create({
      data: {
        name: '활동 일지 프로젝트',
        members: {
          create: [
            { userId: developer.id, role: 'DEVELOPER' },
            { userId: client.id, role: 'CLIENT' },
          ],
        },
      },
    });
    const otherProject = await prisma.project.create({
      data: {
        name: '다른 프로젝트',
        members: {
          create: [
            { userId: outsider.id, role: 'DEVELOPER' },
            { userId: developer.id, role: 'CLIENT' },
          ],
        },
      },
    });
    projectId = project.id;
    otherProjectId = otherProject.id;
    cookie = await login(developer.id);
    clientCookie = await login(client.id);
    outsiderCookie = await login(outsider.id);
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

  it.each(['DEVELOPER', 'CLIENT'] as const)(
    '다른 프로젝트에 게시 사건이 있어도 게시 전에는 %s에게 빈 배열을 돌려준다',
    async (role) => {
      const other = await createDraftWithPhoto(otherProjectId, outsiderCookie);
      await post(`/api/versions/${other.versionId}/publish`, outsiderCookie).expect(200);
      const memberCookie = role === 'DEVELOPER' ? cookie : clientCookie;

      await getActivity(projectId, memberCookie).expect(200).expect([]);
      await createDraftWithPhoto();
      await getActivity(projectId, memberCookie).expect(200).expect([]);
    },
  );

  it.each(['DEVELOPER', 'CLIENT'] as const)(
    '1차·2차를 게시하면 %s에게 정해진 여섯 칸만 2차부터 돌려준다',
    async (role) => {
      const first = await createDraftWithPhoto();
      await post(`/api/versions/${first.versionId}/publish`).expect(200);
      const second = await post(`/api/projects/${projectId}/versions`).expect(201);
      await post(`/api/versions/${second.body.id}/publish`).expect(200);
      const firstEvent = await prisma.activityEvent.findFirstOrThrow({ where: { versionId: first.versionId } });
      const secondEvent = await prisma.activityEvent.findFirstOrThrow({ where: { versionId: second.body.id } });

      const response = await getActivity(projectId, role === 'DEVELOPER' ? cookie : clientCookie).expect(200);

      expect(response.body).toEqual([
        {
          id: secondEvent.id,
          type: 'VERSION_PUBLISHED',
          createdAt: secondEvent.createdAt.toISOString(),
          actorName: '개발자',
          mailFailedTo: [],
          issue: null,
          memberName: null,
          version: { id: second.body.id, number: 1 },
        },
        {
          id: firstEvent.id,
          type: 'VERSION_PUBLISHED',
          createdAt: firstEvent.createdAt.toISOString(),
          actorName: '개발자',
          mailFailedTo: [],
          issue: null,
          memberName: null,
          version: { id: first.versionId, number: 0 },
        },
      ]);
    },
  );

  it('둘 다 가입한 프로젝트여도 사건이 섞이지 않고 actorName은 각 게시자의 이름이다', async () => {
    const own = await createDraftWithPhoto();
    await post(`/api/versions/${own.versionId}/publish`).expect(200);
    const before = await getActivity(projectId, cookie).expect(200);
    expect(before.body).toHaveLength(1);
    const other = await createDraftWithPhoto(otherProjectId, outsiderCookie);
    await post(`/api/versions/${other.versionId}/publish`, outsiderCookie).expect(200);

    await getActivity(projectId, cookie).expect(200).expect(before.body);
    const response = await getActivity(otherProjectId, cookie).expect(200);
    expect(response.body).toEqual([
      {
        id: expect.any(String),
        type: 'VERSION_PUBLISHED',
        createdAt: expect.any(String),
        actorName: '다른 개발자',
        mailFailedTo: [],
        issue: null,
        memberName: null,
        version: { id: other.versionId, number: 0 },
      },
    ]);
    await getActivity(otherProjectId, clientCookie).expect(404).expect(projectNotFoundBody);
  });

  it.each(['ISSUE_CREATED', 'ISSUE_STARTED'] as const)(
    '%s는 해당 프로젝트 쪽지의 id·번호를 돌려주고 비멤버·철회된 멤버에게는 404다',
    async (type) => {
      const expectedByProject = [];
      // 쪽지 쓰기 API가 생기기 전이므로 조회할 쪽지와 사건을 DB에 준비한다.
      for (const targetProjectId of [projectId, otherProjectId]) {
        const version = await prisma.deliveryVersion.create({
          data: { projectId: targetProjectId, number: 0, status: 'IN_REVIEW', publishedAt: new Date() },
        });
        const issue = await prisma.issue.create({
          data: {
            projectId: targetProjectId,
            originVersionId: version.id,
            authorId: developerId,
            number: 14,
            title: '각 프로젝트의 쪽지',
            body: '일지에는 본문이 나오지 않는다',
            requestId: randomUUID(),
            status: type === 'ISSUE_STARTED' ? 'IN_PROGRESS' : 'OPEN',
          },
        });
        const event = await prisma.activityEvent.create({
          data: { projectId: targetProjectId, actorId: developerId, type, issueId: issue.id },
        });
        expectedByProject.push({
          projectId: targetProjectId,
          events: [
            {
              id: event.id,
              type,
              createdAt: event.createdAt.toISOString(),
              actorName: '개발자',
              mailFailedTo: [],
              memberName: null,
              version: null,
              issue: { id: issue.id, number: 14 },
            },
          ],
        });
      }

      for (const expected of expectedByProject) {
        await getActivity(expected.projectId, cookie).expect(200).expect(expected.events);
      }
      await getActivity(projectId, clientCookie).expect(200).expect(expectedByProject[0].events);
      await getActivity(projectId, outsiderCookie).expect(404).expect(projectNotFoundBody);
      await prisma.projectMember.update({
        where: { projectId_userId: { projectId, userId: clientId } },
        data: { revokedAt: new Date() },
      });
      await getActivity(projectId, clientCookie).expect(404).expect(projectNotFoundBody);
      await getActivity(projectId, cookie).expect(200).expect(expectedByProject[0].events);
    },
  );

  it('연결된 버전이 없는 사건도 version: null로 보이고 저장 순서 대신 사건 시각으로 정렬한다', async () => {
    // versionId는 선택 칸이다. 현재 게시 API로는 만들지 않는 null 사례를 DB에 준비한다.
    const latest = await prisma.activityEvent.create({
      data: {
        projectId,
        actorId: developerId,
        type: 'VERSION_PUBLISHED',
        createdAt: new Date('2026-01-02T00:00:00Z'),
      },
    });
    const oldest = await prisma.activityEvent.create({
      data: {
        projectId,
        actorId: developerId,
        type: 'VERSION_PUBLISHED',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    });

    const response = await getActivity().expect(200);

    expect(response.body).toEqual([
      {
        id: latest.id,
        type: 'VERSION_PUBLISHED',
        createdAt: '2026-01-02T00:00:00.000Z',
        actorName: '개발자',
        mailFailedTo: [],
        issue: null,
        memberName: null,
        version: null,
      },
      {
        id: oldest.id,
        type: 'VERSION_PUBLISHED',
        createdAt: '2026-01-01T00:00:00.000Z',
        actorName: '개발자',
        mailFailedTo: [],
        issue: null,
        memberName: null,
        version: null,
      },
    ]);
  });

  it('다음 초안을 만들고 사진·설명·테스트 주소를 바꿔도 클라이언트의 일지에는 게시 사건만 남는다', async () => {
    const first = await createDraftWithPhoto();
    await post(`/api/versions/${first.versionId}/publish`).expect(200);
    const before = await getActivity().expect(200);
    expect(before.body).toHaveLength(1);

    const draft = await createDraftWithPhoto();
    await request(server)
      .patch(`/api/versions/${draft.versionId}`)
      .set('Origin', origin)
      .set('Cookie', cookie)
      .send({ summary: '아직 공개하지 않은 초안 설명', testUrl: 'https://example.com/draft-only' })
      .expect(200);

    await getActivity().expect(200).expect(before.body);
    await getActivity(projectId, cookie).expect(200).expect(before.body);
  });

  it.each([false, true])('게시 사건 유무(%s)와 관계없이 비멤버·없는 UUID·잘못된 id는 같은 404다', async (hasEvent) => {
    if (hasEvent) {
      const draft = await createDraftWithPhoto();
      await post(`/api/versions/${draft.versionId}/publish`).expect(200);
    }

    await getActivity(projectId, outsiderCookie).expect(404).expect(projectNotFoundBody);
    await getActivity(missingId, outsiderCookie).expect(404).expect(projectNotFoundBody);
    await getActivity('abc', outsiderCookie).expect(404).expect(projectNotFoundBody);
    await getActivity(missingId, cookie).expect(404).expect(projectNotFoundBody);
    await getActivity('abc', cookie).expect(404).expect(projectNotFoundBody);
  });

  it('일지를 보던 멤버를 삭제하면 같은 로그인 쿠키로 다시 조회해도 404다', async () => {
    const draft = await createDraftWithPhoto();
    await post(`/api/versions/${draft.versionId}/publish`).expect(200);
    const before = await getActivity().expect(200);
    expect(before.body).toHaveLength(1);

    await prisma.projectMember.delete({ where: { projectId_userId: { projectId, userId: clientId } } });

    await getActivity().expect(404).expect(projectNotFoundBody);
    await getActivity(projectId, cookie).expect(200).expect(before.body);
  });

  it.each(['로그인 안 함', '세션 만료', '24시간 미사용'] as const)('%s이면 일지는 401이다', async (state) => {
    const draft = await createDraftWithPhoto();
    await post(`/api/versions/${draft.versionId}/publish`).expect(200);
    if (state === '세션 만료') {
      await prisma.session.updateMany({
        where: { userId: clientId },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });
    }
    if (state === '24시간 미사용') {
      await prisma.session.updateMany({
        where: { userId: clientId },
        data: { lastSeenAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
      });
    }

    const pending = request(server).get(`/api/projects/${projectId}/activity`);
    if (state !== '로그인 안 함') pending.set('Cookie', clientCookie);
    await pending.expect(401).expect({ statusCode: 401, message: 'Unauthorized' });
  });

  it.each([
    { label: 'Origin 없음', value: undefined },
    { label: '다른 Origin', value: 'https://other.example' },
  ])('GET은 $label이어도 일지를 돌려준다', async ({ value }) => {
    const draft = await createDraftWithPhoto();
    await post(`/api/versions/${draft.versionId}/publish`).expect(200);

    const pending = getActivity();
    if (value !== undefined) pending.set('Origin', value);
    const response = await pending.expect(200);
    expect(response.body).toEqual([
      {
        id: expect.any(String),
        type: 'VERSION_PUBLISHED',
        createdAt: expect.any(String),
        actorName: '개발자',
        mailFailedTo: [],
        issue: null,
        memberName: null,
        version: { id: draft.versionId, number: 0 },
      },
    ]);
  });

  it.each(['NO_SCREENS', 'SCREEN_HIDDEN'] as const)(
    '다음 초안 게시가 %s로 실패하면 새 일지가 생기지 않고 이전 일지도 그대로다',
    async (code) => {
      const first = await createDraftWithPhoto();
      await post(`/api/versions/${first.versionId}/publish`).expect(200);
      const before = await getActivity().expect(200);
      expect(before.body).toHaveLength(1);
      const draft = await post(`/api/projects/${projectId}/versions`).expect(201);
      if (code === 'NO_SCREENS') {
        await request(server)
          .delete(`/api/versions/${draft.body.id}/screens/${first.screenId}`)
          .set('Origin', origin)
          .set('Cookie', cookie)
          .expect(200);
      }
      if (code === 'SCREEN_HIDDEN') await post(`/api/screens/${first.screenId}/hide`).expect(200);

      const failed = await post(`/api/versions/${draft.body.id}/publish`).expect(409);
      expect(failed.body.code).toBe(code);

      await getActivity().expect(200).expect(before.body);
      await getActivity(projectId, cookie).expect(200).expect(before.body);
    },
  );

  it('동시 게시와 재게시로 같은 게시 사건이 두 줄 생기지 않는다', async () => {
    const draft = await createDraftWithPhoto();

    const responses = await Promise.all([
      post(`/api/versions/${draft.versionId}/publish`),
      post(`/api/versions/${draft.versionId}/publish`),
    ]);
    expect(responses.map(({ status }) => status).sort((left, right) => left - right)).toEqual([200, 409]);
    expect(responses.find(({ status }) => status === 409)?.body.code).toBe('VERSION_NOT_DRAFT');
    const activity = await getActivity().expect(200);
    expect(activity.body).toEqual([
      {
        id: expect.any(String),
        type: 'VERSION_PUBLISHED',
        createdAt: expect.any(String),
        actorName: '개발자',
        mailFailedTo: [],
        issue: null,
        memberName: null,
        version: { id: draft.versionId, number: 0 },
      },
    ]);

    const retry = await post(`/api/versions/${draft.versionId}/publish`).expect(409);
    expect(retry.body.code).toBe('VERSION_NOT_DRAFT');
    await getActivity().expect(200).expect(activity.body);
  });
});
