import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module.js';
import { ActivityController } from './activity.controller.js';
import { ActivityService } from './activity.service.js';

@Module({
  imports: [ProjectsModule],
  controllers: [ActivityController],
  providers: [ActivityService],
  // 버전 게시가 같은 트랜잭션 안에서 일지를 쓴다(record).
  exports: [ActivityService],
})
export class ActivityModule {}
