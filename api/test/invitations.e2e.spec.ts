import { createHash, randomUUID } from 'node:crypto';
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
const appUrl = 'https://review.example.com';
const missingId = '00000000-0000-4000-8000-000000000001';
const tokenFromLink = (link: string) => new URL(link).pathname.split('/').at(-1)!;
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const invitationNotFoundBody = { statusCode: 404, message: '사용할 수 없는 초대예요', error: 'Not Found' };
const invitationExpiredBody = { statusCode: 410, message: '초대가 만료됐어요', error: 'Gone' };
const projectFullBody = { statusCode: 409, message: '클라이언트는 5명까지 참여할 수 있어요', code: 'PROJECT_FULL' };

describe('초대 API (e2e)', () => {
  let app: INestApplication | undefined;
  let server: Server;
  let prisma: PrismaService;
  let developer: { id: string; email: string };
  let invited: { id: string; email: string };
  let outsider: { id: string; email: string };
  let projectId: string;
  let cookie: string;
  let invitedCookie: string;
  let outsiderCookie: string;
  const sendLoginCode = vi.fn<MailService['sendLoginCode']>();
  const sendInvitation = vi.fn<MailService['sendInvitation']>();

  const login = async (userId: string) => {
    const token = createSessionToken();
    await prisma.session.create({
      data: { userId, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
    });
    return `sid=${token}`;
  };

  const post = (path: string, memberCookie = cookie) =>
    request(server).post(path).set('Origin', origin).set('Cookie', memberCookie);

  const createInvitation = async (email = invited.email) => {
    const response = await post(`/api/projects/${projectId}/invitations`).send({ email }).expect(201);
    return { ...response.body, token: tokenFromLink(response.body.link) } as {
      email: string;
      expiresAt: string;
      link: string;
      token: string;
    };
  };

  const preview = (token: string) => request(server).get(`/api/invitations/${encodeURIComponent(token)}`);
  const accept = (token: string, memberCookie = invitedCookie) =>
    post('/api/invitations/accept', memberCookie).send({ token });

  const addClients = async (count: number) => {
    const members = [];
    for (let index = 0; index < count; index += 1) {
      members.push(
        await prisma.projectMember.create({
          data: {
            project: { connect: { id: projectId } },
            role: 'CLIENT',
            user: { create: { email: `client-${randomUUID()}@example.com`, name: `클라이언트 ${index}` } },
          },
        }),
      );
    }
    return members;
  };

  // 실패한 쓰기 요청이 초대·참여자·일지·승인자를 바꾸지 않았는지 함께 확인한다.
  const readState = async () => ({
    invitations: await prisma.invitation.findMany({ orderBy: { id: 'asc' } }),
    members: await prisma.projectMember.findMany({ orderBy: { id: 'asc' } }),
    events: await prisma.activityEvent.findMany({ orderBy: { id: 'asc' } }),
    projects: await prisma.project.findMany({ orderBy: { id: 'asc' } }),
  });

  const expireInvitation = (token: string) => prisma.$executeRaw`
    UPDATE invitations SET created_at = now() - interval '8 days', expires_at = now() - interval '1 day'
    WHERE token_hash = ${tokenHash(token)}
  `;

  beforeEach(async () => {
    vi.stubEnv('APP_URL', appUrl);
    vi.stubEnv('APP_ORIGINS', origin);
    vi.stubEnv('COOKIE_SECURE', undefined);
    sendLoginCode.mockReset();
    sendInvitation.mockReset();
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MailService)
      .useValue({ sendLoginCode, sendInvitation })
      .compile();

    app = module.createNestApplication();
    setupApp(app);
    await app.init();
    server = app.getHttpServer() as Server;
    prisma = app.get(PrismaService);
    await resetDatabase(prisma);
    developer = await prisma.user.create({ data: { email: 'developer@example.com', name: '개발자' } });
    invited = await prisma.user.create({ data: { email: 'invited@example.com', name: '초대받은 사람' } });
    outsider = await prisma.user.create({ data: { email: 'outsider@example.com', name: '다른 사람' } });
    const project = await prisma.project.create({
      data: { name: '초대 검수 프로젝트', members: { create: { userId: developer.id, role: 'DEVELOPER' } } },
    });
    projectId = project.id;
    cookie = await login(developer.id);
    invitedCookie = await login(invited.id);
    outsiderCookie = await login(outsider.id);
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

  it('만들기는 이메일을 정리하고 201의 세 칸과 메일에 같은 APP_URL 링크를 준다', async () => {
    const response = await post(`/api/projects/${projectId}/invitations`)
      .send({ email: ' \tINVITED@EXAMPLE.COM\n ' })
      .expect(201);
    const token = tokenFromLink(response.body.link);
    const stored = await prisma.invitation.findFirstOrThrow();

    expect(response.body).toEqual({
      email: invited.email,
      expiresAt: stored.expiresAt.toISOString(),
      link: `${appUrl}/app/invite/${token}`,
    });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(stored).toMatchObject({ projectId, email: invited.email, tokenHash: tokenHash(token) });
    expect(JSON.stringify(stored)).not.toContain(token);
    const [expiration] = await prisma.$queryRaw<{ seven_days: boolean }[]>`
      SELECT expires_at = created_at + interval '7 days' AS seven_days FROM invitations WHERE id = ${stored.id}::uuid
    `;
    expect(expiration.seven_days).toBe(true);
    expect(sendInvitation).toHaveBeenCalledExactlyOnceWith(
      invited.email,
      response.body.link,
      '초대 검수 프로젝트',
      '개발자',
    );
    expect(await prisma.activityEvent.findMany()).toEqual([
      expect.objectContaining({ projectId, actorId: developer.id, type: 'INVITATION_CREATED', memberId: null }),
    ]);
    await accept(token).expect(200).expect({ projectId });
  });

  it('가입하지 않은 이메일에도 초대하고 사용자나 멤버를 미리 만들지 않는다', async () => {
    const usersBefore = await prisma.user.count();
    await createInvitation('new-client@example.com');

    expect(await prisma.user.count()).toBe(usersBefore);
    expect(await prisma.projectMember.count()).toBe(1);
  });

  it.each([
    {},
    { email: 'wrong-email' },
    { email: '' },
    { email: '   ' },
    { email: null },
    { email: 123 },
    { email: ['invited@example.com'] },
    { email: 'invited@example.com', role: 'DEVELOPER' },
  ])('만들기는 잘못된 본문 %j를 422로 거절하며 저장하거나 메일을 보내지 않는다', async (body) => {
    const before = await readState();
    await post(`/api/projects/${projectId}/invitations`).send(body).expect(422);

    expect(await readState()).toEqual(before);
    expect(sendInvitation).not.toHaveBeenCalled();
  });

  it.each(['not-a-uuid', missingId])('프로젝트 id=%s는 같은 404이고 아무것도 저장하지 않는다', async (id) => {
    const before = await readState();
    await post(`/api/projects/${id}/invitations`)
      .send({ email: invited.email })
      .expect(404)
      .expect({ statusCode: 404, message: '없는 프로젝트예요', error: 'Not Found' });

    expect(await readState()).toEqual(before);
    expect(sendInvitation).not.toHaveBeenCalled();
  });

  it.each([
    { role: 'CLIENT', revoked: false, status: 403 },
    { role: 'CLIENT', revoked: true, status: 404 },
    { role: null, revoked: false, status: 404 },
  ] as const)('만들기 권한: $role, 철회=$revoked이면 $status다', async ({ role, revoked, status }) => {
    if (role) {
      await prisma.projectMember.create({
        data: { projectId, userId: outsider.id, role, revokedAt: revoked ? new Date() : null },
      });
    }
    // 다른 프로젝트의 개발자라도 이 프로젝트의 권한만 적용한다.
    await prisma.project.create({
      data: { name: '다른 프로젝트', members: { create: { userId: outsider.id, role: 'DEVELOPER' } } },
    });
    const before = await readState();
    await post(`/api/projects/${projectId}/invitations`, outsiderCookie).send({ email: invited.email }).expect(status);

    expect(await readState()).toEqual(before);
    expect(sendInvitation).not.toHaveBeenCalled();
  });

  it.each(['DEVELOPER', 'CLIENT'] as const)('활성 %s를 다시 초대하면 409 ALREADY_MEMBER다', async (role) => {
    if (role === 'CLIENT') await prisma.projectMember.create({ data: { projectId, userId: invited.id, role } });
    const email = role === 'DEVELOPER' ? developer.email : invited.email;
    const before = await readState();

    const response = await post(`/api/projects/${projectId}/invitations`).send({ email }).expect(409);
    expect(response.body).toEqual({ statusCode: 409, message: expect.any(String), code: 'ALREADY_MEMBER' });

    expect(await readState()).toEqual(before);
    expect(sendInvitation).not.toHaveBeenCalled();
  });

  it('활성 클라이언트가 5명이면 만들기는 409 PROJECT_FULL이고 예전 초대를 보존한다', async () => {
    const invitation = await createInvitation();
    await addClients(5);
    const before = await readState();
    sendInvitation.mockClear();

    await post(`/api/projects/${projectId}/invitations`)
      .send({ email: invited.email })
      .expect(409)
      .expect(projectFullBody);

    expect(await readState()).toEqual(before);
    expect(sendInvitation).not.toHaveBeenCalled();
    await preview(invitation.token).expect(200);
  });

  it.each([undefined, ''])('APP_URL=%s이면 500이고 기존 초대·멤버·일지를 보존한다', async (value) => {
    await createInvitation();
    const before = await readState();
    sendInvitation.mockClear();
    vi.stubEnv('APP_URL', value);

    await post(`/api/projects/${projectId}/invitations`).send({ email: invited.email }).expect(500);

    expect(await readState()).toEqual(before);
    expect(sendInvitation).not.toHaveBeenCalled();
  });

  it('초대 만들기가 일지 저장에서 실패하면 새 초대가 없고 예전 초대는 그대로 쓸 수 있다', async () => {
    const invitation = await createInvitation();
    const before = await readState();
    sendInvitation.mockClear();

    try {
      await prisma.$executeRaw`
        CREATE FUNCTION invitations_e2e_fail_create_event() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'invitations e2e create event failure';
        END;
        $$
      `;
      await prisma.$executeRaw`
        CREATE TRIGGER invitations_e2e_fail_create_event
        BEFORE INSERT ON activity_events FOR EACH ROW
        EXECUTE FUNCTION invitations_e2e_fail_create_event()
      `;

      await post(`/api/projects/${projectId}/invitations`).send({ email: invited.email }).expect(500);

      expect(await readState()).toEqual(before);
      expect(sendInvitation).not.toHaveBeenCalled();
      await preview(invitation.token).expect(200).expect({
        projectName: '초대 검수 프로젝트',
        inviterName: '개발자',
        email: invited.email,
        status: 'PENDING',
      });
    } finally {
      try {
        await prisma.$executeRaw`DROP TRIGGER IF EXISTS invitations_e2e_fail_create_event ON activity_events`;
      } finally {
        await prisma.$executeRaw`DROP FUNCTION IF EXISTS invitations_e2e_fail_create_event()`;
      }
    }
  });

  it('수락이 일지 저장에서 실패하면 초대는 미수락으로 남고 멤버가 생기지 않는다', async () => {
    const invitation = await createInvitation();
    const before = await readState();

    try {
      await prisma.$executeRaw`
        CREATE FUNCTION invitations_e2e_fail_accept_event() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'invitations e2e accept event failure';
        END;
        $$
      `;
      await prisma.$executeRaw`
        CREATE TRIGGER invitations_e2e_fail_accept_event
        BEFORE INSERT ON activity_events FOR EACH ROW
        EXECUTE FUNCTION invitations_e2e_fail_accept_event()
      `;

      await accept(invitation.token).expect(500);

      expect(await readState()).toEqual(before);
      expect(
        await prisma.projectMember.findUnique({
          where: { projectId_userId: { projectId, userId: invited.id } },
        }),
      ).toBeNull();
      await preview(invitation.token).expect(200).expect({
        projectName: '초대 검수 프로젝트',
        inviterName: '개발자',
        email: invited.email,
        status: 'PENDING',
      });
    } finally {
      try {
        await prisma.$executeRaw`DROP TRIGGER IF EXISTS invitations_e2e_fail_accept_event ON activity_events`;
      } finally {
        await prisma.$executeRaw`DROP FUNCTION IF EXISTS invitations_e2e_fail_accept_event()`;
      }
    }
  });

  it.each(['create', 'accept'] as const)('%s는 로그인하지 않으면 401이고 상태를 바꾸지 않는다', async (action) => {
    const invitation = await createInvitation();
    const path = action === 'create' ? `/api/projects/${projectId}/invitations` : '/api/invitations/accept';
    const body = action === 'create' ? { email: invited.email } : { token: invitation.token };
    const before = await readState();
    sendInvitation.mockClear();

    await request(server).post(path).set('Origin', origin).send(body).expect(401);

    expect(await readState()).toEqual(before);
    expect(sendInvitation).not.toHaveBeenCalled();
  });

  it.each([
    { action: 'create', requestOrigin: 'https://evil.example.com' },
    { action: 'accept', requestOrigin: 'https://evil.example.com' },
    { action: 'create', requestOrigin: undefined },
    { action: 'accept', requestOrigin: undefined },
  ])('$action는 Origin=$requestOrigin이면 403이고 상태를 바꾸지 않는다', async ({ action, requestOrigin }) => {
    const invitation = await createInvitation();
    const path = action === 'create' ? `/api/projects/${projectId}/invitations` : '/api/invitations/accept';
    const body = action === 'create' ? { email: invited.email } : { token: invitation.token };
    const before = await readState();
    sendInvitation.mockClear();
    const mutation = request(server)
      .post(path)
      .set('Cookie', action === 'create' ? cookie : invitedCookie);
    if (requestOrigin) mutation.set('Origin', requestOrigin);

    await mutation.send(body).expect(403);

    expect(await readState()).toEqual(before);
    expect(sendInvitation).not.toHaveBeenCalled();
  });

  it('미리보기는 로그인 없이 PENDING의 네 칸만 주고 토큰·해시·id는 주지 않는다', async () => {
    const invitation = await createInvitation();
    const before = await readState();

    await preview(invitation.token).expect(200).expect({
      projectName: '초대 검수 프로젝트',
      inviterName: '개발자',
      email: invited.email,
      status: 'PENDING',
    });

    expect(await readState()).toEqual(before);
  });

  it.each([false, true])('수락한 초대의 미리보기는 만료 여부=%s와 관계없이 네 칸의 ACCEPTED다', async (expired) => {
    const invitation = await createInvitation();
    await accept(invitation.token).expect(200);
    if (expired) await expireInvitation(invitation.token);

    await preview(invitation.token).expect(200).expect({
      projectName: '초대 검수 프로젝트',
      inviterName: '개발자',
      email: invited.email,
      status: 'ACCEPTED',
    });
    await accept(invitation.token).expect(404).expect(invitationNotFoundBody);
  });

  it.each([false, true])('만료 여부=%s인 초대도 이메일을 정리해 다시 초대하면 예전 링크는 404다', async (expired) => {
    const oldInvitation = await createInvitation();
    if (expired) await expireInvitation(oldInvitation.token);
    const invitation = await createInvitation(' INVITED@EXAMPLE.COM ');
    const before = await readState();

    expect(invitation.token).not.toBe(oldInvitation.token);
    await preview(oldInvitation.token).expect(404).expect(invitationNotFoundBody);
    await accept(oldInvitation.token).expect(404).expect(invitationNotFoundBody);
    expect(await readState()).toEqual(before);
    await preview(invitation.token).expect(200);
    await accept(invitation.token).expect(200).expect({ projectId });
  });

  it('7일이 지난 미수락 초대는 미리보기·수락 모두 410이며 사용되지 않는다', async () => {
    const invitation = await createInvitation();
    await expireInvitation(invitation.token);
    const before = await readState();

    await preview(invitation.token).expect(410).expect(invitationExpiredBody);
    await accept(invitation.token).expect(410).expect(invitationExpiredBody);
    expect(await readState()).toEqual(before);
  });

  it('잠금을 기다리는 동안 만료된 초대는 410이고 초대·멤버·일지가 바뀌지 않는다', async () => {
    const invitation = await createInvitation();
    const hash = tokenHash(invitation.token);
    await prisma.$executeRaw`
      UPDATE invitations SET expires_at = clock_timestamp() + interval '2 seconds'
      WHERE token_hash = ${hash}
    `;
    const before = await readState();
    let response: request.Response | undefined;
    let requestError: unknown;
    let requestFinished = false;
    let acceptRequest: Promise<void> | undefined;

    try {
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM projects WHERE id = ${projectId}::uuid FOR UPDATE`;
        const [connection] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;

        // .then으로 HTTP 요청을 즉시 보내고, 잠금을 푼 뒤에도 같은 요청의 결과를 확인한다.
        acceptRequest = accept(invitation.token)
          .timeout({ deadline: 4_000 })
          .then(
            (result) => {
              response = result;
              requestFinished = true;
            },
            (error: unknown) => {
              requestError = error;
              requestFinished = true;
            },
          );

        // 단순 지연이 아니라 이 연결의 잠금에서, 만료 전에 시작한 트랜잭션이 기다리는지 본다.
        await vi.waitFor(
          async () => {
            const [waiting] = await prisma.$queryRaw<{ blocked: boolean }[]>`
            SELECT EXISTS (
              SELECT 1 FROM pg_stat_activity AS activity
              JOIN invitations AS invitation ON invitation.token_hash = ${hash}
              WHERE ${connection.pid}::int = ANY(pg_blocking_pids(activity.pid))
                AND activity.xact_start < invitation.expires_at
                AND clock_timestamp() < invitation.expires_at
            ) AS blocked
          `;
            expect(waiting.blocked).toBe(true);
          },
          { timeout: 1_000, interval: 25 },
        );
        expect(requestFinished).toBe(false);

        await vi.waitFor(
          async () => {
            const [expiration] = await prisma.$queryRaw<{ expired: boolean }[]>`
            SELECT expires_at <= clock_timestamp() AS expired FROM invitations WHERE token_hash = ${hash}
          `;
            expect(expiration.expired).toBe(true);
          },
          { timeout: 3_000, interval: 50 },
        );
        expect(requestFinished).toBe(false);
      });
    } finally {
      // 중간 검증이 실패해도 트랜잭션이 잠금을 풀고 HTTP 요청까지 끝낸 뒤 다음 테스트로 간다.
      await acceptRequest;
    }

    expect(requestError).toBeUndefined();
    expect(response?.status).toBe(410);
    expect(response?.body).toEqual(invitationExpiredBody);
    expect(await prisma.invitation.findUniqueOrThrow({ where: { tokenHash: hash } })).toMatchObject({
      acceptedAt: null,
      revokedAt: null,
    });
    expect(await readState()).toEqual(before);
  });

  it('없는 토큰은 미리보기·수락 모두 같은 404다', async () => {
    const before = await readState();

    await preview('missing-token').expect(404).expect(invitationNotFoundBody);
    await accept('missing-token').expect(404).expect(invitationNotFoundBody);

    expect(await readState()).toEqual(before);
  });

  it('수락은 200의 projectId만 주고 CLIENT로 프로젝트를 볼 수 있지만 승인자는 비어 있다', async () => {
    const invitation = await createInvitation();
    await request(server).get(`/api/projects/${projectId}`).set('Cookie', invitedCookie).expect(404);

    await accept(invitation.token).expect(200).expect({ projectId });

    await request(server).get(`/api/projects/${projectId}`).set('Cookie', invitedCookie).expect(200).expect({
      id: projectId,
      name: '초대 검수 프로젝트',
      myRole: 'CLIENT',
      currentVersion: null,
      approver: null,
    });
    const member = await prisma.projectMember.findUniqueOrThrow({
      where: { projectId_userId: { projectId, userId: invited.id } },
    });
    expect(member).toMatchObject({ role: 'CLIENT', revokedAt: null });
    expect(
      await prisma.invitation.findUniqueOrThrow({ where: { tokenHash: tokenHash(invitation.token) } }),
    ).toMatchObject({ acceptedAt: expect.any(Date), revokedAt: null });
    expect(await prisma.activityEvent.findMany({ where: { type: 'INVITATION_ACCEPTED' } })).toEqual([
      expect.objectContaining({ projectId, actorId: invited.id, memberId: member.id }),
    ]);
  });

  it('다른 이메일은 403 EMAIL_MISMATCH이며 같은 링크로 맞는 이메일은 나중에 수락할 수 있다', async () => {
    const invitation = await createInvitation();
    const before = await readState();

    const response = await accept(invitation.token, outsiderCookie).expect(403);
    expect(response.body).toEqual({ statusCode: 403, message: expect.any(String), code: 'EMAIL_MISMATCH' });

    expect(await readState()).toEqual(before);
    await accept(invitation.token).expect(200).expect({ projectId });
    await request(server).get(`/api/projects/${projectId}`).set('Cookie', outsiderCookie).expect(404);
  });

  it.each([{}, { token: 123 }, { token: null }, { token: {} }, { token: ['token'] }])(
    '수락은 잘못된 본문 %j를 422로 거절하고 상태를 바꾸지 않는다',
    async (body) => {
      await createInvitation();
      const before = await readState();

      await post('/api/invitations/accept', invitedCookie).send(body).expect(422);

      expect(await readState()).toEqual(before);
    },
  );

  it('수락 본문에 추가 칸이 있으면 유효한 토큰도 422로 거절한다', async () => {
    const invitation = await createInvitation();
    const before = await readState();

    await post('/api/invitations/accept', invitedCookie)
      .send({ token: invitation.token, role: 'DEVELOPER' })
      .expect(422);

    expect(await readState()).toEqual(before);
  });

  it('문자열이지만 빈 토큰은 사용할 수 없는 초대인 404다', async () => {
    const before = await readState();
    await accept('').expect(404).expect(invitationNotFoundBody);
    expect(await readState()).toEqual(before);
  });

  it('같은 토큰을 두 번 수락하면 두 번째는 404이고 멤버·일지가 늘지 않는다', async () => {
    const invitation = await createInvitation();
    await accept(invitation.token).expect(200);
    const before = await readState();

    await accept(invitation.token).expect(404).expect(invitationNotFoundBody);
    await accept(invitation.token, outsiderCookie).expect(404).expect(invitationNotFoundBody);

    expect(await readState()).toEqual(before);
  });

  it('초대 후 이미 멤버가 된 사람은 수락 시 409 ALREADY_MEMBER이고 초대를 사용하지 않는다', async () => {
    const invitation = await createInvitation();
    await prisma.projectMember.create({ data: { projectId, userId: invited.id, role: 'CLIENT' } });
    const before = await readState();

    const response = await accept(invitation.token).expect(409);
    expect(response.body).toEqual({ statusCode: 409, message: expect.any(String), code: 'ALREADY_MEMBER' });

    expect(await readState()).toEqual(before);
  });

  it('초대 후 5명이 되면 수락은 409 PROJECT_FULL이고 자리가 나면 같은 링크를 쓸 수 있다', async () => {
    const invitation = await createInvitation();
    const clients = await addClients(5);
    const before = await readState();

    await accept(invitation.token).expect(409).expect(projectFullBody);

    expect(await readState()).toEqual(before);
    await prisma.projectMember.update({ where: { id: clients[0].id }, data: { revokedAt: new Date() } });
    await accept(invitation.token).expect(200).expect({ projectId });
    expect(await prisma.projectMember.count({ where: { projectId, role: 'CLIENT', revokedAt: null } })).toBe(5);
  });

  it('활성 클라이언트가 4명이면 철회된 멤버·대기 초대·개발자·다른 프로젝트 멤버는 정원에 세지 않는다', async () => {
    await addClients(4);
    await prisma.projectMember.create({
      data: { projectId, userId: outsider.id, role: 'CLIENT', revokedAt: new Date() },
    });
    await prisma.project.create({
      data: {
        name: '다른 프로젝트',
        members: {
          create: [
            { userId: developer.id, role: 'DEVELOPER' },
            { userId: invited.id, role: 'CLIENT' },
          ],
        },
      },
    });
    await createInvitation('pending@example.com');

    const invitation = await createInvitation();
    await accept(invitation.token).expect(200).expect({ projectId });

    expect(await prisma.projectMember.count({ where: { projectId, role: 'CLIENT', revokedAt: null } })).toBe(5);
  });

  it('철회된 사람은 예전 링크로 못 들어오고 새 초대로 같은 멤버가 되살아나며 승인자는 비어 있다', async () => {
    const oldInvitation = await createInvitation();
    await accept(oldInvitation.token).expect(200);
    const member = await prisma.projectMember.findUniqueOrThrow({
      where: { projectId_userId: { projectId, userId: invited.id } },
    });
    // 철회 API는 조각 8에서 검증한다. 여기서는 철회가 끝난 상태를 준비한다.
    await prisma.projectMember.update({ where: { id: member.id }, data: { revokedAt: new Date() } });
    await request(server).get(`/api/projects/${projectId}`).set('Cookie', invitedCookie).expect(404);
    const invitation = await createInvitation();

    await accept(oldInvitation.token).expect(404).expect(invitationNotFoundBody);
    await accept(invitation.token).expect(200).expect({ projectId });

    expect(await prisma.projectMember.findUnique({ where: { id: member.id } })).toEqual(member);
    expect(await prisma.projectMember.count({ where: { projectId, userId: invited.id } })).toBe(1);
    const detail = await request(server).get(`/api/projects/${projectId}`).set('Cookie', invitedCookie).expect(200);
    expect(detail.body).toMatchObject({ myRole: 'CLIENT', approver: null });
    expect(await prisma.activityEvent.count({ where: { type: 'INVITATION_ACCEPTED', memberId: member.id } })).toBe(2);
  });

  it('같은 이메일로 동시에 초대하면 둘 다 201이고 사용할 수 있는 링크는 하나만 남는다', async () => {
    const responses = await Promise.all([
      post(`/api/projects/${projectId}/invitations`).send({ email: invited.email }).expect(201),
      post(`/api/projects/${projectId}/invitations`).send({ email: ' INVITED@EXAMPLE.COM ' }).expect(201),
    ]);
    const tokens = responses.map((response) => tokenFromLink(response.body.link));
    expect(new Set(tokens).size).toBe(2);
    const previews = await Promise.all(tokens.map((token) => preview(token)));

    expect(previews.map((response) => response.status).sort((left, right) => left - right)).toEqual([200, 404]);
    expect(await prisma.invitation.count({ where: { projectId, acceptedAt: null, revokedAt: null } })).toBe(1);
    expect(await prisma.activityEvent.count({ where: { type: 'INVITATION_CREATED' } })).toBe(2);
    expect(sendInvitation).toHaveBeenCalledTimes(2);
    const invalidIndex = previews.findIndex((response) => response.status === 404);
    await accept(tokens[invalidIndex]).expect(404).expect(invitationNotFoundBody);
    await accept(tokens[1 - invalidIndex])
      .expect(200)
      .expect({ projectId });
  });

  it('같은 링크로 동시에 수락하면 200·404이고 멤버와 수락 일지는 한 번만 생긴다', async () => {
    const invitation = await createInvitation();

    const responses = await Promise.all([accept(invitation.token), accept(invitation.token)]);

    expect(responses.map((response) => response.status).sort((left, right) => left - right)).toEqual([200, 404]);
    expect(responses.find((response) => response.status === 200)?.body).toEqual({ projectId });
    expect(responses.find((response) => response.status === 404)?.body).toEqual(invitationNotFoundBody);
    expect(await prisma.projectMember.count({ where: { projectId, userId: invited.id } })).toBe(1);
    expect(await prisma.activityEvent.count({ where: { type: 'INVITATION_ACCEPTED' } })).toBe(1);
  });

  it('4명일 때 두 사람이 동시에 수락하면 한 명만 200이고 다른 초대는 409 PROJECT_FULL로 남는다', async () => {
    await addClients(4);
    const invitations = [await createInvitation(), await createInvitation(outsider.email)];

    const responses = await Promise.all([accept(invitations[0].token), accept(invitations[1].token, outsiderCookie)]);

    expect(responses.map((response) => response.status).sort((left, right) => left - right)).toEqual([200, 409]);
    expect(responses.find((response) => response.status === 200)?.body).toEqual({ projectId });
    expect(responses.find((response) => response.status === 409)?.body).toEqual(projectFullBody);
    expect(await prisma.projectMember.count({ where: { projectId, role: 'CLIENT', revokedAt: null } })).toBe(5);
    expect(await prisma.activityEvent.count({ where: { type: 'INVITATION_ACCEPTED' } })).toBe(1);
    const pendingIndex = responses.findIndex((response) => response.status === 409);
    const pending = await preview(invitations[pendingIndex].token).expect(200);
    expect(pending.body.status).toBe('PENDING');
    expect(await prisma.invitation.count({ where: { projectId, acceptedAt: null, revokedAt: null } })).toBe(1);
  });
});
