import type { Server } from 'node:http';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { Logger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { AuthService } from '../src/auth/auth.service.js';
import { InvitationsService } from '../src/invitations/invitations.service.js';
import { MAIL_TRANSPORT, type Mail, type MailTransport } from '../src/mail/mail.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { sendAlert } from '../src/scripts/send-alert.js';
import { setupApp } from '../src/setup-app.js';
import { resetDatabase } from './reset-database.js';

const origin = 'http://localhost:5173';
const developerEmail = 'developer@example.com';
const serverErrorBody = { statusCode: 500, message: 'Internal server error' };

describe('오류 알림 (e2e)', () => {
  let app: INestApplication | undefined;
  let server: Server;
  let prisma: PrismaService;
  let auth: AuthService;
  let invitations: InvitationsService;
  let mails: Mail[];
  const send = vi.fn<MailTransport>();

  beforeEach(async () => {
    vi.stubEnv('APP_ORIGINS', origin);
    vi.stubEnv('APP_URL', 'https://review.example.com');
    vi.stubEnv('COOKIE_SECURE', undefined);
    vi.stubEnv('DEVELOPER_EMAIL', developerEmail);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    mails = [];
    send.mockReset();
    send.mockImplementation(async (mail) => {
      mails.push(mail);
    });
    // 알림 간격은 앱 안에 기억하므로 테스트마다 실제 앱을 새로 만든다.
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MAIL_TRANSPORT)
      .useValue(send)
      .compile();
    app = module.createNestApplication();
    setupApp(app);
    await app.init();
    server = app.getHttpServer() as Server;
    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
    invitations = app.get(InvitationsService);
    await resetDatabase(prisma);
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

  it('500이 나면 개발자에게 알림 메일이 간다', async () => {
    const now = Date.parse('2026-11-14T03:04:05.000Z');
    vi.spyOn(Date, 'now').mockReturnValue(now);
    // DB 조회가 실패해도 우편함에 저장하거나 반복 발송기를 기다리지 않고 바로 알린다.
    vi.spyOn(prisma, '$queryRaw').mockRejectedValueOnce(new Error('테스트 DB 연결 실패'));

    await request(server).get('/api/invitations/db-error').expect(500).expect(serverErrorBody);

    expect(send).toHaveBeenCalledTimes(1);
    expect(mails).toEqual([
      {
        to: developerEmail,
        subject: '[Client Review 알림] 서버 오류 500',
        text: ['시각: 2026-11-14T03:04:05.000Z', '요청: GET /api/invitations/:token', '상태: 500', '오류: Error'].join(
          '\n',
        ),
      },
    ]);
    expect(await prisma.notificationDelivery.count()).toBe(0);

    // HttpException으로 던진 503도 원래 응답을 유지하면서 알린다.
    vi.mocked(Date.now).mockReturnValue(now + 10 * 60 * 1000);
    vi.mocked(prisma.$queryRaw).mockRejectedValueOnce(new Error('테스트 health DB 연결 실패'));
    await request(server).get('/api/health').expect(503).expect({ statusCode: 503, message: 'Service Unavailable' });
    expect(send).toHaveBeenCalledTimes(2);
    expect(mails[1]).toEqual({
      to: developerEmail,
      subject: '[Client Review 알림] 서버 오류 503',
      text: [
        '시각: 2026-11-14T03:14:05.000Z',
        '요청: GET /api/health',
        '상태: 503',
        '오류: ServiceUnavailableException',
      ].join('\n'),
    });
  });

  it('10분 안의 두 번째 500은 메일을 보내지 않고 10분이 지나면 다시 보낸다', async () => {
    const start = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(start);
    vi.spyOn(invitations, 'preview').mockRejectedValue(new Error('반복 오류'));

    // 같은 시각에 요청이 겹쳐도 한 통만 보낸다.
    await Promise.all([
      request(server).get('/api/invitations/first-error').expect(500).expect(serverErrorBody),
      request(server).get('/api/invitations/concurrent-error').expect(500).expect(serverErrorBody),
    ]);
    expect(send).toHaveBeenCalledTimes(1);

    now.mockReturnValue(start + 9 * 60 * 1000 + 59 * 1000);
    await request(server).get('/api/invitations/before-boundary').expect(500).expect(serverErrorBody);
    expect(send).toHaveBeenCalledTimes(1);

    now.mockReturnValue(start + 10 * 60 * 1000);
    await request(server).get('/api/invitations/at-boundary').expect(500).expect(serverErrorBody);
    expect(send).toHaveBeenCalledTimes(2);
    expect(mails.map(({ text }) => text.split('\n')[0])).toEqual([
      `시각: ${new Date(start).toISOString()}`,
      `시각: ${new Date(start + 10 * 60 * 1000).toISOString()}`,
    ]);
  });

  it('알림 메일에는 요청 본문·쿼리·쿠키·오류 메시지가 들어가지 않는다', async () => {
    const bodyName = 'PRIVATE_BODY_7e94';
    const bodyEmail = 'private-body-83e1@example.com';
    const loginCode = '739152';
    const query = 'PRIVATE_QUERY_45b2';
    const cookie = 'PRIVATE_COOKIE_9ac3';
    const errorMessage = 'PRIVATE_ERROR_MESSAGE_21f8';
    const verify = vi.spyOn(auth, 'verifyCode').mockRejectedValue(new TypeError(errorMessage));

    await request(server)
      .post('/api/auth/verify-code')
      .set('Origin', origin)
      .set('Cookie', `sid=${cookie}`)
      .query({ privateQuery: query })
      .send({ email: bodyEmail, code: loginCode, name: bodyName })
      .expect(500)
      .expect(serverErrorBody);

    expect(verify).toHaveBeenCalledExactlyOnceWith(bodyEmail, loginCode, bodyName);
    expect(send).toHaveBeenCalledTimes(1);
    expect(mails[0].text.split('\n')).toEqual([
      expect.stringMatching(/^시각: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      '요청: POST /api/auth/verify-code',
      '상태: 500',
      '오류: TypeError',
    ]);
    const content = `${mails[0].subject}\n${mails[0].text}`;
    for (const secret of [bodyName, bodyEmail, loginCode, query, cookie, errorMessage]) {
      expect(content).not.toContain(secret);
    }
  });

  it('초대 주소에서 500이 나도 알림 메일에 초대 토큰이 없다', async () => {
    const token = 'PRIVATE_INVITATION_TOKEN_8f32';
    const preview = vi.spyOn(invitations, 'preview').mockRejectedValue(new Error('초대 조회 실패'));

    await request(server).get(`/api/invitations/${token}`).expect(500).expect(serverErrorBody);

    expect(preview).toHaveBeenCalledExactlyOnceWith(token);
    expect(send).toHaveBeenCalledTimes(1);
    expect(mails[0].text.split('\n')).toContain('요청: GET /api/invitations/:token');
    expect(`${mails[0].subject}\n${mails[0].text}`).not.toContain(token);
  });

  it('400대 응답은 알림 메일을 보내지 않는다', async () => {
    await request(server).get('/api/auth/me').expect(401);
    await request(server).post('/api/auth/email-code').send({}).expect(403);
    await request(server).get('/api/no-such-alert-route').expect(404);
    await request(server).get('/api/invitations/no-such-invitation').expect(404);
    await request(server).post('/api/auth/email-code').set('Origin', origin).send({ email: 'invalid' }).expect(422);

    // 가입·초대되지 않은 이메일은 정상 코드 요청도 메일을 보내지 않아 429 알림과 구별된다.
    const body = { email: 'not-invited@example.com', privacyAgreed: true };
    await request(server).post('/api/auth/email-code').set('Origin', origin).send(body).expect(204);
    await request(server).post('/api/auth/email-code').set('Origin', origin).send(body).expect(429);
    await nextTurn();

    expect(send).not.toHaveBeenCalled();
    expect(mails).toEqual([]);
  });

  it('알림 메일 보내기가 실패해도 원래 500 응답은 그대로다', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    send.mockRejectedValue(new Error('테스트 메일 서버 연결 실패'));
    vi.spyOn(invitations, 'preview').mockRejectedValue(new Error('원래 서버 오류'));

    try {
      await request(server).get('/api/invitations/mail-failure').expect(500).expect(serverErrorBody);
      await nextTurn();
      await nextTurn();

      expect(send).toHaveBeenCalledTimes(1);
      expect(Logger.prototype.error).toHaveBeenCalledWith('오류 알림 메일을 보내지 못했어요');
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('send-alert는 받은 글을 개발자에게 보내고 개발자 이메일이 없으면 실패로 끝난다', async () => {
    vi.stubEnv('DEVELOPER_EMAIL', ' \tDEVELOPER@EXAMPLE.COM\n ');
    const text = '백업에 실패했어요\n운영 기록을 확인해 주세요';

    await sendAlert(text, send);

    expect(send).toHaveBeenCalledExactlyOnceWith({
      to: developerEmail,
      subject: '[Client Review 알림] 운영 알림',
      text,
    });
    send.mockClear();
    for (const missingEmail of [undefined, '', ' \t\n ']) {
      vi.stubEnv('DEVELOPER_EMAIL', missingEmail);
      await expect(sendAlert(text, send)).rejects.toThrow('DEVELOPER_EMAIL이 없어요');
      expect(send).not.toHaveBeenCalled();
    }
  });
});
