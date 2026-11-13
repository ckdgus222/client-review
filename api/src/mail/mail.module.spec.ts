import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MailModule } from './mail.module.js';
import { MAIL_TRANSPORT, MailService, type MailTransport } from './mail.service.js';

describe('MailModule', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('환경 설정으로 만든 발송기를 MailService에 연결한다', async () => {
    vi.stubEnv('MAIL_MODE', 'log');
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    const module = await Test.createTestingModule({ imports: [MailModule] }).compile();

    try {
      log.mockClear();
      await module.get(MailService).send({ to: 'client@example.com', subject: '연결 시험', text: '메일 본문' });

      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0][0]).toContain('client@example.com');
      expect(log.mock.calls[0][0]).toContain('메일 본문');
    } finally {
      await module.close();
    }
  });

  it('가져오는 모듈에 MailService와 MAIL_TRANSPORT를 모두 제공한다', async () => {
    const transport = vi.fn<MailTransport>().mockResolvedValue(undefined);
    const module = await Test.createTestingModule({
      imports: [MailModule],
      providers: [
        {
          provide: 'mail-consumer',
          inject: [MailService, MAIL_TRANSPORT],
          useFactory: (service: MailService, send: MailTransport) => ({ service, send }),
        },
      ],
    })
      .overrideProvider(MAIL_TRANSPORT)
      .useValue(transport)
      .compile();

    try {
      const consumer = module.get<{ service: MailService; send: MailTransport }>('mail-consumer');
      const mail = { to: 'client@example.com', subject: '공유 발송기', text: '메일 본문' };

      await consumer.service.send(mail);

      expect(consumer.send).toBe(transport);
      expect(transport).toHaveBeenCalledExactlyOnceWith(mail);
    } finally {
      await module.close();
    }
  });
});
