import { Module } from '@nestjs/common';
import { ActivityModule } from '../activity/activity.module.js';
import { ProjectStatusController } from './project-status.controller.js';
import { ProjectStatusService } from './project-status.service.js';
import { ProjectsModule } from './projects.module.js';

// 상태 바꾸기는 일지(ActivityService)를 쓰는데, ActivityModule이 ProjectsModule을 가져와서 ProjectsModule 안에 두면 서로 가져오는 고리가 생긴다.
@Module({
  imports: [ProjectsModule, ActivityModule],
  controllers: [ProjectStatusController],
  providers: [ProjectStatusService],
})
export class ProjectStatusModule {}
