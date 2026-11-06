import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import { Controller, type INestApplication, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
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
    const response = await request(server)
      .post('/api/auth/email-code')
      .set('Origin', allowedOrigin)
      .send({ email: address })
      .expect(204);
    expect(response.text).toBe('');
    const delivery = sendLoginCode.mock.lastCall;
    expect(delivery).toEqual([address.trim().toLowerCase(), expect.stringMatching(/^\d{6}$/)]);
    return delivery![1];
  };

  const login = async (address = email, userName = name) => {
    const code = await requestCode(address);
    const response = await post('/api/auth/verify-code').send({ email: address, code, name: userName }).expect(200);
    const cookie = sessionCookie(response).split(';')[0];
    return { response, cookie, code };
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
    const body = endpoint === 'email-code' ? { email: value } : { email: value, code: '123456', name };
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
    const validBody = endpoint === 'email-code' ? { email } : { email, code, name };
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
      .send({ email: ` ${email.toUpperCase()} ` })
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
    const responses = await Promise.all([
      post('/api/auth/email-code').send({ email }),
      post('/api/auth/email-code').send({ email }),
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
      const pending = request(server).post(`/api/auth/${path}`).set('Cookie', cookie).send({ email, code, name });
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
});
