import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { crc32 } from 'node:zlib';
import { Logger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import sharp from 'sharp';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { deleteAsset } from '../src/assets/asset-storage.js';
import { createSessionToken, hashSessionToken } from '../src/auth/token.js';
import { MailService } from '../src/mail/mail.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { setupApp } from '../src/setup-app.js';
import { resetDatabase } from './reset-database.js';

// 파일 삭제 실패만 주입한다. 나머지는 실제 DB·사진 처리·파일 저장을 지난다.
vi.mock('../src/assets/asset-storage.js', async (importOriginal) => {
  const storage = await importOriginal<typeof import('../src/assets/asset-storage.js')>();
  return { ...storage, deleteAsset: vi.fn(storage.deleteAsset) };
});

const origin = 'http://localhost:5173';
const missingId = '00000000-0000-4000-8000-000000000001';
const quota = 1024 * 1024 * 1024;
const issueNotFoundBody = { statusCode: 404, message: '없는 쪽지예요', error: 'Not Found' };
const assetNotFoundBody = { statusCode: 404, message: '없는 사진이에요', error: 'Not Found' };
const tooManyBody = { statusCode: 409, message: '참고 사진은 3장까지 붙일 수 있어요', code: 'TOO_MANY_ATTACHMENTS' };

describe('참고 사진 API (e2e)', () => {
  let app: INestApplication | undefined;
  let server: Server;
  let prisma: PrismaService;
  let directory: string;
  let projectId: string;
  let versionId: string;
  let versionAssetId: string;
  let issueId: string;
  let authorId: string;
  let authorCookie: string;
  let developerCookie: string;
  let clientCookie: string;
  let outsiderCookie: string;
  let photo: Buffer;

  const login = async (userId: string) => {
    const token = createSessionToken();
    await prisma.session.create({
      data: { userId, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
    });
    return `sid=${token}`;
  };
  const post = (path: string, cookie = authorCookie) =>
    request(server).post(path).set('Origin', origin).set('Cookie', cookie);
  const attach = (cookie = authorCookie, targetIssueId = issueId, data = photo) =>
    post(`/api/issues/${targetIssueId}/attachments`, cookie).attach('file', data, 'reference.png');
  const remove = (attachmentId: string, cookie = authorCookie, targetIssueId = issueId) =>
    request(server)
      .delete(`/api/issues/${targetIssueId}/attachments/${attachmentId}`)
      .set('Origin', origin)
      .set('Cookie', cookie);
  const detail = (targetIssueId = issueId, cookie = authorCookie) =>
    request(server).get(`/api/issues/${targetIssueId}`).set('Cookie', cookie);
  const createIssue = () =>
    post(`/api/projects/${projectId}/issues`)
      .send({ requestId: randomUUID(), versionId, title: '참고 시안', body: '이 사진을 봐 주세요' })
      .expect(201);
  const assetFiles = async () => {
    const entries = await readdir(directory, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => relative(directory, join(entry.parentPath, entry.name)))
      .sort();
  };
  const readState = async () => ({
    issues: await prisma.issue.findMany({ orderBy: { id: 'asc' } }),
    attachments: await prisma.issueAttachment.findMany({ orderBy: { id: 'asc' } }),
    assets: await prisma.asset.findMany({ orderBy: { id: 'asc' } }),
    screens: await prisma.versionScreen.findMany({ orderBy: { id: 'asc' } }),
    events: await prisma.activityEvent.findMany({ orderBy: { id: 'asc' } }),
    files: await Promise.all(
      (await assetFiles()).map(async (key) => ({ key, data: await readFile(join(directory, key)) })),
    ),
  });
  const revokeAuthor = () =>
    prisma.projectMember.updateMany({
      where: { projectId, userId: authorId },
      data: { revokedAt: new Date() },
    });

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'issue-attachments-e2e-'));
    vi.stubEnv('ASSET_DIR', directory);
    vi.stubEnv('APP_ORIGINS', origin);
    vi.stubEnv('COOKIE_SECURE', undefined);
    vi.mocked(deleteAsset).mockReset();
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
    const author = await prisma.user.create({ data: { email: 'author@example.com', name: '쓴 사람' } });
    const client = await prisma.user.create({ data: { email: 'client@example.com', name: '다른 참여자' } });
    const outsider = await prisma.user.create({ data: { email: 'outsider@example.com', name: '외부인' } });
    authorId = author.id;
    const project = await prisma.project.create({
      data: {
        name: '참고 사진 검수',
        members: {
          create: [
            { userId: developer.id, role: 'DEVELOPER' },
            { userId: author.id, role: 'CLIENT' },
            { userId: client.id, role: 'CLIENT' },
          ],
        },
      },
    });
    projectId = project.id;
    developerCookie = await login(developer.id);
    authorCookie = await login(author.id);
    clientCookie = await login(client.id);
    outsiderCookie = await login(outsider.id);
    photo = await sharp({ create: { width: 32, height: 24, channels: 3, background: 'red' } })
      .png()
      .toBuffer();
    const screen = await prisma.screen.create({ data: { projectId, name: '첫 화면', viewport: 'PC' } });
    const draft = await post(`/api/projects/${projectId}/versions`, developerCookie).expect(201);
    versionId = draft.body.id;
    const uploaded = await request(server)
      .put(`/api/versions/${versionId}/screens/${screen.id}/asset`)
      .set('Origin', origin)
      .set('Cookie', developerCookie)
      .attach('file', photo, 'screen.png')
      .expect(200);
    versionAssetId = uploaded.body.screens[0].asset.id;
    await post(`/api/versions/${versionId}/publish`, developerCookie).expect(200);
    issueId = (await createIssue()).body.id;
  });

  afterEach(async () => {
    try {
      await app?.close();
    } finally {
      app = undefined;
      vi.restoreAllMocks();
      vi.mocked(deleteAsset).mockReset();
      vi.unstubAllEnvs();
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  });

  it('쓴 사람이 붙이면 201 쪽지 상세이고 같은 사진을 다시 보내도 각각 붙으며 일지는 늘지 않는다', async () => {
    const before = await detail().expect(200);
    const events = await prisma.activityEvent.findMany();
    const first = await attach().expect(201);
    expect(first.body).toEqual({
      ...before.body,
      attachments: [{ id: expect.any(String), assetId: expect.any(String), width: 32, height: 24 }],
    });
    const second = await attach().expect(201);
    expect(second.body.attachments).toHaveLength(2);
    expect(new Set(second.body.attachments.map((item: { id: string }) => item.id)).size).toBe(2);
    expect(new Set(second.body.attachments.map((item: { assetId: string }) => item.assetId)).size).toBe(2);
    await detail().expect(200).expect(second.body);
    expect(await prisma.issueAttachment.count({ where: { issueId } })).toBe(2);
    expect(await assetFiles()).toHaveLength(3);
    expect(await prisma.activityEvent.findMany()).toEqual(events);
  });

  it('쓴 사람이 아니면 개발자도 403이고 사진·파일이 남지 않는다', async () => {
    const before = await readState();
    for (const cookie of [clientCookie, developerCookie]) {
      await attach(cookie).expect(403).expect({
        statusCode: 403,
        message: '쪽지를 쓴 사람만 할 수 있어요',
        error: 'Forbidden',
      });
      expect(await readState()).toEqual(before);
    }
  });

  it('네 번째 사진은 409 TOO_MANY_ATTACHMENTS이고 파일이 남지 않는다', async () => {
    for (let i = 0; i < 3; i++) await attach().expect(201);
    const before = await readState();
    await attach().expect(409).expect(tooManyBody);
    expect(await readState()).toEqual(before);
  });

  it('동시에 다섯 장을 올려도 세 장만 붙고 나머지 파일은 지워진다', async () => {
    const responses = await Promise.all(Array.from({ length: 5 }, () => attach()));
    expect(responses.map(({ status }) => status).sort((a, b) => a - b)).toEqual([201, 201, 201, 409, 409]);
    for (const response of responses.filter(({ status }) => status === 409)) expect(response.body).toEqual(tooManyBody);
    const attachments = await prisma.issueAttachment.findMany({ where: { issueId } });
    expect(attachments).toHaveLength(3);
    expect((await detail().expect(200)).body.attachments).toHaveLength(3);
    const assets = await prisma.asset.findMany();
    expect(assets).toHaveLength(4);
    expect(await assetFiles()).toEqual(assets.map(({ storageKey }) => storageKey).sort());
  });

  it.each(['멤버 아님', '철회된 작성자', '없는 쪽지', '틀린 id'] as const)(
    '%s는 같은 404이고 사진·첨부·파일이 남지 않는다',
    async (scenario) => {
      if (scenario === '철회된 작성자') await revokeAuthor();
      const targetId = scenario === '없는 쪽지' ? missingId : scenario === '틀린 id' ? 'invalid' : issueId;
      const before = await readState();
      await attach(scenario === '멤버 아님' ? outsiderCookie : authorCookie, targetId)
        .expect(404)
        .expect(issueNotFoundBody);
      expect(await readState()).toEqual(before);
    },
  );

  it('로그인하지 않으면 401이고 다른 Origin이면 403이며 파일이 남지 않는다', async () => {
    const before = await readState();
    await request(server)
      .post(`/api/issues/${issueId}/attachments`)
      .set('Origin', origin)
      .attach('file', photo, 'reference.png')
      .expect(401);
    await attach().set('Origin', 'https://other.example.com').expect(403);
    await attach().unset('Origin').expect(403);
    expect(await readState()).toEqual(before);
  });

  it.each([
    ['가짜 PNG', 415],
    ['움직이는 사진', 415],
    ['20 MiB 초과', 413],
    ['파일 없음', 422],
    ['프로젝트 용량 초과', 413],
  ] as const)('%s는 %i이고 사진·파일이 남지 않는다', async (scenario, status) => {
    let data = photo;
    if (scenario === '가짜 PNG') data = Buffer.from('not an image');
    if (scenario === '20 MiB 초과') data = Buffer.concat([photo, Buffer.alloc(20 * 1024 * 1024 + 1 - photo.length)]);
    if (scenario === '움직이는 사진') {
      const red = Buffer.alloc(16 * 16 * 3, Buffer.from([255, 0, 0]));
      const blue = Buffer.alloc(16 * 16 * 3, Buffer.from([0, 0, 255]));
      data = await sharp(Buffer.concat([red, blue]), { raw: { width: 16, height: 32, channels: 3, pageHeight: 16 } })
        .webp({ delay: [100, 100], loop: 0 })
        .toBuffer();
      expect((await sharp(data, { animated: true }).metadata()).pages).toBe(2);
    }
    if (scenario === '프로젝트 용량 초과') {
      const savedBytes = (await sharp(photo).png().toBuffer()).length;
      await prisma.asset.update({ where: { id: versionAssetId }, data: { bytes: quota - savedBytes + 1 } });
    }
    const before = await readState();
    const pending =
      scenario === '파일 없음'
        ? post(`/api/issues/${issueId}/attachments`).field('description', '없음')
        : attach(authorCookie, issueId, data);
    await pending.expect(status);
    expect(await readState()).toEqual(before);
  });

  it('붙인 사진은 메타데이터가 지워지고 프로젝트 용량에 함께 센다', async () => {
    const input = await sharp(photo)
      .jpeg()
      .withMetadata({ orientation: 6 })
      .withExif({ IFD0: { Artist: 'reference-author', Copyright: 'reference-test' } })
      .withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/">test metadata</x:xmpmeta>')
      .toBuffer();
    expect(await sharp(input).metadata()).toMatchObject({
      exif: expect.any(Buffer),
      icc: expect.any(Buffer),
      xmp: expect.any(Buffer),
      orientation: 6,
    });
    const response = await attach(authorCookie, issueId, input).expect(201);
    const attached = response.body.attachments[0];
    const asset = await prisma.asset.findUniqueOrThrow({ where: { id: attached.assetId } });
    const saved = await readFile(join(directory, asset.storageKey));
    const metadata = await sharp(saved).metadata();
    expect(metadata).toMatchObject({ format: 'jpeg', width: 24, height: 32 });
    for (const key of ['exif', 'icc', 'iptc', 'xmp', 'orientation'] as const) expect(metadata[key]).toBeUndefined();
    expect(asset).toMatchObject({ projectId, mime: 'image/jpeg', bytes: saved.length, width: 24, height: 32 });
    expect(attached).toEqual({ id: expect.any(String), assetId: asset.id, width: 24, height: 32 });
    const versionAsset = await prisma.asset.findUniqueOrThrow({ where: { id: versionAssetId } });
    expect((await prisma.asset.aggregate({ where: { projectId }, _sum: { bytes: true } }))._sum.bytes).toBe(
      versionAsset.bytes + saved.length,
    );
    const nextBytes = (await sharp(photo).png().toBuffer()).length;
    await prisma.asset.update({ where: { id: versionAssetId }, data: { bytes: quota - saved.length - nextBytes } });
    await attach().expect(201);
    expect((await prisma.asset.aggregate({ where: { projectId }, _sum: { bytes: true } }))._sum.bytes).toBe(quota);
    const draft = await post(`/api/projects/${projectId}/versions`, developerCookie).expect(201);
    const screen = await prisma.screen.create({ data: { projectId, name: '용량 검사 화면', viewport: 'PC' } });
    const before = await readState();
    await attach().expect(413);
    // 버전 사진을 올리는 경로도 참고 사진의 바이트를 반드시 합산한다.
    await request(server)
      .put(`/api/versions/${draft.body.id}/screens/${screen.id}/asset`)
      .set('Origin', origin)
      .set('Cookie', developerCookie)
      .attach('file', photo, 'screen.png')
      .expect(413);
    expect(await readState()).toEqual(before);
  });

  it('버전 사진과 참고 사진을 동시에 올려도 프로젝트 용량을 함께 지킨다', async () => {
    const bytes = (await sharp(photo).png().toBuffer()).length;
    await prisma.asset.update({ where: { id: versionAssetId }, data: { bytes: quota - bytes } });
    const draft = await post(`/api/projects/${projectId}/versions`, developerCookie).expect(201);
    const screen = await prisma.screen.create({ data: { projectId, name: '추가 화면', viewport: 'MOBILE' } });
    const responses = await Promise.all([
      attach(),
      request(server)
        .put(`/api/versions/${draft.body.id}/screens/${screen.id}/asset`)
        .set('Origin', origin)
        .set('Cookie', developerCookie)
        .attach('file', photo, 'screen.png'),
    ]);
    expect(responses.filter(({ status }) => status === 413)).toHaveLength(1);
    expect([200, 201]).toContain(responses.find(({ status }) => status !== 413)?.status);
    const assets = await prisma.asset.findMany();
    expect(assets).toHaveLength(2);
    expect(assets.reduce((sum, asset) => sum + asset.bytes, 0)).toBe(quota);
    expect(await assetFiles()).toEqual(assets.map(({ storageKey }) => storageKey).sort());
    expect(await prisma.issueAttachment.count()).toBe(responses[0].status === 201 ? 1 : 0);
    expect(await prisma.versionScreen.count({ where: { versionId: draft.body.id, screenId: screen.id } })).toBe(
      responses[1].status === 200 ? 1 : 0,
    );
  });

  it('DB 저장이 실패하면 새 파일이 지워지고 쪽지의 사진은 그대로다', async () => {
    await attach().expect(201);
    const before = await readState();
    try {
      await prisma.$executeRaw`CREATE FUNCTION attachments_e2e_fail_insert() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'attachment insert failure'; END; $$`;
      await prisma.$executeRaw`CREATE TRIGGER attachments_e2e_fail_insert BEFORE INSERT ON issue_attachments
        FOR EACH ROW EXECUTE FUNCTION attachments_e2e_fail_insert()`;
      await attach().expect(500);
      expect(await readState()).toEqual(before);
    } finally {
      await prisma.$executeRaw`DROP TRIGGER IF EXISTS attachments_e2e_fail_insert ON issue_attachments`;
      await prisma.$executeRaw`DROP FUNCTION IF EXISTS attachments_e2e_fail_insert()`;
    }
  });

  it('쓴 사람이 지우면 200이고 사진 주소는 404이며 파일이 없고 다시 세 장까지 붙일 수 있다', async () => {
    for (let i = 0; i < 3; i++) await attach().expect(201);
    const before = await detail().expect(200);
    const [target, ...remaining] = before.body.attachments;
    const asset = await prisma.asset.findUniqueOrThrow({ where: { id: target.assetId } });
    const events = await prisma.activityEvent.findMany();
    // 용량도 가득 채워 두어 지운 사진의 자리와 바이트가 실제로 돌아오는지 확인한다.
    const referenceBytes = (
      await prisma.asset.aggregate({ where: { id: { not: versionAssetId } }, _sum: { bytes: true } })
    )._sum.bytes!;
    await prisma.asset.update({ where: { id: versionAssetId }, data: { bytes: quota - referenceBytes } });
    await request(server).get(`/api/assets/${asset.id}`).set('Cookie', developerCookie).expect(200);
    await remove(target.id)
      .expect(200)
      .expect({ ...before.body, attachments: remaining });
    await detail()
      .expect(200)
      .expect({ ...before.body, attachments: remaining });
    await request(server)
      .get(`/api/assets/${asset.id}`)
      .set('Cookie', developerCookie)
      .expect(404)
      .expect(assetNotFoundBody);
    await expect(readFile(join(directory, asset.storageKey))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await prisma.asset.findUnique({ where: { id: asset.id } })).toBeNull();
    expect(await prisma.issueAttachment.findUnique({ where: { id: target.id } })).toBeNull();
    expect((await prisma.asset.aggregate({ where: { projectId }, _sum: { bytes: true } }))._sum.bytes).toBe(
      quota - asset.bytes,
    );
    const replacement = await attach().expect(201);
    expect(replacement.body.attachments).toHaveLength(3);
    expect(replacement.body.attachments).toEqual(expect.arrayContaining(remaining));
    expect((await prisma.asset.aggregate({ where: { projectId }, _sum: { bytes: true } }))._sum.bytes).toBe(quota);
    await attach().expect(409).expect(tooManyBody);
    const assets = await prisma.asset.findMany();
    expect(await assetFiles()).toEqual(assets.map(({ storageKey }) => storageKey).sort());
    expect(await prisma.activityEvent.findMany()).toEqual(events);
  });

  it.each([
    ['쓴 사람 아님', 403],
    ['개발자', 403],
    ['멤버 아님', 404],
    ['철회된 작성자', 404],
    ['로그인 안 함', 401],
    ['다른 Origin', 403],
  ] as const)('지우기는 %s이면 %i이고 사진·파일이 그대로다', async (scenario, status) => {
    const uploaded = await attach().expect(201);
    if (scenario === '철회된 작성자') await revokeAuthor();
    const before = await readState();
    const cookie = {
      '쓴 사람 아님': clientCookie,
      개발자: developerCookie,
      '멤버 아님': outsiderCookie,
      '철회된 작성자': authorCookie,
      '로그인 안 함': authorCookie,
      '다른 Origin': authorCookie,
    }[scenario];
    const pending = remove(uploaded.body.attachments[0].id, cookie);
    if (scenario === '로그인 안 함') pending.unset('Cookie');
    if (scenario === '다른 Origin') pending.set('Origin', 'https://other.example.com');
    const response = await pending.expect(status);
    if (status === 404) expect(response.body).toEqual(issueNotFoundBody);
    expect(await readState()).toEqual(before);
  });

  it.each(['다른 쪽지의 사진 id', '없는 id', '틀린 모양 id', '버전 화면의 Asset id'] as const)(
    '지우기 대상이 %s이면 404이고 어떤 사진·파일도 지워지지 않는다',
    async (scenario) => {
      await attach().expect(201);
      const other = await createIssue();
      const otherPhoto = await attach(authorCookie, other.body.id).expect(201);
      const target = {
        '다른 쪽지의 사진 id': otherPhoto.body.attachments[0].id,
        '없는 id': missingId,
        '틀린 모양 id': 'invalid',
        '버전 화면의 Asset id': versionAssetId,
      }[scenario];
      const before = await readState();
      await remove(target).expect(404).expect(assetNotFoundBody);
      expect(await readState()).toEqual(before);
    },
  );

  it.each([missingId, 'invalid'])('없는 쪽지 %s로 지워도 같은 404이고 사진·파일이 그대로다', async (targetId) => {
    const uploaded = await attach().expect(201);
    const before = await readState();
    await remove(uploaded.body.attachments[0].id, authorCookie, targetId).expect(404).expect(issueNotFoundBody);
    expect(await readState()).toEqual(before);
  });

  it('동시에 두 번 지우면 200과 404이고 남은 사진은 그대로다', async () => {
    await attach().expect(201);
    const uploaded = await attach().expect(201);
    const [target, remaining] = uploaded.body.attachments;
    const before = await readState();
    const targetAsset = before.assets.find(({ id }) => id === target.assetId)!;
    const responses = await Promise.all([remove(target.id), remove(target.id)]);
    expect(responses.map(({ status }) => status).sort((a, b) => a - b)).toEqual([200, 404]);
    expect(responses.find(({ status }) => status === 404)?.body).toEqual(assetNotFoundBody);
    expect(responses.find(({ status }) => status === 200)?.body).toEqual({
      ...uploaded.body,
      attachments: [remaining],
    });
    expect(await readState()).toEqual({
      ...before,
      attachments: before.attachments.filter(({ id }) => id !== target.id),
      assets: before.assets.filter(({ id }) => id !== target.assetId),
      files: before.files.filter(({ key }) => key !== targetAsset.storageKey),
    });
    await remove(target.id).expect(404).expect(assetNotFoundBody);
  });

  it('현재 버전이 승인된 뒤 지우기는 409 VERSION_NOT_IN_REVIEW이고 사진이 그대로다', async () => {
    const uploaded = await attach().expect(201);
    await prisma.deliveryVersion.update({ where: { id: versionId }, data: { status: 'APPROVED' } });
    const before = await readState();
    await remove(uploaded.body.attachments[0].id).expect(409).expect({
      statusCode: 409,
      message: '검수 중인 버전이 아니에요',
      code: 'VERSION_NOT_IN_REVIEW',
    });
    expect(await readState()).toEqual(before);
  });

  it('지우기의 DB 저장이 실패하면 사진과 파일이 그대로다', async () => {
    const uploaded = await attach().expect(201);
    const before = await readState();
    try {
      await prisma.$executeRaw`CREATE FUNCTION attachments_e2e_fail_delete() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'attachment delete failure'; END; $$`;
      // 첨부 삭제 다음의 Asset 삭제를 실패시켜 먼저 지운 첨부 줄도 돌아오는지 본다.
      await prisma.$executeRaw`CREATE TRIGGER attachments_e2e_fail_delete BEFORE DELETE ON assets
        FOR EACH ROW EXECUTE FUNCTION attachments_e2e_fail_delete()`;
      await remove(uploaded.body.attachments[0].id).expect(500);
      expect(await readState()).toEqual(before);
      expect(deleteAsset).not.toHaveBeenCalled();
    } finally {
      await prisma.$executeRaw`DROP TRIGGER IF EXISTS attachments_e2e_fail_delete ON assets`;
      await prisma.$executeRaw`DROP FUNCTION IF EXISTS attachments_e2e_fail_delete()`;
    }
  });

  it('파일 지우기가 실패해도 200이고 첨부·사진 줄은 없다', async () => {
    const uploaded = await attach().expect(201);
    const target = uploaded.body.attachments[0];
    const asset = await prisma.asset.findUniqueOrThrow({ where: { id: target.assetId } });
    const before = await readState();
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    vi.mocked(deleteAsset).mockRejectedValueOnce(new Error('파일 삭제 실패'));
    await remove(target.id)
      .expect(200)
      .expect({ ...uploaded.body, attachments: [] });
    expect(deleteAsset).toHaveBeenCalledWith(asset.storageKey);
    expect(await readState()).toEqual({
      ...before,
      attachments: [],
      assets: before.assets.filter(({ id }) => id !== asset.id),
    });
    await detail()
      .expect(200)
      .expect({ ...uploaded.body, attachments: [] });
    await request(server)
      .get(`/api/assets/${asset.id}`)
      .set('Cookie', developerCookie)
      .expect(404)
      .expect(assetNotFoundBody);
  });

  it.each(['파일 두 개', '다른 칸 이름'] as const)('%s는 400이고 사진·파일이 남지 않는다', async (scenario) => {
    const before = await readState();
    const pending = post(`/api/issues/${issueId}/attachments`);
    if (scenario === '파일 두 개') pending.attach('file', photo, 'one.png').attach('file', photo, 'two.png');
    if (scenario === '다른 칸 이름') pending.attach('photo', photo, 'one.png');
    await pending.expect(400);
    expect(await readState()).toEqual(before);
  });

  it('20 MiB 사진은 받아서 다시 저장한 크기만 용량에 센다', async () => {
    const data = Buffer.concat([photo, Buffer.alloc(20 * 1024 * 1024 - photo.length)]);
    const response = await attach(authorCookie, issueId, data).expect(201);
    const asset = await prisma.asset.findUniqueOrThrow({ where: { id: response.body.attachments[0].assetId } });
    const saved = await readFile(join(directory, asset.storageKey));
    expect(asset.bytes).toBe(saved.length);
    expect(saved.length).toBeLessThan(data.length);
    expect(await sharp(saved).metadata()).toMatchObject({ width: 32, height: 24, format: 'png' });
  });

  it('PNG 움직임 정보와 20000px 초과 사진도 거절하고 파일이 남지 않는다', async () => {
    const chunk = Buffer.alloc(20);
    chunk.writeUInt32BE(8, 0);
    chunk.write('acTL', 4, 4, 'ascii');
    chunk.writeUInt32BE(2, 8);
    chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), 16);
    const afterHeader = 8 + 12 + photo.readUInt32BE(8);
    const animated = Buffer.concat([photo.subarray(0, afterHeader), chunk, photo.subarray(afterHeader)]);
    const oversized = await sharp({ create: { width: 20001, height: 1, channels: 3, background: 'red' } })
      .png()
      .toBuffer();
    const before = await readState();
    await attach(authorCookie, issueId, animated).expect(415);
    await attach(authorCookie, issueId, oversized).expect(413);
    expect(await readState()).toEqual(before);
  });
});
