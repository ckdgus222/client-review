import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import bcrypt from 'bcrypt';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { createSessionToken, hashSessionToken } from '../src/auth/token.js';
import { MailService } from '../src/mail/mail.service.js';
import { NotificationsService } from '../src/notifications/notifications.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { withdrawUser } from '../src/scripts/withdraw-user.js';
import { setupApp } from '../src/setup-app.js';
import { resetDatabase } from './reset-database.js';

const origin = 'http://localhost:5173';
const developerEmail = 'developer@example.com';
const email = 'withdraw@example.com';
const otherEmail = 'other@example.com';
const name = '탈퇴 요청자';

describe('탈퇴 처리 (e2e)', () => {
  let app: INestApplication | undefined;
  let server: Server;
  let prisma: PrismaService;
  let directory: string;
  let developerId: string;
  let userId: string;
  let otherId: string;
  let projectId: string;
  let versionId: string;
  let issueId: string;
  let memberId: string;
  let developerCookie: string;
  let cookies: string[];
  const sendLoginCode = vi.fn<MailService['sendLoginCode']>();
  const send = vi.fn<MailService['send']>();

  const login = async (id: string) => {
    const token = createSessionToken();
    await prisma.session.create({
      data: { userId: id, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 3_600_000) },
    });
    return `sid=${token}`;
  };
  const get = (path: string, cookie = developerCookie) => request(server).get(path).set('Cookie', cookie);
  const post = (path: string, cookie = developerCookie) =>
    request(server).post(path).set('Origin', origin).set('Cookie', cookie);

  // 순서를 고정해 개수뿐 아니라 각 줄의 값까지 되돌아왔는지 확인한다.
  const readState = async () => ({
    users: await prisma.user.findMany({ orderBy: { id: 'asc' } }),
    sessions: await prisma.session.findMany({ orderBy: { id: 'asc' } }),
    loginCodes: await prisma.loginCode.findMany({ orderBy: { id: 'asc' } }),
    invitations: await prisma.invitation.findMany({ orderBy: { id: 'asc' } }),
    deliveries: await prisma.notificationDelivery.findMany({ orderBy: { id: 'asc' } }),
    projects: await prisma.project.findMany({ orderBy: { id: 'asc' } }),
    members: await prisma.projectMember.findMany({ orderBy: { id: 'asc' } }),
    screens: await prisma.screen.findMany({ orderBy: { id: 'asc' } }),
    versions: await prisma.deliveryVersion.findMany({ orderBy: { id: 'asc' } }),
    assets: await prisma.asset.findMany({ orderBy: { id: 'asc' } }),
    versionScreens: await prisma.versionScreen.findMany({ orderBy: { id: 'asc' } }),
    issues: await prisma.issue.findMany({ orderBy: { id: 'asc' } }),
    comments: await prisma.comment.findMany({ orderBy: { id: 'asc' } }),
    attachments: await prisma.issueAttachment.findMany({ orderBy: { id: 'asc' } }),
    attempts: await prisma.resolutionAttempt.findMany({ orderBy: { id: 'asc' } }),
    approvals: await prisma.approval.findMany({ orderBy: { id: 'asc' } }),
    events: await prisma.activityEvent.findMany({ orderBy: { id: 'asc' } }),
  });

  const approve = async () => {
    const review = await get(`/api/versions/${versionId}/approval-check`, cookies[0]).expect(200);
    await post(`/api/versions/${versionId}/approve`, cookies[0]).send({ seenAt: review.body.serverTime }).expect(200);
  };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'withdraw-user-e2e-'));
    vi.stubEnv('ASSET_DIR', directory);
    vi.stubEnv('APP_ORIGINS', origin);
    vi.stubEnv('APP_URL', origin);
    vi.stubEnv('DEVELOPER_EMAIL', developerEmail);
    vi.stubEnv('COOKIE_SECURE', undefined);
    sendLoginCode.mockReset();
    send.mockReset();
    send.mockResolvedValue(undefined);
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MailService)
      .useValue({ sendLoginCode, sendInvitation: vi.fn(), send })
      .compile();
    app = module.createNestApplication();
    setupApp(app);
    await app.init();
    server = app.getHttpServer() as Server;
    prisma = app.get(PrismaService);
    await resetDatabase(prisma);

    developerId = (await prisma.user.create({ data: { email: developerEmail, name: '개발자' } })).id;
    // 탈퇴가 마지막 접속·동의 시각을 비우는지 보려면 값이 있어야 한다.
    const withdrawing = { email, name, lastSeenAt: new Date(), privacyAgreedAt: new Date() };
    userId = (await prisma.user.create({ data: withdrawing })).id;
    otherId = (await prisma.user.create({ data: { email: otherEmail, name: '다른 참여자' } })).id;
    const project = await prisma.project.create({
      data: {
        name: '탈퇴 검수 프로젝트',
        members: {
          create: [
            { userId: developerId, role: 'DEVELOPER' },
            { userId, role: 'CLIENT' },
            { userId: otherId, role: 'CLIENT' },
          ],
        },
      },
      include: { members: true },
    });
    projectId = project.id;
    memberId = project.members.find((member) => member.userId === userId)!.id;
    const version = await prisma.deliveryVersion.create({
      data: { projectId, number: 1, status: 'IN_REVIEW', publishedAt: new Date() },
    });
    versionId = version.id;
    await prisma.project.update({
      where: { id: projectId },
      data: { currentVersionId: versionId, approverMemberId: memberId },
    });
    const screen = await prisma.screen.create({ data: { projectId, name: '홈', viewport: 'PC' } });
    const asset = await prisma.asset.create({
      data: { projectId, storageKey: `${projectId}/screen.png`, mime: 'image/png', bytes: 100, width: 10, height: 10 },
    });
    await prisma.versionScreen.create({ data: { versionId, screenId: screen.id, assetId: asset.id } });
    const issue = await prisma.issue.create({
      data: {
        projectId,
        number: 1,
        originVersionId: versionId,
        authorId: userId,
        title: `${name}의 수정 요청`,
        body: `${email}에 관해 직접 쓴 작업 내용`,
        status: 'VERIFIED',
        requestId: randomUUID(),
      },
    });
    issueId = issue.id;
    await prisma.comment.create({
      data: { issueId, versionId, authorId: userId, body: `${name}이 직접 쓴 댓글`, requestId: randomUUID() },
    });
    await prisma.activityEvent.create({
      data: { projectId, actorId: userId, type: 'ISSUE_CREATED', issueId, versionId },
    });
    developerCookie = await login(developerId);
    cookies = [await login(userId), await login(userId)];
    await login(otherId);

    // 살아 있는 초대뿐 아니라 수락·철회·만료된 초대에도 이메일이 남아 있다.
    const expiredProject = await prisma.project.create({ data: { name: '만료된 초대 프로젝트' } });
    for (const address of [email, otherEmail, developerEmail]) {
      await prisma.loginCode.create({
        data: {
          email: address,
          codeHash: 'unused-test-hash',
          privacyAgreed: true,
          expiresAt: new Date(Date.now() + 600_000),
        },
      });
      for (const state of ['pending', 'accepted', 'revoked', 'expired']) {
        await prisma.invitation.create({
          data: {
            projectId: state === 'expired' ? expiredProject.id : projectId,
            email: address,
            invitedById: developerId,
            tokenHash: hashSessionToken(createSessionToken()),
            expiresAt: new Date(Date.now() + (state === 'expired' ? -1 : 1) * 86_400_000),
            acceptedAt: state === 'accepted' ? new Date() : null,
            revokedAt: state === 'revoked' ? new Date() : null,
          },
        });
      }
    }
    for (const status of ['PENDING', 'SENT', 'FAILED'] as const) {
      const event = await prisma.activityEvent.create({
        data: { projectId, actorId: developerId, type: 'VERSION_PUBLISHED', versionId },
      });
      await prisma.notificationDelivery.createMany({
        data: [email, otherEmail].map((toEmail) => ({
          eventId: event.id,
          toEmail,
          status,
          attempts: status === 'FAILED' ? 5 : 0,
          sentAt: status === 'SENT' ? new Date() : null,
        })),
      });
    }
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

  it('탈퇴하면 계정·세션·로그인 코드·초대·메일 기록에 이름과 이메일이 남지 않는다', async () => {
    const before = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

    const result = await withdrawUser(prisma, `  ${email.toUpperCase()}  `);

    expect(result).toEqual({
      userId,
      approverCleared: 1,
      membershipsRevoked: 1,
      sessions: 2,
      loginCodes: 1,
      invitations: 4,
      deliveries: 3,
    });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: userId } })).toEqual({
      ...before,
      name: '탈퇴한 사용자',
      email: `withdrawn-${userId}@invalid`,
      lastSeenAt: null,
      privacyAgreedAt: null,
    });
    expect(await prisma.user.count({ where: { OR: [{ email }, { name }] } })).toBe(0);
    expect(await prisma.session.count({ where: { userId } })).toBe(0);
    expect(await prisma.loginCode.count({ where: { email } })).toBe(0);
    expect(await prisma.invitation.count({ where: { email } })).toBe(0);
    expect(await prisma.notificationDelivery.count({ where: { toEmail: email } })).toBe(0);
  });

  it('탈퇴하면 그 사람의 기존 쿠키로 요청해도 401이다', async () => {
    for (const cookie of cookies) await get('/api/auth/me', cookie).expect(200);

    await withdrawUser(prisma, email);

    for (const cookie of cookies) {
      await get('/api/auth/me', cookie).expect(401);
      await get(`/api/projects/${projectId}`, cookie).expect(401);
      await post(`/api/issues/${issueId}/comments`, cookie)
        .send({ versionId, body: '탈퇴 뒤 댓글', requestId: randomUUID() })
        .expect(401);
    }
    expect(await prisma.comment.count()).toBe(1);
    await get('/api/auth/me').expect(200);
  });

  it('중간 단계가 실패하면 아무것도 바뀌지 않는다', async () => {
    await approve();
    const before = await readState();
    try {
      // 마지막 삭제에서 실패시켜 앞선 계정 변경과 모든 삭제도 함께 되돌리는지 본다.
      await prisma.$executeRaw`
        CREATE FUNCTION withdraw_e2e_fail_delete() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'withdraw e2e last delete failure'; END; $$
      `;
      await prisma.$executeRaw`
        CREATE TRIGGER withdraw_e2e_fail_delete BEFORE DELETE ON notification_deliveries
        FOR EACH ROW EXECUTE FUNCTION withdraw_e2e_fail_delete()
      `;

      await expect(withdrawUser(prisma, email)).rejects.toThrow('withdraw e2e last delete failure');

      expect(await readState()).toEqual(before);
      await get('/api/auth/me', cookies[0])
        .expect(200)
        .expect((response) => {
          expect(response.body).toMatchObject({ id: userId, email, name });
        });
    } finally {
      await prisma.$executeRaw`DROP TRIGGER IF EXISTS withdraw_e2e_fail_delete ON notification_deliveries`;
      await prisma.$executeRaw`DROP FUNCTION IF EXISTS withdraw_e2e_fail_delete()`;
    }
  });

  it('다른 사람의 계정·세션·초대·메일·참여는 그대로다', async () => {
    const otherProject = await prisma.project.create({
      data: {
        name: '다른 사람만 참여한 프로젝트',
        members: {
          create: [
            { userId: developerId, role: 'DEVELOPER' },
            { userId: otherId, role: 'CLIENT' },
          ],
        },
      },
      include: { members: true },
    });
    await prisma.project.update({
      where: { id: otherProject.id },
      data: { approverMemberId: otherProject.members.find((member) => member.userId === otherId)!.id },
    });
    // 탈퇴자가 초대한 다른 사람의 초대는 지우지 않는다.
    const invited = await prisma.invitation.create({
      data: {
        projectId,
        email: 'invited-by-withdrawn@example.com',
        invitedById: userId,
        tokenHash: hashSessionToken(createSessionToken()),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    const before = await readState();

    await withdrawUser(prisma, email);

    const after = await readState();
    expect(after.users.filter((user) => user.id !== userId)).toEqual(before.users.filter((user) => user.id !== userId));
    expect(after.sessions).toEqual(before.sessions.filter((session) => session.userId !== userId));
    expect(after.loginCodes).toEqual(before.loginCodes.filter((code) => code.email !== email));
    expect(after.invitations).toEqual(before.invitations.filter((invitation) => invitation.email !== email));
    expect(after.deliveries).toEqual(before.deliveries.filter((delivery) => delivery.toEmail !== email));
    expect(after.members.filter((member) => member.userId !== userId)).toEqual(
      before.members.filter((member) => member.userId !== userId),
    );
    expect(after.projects.find((project) => project.id === otherProject.id)).toEqual(
      before.projects.find((project) => project.id === otherProject.id),
    );
    expect(
      await prisma.invitation.findUniqueOrThrow({ where: { id: invited.id }, include: { invitedBy: true } }),
    ).toMatchObject({ ...invited, invitedBy: { id: userId, name: '탈퇴한 사용자' } });
    const otherCookie = await login(otherId);
    await get('/api/auth/me', otherCookie)
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({ id: otherId, email: otherEmail, name: '다른 참여자' });
      });
    await get(`/api/projects/${projectId}`, otherCookie).expect(200);
  });

  it('탈퇴하면 그 이메일의 대기·성공·실패 메일 줄이 모두 지워진다', async () => {
    expect(
      await prisma.notificationDelivery.findMany({ where: { toEmail: email }, orderBy: { status: 'asc' } }),
    ).toEqual(['PENDING', 'SENT', 'FAILED'].map((status) => expect.objectContaining({ status })));

    await withdrawUser(prisma, email);

    expect(await prisma.notificationDelivery.count({ where: { toEmail: email } })).toBe(0);
    await app!.get(NotificationsService).processDue();
    expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ to: otherEmail }));
    expect(await prisma.notificationDelivery.count({ where: { toEmail: email } })).toBe(0);
  });

  it('탈퇴한 이메일로는 코드를 맞혀도 로그인할 수 없다', async () => {
    await prisma.loginCode.delete({ where: { email } });
    await post('/api/auth/email-code').send({ email, privacyAgreed: true }).expect(204);
    expect(sendLoginCode).toHaveBeenCalledExactlyOnceWith(email, expect.stringMatching(/^\d{6}$/));
    const oldCode = sendLoginCode.mock.calls[0][1];

    await withdrawUser(prisma, email);

    const oldResponse = await post('/api/auth/verify-code').send({ email, code: oldCode, name }).expect(422);
    expect(oldResponse.body.code).toBe('CODE_EXPIRED');
    expect(oldResponse.headers['set-cookie']).toBeUndefined();
    sendLoginCode.mockClear();
    await post('/api/auth/email-code').send({ email, privacyAgreed: true }).expect(204);
    expect(sendLoginCode).not.toHaveBeenCalled();
    // 메일을 받지 못해도 새 코드를 맞힌 경우까지 확인한다.
    const guessedCode = '314159';
    await prisma.loginCode.update({ where: { email }, data: { codeHash: await bcrypt.hash(guessedCode, 12) } });
    for (const input of [
      { email, code: guessedCode },
      { email, code: guessedCode, name },
    ]) {
      const response = await post('/api/auth/verify-code').send(input).expect(422);
      expect(response.body.code).toBe('CODE_WRONG');
      expect(response.headers['set-cookie']).toBeUndefined();
    }
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
    expect(await prisma.session.count({ where: { userId } })).toBe(0);
    expect(await prisma.user.count()).toBe(3);
    expect(await prisma.invitation.count({ where: { email } })).toBe(0);
  });

  it('탈퇴한 사람이 쓴 쪽지와 댓글은 탈퇴한 사용자로 남는다', async () => {
    const before = await readState();
    const detailBefore = await get(`/api/issues/${issueId}`).expect(200);
    expect(detailBefore.body.authorName).toBe(name);

    await withdrawUser(prisma, email);

    const detail = await get(`/api/issues/${issueId}`).expect(200);
    expect(detail.body).toEqual({
      ...detailBefore.body,
      authorName: '탈퇴한 사용자',
      comments: detailBefore.body.comments.map((comment: Record<string, unknown>) => ({
        ...comment,
        authorName: '탈퇴한 사용자',
      })),
    });
    const list = await get(`/api/projects/${projectId}/issues`).expect(200);
    expect(list.body).toEqual([expect.objectContaining({ id: issueId, authorName: '탈퇴한 사용자', commentCount: 1 })]);
    const activity = await get(`/api/projects/${projectId}/activity`).expect(200);
    expect(activity.body).toContainEqual(
      expect.objectContaining({ type: 'ISSUE_CREATED', actorName: '탈퇴한 사용자' }),
    );
    const after = await readState();
    expect(after.issues).toEqual(before.issues);
    expect(after.comments).toEqual(before.comments);
    expect(after.events).toEqual(before.events);
    expect(after.assets).toEqual(before.assets);
    expect(after.versionScreens).toEqual(before.versionScreens);
  });

  it('탈퇴한 승인자의 승인 기록과 검수 확인서는 남고 승인자 이름이 탈퇴한 사용자로 보인다', async () => {
    await approve();
    const approval = await prisma.approval.findUniqueOrThrow({ where: { versionId } });
    const certificate = await get(`/api/versions/${versionId}/certificate`).expect(200);
    const version = await get(`/api/versions/${versionId}`).expect(200);
    expect(certificate.body.approval.approverName).toBe(name);
    expect(certificate.body.issues).toContainEqual(expect.objectContaining({ title: `${name}의 수정 요청` }));

    await withdrawUser(prisma, email);

    expect(await prisma.approval.findUniqueOrThrow({ where: { versionId } })).toEqual(approval);
    await get(`/api/versions/${versionId}/certificate`)
      .expect(200)
      .expect({
        ...certificate.body,
        approval: { ...certificate.body.approval, approverName: '탈퇴한 사용자' },
      });
    await get(`/api/versions/${versionId}`)
      .expect(200)
      .expect({
        ...version.body,
        approval: { ...version.body.approval, approverName: '탈퇴한 사용자' },
      });
  });

  it('탈퇴하면 모든 프로젝트 참여가 철회되고 승인자였으면 비워진다', async () => {
    const previousRevocation = new Date('2020-01-01T00:00:00Z');
    for (const { status, revokedAt } of [
      { status: 'ACTIVE', revokedAt: null },
      { status: 'ACTIVE', revokedAt: previousRevocation },
      { status: 'ARCHIVED', revokedAt: null },
      { status: 'DELETE_PENDING', revokedAt: null },
    ] as const) {
      const project = await prisma.project.create({
        data: {
          name: `${status} 프로젝트`,
          status,
          statusBeforeDelete: status === 'DELETE_PENDING' ? 'ACTIVE' : null,
          deleteRequestedAt: status === 'DELETE_PENDING' ? new Date() : null,
          members: {
            create: [
              { userId: developerId, role: 'DEVELOPER' },
              { userId, role: 'CLIENT', revokedAt },
              { userId: otherId, role: 'CLIENT' },
            ],
          },
        },
        include: { members: true },
      });
      await prisma.project.update({
        where: { id: project.id },
        data: {
          approverMemberId: project.members.find(
            (member) => member.userId === (status === 'ACTIVE' ? otherId : userId),
          )!.id,
        },
      });
    }
    const before = await readState();
    const [{ now: startedAt }] = await prisma.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;

    const result = await withdrawUser(prisma, email);

    const [{ now: finishedAt }] = await prisma.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    expect(result).toMatchObject({ membershipsRevoked: 4, approverCleared: 3 });
    const after = await readState();
    expect(after.members).toHaveLength(before.members.length);
    for (const member of before.members) {
      const current = after.members.find(({ id }) => id === member.id)!;
      if (member.userId !== userId || member.revokedAt !== null) {
        expect(current).toEqual(member);
        continue;
      }
      expect(current).toEqual({ ...member, revokedAt: expect.any(Date) });
      expect(current.revokedAt!.getTime()).toBeGreaterThanOrEqual(startedAt.getTime());
      expect(current.revokedAt!.getTime()).toBeLessThanOrEqual(finishedAt.getTime());
    }
    const targetMemberIds = before.members.filter((member) => member.userId === userId).map(({ id }) => id);
    expect(after.projects).toEqual(
      before.projects.map((project) => ({
        ...project,
        approverMemberId: targetMemberIds.includes(project.approverMemberId ?? '') ? null : project.approverMemberId,
      })),
    );
    // 세션 삭제와 별개로 참여 철회 자체도 API 접근을 막아야 한다.
    const newCookie = await login(userId);
    await get(`/api/projects/${projectId}`, newCookie).expect(404);
    await get(`/api/issues/${issueId}`, newCookie).expect(404);
  });

  it('개발자 이메일과 없는 이메일은 거부하고 아무것도 바꾸지 않는다', async () => {
    const before = await readState();
    vi.stubEnv('DEVELOPER_EMAIL', `  ${developerEmail.toUpperCase()}  `);
    for (const address of [developerEmail, ` ${developerEmail.toUpperCase()} `]) {
      await expect(withdrawUser(prisma, address)).rejects.toThrow('개발자 계정은 탈퇴 처리하지 않아요');
      expect(await readState()).toEqual(before);
    }
    await expect(withdrawUser(prisma, 'missing@example.com')).rejects.toThrow('그 이메일의 사용자가 없어요');
    expect(await readState()).toEqual(before);
    for (const setting of [undefined, '', '   ']) {
      vi.stubEnv('DEVELOPER_EMAIL', setting);
      await expect(withdrawUser(prisma, email)).rejects.toThrow('DEVELOPER_EMAIL이 없어요');
      await expect(withdrawUser(prisma, developerEmail)).rejects.toThrow('DEVELOPER_EMAIL이 없어요');
      expect(await readState()).toEqual(before);
    }
  });
});
