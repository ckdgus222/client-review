import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import bcrypt from 'bcrypt';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { MAIL_TRANSPORT, type MailTransport } from '../src/mail/mail.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { setupApp } from '../src/setup-app.js';
import { resetDatabase } from './reset-database.js';

const origin = 'http://localhost:5173';
const send = vi.fn<MailTransport>();
let app: INestApplication | undefined;
let server: Server;
let prisma: PrismaService;

beforeEach(async () => {
  vi.stubEnv('APP_ORIGINS', origin);
  vi.stubEnv('DEVELOPER_EMAIL', 'developer@example.com');
  send.mockReset().mockResolvedValue(undefined);
  // 인증과 메일 본문은 실제 구현을 쓰고 외부 발송 경계만 시험용으로 바꾼다.
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MAIL_TRANSPORT)
    .useValue(send)
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

it('로그인 메일에는 여섯 자리 코드와 10분 안내가 있다', async () => {
  const email = 'portfolio-client@example.com';
  const user = await prisma.user.create({ data: { email, name: '검수 고객' } });

  await request(server)
    .post('/api/auth/email-code')
    .set('Origin', origin)
    .send({ email, privacyAgreed: true })
    .expect(204);

  expect(send).toHaveBeenCalledTimes(1);
  const mail = send.mock.calls[0][0];
  expect(mail.to).toBe(email);
  expect(mail.subject).toBe('[Client Review] 로그인 코드');
  const codeLines = mail.text.split(/\r?\n/).filter((line) => /^[0-9]{6}$/.test(line));
  expect(codeLines).toHaveLength(1);
  const [code] = codeLines;
  expect(mail.text).toBe(
    `Client Review 로그인 화면에 아래 6자리 코드를 입력해 주세요.\n\n${code}\n\n` +
      '이 코드는 발급 후 10분간 유효합니다. 로그인을 요청하지 않으셨다면 이 메일을 무시해 주세요.',
  );
  const saved = await prisma.loginCode.findUniqueOrThrow({ where: { email } });
  expect(await bcrypt.compare(code, saved.codeHash)).toBe(true);
  expect(saved.expiresAt.getTime() - saved.createdAt.getTime()).toBe(10 * 60 * 1000);

  // 메일에서 읽은 코드 자체로 로그인한다. 미리 아는 코드로 DB를 바꾸지 않는다.
  const login = await request(server)
    .post('/api/auth/verify-code')
    .set('Origin', origin)
    .send({ email, code })
    .expect(200);
  expect(login.body).toEqual({ id: user.id, email, name: user.name });

  await request(server)
    .post('/api/auth/email-code')
    .set('Origin', origin)
    .send({ email, privacyAgreed: true })
    .expect(429);
  await request(server)
    .post('/api/auth/email-code')
    .set('Origin', origin)
    .send({ email: 'uninvited@example.com', privacyAgreed: true })
    .expect(204);
  expect(send).toHaveBeenCalledTimes(1);
});
