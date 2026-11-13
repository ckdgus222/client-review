import { Module } from '@nestjs/common';
import { MailModule } from '../mail/mail.module.js';
import { NotificationsService } from './notifications.service.js';

// 알림 메일 우편함을 꺼내 보내는 반복 작업. 넣기는 활동 일지가 사건을 쓸 때 함수(enqueueNotifications)로 한다.
@Module({
  imports: [MailModule],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
