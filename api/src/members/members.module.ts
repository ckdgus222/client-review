import { Module } from '@nestjs/common';
import { ActivityModule } from '../activity/activity.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { MembersController } from './members.controller.js';
import { MembersService } from './members.service.js';

@Module({
  imports: [ProjectsModule, ActivityModule],
  controllers: [MembersController],
  providers: [MembersService],
})
export class MembersModule {}
