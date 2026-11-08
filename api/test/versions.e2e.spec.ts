import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { crc32 } from 'node:zlib';
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
const versionNotFoundBody = { statusCode: 404, message: '없는 버전이에요', error: 'Not Found' };
const screenNotFoundBody = { statusCode: 404, message: '없는 화면이에요', error: 'Not Found' };
const draftExistsBody = { statusCode: 409, message: '이미 작성 중인 초안이 있어요', code: 'DRAFT_EXISTS' };
const versionNotDraftBody = { statusCode: 409, message: '게시한 버전은 고칠 수 없어요', code: 'VERSION_NOT_DRAFT' };
const httpsPrefix = 'https://example.com/';

describe('버전 API (e2e)', () => {
  let app: INestApplication | undefined;
  let server: Server;
  let prisma: PrismaService;
  let directory: string;
  let developerId: string;
  let projectId: string;
  let otherProjectId: string;
  let cookie: string;
  let clientCookie: string;
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

  const getDetail = (versionId: string, memberCookie = cookie) =>
    request(server).get(`/api/versions/${versionId}`).set('Cookie', memberCookie);

  const patch = (versionId: string) =>
    request(server).patch(`/api/versions/${versionId}`).set('Origin', origin).set('Cookie', cookie);

  const putPhoto = (versionId: string, screenId: string) =>
    request(server)
      .put(`/api/versions/${versionId}/screens/${screenId}/asset`)
      .set('Origin', origin)
      .set('Cookie', cookie);

  const removeScreen = (versionId: string, screenId: string) =>
    request(server)
      .delete(`/api/versions/${versionId}/screens/${screenId}`)
      .set('Origin', origin)
      .set('Cookie', cookie);

  const createDraft = () => post(`/api/projects/${projectId}/versions`).expect(201);

  const createScreen = (targetProjectId = projectId) =>
    prisma.screen.create({ data: { projectId: targetProjectId, name: `화면 ${randomUUID()}`, viewport: 'PC' } });

  // 빈 프로젝트 폴더는 남아도 된다. ASSET_DIR 전체에서 실제 파일만 확인한다.
  const assetFiles = async () => {
    const entries = await readdir(directory, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => relative(directory, join(entry.parentPath, entry.name)))
      .sort();
  };

  // 권한 표의 다섯 경로에 같은 조건을 적용한다. PUT은 가드가 먼저 답해도 안전한 작은 사진이다.
  const versionRequests = (versionId: string, screenId: string) => [
    () => request(server).get(`/api/versions/${versionId}`),
    () => request(server).patch(`/api/versions/${versionId}`).send({ summary: '바뀐 설명' }),
    () =>
      request(server).put(`/api/versions/${versionId}/screens/${screenId}/asset`).attach('file', photo, 'screen.png'),
    () => request(server).delete(`/api/versions/${versionId}/screens/${screenId}`),
    () => request(server).post(`/api/versions/${versionId}/publish`),
  ];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'versions-e2e-'));
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
    developerId = developer.id;
    const project = await prisma.project.create({
      data: {
        name: '버전 검수 프로젝트',
        members: {
          create: [
            { userId: developer.id, role: 'DEVELOPER' },
            { userId: client.id, role: 'CLIENT' },
          ],
        },
      },
    });
    // 다른 프로젝트의 개발자여도 이 프로젝트에서는 클라이언트다.
    const otherProject = await prisma.project.create({
      data: { name: '남의 프로젝트', members: { create: { userId: client.id, role: 'DEVELOPER' } } },
    });
    projectId = project.id;
    otherProjectId = otherProject.id;
    cookie = await login(developer.id);
    clientCookie = await login(client.id);
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

  it.each(['DEVELOPER', 'CLIENT'] as const)('버전이 없으면 %s의 목록은 빈 배열이다', async (role) => {
    await prisma.deliveryVersion.create({ data: { projectId: otherProjectId } });

    await request(server)
      .get(`/api/projects/${projectId}/versions`)
      .set('Cookie', role === 'DEVELOPER' ? cookie : clientCookie)
      .expect(200)
      .expect([]);
  });

  it('초안 생성·상세·수정·사진·화면 빼기·게시가 정해진 코드와 상세 모양을 돌려준다', async () => {
    const draft = await createDraft();
    expect(draft.body).toEqual({
      id: expect.any(String),
      projectId,
      number: null,
      status: 'DRAFT',
      summary: '',
      testUrl: null,
      publishedAt: null,
      screens: [],
    });
    await getDetail(draft.body.id).expect(200).expect(draft.body);

    const updated = await patch(draft.body.id)
      .send({ summary: ' \t첫  버전\n ', testUrl: '  https://example.com/review  ' })
      .expect(200);
    expect(updated.body).toEqual({ ...draft.body, summary: '첫  버전', testUrl: 'https://example.com/review' });
    const screen = await createScreen();
    const uploaded = await putPhoto(draft.body.id, screen.id).attach('file', photo, 'screen.png').expect(200);
    expect(uploaded.body).toEqual({
      ...updated.body,
      screens: [
        {
          screenId: screen.id,
          name: screen.name,
          viewport: 'PC',
          hiddenAt: null,
          asset: { id: expect.any(String), width: 32, height: 24 },
        },
      ],
    });
    await getDetail(draft.body.id).expect(200).expect(uploaded.body);

    await removeScreen(draft.body.id, screen.id).expect(200).expect(updated.body);
    expect(await prisma.asset.count()).toBe(0);
    expect(await prisma.versionScreen.count()).toBe(0);
    expect(await assetFiles()).toEqual([]);
    const reuploaded = await putPhoto(draft.body.id, screen.id).attach('file', photo, 'screen.png').expect(200);
    const published = await post(`/api/versions/${draft.body.id}/publish`).expect(200);
    expect(published.body).toEqual({
      ...reuploaded.body,
      status: 'IN_REVIEW',
      number: 1,
      publishedAt: expect.any(String),
    });
    expect(new Date(published.body.publishedAt).toISOString()).toBe(published.body.publishedAt);
    await getDetail(draft.body.id, clientCookie).expect(200).expect(published.body);
    // 조각 11의 GET /projects/:id 응답 변경 없이도 게시 결과를 목록에서 확인할 수 있어야 한다.
    await request(server)
      .get(`/api/projects/${projectId}/versions`)
      .set('Cookie', clientCookie)
      .expect(200)
      .expect([{ id: draft.body.id, number: 1, status: 'IN_REVIEW', publishedAt: published.body.publishedAt }]);
    expect(await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).toMatchObject({
      currentVersionId: draft.body.id,
    });
    expect(await prisma.activityEvent.findMany()).toEqual([
      {
        id: expect.any(String),
        projectId,
        actorId: developerId,
        type: 'VERSION_PUBLISHED',
        versionId: draft.body.id,
        createdAt: expect.any(Date),
      },
    ]);
  });

  it.each(['DEVELOPER', 'CLIENT'] as const)(
    '프로젝트 상세는 %s에게 게시 전 null, 1차 게시 뒤 1차, 2차 게시 뒤 2차를 돌려준다',
    async (role) => {
      const memberCookie = role === 'DEVELOPER' ? cookie : clientCookie;
      const projectDetail = { id: projectId, name: '버전 검수 프로젝트', myRole: role };
      await request(server)
        .get(`/api/projects/${projectId}`)
        .set('Cookie', memberCookie)
        .expect(200)
        .expect({ ...projectDetail, currentVersion: null });

      const first = await createDraft();
      const screen = await createScreen();
      await putPhoto(first.body.id, screen.id).attach('file', photo, 'screen.png').expect(200);
      await request(server)
        .get(`/api/projects/${projectId}`)
        .set('Cookie', memberCookie)
        .expect(200)
        .expect({ ...projectDetail, currentVersion: null });

      await post(`/api/versions/${first.body.id}/publish`).expect(200);
      await request(server)
        .get(`/api/projects/${projectId}`)
        .set('Cookie', memberCookie)
        .expect(200)
        .expect({ ...projectDetail, currentVersion: { id: first.body.id, number: 1 } });

      const second = await createDraft();
      expect(second.body.id).not.toBe(first.body.id);
      await request(server)
        .get(`/api/projects/${projectId}`)
        .set('Cookie', memberCookie)
        .expect(200)
        .expect({ ...projectDetail, currentVersion: { id: first.body.id, number: 1 } });

      await post(`/api/versions/${second.body.id}/publish`).expect(200);
      await request(server)
        .get(`/api/projects/${projectId}`)
        .set('Cookie', memberCookie)
        .expect(200)
        .expect({ ...projectDetail, currentVersion: { id: second.body.id, number: 2 } });

      // 지난 버전을 다시 게시하려다 실패해도 현재 버전이 1차로 돌아가지 않는다.
      await post(`/api/versions/${first.body.id}/publish`).expect(409).expect(versionNotDraftBody);
      await request(server)
        .get(`/api/projects/${projectId}`)
        .set('Cookie', memberCookie)
        .expect(200)
        .expect({ ...projectDetail, currentVersion: { id: second.body.id, number: 2 } });
    },
  );

  it.each(['NO_SCREENS', 'SCREEN_HIDDEN'] as const)(
    '2차 게시가 %s 409이면 두 멤버의 프로젝트 상세는 계속 1차를 가리킨다',
    async (code) => {
      const first = await createDraft();
      const screen = await createScreen();
      await putPhoto(first.body.id, screen.id).attach('file', photo, 'screen.png').expect(200);
      await post(`/api/versions/${first.body.id}/publish`).expect(200);
      const second = await createDraft();
      if (code === 'NO_SCREENS') await removeScreen(second.body.id, screen.id).expect(200);
      if (code === 'SCREEN_HIDDEN') await post(`/api/screens/${screen.id}/hide`).expect(200);

      const failed = await post(`/api/versions/${second.body.id}/publish`).expect(409);
      expect(failed.body).toEqual({ statusCode: 409, message: expect.any(String), code });

      for (const role of ['DEVELOPER', 'CLIENT'] as const) {
        await request(server)
          .get(`/api/projects/${projectId}`)
          .set('Cookie', role === 'DEVELOPER' ? cookie : clientCookie)
          .expect(200)
          .expect({
            id: projectId,
            name: '버전 검수 프로젝트',
            myRole: role,
            currentVersion: { id: first.body.id, number: 1 },
          });
      }
    },
  );

  it('현재 버전이 있어도 비멤버에게 프로젝트 상세는 없는 프로젝트와 같은 404다', async () => {
    const draft = await post(`/api/projects/${otherProjectId}/versions`, clientCookie).expect(201);
    const screen = await createScreen(otherProjectId);
    await request(server)
      .put(`/api/versions/${draft.body.id}/screens/${screen.id}/asset`)
      .set('Origin', origin)
      .set('Cookie', clientCookie)
      .attach('file', photo, 'screen.png')
      .expect(200);
    await post(`/api/versions/${draft.body.id}/publish`, clientCookie).expect(200);

    for (const id of [otherProjectId, missingId]) {
      await request(server).get(`/api/projects/${id}`).set('Cookie', cookie).expect(404).expect(projectNotFoundBody);
    }
  });

  it('목록은 초안·2차·1차 순으로 네 칸만 주고 클라이언트에게 초안을 숨긴다', async () => {
    const first = await createDraft();
    const screen = await createScreen();
    await putPhoto(first.body.id, screen.id).attach('file', photo, 'screen.png').expect(200);
    const publishedFirst = await post(`/api/versions/${first.body.id}/publish`).expect(200);
    const second = await createDraft();
    const publishedSecond = await post(`/api/versions/${second.body.id}/publish`).expect(200);
    expect(publishedSecond.body.number).toBe(2);
    const draft = await createDraft();
    await prisma.deliveryVersion.create({ data: { projectId: otherProjectId } });
    const publishedList = [
      { id: second.body.id, number: 2, status: 'IN_REVIEW', publishedAt: publishedSecond.body.publishedAt },
      { id: first.body.id, number: 1, status: 'IN_REVIEW', publishedAt: publishedFirst.body.publishedAt },
    ];

    await request(server)
      .get(`/api/projects/${projectId}/versions`)
      .set('Cookie', cookie)
      .expect(200)
      .expect([{ id: draft.body.id, number: null, status: 'DRAFT', publishedAt: null }, ...publishedList]);
    await request(server)
      .get(`/api/projects/${projectId}/versions`)
      .set('Cookie', clientCookie)
      .expect(200)
      .expect(publishedList);
    expect(await prisma.activityEvent.count()).toBe(2);
  });

  it('화면 상세는 업로드 순서나 이름순 대신 화면을 만든 순서이고 숨긴 시각도 돌려준다', async () => {
    const draft = await createDraft();
    const newer = await prisma.screen.create({
      data: { projectId, name: '가', viewport: 'PC', createdAt: new Date('2026-01-03T00:00:00Z') },
    });
    const older = await prisma.screen.create({
      data: { projectId, name: '나', viewport: 'MOBILE', createdAt: new Date('2026-01-01T00:00:00Z') },
    });
    const firstUpload = await putPhoto(draft.body.id, newer.id).attach('file', photo, 'newer.png').expect(200);
    const secondUpload = await putPhoto(draft.body.id, older.id).attach('file', photo, 'older.png').expect(200);
    const hidden = await post(`/api/screens/${older.id}/hide`).expect(200);

    const detail = await getDetail(draft.body.id).expect(200);
    expect(detail.body).toEqual({
      ...draft.body,
      screens: [
        {
          screenId: older.id,
          name: '나',
          viewport: 'MOBILE',
          hiddenAt: hidden.body.hiddenAt,
          asset: secondUpload.body.screens[0].asset,
        },
        { screenId: newer.id, name: '가', viewport: 'PC', hiddenAt: null, asset: firstUpload.body.screens[0].asset },
      ],
    });
  });

  it('2차 초안은 숨긴 화면을 빼고 같은 사진을 복사하며 바꾼 화면만 새 사진을 쓴다', async () => {
    const first = await createDraft();
    const changed = await createScreen();
    const unchanged = await createScreen();
    const hidden = await createScreen();
    for (const screen of [changed, unchanged, hidden]) {
      await putPhoto(first.body.id, screen.id).attach('file', photo, 'screen.png').expect(200);
    }
    const published = await post(`/api/versions/${first.body.id}/publish`).expect(200);
    const originalAssets = await prisma.asset.findMany();
    await post(`/api/screens/${hidden.id}/hide`).expect(200);
    const firstDetail = await getDetail(first.body.id, clientCookie).expect(200);
    const draft = await createDraft();
    const copied = published.body.screens.filter((screen: { screenId: string }) => screen.screenId !== hidden.id);
    expect(draft.body).toEqual({
      id: expect.any(String),
      projectId,
      number: null,
      status: 'DRAFT',
      summary: '',
      testUrl: null,
      publishedAt: null,
      screens: copied,
    });
    expect(await prisma.asset.count()).toBe(3);
    const replacement = await sharp(photo).resize(16, 12).jpeg().toBuffer();
    const updated = await putPhoto(draft.body.id, changed.id).attach('file', replacement, 'changed.jpg').expect(200);
    expect(updated.body.screens).toEqual(
      copied.map((screen: { screenId: string; asset: { id: string } }) =>
        screen.screenId === changed.id
          ? { ...screen, asset: { id: expect.any(String), width: 16, height: 12 } }
          : screen,
      ),
    );
    expect(
      updated.body.screens.find((screen: { screenId: string }) => screen.screenId === changed.id).asset.id,
    ).not.toBe(copied.find((screen: { screenId: string }) => screen.screenId === changed.id).asset.id);

    // 초안에서 공유 사진을 빼도 1차 사진 파일과 상세는 보존한다.
    await removeScreen(draft.body.id, unchanged.id).expect(200);
    await getDetail(first.body.id, clientCookie).expect(200).expect(firstDetail.body);
    expect(await prisma.asset.count()).toBe(4);
    for (const asset of originalAssets) {
      expect(await prisma.asset.findUnique({ where: { id: asset.id } })).toEqual(asset);
      expect(await readFile(join(directory, asset.storageKey))).toBeInstanceOf(Buffer);
    }
  });

  it.each(['', ' \t\n ', '가', '가'.repeat(1000)])('설명 경계값(%s)은 공백을 지운 뒤 저장한다', async (summary) => {
    const draft = await createDraft();
    const response = await patch(draft.body.id)
      .send({ summary: `  ${summary}  ` })
      .expect(200);

    expect(response.body).toEqual({ ...draft.body, summary: summary.trim() });
    await getDetail(draft.body.id).expect(200).expect(response.body);
  });

  it.each([
    { label: '설명 1001자', body: { summary: '가'.repeat(1001) } },
    { label: '설명 null', body: { summary: null } },
    { label: '설명 숫자', body: { summary: 123 } },
    { label: '설명 불리언', body: { summary: false } },
    { label: '설명 배열', body: { summary: ['설명'] } },
    { label: '설명 객체', body: { summary: {} } },
    { label: 'http 주소', body: { testUrl: 'http://example.com' } },
    { label: 'javascript 주소', body: { testUrl: 'javascript:alert(1)' } },
    { label: '프로토콜 없음', body: { testUrl: 'example.com' } },
    { label: '주소의 호스트 없음', body: { testUrl: 'https://' } },
    { label: '주소 2001자', body: { testUrl: httpsPrefix + 'a'.repeat(2001 - httpsPrefix.length) } },
    { label: '주소 숫자', body: { testUrl: 123 } },
    { label: '주소 false', body: { testUrl: false } },
    { label: '주소 배열', body: { testUrl: ['https://example.com'] } },
    { label: '주소 객체', body: { testUrl: {} } },
    { label: '모르는 칸', body: { summary: '저장되면 안 됨', unexpected: true } },
    { label: '상태 직접 변경', body: { status: 'IN_REVIEW' } },
    { label: '번호 직접 변경', body: { number: 1 } },
  ])('PATCH $label은 422이고 기존 설명·주소를 보존한다', async ({ body }) => {
    const draft = await createDraft();
    const saved = await patch(draft.body.id).send({ summary: '기존 설명', testUrl: 'https://example.com' }).expect(200);
    const response = await patch(draft.body.id).send(body).expect(422);

    expect(response.body.statusCode).toBe(422);
    expect(response.body.message).toEqual(expect.any(Array));
    await getDetail(draft.body.id).expect(200).expect(saved.body);
  });

  it.each(['', ' \t\n ', null])('testUrl=%s는 주소만 null로 지운다', async (testUrl) => {
    const draft = await createDraft();
    const saved = await patch(draft.body.id).send({ summary: '기존 설명', testUrl: 'https://example.com' }).expect(200);

    await patch(draft.body.id)
      .send({ testUrl })
      .expect(200)
      .expect({ ...saved.body, testUrl: null });
    await getDetail(draft.body.id)
      .expect(200)
      .expect({ ...saved.body, testUrl: null });
  });

  it('https 주소 2000자는 허용하며 빈 PATCH 본문은 설명과 주소를 그대로 둔다', async () => {
    const draft = await createDraft();
    const testUrl = httpsPrefix + 'a'.repeat(2000 - httpsPrefix.length);
    const saved = await patch(draft.body.id).send({ summary: '기존 설명', testUrl }).expect(200);
    expect(saved.body).toEqual({ ...draft.body, summary: '기존 설명', testUrl });

    await patch(draft.body.id).send({}).expect(200).expect(saved.body);
    await getDetail(draft.body.id).expect(200).expect(saved.body);
    await patch(draft.body.id)
      .send({ summary: '설명만 수정' })
      .expect(200)
      .expect({ ...saved.body, summary: '설명만 수정' });
  });

  it.each(['png', 'jpeg', 'webp'] as const)(
    '%s 실제 사진을 multipart file로 받아 같은 형식으로 저장한다',
    async (format) => {
      const draft = await createDraft();
      const screen = await createScreen();
      const input = await sharp(photo).toFormat(format).toBuffer();

      const response = await putPhoto(draft.body.id, screen.id).attach('file', input, `screen.${format}`).expect(200);
      const asset = await prisma.asset.findUniqueOrThrow({ where: { id: response.body.screens[0].asset.id } });
      const saved = await readFile(join(directory, asset.storageKey));
      expect(asset).toMatchObject({ projectId, mime: `image/${format}`, bytes: saved.length, width: 32, height: 24 });
      expect(await sharp(saved).metadata()).toMatchObject({ format, width: 32, height: 24 });
      expect(await assetFiles()).toEqual([asset.storageKey]);
    },
  );

  it('회전 정보가 든 JPEG를 바로 세워 저장하고 EXIF·ICC·XMP를 지운다', async () => {
    const draft = await createDraft();
    const screen = await createScreen();
    const input = await sharp(photo)
      .jpeg()
      .withMetadata({ orientation: 6 })
      .withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/">test metadata</x:xmpmeta>')
      .toBuffer();
    expect(await sharp(input).metadata()).toMatchObject({
      orientation: 6,
      exif: expect.any(Buffer),
      icc: expect.any(Buffer),
      xmp: expect.any(Buffer),
    });

    const response = await putPhoto(draft.body.id, screen.id).attach('file', input, 'rotated.jpg').expect(200);
    expect(response.body.screens[0].asset).toEqual({ id: expect.any(String), width: 24, height: 32 });
    const asset = await prisma.asset.findUniqueOrThrow({ where: { id: response.body.screens[0].asset.id } });
    const metadata = await sharp(await readFile(join(directory, asset.storageKey))).metadata();
    expect(metadata).toMatchObject({ format: 'jpeg', width: 24, height: 32 });
    expect(metadata.orientation).toBeUndefined();
    expect(metadata.exif).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
    expect(metadata.xmp).toBeUndefined();
  });

  it('초안 전용 사진을 교체하면 이전 Asset과 파일은 지우고 새 사진 하나만 남긴다', async () => {
    const draft = await createDraft();
    const screen = await createScreen();
    const old = await putPhoto(draft.body.id, screen.id).attach('file', photo, 'old.png').expect(200);
    const oldAsset = await prisma.asset.findUniqueOrThrow({ where: { id: old.body.screens[0].asset.id } });
    const input = await sharp(photo).resize(16, 12).jpeg().toBuffer();

    const replaced = await putPhoto(draft.body.id, screen.id).attach('file', input, 'new.jpg').expect(200);
    expect(replaced.body.screens).toEqual([
      {
        screenId: screen.id,
        name: screen.name,
        viewport: 'PC',
        hiddenAt: null,
        asset: { id: expect.any(String), width: 16, height: 12 },
      },
    ]);
    const newId = replaced.body.screens[0].asset.id;
    expect(newId).not.toBe(oldAsset.id);
    expect(await prisma.asset.findUnique({ where: { id: oldAsset.id } })).toBeNull();
    await expect(readFile(join(directory, oldAsset.storageKey))).rejects.toMatchObject({ code: 'ENOENT' });
    const newAsset = await prisma.asset.findUniqueOrThrow({ where: { id: newId } });
    expect(await assetFiles()).toEqual([newAsset.storageKey]);
    expect(await prisma.versionScreen.count()).toBe(1);
    await getDetail(draft.body.id).expect(200).expect(replaced.body);
  });

  it('10 MiB를 넘는 파일은 413이고 파일과 DB 줄이 남지 않는다', async () => {
    const draft = await createDraft();
    const screen = await createScreen();
    const oversized = Buffer.concat([photo, Buffer.alloc(10 * 1024 * 1024 + 1 - photo.length)]);

    await putPhoto(draft.body.id, screen.id).attach('file', oversized, 'large.png').expect(413);
    expect(await assetFiles()).toEqual([]);
    expect(await prisma.asset.count()).toBe(0);
    await getDetail(draft.body.id).expect(200).expect(draft.body);
  });

  it.each([10 * 1024 * 1024 - 1, 10 * 1024 * 1024])('%i바이트 사진은 10 MiB 이하라서 허용한다', async (bytes) => {
    const draft = await createDraft();
    const screen = await createScreen();
    // PNG 끝에 패딩을 붙여 픽셀 크기를 바꾸지 않고 multipart 파일 크기만 경계값으로 맞춘다.
    const input = Buffer.concat([photo, Buffer.alloc(bytes - photo.length)]);
    expect(input.length).toBe(bytes);
    expect(await sharp(input).metadata()).toMatchObject({ format: 'png', width: 32, height: 24 });

    const response = await putPhoto(draft.body.id, screen.id).attach('file', input, 'boundary.png').expect(200);
    expect(response.body.screens[0].asset).toEqual({ id: expect.any(String), width: 32, height: 24 });
    expect(await prisma.asset.count()).toBe(1);
    expect(await assetFiles()).toHaveLength(1);
  });

  it.each([
    { label: '가짜 PNG', data: Buffer.from('not an image') },
    { label: '빈 파일', data: Buffer.alloc(0) },
    { label: 'PNG 머리만', data: Buffer.from('89504e470d0a1a0a', 'hex') },
  ])('$label은 image/png로 보내도 415이고 파일이 남지 않는다', async ({ data }) => {
    const draft = await createDraft();
    const screen = await createScreen();

    await putPhoto(draft.body.id, screen.id)
      .attach('file', data, { filename: 'fake.png', contentType: 'image/png' })
      .expect(415);
    expect(await assetFiles()).toEqual([]);
    expect(await prisma.asset.count()).toBe(0);
    await getDetail(draft.body.id).expect(200).expect(draft.body);
  });

  it('움직이는 WebP는 415이고 파일이 남지 않는다', async () => {
    const draft = await createDraft();
    const screen = await createScreen();
    const red = Buffer.alloc(16 * 16 * 3, Buffer.from([255, 0, 0]));
    const blue = Buffer.alloc(16 * 16 * 3, Buffer.from([0, 0, 255]));
    const animated = await sharp(Buffer.concat([red, blue]), {
      raw: { width: 16, height: 32, channels: 3, pageHeight: 16 },
    })
      .webp({ delay: [100, 100], loop: 0 })
      .toBuffer();
    expect((await sharp(animated, { animated: true }).metadata()).pages).toBe(2);

    await putPhoto(draft.body.id, screen.id).attach('file', animated, 'animated.webp').expect(415);
    expect(await assetFiles()).toEqual([]);
    expect(await prisma.asset.count()).toBe(0);
  });

  it('PNG에 움직임 정보가 있으면 sharp가 한 장으로 읽어도 415이고 파일이 남지 않는다', async () => {
    const draft = await createDraft();
    const screen = await createScreen();
    // 조각 2의 APNG 형식: IHDR 뒤에 두 프레임을 나타내는 acTL과 올바른 CRC를 넣는다.
    const chunk = Buffer.alloc(20);
    chunk.writeUInt32BE(8, 0);
    chunk.write('acTL', 4, 4, 'ascii');
    chunk.writeUInt32BE(2, 8);
    chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), 16);
    const afterHeader = 8 + 12 + photo.readUInt32BE(8);
    const animated = Buffer.concat([photo.subarray(0, afterHeader), chunk, photo.subarray(afterHeader)]);
    expect(await sharp(animated).metadata()).toMatchObject({ format: 'png', width: 32, height: 24 });

    await putPhoto(draft.body.id, screen.id).attach('file', animated, 'animated.png').expect(415);
    expect(await assetFiles()).toEqual([]);
    expect(await prisma.asset.count()).toBe(0);
  });

  it('긴 변이 20000px를 넘으면 작은 압축 파일이어도 413이고 파일이 남지 않는다', async () => {
    const draft = await createDraft();
    const screen = await createScreen();
    const input = await sharp({ create: { width: 20001, height: 1, channels: 3, background: 'red' } })
      .png()
      .toBuffer();

    await putPhoto(draft.body.id, screen.id).attach('file', input, 'wide.png').expect(413);
    expect(await assetFiles()).toEqual([]);
    expect(await prisma.asset.count()).toBe(0);
  });

  it.each(['빈 본문', '파일 없는 multipart'] as const)('%s은 422와 사진 안내 문구를 돌려준다', async (body) => {
    const draft = await createDraft();
    const screen = await createScreen();
    const pending = putPhoto(draft.body.id, screen.id);
    if (body === '파일 없는 multipart') pending.field('description', '사진 없음');

    await pending
      .expect(422)
      .expect({ statusCode: 422, message: '사진 파일을 보내 주세요', error: 'Unprocessable Entity' });
    expect(await assetFiles()).toEqual([]);
    expect(await prisma.asset.count()).toBe(0);
    await getDetail(draft.body.id).expect(200).expect(draft.body);
  });

  it.each(['파일 두 개', '다른 칸 이름'] as const)('%s는 400이고 파일이 남지 않는다', async (kind) => {
    const draft = await createDraft();
    const screen = await createScreen();
    const pending = putPhoto(draft.body.id, screen.id);
    if (kind === '파일 두 개') pending.attach('file', photo, 'one.png').attach('file', photo, 'two.png');
    if (kind === '다른 칸 이름') pending.attach('photo', photo, 'screen.png');

    await pending.expect(400);
    expect(await assetFiles()).toEqual([]);
    expect(await prisma.asset.count()).toBe(0);
    await getDetail(draft.body.id).expect(200).expect(draft.body);
  });

  it('초안이 있으면 DRAFT_EXISTS 409이고 기존 초안을 보존한다', async () => {
    const draft = await createDraft();

    await post(`/api/projects/${projectId}/versions`).expect(409).expect(draftExistsBody);
    expect(await prisma.deliveryVersion.count()).toBe(1);
    await getDetail(draft.body.id).expect(200).expect(draft.body);
  });

  it('동시에 초안을 두 번 만들면 하나만 201이고 다른 하나는 DRAFT_EXISTS 409다', async () => {
    const responses = await Promise.all([
      post(`/api/projects/${projectId}/versions`),
      post(`/api/projects/${projectId}/versions`),
    ]);

    expect(responses.map(({ status }) => status).sort((left, right) => left - right)).toEqual([201, 409]);
    expect(responses.find(({ status }) => status === 409)?.body).toEqual(draftExistsBody);
    expect(await prisma.deliveryVersion.count()).toBe(1);
  });

  it('빈 초안 게시가 NO_SCREENS 409이면 번호·현재 버전·일지가 생기지 않는다', async () => {
    const draft = await createDraft();

    await post(`/api/versions/${draft.body.id}/publish`)
      .expect(409)
      .expect({ statusCode: 409, message: '사진을 올린 화면이 없어요', code: 'NO_SCREENS' });
    await getDetail(draft.body.id).expect(200).expect(draft.body);
    expect(await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).toMatchObject({
      currentVersionId: null,
    });
    expect(await prisma.activityEvent.count()).toBe(0);
    for (const role of ['DEVELOPER', 'CLIENT'] as const) {
      await request(server)
        .get(`/api/projects/${projectId}`)
        .set('Cookie', role === 'DEVELOPER' ? cookie : clientCookie)
        .expect(200)
        .expect({ id: projectId, name: '버전 검수 프로젝트', myRole: role, currentVersion: null });
    }
  });

  it('숨긴 화면 업로드는 SCREEN_HIDDEN 409이고 새 파일을 지운다', async () => {
    const draft = await createDraft();
    const screen = await createScreen();
    await post(`/api/screens/${screen.id}/hide`).expect(200);

    await putPhoto(draft.body.id, screen.id)
      .attach('file', photo, 'screen.png')
      .expect(409)
      .expect({ statusCode: 409, message: '숨긴 화면에는 사진을 올릴 수 없어요', code: 'SCREEN_HIDDEN' });
    expect(await assetFiles()).toEqual([]);
    expect(await prisma.asset.count()).toBe(0);
    await getDetail(draft.body.id).expect(200).expect(draft.body);
  });

  it('사진을 올린 뒤 숨기면 게시가 SCREEN_HIDDEN 409이며 화면을 뺀 뒤 1차로 게시된다', async () => {
    const draft = await createDraft();
    const visible = await createScreen();
    const hidden = await createScreen();
    for (const screen of [visible, hidden]) {
      await putPhoto(draft.body.id, screen.id).attach('file', photo, 'screen.png').expect(200);
    }
    await post(`/api/screens/${hidden.id}/hide`).expect(200);
    const before = await getDetail(draft.body.id).expect(200);
    const files = await assetFiles();

    await post(`/api/versions/${draft.body.id}/publish`)
      .expect(409)
      .expect({ statusCode: 409, message: '숨긴 화면을 빼고 게시해 주세요', code: 'SCREEN_HIDDEN' });
    await getDetail(draft.body.id).expect(200).expect(before.body);
    expect(before.body).toMatchObject({ number: null, publishedAt: null, status: 'DRAFT' });
    expect(await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).toMatchObject({
      currentVersionId: null,
    });
    expect(await prisma.activityEvent.count()).toBe(0);
    expect(await assetFiles()).toEqual(files);
    await removeScreen(draft.body.id, hidden.id).expect(200);
    const published = await post(`/api/versions/${draft.body.id}/publish`).expect(200);
    expect(published.body).toMatchObject({ number: 1, status: 'IN_REVIEW' });
    expect(await prisma.activityEvent.count()).toBe(1);
  });

  it('동시 게시는 하나만 200이고 번호와 일지가 한 번만 생긴다', async () => {
    const draft = await createDraft();
    const screen = await createScreen();
    await putPhoto(draft.body.id, screen.id).attach('file', photo, 'screen.png').expect(200);

    const responses = await Promise.all([
      post(`/api/versions/${draft.body.id}/publish`),
      post(`/api/versions/${draft.body.id}/publish`),
    ]);
    expect(responses.map(({ status }) => status).sort((left, right) => left - right)).toEqual([200, 409]);
    expect(responses.find(({ status }) => status === 409)?.body).toEqual(versionNotDraftBody);
    const published = responses.find(({ status }) => status === 200)!.body;
    expect(published).toMatchObject({
      id: draft.body.id,
      status: 'IN_REVIEW',
      number: 1,
      publishedAt: expect.any(String),
    });
    await getDetail(draft.body.id).expect(200).expect(published);
    expect(await prisma.activityEvent.count()).toBe(1);
    for (const role of ['DEVELOPER', 'CLIENT'] as const) {
      await request(server)
        .get(`/api/projects/${projectId}`)
        .set('Cookie', role === 'DEVELOPER' ? cookie : clientCookie)
        .expect(200)
        .expect({
          id: projectId,
          name: '버전 검수 프로젝트',
          myRole: role,
          currentVersion: { id: draft.body.id, number: 1 },
        });
    }
  });

  it('게시한 버전의 PATCH·PUT·DELETE·재게시는 VERSION_NOT_DRAFT 409이고 사진과 일지를 보존한다', async () => {
    const draft = await createDraft();
    const screen = await createScreen();
    await putPhoto(draft.body.id, screen.id).attach('file', photo, 'screen.png').expect(200);
    const published = await post(`/api/versions/${draft.body.id}/publish`).expect(200);
    const assets = await prisma.asset.findMany();
    const files = await assetFiles();

    for (const makeRequest of versionRequests(draft.body.id, screen.id).slice(1)) {
      await makeRequest().set('Origin', origin).set('Cookie', cookie).expect(409).expect(versionNotDraftBody);
      expect(await assetFiles()).toEqual(files);
    }
    await getDetail(draft.body.id).expect(200).expect(published.body);
    expect(await prisma.asset.findMany()).toEqual(assets);
    expect(await prisma.activityEvent.count()).toBe(1);
  });

  it('20개 화면은 게시할 수 있고 21번째는 TOO_MANY_SCREENS 409이며 기존 화면 교체는 허용한다', async () => {
    const draft = await createDraft();
    const screens = [];
    for (let index = 0; index < 20; index += 1) {
      const screen = await createScreen();
      screens.push(screen);
      await putPhoto(draft.body.id, screen.id).attach('file', photo, 'screen.png').expect(200);
    }
    const before = await getDetail(draft.body.id).expect(200);
    expect(before.body.screens).toHaveLength(20);
    const files = await assetFiles();
    const extra = await createScreen();

    await putPhoto(draft.body.id, extra.id)
      .attach('file', photo, 'extra.png')
      .expect(409)
      .expect({ statusCode: 409, message: '화면은 20개까지 올릴 수 있어요', code: 'TOO_MANY_SCREENS' });
    await getDetail(draft.body.id).expect(200).expect(before.body);
    expect(await assetFiles()).toEqual(files);
    expect(await prisma.asset.count()).toBe(20);
    const replaced = await putPhoto(draft.body.id, screens[0].id).attach('file', photo, 'changed.png').expect(200);
    expect(replaced.body.screens).toHaveLength(20);
    expect(await prisma.asset.count()).toBe(20);
    expect(await assetFiles()).toHaveLength(20);
    const published = await post(`/api/versions/${draft.body.id}/publish`).expect(200);
    expect(published.body).toEqual({
      ...replaced.body,
      number: 1,
      status: 'IN_REVIEW',
      publishedAt: expect.any(String),
    });
  });

  it('용량을 넘는 교체는 413이며 기존 사진 용량을 미리 빼거나 기존 파일을 지우지 않는다', async () => {
    const draft = await createDraft();
    const screen = await createScreen();
    const uploaded = await putPhoto(draft.body.id, screen.id).attach('file', photo, 'original.png').expect(200);
    // 실제로 500 MiB 파일을 만들지 않고 DB의 합계만 한도에 맞춘다. 기존 파일 자체는 실제 PNG다.
    const asset = await prisma.asset.update({
      where: { id: uploaded.body.screens[0].asset.id },
      data: { bytes: 500 * 1024 * 1024 },
    });
    const original = await readFile(join(directory, asset.storageKey));
    const replacement = await sharp(photo).resize(16, 12).jpeg().toBuffer();

    await putPhoto(draft.body.id, screen.id).attach('file', replacement, 'changed.jpg').expect(413);
    await getDetail(draft.body.id).expect(200).expect(uploaded.body);
    expect(await prisma.asset.findMany()).toEqual([asset]);
    expect(await assetFiles()).toEqual([asset.storageKey]);
    expect(await readFile(join(directory, asset.storageKey))).toEqual(original);
  });

  it('사진 한 장만 더 들어갈 용량에서 동시에 두 장을 올리면 하나만 성공하고 실패한 파일은 지운다', async () => {
    const draft = await createDraft();
    const existing = await createScreen();
    const uploaded = await putPhoto(draft.body.id, existing.id).attach('file', photo, 'original.png').expect(200);
    const asset = await prisma.asset.findUniqueOrThrow({ where: { id: uploaded.body.screens[0].asset.id } });
    const quota = 500 * 1024 * 1024;
    await prisma.asset.update({ where: { id: asset.id }, data: { bytes: quota - asset.bytes } });
    const first = await createScreen();
    const second = await createScreen();

    const responses = await Promise.all([
      putPhoto(draft.body.id, first.id).attach('file', photo, 'first.png'),
      putPhoto(draft.body.id, second.id).attach('file', photo, 'second.png'),
    ]);
    expect(responses.map(({ status }) => status).sort((left, right) => left - right)).toEqual([200, 413]);
    const assets = await prisma.asset.findMany();
    expect(assets).toHaveLength(2);
    expect(assets.reduce((sum, saved) => sum + saved.bytes, 0)).toBe(quota);
    expect(await assetFiles()).toEqual(assets.map(({ storageKey }) => storageKey).sort());
    const detail = await getDetail(draft.body.id).expect(200);
    expect(detail.body).toEqual(responses.find(({ status }) => status === 200)!.body);
    expect(detail.body.screens).toHaveLength(2);
  });

  it('사진 교체와 게시가 겹쳐도 게시 응답 이후 사진이 바뀌거나 고아 파일이 남지 않는다', async () => {
    const draft = await createDraft();
    const screen = await createScreen();
    const old = await putPhoto(draft.body.id, screen.id).attach('file', photo, 'old.png').expect(200);
    const replacement = await sharp(photo).resize(16, 12).jpeg().toBuffer();

    const [uploaded, published] = await Promise.all([
      putPhoto(draft.body.id, screen.id).attach('file', replacement, 'changed.jpg'),
      post(`/api/versions/${draft.body.id}/publish`),
    ]);
    expect(published.status).toBe(200);
    expect([200, 409]).toContain(uploaded.status);
    if (uploaded.status === 409) expect(uploaded.body).toEqual(versionNotDraftBody);
    // 잠금 획득 순서는 강제하지 않는다. 교체가 먼저 끝났을 때만 새 사진으로 게시되어야 한다.
    expect(published.body.screens).toEqual(uploaded.status === 200 ? uploaded.body.screens : old.body.screens);
    await getDetail(draft.body.id, clientCookie).expect(200).expect(published.body);
    const assets = await prisma.asset.findMany();
    expect(assets).toHaveLength(1);
    expect(assets[0].id).toBe(published.body.screens[0].asset.id);
    expect(await assetFiles()).toEqual([assets[0].storageKey]);
    expect(await prisma.activityEvent.count()).toBe(1);
  });

  it.each(['DRAFT', 'IN_REVIEW'] as const)(
    '클라이언트의 %s 읽기·쓰기 권한과 업로드 파일 정리를 지킨다',
    async (status) => {
      const version = await prisma.deliveryVersion.create({
        data: {
          projectId,
          status,
          number: status === 'DRAFT' ? null : 1,
          publishedAt: status === 'DRAFT' ? null : new Date('2026-01-01T00:00:00Z'),
        },
      });
      const screen = await createScreen();
      const requests = versionRequests(version.id, screen.id);
      const read = requests[0]().set('Cookie', clientCookie);
      if (status === 'DRAFT') await read.expect(404).expect(versionNotFoundBody);
      if (status === 'IN_REVIEW') await read.expect(200);

      for (const makeRequest of requests.slice(1)) {
        const response = await makeRequest()
          .set('Origin', origin)
          .set('Cookie', clientCookie)
          .expect(status === 'DRAFT' ? 404 : 403);
        if (status === 'DRAFT') expect(response.body).toEqual(versionNotFoundBody);
        expect(await assetFiles()).toEqual([]);
      }
      expect(await prisma.deliveryVersion.findMany()).toEqual([version]);
      expect(await prisma.asset.count()).toBe(0);
      expect(await prisma.activityEvent.count()).toBe(0);
    },
  );

  it('클라이언트는 초안을 만들 수 없고 초안만 있는 프로젝트의 목록은 비어 있다', async () => {
    await post(`/api/projects/${projectId}/versions`, clientCookie).expect(403);
    expect(await prisma.deliveryVersion.count()).toBe(0);
    const draft = await createDraft();

    await post(`/api/projects/${projectId}/versions`, clientCookie).expect(403);
    await request(server).get(`/api/projects/${projectId}/versions`).set('Cookie', clientCookie).expect(200).expect([]);
    await getDetail(draft.body.id, clientCookie).expect(404).expect(versionNotFoundBody);
    expect(await prisma.deliveryVersion.count()).toBe(1);
  });

  it.each(['get', 'post'] as const)(
    '프로젝트 %s 경로는 남의 프로젝트·없는 UUID·틀린 id에 같은 404다',
    async (method) => {
      for (const id of [otherProjectId, missingId, 'abc']) {
        await request(server)
          [method](`/api/projects/${id}/versions`)
          .set('Origin', origin)
          .set('Cookie', cookie)
          .expect(404)
          .expect(projectNotFoundBody);
      }
      expect(await prisma.deliveryVersion.count()).toBe(0);
    },
  );

  it.each(['DRAFT', 'IN_REVIEW'] as const)(
    '남의 %s 버전·없는 UUID·틀린 id는 다섯 경로 모두 같은 404다',
    async (status) => {
      const other = await prisma.deliveryVersion.create({
        data: {
          projectId: otherProjectId,
          status,
          number: status === 'DRAFT' ? null : 1,
          publishedAt: status === 'DRAFT' ? null : new Date('2026-01-01T00:00:00Z'),
        },
      });
      const screen = await createScreen(otherProjectId);
      for (const id of [other.id, missingId, 'abc']) {
        for (const makeRequest of versionRequests(id, screen.id)) {
          await makeRequest().set('Origin', origin).set('Cookie', cookie).expect(404).expect(versionNotFoundBody);
        }
      }
      expect(await assetFiles()).toEqual([]);
      expect(await prisma.asset.count()).toBe(0);
      expect(await prisma.deliveryVersion.findMany()).toEqual([other]);
    },
  );

  it('사진 올리기·화면 빼기는 남의 화면·없는 UUID·틀린 화면 id에 같은 404다', async () => {
    const draft = await createDraft();
    const other = await createScreen(otherProjectId);
    for (const screenId of [other.id, missingId, 'abc']) {
      await putPhoto(draft.body.id, screenId)
        .attach('file', photo, 'screen.png')
        .expect(404)
        .expect(screenNotFoundBody);
      await removeScreen(draft.body.id, screenId).expect(404).expect(screenNotFoundBody);
      expect(await assetFiles()).toEqual([]);
    }
    expect(await prisma.asset.count()).toBe(0);
    await getDetail(draft.body.id).expect(200).expect(draft.body);
  });

  it('프로젝트에 있어도 초안에 없는 화면을 빼면 404다', async () => {
    const draft = await createDraft();
    const screen = await createScreen();

    await removeScreen(draft.body.id, screen.id).expect(404).expect(screenNotFoundBody);
    await getDetail(draft.body.id).expect(200).expect(draft.body);
    expect(await prisma.screen.findMany()).toEqual([screen]);
  });

  it.each(['로그인 안 함', '세션 만료'] as const)(
    '%s이면 일곱 경로 모두 401이고 파일·버전이 바뀌지 않는다',
    async (state) => {
      const draft = await prisma.deliveryVersion.create({ data: { projectId } });
      const screen = await createScreen();
      if (state === '세션 만료')
        await prisma.session.updateMany({ data: { expiresAt: new Date(Date.now() - 60_000) } });
      const requests = [
        () => request(server).get(`/api/projects/${projectId}/versions`),
        () => request(server).post(`/api/projects/${projectId}/versions`),
        ...versionRequests(draft.id, screen.id),
      ];

      for (const makeRequest of requests) {
        const pending = makeRequest().set('Origin', origin);
        if (state === '세션 만료') pending.set('Cookie', cookie);
        await pending.expect(401);
      }
      expect(await assetFiles()).toEqual([]);
      expect(await prisma.asset.count()).toBe(0);
      expect(await prisma.deliveryVersion.findMany()).toEqual([draft]);
      expect(await prisma.activityEvent.count()).toBe(0);
    },
  );

  it.each([
    { label: '다른 Origin', value: 'https://other.example' },
    { label: '포트만 다른 Origin', value: 'http://localhost:5174' },
    { label: 'Origin 없음', value: undefined },
  ])('$label이면 다섯 쓰기 경로 모두 403이고 파일·버전이 바뀌지 않는다', async ({ value }) => {
    const draft = await prisma.deliveryVersion.create({ data: { projectId } });
    const screen = await createScreen();
    const requests = [
      () => request(server).post(`/api/projects/${projectId}/versions`),
      ...versionRequests(draft.id, screen.id).slice(1),
    ];

    for (const makeRequest of requests) {
      const pending = makeRequest().set('Cookie', cookie);
      if (value !== undefined) pending.set('Origin', value);
      await pending.expect(403);
      expect(await assetFiles()).toEqual([]);
    }
    expect(await prisma.asset.count()).toBe(0);
    expect(await prisma.deliveryVersion.findMany()).toEqual([draft]);
    expect(await prisma.activityEvent.count()).toBe(0);
  });
});
