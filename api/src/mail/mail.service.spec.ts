import { Logger } from '@nestjs/common';
import { MailService } from './mail.service.js';

describe('MailService.sendLoginCode', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('코드와 받는 이메일을 Logger.log에 한 번 전달한다', () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    const service = new MailService();

    service.sendLoginCode('login@example.com', '000042');

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]).toEqual(
      expect.arrayContaining([expect.stringContaining('000042'), expect.stringContaining('login@example.com')]),
    );
  });
});

describe('MailService.sendInvitation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('받는 이메일, 초대 링크, 프로젝트 이름, 초대한 사람 이름을 Logger.log에 한 번 전달한다', () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    const service = new MailService();
    const link = 'https://review.example.com/app/invite/test-invitation';

    service.sendInvitation('client@example.com', link, '쇼핑몰 리뉴얼', '개발자');

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]).toEqual(
      expect.arrayContaining([
        expect.stringContaining('client@example.com'),
        expect.stringContaining(link),
        expect.stringContaining('쇼핑몰 리뉴얼'),
        expect.stringContaining('개발자'),
      ]),
    );
  });
});
