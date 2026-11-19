import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { MailModule } from '../mail/mail.module.js';
import { AlertService } from './alert.service.js';
import { ErrorAlertFilter } from './error-alert.filter.js';

// APP_FILTER로 걸면 main.ts와 e2e 테스트의 앱이 같은 필터를 쓴다(AlertService를 주입받으려고 모듈에서 건다).
@Module({
  imports: [MailModule],
  providers: [AlertService, { provide: APP_FILTER, useClass: ErrorAlertFilter }],
})
export class AlertModule {}
