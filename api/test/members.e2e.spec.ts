import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
const memberNotFoundBody = { statusCode: 404, message: '없는 참여자예요', error: 'Not Found' };
const invitationNotFoundBody = { statusCode: 404, message: '사용할 수 없는 초대예요', error: 'Not Found' };
const tokenFromLink = (link: string) => new URL(link).pathname.split('/').at(-1)!;

describe('참여자 API (e2e)', () => {
  let app: INestApplication | undefined;
  let server: Server;
  let prisma: PrismaService;
  let directory: string;
  let developer: { id: string; email: string; name: string };
  let client: { id: string; email: string; name: string; memberId: string; cookie: string; token: string };
  let projectId: string;
  let otherProjectId: string;
  let developerMemberId: string;
  let cookie: string;
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

  const get = (path: string, memberCookie = cookie) => request(server).get(path).set('Cookie', memberCookie);
  const post = (path: string, memberCookie = cookie) =>
    request(server).post(path).set('Origin', origin).set('Cookie', memberCookie);
  const list = (memberCookie = cookie) => get(`/api/projects/${projectId}/members`, memberCookie);
  const revoke = (memberId: string, memberCookie = cookie) => post(`/api/members/${memberId}/revoke`, memberCookie);
  const setApprover = (memberId: string | null, memberCookie = cookie) =>
    post(`/api/projects/${projectId}/approver`, memberCookie).send({ memberId });

  const createInvitation = async (email: string, targetProjectId = projectId, memberCookie = cookie) => {
    const response = await post(`/api/projects/${targetProjectId}/invitations`, memberCookie)
      .send({ email })
      .expect(201);
    return { ...response.body, token: tokenFromLink(response.body.link) } as {
      email: string;
      expiresAt: string;
      token: string;
    };
  };

  // 클라이언트 멤버는 DB에 직접 넣지 않고 실제 초대·수락 API로 만든다.
  const joinClient = async (email: string, name: string, targetProjectId = projectId, memberCookie = cookie) => {
    const user = await prisma.user.create({ data: { email, name } });
    const clientCookie = await login(user.id);
    const invitation = await createInvitation(email, targetProjectId, memberCookie);
    await post('/api/invitations/accept', clientCookie)
      .send({ token: invitation.token })
      .expect(200)
      .expect({ projectId: targetProjectId });
    const member = await prisma.projectMember.findUniqueOrThrow({
      where: { projectId_userId: { projectId: targetProjectId, userId: user.id } },
    });
    return { ...user, memberId: member.id, cookie: clientCookie, token: invitation.token };
  };

  const readState = async () => ({
    members: await prisma.projectMember.findMany({ orderBy: { id: 'asc' } }),
    invitations: await prisma.invitation.findMany({ orderBy: { id: 'asc' } }),
    projects: await prisma.project.findMany({ orderBy: { id: 'asc' } }),
    events: await prisma.activityEvent.findMany({ orderBy: { id: 'asc' } }),
  });

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'members-e2e-'));
    vi.stubEnv('ASSET_DIR', directory);
    vi.stubEnv('APP_URL', 'https://review.example.com');
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
    const outsider = await prisma.user.create({ data: { email: 'outsider@example.com', name: '다른 개발자' } });
    const project = await prisma.project.create({
      data: { name: '참여자 검수 프로젝트', members: { create: { userId: developer.id, role: 'DEVELOPER' } } },
      include: { members: true },
    });
    projectId = project.id;
    developerMemberId = project.members[0].id;
    const otherProject = await prisma.project.create({
      data: { name: '다른 프로젝트', members: { create: { userId: outsider.id, role: 'DEVELOPER' } } },
    });
    otherProjectId = otherProject.id;
    cookie = await login(developer.id);
    outsiderCookie = await login(outsider.id);
    client = await joinClient('client@example.com', '첫 참여자');
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

  it('목록은 개발자 먼저·참여한 순으로 다섯 칸을 주고 마지막 접속 시각과 null을 구분한다', async () => {
    const second = await joinClient('z-second@example.com', '후속 참여자');
    const lastSeenAt = new Date('2026-01-02T03:04:05.000Z');
    await prisma.user.update({ where: { id: client.id }, data: { lastSeenAt } });
    // 삽입·이름·이메일 순서와 다르게 만들어 실제 참여 시각으로 정렬하는지 확인한다.
    await prisma.projectMember.update({ where: { id: second.memberId }, data: { createdAt: new Date('2026-01-01') } });
    await prisma.projectMember.update({ where: { id: client.memberId }, data: { createdAt: new Date('2026-01-02') } });
    await prisma.projectMember.update({
      where: { id: developerMemberId },
      data: { createdAt: new Date('2026-01-03') },
    });
    const pending = await createInvitation('pending@example.com');
    await joinClient('foreign@example.com', '다른 프로젝트 참여자', otherProjectId, outsiderCookie);

    await list()
      .expect(200)
      .expect({
        members: [
          { id: developerMemberId, name: developer.name, email: developer.email, role: 'DEVELOPER', lastSeenAt: null },
          { id: second.memberId, name: second.name, email: second.email, role: 'CLIENT', lastSeenAt: null },
          {
            id: client.memberId,
            name: client.name,
            email: client.email,
            role: 'CLIENT',
            lastSeenAt: lastSeenAt.toISOString(),
          },
        ],
        invitations: [{ email: pending.email, expiresAt: pending.expiresAt }],
      });
  });

  it('대기 목록은 만료·무효·수락·다른 프로젝트 초대를 빼고 쓸 수 있는 초대만 만든 순서대로 준다', async () => {
    const first = await createInvitation('z-first@example.com');
    const expired = await createInvitation('expired@example.com');
    await prisma.$executeRaw`
      UPDATE invitations SET expires_at = now() - interval '1 second'
      WHERE token_hash = ${hashSessionToken(expired.token)}
    `;
    await createInvitation('a-replaced@example.com');
    const replacement = await createInvitation('a-replaced@example.com');
    await createInvitation('foreign@example.com', otherProjectId, outsiderCookie);
    const response = await list().expect(200);

    expect(response.body.invitations).toEqual([
      { email: first.email, expiresAt: first.expiresAt },
      { email: replacement.email, expiresAt: replacement.expiresAt },
    ]);
  });

  it('목록은 클라이언트에게 403이고 이메일·접속 시각을 노출하지 않는다', async () => {
    const response = await list(client.cookie).expect(403);
    expect(response.body).toEqual({ statusCode: 403, message: expect.any(String), error: 'Forbidden' });
    expect(response.text).not.toContain(developer.email);
    expect(response.text).not.toContain('lastSeenAt');
  });

  it.each(['not-a-uuid', missingId])('목록과 승인자는 프로젝트 id=%s에 같은 404를 준다', async (id) => {
    const before = await readState();
    await get(`/api/projects/${id}/members`).expect(404).expect(projectNotFoundBody);
    await post(`/api/projects/${id}/approver`).send({ memberId: null }).expect(404).expect(projectNotFoundBody);
    expect(await readState()).toEqual(before);
  });

  it('다른 프로젝트 개발자라도 비멤버이면 목록·승인자·철회가 404다', async () => {
    const before = await readState();
    await list(outsiderCookie).expect(404).expect(projectNotFoundBody);
    await setApprover(client.memberId, outsiderCookie).expect(404).expect(projectNotFoundBody);
    await revoke(client.memberId, outsiderCookie).expect(404).expect(memberNotFoundBody);
    expect(await readState()).toEqual(before);
  });

  it.each(['list', 'revoke', 'approver'] as const)(
    '%s는 로그인하지 않으면 401이고 데이터를 보존한다',
    async (action) => {
      const before = await readState();
      const path =
        action === 'revoke'
          ? `/api/members/${client.memberId}/revoke`
          : `/api/projects/${projectId}/${action === 'list' ? 'members' : 'approver'}`;
      const pending = action === 'list' ? request(server).get(path) : request(server).post(path).set('Origin', origin);
      if (action === 'approver') pending.send({ memberId: client.memberId });
      await pending.expect(401);
      expect(await readState()).toEqual(before);
    },
  );

  it.each([
    { action: 'revoke', requestOrigin: 'https://other.example.com' },
    { action: 'revoke', requestOrigin: undefined },
    { action: 'approver', requestOrigin: 'https://other.example.com' },
    { action: 'approver', requestOrigin: undefined },
  ])('$action는 Origin=$requestOrigin이면 403이고 데이터를 보존한다', async ({ action, requestOrigin }) => {
    const before = await readState();
    const path = action === 'revoke' ? `/api/members/${client.memberId}/revoke` : `/api/projects/${projectId}/approver`;
    const pending = request(server).post(path).set('Cookie', cookie);
    if (requestOrigin) pending.set('Origin', requestOrigin);
    if (action === 'approver') pending.send({ memberId: client.memberId });
    await pending.expect(403);
    expect(await readState()).toEqual(before);
  });

  it('철회는 빈 204이고 같은 세션의 프로젝트·버전·사진·일지 접근과 목록 노출을 바로 막는다', async () => {
    const draft = await post(`/api/projects/${projectId}/versions`).expect(201);
    const versionId: string = draft.body.id;
    const screen = await prisma.screen.create({ data: { projectId, name: '첫 화면', viewport: 'PC' } });
    const photo = await sharp({ create: { width: 32, height: 24, channels: 3, background: 'red' } })
      .png()
      .toBuffer();
    const uploaded = await request(server)
      .put(`/api/versions/${versionId}/screens/${screen.id}/asset`)
      .set('Origin', origin)
      .set('Cookie', cookie)
      .attach('file', photo, 'screen.png')
      .expect(200);
    const assetId: string = uploaded.body.screens.find((item: { screenId: string }) => item.screenId === screen.id)
      .asset.id;
    await get(`/api/versions/${versionId}`, client.cookie).expect(404);
    await get(`/api/assets/${assetId}`, client.cookie).expect(404);
    await get(`/api/projects/${projectId}/versions`, client.cookie).expect(200).expect([]);
    await post(`/api/versions/${versionId}/publish`).expect(200);
    await setApprover(client.memberId).expect(200);
    const paths = [
      `/api/projects/${projectId}`,
      `/api/projects/${projectId}/versions`,
      `/api/versions/${versionId}`,
      `/api/projects/${projectId}/activity`,
    ];
    for (const path of paths) await get(path, client.cookie).expect(200);
    const asset = await get(`/api/assets/${assetId}`, client.cookie).expect(200);
    expect(asset.headers.etag).toEqual(expect.any(String));
    const projectsBefore = await get('/api/projects', client.cookie).expect(200);
    expect(projectsBefore.body).toEqual([expect.objectContaining({ id: projectId })]);

    const response = await revoke(client.memberId).expect(204);

    expect(response.text).toBe('');
    for (const path of paths) await get(path, client.cookie).expect(404);
    await get(`/api/assets/${assetId}`, client.cookie).expect(404);
    await get(`/api/assets/${assetId}`, client.cookie).set('If-None-Match', asset.headers.etag).expect(404);
    await get('/api/projects', client.cookie).expect(200).expect([]);
    const detail = await get(`/api/projects/${projectId}`).expect(200);
    expect(detail.body.approver).toBeNull();
    const members = await list().expect(200);
    expect(members.body.members.map(({ id }: { id: string }) => id)).toEqual([developerMemberId]);
    await get(`/api/assets/${assetId}`).expect(200);
    const activity = await get(`/api/projects/${projectId}/activity`).expect(200);
    expect(activity.body.filter(({ type }: { type: string }) => type === 'MEMBER_REVOKED')).toEqual([
      {
        id: expect.any(String),
        type: 'MEMBER_REVOKED',
        createdAt: expect.any(String),
        actorName: developer.name,
        memberName: client.name,
        version: null,
      },
    ]);
    const beforeRetry = await readState();
    await revoke(client.memberId).expect(404).expect(memberNotFoundBody);
    await list(client.cookie).expect(404).expect(projectNotFoundBody);
    await setApprover(null, client.cookie).expect(404).expect(projectNotFoundBody);
    expect(await readState()).toEqual(beforeRetry);
  });

  it.each([false, true])(
    '철회는 만료 여부=%s인 미수락 링크를 무효로 하고 다른 사람·프로젝트의 초대는 보존한다',
    async (expired) => {
      // 활성 멤버에게 재초대하는 API는 409다. 철회 시 정리해야 하는 잔존 초대만 DB에 준비한다.
      const oldToken = createSessionToken();
      const pending = await prisma.invitation.create({
        data: {
          projectId,
          email: client.email,
          invitedById: developer.id,
          tokenHash: hashSessionToken(oldToken),
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });
      if (expired)
        await prisma.$executeRaw`UPDATE invitations SET expires_at = now() - interval '1 second' WHERE id = ${pending.id}::uuid`;
      await request(server)
        .get(`/api/invitations/${oldToken}`)
        .expect(expired ? 410 : 200);
      const otherEmail = await createInvitation('pending@example.com');
      const otherProjectInvitation = await createInvitation(client.email, otherProjectId, outsiderCookie);

      await revoke(client.memberId).expect(204);

      await request(server).get(`/api/invitations/${oldToken}`).expect(404).expect(invitationNotFoundBody);
      await post('/api/invitations/accept', client.cookie)
        .send({ token: oldToken })
        .expect(404)
        .expect(invitationNotFoundBody);
      await post('/api/invitations/accept', client.cookie)
        .send({ token: client.token })
        .expect(404)
        .expect(invitationNotFoundBody);
      await request(server).get(`/api/invitations/${otherEmail.token}`).expect(200);
      await request(server).get(`/api/invitations/${otherProjectInvitation.token}`).expect(200);
      expect(await prisma.invitation.findUniqueOrThrow({ where: { id: pending.id } })).toMatchObject({
        revokedAt: expect.any(Date),
        acceptedAt: null,
      });
    },
  );

  it('철회 뒤 새 초대를 수락하면 같은 멤버 id로 돌아오고 승인자는 비어 있다', async () => {
    const original = await prisma.projectMember.findUniqueOrThrow({ where: { id: client.memberId } });
    await setApprover(client.memberId).expect(200);
    await revoke(client.memberId).expect(204);
    const invitation = await createInvitation(client.email);

    await post('/api/invitations/accept', client.cookie)
      .send({ token: invitation.token })
      .expect(200)
      .expect({ projectId });

    const detail = await get(`/api/projects/${projectId}`, client.cookie).expect(200);
    expect(detail.body).toMatchObject({ myRole: 'CLIENT', approver: null });
    expect(await prisma.projectMember.findMany({ where: { projectId, userId: client.id } })).toEqual([original]);
    const members = await list().expect(200);
    expect(members.body.members.map(({ id }: { id: string }) => id)).toEqual([developerMemberId, client.memberId]);
    await post('/api/invitations/accept', client.cookie)
      .send({ token: client.token })
      .expect(404)
      .expect(invitationNotFoundBody);
  });

  it('남의 프로젝트 참여자·없는 UUID·잘못된 id의 철회는 같은 404 본문이고 데이터를 보존한다', async () => {
    const foreign = await joinClient('foreign@example.com', '남의 참여자', otherProjectId, outsiderCookie);
    const before = await readState();
    for (const id of [foreign.memberId, missingId, 'not-a-uuid']) {
      await revoke(id).expect(404).expect(memberNotFoundBody);
    }
    expect(await readState()).toEqual(before);
  });

  it('개발자 줄은 철회할 수 없고 클라이언트는 자신이나 다른 참여자를 철회할 수 없다', async () => {
    const second = await joinClient('second@example.com', '두 번째 참여자');
    const before = await readState();
    await revoke(developerMemberId).expect(403);
    await revoke(client.memberId, client.cookie).expect(403);
    await revoke(second.memberId, client.cookie).expect(403);
    expect(await readState()).toEqual(before);
  });

  it('승인자가 아닌 사람을 철회해도 기존 승인자와 다른 프로젝트의 참여 권한은 보존한다', async () => {
    const second = await joinClient('second@example.com', '두 번째 참여자');
    const invitation = await createInvitation(client.email, otherProjectId, outsiderCookie);
    await post('/api/invitations/accept', client.cookie).send({ token: invitation.token }).expect(200);
    await setApprover(second.memberId).expect(200);

    await revoke(client.memberId).expect(204);

    const detail = await get(`/api/projects/${projectId}`).expect(200);
    expect(detail.body.approver).toEqual({ memberId: second.memberId, name: second.name });
    await get(`/api/projects/${otherProjectId}`, client.cookie).expect(200);
    const projects = await get('/api/projects', client.cookie).expect(200);
    expect(projects.body).toEqual([expect.objectContaining({ id: otherProjectId })]);
  });

  it('승인자는 자동 지정되지 않고 지정·교체·null 해제 결과가 200과 프로젝트 조회에 반영된다', async () => {
    const second = await joinClient('second@example.com', '두 번째 참여자');
    const initial = await get(`/api/projects/${projectId}`, client.cookie).expect(200);
    expect(initial.body.approver).toBeNull();
    for (const target of [client, second]) {
      const approver = { memberId: target.memberId, name: target.name };
      await setApprover(target.memberId).expect(200).expect({ approver });
      const detail = await get(`/api/projects/${projectId}`, client.cookie).expect(200);
      expect(detail.body.approver).toEqual(approver);
    }
    await setApprover(null).expect(200).expect({ approver: null });
    const cleared = await get(`/api/projects/${projectId}`).expect(200);
    expect(cleared.body.approver).toBeNull();
    expect(
      await prisma.activityEvent.findMany({ where: { type: 'APPROVER_CHANGED' }, orderBy: { createdAt: 'asc' } }),
    ).toEqual([
      expect.objectContaining({ projectId, actorId: developer.id, memberId: client.memberId }),
      expect.objectContaining({ projectId, actorId: developer.id, memberId: second.memberId }),
      expect.objectContaining({ projectId, actorId: developer.id, memberId: null }),
    ]);
  });

  it.each([false, true])(
    '같은 승인자 값(지정됨=%s)을 다시 저장하면 200이고 일지를 더 만들지 않는다',
    async (assigned) => {
      const memberId = assigned ? client.memberId : null;
      await setApprover(memberId).expect(200);
      const before = await readState();
      await setApprover(memberId)
        .expect(200)
        .expect({ approver: assigned ? { memberId, name: client.name } : null });
      expect(await readState()).toEqual(before);
    },
  );

  it.each(['developer', 'revoked', 'foreign', 'missing', 'user-id'] as const)(
    '승인자 대상이 %s이면 422이고 기존 승인자와 일지를 보존한다',
    async (target) => {
      await setApprover(client.memberId).expect(200);
      let memberId = missingId;
      if (target === 'developer') memberId = developerMemberId;
      if (target === 'user-id') memberId = client.id;
      if (target === 'foreign')
        memberId = (await joinClient('foreign@example.com', '남의 참여자', otherProjectId, outsiderCookie)).memberId;
      if (target === 'revoked') {
        memberId = (await joinClient('revoked@example.com', '철회된 참여자')).memberId;
        await revoke(memberId).expect(204);
      }
      const before = await readState();
      await setApprover(memberId).expect(422);
      expect(await readState()).toEqual(before);
    },
  );

  it.each([
    {},
    { memberId: 'not-a-uuid' },
    { memberId: '' },
    { memberId: '   ' },
    { memberId: 123 },
    { memberId: false },
    { memberId: [] },
    { memberId: {} },
    { memberId: null, extra: true },
    { memberId: missingId, extra: true },
  ])('승인자는 잘못된 본문 %j를 422로 거절하고 현재 값을 보존한다', async (body) => {
    await setApprover(client.memberId).expect(200);
    const before = await readState();
    await post(`/api/projects/${projectId}/approver`).send(body).expect(422);
    expect(await readState()).toEqual(before);
  });

  it('클라이언트는 승인자여도 지정·해제할 수 없다', async () => {
    await setApprover(client.memberId).expect(200);
    const before = await readState();
    await setApprover(client.memberId, client.cookie).expect(403);
    await setApprover(null, client.cookie).expect(403);
    expect(await readState()).toEqual(before);
  });

  it('동시에 두 번 철회하면 204와 404이며 철회 일지는 하나만 남는다', async () => {
    const responses = await Promise.all([revoke(client.memberId), revoke(client.memberId)]);
    expect(responses.map(({ status }) => status).sort((a, b) => a - b)).toEqual([204, 404]);
    expect(responses.find(({ status }) => status === 404)?.body).toEqual(memberNotFoundBody);
    expect(await prisma.activityEvent.findMany({ where: { type: 'MEMBER_REVOKED' } })).toEqual([
      expect.objectContaining({ projectId, actorId: developer.id, memberId: client.memberId }),
    ]);
  });

  it.each(['revoke', 'approver'] as const)(
    '%s 요청을 먼저 시작해도 동시 철회·지정 뒤 철회된 승인자가 남지 않는다',
    async (first) => {
      const requests =
        first === 'revoke'
          ? [revoke(client.memberId), setApprover(client.memberId)]
          : [setApprover(client.memberId), revoke(client.memberId)];
      const responses = await Promise.all(requests);
      const revokeResponse = responses[first === 'revoke' ? 0 : 1];
      const approverResponse = responses[first === 'approver' ? 0 : 1];
      expect(revokeResponse.status).toBe(204);
      expect([200, 422]).toContain(approverResponse.status);
      const detail = await get(`/api/projects/${projectId}`).expect(200);
      expect(detail.body.approver).toBeNull();
      await get(`/api/projects/${projectId}`, client.cookie).expect(404);
      expect(await prisma.activityEvent.count({ where: { type: 'MEMBER_REVOKED', memberId: client.memberId } })).toBe(
        1,
      );
    },
  );
});
