import { Controller, Get, Param, ParseUUIDPipe, Req } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/guards/session.guard.js';
import { projectNotFound } from '../projects/projects.service.js';
import { ActivityService } from './activity.service.js';

// 틀린 모양의 id는 DB에 묻기 전에, 없는 프로젝트와 같은 404로 끝낸다.
const projectIdPipe = new ParseUUIDPipe({ exceptionFactory: projectNotFound });

@Controller('projects')
export class ActivityController {
  constructor(private readonly activity: ActivityService) {}

  @Get(':id/activity')
  list(@Req() request: AuthenticatedRequest, @Param('id', projectIdPipe) projectId: string) {
    return this.activity.listForMember(projectId, request.user.id);
  }
}
