import { Module } from '@nestjs/common';
import { ProjectsController } from './projects.controller.js';
import { ProjectsService } from './projects.service.js';

@Module({
  controllers: [ProjectsController],
  providers: [ProjectsService],
  // 화면 모듈이 멤버 확인 함수(requireMemberRole)를 쓴다.
  exports: [ProjectsService],
})
export class ProjectsModule {}
