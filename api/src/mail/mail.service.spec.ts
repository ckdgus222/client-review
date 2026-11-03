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
