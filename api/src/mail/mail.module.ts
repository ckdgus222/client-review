import { Module } from '@nestjs/common';
import { readMailConfig } from './mail-config.js';
import { createMailTransport, MAIL_TRANSPORT, MailService } from './mail.service.js';

// 메일을 쓰는 모듈(로그인, 초대, 우편함)이 이 모듈을 가져와 같은 발송기 하나를 쓴다.
@Module({
  providers: [MailService, { provide: MAIL_TRANSPORT, useFactory: () => createMailTransport(readMailConfig()) }],
  exports: [MailService, MAIL_TRANSPORT],
})
export class MailModule {}
