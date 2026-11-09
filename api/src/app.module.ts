import { Module } from '@nestjs/common';
import { AssetsModule } from './assets/assets.module.js';
import { AuthModule } from './auth/auth.module.js';
import { HealthModule } from './health/health.module.js';
import { InvitationsModule } from './invitations/invitations.module.js';
import { MembersModule } from './members/members.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { ProjectsModule } from './projects/projects.module.js';
import { ScreensModule } from './screens/screens.module.js';
import { VersionsModule } from './versions/versions.module.js';

@Module({
  imports: [PrismaModule, HealthModule, AuthModule, ProjectsModule, ScreensModule, VersionsModule, AssetsModule, InvitationsModule, MembersModule],
})
export class AppModule {}
