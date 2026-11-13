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

describe('승인 API (e2e)', () => {
  let app: INestApplication | undefined;
  let server: Server;
  let prisma: PrismaService;
  let projectId: string;
  let developerCookie: string;
  let firstClient: { id: string; name: string; memberId: string; cookie: string };
  let secondClient: { id: string; name: string; memberId: string; cookie: string };

  const login = async (userId: string) => {
    const token = createSessionToken();
    await prisma.session.create({
      data: { userId, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
    });
    return `sid=${token}`;
  };

  const getProject = (cookie: string, targetProjectId = projectId) =>
    request(server).get(`/api/projects/${targetProjectId}`).set('Cookie', cookie);

  const setApprover = (memberId: string | null, targetProjectId = projectId) =>
    request(server)
      .post(`/api/projects/${targetProjectId}/approver`)
      .set('Origin', origin)
      .set('Cookie', developerCookie)
      .send({ memberId });

  beforeEach(async () => {
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
    const firstUser = await prisma.user.create({ data: { email: 'first@example.com', name: '첫 클라이언트' } });
    const secondUser = await prisma.user.create({ data: { email: 'second@example.com', name: '둘째 클라이언트' } });
    const project = await prisma.project.create({
      data: { name: '승인 검수 프로젝트', members: { create: { userId: developer.id, role: 'DEVELOPER' } } },
    });
    projectId = project.id;
    const firstMember = await prisma.projectMember.create({
      data: { projectId, userId: firstUser.id, role: 'CLIENT' },
    });
    const secondMember = await prisma.projectMember.create({
      data: { projectId, userId: secondUser.id, role: 'CLIENT' },
    });
    developerCookie = await login(developer.id);
    firstClient = {
      id: firstUser.id,
      name: firstUser.name,
      memberId: firstMember.id,
      cookie: await login(firstUser.id),
    };
    secondClient = {
      id: secondUser.id,
      name: secondUser.name,
      memberId: secondMember.id,
      cookie: await login(secondUser.id),
    };
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

  it('프로젝트 상세의 isApprover는 승인자에게만 참이다', async () => {
    const developer = await prisma.projectMember.findFirstOrThrow({ where: { projectId, role: 'DEVELOPER' } });
    const otherProject = await prisma.project.create({
      data: { name: '다른 프로젝트', members: { create: { userId: developer.userId, role: 'DEVELOPER' } } },
    });
    const otherApprover = await prisma.projectMember.create({
      data: { projectId: otherProject.id, userId: secondClient.id, role: 'CLIENT' },
    });
    await setApprover(otherApprover.id, otherProject.id).expect(200);

    // 승인자가 없는 때, 지정한 뒤, 교체한 뒤, 해제한 뒤를 각각 조회한다.
    for (const approver of [null, firstClient, secondClient, null]) {
      await setApprover(approver?.memberId ?? null).expect(200);
      for (const viewer of [
        { cookie: developerCookie, role: 'DEVELOPER', memberId: developer.id },
        { ...firstClient, role: 'CLIENT' },
        { ...secondClient, role: 'CLIENT' },
      ]) {
        await getProject(viewer.cookie)
          .expect(200)
          .expect({
            id: projectId,
            name: '승인 검수 프로젝트',
            myRole: viewer.role,
            currentVersion: null,
            approver: approver ? { memberId: approver.memberId, name: approver.name } : null,
            isApprover: approver !== null && viewer.memberId === approver.memberId,
          });
      }

      const otherDetail = await getProject(secondClient.cookie, otherProject.id).expect(200);
      expect(otherDetail.body.isApprover).toBe(true);
      expect(otherDetail.body.approver).toEqual({ memberId: otherApprover.id, name: secondClient.name });
    }
  });

  it('승인자의 접근을 철회하면 프로젝트 상세는 404이고 남은 멤버의 isApprover는 거짓이다', async () => {
    await setApprover(firstClient.memberId).expect(200);
    const before = await getProject(firstClient.cookie).expect(200);
    expect(before.body.isApprover).toBe(true);

    await request(server)
      .post(`/api/members/${firstClient.memberId}/revoke`)
      .set('Origin', origin)
      .set('Cookie', developerCookie)
      .expect(204);

    await getProject(firstClient.cookie).expect(404).expect({
      statusCode: 404,
      message: '없는 프로젝트예요',
      error: 'Not Found',
    });
    for (const cookie of [developerCookie, secondClient.cookie]) {
      const detail = await getProject(cookie).expect(200);
      expect(detail.body.approver).toBeNull();
      expect(detail.body.isApprover).toBe(false);
    }
  });
});
