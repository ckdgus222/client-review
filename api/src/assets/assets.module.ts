import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module.js';
import { AssetsController } from './assets.controller.js';
import { AssetsService } from './assets.service.js';

@Module({
  imports: [ProjectsModule],
  controllers: [AssetsController],
  providers: [AssetsService],
})
export class AssetsModule {}
