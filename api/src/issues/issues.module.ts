import { Module } from '@nestjs/common';
import { ActivityModule } from '../activity/activity.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { IssuesController } from './issues.controller.js';
import { IssuesService } from './issues.service.js';

@Module({
  imports: [ProjectsModule, ActivityModule],
  controllers: [IssuesController],
  providers: [IssuesService],
})
export class IssuesModule {}
