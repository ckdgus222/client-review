import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module.js';
import { HealthModule } from './health/health.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { ProjectsModule } from './projects/projects.module.js';
import { ScreensModule } from './screens/screens.module.js';
import { VersionsModule } from './versions/versions.module.js';

@Module({
  imports: [PrismaModule, HealthModule, AuthModule, ProjectsModule, ScreensModule, VersionsModule],
})
export class AppModule {}
