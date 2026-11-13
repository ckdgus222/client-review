import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { createSessionToken, hashSessionToken } from '../src/auth/token.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import { MailService } from '../src/mail/mail.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { setupApp } from '../src/setup-app.js';
import { resetDatabase } from './reset-database.js';

const origin = 'http://localhost:5173';
const missingId = '00000000-0000-4000-8000-000000000001';
const publishedAt = new Date('2026-01-01T00:00:00.000Z');
const notFound = { statusCode: 404, message: '없는 확인서예요', error: 'Not Found' };

describe('검수 확인서 API (e2e)', () => {
  let app: INestApplication | undefined;
  let server: Server;
  let prisma: PrismaService;
  let directory: string;
  let projectId: string;
  let versionId: string;
  let developerCookie: string;
  let firstClient: { id: string; memberId: string; cookie: string };
  let secondClient: { id: string; memberId: string; cookie: string };

  const post = (path: string, cookie = firstClient.cookie) =>
    request(server).post(path).set('Origin', origin).set('Cookie', cookie);
  const certificate = (cookie = firstClient.cookie, targetVersionId = versionId) =>
    request(server).get(`/api/versions/${targetVersionId}/certificate`).set('Cookie', cookie);
  const login = async (userId: string) => {
    const token = createSessionToken();
    await prisma.session.create({
      data: { userId, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
    });
    return `sid=${token}`;
  };
  const createIssue = async (changes: Partial<Prisma.IssueUncheckedCreateInput> = {}) => {
    const { _max } = await prisma.issue.aggregate({ where: { projectId }, _max: { number: true } });
    return prisma.issue.create({
      data: {
        projectId,
        originVersionId: versionId,
        authorId: firstClient.id,
        number: (_max.number ?? 0) + 1,
        requestId: randomUUID(),
        title: '버튼 색 수정',
        body: '버튼을 파란색으로 바꿔 주세요',
        category: 'BUG',
        scope: 'IN_SCOPE',
        status: 'VERIFIED',
        ...changes,
      },
    });
  };
  const approve = async () => {
    const review = await request(server)
      .get(`/api/versions/${versionId}/approval-check`)
      .set('Cookie', firstClient.cookie)
      .expect(200);
    await post(`/api/versions/${versionId}/approve`).send({ seenAt: review.body.serverTime }).expect(200);
    return prisma.approval.findUniqueOrThrow({ where: { versionId } });
  };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'certificate-e2e-'));
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

    const developer = await prisma.user.create({ data: { email: 'developer@example.com', name: '김개발' } });
    const firstUser = await prisma.user.create({ data: { email: 'first@example.com', name: '홍승인' } });
    const secondUser = await prisma.user.create({ data: { email: 'second@example.com', name: '이클라이언트' } });
    const project = await prisma.project.create({
      data: { name: '쇼핑몰 리뉴얼', members: { create: { userId: developer.id, role: 'DEVELOPER' } } },
    });
    projectId = project.id;
    const firstMember = await prisma.projectMember.create({
      data: { projectId, userId: firstUser.id, role: 'CLIENT' },
    });
    const secondMember = await prisma.projectMember.create({
      data: { projectId, userId: secondUser.id, role: 'CLIENT' },
    });
    developerCookie = await login(developer.id);
    firstClient = { id: firstUser.id, memberId: firstMember.id, cookie: await login(firstUser.id) };
    secondClient = { id: secondUser.id, memberId: secondMember.id, cookie: await login(secondUser.id) };
    const version = await prisma.deliveryVersion.create({
      data: { projectId, number: 1, status: 'IN_REVIEW', publishedAt },
    });
    versionId = version.id;
    await prisma.project.update({
      where: { id: projectId },
      data: { currentVersionId: versionId, approverMemberId: firstClient.memberId },
    });
    const firstScreen = await prisma.screen.create({
      data: { projectId, name: '홈', viewport: 'PC', createdAt: new Date('2025-12-01T00:00:00Z') },
    });
    const secondScreen = await prisma.screen.create({
      data: { projectId, name: '결제', viewport: 'MOBILE', createdAt: new Date('2025-12-02T00:00:00Z') },
    });
    const asset = await prisma.asset.create({
      data: {
        projectId,
        storageKey: `${projectId}/screen.png`,
        mime: 'image/png',
        bytes: 100,
        width: 1200,
        height: 800,
      },
    });
    // 이름 순서와 버전에 붙인 순서가 화면을 만든 순서와 다르게 준비한다.
    await prisma.versionScreen.create({
      data: { versionId, screenId: secondScreen.id, assetId: asset.id, createdAt: new Date('2025-12-03T00:00:00Z') },
    });
    await prisma.versionScreen.create({
      data: { versionId, screenId: firstScreen.id, assetId: asset.id, createdAt: new Date('2025-12-04T00:00:00Z') },
    });
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

  it('검수 중인 버전의 확인서는 404다', async () => {
    for (const cookie of [developerCookie, firstClient.cookie, secondClient.cookie]) {
      await certificate(cookie).expect(404).expect(notFound);
    }
  });

  it('게시 전 버전의 확인서는 개발자에게도 404다', async () => {
    const draft = await post(`/api/projects/${projectId}/versions`, developerCookie).expect(201);
    for (const cookie of [developerCookie, firstClient.cookie, secondClient.cookie]) {
      await certificate(cookie, draft.body.id).expect(404).expect(notFound);
    }
  });

  it('멤버가 아닌 사람에게는 404다', async () => {
    const outsider = await prisma.user.create({ data: { email: 'outsider@example.com', name: '외부인' } });
    const cookie = await login(outsider.id);
    const draft = await post(`/api/projects/${projectId}/versions`, developerCookie).expect(201);
    await certificate(cookie, draft.body.id).expect(404).expect(notFound);
    await certificate(cookie).expect(404).expect(notFound);
    await approve();
    await certificate(cookie).expect(404).expect(notFound);
  });

  it('접근이 철회된 클라이언트에게는 404다', async () => {
    await approve();
    await certificate(secondClient.cookie).expect(200);
    await post(`/api/members/${secondClient.memberId}/revoke`, developerCookie).expect(204);
    await certificate(secondClient.cookie).expect(404).expect(notFound);
  });

  it('로그인하지 않으면 401이다', async () => {
    await approve();
    for (const id of [versionId, missingId, 'not-a-uuid']) {
      await request(server).get(`/api/versions/${id}/certificate`).expect(401);
    }
  });

  it('개발자, 승인자, 다른 클라이언트 모두 같은 확인서를 받는다', async () => {
    await createIssue();
    const approval = await approve();
    const expected = {
      certificateNumber: approval.id,
      project: { id: projectId, name: '쇼핑몰 리뉴얼' },
      version: { id: versionId, number: 1, publishedAt: publishedAt.toISOString() },
      approval: { approverName: '홍승인', approvedAt: approval.approvedAt.toISOString() },
      developerName: '김개발',
      screens: [
        { name: '홈', viewport: 'PC' },
        { name: '결제', viewport: 'MOBILE' },
      ],
      counts: { verified: 1, withdrawn: 0, outOfScope: 0 },
      issues: [{ number: 1, title: '버튼 색 수정', category: 'BUG', scope: 'IN_SCOPE', status: 'VERIFIED' }],
    };
    for (const cookie of [developerCookie, firstClient.cookie, secondClient.cookie]) {
      const response = await certificate(cookie).expect(200);
      expect(response.body).toEqual(expected);
    }
    expect(await prisma.approval.findUniqueOrThrow({ where: { versionId } })).toEqual(approval);
  });

  it('승인 뒤 다음 버전에서 쪽지를 다시 열고 범위를 바꿔도 확인서의 쪽지 목록과 수는 그대로다', async () => {
    const old = await prisma.deliveryVersion.create({
      data: { projectId, number: 0, status: 'IN_REVIEW', publishedAt: new Date('2025-12-01T00:00:00Z') },
    });
    await createIssue({ number: 3, title: '추가 문구', category: 'COPY', scope: 'OUT_OF_SCOPE', status: 'OPEN' });
    const completed = await createIssue({ number: 1, originVersionId: old.id });
    await createIssue({ number: 2, title: '철회한 디자인', category: 'DESIGN', status: 'WITHDRAWN' });
    await approve();
    const before = await certificate().expect(200);
    const expectedIssues = [
      { number: 1, title: '버튼 색 수정', category: 'BUG', scope: 'IN_SCOPE', status: 'VERIFIED' },
      { number: 2, title: '철회한 디자인', category: 'DESIGN', scope: 'IN_SCOPE', status: 'WITHDRAWN' },
      { number: 3, title: '추가 문구', category: 'COPY', scope: 'OUT_OF_SCOPE', status: 'OPEN' },
    ];
    expect(before.body.issues).toEqual(expectedIssues);
    expect(before.body.counts).toEqual({ verified: 1, withdrawn: 1, outOfScope: 1 });

    const draft = await post(`/api/projects/${projectId}/versions`, developerCookie).expect(201);
    await post(`/api/versions/${draft.body.id}/publish`, developerCookie).expect(200);
    const reopened = await post(`/api/issues/${completed.id}/reopen`)
      .send({ versionId: draft.body.id, reason: '다음 버전에서 다시 확인해요' })
      .expect(200);
    expect(reopened.body.status).toBe('OPEN');
    const updated = await request(server)
      .patch(`/api/issues/${completed.id}`)
      .set('Origin', origin)
      .set('Cookie', developerCookie)
      .send({ versionId: draft.body.id, scope: 'OUT_OF_SCOPE', category: 'OTHER' })
      .expect(200);
    expect(updated.body).toMatchObject({ status: 'OPEN', scope: 'OUT_OF_SCOPE', category: 'OTHER' });
    // 제목 변경 API는 없으므로 현재 제목이 달라진 상황만 DB로 준비한다.
    await prisma.issue.update({ where: { id: completed.id }, data: { title: '다음 버전의 제목' } });
    await post(`/api/projects/${projectId}/issues`)
      .send({ requestId: randomUUID(), versionId: draft.body.id, title: '새 쪽지', body: '다음 차수 요청이에요' })
      .expect(201);

    for (const cookie of [developerCookie, firstClient.cookie, secondClient.cookie]) {
      const after = await certificate(cookie).expect(200);
      expect(after.body).toEqual(before.body);
      expect(after.body.issues).toEqual(expectedIssues);
      expect(after.body.counts).toEqual({ verified: 1, withdrawn: 1, outOfScope: 1 });
    }
  });

  it('쪽지 수는 범위 안의 확인 완료와 철회, 범위 밖을 따로 센다', async () => {
    await createIssue();
    await createIssue();
    await createIssue({ status: 'WITHDRAWN' });
    const statuses = ['OPEN', 'IN_PROGRESS', 'READY_FOR_REVIEW', 'VERIFIED', 'WITHDRAWN'] as const;
    for (const status of statuses) {
      await createIssue({ scope: 'OUT_OF_SCOPE', status });
    }
    await approve();
    const response = await certificate().expect(200);
    expect(response.body.counts).toEqual({ verified: 2, withdrawn: 1, outOfScope: 5 });
    expect(response.body.issues).toHaveLength(8);
    expect(response.body.counts.verified + response.body.counts.withdrawn + response.body.counts.outOfScope).toBe(
      response.body.issues.length,
    );
    expect(response.body.issues.slice(3)).toEqual(
      statuses.map((status, index) => ({
        number: index + 4,
        title: '버튼 색 수정',
        category: 'BUG',
        scope: 'OUT_OF_SCOPE',
        status,
      })),
    );
  });

  it('쪽지 없이 승인된 버전은 수가 모두 0이고 목록이 비어 있다', async () => {
    const approval = await approve();
    const response = await certificate().expect(200);
    expect(response.body.certificateNumber).toBe(approval.id);
    expect(response.body.counts).toEqual({ verified: 0, withdrawn: 0, outOfScope: 0 });
    expect(response.body.issues).toEqual([]);
  });

  it('다른 프로젝트의 멤버는 그 프로젝트의 확인서를 못 본다', async () => {
    await approve();
    const outsider = await prisma.user.create({ data: { email: 'outsider@example.com', name: '다른 개발자' } });
    const otherProject = await prisma.project.create({
      data: {
        name: '다른 프로젝트',
        members: {
          create: [
            { userId: outsider.id, role: 'DEVELOPER' },
            { userId: firstClient.id, role: 'CLIENT' },
          ],
        },
      },
    });
    const cookie = await login(outsider.id);
    await request(server).get(`/api/projects/${otherProject.id}`).set('Cookie', cookie).expect(200);
    await certificate(cookie).expect(404).expect(notFound);
  });

  it('없는 버전과 UUID가 아닌 id는 404다', async () => {
    await approve();
    for (const id of [missingId, 'not-a-uuid', versionId.slice(0, -1), 'gggggggg-gggg-4ggg-8ggg-gggggggggggg']) {
      await certificate(developerCookie, id).expect(404).expect(notFound);
    }
  });

  it('대문자 UUID로도 확인서를 받는다', async () => {
    await approve();
    const lowercase = await certificate().expect(200);
    const uppercase = await certificate(firstClient.cookie, versionId.toUpperCase()).expect(200);
    expect(uppercase.body).toEqual(lowercase.body);
    expect(uppercase.body.version.id).toBe(versionId);
  });

  it('승인자가 그 뒤 철회돼도 확인서에 승인자 이름이 남는다', async () => {
    const approval = await approve();
    const before = await certificate().expect(200);
    await post(`/api/members/${firstClient.memberId}/revoke`, developerCookie).expect(204);
    for (const cookie of [developerCookie, secondClient.cookie]) {
      const response = await certificate(cookie).expect(200);
      expect(response.body).toEqual(before.body);
      expect(response.body.approval).toEqual({ approverName: '홍승인', approvedAt: approval.approvedAt.toISOString() });
    }
    await certificate(firstClient.cookie).expect(404).expect(notFound);
  });

  it('응답에는 정해진 칸만 있고 이메일과 사진 주소가 없다', async () => {
    const issue = await createIssue({ dueDate: new Date('2027-01-01T00:00:00Z') });
    await post(`/api/issues/${issue.id}/comments`, developerCookie)
      .send({ requestId: randomUUID(), versionId, body: '확인서에 넣지 않는 댓글' })
      .expect(201);
    const approval = await approve();
    const response = await certificate().expect(200);
    expect(response.body).toEqual({
      certificateNumber: approval.id,
      project: { id: projectId, name: '쇼핑몰 리뉴얼' },
      version: { id: versionId, number: 1, publishedAt: publishedAt.toISOString() },
      approval: { approverName: '홍승인', approvedAt: approval.approvedAt.toISOString() },
      developerName: '김개발',
      screens: [
        { name: '홈', viewport: 'PC' },
        { name: '결제', viewport: 'MOBILE' },
      ],
      counts: { verified: 1, withdrawn: 0, outOfScope: 0 },
      issues: [{ number: 1, title: '버튼 색 수정', category: 'BUG', scope: 'IN_SCOPE', status: 'VERIFIED' }],
    });
  });

  it('화면 목록은 검수실의 버전 상세와 같은 순서로 나온다', async () => {
    await approve();
    const detail = await request(server).get(`/api/versions/${versionId}`).set('Cookie', developerCookie).expect(200);
    const response = await certificate().expect(200);
    const expected = [
      { name: '홈', viewport: 'PC' },
      { name: '결제', viewport: 'MOBILE' },
    ];
    expect(
      detail.body.screens.map(({ name, viewport }: { name: string; viewport: string }) => ({ name, viewport })),
    ).toEqual(expected);
    expect(response.body.screens).toEqual(expected);
  });

  it('번호가 0인 초안도 승인하면 확인서를 받는다', async () => {
    await prisma.deliveryVersion.update({ where: { id: versionId }, data: { number: 0 } });
    const approval = await approve();
    const response = await certificate().expect(200);
    expect(response.body.certificateNumber).toBe(approval.id);
    expect(response.body.version).toEqual({ id: versionId, number: 0, publishedAt: publishedAt.toISOString() });
  });

  it('세션이 끝난 뒤 확인서를 요청하면 401이다', async () => {
    await approve();
    await certificate().expect(200);
    await prisma.session.updateMany({ where: { userId: firstClient.id }, data: { expiresAt: new Date(0) } });
    await certificate().expect(401);
  });
});
