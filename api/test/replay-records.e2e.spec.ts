import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, utimes } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import bcrypt from 'bcrypt';
import sharp from 'sharp';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { createSessionToken, hashSessionToken } from '../src/auth/token.js';
import { CleanupService } from '../src/cleanup/cleanup.service.js';
import { Prisma, type ActivityType } from '../src/generated/prisma/client.js';
import { MAIL_TRANSPORT, type Mail, type MailTransport } from '../src/mail/mail.service.js';
import { NotificationsService } from '../src/notifications/notifications.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { replayRecords } from '../src/scripts/replay-records.js';
import { withdrawalRecord, withdrawUser } from '../src/scripts/withdraw-user.js';
import { setupApp } from '../src/setup-app.js';
import { resetDatabase } from './reset-database.js';

const origin = 'http://localhost:5173';
const since = '2000-01-01T00:00:00.000000Z';
const projectName = '기록 복원 검수';
const redacted = '[요청으로 지운 내용]';
type Member = { id: string; email: string; name: string; memberId: string; cookie: string };

// 메일 사건은 HTTP로 만들고, 손작업인 글 삭제만 운영 기록 형식으로 쓴다.
const redactionRecord = (target: string, time: string) =>
  ['사건: CONTENT_REDACTED', `사건 id: ${randomUUID()}`, `시각: ${time}`, `대상: ${target}`].join('\n');
const recordId = (text: string) => text.match(/^사건 id: (.+)$/m)![1];
const recordTime = (text: string) => text.match(/^시각: (.+)$/m)![1];

