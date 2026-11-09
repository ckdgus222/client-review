import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { get, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger, type INestApplication } from '@nestjs/common';
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
const assetNotFoundBody = { statusCode: 404, message: '없는 사진이에요', error: 'Not Found' };

describe('사진 API (e2e)', () => {
  let app: INestApplication | undefined;
  let server: Server;
  let prisma: PrismaService;
  let directory: string;
  let projectId: string;
  let otherProjectId: string;
  let clientId: string;
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

  const getPhoto = (assetId: string, memberCookie = clientCookie) =>
    request(server).get(`/api/assets/${assetId}`).set('Cookie', memberCookie).buffer(true);

  const uploadPhoto = async (
    versionId: string,
    screenId: string,
    input = photo,
    format = 'png',
    memberCookie = cookie,
  ) => {
    const response = await request(server)
      .put(`/api/versions/${versionId}/screens/${screenId}/asset`)
      .set('Origin', origin)
      .set('Cookie', memberCookie)
      .attach('file', input, `screen.${format}`)
      .expect(200);
    const screen = response.body.screens.find((item: { screenId: string }) => item.screenId === screenId);
    return prisma.asset.findUniqueOrThrow({ where: { id: screen.asset.id } });
  };

  const createDraftWithPhoto = async (
    input = photo,
    format = 'png',
    targetProjectId = projectId,
    memberCookie = cookie,
  ) => {
    const draft = await post(`/api/projects/${targetProjectId}/versions`, memberCookie).expect(201);
    const screen = await prisma.screen.create({
      data: { projectId: targetProjectId, name: `화면 ${randomUUID()}`, viewport: 'PC' },
    });
    const versionId: string = draft.body.id;
    const asset = await uploadPhoto(versionId, screen.id, input, format, memberCookie);
    return { versionId, screenId: screen.id, asset };
  };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'assets-e2e-'));
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
    clientId = client.id;
    const project = await prisma.project.create({
      data: {
        name: '사진 검수 프로젝트',
        members: {
          create: [
            { userId: developer.id, role: 'DEVELOPER' },
            { userId: client.id, role: 'CLIENT' },
          ],
        },
      },
    });
    const otherProject = await prisma.project.create({
      data: { name: '남의 프로젝트', members: { create: { userId: outsider.id, role: 'DEVELOPER' } } },
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

  it.each(['png', 'jpeg', 'webp'] as const)(
    '게시한 %s는 저장된 바이트·MIME과 같고 캐시·nosniff·ETag 헤더가 있다',
    async (format) => {
      const input = await sharp(photo).toFormat(format).toBuffer();
      const { versionId, asset } = await createDraftWithPhoto(input, format);
      await post(`/api/versions/${versionId}/publish`).expect(200);
      const saved = await readFile(join(directory, asset.storageKey));

      const response = await getPhoto(asset.id).expect(200);

      expect(Buffer.isBuffer(response.body)).toBe(true);
      expect(response.body).toEqual(saved);
      expect(asset.mime).toBe(`image/${format}`);
      expect(response.headers['content-type']).toBe(asset.mime);
      expect(response.headers['cache-control']).toBe('private, no-cache');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers.etag).toEqual(expect.stringMatching(/^(W\/)?"[^"]+"$/));
    },
  );

  it('같은 ETag는 본문 없는 304지만 멤버 삭제 뒤에는 같은 요청도 404다', async () => {
    const { versionId, asset } = await createDraftWithPhoto();
    await post(`/api/versions/${versionId}/publish`).expect(200);
    const first = await getPhoto(asset.id).expect(200);
    expect(first.headers.etag).toEqual(expect.any(String));

    const cached = await getPhoto(asset.id).set('If-None-Match', first.headers.etag).expect(304);
    expect(cached.text).toBe('');
    expect(cached.headers.etag).toBe(first.headers.etag);
    expect(cached.headers['cache-control']).toBe('private, no-cache');

    await prisma.projectMember.delete({ where: { projectId_userId: { projectId, userId: clientId } } });

    await getPhoto(asset.id).set('If-None-Match', first.headers.etag).expect(404).expect(assetNotFoundBody);
    await getPhoto(asset.id).expect(404).expect(assetNotFoundBody);
    await getPhoto(asset.id, cookie).expect(200);
  });

  it('다른 ETag는 304 대신 저장된 사진 전체를 돌려준다', async () => {
    const { versionId, asset } = await createDraftWithPhoto();
    await post(`/api/versions/${versionId}/publish`).expect(200);
    const saved = await readFile(join(directory, asset.storageKey));

    const response = await getPhoto(asset.id).set('If-None-Match', '"different-photo"').expect(200);

    expect(response.body).toEqual(saved);
  });

  it('개발자는 초안 사진을 받지만 클라이언트는 그 ETag를 알아도 같은 404다', async () => {
    const { asset } = await createDraftWithPhoto();
    const saved = await readFile(join(directory, asset.storageKey));

    const developer = await getPhoto(asset.id, cookie).expect(200);
    expect(developer.body).toEqual(saved);
    expect(developer.headers.etag).toEqual(expect.any(String));
    await getPhoto(asset.id).expect(404).expect(assetNotFoundBody);
    await getPhoto(asset.id).set('If-None-Match', developer.headers.etag).expect(404).expect(assetNotFoundBody);
  });

  it('다른 프로젝트의 개발자여도 멤버가 아닌 사진은 같은 404다', async () => {
    const { versionId, asset } = await createDraftWithPhoto();
    await post(`/api/versions/${versionId}/publish`).expect(200);

    await getPhoto(asset.id, outsiderCookie).expect(404).expect(assetNotFoundBody);
  });

  it('클라이언트에게 남의 프로젝트의 게시 사진도 같은 404다', async () => {
    const { versionId, asset } = await createDraftWithPhoto(photo, 'png', otherProjectId, outsiderCookie);
    await post(`/api/versions/${versionId}/publish`, outsiderCookie).expect(200);

    await getPhoto(asset.id).expect(404).expect(assetNotFoundBody);
  });

  it.each([missingId, 'abc'])('없는 UUID나 틀린 모양 id(%s)는 같은 404다', async (assetId) => {
    await getPhoto(assetId).expect(404).expect(assetNotFoundBody);
  });

  it('2차에서 바꾼 사진은 게시 뒤에만 보이고 1차 사진은 초안·게시 뒤 모두 계속 보인다', async () => {
    const first = await createDraftWithPhoto();
    await post(`/api/versions/${first.versionId}/publish`).expect(200);
    const original = await readFile(join(directory, first.asset.storageKey));
    const second = await post(`/api/projects/${projectId}/versions`).expect(201);
    expect(second.body.screens[0].asset.id).toBe(first.asset.id);
    const copied = await getPhoto(first.asset.id).expect(200);
    expect(copied.body).toEqual(original);

    const replacement = await sharp(photo).resize(16, 12).jpeg().toBuffer();
    const newAsset = await uploadPhoto(second.body.id, first.screenId, replacement, 'jpeg');
    expect(newAsset.id).not.toBe(first.asset.id);
    await getPhoto(newAsset.id).expect(404).expect(assetNotFoundBody);
    const duringDraft = await getPhoto(first.asset.id).expect(200);
    expect(duringDraft.body).toEqual(original);

    await post(`/api/versions/${second.body.id}/publish`).expect(200);

    const current = await getPhoto(newAsset.id).expect(200);
    expect(current.body).toEqual(await readFile(join(directory, newAsset.storageKey)));
    const previous = await getPhoto(first.asset.id).expect(200);
    expect(previous.body).toEqual(original);
  });

  it('2차 초안에서 공유 화면을 빼도 지난 버전의 사진은 계속 보인다', async () => {
    const first = await createDraftWithPhoto();
    await post(`/api/versions/${first.versionId}/publish`).expect(200);
    const saved = await readFile(join(directory, first.asset.storageKey));
    const second = await post(`/api/projects/${projectId}/versions`).expect(201);

    await request(server)
      .delete(`/api/versions/${second.body.id}/screens/${first.screenId}`)
      .set('Origin', origin)
      .set('Cookie', cookie)
      .expect(200);

    const response = await getPhoto(first.asset.id).expect(200);
    expect(response.body).toEqual(saved);
  });

  it('초안 전용 사진을 바꾸면 이전 사진 주소는 개발자에게도 404다', async () => {
    const { versionId, screenId, asset } = await createDraftWithPhoto();
    const replacement = await uploadPhoto(versionId, screenId);
    expect(replacement.id).not.toBe(asset.id);

    await getPhoto(asset.id, cookie).expect(404).expect(assetNotFoundBody);
    await getPhoto(replacement.id, cookie).expect(200);
  });

  it('게시한 화면을 숨겨도 그 버전의 사진은 클라이언트에게 보인다', async () => {
    const { versionId, screenId, asset } = await createDraftWithPhoto();
    await post(`/api/versions/${versionId}/publish`).expect(200);
    await post(`/api/screens/${screenId}/hide`).expect(200);

    const response = await getPhoto(asset.id).expect(200);
    expect(response.body).toEqual(await readFile(join(directory, asset.storageKey)));
  });

  it('승인된 버전의 사진도 클라이언트에게 보인다', async () => {
    const { versionId, asset } = await createDraftWithPhoto();
    await post(`/api/versions/${versionId}/publish`).expect(200);
    // 승인 API는 7번 기능에서 만든다. 게시된 버전의 상태만 승인으로 바꾼다.
    await prisma.deliveryVersion.update({ where: { id: versionId }, data: { status: 'APPROVED' } });

    const response = await getPhoto(asset.id).expect(200);
    expect(response.body).toEqual(await readFile(join(directory, asset.storageKey)));
  });

  it.each(['로그인 안 함', '세션 만료', '24시간 미사용'] as const)(
    '%s이면 같은 ETag를 보내도 304 대신 401이다',
    async (state) => {
      const { versionId, asset } = await createDraftWithPhoto();
      await post(`/api/versions/${versionId}/publish`).expect(200);
      const first = await getPhoto(asset.id).expect(200);
      expect(first.headers.etag).toEqual(expect.any(String));
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

      const pending = request(server).get(`/api/assets/${asset.id}`).set('If-None-Match', first.headers.etag);
      if (state !== '로그인 안 함') pending.set('Cookie', clientCookie);
      await pending.expect(401);
    },
  );

  it.each([
    { label: 'Origin 없음', value: undefined },
    { label: '다른 Origin', value: 'https://other.example' },
  ])('GET은 $label이어도 사진을 받는다', async ({ value }) => {
    const { versionId, asset } = await createDraftWithPhoto();
    await post(`/api/versions/${versionId}/publish`).expect(200);

    const pending = getPhoto(asset.id);
    if (value !== undefined) pending.set('Origin', value);
    const response = await pending.expect(200);
    expect(response.body).toEqual(await readFile(join(directory, asset.storageKey)));
  });

  it('ASSET_DIR 경로에 점으로 시작하는 .assets 폴더가 있어도 사진을 받는다', async () => {
    const hiddenDirectory = join(directory, '.assets');
    vi.stubEnv('ASSET_DIR', hiddenDirectory);
    const { versionId, asset } = await createDraftWithPhoto();
    await post(`/api/versions/${versionId}/publish`).expect(200);
    const saved = await readFile(join(hiddenDirectory, asset.storageKey));

    const response = await getPhoto(asset.id).expect(200);

    expect(response.body).toEqual(saved);
    expect(response.headers['content-type']).toBe(asset.mime);
  });

  it('사진을 받는 도중 연결을 끊어도 서버 오류를 기록하지 않는다', async () => {
    const largePhoto = await sharp(randomBytes(1800 * 1500 * 3), {
      raw: { width: 1800, height: 1500, channels: 3 },
    })
      .png({ compressionLevel: 0 })
      .toBuffer();
    const { asset } = await createDraftWithPhoto(largePhoto);
    await app!.listen(0, '127.0.0.1');
    const url = `${await app!.getUrl()}/api/assets/${asset.id}`;
    const logError = vi.spyOn(Logger.prototype, 'error');

    const firstChunk = await new Promise<{ statusCode: number | undefined; bytes: number }>((resolve) => {
      const req = get(url, { headers: { Cookie: cookie } }, (response) => {
        response.once('data', (chunk: Buffer) => {
          req.destroy();
          resolve({ statusCode: response.statusCode, bytes: chunk.length });
        });
      });
      // 클라이언트가 직접 끊어서 생기는 요청 오류는 무시한다.
      req.on('error', () => {});
    });

    expect(firstChunk.statusCode).toBe(200);
    expect(firstChunk.bytes).toBeGreaterThan(0);
    expect(firstChunk.bytes).toBeLessThan(asset.bytes);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(logError).not.toHaveBeenCalled();
  });

  it('DB에 사진이 있지만 디스크 파일이 없으면 500이고 응답에 경로가 드러나지 않는다', async () => {
    const { versionId, asset } = await createDraftWithPhoto();
    await post(`/api/versions/${versionId}/publish`).expect(200);
    const first = await getPhoto(asset.id).expect(200);
    expect(first.headers.etag).toEqual(expect.any(String));
    await rm(join(directory, asset.storageKey));
    expect(await prisma.asset.findUnique({ where: { id: asset.id } })).toEqual(asset);

    const response = await getPhoto(asset.id).expect(500);

    expect(response.body).toEqual({ statusCode: 500, message: 'Internal server error' });
    expect(response.text).not.toContain(directory);
    expect(response.text).not.toContain(asset.storageKey);
    await getPhoto(asset.id).set('If-None-Match', first.headers.etag).expect(500).expect(response.body);
  });

  it.each([undefined, '', '   '])('ASSET_DIR=%s이면 사진 받기는 500이다', async (value) => {
    const { versionId, asset } = await createDraftWithPhoto();
    await post(`/api/versions/${versionId}/publish`).expect(200);
    vi.stubEnv('ASSET_DIR', value);

    const response = await getPhoto(asset.id).expect(500);

    expect(response.body).toEqual({ statusCode: 500, message: 'Internal server error' });
    expect(response.text).not.toContain(directory);
  });
});
