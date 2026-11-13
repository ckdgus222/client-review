import { Module } from '@nestjs/common';
import { ActivityModule } from '../activity/activity.module.js';
import { MailModule } from '../mail/mail.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { InvitationsController } from './invitations.controller.js';
import { InvitationsService } from './invitations.service.js';

@Module({
  imports: [ProjectsModule, ActivityModule, MailModule],
  controllers: [InvitationsController],
  providers: [InvitationsService],
})
export class InvitationsModule {}
