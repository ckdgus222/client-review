import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Logger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { createSessionToken, hashSessionToken } from '../src/auth/token.js';
import type { ActivityType } from '../src/generated/prisma/client.js';
import { MAIL_TRANSPORT, type Mail, type MailTransport } from '../src/mail/mail.service.js';
import { enqueueNotifications, NotificationsService } from '../src/notifications/notifications.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { setupApp } from '../src/setup-app.js';
import { resetDatabase } from './reset-database.js';

const origin = 'http://localhost:5173';
const appUrl = 'https://review.example.com';
type Member = { id: string; email: string; memberId: string; cookie: string };

// 발송을 붙잡아 두고, 다른 요청이나 작업자가 끝난 뒤 성공·실패를 직접 결정한다.
const deferred = () => {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

describe('알림 우편함 (e2e)', () => {
  let apps: INestApplication[];
  let server: Server;
  let prisma: PrismaService;
  let worker: NotificationsService;
  let directory: string;
  let projectId: string;
  let versionId: string;
  let screenId: string;
  let developer: Member;
  let client: Member;
  let approver: Member;
  let mails: Mail[];
  let logs: string[];
  const send = vi.fn<MailTransport>();

  const createApp = async (transport: MailTransport = send) => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MAIL_TRANSPORT)
      .useValue(transport)
      .compile();
    const app = module.createNestApplication();
    apps.push(app);
    setupApp(app);
    await app.init();
    return app;
  };
  const login = async (userId: string) => {
    const token = createSessionToken();
    await prisma.session.create({
      data: { userId, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 3_600_000) },
    });
    return `sid=${token}`;
  };
  const post = (path: string, cookie = developer.cookie) =>
    request(server).post(path).set('Origin', origin).set('Cookie', cookie);
  const publish = () => post(`/api/versions/${versionId}/publish`).expect(200);
  const prepareReview = async () => {
    await prisma.deliveryVersion.update({
      where: { id: versionId },
      data: { status: 'IN_REVIEW', number: 0, publishedAt: new Date() },
    });
    await prisma.project.update({ where: { id: projectId }, data: { currentVersionId: versionId } });
  };
  const approve = async () => {
    const check = await request(server)
      .get(`/api/versions/${versionId}/approval-check`)
      .set('Cookie', approver.cookie)
      .expect(200);
    return await post(`/api/versions/${versionId}/approve`, approver.cookie)
      .send({ seenAt: check.body.serverTime })
      .expect(200);
  };
  const createIssue = async (cookie = client.cookie, title = '버튼 수정') => {
    const response = await post(`/api/projects/${projectId}/issues`, cookie)
      .send({ requestId: randomUUID(), versionId, title, body: '메일에 넣지 않을 쪽지 본문' })
      .expect(201);
    return response.body.id as string;
  };
  const submit = (issueId: string) =>
    post(`/api/issues/${issueId}/submit-resolution`)
      .send({ versionId, summary: '메일에 넣지 않을 수정 설명', screenId })
      .expect(200);
  const deliveriesFor = (type: ActivityType, issueId?: string) =>
    prisma.notificationDelivery.findMany({
      where: { event: { projectId, type, ...(issueId ? { issueId } : {}) } },
      orderBy: { toEmail: 'asc' },
    });
  const makeDue = () => prisma.$executeRaw`
    UPDATE notification_deliveries SET next_attempt_at = clock_timestamp() - interval '1 second'
  `;
  const readState = async () => ({
    project: await prisma.project.findUniqueOrThrow({ where: { id: projectId } }),
    versions: await prisma.deliveryVersion.findMany({ orderBy: { id: 'asc' } }),
    events: await prisma.activityEvent.findMany({ orderBy: { id: 'asc' } }),
    deliveries: await prisma.notificationDelivery.findMany({ orderBy: { id: 'asc' } }),
  });

  beforeEach(async () => {
    apps = [];
    mails = [];
    logs = [];
    directory = await mkdtemp(join(tmpdir(), 'notifications-e2e-'));
    vi.stubEnv('ASSET_DIR', directory);
    vi.stubEnv('APP_URL', appUrl);
    vi.stubEnv('APP_ORIGINS', origin);
    vi.stubEnv('COOKIE_SECURE', undefined);
    vi.stubEnv('DEVELOPER_EMAIL', 'developer@example.com');
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((...messages: unknown[]) => {
        logs.push(messages.map(String).join(' '));
      });
    }
    send.mockReset();
    send.mockImplementation(async (mail) => {
      mails.push(mail);
    });
    const app = await createApp();
    server = app.getHttpServer() as Server;
    prisma = app.get(PrismaService);
    worker = app.get(NotificationsService);
    await resetDatabase(prisma);
    const project = await prisma.project.create({ data: { name: '알림 검수 프로젝트' } });
    projectId = project.id;
    const members: Member[] = [];
    for (const [name, role] of [
      ['developer', 'DEVELOPER'],
      ['client', 'CLIENT'],
      ['approver', 'CLIENT'],
    ] as const) {
      const user = await prisma.user.create({ data: { email: `${name}@example.com`, name } });
      const member = await prisma.projectMember.create({ data: { projectId, userId: user.id, role } });
      members.push({ id: user.id, email: user.email, memberId: member.id, cookie: await login(user.id) });
    }
    [developer, client, approver] = members;
    await prisma.project.update({ where: { id: projectId }, data: { approverMemberId: approver.memberId } });
    const version = await prisma.deliveryVersion.create({ data: { projectId } });
    versionId = version.id;
    const screen = await prisma.screen.create({ data: { projectId, name: '첫 화면', viewport: 'PC' } });
    screenId = screen.id;
    const asset = await prisma.asset.create({
      data: { projectId, storageKey: `${projectId}/screen.png`, mime: 'image/png', bytes: 100, width: 32, height: 24 },
    });
    await prisma.versionScreen.create({ data: { versionId, screenId, assetId: asset.id } });
  });

  afterEach(async () => {
    try {
      for (const app of apps) await app.close();
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  });

  it('우편함에 넣은 뒤 트랜잭션이 실패하면 게시·사건·우편함 줄이 모두 되돌아가고 메일도 나가지 않는다', async () => {
    const before = await readState();
    try {
      await prisma.$executeRaw`
        CREATE FUNCTION notifications_e2e_fail_insert() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'notifications e2e insert failure';
        END;
        $$
      `;
      await prisma.$executeRaw`
        CREATE TRIGGER notifications_e2e_fail_insert BEFORE INSERT ON notification_deliveries
        FOR EACH ROW EXECUTE FUNCTION notifications_e2e_fail_insert()
      `;
      await post(`/api/versions/${versionId}/publish`).expect(500);
      expect(await readState()).toEqual(before);
      await worker.processDue();
      expect(send).not.toHaveBeenCalled();
    } finally {
      try {
        await prisma.$executeRaw`DROP TRIGGER IF EXISTS notifications_e2e_fail_insert ON notification_deliveries`;
      } finally {
        await prisma.$executeRaw`DROP FUNCTION IF EXISTS notifications_e2e_fail_insert()`;
      }
    }
  });

  it('승인자가 쓴 쪽지의 고쳤어요 메일은 그 사람에게 한 통만 들어간다', async () => {
    await prepareReview();
    const issueId = await createIssue(approver.cookie);
    await submit(issueId);
    expect(await deliveriesFor('RESOLUTION_SUBMITTED')).toEqual([
      expect.objectContaining({ toEmail: approver.email, status: 'PENDING', attempts: 0 }),
    ]);
    await worker.processDue();
    expect(mails).toEqual([expect.objectContaining({ to: approver.email })]);
  });

  it('같은 사건을 두 번 넣어도 오류 없이 받는 사람마다 한 줄이다', async () => {
    await publish();
    const event = await prisma.activityEvent.findFirstOrThrow({ where: { type: 'VERSION_PUBLISHED' } });
    const before = await deliveriesFor('VERSION_PUBLISHED');
    await prisma.$transaction(async (tx) => {
      await enqueueNotifications(tx, { id: event.id, projectId, type: event.type });
      await enqueueNotifications(tx, { id: event.id, projectId, type: event.type });
    });
    expect(await deliveriesFor('VERSION_PUBLISHED')).toEqual(before);
    expect(before.map(({ toEmail }) => toEmail)).toEqual([approver.email, client.email]);
    await worker.processDue();
    expect(mails.map(({ to }) => to).sort()).toEqual([approver.email, client.email]);
  });

  it('버전을 게시하면 활성 클라이언트에게만 메일 줄이 들어간다', async () => {
    const revoked = await prisma.user.create({ data: { email: 'revoked@example.com', name: '철회됨' } });
    await prisma.projectMember.create({
      data: { projectId, userId: revoked.id, role: 'CLIENT', revokedAt: new Date() },
    });
    const outside = await prisma.user.create({ data: { email: 'outside@example.com', name: '다른 사람' } });
    await prisma.project.create({
      data: {
        name: '다른 프로젝트',
        members: {
          create: [
            { userId: developer.id, role: 'DEVELOPER' },
            { userId: outside.id, role: 'CLIENT' },
          ],
        },
      },
    });
    await publish();
    expect((await deliveriesFor('VERSION_PUBLISHED')).map(({ toEmail }) => toEmail)).toEqual([
      approver.email,
      client.email,
    ]);
    expect(send).not.toHaveBeenCalled();
    await worker.processDue();
    expect(mails.map(({ to }) => to).sort()).toEqual([approver.email, client.email]);
  });

  it('고쳤어요는 쪽지를 쓴 클라이언트에게, 개발자가 쓴 쪽지는 승인자에게 간다', async () => {
    await prepareReview();
    const clientIssue = await createIssue();
    const developerIssue = await createIssue(developer.cookie);
    await submit(clientIssue);
    await submit(developerIssue);
    expect((await deliveriesFor('RESOLUTION_SUBMITTED', clientIssue)).map(({ toEmail }) => toEmail)).toEqual([
      client.email,
    ]);
    expect((await deliveriesFor('RESOLUTION_SUBMITTED', developerIssue)).map(({ toEmail }) => toEmail)).toEqual([
      approver.email,
    ]);
    await worker.processDue();
    expect(mails).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ to: client.email, text: expect.stringContaining(`?issue=${clientIssue}`) }),
        expect.objectContaining({ to: approver.email, text: expect.stringContaining(`?issue=${developerIssue}`) }),
      ]),
    );
    expect(mails).toHaveLength(2);
  });

  it('쪽지를 쓴 클라이언트가 철회됐으면 고쳤어요 메일은 승인자에게 간다', async () => {
    await prepareReview();
    const issueId = await createIssue();
    await post(`/api/members/${client.memberId}/revoke`).expect(204);
    await submit(issueId);
    expect((await deliveriesFor('RESOLUTION_SUBMITTED')).map(({ toEmail }) => toEmail)).toEqual([approver.email]);
    await worker.processDue();
    expect(mails.filter(({ text }) => text.includes(`?issue=${issueId}`))).toEqual([
      expect.objectContaining({ to: approver.email }),
    ]);
  });

  it('승인하면 개발자에게 메일 줄이 들어간다', async () => {
    await prepareReview();
    await approve();
    expect(await deliveriesFor('VERSION_APPROVED')).toEqual([
      expect.objectContaining({ toEmail: developer.email, status: 'PENDING', attempts: 0 }),
    ]);
    expect(send).not.toHaveBeenCalled();
    await worker.processDue();
    expect(mails).toEqual([expect.objectContaining({ to: developer.email })]);
  });

  it('접근 철회와 초대 수락은 개발자에게 사건 종류·시각·프로젝트 id·대상 멤버 id가 적힌 기록 메일로 간다', async () => {
    await post(`/api/members/${client.memberId}/revoke`).expect(204);
    const invited = await prisma.user.create({ data: { email: 'invited@example.com', name: '초대받음' } });
    const invitation = await post(`/api/projects/${projectId}/invitations`).send({ email: invited.email }).expect(201);
    const token = new URL(invitation.body.link).pathname.split('/').at(-1)!;
    await post('/api/invitations/accept', await login(invited.id))
      .send({ token })
      .expect(200);
    const accepted = await prisma.projectMember.findUniqueOrThrow({
      where: { projectId_userId: { projectId, userId: invited.id } },
    });
    mails.length = 0;
    await worker.processDue();
    expect(mails).toHaveLength(2);
    for (const [type, memberId] of [
      ['MEMBER_REVOKED', client.memberId],
      ['INVITATION_ACCEPTED', accepted.id],
    ] as const) {
      const event = await prisma.activityEvent.findFirstOrThrow({ where: { projectId, type } });
      expect(event.memberId).toBe(memberId);
      expect(await deliveriesFor(type)).toEqual([
        expect.objectContaining({ toEmail: developer.email, status: 'SENT', sentAt: expect.any(Date) }),
      ]);
      expect(mails.find(({ text }) => text.includes(`사건: ${type}`))).toMatchObject({
        to: developer.email,
        text: [
          `사건: ${type}`,
          `시각: ${event.createdAt.toISOString()}`,
          `프로젝트 id: ${projectId}`,
          `대상 멤버 id: ${memberId}`,
        ].join('\n'),
      });
    }
    expect(JSON.stringify(mails)).not.toContain(token);
  });

  it('쪽지 작성·초대·승인자 변경 같은 사건은 우편함에 줄을 만들지 않는다', async () => {
    await prepareReview();
    await createIssue();
    await post(`/api/projects/${projectId}/invitations`).send({ email: 'invited@example.com' }).expect(201);
    await post(`/api/projects/${projectId}/approver`).send({ memberId: client.memberId }).expect(200);
    expect((await prisma.activityEvent.findMany()).map(({ type }) => type).sort()).toEqual([
      'APPROVER_CHANGED',
      'INVITATION_CREATED',
      'ISSUE_CREATED',
    ]);
    expect(await prisma.notificationDelivery.count()).toBe(0);
    send.mockClear();
    await worker.processDue();
    expect(send).not.toHaveBeenCalled();
  });

  it('메일 발송이 실패해도 게시와 승인은 저장되고 줄은 다시 보낼 차례로 남는다', async () => {
    send.mockRejectedValue(new Error('발송 실패'));
    await publish();
    await approve();
    expect(send).not.toHaveBeenCalled();
    await worker.processDue();
    expect(await prisma.deliveryVersion.findUniqueOrThrow({ where: { id: versionId } })).toMatchObject({
      status: 'APPROVED',
      number: 0,
    });
    expect(await prisma.approval.count({ where: { versionId } })).toBe(1);
    expect((await prisma.activityEvent.findMany()).map(({ type }) => type).sort()).toEqual([
      'VERSION_APPROVED',
      'VERSION_PUBLISHED',
    ]);
    const deliveries = await prisma.notificationDelivery.findMany();
    expect(deliveries).toHaveLength(3);
    expect(deliveries).toEqual(
      Array.from({ length: 3 }, () => expect.objectContaining({ status: 'PENDING', attempts: 1, sentAt: null })),
    );
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('실패한 메일은 1분이 지나기 전에는 다시 보내지 않는다', async () => {
    await prepareReview();
    await approve();
    send.mockRejectedValue(new Error('발송 실패'));
    const [{ before }] = await prisma.$queryRaw<{ before: Date }[]>`SELECT clock_timestamp() AS before`;
    await worker.processDue();
    const [{ after }] = await prisma.$queryRaw<{ after: Date }[]>`SELECT clock_timestamp() AS after`;
    const failed = await prisma.notificationDelivery.findFirstOrThrow();
    expect(failed).toMatchObject({ attempts: 1, status: 'PENDING', sentAt: null });
    expect(failed.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before.getTime() + 60_000);
    expect(failed.nextAttemptAt.getTime()).toBeLessThanOrEqual(after.getTime() + 60_000);
    await worker.processDue();
    expect(send).toHaveBeenCalledTimes(1);
    expect(await prisma.notificationDelivery.findFirstOrThrow()).toEqual(failed);
    await makeDue();
    send.mockResolvedValue(undefined);
    await worker.processDue();
    expect(send).toHaveBeenCalledTimes(2);
    expect(await prisma.notificationDelivery.findFirstOrThrow()).toMatchObject({
      attempts: 1,
      status: 'SENT',
      sentAt: expect.any(Date),
    });
  });

  it('APP_URL이 없으면 보내지 않고 원인을 로그에 남긴 뒤 1분 뒤 다시 보낸다', async () => {
    await prepareReview();
    await approve();
    const originalAppUrl = process.env.APP_URL;
    try {
      vi.stubEnv('APP_URL', undefined);
      const [{ before }] = await prisma.$queryRaw<{ before: Date }[]>`SELECT clock_timestamp() AS before`;
      await worker.processDue();
      const [{ after }] = await prisma.$queryRaw<{ after: Date }[]>`SELECT clock_timestamp() AS after`;
      const failed = await prisma.notificationDelivery.findFirstOrThrow();
      expect(send).not.toHaveBeenCalled();
      expect(failed).toMatchObject({ toEmail: developer.email, status: 'PENDING', attempts: 1, sentAt: null });
      expect(failed.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before.getTime() + 60_000);
      expect(failed.nextAttemptAt.getTime()).toBeLessThanOrEqual(after.getTime() + 60_000);
      const warning = `알림 메일을 보내지 못했어요(1번째) → ${developer.email}: APP_URL이 없어요`;
      expect(logs).toContain(warning);
      expect(Logger.prototype.warn).toHaveBeenCalledWith(warning);
      await worker.processDue();
      expect(send).not.toHaveBeenCalled();
      expect(await prisma.notificationDelivery.findFirstOrThrow()).toEqual(failed);
    } finally {
      vi.stubEnv('APP_URL', originalAppUrl);
    }
    await makeDue();
    await worker.processDue();
    expect(send).toHaveBeenCalledTimes(1);
    expect(mails).toEqual([expect.objectContaining({ to: developer.email })]);
    expect(await prisma.notificationDelivery.findFirstOrThrow()).toMatchObject({
      status: 'SENT',
      attempts: 1,
      sentAt: expect.any(Date),
    });
  });

  it('SMTP 오류는 서버 응답 원문 없이 오류 코드만 로그에 남긴다', async () => {
    await publish();
    const smtpError = Object.assign(new Error('SMTP 인증 실패\r\n메일본문표식'), {
      code: 'EAUTH',
      responseCode: 535,
    });
    const connectionError = Object.assign(new Error('SMTP 연결 실패\n메일본문표식'), {
      code: 'ECONNREFUSED',
    });
    send.mockImplementation(async (mail) => {
      if (mail.to === client.email) throw smtpError;
      throw connectionError;
    });

    await worker.processDue();

    expect(send).toHaveBeenCalledTimes(2);
    expect(logs).toContain(`알림 메일을 보내지 못했어요(1번째) → ${client.email}: 오류 코드 EAUTH(SMTP 535)`);
    expect(logs).toContain(`알림 메일을 보내지 못했어요(1번째) → ${approver.email}: 오류 코드 ECONNREFUSED`);
    expect(logs.join('\n')).not.toContain('메일본문표식');
    expect(await deliveriesFor('VERSION_PUBLISHED')).toEqual([
      expect.objectContaining({ toEmail: approver.email, status: 'PENDING', attempts: 1, sentAt: null }),
      expect.objectContaining({ toEmail: client.email, status: 'PENDING', attempts: 1, sentAt: null }),
    ]);
  });

  it('다섯 번 실패하면 FAILED가 되고 더 보내지 않는다', async () => {
    await prepareReview();
    await approve();
    send.mockRejectedValue(new Error('발송 실패'));
    for (let attempts = 1; attempts <= 5; attempts += 1) {
      await makeDue();
      await worker.processDue();
      expect(await prisma.notificationDelivery.findFirstOrThrow()).toMatchObject({
        attempts,
        status: attempts === 5 ? 'FAILED' : 'PENDING',
        sentAt: null,
      });
      expect(send).toHaveBeenCalledTimes(attempts);
    }
    await makeDue();
    const failed = await prisma.notificationDelivery.findFirstOrThrow();
    await worker.processDue();
    expect(send).toHaveBeenCalledTimes(5);
    expect(await prisma.notificationDelivery.findFirstOrThrow()).toEqual(failed);
  });

  it('활동 일지의 메일 실패 주소는 개발자에게만 보인다', async () => {
    for (const email of ['sent@example.com', 'pending@example.com']) {
      await prisma.user.create({
        data: { email, name: email, memberships: { create: { projectId, role: 'CLIENT' } } },
      });
    }
    await publish();
    const event = await prisma.activityEvent.findFirstOrThrow({ where: { projectId, type: 'VERSION_PUBLISHED' } });
    await prisma.notificationDelivery.update({
      where: { eventId_toEmail: { eventId: event.id, toEmail: 'pending@example.com' } },
      data: { nextAttemptAt: new Date('2099-01-01T00:00:00Z') },
    });
    send.mockImplementation(async (mail) => {
      if (mail.to !== 'sent@example.com') throw new Error('발송 실패');
      mails.push(mail);
    });

    for (let attempts = 1; attempts <= 5; attempts += 1) {
      await prisma.$executeRaw`
        UPDATE notification_deliveries
        SET next_attempt_at = clock_timestamp() - interval '1 second'
        WHERE event_id = ${event.id}::uuid AND to_email IN (${client.email}, ${approver.email})
      `;
      await worker.processDue();
      const response = await request(server)
        .get(`/api/projects/${projectId}/activity`)
        .set('Cookie', developer.cookie)
        .expect(200);
      expect(response.body).toEqual([
        {
          id: event.id,
          type: 'VERSION_PUBLISHED',
          createdAt: event.createdAt.toISOString(),
          actorName: 'developer',
          version: { id: versionId, number: 0 },
          memberName: null,
          issue: null,
          mailFailedTo: attempts === 5 ? [approver.email, client.email] : [],
        },
      ]);
    }
    expect(send).toHaveBeenCalledTimes(11);
    expect(await deliveriesFor('VERSION_PUBLISHED')).toEqual([
      expect.objectContaining({ toEmail: approver.email, status: 'FAILED', attempts: 5, sentAt: null }),
      expect.objectContaining({ toEmail: client.email, status: 'FAILED', attempts: 5, sentAt: null }),
      expect.objectContaining({ toEmail: 'pending@example.com', status: 'PENDING', attempts: 0, sentAt: null }),
      expect.objectContaining({ toEmail: 'sent@example.com', status: 'SENT', attempts: 0, sentAt: expect.any(Date) }),
    ]);

    const issueId = await createIssue();
    const issueEvent = await prisma.activityEvent.findFirstOrThrow({ where: { projectId, issueId } });
    const developerResponse = await request(server)
      .get(`/api/projects/${projectId}/activity`)
      .set('Cookie', developer.cookie)
      .expect(200);
    expect(developerResponse.body).toEqual([
      expect.objectContaining({ id: issueEvent.id, mailFailedTo: [] }),
      expect.objectContaining({ id: event.id, mailFailedTo: [approver.email, client.email] }),
    ]);
    for (const member of [client, approver]) {
      const response = await request(server)
        .get(`/api/projects/${projectId}/activity`)
        .set('Cookie', member.cookie)
        .expect(200);
      expect(response.body).toEqual(
        developerResponse.body.map((item: Record<string, unknown>) => ({ ...item, mailFailedTo: [] })),
      );
    }

    const outsider = await prisma.user.create({ data: { email: 'outsider@example.com', name: '비멤버' } });
    const outsiderCookie = await login(outsider.id);
    const notFound = { statusCode: 404, message: '없는 프로젝트예요', error: 'Not Found' };
    await request(server)
      .get(`/api/projects/${projectId}/activity`)
      .set('Cookie', outsiderCookie)
      .expect(404)
      .expect(notFound);
    await post(`/api/members/${client.memberId}/revoke`).expect(204);
    await request(server)
      .get(`/api/projects/${projectId}/activity`)
      .set('Cookie', client.cookie)
      .expect(404)
      .expect(notFound);
    const afterRevoke = await request(server)
      .get(`/api/projects/${projectId}/activity`)
      .set('Cookie', developer.cookie)
      .expect(200);
    expect(afterRevoke.body).toContainEqual(
      expect.objectContaining({ id: event.id, mailFailedTo: [approver.email, client.email] }),
    );
    await prisma.projectMember.update({ where: { id: developer.memberId }, data: { revokedAt: new Date() } });
    await request(server)
      .get(`/api/projects/${projectId}/activity`)
      .set('Cookie', developer.cookie)
      .expect(404)
      .expect(notFound);
  });

  it('느린 발송기로 두 작업자가 동시에 보내도 메일은 한 통씩만 간다', async () => {
    await publish();
    const next = await post(`/api/projects/${projectId}/versions`).expect(201);
    versionId = next.body.id;
    await publish();
    const release = deferred();
    send.mockImplementation(async (mail) => {
      mails.push(mail);
      await release.promise;
    });
    const second = (await createApp()).get(NotificationsService);
    const pending = Promise.allSettled([worker.processDue(), second.processDue()]);
    try {
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
      const [{ leased, fiveMinutes }] = await prisma.$queryRaw<{ leased: number; fiveMinutes: number }[]>`
        SELECT count(*)::int AS leased,
          count(*) FILTER (
            WHERE next_attempt_at > clock_timestamp() + interval '4 minutes 55 seconds'
              AND next_attempt_at <= clock_timestamp() + interval '5 minutes'
          )::int AS "fiveMinutes"
        FROM notification_deliveries
        WHERE next_attempt_at > clock_timestamp()
      `;
      expect(leased).toBe(2);
      expect(fiveMinutes).toBe(2);
    } finally {
      release.resolve();
      expect(await pending).toEqual([
        { status: 'fulfilled', value: undefined },
        { status: 'fulfilled', value: undefined },
      ]);
    }
    expect(mails).toHaveLength(4);
    expect(new Set(mails.map(({ to, text }) => `${to}:${text}`)).size).toBe(4);
    expect(await prisma.notificationDelivery.count({ where: { status: 'SENT', attempts: 0 } })).toBe(4);
  });

  it('다른 트랜잭션이 잠근 줄은 건너뛰고 다음 줄을 보낸다', async () => {
    await publish();
    const [first, second] = await deliveriesFor('VERSION_PUBLISHED');
    await prisma.$executeRaw`
      UPDATE notification_deliveries
      SET next_attempt_at = clock_timestamp() -
        CASE WHEN id = ${first.id}::uuid THEN interval '2 minutes' ELSE interval '1 minute' END
      WHERE id IN (${first.id}::uuid, ${second.id}::uuid)
    `;
    const locked = await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: first.id } });
    const rollback = new Error('잠금 테스트 트랜잭션 되돌리기');
    let pending: Promise<PromiseSettledResult<void>[]> | undefined;
    let finished = false;
    try {
      await expect(
        prisma.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT id FROM notification_deliveries WHERE id = ${first.id}::uuid FOR UPDATE`;
            pending = Promise.allSettled([
              (async () => {
                await worker.processDue();
                finished = true;
              })(),
            ]);
            // 잠금을 풀기 전에 끝나야 한다. SKIP LOCKED가 없으면 여기서 실패한다.
            await vi.waitFor(() => expect(finished).toBe(true), { timeout: 2_000, interval: 20 });
            expect(await pending).toEqual([{ status: 'fulfilled', value: undefined }]);
            expect(send).toHaveBeenCalledTimes(1);
            expect(mails).toEqual([expect.objectContaining({ to: second.toEmail })]);
            expect(await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: second.id } })).toMatchObject({
              status: 'SENT',
              attempts: 0,
              sentAt: expect.any(Date),
            });
            expect(await tx.notificationDelivery.findUniqueOrThrow({ where: { id: first.id } })).toEqual(locked);
            expect(locked).toMatchObject({ status: 'PENDING', attempts: 0, sentAt: null });
            throw rollback;
          },
          { maxWait: 5_000, timeout: 10_000 },
        ),
      ).rejects.toBe(rollback);
    } finally {
      await pending;
    }
  }, 15_000);

  it('임대가 끝난 뒤 늦게 끝난 옛 작업자의 결과는 새 작업자의 결과를 덮지 않는다', async () => {
    await prepareReview();
    await approve();
    const release = deferred();
    send.mockImplementation(async (mail) => {
      mails.push(mail);
      await release.promise;
    });
    const secondSend = vi.fn<MailTransport>().mockResolvedValue(undefined);
    const second = (await createApp(secondSend)).get(NotificationsService);
    const pending = Promise.allSettled([worker.processDue()]);
    try {
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      await makeDue();
      await second.processDue();
      const sent = await prisma.notificationDelivery.findFirstOrThrow();
      expect(sent).toMatchObject({ status: 'SENT', attempts: 0, sentAt: expect.any(Date) });
      release.reject(new Error('옛 작업자의 늦은 실패'));
      expect(await pending).toEqual([{ status: 'fulfilled', value: undefined }]);
      expect(await prisma.notificationDelivery.findFirstOrThrow()).toEqual(sent);
      expect(secondSend).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      await pending;
    }
  });

  it.each(['성공', '실패'] as const)(
    '옛 작업자의 늦은 %s도 새 작업자가 정한 재시도 시각과 실패 횟수를 바꾸지 않는다',
    async (result) => {
      await prepareReview();
      await approve();
      const release = deferred();
      send.mockImplementation(async (mail) => {
        mails.push(mail);
        await release.promise;
      });
      const secondSend = vi.fn<MailTransport>().mockRejectedValue(new Error('새 작업자의 실패'));
      const second = (await createApp(secondSend)).get(NotificationsService);
      const pending = Promise.allSettled([worker.processDue()]);
      try {
        await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
        await makeDue();
        await second.processDue();
        const retry = await prisma.notificationDelivery.findFirstOrThrow();
        expect(retry).toMatchObject({ status: 'PENDING', attempts: 1, sentAt: null });
        if (result === '실패') release.reject(new Error('옛 작업자의 늦은 실패'));
        if (result === '성공') release.resolve();
        expect(await pending).toEqual([{ status: 'fulfilled', value: undefined }]);
        expect(await prisma.notificationDelivery.findFirstOrThrow()).toEqual(retry);
        expect(secondSend).toHaveBeenCalledTimes(1);
      } finally {
        release.resolve();
        await pending;
      }
    },
  );

  it('끝나지 않는 발송은 한도가 지나면 실패로 세고 다음 메일을 보낸다', async () => {
    await publish();
    worker.sendLimitMs = 200;
    send.mockImplementationOnce(async (mail) => {
      mails.push(mail);
      await new Promise<void>(() => {});
    });
    await worker.processDue();
    expect(mails).toHaveLength(2);
    expect(await prisma.notificationDelivery.findMany({ orderBy: { status: 'asc' } })).toEqual([
      expect.objectContaining({ toEmail: mails[0].to, status: 'PENDING', attempts: 1, sentAt: null }),
      expect.objectContaining({ toEmail: mails[1].to, status: 'SENT', attempts: 0, sentAt: expect.any(Date) }),
    ]);
  });

  it('실제 DB에서 임대한 줄의 성공과 실패가 저장된다', async () => {
    await publish();
    send.mockRejectedValueOnce(new Error('첫 발송 실패'));
    await worker.processDue();
    expect(
      await prisma.notificationDelivery.count({ where: { status: 'SENT', sentAt: { not: null }, attempts: 0 } }),
    ).toBe(1);
    expect(await prisma.notificationDelivery.count({ where: { status: 'PENDING', sentAt: null, attempts: 1 } })).toBe(
      1,
    );
    await makeDue();
    await worker.processDue();
    expect(await prisma.notificationDelivery.count({ where: { status: 'SENT' } })).toBe(2);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('임대 시각이 지난 줄은 다시 골라 보낸다', async () => {
    await prepareReview();
    await approve();
    await prisma.$executeRaw`UPDATE notification_deliveries SET next_attempt_at = clock_timestamp() + interval '5 minutes'`;
    await worker.processDue();
    expect(send).not.toHaveBeenCalled();
    await makeDue();
    await worker.processDue();
    expect(send).toHaveBeenCalledTimes(1);
    expect(await prisma.notificationDelivery.findFirstOrThrow()).toMatchObject({
      status: 'SENT',
      attempts: 0,
      sentAt: expect.any(Date),
    });
  });

  it('프로젝트 이름과 쪽지 제목의 줄바꿈은 메일 제목에 들어가지 않는다', async () => {
    await prisma.project.update({ where: { id: projectId }, data: { name: '검수\r\nBcc: injected@example.com' } });
    await publish();
    const issueId = await createIssue(client.cookie, '수정\r\nCc: injected@example.com');
    await submit(issueId);
    await worker.processDue();
    expect(mails).toHaveLength(3);
    for (const mail of mails) {
      expect(mail.subject).toMatch(/^\[Client Review\]/);
      expect(mail.subject).not.toMatch(/[\r\n]/);
    }
  });

  it('게시·고쳤어요·승인 메일은 그 버전이나 쪽지를 여는 링크를 담는다', async () => {
    await publish();
    const issueId = await createIssue();
    const resolution = await submit(issueId);
    await post(`/api/issues/${issueId}/verify`, client.cookie)
      .send({ versionId, attemptId: resolution.body.attempts[0].id })
      .expect(200);
    await approve();
    await worker.processDue();
    const room = `${appUrl}/app/projects/${projectId}`;
    expect(mails).toHaveLength(4);
    expect(mails.filter(({ subject }) => subject.includes('올라왔어요'))).toEqual([
      expect.objectContaining({ text: expect.stringContaining(`${room}?version=${versionId}`) }),
      expect.objectContaining({ text: expect.stringContaining(`${room}?version=${versionId}`) }),
    ]);
    expect(mails.find(({ subject }) => subject.includes('고쳤어요'))).toMatchObject({
      to: client.email,
      text: expect.stringContaining(`${room}?issue=${issueId}`),
    });
    expect(mails.find(({ subject }) => subject.includes('승인됐어요'))).toMatchObject({
      to: developer.email,
      text: expect.stringContaining(`${room}?version=${versionId}`),
    });
    expect(JSON.stringify(mails)).not.toContain('메일에 넣지 않을');
  });

  it('로그인 코드 메일이 실패해도 코드 요청은 204이고 메일을 기다리지 않는다', async () => {
    const release = deferred();
    send.mockImplementationOnce(async (mail) => {
      mails.push(mail);
      await release.promise;
    });
    try {
      await post('/api/auth/email-code')
        .send({ email: client.email, privacyAgreed: true })
        .timeout({ deadline: 2_000 })
        .expect(204);
      expect(mails).toHaveLength(1);
      const code = mails[0].text.match(/\b\d{6}\b/)?.[0];
      expect(code).toMatch(/^\d{6}$/);
      expect(await prisma.loginCode.count({ where: { email: client.email } })).toBe(1);
      release.reject(new Error(mails[0].text));
      await vi.waitFor(() => expect(logs.join('\n')).toContain(client.email));
      expect(logs.join('\n')).not.toContain(code);
      send.mockImplementationOnce(async (mail) => {
        mails.push(mail);
        throw new Error(mail.text);
      });
      await post('/api/auth/email-code')
        .send({ email: approver.email, privacyAgreed: true })
        .timeout({ deadline: 2_000 })
        .expect(204);
      await vi.waitFor(() => expect(logs.join('\n')).toContain(approver.email));
      const secondCode = mails[1].text.match(/\b\d{6}\b/)?.[0];
      expect(secondCode).toMatch(/^\d{6}$/);
      expect(logs.join('\n')).not.toContain(secondCode);
      expect(logs.join('\n')).toContain('메일을 보내지 못했어요');
      await post('/api/auth/email-code')
        .send({ email: 'unknown@example.com', privacyAgreed: true })
        .timeout({ deadline: 2_000 })
        .expect(204);
      expect(send).toHaveBeenCalledTimes(2);
      expect(await prisma.notificationDelivery.count()).toBe(0);
    } finally {
      release.resolve();
    }
  });

  it('초대 메일이 실패해도 초대는 201이고 링크를 돌려준다', async () => {
    const release = deferred();
    send.mockImplementationOnce(async (mail) => {
      mails.push(mail);
      await release.promise;
    });
    try {
      const pending = await post(`/api/projects/${projectId}/invitations`)
        .send({ email: 'pending@example.com' })
        .timeout({ deadline: 2_000 })
        .expect(201);
      expect(pending.body.link).toMatch(/^https:\/\/review\.example\.com\/app\/invite\/[A-Za-z0-9_-]{43}$/);
      expect(mails).toHaveLength(1);
      expect(mails[0].text).toContain(pending.body.link);
      release.reject(new Error(mails[0].text));
      await vi.waitFor(() => expect(logs.join('\n')).toContain('pending@example.com'));
      send.mockImplementationOnce(async (mail) => {
        mails.push(mail);
        throw new Error(mail.text);
      });
      const failed = await post(`/api/projects/${projectId}/invitations`)
        .send({ email: 'failed@example.com' })
        .timeout({ deadline: 2_000 })
        .expect(201);
      await vi.waitFor(() => expect(logs.join('\n')).toContain('failed@example.com'));
      for (const response of [pending, failed]) {
        const token = new URL(response.body.link).pathname.split('/').at(-1)!;
        expect(logs.join('\n')).not.toContain(token);
        expect(logs.join('\n')).not.toContain(response.body.link);
        await request(server).get(`/api/invitations/${token}`).expect(200);
      }
      expect(logs.join('\n')).toContain('메일을 보내지 못했어요');
      expect(await prisma.invitation.count()).toBe(2);
      expect(await prisma.notificationDelivery.count()).toBe(0);
    } finally {
      release.resolve();
    }
  });

  it('프로젝트 잠금을 기다린 철회의 사건 시각은 잠금이 풀린 뒤이고 기록 메일에도 그 시각이 적힌다', async () => {
    let pending: Promise<PromiseSettledResult<request.Response>[]> | undefined;
    let releaseTime!: Date;
    try {
      await prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM projects WHERE id = ${projectId}::uuid FOR UPDATE`;
          const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          pending = Promise.allSettled([
            (async () => await post(`/api/members/${client.memberId}/revoke`).timeout({ deadline: 5_000 }))(),
          ]);
          await vi.waitFor(
            async () => {
              const [{ waiting }] = await prisma.$queryRaw<{ waiting: boolean }[]>`
            SELECT EXISTS (
              SELECT 1 FROM pg_stat_activity
              WHERE datname = current_database() AND ${pid}::int = ANY(pg_blocking_pids(pid))
                AND query ILIKE '%projects%'
            ) AS waiting
          `;
              expect(waiting).toBe(true);
            },
            { timeout: 2_000, interval: 20 },
          );
          await delay(100);
          const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
          releaseTime = now;
        },
        { maxWait: 5_000, timeout: 10_000 },
      );
    } finally {
      await pending;
    }
    const [result] = await pending!;
    if (result.status === 'rejected') throw result.reason;
    expect(result.value.status).toBe(204);
    const event = await prisma.activityEvent.findFirstOrThrow({ where: { type: 'MEMBER_REVOKED' } });
    expect(event.createdAt.getTime()).toBeGreaterThanOrEqual(releaseTime.getTime());
    await worker.processDue();
    expect(mails).toEqual([
      expect.objectContaining({
        to: developer.email,
        text: expect.stringContaining(`시각: ${event.createdAt.toISOString()}`),
      }),
    ]);
  });

  it('받을 클라이언트나 대체 승인자가 없으면 우편함에 줄을 넣지 않는다', async () => {
    await prisma.project.update({ where: { id: projectId }, data: { approverMemberId: null } });
    await prisma.projectMember.updateMany({ where: { projectId, role: 'CLIENT' }, data: { revokedAt: new Date() } });
    await publish();
    const issueId = await createIssue(developer.cookie);
    await submit(issueId);
    expect(await prisma.notificationDelivery.count()).toBe(0);
    await worker.processDue();
    expect(send).not.toHaveBeenCalled();
  });

  it('우편함에 넣은 뒤 이메일이 바뀌거나 접근이 철회돼도 넣을 때 주소로 보낸다', async () => {
    await publish();
    await prisma.user.update({ where: { id: client.id }, data: { email: 'changed@example.com' } });
    await post(`/api/members/${client.memberId}/revoke`).expect(204);
    await worker.processDue();
    expect(
      mails
        .filter(({ subject }) => subject.includes('올라왔어요'))
        .map(({ to }) => to)
        .sort(),
    ).toEqual([approver.email, client.email]);
    await request(server).get(`/api/projects/${projectId}`).set('Cookie', client.cookie).expect(404);
  });

  it('한 번에 최대 20통을 보내고 남은 메일은 다음 실행에서 보낸다', async () => {
    await publish();
    for (let index = 0; index < 10; index += 1) {
      const draft = await post(`/api/projects/${projectId}/versions`).expect(201);
      versionId = draft.body.id;
      await publish();
    }
    expect(await prisma.notificationDelivery.count()).toBe(22);
    await worker.processDue();
    expect(send).toHaveBeenCalledTimes(20);
    expect(await prisma.notificationDelivery.count({ where: { status: 'PENDING', attempts: 0 } })).toBe(2);
    await worker.processDue();
    expect(send).toHaveBeenCalledTimes(22);
    expect(await prisma.notificationDelivery.count({ where: { status: 'SENT' } })).toBe(22);
  });

  it('같은 작업자의 앞 실행이 발송 중이면 겹친 실행은 건너뛴다', async () => {
    await publish();
    const release = deferred();
    send.mockImplementationOnce(async (mail) => {
      mails.push(mail);
      await release.promise;
    });
    const pending = Promise.allSettled([worker.processDue()]);
    try {
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      await worker.processDue();
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      expect(await pending).toEqual([{ status: 'fulfilled', value: undefined }]);
    }
    expect(send).toHaveBeenCalledTimes(2);
    expect(await prisma.notificationDelivery.count({ where: { status: 'SENT' } })).toBe(2);
  });

  it('앱 초기화만으로 반복하지 않고 start 뒤 10초마다 보내며 앱 종료 때 멈춘다', async () => {
    await publish();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const scheduledApp = await createApp();
    const scheduledWorker = scheduledApp.get(NotificationsService);
    const process = vi.spyOn(scheduledWorker, 'processDue');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(process).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    scheduledWorker.start();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(process).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(async () => {
      expect(await prisma.notificationDelivery.count({ where: { status: 'SENT' } })).toBe(2);
    });
    expect(process).toHaveBeenCalledTimes(1);
    await process.mock.results[0].value;
    await vi.advanceTimersByTimeAsync(10_000);
    // 실행이 끝난 뒤 앱의 실제 종료 훅으로 타이머를 정리한다.
    await process.mock.results[1].value;
    expect(process).toHaveBeenCalledTimes(2);
    await scheduledApp.close();
    apps = apps.filter((app) => app !== scheduledApp);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(process).toHaveBeenCalledTimes(2);
  });
});
