import { Module } from '@nestjs/common';
import { ActivityModule } from '../activity/activity.module.js';
import { MailService } from '../mail/mail.service.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { InvitationsController } from './invitations.controller.js';
import { InvitationsService } from './invitations.service.js';

@Module({
  imports: [ProjectsModule, ActivityModule],
  controllers: [InvitationsController],
  // 메일 부품은 로그인(AuthModule)처럼 쓰는 모듈마다 둔다. 지금은 로그만 찍어서 상태가 없다.
  providers: [InvitationsService, MailService],
})
export class InvitationsModule {}
