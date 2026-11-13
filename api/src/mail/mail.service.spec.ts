import { Logger } from '@nestjs/common';
import { createTransport } from 'nodemailer';
import { createMailTransport, MailService, type MailTransport } from './mail.service.js';

const { sendMail } = vi.hoisted(() => ({ sendMail: vi.fn() }));

vi.mock('nodemailer', () => ({
  createTransport: vi.fn(() => ({ sendMail })),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  sendMail.mockReset();
});

describe('createMailTransport', () => {
  const mail = { to: 'client@example.com', subject: '[Client Review] 시험', text: '시험 본문' };
  const smtpConfig = {
    mode: 'smtp' as const,
    host: 'smtp.example.com',
    port: 587,
    user: 'test-user',
    pass: 'fake-smtp-password',
    from: 'Client Review <noreply@example.com>',
  };

  it('log 모드는 받는 주소·제목·본문을 로그에 찍고 SMTP에 연결하지 않는다', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    const transport = createMailTransport({ mode: 'log' });

    await expect(transport(mail)).resolves.toBeUndefined();

    expect(log).toHaveBeenCalledTimes(1);
    for (const value of Object.values(mail)) {
      expect(log.mock.calls[0][0]).toContain(value);
    }
    expect(createTransport).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it.each([465, 587, 25, 2525])('SMTP 포트 %i에서 TLS 방식·인증·세 단계의 20초 한도를 설정한다', (port) => {
    createMailTransport({ ...smtpConfig, port });

    expect(createTransport).toHaveBeenCalledExactlyOnceWith({
      host: smtpConfig.host,
      port,
      secure: port === 465,
      requireTLS: port !== 465,
      auth: { user: smtpConfig.user, pass: smtpConfig.pass },
      connectionTimeout: 20_000,
      greetingTimeout: 20_000,
      socketTimeout: 20_000,
    });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('SMTP 발송에 보내는 주소를 붙이고 같은 발송기로 여러 통을 보낸다', async () => {
    sendMail.mockResolvedValue({ messageId: 'fake-message-id' });
    const transport = createMailTransport(smtpConfig);
    const secondMail = { ...mail, to: 'second@example.com', text: '두 번째 본문' };

    await expect(transport(mail)).resolves.toBeUndefined();
    await expect(transport(secondMail)).resolves.toBeUndefined();

    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledTimes(2);
    expect(sendMail).toHaveBeenNthCalledWith(1, { from: smtpConfig.from, ...mail });
    expect(sendMail).toHaveBeenNthCalledWith(2, { from: smtpConfig.from, ...secondMail });
  });

  it('SMTP 발송 실패는 호출한 쪽으로 전달한다', async () => {
    const failure = new Error('시험용 SMTP 실패');
    sendMail.mockRejectedValue(failure);
    const transport = createMailTransport(smtpConfig);

    await expect(transport(mail)).rejects.toBe(failure);
  });
});

describe('MailService.send', () => {
  const mail = { to: 'client@example.com', subject: '알림', text: '알림 본문' };

  it('받는 주소·제목·본문을 발송 함수에 한 번 전달하고 끝날 때까지 기다린다', async () => {
    let finishSending!: () => void;
    const pending = new Promise<void>((resolve) => {
      finishSending = resolve;
    });
    const transport = vi.fn<MailTransport>(async () => {
      await pending;
    });
    const service = new MailService(transport);
    let completed = false;
    const sending = async () => {
      await service.send(mail);
      completed = true;
    };

    const result = sending();
    try {
      // 즉시 반환하는 구현이면 다음 차례에 completed가 true가 된다.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(transport).toHaveBeenCalledExactlyOnceWith(mail);
      expect(completed).toBe(false);
    } finally {
      finishSending();
      await result;
    }
    expect(completed).toBe(true);
  });

  it('발송 함수의 실패를 삼키지 않고 던진다', async () => {
    const failure = new Error('시험용 발송 실패');
    const transport = vi.fn<MailTransport>().mockRejectedValue(failure);
    const service = new MailService(transport);

    await expect(service.send(mail)).rejects.toBe(failure);
    expect(transport).toHaveBeenCalledExactlyOnceWith(mail);
  });
});

describe('MailService.sendLoginCode', () => {
  it('받는 이메일과 앞자리 0을 포함한 코드, 유효시간을 발송 함수에 한 번 전달한다', async () => {
    const transport = vi.fn<MailTransport>().mockResolvedValue(undefined);
    const service = new MailService(transport);

    await Promise.resolve(service.sendLoginCode('login@example.com', '000042'));

    expect(transport).toHaveBeenCalledExactlyOnceWith({
      to: 'login@example.com',
      subject: '[Client Review] 로그인 코드',
      text: expect.stringContaining('000042'),
    });
    expect(transport.mock.calls[0][0].text).toContain('10분');
  });
});

describe('MailService.sendInvitation', () => {
  it('받는 이메일, 초대 링크, 프로젝트 이름, 초대한 사람과 유효시간을 본문에 넣는다', async () => {
    const transport = vi.fn<MailTransport>().mockResolvedValue(undefined);
    const service = new MailService(transport);
    const link = 'https://review.example.com/app/invite/test-invitation';
    const projectName = '쇼핑몰 리뉴얼\r\nBcc: injected@example.com';

    await Promise.resolve(service.sendInvitation('client@example.com', link, projectName, '개발자'));

    expect(transport).toHaveBeenCalledExactlyOnceWith({
      to: 'client@example.com',
      subject: '[Client Review] 프로젝트 초대',
      text: expect.any(String),
    });
    const mail = transport.mock.calls[0][0];
    for (const value of [link, projectName, '개발자', '7일']) {
      expect(mail.text).toContain(value);
    }
    expect(mail.subject).not.toContain('쇼핑몰');
    expect(mail.subject).not.toMatch(/[\r\n]/);
  });
});

describe.each([
  { kind: '로그인 코드', send: (service: MailService) => service.sendLoginCode('client@example.com', '000042') },
  {
    kind: '초대',
    send: (service: MailService) =>
      service.sendInvitation(
        'client@example.com',
        'https://review.example.com/app/invite/test-secret-token',
        '비공개 프로젝트',
        '개발자',
      ),
  },
])('MailService $kind 메일 실패 처리', ({ send }) => {
  it('발송 함수가 끝나지 않아도 기다리지 않고 바로 돌아온다', async () => {
    const transport = vi.fn<MailTransport>(() => new Promise<void>(() => {}));
    const service = new MailService(transport);

    await Promise.resolve(send(service));

    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each(['즉시', '요청이 끝난 뒤'])('%s 실패해도 던지지 않고 실패 로그에는 받는 주소만 남긴다', async (timing) => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    let failSending!: (error: Error) => void;
    const pending = new Promise<void>((_resolve, reject) => {
      failSending = reject;
    });
    const transport = vi.fn<MailTransport>(() => pending);
    const service = new MailService(transport);
    // SMTP 오류가 원래 메일 본문을 포함해도 로그에 옮기면 안 된다.
    const failure = new Error('000042 https://review.example.com/app/invite/test-secret-token 비공개 프로젝트');
    if (timing === '즉시') failSending(failure);

    await Promise.resolve(send(service));
    if (timing === '요청이 끝난 뒤') {
      expect(error).not.toHaveBeenCalled();
      failSending(failure);
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(transport).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
    const output = JSON.stringify(error.mock.calls);
    expect(output).toContain('client@example.com');
    expect(output).toMatch(/메일.*(실패|못)/);
    for (const secret of ['000042', 'https://review.example.com', 'test-secret-token', '비공개 프로젝트']) {
      expect(output).not.toContain(secret);
    }
    expect(log).not.toHaveBeenCalled();
  });
});
