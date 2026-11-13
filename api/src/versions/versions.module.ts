import { Module } from '@nestjs/common';
import { ActivityModule } from '../activity/activity.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { ApprovalService } from './approval.service.js';
import { DraftScreensService } from './draft-screens.service.js';
import { VersionsController } from './versions.controller.js';
import { VersionsService } from './versions.service.js';

@Module({
  imports: [ProjectsModule, ActivityModule],
  controllers: [VersionsController],
  providers: [VersionsService, DraftScreensService, ApprovalService],
})
export class VersionsModule {}
