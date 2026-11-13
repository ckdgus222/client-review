import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import { Controller, type INestApplication, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import bcrypt from 'bcrypt';
import request, { type Response } from 'supertest';
import { AppModule } from '../src/app.module.js';
import { MailService } from '../src/mail/mail.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { setupApp } from '../src/setup-app.js';
import { resetDatabase } from './reset-database.js';

// 실제 앱에는 아직 로그인이 필요한 POST가 없어서 테스트 모듈에만 둔다.
@Controller('auth-test/private')
class PrivateController {
  @Post()
  submit() {
    return { ok: true };
  }
}

const origin = 'http://localhost:5173';
const email = 'login@example.com';
const name = '새 사용자';
const maxLengthEmail = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(57)}.com`;

const sessionCookie = (response: Response) => {
  const cookies: unknown = response.headers['set-cookie'];
  expect(cookies).toEqual([expect.stringMatching(/^sid=/)]);
  return (cookies as string[])[0];
};

const expectClearedCookie = (response: Response) => {
  const attributes = sessionCookie(response).split('; ');
  expect(attributes).toEqual(
    expect.arrayContaining(['sid=', 'Path=/api', 'HttpOnly', 'SameSite=Lax', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT']),
  );
  expect(attributes).not.toContain('Max-Age=604800');
};

const expectCodeError = (response: Response, code: string) => {
  expect(response.status).toBe(422);
  expect(response.body).toEqual({
    statusCode: 422,
    message: expect.stringMatching(/\S/),
    code,
  });
  expect(response.headers['set-cookie']).toBeUndefined();
};

describe('로그인 API (e2e)', () => {
  let app: INestApplication | undefined;
  let server: Server;
  let prisma: PrismaService;
  const sendLoginCode = vi.fn<MailService['sendLoginCode']>();

  const post = (path: string) => request(server).post(path).set('Origin', origin);

  const requestCode = async (address = email, allowedOrigin = origin) => {
    // 기존 코드·입력 검사 테스트는 가입 가능한 이메일로 준비한다.
    vi.stubEnv('DEVELOPER_EMAIL', address.trim().toLowerCase());
    const response = await request(server)
      .post('/api/auth/email-code')
      .set('Origin', allowedOrigin)
      .send({ email: address, privacyAgreed: true })
      .expect(204);
    expect(response.text).toBe('');
    const delivery = sendLoginCode.mock.lastCall;
    expect(delivery).toEqual([address.trim().toLowerCase(), expect.stringMatching(/^\d{6}$/)]);
    return delivery![1];
  };

  const login = async (address = email, userName = name) => {
    const developerEmail = process.env.DEVELOPER_EMAIL;
    try {
      const code = await requestCode(address);
      const response = await post('/api/auth/verify-code').send({ email: address, code, name: userName }).expect(200);
      const cookie = sessionCookie(response).split(';')[0];
      return { response, cookie, code };
    } finally {
      // /me의 권한은 각 테스트가 정한 원래 개발자 설정으로 확인한다.
      vi.stubEnv('DEVELOPER_EMAIL', developerEmail);
    }
  };

  beforeEach(async () => {
    vi.stubEnv('APP_ORIGINS', 'http://localhost:5173,http://localhost:8080');
    vi.stubEnv('COOKIE_SECURE', undefined);
    vi.stubEnv('DEVELOPER_EMAIL', 'developer@example.com');
    sendLoginCode.mockReset();
    const module = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [PrivateController],
    })
      .overrideProvider(MailService)
      .useValue({ sendLoginCode })
      .compile();

    app = module.createNestApplication();
    setupApp(app);
    await app.init();
    server = app.getHttpServer() as Server;
    prisma = app.get(PrismaService);
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

  it('코드 요청 → 로그인 → 내 정보 → 로그아웃 → 옛 쿠키 거부까지 한 바퀴 돈다', async () => {
    const { response, cookie, code } = await login();
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const publicUser = { id: user.id, email, name };
    expect(response.body).toEqual(publicUser);

    const attributes = sessionCookie(response).split('; ');
    expect(attributes).toEqual(expect.arrayContaining(['HttpOnly', 'SameSite=Lax', 'Path=/api', 'Max-Age=604800']));
    expect(attributes).not.toContain('Secure');
    const token = cookie.slice('sid='.length);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    const sessions = await prisma.session.findMany();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].userId).toBe(user.id);
    expect(sessions[0].tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(sessions[0].tokenHash).not.toBe(token);
    const savedCode = await prisma.loginCode.findUniqueOrThrow({
      where: { email },
    });
    expect(savedCode.codeHash).not.toBe(code);
    expect(savedCode.codeHash).toMatch(/^\$2[aby]\$12\$/);
    expect(savedCode.usedAt).not.toBeNull();

    await request(server)
      .get('/api/auth/me')
      .set('Cookie', cookie)
      .expect(200)
      .expect({ ...publicUser, canCreateProjects: false });
    const logout = await post('/api/auth/logout').set('Cookie', cookie).expect(204);
    expect(logout.text).toBe('');
    expectClearedCookie(logout);
    expect(await prisma.session.count()).toBe(0);
    expect(await prisma.user.count()).toBe(1);
    await request(server).get('/api/auth/me').set('Cookie', cookie).expect(401);
  });

  it.each([
    { label: '같은 이메일', value: email, address: email, canCreateProjects: true },
    { label: '설정의 대소문자가 다름', value: email.toUpperCase(), address: email, canCreateProjects: true },
    { label: '설정에 앞뒤 공백이 있음', value: `  ${email}  `, address: email, canCreateProjects: true },
    {
      label: '설정의 대소문자와 앞뒤 공백이 다름',
      value: ` \t${email.toUpperCase()}\n `,
      address: email,
      canCreateProjects: true,
    },
    { label: '로그인 이메일이 정리됨', value: email, address: `  ${email.toUpperCase()}  `, canCreateProjects: true },
    { label: '다른 이메일', value: 'developer@example.com', address: email, canCreateProjects: false },
    { label: '설정 없음', value: undefined, address: email, canCreateProjects: false },
    { label: '설정이 빈 문자열', value: '', address: email, canCreateProjects: false },
    { label: '설정이 공백만', value: ' \t\n ', address: email, canCreateProjects: false },
  ])('/me는 $label이면 canCreateProjects가 $canCreateProjects다', async ({ value, address, canCreateProjects }) => {
    vi.stubEnv('DEVELOPER_EMAIL', value);
    const { response, cookie } = await login(address);
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const publicUser = { id: user.id, email, name };
    expect(response.body).toEqual(publicUser);

    await request(server)
      .get('/api/auth/me')
      .set('Cookie', cookie)
      .expect(200)
      .expect({ ...publicUser, canCreateProjects });
  });

  it('/me는 각 세션의 이메일로 권한을 구분하고 프로젝트가 없어도 개발자에게 true를 돌려준다', async () => {
    vi.stubEnv('DEVELOPER_EMAIL', email);
    const developer = await login();
    const client = await login('client@example.com', '클라이언트');
    expect(await prisma.project.count()).toBe(0);
    expect(await prisma.projectMember.count()).toBe(0);

    await request(server)
      .get('/api/auth/me')
      .set('Cookie', developer.cookie)
      .expect(200)
      .expect({ ...developer.response.body, canCreateProjects: true });
    await request(server)
      .get('/api/auth/me')
      .set('Cookie', client.cookie)
      .expect(200)
      .expect({ ...client.response.body, canCreateProjects: false });
  });

  it.each([
    { value: 'true', secure: true },
    { value: 'TRUE', secure: false },
    { value: '1', secure: false },
    { value: 'false', secure: false },
    { value: undefined, secure: false },
  ])('COOKIE_SECURE=$value이면 생성·삭제 쿠키의 Secure는 $secure다', async ({ value, secure }) => {
    vi.stubEnv('COOKIE_SECURE', value);
    const { response, cookie } = await login();
    expect(sessionCookie(response).split('; ').includes('Secure')).toBe(secure);
    const logout = await post('/api/auth/logout').set('Cookie', cookie).expect(204);
    expectClearedCookie(logout);
    expect(sessionCookie(logout).split('; ').includes('Secure')).toBe(secure);
    expect(await prisma.session.count()).toBe(0);
  });

  const invalidEmails = [
    { label: '없음', value: undefined },
    { label: '빈 문자열', value: '' },
    { label: '공백만', value: '   ' },
    { label: '이메일 모양 아님', value: 'not-an-email' },
    { label: '255자', value: `${maxLengthEmail}a` },
    { label: '숫자', value: 123 },
    { label: '배열', value: [email] },
    { label: '객체', value: { address: email } },
    { label: 'null', value: null },
  ];

  it.each(
    ['email-code', 'verify-code'].flatMap((endpoint) =>
      invalidEmails.map(({ label, value }) => ({ endpoint, label, value })),
    ),
  )('$endpoint에서 email이 $label이면 입력 오류 422다', async ({ endpoint, value }) => {
    const body =
      endpoint === 'email-code' ? { email: value, privacyAgreed: true } : { email: value, code: '123456', name };
    const response = await post(`/api/auth/${endpoint}`).send(body).expect(422);
    expect(response.body.statusCode).toBe(422);
    expect(response.body.message).toEqual(expect.any(Array));
    expect(response.body).not.toHaveProperty('code');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(sendLoginCode).not.toHaveBeenCalled();
    expect(await prisma.loginCode.count()).toBe(0);
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.session.count()).toBe(0);
  });

  it.each([
    { label: '없음', value: undefined },
    { label: '5자리', value: '12345' },
    { label: '7자리', value: '1234567' },
    { label: '영문', value: 'abcdef' },
    { label: '숫자 타입', value: 123456 },
    { label: '앞 공백', value: ' 123456' },
    { label: '뒤 공백', value: '123456 ' },
    { label: '뒤 줄바꿈', value: '123456\n' },
    { label: '전각 숫자', value: '１２３４５６' },
    { label: '배열', value: ['123456'] },
    { label: 'null', value: null },
  ])('code가 $label이면 422이고 시도 횟수를 쓰지 않는다', async ({ value }) => {
    await requestCode();
    const response = await post('/api/auth/verify-code').send({ email, code: value, name }).expect(422);
    expect(response.body.message).toEqual(expect.any(Array));
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(await prisma.loginCode.findUniqueOrThrow({ where: { email } })).toMatchObject({
      attempts: 0,
      usedAt: null,
    });
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.session.count()).toBe(0);
  });

  it.each([
    { label: '빈 문자열', value: '' },
    { label: '공백만', value: '   ' },
    { label: '정리 후 31자', value: `  ${'가'.repeat(31)}  ` },
    { label: '숫자', value: 123 },
    { label: '배열', value: ['이름'] },
    { label: '객체', value: { name: '이름' } },
  ])('name이 $label이면 맞는 코드라도 422이고 가입하지 않는다', async ({ value }) => {
    const code = await requestCode();
    const response = await post('/api/auth/verify-code').send({ email, code, name: value }).expect(422);
    expect(response.body.message).toEqual(expect.any(Array));
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(await prisma.loginCode.findUniqueOrThrow({ where: { email } })).toMatchObject({
      attempts: 0,
      usedAt: null,
    });
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.session.count()).toBe(0);
  });

  it.each([
    { endpoint: 'email-code', kind: '추가 필드' },
    { endpoint: 'email-code', kind: '배열 본문' },
    { endpoint: 'verify-code', kind: '추가 필드' },
    { endpoint: 'verify-code', kind: '배열 본문' },
  ])('$endpoint에서 $kind는 422다', async ({ endpoint, kind }) => {
    const code = endpoint === 'verify-code' ? await requestCode() : undefined;
    const validBody = endpoint === 'email-code' ? { email, privacyAgreed: true } : { email, code, name };
    const body = kind === '추가 필드' ? { ...validBody, isAdmin: true } : [validBody];
    const response = await post(`/api/auth/${endpoint}`).send(body).expect(422);
    expect(response.body.message).toEqual(expect.any(Array));
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(sendLoginCode).toHaveBeenCalledTimes(endpoint === 'verify-code' ? 1 : 0);
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.session.count()).toBe(0);
    if (endpoint === 'verify-code') {
      expect(await prisma.loginCode.findUniqueOrThrow({ where: { email } })).toMatchObject({
        attempts: 0,
        usedAt: null,
      });
    }
  });

  it('이메일은 소문자로, 이름은 앞뒤 공백을 지워 저장한다', async () => {
    const code = await requestCode(' A@X.COM ');
    const response = await post('/api/auth/verify-code')
      .send({ email: 'a@x.com', code, name: '  새 이름  ' })
      .expect(200);
    expect(response.body).toEqual({
      id: expect.any(String),
      email: 'a@x.com',
      name: '새 이름',
    });
    expect(await prisma.loginCode.findMany()).toEqual([expect.objectContaining({ email: 'a@x.com' })]);
    expect(await prisma.user.findMany()).toEqual([expect.objectContaining({ email: 'a@x.com', name: '새 이름' })]);
  });

  it.each(['가', '가'.repeat(30)])('이름 길이 경계값 %s는 공백 제거 뒤 허용한다', async (userName) => {
    const code = await requestCode();
    const response = await post('/api/auth/verify-code')
      .send({
        email: `  ${email.toUpperCase()}  `,
        code,
        name: `  ${userName}  `,
      })
      .expect(200);
    expect(response.body).toEqual({
      id: expect.any(String),
      email,
      name: userName,
    });
    expect(await prisma.user.findUniqueOrThrow({ where: { email } })).toMatchObject({
      name: userName,
    });
  });

  it('254자 이메일은 양쪽 API에서 허용한다', async () => {
    expect(maxLengthEmail).toHaveLength(254);
    const { response } = await login(maxLengthEmail);
    expect(response.body).toEqual({
      id: expect.any(String),
      email: maxLengthEmail,
      name,
    });
  });

  it('틀린 코드는 CODE_WRONG이고 코드가 없으면 CODE_EXPIRED다', async () => {
    const code = await requestCode();
    const wrongCode = code === '000000' ? '000001' : '000000';
    expectCodeError(
      await post('/api/auth/verify-code').send({
        email,
        code: wrongCode,
        name,
      }),
      'CODE_WRONG',
    );
    expectCodeError(
      await post('/api/auth/verify-code').send({
        email: 'missing@example.com',
        code,
        name,
      }),
      'CODE_EXPIRED',
    );
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.session.count()).toBe(0);
  });

  it('네 번 틀린 새 사용자도 NAME_REQUIRED 뒤 같은 코드와 이름으로 가입한다', async () => {
    const code = await requestCode();
    const wrongCode = code === '000000' ? '000001' : '000000';
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expectCodeError(await post('/api/auth/verify-code').send({ email, code: wrongCode }), 'CODE_WRONG');
    }
    expectCodeError(await post('/api/auth/verify-code').send({ email, code }), 'NAME_REQUIRED');
    expect(await prisma.loginCode.findUniqueOrThrow({ where: { email } })).toMatchObject({
      attempts: 4,
      usedAt: null,
    });
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.session.count()).toBe(0);
    await post('/api/auth/verify-code').send({ email, code, name }).expect(200);
    expect(await prisma.session.count()).toBe(1);
  });

  it('60초 안에 대소문자와 공백만 바꿔 다시 요청해도 429이고 재발송하지 않는다', async () => {
    await requestCode();
    const savedCode = await prisma.loginCode.findUniqueOrThrow({
      where: { email },
    });
    const response = await post('/api/auth/email-code')
      .send({ email: ` ${email.toUpperCase()} `, privacyAgreed: true })
      .expect(429);
    expect(response.body.statusCode).toBe(429);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(sendLoginCode).toHaveBeenCalledTimes(1);
    expect(await prisma.loginCode.findUniqueOrThrow({ where: { email } })).toEqual(savedCode);
  });

  it('기존 사용자도 코드 요청은 204이고 이름 없이 로그인한다', async () => {
    const user = await prisma.user.create({
      data: { email, name: '기존 이름' },
    });
    const code = await requestCode();
    vi.stubEnv('DEVELOPER_EMAIL', 'developer@example.com');
    const response = await post('/api/auth/verify-code').send({ email, code }).expect(200);
    expect(response.body).toEqual({ id: user.id, email, name: '기존 이름' });
    expect(await prisma.user.count()).toBe(1);
    await request(server)
      .get('/api/auth/me')
      .set('Cookie', sessionCookie(response).split(';')[0])
      .expect(200)
      .expect({ ...response.body, canCreateProjects: false });
  });

  it('만료된 코드와 이미 쓴 코드는 CODE_EXPIRED이고 세션을 더 만들지 않는다', async () => {
    const { code } = await login();
    expectCodeError(await post('/api/auth/verify-code').send({ email, code, name }), 'CODE_EXPIRED');
    const expiredEmail = 'expired@example.com';
    const expiredCode = await requestCode(expiredEmail);
    await prisma.$executeRaw`
      UPDATE login_codes SET expires_at = now() - interval '1 second'
      WHERE email = ${expiredEmail}
    `;
    expectCodeError(
      await post('/api/auth/verify-code').send({
        email: expiredEmail,
        code: expiredCode,
        name,
      }),
      'CODE_EXPIRED',
    );
    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.session.count()).toBe(1);
  });

  it('동시에 코드를 두 번 요청하면 204와 429이고 메일은 한 번만 보낸다', async () => {
    vi.stubEnv('DEVELOPER_EMAIL', email);
    const responses = await Promise.all([
      post('/api/auth/email-code').send({ email, privacyAgreed: true }),
      post('/api/auth/email-code').send({ email, privacyAgreed: true }),
    ]);
    expect(responses.map((response) => response.status).sort((first, second) => first - second)).toEqual([204, 429]);
    expect(sendLoginCode).toHaveBeenCalledTimes(1);
    expect(await prisma.loginCode.count()).toBe(1);
  });

  it('동시에 맞는 코드를 두 번 보내도 로그인과 세션은 하나만 성공한다', async () => {
    const code = await requestCode();
    const responses = await Promise.all([
      post('/api/auth/verify-code').send({ email, code, name }),
      post('/api/auth/verify-code').send({ email, code, name }),
    ]);
    expect(responses.map((response) => response.status).sort((first, second) => first - second)).toEqual([200, 422]);
    expectCodeError(
      responses.find((response) => response.status === 422)!,
      'CODE_EXPIRED',
    );
    sessionCookie(responses.find((response) => response.status === 200)!);
    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.session.count()).toBe(1);
  });

  it('틀린 코드 열 번이 동시에 와도 다섯 번까지만 시도하고 맞는 코드도 잠근다', async () => {
    const code = await requestCode();
    const wrongCode = code === '000000' ? '000001' : '000000';
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => post('/api/auth/verify-code').send({ email, code: wrongCode, name })),
    );
    const wrong = responses.filter((response) => response.body.code === 'CODE_WRONG');
    const expired = responses.filter((response) => response.body.code === 'CODE_EXPIRED');
    expect(wrong).toHaveLength(5);
    expect(expired).toHaveLength(5);
    wrong.forEach((response) => expectCodeError(response, 'CODE_WRONG'));
    expired.forEach((response) => expectCodeError(response, 'CODE_EXPIRED'));
    expectCodeError(await post('/api/auth/verify-code').send({ email, code, name }), 'CODE_EXPIRED');
    expect(await prisma.loginCode.findUniqueOrThrow({ where: { email } })).toMatchObject({
      attempts: 5,
      usedAt: null,
    });
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.session.count()).toBe(0);
  }, 15_000);

  it('health는 쿠키와 Origin 없이 열리고 다른 Origin의 GET도 허용한다', async () => {
    await request(server).get('/api/health').expect(200).expect({ status: 'ok' });
    await request(server)
      .get('/api/health')
      .set('Origin', 'https://other.example')
      .expect(200)
      .expect({ status: 'ok' });
  });

  it.each([
    undefined,
    'sid=unknown-session',
    'sid=',
    'another-cookie=value',
    `sid=${encodeURIComponent('j:{"token":"value"}')}`,
    `sid=${encodeURIComponent('j:["value"]')}`,
    `sid=${encodeURIComponent('j:123')}`,
    `sid=${encodeURIComponent('j:null')}`,
  ])('유효한 문자열 sid가 아니면 /me는 401이고 logout은 204다: %s', async (cookie) => {
    const me = request(server).get('/api/auth/me');
    if (cookie !== undefined) me.set('Cookie', cookie);
    await me.expect(401);
    // supertest는 요청이 끝나면 테스트 서버를 닫아서, 다음 요청은 앞 요청이 끝난 뒤 만든다.
    const logout = post('/api/auth/logout');
    if (cookie !== undefined) logout.set('Cookie', cookie);
    const response = await logout.expect(204);
    expect(response.text).toBe('');
    expectClearedCookie(response);
  });

  it.each([
    { label: 'Origin 없음', value: undefined },
    { label: '다른 호스트', value: 'http://other.example:5173' },
    { label: '다른 프로토콜', value: 'https://localhost:5173' },
    { label: '다른 포트', value: 'http://localhost:5174' },
    { label: 'null 출처', value: 'null' },
  ])('$label이면 공개 POST 세 개도 403이고 DB를 바꾸지 않는다', async ({ value }) => {
    const { cookie, code } = await login();
    for (const path of ['email-code', 'verify-code', 'logout']) {
      const pending = request(server)
        .post(`/api/auth/${path}`)
        .set('Cookie', cookie)
        .send({ email, code, name, ...(path === 'email-code' ? { privacyAgreed: true } : {}) });
      if (value !== undefined) pending.set('Origin', value);
      const response = await pending.expect(403);
      expect(response.headers['set-cookie']).toBeUndefined();
    }
    expect(sendLoginCode).toHaveBeenCalledTimes(1);
    expect(await prisma.session.count()).toBe(1);
    await request(server).get('/api/auth/me').set('Cookie', cookie).expect(200);
  });

  it('8080 Origin도 코드 발급·로그인·로그아웃을 모두 통과한다', async () => {
    const allowedOrigin = 'http://localhost:8080';
    const code = await requestCode(email, allowedOrigin);
    const response = await request(server)
      .post('/api/auth/verify-code')
      .set('Origin', allowedOrigin)
      .send({ email, code, name })
      .expect(200);
    await request(server)
      .post('/api/auth/logout')
      .set('Origin', allowedOrigin)
      .set('Cookie', sessionCookie(response).split(';')[0])
      .expect(204);
    expect(await prisma.session.count()).toBe(0);
  });

  it('새 비공개 POST에도 전역 가드가 적용되고 Origin 검사가 세션 검사보다 먼저다', async () => {
    await request(server).post('/api/auth-test/private').set('Origin', 'https://other.example').expect(403);
    await request(server).post('/api/auth-test/private').expect(403);
    await post('/api/auth-test/private').expect(401);
    const { cookie } = await login();
    await post('/api/auth-test/private').set('Cookie', cookie).expect(201).expect({ ok: true });
  });

  it.each(['만료', '24시간 미사용'])('세션이 %s이면 /me는 401이고 로그아웃으로 삭제할 수 있다', async (state) => {
    const { cookie } = await login();
    if (state === '만료') {
      await prisma.$executeRaw`UPDATE sessions SET expires_at = now() - interval '1 second'`;
    }
    if (state === '24시간 미사용') {
      await prisma.$executeRaw`UPDATE sessions SET last_seen_at = now() - interval '24 hours 1 second'`;
    }
    await request(server).get('/api/auth/me').set('Cookie', cookie).expect(401);
    const response = await post('/api/auth/logout').set('Cookie', cookie).expect(204);
    expectClearedCookie(response);
    expect(await prisma.session.count()).toBe(0);
  });

  it('로그아웃은 그 쿠키의 세션만 지우고 같은 사람의 다른 세션과 다른 사람은 유지한다', async () => {
    const first = await login();
    await prisma.$executeRaw`
      UPDATE login_codes SET created_at = now() - interval '61 seconds'
      WHERE email = ${email}
    `;
    const second = await login();
    const other = await login('other@example.com', '다른 사용자');
    expect(await prisma.session.count()).toBe(3);
    await post('/api/auth/logout').set('Cookie', first.cookie).expect(204);
    expect(await prisma.session.count()).toBe(2);
    await request(server).get('/api/auth/me').set('Cookie', first.cookie).expect(401);
    await request(server)
      .get('/api/auth/me')
      .set('Cookie', second.cookie)
      .expect(200)
      .expect({ ...first.response.body, canCreateProjects: false });
    await request(server)
      .get('/api/auth/me')
      .set('Cookie', other.cookie)
      .expect(200)
      .expect({ ...other.response.body, canCreateProjects: false });

    const remaining = await prisma.session.findMany({ orderBy: { id: 'asc' } });
    await post('/api/auth/logout').expect(204);
    await post('/api/auth/logout').set('Cookie', 'sid=unknown-session').expect(204);
    await post('/api/auth/logout').set('Cookie', first.cookie).expect(204);
    expect(await prisma.session.findMany({ orderBy: { id: 'asc' } })).toEqual(remaining);
    expect(await prisma.user.count()).toBe(2);
  });

  it.each(['모르는 이메일', '만료', '무효', '수락'])(
    '%s도 204·429·CODE_WRONG 본문이 같고 맞는 코드로 가입할 수 없다',
    async (state) => {
      const address = 'blocked@example.com';
      const knownCode = '000042';
      const existing = await prisma.user.create({ data: { email: 'existing@example.com', name: '기존 사용자' } });
      if (state !== '모르는 이메일') {
        const project = await prisma.project.create({ data: { name: '로그인 제한' } });
        await prisma.$executeRaw`
        INSERT INTO invitations (project_id, email, token_hash, invited_by_id, expires_at, accepted_at, revoked_at)
        VALUES (${project.id}::uuid, ${address}, ${createHash('sha256').update(state).digest('hex')}, ${existing.id}::uuid,
                now() + ${state === '만료' ? 0 : 604800} * interval '1 second',
                CASE WHEN ${state === '수락'} THEN now() ELSE NULL END,
                CASE WHEN ${state === '무효'} THEN now() ELSE NULL END)
      `;
      }

      const allowed = await post('/api/auth/email-code')
        .send({ email: existing.email, privacyAgreed: true })
        .expect(204);
      const blocked = await post('/api/auth/email-code').send({ email: address, privacyAgreed: true }).expect(204);
      expect(blocked.text).toBe(allowed.text);
      expect(blocked.text).toBe('');
      expect(blocked.headers['set-cookie']).toBeUndefined();
      expect(sendLoginCode).toHaveBeenCalledExactlyOnceWith(existing.email, expect.stringMatching(/^\d{6}$/));
      const saved = await prisma.loginCode.findUniqueOrThrow({ where: { email: address } });
      expect(saved).toMatchObject({ attempts: 0, usedAt: null });
      expect(saved.codeHash).toMatch(/^\$2[aby]\$12\$/);
      const allowedRetry = await post('/api/auth/email-code')
        .send({ email: existing.email, privacyAgreed: true })
        .expect(429);
      const blockedRetry = await post('/api/auth/email-code')
        .send({ email: ` ${address.toUpperCase()} `, privacyAgreed: true })
        .expect(429);
      expect(blockedRetry.body).toEqual(allowedRetry.body);
      expect(blockedRetry.headers['set-cookie']).toBeUndefined();
      expect(await prisma.loginCode.findUniqueOrThrow({ where: { email: address } })).toEqual(saved);
      expect(sendLoginCode).toHaveBeenCalledTimes(1);

      // 메일을 받지 못한 사람도 정답을 알아낸 경우를 DB의 테스트 코드로 재현한다.
      await prisma.loginCode.update({
        where: { email: address },
        data: { codeHash: await bcrypt.hash(knownCode, 12) },
      });
      const mailedCode = sendLoginCode.mock.calls[0][1];
      const wrongAllowed = await post('/api/auth/verify-code').send({
        email: existing.email,
        code: mailedCode === '999999' ? '999998' : '999999',
      });
      const wrongBlocked = await post('/api/auth/verify-code').send({ email: address, code: '999999' });
      expectCodeError(wrongAllowed, 'CODE_WRONG');
      expectCodeError(wrongBlocked, 'CODE_WRONG');
      expect(wrongBlocked.body).toEqual(wrongAllowed.body);
      const correctWithoutName = await post('/api/auth/verify-code').send({ email: address, code: knownCode });
      expectCodeError(correctWithoutName, 'CODE_WRONG');
      expect(correctWithoutName.body).toEqual(wrongAllowed.body);
      expect(await prisma.loginCode.findUniqueOrThrow({ where: { email: address } })).toMatchObject({
        attempts: 2,
        usedAt: null,
      });
      const correctWithName = await post('/api/auth/verify-code').send({ email: address, code: knownCode, name });
      expectCodeError(correctWithName, 'CODE_WRONG');
      expect(correctWithName.body).toEqual(wrongAllowed.body);
      expect(await prisma.loginCode.findUniqueOrThrow({ where: { email: address } })).toMatchObject({
        attempts: 3,
        usedAt: null,
      });
      expect(await prisma.user.findUnique({ where: { email: address } })).toBeNull();
      expect(await prisma.session.count()).toBe(0);
    },
  );

  it('코드를 받은 뒤 초대가 무효가 되면 맞는 코드로도 가입할 수 없고 이름도 묻지 않는다', async () => {
    const inviter = await prisma.user.create({ data: { email: 'developer@example.com', name: '개발자' } });
    const project = await prisma.project.create({ data: { name: '코드 발급 뒤 초대 변경' } });

    for (const state of ['revoked', 'expired']) {
      const address = `${state}-after-code@example.com`;
      await prisma.$executeRaw`
        INSERT INTO invitations (project_id, email, token_hash, invited_by_id, expires_at)
        VALUES (${project.id}::uuid, ${address}, ${createHash('sha256').update(address).digest('hex')},
                ${inviter.id}::uuid, now() + interval '7 days')
      `;
      sendLoginCode.mockClear();
      await post('/api/auth/email-code').send({ email: address, privacyAgreed: true }).expect(204);
      expect(sendLoginCode).toHaveBeenCalledExactlyOnceWith(address, expect.stringMatching(/^\d{6}$/));
      const code = sendLoginCode.mock.calls[0][1];

      await prisma.$executeRaw`
        UPDATE invitations
        SET revoked_at = CASE WHEN ${state === 'revoked'} THEN now() ELSE NULL END,
            expires_at = CASE WHEN ${state === 'expired'} THEN now() - interval '1 second' ELSE expires_at END
        WHERE project_id = ${project.id}::uuid AND email = ${address}
      `;
      const invitations = await prisma.invitation.findMany({ orderBy: { id: 'asc' } });
      const wrong = await post('/api/auth/verify-code').send({
        email: address,
        code: code === '999999' ? '999998' : '999999',
      });
      expectCodeError(wrong, 'CODE_WRONG');
      const withoutName = await post('/api/auth/verify-code').send({ email: address, code });
      expectCodeError(withoutName, 'CODE_WRONG');
      expect(withoutName.body).toEqual(wrong.body);
      expect(await prisma.user.findUnique({ where: { email: address } })).toBeNull();

      const withName = await post('/api/auth/verify-code').send({ email: address, code, name });
      expectCodeError(withName, 'CODE_WRONG');
      expect(withName.body).toEqual(wrong.body);
      expect(await prisma.user.findUnique({ where: { email: address } })).toBeNull();
      expect(await prisma.session.count()).toBe(0);
      expect(await prisma.projectMember.count()).toBe(0);
      expect(await prisma.loginCode.findUniqueOrThrow({ where: { email: address } })).toMatchObject({ usedAt: null });
      expect(await prisma.invitation.findMany({ orderBy: { id: 'asc' } })).toEqual(invitations);
    }
  });

  it('가입 트랜잭션이 기다리는 동안 초대가 만료되면 가입할 수 없고 코드는 안 쓴 것으로 남는다', async () => {
    const address = 'expires-during-signup@example.com';
    const inviter = await prisma.user.create({ data: { email: 'developer@example.com', name: '개발자' } });
    const project = await prisma.project.create({ data: { name: '가입 잠금 중 초대 만료' } });
    await prisma.$executeRaw`
      INSERT INTO invitations (project_id, email, token_hash, invited_by_id, expires_at)
      VALUES (${project.id}::uuid, ${address}, ${createHash('sha256').update(address).digest('hex')},
              ${inviter.id}::uuid, clock_timestamp() + interval '7 days')
    `;
    await post('/api/auth/email-code').send({ email: address, privacyAgreed: true }).expect(204);
    expect(sendLoginCode).toHaveBeenCalledExactlyOnceWith(address, expect.stringMatching(/^\d{6}$/));
    const code = sendLoginCode.mock.calls[0][1];
    const wrong = await post('/api/auth/verify-code').send({
      email: address,
      code: code === '999999' ? '999998' : '999999',
      name,
    });
    expectCodeError(wrong, 'CODE_WRONG');
    const savedCode = await prisma.loginCode.findUniqueOrThrow({ where: { email: address } });
    await prisma.$executeRaw`
      UPDATE invitations SET expires_at = clock_timestamp() + interval '2 seconds'
      WHERE project_id = ${project.id}::uuid AND email = ${address}
    `;
    let response: Response | undefined;
    let requestError: unknown;
    let requestFinished = false;
    let verifyRequest: Promise<void> | undefined;

    try {
      await prisma.$transaction(async (tx) => {
        const [connection] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        verifyRequest = post('/api/auth/verify-code')
          .send({ email: address, code, name })
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

        // 첫 UPDATE(시도 횟수)는 통과시키고, 실제 bcrypt 비교 중에 줄을 잡아 가입 UPDATE를 기다리게 한다.
        await vi.waitFor(
          async () => {
            const locked = await tx.$queryRaw<{ id: string }[]>`
              SELECT id FROM login_codes
              WHERE email = ${address} AND attempts = ${savedCode.attempts + 1} AND used_at IS NULL
              FOR UPDATE
            `;
            expect(locked).toHaveLength(1);
          },
          { timeout: 1_000, interval: 10 },
        );
        await vi.waitFor(
          async () => {
            const [waiting] = await prisma.$queryRaw<{ blocked: boolean }[]>`
              SELECT EXISTS (
                SELECT 1 FROM pg_stat_activity AS activity
                JOIN invitations AS invitation ON invitation.project_id = ${project.id}::uuid
                  AND invitation.email = ${address}
                WHERE ${connection.pid}::int = ANY(pg_blocking_pids(activity.pid))
                  AND activity.query LIKE '%UPDATE login_codes SET used_at%'
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
              SELECT expires_at <= clock_timestamp() AS expired FROM invitations
              WHERE project_id = ${project.id}::uuid AND email = ${address}
            `;
            expect(expiration.expired).toBe(true);
          },
          { timeout: 3_000, interval: 50 },
        );
        expect(requestFinished).toBe(false);
      });
    } finally {
      // 중간 검증이 실패해도 잠금을 풀고 HTTP 요청까지 끝낸 뒤 다음 테스트로 간다.
      await verifyRequest;
    }

    expect(requestError).toBeUndefined();
    expect(response).toBeDefined();
    expectCodeError(response!, 'CODE_WRONG');
    expect(response!.body).toEqual(wrong.body);
    expect(await prisma.user.findUnique({ where: { email: address } })).toBeNull();
    expect(await prisma.session.count()).toBe(0);
    expect(await prisma.loginCode.findUniqueOrThrow({ where: { email: address } })).toEqual({
      ...savedCode,
      attempts: savedCode.attempts + 1,
      usedAt: null,
    });
  });

  it('메일이 안 가는 이메일도 다섯 번 시도하면 잠기고 60초 뒤 재발급하면 다시 0회다', async () => {
    const address = 'unknown@example.com';
    const knownCode = '000042';
    await post('/api/auth/email-code').send({ email: address, privacyAgreed: true }).expect(204);
    await prisma.loginCode.update({ where: { email: address }, data: { codeHash: await bcrypt.hash(knownCode, 12) } });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expectCodeError(
        await post('/api/auth/verify-code').send({ email: address, code: knownCode, name }),
        'CODE_WRONG',
      );
    }
    expectCodeError(
      await post('/api/auth/verify-code').send({ email: address, code: knownCode, name }),
      'CODE_EXPIRED',
    );
    const before = await prisma.loginCode.findUniqueOrThrow({ where: { email: address } });
    expect(before).toMatchObject({ attempts: 5, usedAt: null });
    await prisma.$executeRaw`UPDATE login_codes SET created_at = now() - interval '60 seconds' WHERE email = ${address}`;

    await post('/api/auth/email-code').send({ email: address, privacyAgreed: true }).expect(204);

    const after = await prisma.loginCode.findUniqueOrThrow({ where: { email: address } });
    expect(after).toMatchObject({ id: before.id, attempts: 0, usedAt: null });
    expect(after.codeHash).not.toBe(before.codeHash);
    await post('/api/auth/email-code').send({ email: address, privacyAgreed: true }).expect(429);
    expect(sendLoginCode).not.toHaveBeenCalled();
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.session.count()).toBe(0);
  });

  it('초대 이메일의 대소문자·공백을 정리해 메일을 보내고 NAME_REQUIRED 뒤 가입한다', async () => {
    const inviter = await prisma.user.create({ data: { email: 'developer@example.com', name: '개발자' } });
    const project = await prisma.project.create({ data: { name: '초대 가입' } });
    await prisma.$executeRaw`
      INSERT INTO invitations (project_id, email, token_hash, invited_by_id, expires_at)
      VALUES (${project.id}::uuid, ${email}, ${createHash('sha256').update('invitation-test').digest('hex')},
              ${inviter.id}::uuid, now() + interval '7 days')
    `;
    const invitations = await prisma.invitation.findMany();
    await post('/api/auth/email-code')
      .send({ email: ` ${email.toUpperCase()} `, privacyAgreed: true })
      .expect(204);
    expect(sendLoginCode).toHaveBeenCalledExactlyOnceWith(email, expect.stringMatching(/^\d{6}$/));
    const code = sendLoginCode.mock.calls[0][1];

    expectCodeError(await post('/api/auth/verify-code').send({ email, code }), 'NAME_REQUIRED');
    expect(await prisma.loginCode.findUniqueOrThrow({ where: { email } })).toMatchObject({ attempts: 0, usedAt: null });
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
    const response = await post('/api/auth/verify-code').send({ email, code, name }).expect(200);

    expect(response.body).toEqual({ id: expect.any(String), email, name });
    await request(server)
      .get('/api/auth/me')
      .set('Cookie', sessionCookie(response).split(';')[0])
      .expect(200)
      .expect({ ...response.body, canCreateProjects: false });
    expect(await prisma.invitation.findMany()).toEqual(invitations);
    expect(await prisma.projectMember.count()).toBe(0);
    expect(await prisma.session.count()).toBe(1);
  });
});

describe('로그인 (e2e)', () => {
  let app: INestApplication | undefined;
  let server: Server;
  let prisma: PrismaService;
  const sendLoginCode = vi.fn<MailService['sendLoginCode']>();
  const post = (path: string) => request(server).post(path).set('Origin', origin);

  beforeEach(async () => {
    vi.stubEnv('APP_ORIGINS', origin);
    vi.stubEnv('DEVELOPER_EMAIL', email);
    sendLoginCode.mockReset();
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MailService)
      .useValue({ sendLoginCode })
      .compile();
    app = module.createNestApplication();
    setupApp(app);
    await app.init();
    server = app.getHttpServer() as Server;
    prisma = app.get(PrismaService);
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

  it('동의 없이 코드를 요청하면 422이고 코드 줄과 메일이 생기지 않는다', async () => {
    const response = await post('/api/auth/email-code').send({ email }).expect(422);

    expect(response.body.message).toEqual(expect.any(Array));
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(sendLoginCode).not.toHaveBeenCalled();
    expect(await prisma.loginCode.count()).toBe(0);
    expect(await prisma.notificationDelivery.count()).toBe(0);
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.session.count()).toBe(0);
  });

  it('동의 값이 false·"true"·빠짐이면 422다', async () => {
    // true 이외의 값이 강제로 불리언으로 바뀌어 통과하지 않아야 한다.
    for (const privacyAgreed of [false, 'true', undefined, null, 1, 'false', [], {}]) {
      const response = await post('/api/auth/email-code').send({ email, privacyAgreed }).expect(422);
      expect(response.body.message).toEqual(expect.any(Array));
      expect(response.body).not.toHaveProperty('code');
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(sendLoginCode).not.toHaveBeenCalled();
      expect(await prisma.loginCode.count()).toBe(0);
    }
    expect(await prisma.notificationDelivery.count()).toBe(0);
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.session.count()).toBe(0);
  });

  it('동의하고 로그인하면 새 사용자와 기존 사용자 모두 동의 시각이 적힌다', async () => {
    const previousConsent = new Date('2020-01-01T00:00:00Z');
    await prisma.user.create({ data: { email: 'first-consent@example.com', name } });
    await prisma.user.create({
      data: { email: 'renew-consent@example.com', name, privacyAgreedAt: previousConsent },
    });

    for (const address of [email, 'first-consent@example.com', 'renew-consent@example.com']) {
      const beforeUser = await prisma.user.findUnique({ where: { email: address } });
      await post('/api/auth/email-code').send({ email: address, privacyAgreed: true }).expect(204);
      expect(await prisma.loginCode.findUniqueOrThrow({ where: { email: address } })).toMatchObject({
        privacyAgreed: true,
        usedAt: null,
      });
      // 코드 요청만으로 동의 시각을 쓰거나 새 사용자를 만들지 않는다.
      expect(await prisma.user.findUnique({ where: { email: address } })).toEqual(beforeUser);
      expect(sendLoginCode.mock.lastCall).toEqual([address, expect.stringMatching(/^\d{6}$/)]);
      const code = sendLoginCode.mock.lastCall![1];
      const [{ now: before }] = await prisma.$queryRaw<{ now: Date }[]>`SELECT now()`;

      const response = await post('/api/auth/verify-code')
        .send({ email: address, code, ...(beforeUser ? {} : { name }) })
        .expect(200);

      sessionCookie(response);
      const [{ now: after }] = await prisma.$queryRaw<{ now: Date }[]>`SELECT now()`;
      const user = await prisma.user.findUniqueOrThrow({ where: { email: address } });
      expect(response.body).toEqual({ id: user.id, email: address, name });
      expect(user.privacyAgreedAt).toBeInstanceOf(Date);
      expect(user.privacyAgreedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(user.privacyAgreedAt!.getTime()).toBeLessThanOrEqual(after.getTime());
      expect(user.privacyAgreedAt).toEqual(user.lastSeenAt);
      expect(user.privacyAgreedAt).not.toEqual(beforeUser?.privacyAgreedAt);
      expect(await prisma.session.count({ where: { userId: user.id } })).toBe(1);
    }
    expect(sendLoginCode).toHaveBeenCalledTimes(3);
    expect(await prisma.user.count()).toBe(3);
  });

  it('로그인이 실패하면 동의 시각도 적히지 않는다', async () => {
    await prisma.user.create({ data: { email: 'first-consent@example.com', name } });
    await prisma.user.create({
      data: { email: 'renew-consent@example.com', name, privacyAgreedAt: new Date('2020-01-01T00:00:00Z') },
    });
    const beforeUsers = await prisma.user.findMany({ orderBy: { email: 'asc' } });
    try {
      // 세션을 넣은 뒤 커밋에서 실패시켜, 동의 시각까지 쓴 실제 로그인 트랜잭션을 되돌린다.
      await prisma.$executeRaw`
        CREATE FUNCTION consent_e2e_fail_commit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'consent e2e commit failure'; END; $$
      `;
      await prisma.$executeRaw`
        CREATE CONSTRAINT TRIGGER consent_e2e_fail_commit AFTER INSERT ON sessions
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION consent_e2e_fail_commit()
      `;

      for (const address of [email, 'first-consent@example.com', 'renew-consent@example.com']) {
        await post('/api/auth/email-code').send({ email: address, privacyAgreed: true }).expect(204);
        expect(sendLoginCode.mock.lastCall).toEqual([address, expect.stringMatching(/^\d{6}$/)]);
        const code = sendLoginCode.mock.lastCall![1];
        const response = await post('/api/auth/verify-code').send({ email: address, code, name }).expect(500);

        expect(response.headers['set-cookie']).toBeUndefined();
        expect(await prisma.user.findMany({ orderBy: { email: 'asc' } })).toEqual(beforeUsers);
        expect(await prisma.session.count()).toBe(0);
        expect(await prisma.loginCode.findUniqueOrThrow({ where: { email: address } })).toMatchObject({
          privacyAgreed: true,
          usedAt: null,
          attempts: 1,
        });
      }
    } finally {
      await prisma.$executeRaw`DROP TRIGGER IF EXISTS consent_e2e_fail_commit ON sessions`;
      await prisma.$executeRaw`DROP FUNCTION IF EXISTS consent_e2e_fail_commit()`;
    }
  });

  it('동의 없이 만든 코드로는 로그인할 수 없고 동의하고 다시 받은 코드로는 된다', async () => {
    const user = await prisma.user.create({ data: { email, name } });
    const code = '123456';
    const codeHash = await bcrypt.hash(code, 12);
    // 동의 칸을 생략해 배포 전에 만든 코드에 적용되는 DB 기본값도 확인한다.
    await prisma.$executeRaw`
      INSERT INTO login_codes (email, code_hash, expires_at, created_at)
      VALUES (${email}, ${codeHash}, now() + interval '10 minutes', now() - interval '61 seconds')
    `;
    const oldCode = await prisma.loginCode.findUniqueOrThrow({ where: { email } });
    expect(oldCode.privacyAgreed).toBe(false);
    expect(user.privacyAgreedAt).toBeNull();

    expectCodeError(await post('/api/auth/verify-code').send({ email, code }), 'CODE_EXPIRED');

    expect(await prisma.user.findUniqueOrThrow({ where: { email } })).toEqual(user);
    expect(await prisma.loginCode.findUniqueOrThrow({ where: { email } })).toEqual(oldCode);
    expect(await prisma.session.count()).toBe(0);
    expect(sendLoginCode).not.toHaveBeenCalled();

    await post('/api/auth/email-code').send({ email, privacyAgreed: true }).expect(204);
    expect(sendLoginCode).toHaveBeenCalledExactlyOnceWith(email, expect.stringMatching(/^\d{6}$/));
    expect(await prisma.loginCode.findUniqueOrThrow({ where: { email } })).toMatchObject({
      id: oldCode.id,
      privacyAgreed: true,
      usedAt: null,
      attempts: 0,
    });
    const response = await post('/api/auth/verify-code')
      .send({ email, code: sendLoginCode.mock.lastCall![1] })
      .expect(200);
    sessionCookie(response);
    expect(await prisma.user.findUniqueOrThrow({ where: { email } })).toMatchObject({
      id: user.id,
      privacyAgreedAt: expect.any(Date),
    });
    expect(await prisma.session.count()).toBe(1);
  });
});
