import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { Logger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { createSessionToken, hashSessionToken } from '../src/auth/token.js';
import { CleanupService } from '../src/cleanup/cleanup.service.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import { MailService } from '../src/mail/mail.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { setupApp } from '../src/setup-app.js';
import { resetDatabase } from './reset-database.js';

const origin = 'http://localhost:5173';
const dayMs = 24 * 60 * 60 * 1000;

describe('정리 작업 (e2e)', () => {
  let app: INestApplication | undefined;
  let server: Server;
  let prisma: PrismaService;
  let cleanup: CleanupService;
  let directory: string;
  let developerId: string;
  let now: Date;

  const daysAgo = (days: number) => new Date(now.getTime() - days * dayMs);

  const login = async (userId: string) => {
    const token = createSessionToken();
    await prisma.session.create({
      data: { userId, tokenHash: hashSessionToken(token), expiresAt: daysAgo(-1) },
    });
    return `sid=${token}`;
  };

  const restore = async (projectId: string) => {
    const cookie = await login(developerId);
    return request(server).post(`/api/projects/${projectId}/restore`).set('Origin', origin).set('Cookie', cookie);
  };

  const writePhoto = async (folder: string, filename: string, ageMs = 0) => {
    await mkdir(join(directory, folder), { recursive: true });
    const path = join(directory, folder, filename);
    await writeFile(path, 'cleanup e2e photo');
    const modifiedAt = new Date(now.getTime() - ageMs);
    await utimes(path, modifiedAt, modifiedAt);
    return path;
  };

  // 실제 외래키가 얽힌 사진·버전·일지·우편함도 함께 준비한다.
  const createProject = async () => {
    const project = await prisma.project.create({
      data: { name: '정리 검수 프로젝트', members: { create: { userId: developerId, role: 'DEVELOPER' } } },
    });
    const photo = await writePhoto(project.id, 'screen.png', 2 * 60 * 60 * 1000);
    const asset = await prisma.asset.create({
      data: {
        projectId: project.id,
        storageKey: `${project.id}/screen.png`,
        mime: 'image/png',
        bytes: 17,
        width: 1,
        height: 1,
      },
    });
    const screen = await prisma.screen.create({ data: { projectId: project.id, name: '첫 화면', viewport: 'PC' } });
    const version = await prisma.deliveryVersion.create({
      data: { projectId: project.id, number: 1, status: 'IN_REVIEW', publishedAt: now },
    });
    const versionScreen = await prisma.versionScreen.create({
      data: { versionId: version.id, screenId: screen.id, assetId: asset.id },
    });
    await prisma.project.update({ where: { id: project.id }, data: { currentVersionId: version.id } });
    const event = await prisma.activityEvent.create({
      data: { projectId: project.id, actorId: developerId, type: 'VERSION_PUBLISHED', versionId: version.id },
    });
    await prisma.notificationDelivery.create({ data: { eventId: event.id, toEmail: 'developer@example.com' } });
    return {
      projectId: project.id,
      versionId: version.id,
      versionScreenId: versionScreen.id,
      eventId: event.id,
      photo,
    };
  };

  const markDeleted = async (projectId: string, days = 8) => {
    await prisma.project.update({
      where: { id: projectId },
      data: { status: 'DELETE_PENDING', statusBeforeDelete: 'ACTIVE', deleteRequestedAt: daysAgo(days) },
    });
  };

  const readProject = (projectId: string) =>
    prisma.project.findUnique({
      where: { id: projectId },
      include: {
        members: { orderBy: { id: 'asc' } },
        screens: { orderBy: { id: 'asc' } },
        versions: { orderBy: { id: 'asc' }, include: { screens: true, approval: true } },
        assets: { orderBy: { id: 'asc' } },
        issues: { orderBy: { id: 'asc' }, include: { comments: true, attachments: true, attempts: true } },
        invitations: { orderBy: { id: 'asc' } },
        activities: { orderBy: { id: 'asc' }, include: { deliveries: true } },
      },
    });

  // 고정 시간만 기다리지 않고, 이 트랜잭션의 잠금에 다른 연결이 실제로 막혔는지 확인한다.
  const waitForProjectLock = async (tx: Prisma.TransactionClient) => {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      await tx.$executeRaw`SELECT pg_stat_clear_snapshot()`;
      const [row] = await tx.$queryRaw<{ waiting: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database() AND pg_backend_pid() = ANY(pg_blocking_pids(pid))
            AND query LIKE '%projects%' AND wait_event_type = 'Lock'
        ) AS waiting`;
      if (row.waiting) return;
      await delay(20);
    }
    throw new Error('프로젝트 잠금을 기다리는 요청이 없어요');
  };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'cleanup-e2e-'));
    vi.stubEnv('ASSET_DIR', directory);
    vi.stubEnv('APP_ORIGINS', origin);
    vi.stubEnv('APP_URL', origin);
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
    cleanup = app.get(CleanupService);
    await resetDatabase(prisma);
    [{ now }] = await prisma.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    developerId = (await prisma.user.create({ data: { email: 'developer@example.com', name: '개발자' } })).id;
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

  it('7일 지난 삭제 대기 프로젝트는 DB 줄과 사진 폴더가 모두 지워지고 다른 프로젝트는 남는다', async () => {
    const deleted = await createProject();
    const kept = await createProject();
    const client = await prisma.user.create({ data: { email: 'client@example.com', name: '클라이언트' } });
    const member = await prisma.projectMember.create({
      data: { projectId: deleted.projectId, userId: client.id, role: 'CLIENT' },
    });
    await prisma.project.update({ where: { id: deleted.projectId }, data: { approverMemberId: member.id } });
    const issue = await prisma.issue.create({
      data: {
        projectId: deleted.projectId,
        number: 1,
        originVersionId: deleted.versionId,
        originVersionScreenId: deleted.versionScreenId,
        xRatio: 0,
        yRatio: 1,
        authorId: client.id,
        title: '수정 요청',
        body: '고쳐 주세요',
        requestId: randomUUID(),
      },
    });
    await prisma.comment.create({
      data: {
        issueId: issue.id,
        authorId: developerId,
        versionId: deleted.versionId,
        body: '확인했어요',
        requestId: randomUUID(),
      },
    });
    const attachment = await prisma.asset.create({
      data: {
        projectId: deleted.projectId,
        storageKey: `${deleted.projectId}/reference.png`,
        mime: 'image/png',
        bytes: 17,
        width: 1,
        height: 1,
      },
    });
    await writePhoto(deleted.projectId, 'reference.png');
    await prisma.issueAttachment.create({ data: { issueId: issue.id, assetId: attachment.id } });
    await prisma.resolutionAttempt.create({
      data: {
        issueId: issue.id,
        versionId: deleted.versionId,
        versionScreenId: deleted.versionScreenId,
        summary: '고쳤어요',
        submittedById: developerId,
      },
    });
    await prisma.approval.create({ data: { versionId: deleted.versionId, approverId: client.id, summary: [] } });
    await prisma.activityEvent.create({
      data: {
        projectId: deleted.projectId,
        actorId: developerId,
        type: 'ISSUE_CREATED',
        issueId: issue.id,
        memberId: member.id,
        versionId: deleted.versionId,
      },
    });
    await prisma.invitation.create({
      data: {
        projectId: deleted.projectId,
        invitedById: developerId,
        email: 'invitee@example.com',
        tokenHash: hashSessionToken(createSessionToken()),
        expiresAt: daysAgo(-1),
      },
    });
    await markDeleted(deleted.projectId, 7);
    const before = await readProject(kept.projectId);

    await cleanup.runOnce();

    expect(await readProject(deleted.projectId)).toBeNull();
    await expect(stat(join(directory, deleted.projectId))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readProject(kept.projectId)).toEqual(before);
    expect(await readFile(kept.photo, 'utf8')).toBe('cleanup e2e photo');
    expect(await prisma.projectMember.count()).toBe(1);
    expect(await prisma.screen.count()).toBe(1);
    expect(await prisma.deliveryVersion.count()).toBe(1);
    expect(await prisma.versionScreen.count()).toBe(1);
    expect(await prisma.asset.count()).toBe(1);
    expect(await prisma.activityEvent.count()).toBe(1);
    expect(await prisma.notificationDelivery.count()).toBe(1);
    expect(await prisma.invitation.count()).toBe(0);
    expect(await prisma.issue.count()).toBe(0);
    expect(await prisma.comment.count()).toBe(0);
    expect(await prisma.issueAttachment.count()).toBe(0);
    expect(await prisma.resolutionAttempt.count()).toBe(0);
    expect(await prisma.approval.count()).toBe(0);
    expect(await prisma.user.count()).toBe(2);
  });

  it('7일 안 된 삭제 대기 프로젝트와 보관한 프로젝트는 지우지 않는다', async () => {
    const recent = await createProject();
    const archived = await createProject();
    await markDeleted(recent.projectId, 7 - 1 / 24);
    await prisma.project.update({
      where: { id: archived.projectId },
      data: { status: 'ARCHIVED', createdAt: daysAgo(90) },
    });
    const before = await Promise.all([readProject(recent.projectId), readProject(archived.projectId)]);

    await cleanup.runOnce();

    expect(await Promise.all([readProject(recent.projectId), readProject(archived.projectId)])).toEqual(before);
    expect(await readFile(recent.photo, 'utf8')).toBe('cleanup e2e photo');
    expect(await readFile(archived.photo, 'utf8')).toBe('cleanup e2e photo');
  });

  it('정리 작업이 고른 뒤 되살린 프로젝트는 지우지 않는다', async () => {
    const project = await createProject();
    const before = await readProject(project.projectId);
    await markDeleted(project.projectId);
    let pending: Promise<void> | undefined;
    try {
      await prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM projects WHERE id = ${project.projectId}::uuid FOR UPDATE`;
          pending = cleanup.runOnce();
          await waitForProjectLock(tx);
          // 정리 대상 조회에는 이전 상태가 보이고, 잠금을 얻었을 때는 되살린 상태가 보이게 한다.
          await tx.project.update({
            where: { id: project.projectId },
            data: { status: 'ACTIVE', statusBeforeDelete: null, deleteRequestedAt: null },
          });
        },
        { timeout: 10_000 },
      );
    } finally {
      await pending;
    }
    expect(await readProject(project.projectId)).toEqual(before);
    expect(await readFile(project.photo, 'utf8')).toBe('cleanup e2e photo');
  }, 20_000);

  it('사진 폴더를 지우지 못하면 DB 줄이 남고 되살릴 수 없으며 다음 정리 때 끝까지 지워진다', async () => {
    const project = await createProject();
    await markDeleted(project.projectId);
    const before = await readProject(project.projectId);
    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    const folder = join(directory, project.projectId);
    await chmod(folder, 0o500);
    try {
      await cleanup.runOnce();
      expect(await readProject(project.projectId)).toEqual(before);
      expect(await readFile(project.photo, 'utf8')).toBe('cleanup e2e photo');
      expect(log).toHaveBeenCalledWith(expect.stringContaining(project.projectId));
      const response = await restore(project.projectId);
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('RESTORE_PERIOD_OVER');
      expect(await readProject(project.projectId)).toEqual(before);
    } finally {
      await chmod(folder, 0o700);
    }

    await cleanup.runOnce();

    expect(await readProject(project.projectId)).toBeNull();
    await expect(stat(folder)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('한 프로젝트의 사진 폴더를 지우지 못해도 다른 프로젝트와 30일 지난 기록은 정리한다', async () => {
    const blocked = await createProject();
    const deleted = await createProject();
    await markDeleted(blocked.projectId);
    await markDeleted(deleted.projectId);
    const expired = await prisma.loginCode.create({
      data: { email: 'old@example.com', codeHash: 'test-only-hash', expiresAt: daysAgo(31) },
    });
    const before = await readProject(blocked.projectId);
    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    const folder = join(directory, blocked.projectId);
    await chmod(folder, 0o500);
    try {
      await cleanup.runOnce();
      expect(await readProject(blocked.projectId)).toEqual(before);
      expect(await readProject(deleted.projectId)).toBeNull();
      await expect(stat(join(directory, deleted.projectId))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await prisma.loginCode.findUnique({ where: { id: expired.id } })).toBeNull();
      expect(log).toHaveBeenCalledWith(expect.stringContaining(blocked.projectId));
    } finally {
      await chmod(folder, 0o700);
    }
  });

  it('사진을 지운 뒤 DB 줄 지우기가 실패해도 되살릴 수 없고 다음 정리 때 끝까지 지워진다', async () => {
    const project = await createProject();
    await markDeleted(project.projectId);
    const before = await readProject(project.projectId);
    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    try {
      await prisma.$executeRaw`
        CREATE FUNCTION cleanup_e2e_fail_delete() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'cleanup e2e delete failure';
        END;
        $$`;
      await prisma.$executeRaw`
        CREATE TRIGGER cleanup_e2e_fail_delete BEFORE DELETE ON projects
        FOR EACH ROW EXECUTE FUNCTION cleanup_e2e_fail_delete()`;

      await cleanup.runOnce();

      expect(await readProject(project.projectId)).toEqual(before);
      await expect(stat(join(directory, project.projectId))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(log).toHaveBeenCalledWith(expect.stringContaining('cleanup e2e delete failure'));
      const response = await restore(project.projectId);
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('RESTORE_PERIOD_OVER');
      expect(await readProject(project.projectId)).toEqual(before);
    } finally {
      await prisma.$executeRaw`DROP TRIGGER IF EXISTS cleanup_e2e_fail_delete ON projects`;
      await prisma.$executeRaw`DROP FUNCTION IF EXISTS cleanup_e2e_fail_delete()`;
    }

    // 폴더가 이미 없어도 재시도가 성공해야 한다.
    await cleanup.runOnce();

    expect(await readProject(project.projectId)).toBeNull();
    expect(await prisma.asset.count()).toBe(0);
    expect(await prisma.notificationDelivery.count()).toBe(0);
  });

  it('DB에 없는 1시간 넘은 사진 파일은 지우고 1시간 안 된 파일과 DB에 있는 파일은 남긴다', async () => {
    const project = await createProject();
    const old = await writePhoto(project.projectId, 'orphan.png', 61 * 60 * 1000);
    const recent = await writePhoto(project.projectId, 'uploading.png', 59 * 60 * 1000);
    const missingProjectId = randomUUID();
    const abandoned = await writePhoto(missingProjectId, 'orphan.png', 2 * 60 * 60 * 1000);
    const before = await readProject(project.projectId);

    await cleanup.runOnce();

    await expect(stat(old)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(abandoned)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(recent, 'utf8')).toBe('cleanup e2e photo');
    expect(await readFile(project.photo, 'utf8')).toBe('cleanup e2e photo');
    expect(await readdir(join(directory, missingProjectId))).toEqual([]);
    expect(await readProject(project.projectId)).toEqual(before);
  });

  it('30일 지난 세션·로그인 코드·초대·메일 줄은 지우고 30일 안 된 줄과 보낼 메일은 남긴다', async () => {
    const project = await createProject();
    const sessions = await prisma.session.createManyAndReturn({
      data: [
        {
          userId: developerId,
          tokenHash: randomUUID(),
          // 만료 기준으로는 30일이 지났지만, 마지막 사용 + 24시간 기준으로는 아직이다.
          expiresAt: daysAgo(30.5),
          lastSeenAt: daysAgo(30.75),
          createdAt: daysAgo(60),
        },
        {
          userId: developerId,
          tokenHash: randomUUID(),
          expiresAt: daysAgo(29),
          lastSeenAt: daysAgo(30),
          createdAt: daysAgo(60),
        },
        {
          userId: developerId,
          tokenHash: randomUUID(),
          expiresAt: daysAgo(-1),
          lastSeenAt: now,
          createdAt: daysAgo(60),
        },
      ],
    });
    const codes = await prisma.loginCode.createManyAndReturn({
      data: [
        { email: 'old@example.com', codeHash: 'test-only-hash', expiresAt: daysAgo(31), createdAt: daysAgo(60) },
        { email: 'recent@example.com', codeHash: 'test-only-hash', expiresAt: daysAgo(29), createdAt: daysAgo(60) },
        { email: 'active@example.com', codeHash: 'test-only-hash', expiresAt: daysAgo(-1), createdAt: daysAgo(60) },
      ],
    });
    const invitations = await prisma.invitation.createManyAndReturn({
      data: [
        { email: 'old-expired@example.com', expiresAt: daysAgo(31) },
        { email: 'old-accepted@example.com', expiresAt: daysAgo(29), acceptedAt: daysAgo(31) },
        { email: 'old-revoked@example.com', expiresAt: daysAgo(-1), revokedAt: daysAgo(31) },
        { email: 'recent-expired@example.com', expiresAt: daysAgo(29) },
        { email: 'recent-accepted@example.com', expiresAt: daysAgo(-1), acceptedAt: daysAgo(29) },
        { email: 'recent-revoked@example.com', expiresAt: daysAgo(-1), revokedAt: daysAgo(29) },
        { email: 'active@example.com', expiresAt: daysAgo(-1) },
      ].map((data) => ({
        ...data,
        projectId: project.projectId,
        invitedById: developerId,
        tokenHash: randomUUID(),
        createdAt: daysAgo(60),
      })),
    });
    const deliveries = await prisma.notificationDelivery.createManyAndReturn({
      data: [
        // SENT는 nextAttemptAt보다 sentAt을 우선하고 FAILED는 nextAttemptAt을 쓴다.
        { toEmail: 'old-sent@example.com', status: 'SENT' as const, sentAt: daysAgo(31), nextAttemptAt: now },
        { toEmail: 'old-failed@example.com', status: 'FAILED' as const, nextAttemptAt: daysAgo(31) },
        {
          toEmail: 'recent-sent@example.com',
          status: 'SENT' as const,
          sentAt: daysAgo(29),
          nextAttemptAt: daysAgo(31),
        },
        { toEmail: 'recent-failed@example.com', status: 'FAILED' as const, nextAttemptAt: daysAgo(29) },
        { toEmail: 'pending@example.com', status: 'PENDING' as const, nextAttemptAt: daysAgo(60) },
      ].map((data) => ({ ...data, eventId: project.eventId, createdAt: daysAgo(60) })),
    });
    const originalDelivery = await prisma.notificationDelivery.findFirstOrThrow({
      where: { toEmail: 'developer@example.com' },
    });

    await cleanup.runOnce();

    const keptSessions = sessions.filter((session) => session.expiresAt >= daysAgo(30));
    expect(await prisma.session.count()).toBe(keptSessions.length);
    expect(await prisma.session.findMany()).toEqual(expect.arrayContaining(keptSessions));
    const keptCodes = codes.filter((code) => code.expiresAt >= daysAgo(30));
    expect(await prisma.loginCode.count()).toBe(keptCodes.length);
    expect(await prisma.loginCode.findMany()).toEqual(expect.arrayContaining(keptCodes));
    const keptInvitations = invitations.filter((invitation) => !invitation.email.startsWith('old-'));
    expect(await prisma.invitation.count()).toBe(keptInvitations.length);
    expect(await prisma.invitation.findMany()).toEqual(expect.arrayContaining(keptInvitations));
    const keptDeliveries = [originalDelivery, ...deliveries.filter((delivery) => !delivery.toEmail.startsWith('old-'))];
    expect(await prisma.notificationDelivery.count()).toBe(keptDeliveries.length);
    expect(await prisma.notificationDelivery.findMany()).toEqual(expect.arrayContaining(keptDeliveries));
    expect(await prisma.activityEvent.findUnique({ where: { id: project.eventId } })).not.toBeNull();
    expect(await prisma.user.count()).toBe(1);
  });

  it('초대 수락이 초대를 찾은 뒤 정리 작업이 그 초대를 지우면 수락은 404다', async () => {
    const project = await createProject();
    const invitee = await prisma.user.create({ data: { email: 'invitee@example.com', name: '초대받은 사람' } });
    const cookie = await login(invitee.id);
    const token = createSessionToken();
    const invitation = await prisma.invitation.create({
      data: {
        projectId: project.projectId,
        invitedById: developerId,
        email: invitee.email,
        tokenHash: hashSessionToken(token),
        expiresAt: daysAgo(31),
      },
    });
    const before = await readProject(project.projectId);
    let pending: Promise<request.Response> | undefined;
    try {
      await prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM projects WHERE id = ${project.projectId}::uuid FOR UPDATE`;
          pending = (async () =>
            request(server)
              .post('/api/invitations/accept')
              .set('Origin', origin)
              .set('Cookie', cookie)
              .send({ token }))();
          await waitForProjectLock(tx);
          await cleanup.runOnce();
          expect(await prisma.invitation.findUnique({ where: { id: invitation.id } })).toBeNull();
        },
        { timeout: 10_000 },
      );
    } finally {
      await pending;
    }
    const response = await pending;
    expect(response?.status).toBe(404);
    expect(response?.body).toEqual({ statusCode: 404, message: '사용할 수 없는 초대예요', error: 'Not Found' });
    expect(await readProject(project.projectId)).toEqual({ ...before, invitations: [] });
    expect(
      await prisma.projectMember.findUnique({
        where: { projectId_userId: { projectId: project.projectId, userId: invitee.id } },
      }),
    ).toBeNull();
  }, 20_000);

  it('오래전에 만료된 초대는 최근에 철회됐어도 만료된 지 30일이 지나면 지운다', async () => {
    const project = await createProject();
    const expired = await prisma.invitation.create({
      data: {
        projectId: project.projectId,
        invitedById: developerId,
        email: 'old@example.com',
        tokenHash: randomUUID(),
        expiresAt: daysAgo(31),
        revokedAt: daysAgo(1),
      },
    });
    const recent = await prisma.invitation.create({
      data: {
        projectId: project.projectId,
        invitedById: developerId,
        email: 'recent@example.com',
        tokenHash: randomUUID(),
        expiresAt: daysAgo(29),
        revokedAt: daysAgo(1),
      },
    });

    await cleanup.runOnce();

    expect(await prisma.invitation.findUnique({ where: { id: expired.id } })).toBeNull();
    expect(await prisma.invitation.findMany()).toEqual([recent]);
  });

  it('24시간 안 써서 끝난 세션은 끝난 지 30일이 지나면 만료 시각 전이어도 지운다', async () => {
    const inactive = await prisma.session.create({
      data: { userId: developerId, tokenHash: randomUUID(), expiresAt: daysAgo(-1), lastSeenAt: daysAgo(32) },
    });
    const recent = await prisma.session.create({
      data: { userId: developerId, tokenHash: randomUUID(), expiresAt: daysAgo(-1), lastSeenAt: daysAgo(30) },
    });

    await cleanup.runOnce();

    expect(await prisma.session.findUnique({ where: { id: inactive.id } })).toBeNull();
    expect(await prisma.session.findMany()).toEqual([recent]);
  });

  it('앞의 정리가 돌고 있으면 다음 정리는 건너뛴다', async () => {
    const project = await createProject();
    await markDeleted(project.projectId);
    const expired = await prisma.loginCode.create({
      data: { email: 'old@example.com', codeHash: 'test-only-hash', expiresAt: daysAgo(31) },
    });
    let first: Promise<void> | undefined;
    let second: Promise<void> | undefined;
    const timeout = new AbortController();
    try {
      await prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM projects WHERE id = ${project.projectId}::uuid FOR UPDATE`;
          first = cleanup.runOnce();
          await waitForProjectLock(tx);
          second = cleanup.runOnce();
          const result = await Promise.race([
            (async () => {
              await second;
              return 'skipped';
            })(),
            delay(1_000, 'waiting', { signal: timeout.signal }),
          ]);
          expect(result).toBe('skipped');
          // 두 번째 실행이 뒤쪽 기록 정리만 따로 진행하지 않았는지도 확인한다.
          expect(await prisma.loginCode.findUnique({ where: { id: expired.id } })).toEqual(expired);
          expect(await readFile(project.photo, 'utf8')).toBe('cleanup e2e photo');
        },
        { timeout: 10_000 },
      );
    } finally {
      timeout.abort();
      await Promise.all([first, second]);
    }
    expect(await readProject(project.projectId)).toBeNull();
    expect(await prisma.loginCode.findUnique({ where: { id: expired.id } })).toBeNull();
    const next = await createProject();
    await markDeleted(next.projectId);
    await cleanup.runOnce();
    expect(await readProject(next.projectId)).toBeNull();
  }, 20_000);

  it('한 사진 파일을 지우지 못해도 다른 폴더의 파일과 30일 지난 기록은 정리한다', async () => {
    const blocked = await writePhoto('a-blocked', 'orphan.png', 2 * 60 * 60 * 1000);
    const deleted = await writePhoto('z-deleted', 'orphan.png', 2 * 60 * 60 * 1000);
    const expired = await prisma.loginCode.create({
      data: { email: 'old@example.com', codeHash: 'test-only-hash', expiresAt: daysAgo(31) },
    });
    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    await chmod(join(directory, 'a-blocked'), 0o500);
    try {
      await cleanup.runOnce();
      expect(await readFile(blocked, 'utf8')).toBe('cleanup e2e photo');
      await expect(stat(deleted)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await prisma.loginCode.findUnique({ where: { id: expired.id } })).toBeNull();
      expect(log).toHaveBeenCalledWith(expect.stringContaining('a-blocked/orphan.png'));
    } finally {
      await chmod(join(directory, 'a-blocked'), 0o700);
    }
    await cleanup.runOnce();
    await expect(stat(blocked)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('사진 폴더 전체를 읽지 못해도 삭제 대기 프로젝트와 30일 지난 기록은 정리한다', async () => {
    const project = await createProject();
    await markDeleted(project.projectId);
    const before = await readProject(project.projectId);
    const expired = await prisma.loginCode.create({
      data: { email: 'old@example.com', codeHash: 'test-only-hash', expiresAt: daysAgo(31) },
    });
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    const originalMode = (await stat(directory)).mode & 0o777;
    try {
      await chmod(directory, 0o000);
      await expect(readdir(directory)).rejects.toMatchObject({ code: 'EACCES' });

      await cleanup.runOnce();

      expect(await prisma.loginCode.findUnique({ where: { id: expired.id } })).toBeNull();
      // 최상위 폴더가 막혀 사진도 지울 수 없으므로 프로젝트 줄은 재시도할 수 있게 남긴다.
      expect(await readProject(project.projectId)).toEqual(before);
    } finally {
      await chmod(directory, originalMode);
    }

    await cleanup.runOnce();

    expect(await readProject(project.projectId)).toBeNull();
    await expect(stat(join(directory, project.projectId))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('사진 폴더 하나를 읽지 못해도 다른 폴더의 DB에 없는 파일은 지운다', async () => {
    const blocked = await writePhoto('a-unreadable', 'orphan.png', 2 * 60 * 60 * 1000);
    const deleted = await writePhoto('z-other', 'orphan.png', 2 * 60 * 60 * 1000);
    const folder = join(directory, 'a-unreadable');
    const originalMode = (await stat(folder)).mode & 0o777;
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    try {
      await chmod(folder, 0o000);
      await expect(readdir(folder)).rejects.toMatchObject({ code: 'EACCES' });

      await cleanup.runOnce();

      await expect(stat(deleted)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await chmod(folder, originalMode);
    }
    expect(await readFile(blocked, 'utf8')).toBe('cleanup e2e photo');
  });

  it('같은 폴더의 사진 파일 하나를 지우지 못해도 나머지 파일은 지운다', async () => {
    const blocked = await writePhoto('orphans', 'a.png', 2 * 60 * 60 * 1000);
    const deleted = await writePhoto('orphans', 'b.png', 2 * 60 * 60 * 1000);
    const runFile = promisify(execFile);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    try {
      await runFile('chflags', ['uchg', blocked]);
      await expect(rm(blocked)).rejects.toMatchObject({ code: 'EPERM' });

      await cleanup.runOnce();

      expect(await readFile(blocked, 'utf8')).toBe('cleanup e2e photo');
      await expect(stat(deleted)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await runFile('chflags', ['nouchg', blocked]);
    }
  });
});
