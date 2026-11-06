import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module.js';
import { ScreensController } from './screens.controller.js';
import { ScreensService } from './screens.service.js';

@Module({
  imports: [ProjectsModule],
  controllers: [ScreensController],
  providers: [ScreensService],
})
export class ScreensModule {}