describe('기록 다시 적용 (e2e)', () => {
  let app: INestApplication | undefined;
  let server: Server;
  let prisma: PrismaService;
  let worker: NotificationsService;
  let directory: string;
  let projectId: string;
  let versionId: string;
  let developer: Member;
  let oldApprover: Member;
  let newApprover: Member;
  let mails: Mail[];
  const send = vi.fn<MailTransport>();

  const login = async (userId: string) => {
    const token = createSessionToken();
    await prisma.session.create({
      data: { userId, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 3_600_000) },
    });
    return `sid=${token}`;
  };
  const get = (path: string, cookie = developer.cookie) => request(server).get(path).set('Cookie', cookie);
  const post = (path: string, cookie = developer.cookie) =>
    request(server).post(path).set('Origin', origin).set('Cookie', cookie);
  const replay = (records: string[], cutoff = since) => replayRecords(prisma, records.join('\n\n'), cutoff);
  const dbTime = async () => {
    const [{ time }] = await prisma.$queryRaw<{ time: string }[]>`
      SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS time
    `;
    return time;
  };
  const collectRecords = async (count: number) => {
    const offset = mails.length;
    await worker.processDue();
    const records = mails.slice(offset).filter(({ subject }) => subject.startsWith('[Client Review 기록]'));
    expect(records).toHaveLength(count);
    return records.map(({ text }) => text);
  };
  const accept = async (person: Pick<Member, 'id' | 'email' | 'name' | 'cookie'>) => {
    const invitation = await post(`/api/projects/${projectId}/invitations`).send({ email: person.email }).expect(201);
    const token = new URL(invitation.body.link).pathname.split('/').at(-1)!;
    await post('/api/invitations/accept', person.cookie).send({ token }).expect(200);
    const member = await prisma.projectMember.findUniqueOrThrow({
      where: { projectId_userId: { projectId, userId: person.id } },
    });
    return { ...person, memberId: member.id };
  };
  const inviteNew = async (name = '새 참여자') => {
    const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.com`, name } });
    return accept({ ...user, cookie: await login(user.id) });
  };
  const revoke = (member = oldApprover) => post(`/api/members/${member.memberId}/revoke`).expect(204);
  const changeApprover = (memberId: string | null) =>
    post(`/api/projects/${projectId}/approver`).send({ memberId }).expect(200);
  const deleteProject = () => post(`/api/projects/${projectId}/delete`).send({ name: projectName }).expect(204);
  const approve = async (cookie: string) => {
    const check = await get(`/api/versions/${versionId}/approval-check`, cookie).expect(200);
    return post(`/api/versions/${versionId}/approve`, cookie).send({ seenAt: check.body.serverTime }).expect(200);
  };
  const expectApprovalDenied = async (cookie: string) => {
    await get(`/api/versions/${versionId}/approval-check`, cookie).expect(403);
    await post(`/api/versions/${versionId}/approve`, cookie)
      .send({ seenAt: await dbTime() })
      .expect(403);
  };
  const restoreMembership = async () => {
    await prisma.$executeRaw`UPDATE project_members SET revoked_at = NULL WHERE project_id = ${projectId}::uuid`;
    await prisma.$executeRaw`
      UPDATE projects SET approver_member_id = ${oldApprover.memberId}::uuid WHERE id = ${projectId}::uuid
    `;
  };
  const restoreActiveProject = () => prisma.$executeRaw`
    UPDATE projects SET status = 'ACTIVE', status_before_delete = NULL, delete_requested_at = NULL
    WHERE id = ${projectId}::uuid
  `;
  // 백업 뒤 생긴 사건(메일 우편함 포함)과 새 참여자를 없애 백업 시점을 흉내 낸다.
  const removeNewMember = async (person: Member) => {
    await prisma.$executeRaw`DELETE FROM activity_events WHERE project_id = ${projectId}::uuid`;
    await prisma.$executeRaw`DELETE FROM invitations WHERE project_id = ${projectId}::uuid AND email = ${person.email}`;
    await prisma.$executeRaw`DELETE FROM project_members WHERE id = ${person.memberId}::uuid`;
    await prisma.$executeRaw`DELETE FROM users WHERE id = ${person.id}::uuid`;
  };
  const setEventTime = async (type: ActivityType, time: string, memberId?: string | null) => {
    const event = await prisma.activityEvent.findFirstOrThrow({
      where: { projectId, type, ...(memberId !== undefined ? { memberId } : {}) },
      orderBy: { createdAt: 'desc' },
    });
    await prisma.$executeRaw`UPDATE activity_events SET created_at = ${time}::timestamptz WHERE id = ${event.id}::uuid`;
    return event.id;
  };
  // 개수뿐 아니라 모든 값과 마이크로초까지 비교한다. 테이블 이름은 아래 고정 목록에서만 온다.
  const readState = async () => {
    const state: Record<string, unknown> = {};
    for (const table of [
      'users',
      'login_codes',
      'sessions',
      'projects',
      'project_members',
      'screens',
      'delivery_versions',
      'assets',
      'version_screens',
      'activity_events',
      'invitations',
      'issues',
      'comments',
      'issue_attachments',
      'resolution_attempts',
      'approvals',
      'notification_deliveries',
    ]) {
      state[table] = await prisma.$queryRaw(
        Prisma.sql`SELECT to_jsonb(t) AS row FROM ${Prisma.raw(table)} t ORDER BY id`,
      );
    }
    return state;
  };
  const expectLoginDenied = async (email: string) => {
    const offset = mails.length;
    await post('/api/auth/email-code').send({ email, privacyAgreed: true }).expect(204);
    expect(mails.slice(offset).filter((mail) => mail.to === email)).toEqual([]);
    // 메일을 못 받아도 코드를 맞힌 경우까지 기존 탈퇴 e2e와 같은 방법으로 확인한다.
    const code = '314159';
    await prisma.loginCode.update({ where: { email }, data: { codeHash: await bcrypt.hash(code, 12) } });
    const response = await post('/api/auth/verify-code').send({ email, code, name: '다시 로그인' }).expect(422);
    expect(response.body.code).toBe('CODE_WRONG');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
  };
  const failArchiveUpdate = async () => {
    await prisma.$executeRaw`
      CREATE FUNCTION replay_e2e_fail_archive() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'replay e2e archive failure'; END; $$
    `;
    await prisma.$executeRaw`
      CREATE TRIGGER replay_e2e_fail_archive BEFORE UPDATE ON projects
      FOR EACH ROW WHEN (NEW.status = 'ARCHIVED') EXECUTE FUNCTION replay_e2e_fail_archive()
    `;
  };
  const removeArchiveFailure = async () => {
    await prisma.$executeRaw`DROP TRIGGER IF EXISTS replay_e2e_fail_archive ON projects`;
    await prisma.$executeRaw`DROP FUNCTION IF EXISTS replay_e2e_fail_archive()`;
  };
  const createContent = async () => {
    const issue = await post(`/api/projects/${projectId}/issues`, oldApprover.cookie)
      .send({ versionId, requestId: randomUUID(), title: '개인정보가 든 제목', body: '개인정보가 든 본문' })
      .expect(201);
    const comment = await post(`/api/issues/${issue.body.id}/comments`, oldApprover.cookie)
      .send({ versionId, requestId: randomUUID(), body: '개인정보가 든 댓글' })
      .expect(201);
    const photo = await sharp({ create: { width: 32, height: 24, channels: 3, background: 'red' } })
      .png()
      .toBuffer();
    const attached = await post(`/api/issues/${issue.body.id}/attachments`, oldApprover.cookie)
      .attach('file', photo, 'reference.png')
      .expect(201);
    const attachment = attached.body.attachments[0] as { id: string; assetId: string };
    const asset = await prisma.asset.findUniqueOrThrow({ where: { id: attachment.assetId } });
    return {
      issue: issue.body as { id: string; number: number },
      comment: comment.body as { id: string },
      attachment,
      asset,
    };
  };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'replay-records-e2e-'));
    vi.stubEnv('ASSET_DIR', directory);
    vi.stubEnv('APP_ORIGINS', origin);
    vi.stubEnv('APP_URL', origin);
    vi.stubEnv('DEVELOPER_EMAIL', 'developer@example.com');
    vi.stubEnv('COOKIE_SECURE', undefined);
    mails = [];
    send.mockReset();
    send.mockImplementation(async (mail) => {
      mails.push(mail);
    });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MAIL_TRANSPORT)
      .useValue(send)
      .compile();
    app = module.createNestApplication();
    setupApp(app);
    await app.init();
    server = app.getHttpServer() as Server;
    prisma = app.get(PrismaService);
    worker = app.get(NotificationsService);
    await resetDatabase(prisma);
    projectId = (await prisma.project.create({ data: { name: projectName } })).id;
    const members: Member[] = [];
    for (const [name, role] of [
      ['developer', 'DEVELOPER'],
      ['old', 'CLIENT'],
      ['new', 'CLIENT'],
    ] as const) {
      const user = await prisma.user.create({
        data: { email: `${name}@example.com`, name, lastSeenAt: new Date(), privacyAgreedAt: new Date() },
      });
      const member = await prisma.projectMember.create({ data: { projectId, userId: user.id, role } });
      members.push({ ...user, memberId: member.id, cookie: await login(user.id) });
    }
    [developer, oldApprover, newApprover] = members;
    const version = await prisma.deliveryVersion.create({
      data: { projectId, number: 1, status: 'IN_REVIEW', publishedAt: new Date() },
    });
    versionId = version.id;
    await prisma.project.update({
      where: { id: projectId },
      data: { currentVersionId: versionId, approverMemberId: oldApprover.memberId },
    });
    const screen = await prisma.screen.create({ data: { projectId, name: '첫 화면', viewport: 'PC' } });
    const asset = await prisma.asset.create({
      data: { projectId, storageKey: `${projectId}/screen.png`, mime: 'image/png', bytes: 100, width: 32, height: 24 },
    });
    await prisma.versionScreen.create({ data: { versionId, screenId: screen.id, assetId: asset.id } });
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

  it('철회 기록을 적용하면 그 멤버는 철회되고 승인자 칸이 비고 그 사람은 프로젝트를 볼 수 없다', async () => {
    await revoke();
    const [record] = await collectRecords(1);
    await restoreMembership();
    await get(`/api/projects/${projectId}`, oldApprover.cookie).expect(200);

    expect(await replay([record])).toEqual({ applied: 1, skippedBeforeSince: 0, skipped: [] });

    const [member] = await prisma.$queryRaw<{ revokedAt: string }[]>`
      SELECT to_char(revoked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "revokedAt"
      FROM project_members WHERE id = ${oldApprover.memberId}::uuid
    `;
    expect(member.revokedAt).toBe(recordTime(record));
    expect((await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).approverMemberId).toBeNull();
    await get(`/api/projects/${projectId}`, oldApprover.cookie).expect(404);
    await get(`/api/projects/${projectId}`, newApprover.cookie).expect(200);
  });

  it('백업에 없는 멤버는 수락 기록으로 같은 id로 만들고 뒤따르는 철회까지 적용한다', async () => {
    const person = await inviteNew();
    await prisma.$executeRaw`
      UPDATE project_members SET created_at = '2026-11-13T03:04:05.987654Z'::timestamptz WHERE id = ${person.memberId}::uuid
    `;
    const [accepted] = await collectRecords(1);
    await revoke(person);
    const [revoked] = await collectRecords(1);
    await removeNewMember(person);

    expect(await replay([accepted])).toEqual({ applied: 1, skippedBeforeSince: 0, skipped: [] });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: person.id } })).toMatchObject({
      email: person.email,
      name: person.name,
    });
    const [member] = await prisma.$queryRaw<{ id: string; userId: string; role: string; joinedAt: string }[]>`
      SELECT id, user_id AS "userId", role,
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "joinedAt"
      FROM project_members WHERE id = ${person.memberId}::uuid
    `;
    expect(member).toEqual({
      id: person.memberId,
      userId: person.id,
      role: 'CLIENT',
      joinedAt: '2026-11-13T03:04:05.987654Z',
    });
    await get(`/api/projects/${projectId}`, await login(person.id)).expect(200);

    await removeNewMember(person);
    expect(await replay([revoked, accepted])).toEqual({ applied: 2, skippedBeforeSince: 0, skipped: [] });
    expect((await prisma.projectMember.findUniqueOrThrow({ where: { id: person.memberId } })).revokedAt).not.toBeNull();
    await get(`/api/projects/${projectId}`, await login(person.id)).expect(404);
  });

  it('승인자였다가 철회되고 다시 수락한 사람은 일반 참여자로 돌아온다', async () => {
    await revoke();
    await accept(oldApprover);
    const records = await collectRecords(2);
    await restoreMembership();

    expect((await replay(records.reverse())).applied).toBe(2);

    expect(await prisma.projectMember.findUniqueOrThrow({ where: { id: oldApprover.memberId } })).toMatchObject({
      role: 'CLIENT',
      revokedAt: null,
    });
    const detail = await get(`/api/projects/${projectId}`, oldApprover.cookie).expect(200);
    expect(detail.body).toMatchObject({ approver: null, isApprover: false });
    await expectApprovalDenied(oldApprover.cookie);
  });

  it('승인자 바꾸기 기록을 적용하면 옛 승인자의 승인은 거부되고 새 승인자만 승인할 수 있다', async () => {
    await changeApprover(newApprover.memberId);
    const records = await collectRecords(1);
    await restoreMembership();

    expect((await replay(records)).applied).toBe(1);

    await expectApprovalDenied(oldApprover.cookie);
    await approve(newApprover.cookie);
    expect(await prisma.approval.findUniqueOrThrow({ where: { versionId } })).toMatchObject({
      approverId: newApprover.id,
    });
  });

  it('승인자를 비운 기록을 적용하면 아무도 승인할 수 없다', async () => {
    await changeApprover(null);
    const records = await collectRecords(1);
    await restoreMembership();

    expect((await replay(records)).applied).toBe(1);

    expect((await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).approverMemberId).toBeNull();
    for (const person of [developer, oldApprover, newApprover]) await expectApprovalDenied(person.cookie);
    expect(await prisma.approval.count()).toBe(0);
  });

  it('삭제 대기와 되살리기 기록을 시각 순으로 적용하면 마지막 상태가 남고 클라이언트는 지운 프로젝트를 볼 수 없다', async () => {
    await deleteProject();
    const [deleted] = await collectRecords(1);
    await post(`/api/projects/${projectId}/restore`).expect(204);
    const [restored] = await collectRecords(1);
    await deleteProject();
    const [deletedAgain] = await collectRecords(1);
    await restoreActiveProject();

    expect((await replay([restored, deleted])).applied).toBe(2);
    expect(await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).toMatchObject({
      status: 'ACTIVE',
      statusBeforeDelete: null,
      deleteRequestedAt: null,
    });
    await get(`/api/projects/${projectId}`, oldApprover.cookie).expect(200);

    await restoreActiveProject();
    expect((await replay([deletedAgain, restored, deleted])).applied).toBe(3);
    const first = await readState();
    expect((await replay([deletedAgain, restored, deleted])).applied).toBe(3);
    expect(await readState()).toEqual(first);

    const [project] = await prisma.$queryRaw<{ status: string; previous: string; requestedAt: string }[]>`
      SELECT status, status_before_delete AS previous,
        to_char(delete_requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "requestedAt"
      FROM projects WHERE id = ${projectId}::uuid
    `;
    expect(project).toEqual({ status: 'DELETE_PENDING', previous: 'ACTIVE', requestedAt: recordTime(deletedAgain) });
    await get(`/api/projects/${projectId}`, oldApprover.cookie).expect(404);
    await get(`/api/projects/${projectId}`).expect(200);

    await post(`/api/projects/${projectId}/restore`, developer.cookie).expect(204);
    expect(await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).toMatchObject({
      status: 'ACTIVE',
      statusBeforeDelete: null,
      deleteRequestedAt: null,
    });
    await get(`/api/projects/${projectId}`, oldApprover.cookie).expect(200);
  });

  it('탈퇴 기록을 적용하면 계정이 익명화되고 그 이메일로 로그인할 수 없다', async () => {
    await prisma.loginCode.create({
      data: { email: oldApprover.email, codeHash: 'unused', expiresAt: new Date(Date.now() + 600_000) },
    });
    await post(`/api/projects/${projectId}/invitations`).send({ email: 'unused@example.com' }).expect(201);
    // 복원된 백업에 남은 수락한 초대에도 원래 이메일이 남아 있다.
    await prisma.invitation.create({
      data: {
        projectId,
        email: oldApprover.email,
        invitedById: developer.id,
        tokenHash: hashSessionToken(createSessionToken()),
        acceptedAt: new Date(),
        expiresAt: new Date(Date.now() + 600_000),
      },
    });
    const record = withdrawalRecord(oldApprover.id, await dbTime());
    expect(record).not.toContain(oldApprover.email);

    expect(await replay([record])).toEqual({ applied: 1, skippedBeforeSince: 0, skipped: [] });

    expect(await prisma.user.findUniqueOrThrow({ where: { id: oldApprover.id } })).toMatchObject({
      email: `withdrawn-${oldApprover.id}@invalid`,
      name: '탈퇴한 사용자',
      lastSeenAt: null,
      privacyAgreedAt: null,
    });
    expect(await prisma.session.count({ where: { userId: oldApprover.id } })).toBe(0);
    expect(await prisma.loginCode.count({ where: { email: oldApprover.email } })).toBe(0);
    expect(await prisma.invitation.count({ where: { email: oldApprover.email } })).toBe(0);
    expect(
      (await prisma.projectMember.findUniqueOrThrow({ where: { id: oldApprover.memberId } })).revokedAt,
    ).not.toBeNull();
    expect((await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).approverMemberId).toBeNull();
    await get('/api/auth/me', oldApprover.cookie).expect(401);
    await expectLoginDenied(oldApprover.email);
    await get(`/api/projects/${projectId}`, newApprover.cookie).expect(200);
  });

  it('백업 뒤 가입하고 기록 메일이 가기 전에 탈퇴한 사람은 원래 이메일 없이 익명으로 남는다', async () => {
    const person = await inviteNew();
    await withdrawUser(prisma, person.email);
    const withdrawn = withdrawalRecord(person.id, await dbTime());
    const [accepted] = await collectRecords(1);
    expect(accepted).toContain(`대상 이메일: "withdrawn-${person.id}@invalid"`);
    expect(accepted).not.toContain(person.email);
    await removeNewMember(person);

    expect(await replay([withdrawn, accepted])).toEqual({ applied: 2, skippedBeforeSince: 0, skipped: [] });

    expect(await prisma.user.findUniqueOrThrow({ where: { id: person.id } })).toMatchObject({
      email: `withdrawn-${person.id}@invalid`,
      name: '탈퇴한 사용자',
    });
    expect((await prisma.projectMember.findUniqueOrThrow({ where: { id: person.memberId } })).revokedAt).not.toBeNull();
    await expectLoginDenied(person.email);
  });

  it('글 삭제 기록을 적용하면 쪽지·댓글·승인 기록 사본이 바뀌고 참고 사진 줄이 지워진다', async () => {
    const { issue, comment, attachment, asset } = await createContent();
    const other = await post(`/api/projects/${projectId}/issues`, newApprover.cookie)
      .send({ versionId, requestId: randomUUID(), title: '남겨 둘 제목', body: '남겨 둘 본문' })
      .expect(201);
    await post(`/api/issues/${issue.id}/withdraw`, oldApprover.cookie)
      .send({ versionId, reason: '요청 취소' })
      .expect(200);
    await post(`/api/issues/${other.body.id}/withdraw`, newApprover.cookie)
      .send({ versionId, reason: '다른 요청 취소' })
      .expect(200);
    await approve(oldApprover.cookie);
    const approval = await prisma.approval.findUniqueOrThrow({ where: { versionId } });
    const beforeCertificate = await get(`/api/versions/${versionId}/certificate`).expect(200);
    const beforeOther = await get(`/api/issues/${other.body.id}`).expect(200);
    const time = await dbTime();
    const records = [
      `issues.title ${issue.id}`,
      `issues.body ${issue.id}`,
      `comments.body ${comment.id}`,
      `approvals.summary ${approval.id} #${issue.number}`,
      `issue_attachments ${attachment.id}`,
    ].map((target) => redactionRecord(target, time));

    expect(await replay(records)).toEqual({ applied: 5, skippedBeforeSince: 0, skipped: [] });

    const detail = await get(`/api/issues/${issue.id}`).expect(200);
    expect(detail.body).toMatchObject({ title: redacted, body: redacted, attachments: [] });
    expect(detail.body.comments).toContainEqual(expect.objectContaining({ id: comment.id, body: redacted }));
    const certificate = await get(`/api/versions/${versionId}/certificate`).expect(200);
    expect(certificate.body).toEqual({
      ...beforeCertificate.body,
      issues: beforeCertificate.body.issues.map((item: { number: number; title: string }) =>
        item.number === issue.number ? { ...item, title: redacted } : item,
      ),
    });
    await get(`/api/issues/${other.body.id}`).expect(200).expect(beforeOther.body);
    expect(await prisma.issueAttachment.findUnique({ where: { id: attachment.id } })).toBeNull();
    expect(await prisma.asset.findUnique({ where: { id: asset.id } })).toBeNull();
    await get(`/api/assets/${asset.id}`).expect(404);
  });

  it('줄바꿈과 콜론이 있는 이름도 기록 메일에서 다시 적용까지 그대로 옮겨진다', async () => {
    const name = '고객\n사건: MEMBER_REVOKED\r\n"대상 이름": 콜론과 따옴표';
    const person = await inviteNew(name);
    const [record] = await collectRecords(1);
    expect(record).toContain(`대상 이름: ${JSON.stringify(name)}`);
    expect(record.split('\n')).toHaveLength(10);
    await removeNewMember(person);

    expect((await replay([record])).applied).toBe(1);

    const cookie = await login(person.id);
    const me = await get('/api/auth/me', cookie).expect(200);
    expect(me.body).toMatchObject({ id: person.id, name, email: person.email });
    await get(`/api/projects/${projectId}`, cookie).expect(200);
  });

  it('백업에 없는 프로젝트의 기록은 건너뛰고 다른 프로젝트의 철회는 적용한다', async () => {
    const other = await post('/api/projects').send({ name: '백업 뒤 프로젝트' }).expect(201);
    await post(`/api/projects/${other.body.id}/archive`).expect(204);
    const [missing] = await collectRecords(1);
    await revoke();
    const [revoked] = await collectRecords(1);
    await prisma.$executeRaw`DELETE FROM projects WHERE id = ${other.body.id}::uuid`;
    await restoreMembership();

    expect(await replay([missing, revoked])).toEqual({
      applied: 1,
      skippedBeforeSince: 0,
      skipped: [`PROJECT_ARCHIVED ${recordId(missing)}: 복원된 DB에 없는 프로젝트`],
    });

    expect(await prisma.project.findUnique({ where: { id: other.body.id } })).toBeNull();
    await get(`/api/projects/${projectId}`, oldApprover.cookie).expect(404);
  });

  it('백업 뒤 보관했다가 지우고 되살린 프로젝트는 보관 상태로 돌아오고 쓰기가 막힌다', async () => {
    await post(`/api/projects/${projectId}/archive`).expect(204);
    await deleteProject();
    await post(`/api/projects/${projectId}/restore`).expect(204);
    const records = await collectRecords(3);
    await restoreActiveProject();

    expect((await replay(records.reverse())).applied).toBe(3);

    expect(await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).toMatchObject({
      status: 'ARCHIVED',
      statusBeforeDelete: null,
      deleteRequestedAt: null,
    });
    const detail = await get(`/api/projects/${projectId}`, oldApprover.cookie).expect(200);
    expect(detail.body.status).toBe('ARCHIVED');
    const response = await post(`/api/projects/${projectId}/issues`, oldApprover.cookie)
      .send({ versionId, requestId: randomUUID(), title: '보관 뒤 쓰기', body: '' })
      .expect(409);
    expect(response.body.code).toBe('PROJECT_ARCHIVED');
    expect(await prisma.issue.count()).toBe(0);
  });

  it('복원된 DB에 없는 사용자의 탈퇴 기록은 건너뛰고 다른 사람의 철회는 적용한다', async () => {
    const missingUserId = randomUUID();
    const missing = withdrawalRecord(missingUserId, await dbTime());
    await revoke();
    const [revoked] = await collectRecords(1);
    await restoreMembership();

    expect(await replay([missing, revoked])).toEqual({
      applied: 1,
      skippedBeforeSince: 0,
      skipped: [`USER_WITHDRAWN ${recordId(missing)}: 복원된 DB에 없는 사용자`],
    });

    expect(await prisma.user.findUnique({ where: { id: missingUserId } })).toBeNull();
    await get(`/api/projects/${projectId}`, oldApprover.cookie).expect(404);
  });

  it('복원된 DB에 없는 글의 삭제 기록은 건너뛰고 다른 사람의 철회는 적용한다', async () => {
    const time = await dbTime();
    const missing = ['issues.title', 'issues.body', 'comments.body', 'issue_attachments', 'approvals.summary'].map(
      (table) => redactionRecord(`${table} ${randomUUID()}${table === 'approvals.summary' ? ' #1' : ''}`, time),
    );
    await revoke();
    const [revoked] = await collectRecords(1);
    await restoreMembership();

    expect(await replay([...missing, revoked])).toEqual({
      applied: 1,
      skippedBeforeSince: 0,
      skipped: missing.map((record) => `CONTENT_REDACTED ${recordId(record)}: 복원된 DB에 없는 글`),
    });

    await get(`/api/projects/${projectId}`, oldApprover.cookie).expect(404);
    expect(await prisma.issue.count()).toBe(0);
  });

  it('같은 묶음에서 수락으로 만든 사람의 탈퇴도 적용하고 뒤 기록에서 DB 오류가 나면 탈퇴까지 모두 되돌린다', async () => {
    const person = await inviteNew();
    const [accepted] = await collectRecords(1);
    const withdrawn = withdrawalRecord(person.id, await dbTime());
    await post(`/api/projects/${projectId}/archive`).expect(204);
    const [archived] = await collectRecords(1);
    await restoreActiveProject();
    await removeNewMember(person);
    const before = await readState();
    try {
      await failArchiveUpdate();

      await expect(replay([archived, withdrawn, accepted])).rejects.toThrow('replay e2e archive failure');

      expect(await readState()).toEqual(before);
    } finally {
      await removeArchiveFailure();
    }
    expect(await replay([withdrawn, accepted])).toEqual({ applied: 2, skippedBeforeSince: 0, skipped: [] });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: person.id } })).toMatchObject({
      email: `withdrawn-${person.id}@invalid`,
      name: '탈퇴한 사용자',
    });
    expect((await prisma.projectMember.findUniqueOrThrow({ where: { id: person.memberId } })).revokedAt).not.toBeNull();
    await expectLoginDenied(person.email);
  });

  it('참고 사진 삭제 기록은 DB 줄만 지우고 파일은 정리 작업이 지운다', async () => {
    const { issue, attachment, asset } = await createContent();
    const file = join(directory, asset.storageKey);
    const bytes = await readFile(file);
    const old = new Date(Date.now() - 2 * 3_600_000);
    await utimes(file, old, old);
    const deleted = redactionRecord(`issue_attachments ${attachment.id}`, await dbTime());
    await post(`/api/projects/${projectId}/archive`).expect(204);
    const [archived] = await collectRecords(1);
    await restoreActiveProject();
    const before = await readState();
    try {
      await failArchiveUpdate();

      await expect(replay([archived, deleted])).rejects.toThrow('replay e2e archive failure');

      expect(await readState()).toEqual(before);
      expect(await readFile(file)).toEqual(bytes);
    } finally {
      await removeArchiveFailure();
    }

    expect((await replay([deleted])).applied).toBe(1);
    expect(await prisma.issueAttachment.findUnique({ where: { id: attachment.id } })).toBeNull();
    expect(await prisma.asset.findUnique({ where: { id: asset.id } })).toBeNull();
    expect(await readFile(file)).toEqual(bytes);
    const detail = await get(`/api/issues/${issue.id}`).expect(200);
    expect(detail.body.attachments).toEqual([]);
    await get(`/api/assets/${asset.id}`).expect(404);

    await app!.get(CleanupService).runOnce();

    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('기준 시각보다 앞선 기록은 건너뛰고 since가 없으면 실패한다', async () => {
    await changeApprover(newApprover.memberId);
    await setEventTime('APPROVER_CHANGED', '2026-11-14T03:04:05.123455Z');
    const [older] = await collectRecords(1);
    await changeApprover(null);
    await setEventTime('APPROVER_CHANGED', '2026-11-14T03:04:05.123456Z', null);
    const [boundary] = await collectRecords(1);
    await restoreMembership();
    const before = await readState();
    for (const cutoff of [undefined, '', '2026-11-14T03:04:05.123Z']) {
      await expect(replayRecords(prisma, older, cutoff as string)).rejects.toThrow('--since');
      expect(await readState()).toEqual(before);
    }

    expect(await replay([older], '2026-11-14T03:04:05.123456Z')).toEqual({
      applied: 0,
      skippedBeforeSince: 1,
      skipped: [],
    });
    expect(await readState()).toEqual(before);
    expect(await replay([older, boundary], '2026-11-14T03:04:05.123456Z')).toEqual({
      applied: 1,
      skippedBeforeSince: 1,
      skipped: [],
    });
    expect((await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).approverMemberId).toBeNull();
    await expectApprovalDenied(oldApprover.cookie);
    await expectApprovalDenied(newApprover.cookie);
  });

  it('같은 밀리초의 승인자 바꾸기 두 건을 거꾸로 넣어도 마지막 승인자만 승인할 수 있다', async () => {
    await changeApprover(newApprover.memberId);
    await changeApprover(oldApprover.memberId);
    await setEventTime('APPROVER_CHANGED', '2026-11-14T03:04:05.123456Z', newApprover.memberId);
    await setEventTime('APPROVER_CHANGED', '2026-11-14T03:04:05.123457Z', oldApprover.memberId);
    const records = await collectRecords(2);
    const descending = records.sort((a, b) => recordTime(b).localeCompare(recordTime(a)));
    expect(descending.map(recordTime)).toEqual(['2026-11-14T03:04:05.123457Z', '2026-11-14T03:04:05.123456Z']);
    // 백업 당시에는 마지막 사건과 다른 사람이 승인자다.
    await prisma.$executeRaw`UPDATE projects SET approver_member_id = ${newApprover.memberId}::uuid WHERE id = ${projectId}::uuid`;

    expect((await replay(descending)).applied).toBe(2);

    await expectApprovalDenied(newApprover.cookie);
    await approve(oldApprover.cookie);
    expect(await prisma.approval.findUniqueOrThrow({ where: { versionId } })).toMatchObject({
      approverId: oldApprover.id,
    });
  });

  it('사건 id가 다른데 시각이 완전히 같은 기록이 한 프로젝트에 있으면 아무것도 바꾸지 않고 실패한다', async () => {
    await changeApprover(newApprover.memberId);
    await changeApprover(oldApprover.memberId);
    const time = '2026-11-14T03:04:05.123456Z';
    await setEventTime('APPROVER_CHANGED', time, newApprover.memberId);
    await setEventTime('APPROVER_CHANGED', time, oldApprover.memberId);
    const records = await collectRecords(2);
    expect(new Set(records.map(recordId)).size).toBe(2);
    await restoreMembership();
    const before = await readState();

    await expect(replay(records)).rejects.toThrow();

    expect(await readState()).toEqual(before);
    const detail = await get(`/api/projects/${projectId}`, oldApprover.cookie).expect(200);
    expect(detail.body.isApprover).toBe(true);
  });

  it('탈퇴 전후로 두 번 간 같은 사건의 기록은 하나로 치고 익명화된 값을 쓴다', async () => {
    const person = await inviteNew();
    const [original] = await collectRecords(1);
    await withdrawUser(prisma, person.email);
    const withdrawn = withdrawalRecord(person.id, await dbTime());
    // 전송 뒤 완료 기록을 잃어 같은 우편함 항목을 다시 보내는 상황이다.
    await prisma.$executeRaw`
      UPDATE notification_deliveries SET status = 'PENDING', sent_at = NULL, next_attempt_at = clock_timestamp()
      WHERE event_id = ${recordId(original)}::uuid
    `;
    const [anonymous] = await collectRecords(1);
    expect(recordId(anonymous)).toBe(recordId(original));
    expect(anonymous).toContain(`대상 이메일: "withdrawn-${person.id}@invalid"`);
    expect(original).toContain(`대상 이메일: ${JSON.stringify(person.email)}`);
    await removeNewMember(person);

    // 어느 사본을 먼저 붙이든 익명 사본을 골라야 한다. 탈퇴 기록 없이 먼저 확인해 잘못된 선택을 숨기지 않는다.
    for (const copies of [
      [original, anonymous],
      [anonymous, original],
    ]) {
      expect(await replay(copies)).toEqual({ applied: 1, skippedBeforeSince: 0, skipped: [] });
      expect(await prisma.user.findUniqueOrThrow({ where: { id: person.id } })).toMatchObject({
        email: `withdrawn-${person.id}@invalid`,
        name: '탈퇴한 사용자',
      });
      expect(await prisma.user.findUnique({ where: { email: person.email } })).toBeNull();
      await removeNewMember(person);
    }
    expect(await replay([original, withdrawn, anonymous])).toEqual({ applied: 2, skippedBeforeSince: 0, skipped: [] });
    await expectLoginDenied(person.email);
  });

  it('섞인 순서의 기록도 시각 순으로 적용하고 두 번 적용해도 결과가 같다', async () => {
    await revoke();
    await accept(oldApprover);
    await changeApprover(newApprover.memberId);
    await post(`/api/projects/${projectId}/archive`).expect(204);
    await post(`/api/projects/${projectId}/unarchive`).expect(204);
    const person = await inviteNew();
    const records = await collectRecords(6);
    await withdrawUser(prisma, person.email);
    records.push(withdrawalRecord(person.id, await dbTime()));
    await removeNewMember(person);
    await restoreMembership();
    await restoreActiveProject();
    const shuffled = [...records].sort((a, b) => recordTime(b).localeCompare(recordTime(a)));
    const duplicated = [...shuffled, ...shuffled];

    expect(await replay(duplicated)).toEqual({ applied: 7, skippedBeforeSince: 0, skipped: [] });
    const first = await readState();
    expect(await replay(duplicated)).toEqual({ applied: 7, skippedBeforeSince: 0, skipped: [] });
    expect(await readState()).toEqual(first);

    expect(await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).toMatchObject({
      status: 'ACTIVE',
      approverMemberId: newApprover.memberId,
    });
    expect(
      (await prisma.projectMember.findUniqueOrThrow({ where: { id: oldApprover.memberId } })).revokedAt,
    ).toBeNull();
    await get(`/api/projects/${projectId}`, oldApprover.cookie).expect(200);
    await expectApprovalDenied(oldApprover.cookie);
    await approve(newApprover.cookie);
  });

  it('형식이 틀린 기록이 하나라도 있으면 아무것도 바꾸지 않고 실패한다', async () => {
    const person = await inviteNew();
    const [accepted] = await collectRecords(1);
    await revoke();
    const [revoked] = await collectRecords(1);
    await restoreMembership();
    await removeNewMember(person);
    const before = await readState();
    const invalid = [
      accepted.replace('사건: INVITATION_ACCEPTED', '사건: UNKNOWN_EVENT'),
      accepted.replace(/^사건 id: .+\n/m, ''),
      accepted.replace(/^시각: .+\n/m, ''),
      accepted.replace(/^대상 역할: .+\n/m, ''),
      `${accepted}\n사건: INVITATION_ACCEPTED`,
      `${accepted}\n대상 이름: "겹친 이름"`,
      `${accepted}\n모르는 열쇠: 값`,
      accepted.replace(/^대상 이메일: .+$/m, `대상 이메일: ${person.email}`),
      accepted.replace(/^대상 이름: .+$/m, '대상 이름: JSON이 아닌 이름'),
      accepted.replace(/^대상 이름: .+$/m, '대상 이름: {"name":"객체"}'),
      accepted.replace(/^대상 이름: .+$/m, '대상 이름: null'),
      accepted.replace(/^시각: .+$/m, '시각: 2026-11-14T03:04:05.123Z'),
      accepted.replace(/^대상 사용자 id: .+$/m, '대상 사용자 id: uuid가 아님'),
      accepted.replace(/^대상 역할: .+$/m, '대상 역할: ADMIN'),
      accepted.replace(/^대상 이름: .+$/m, '구분자 없는 줄'),
      // 같은 사건 id에 대상 자체가 다른 사본도 거부해야 한다.
      `${accepted}\n\n${accepted.replace(/^대상 사용자 id: .+$/m, `대상 사용자 id: ${randomUUID()}`)}`,
    ];
    for (const record of invalid) {
      await expect(replay([revoked, record])).rejects.toThrow();
      expect(await readState()).toEqual(before);
    }
    await get(`/api/projects/${projectId}`, oldApprover.cookie).expect(200);
  });
});
