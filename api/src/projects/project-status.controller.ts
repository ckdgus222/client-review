import { Body, Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/guards/session.guard.js';
import { DeleteProjectDto } from './dto/delete-project.dto.js';
import { ProjectStatusService } from './project-status.service.js';
import { projectNotFound } from './projects.service.js';

// 틀린 모양의 id는 없는 프로젝트와 같은 404다(ProjectsController와 같다).
const projectIdPipe = new ParseUUIDPipe({ exceptionFactory: projectNotFound });

// 로그인 검사와 다른 사이트 요청 검사는 전역 가드가 이미 한다. 성공하면 본문 없이 204다.
@Controller('projects')
export class ProjectStatusController {
  constructor(private readonly status: ProjectStatusService) {}

  @Post(':id/archive')
  @HttpCode(HttpStatus.NO_CONTENT)
  archive(@Req() request: AuthenticatedRequest, @Param('id', projectIdPipe) id: string) {
    return this.status.archive(id, request.user.id);
  }

  @Post(':id/unarchive')
  @HttpCode(HttpStatus.NO_CONTENT)
  unarchive(@Req() request: AuthenticatedRequest, @Param('id', projectIdPipe) id: string) {
    return this.status.unarchive(id, request.user.id);
  }

  @Post(':id/delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  delete(@Req() request: AuthenticatedRequest, @Param('id', projectIdPipe) id: string, @Body() body: DeleteProjectDto) {
    return this.status.delete(id, request.user.id, body.name);
  }

  @Post(':id/restore')
  @HttpCode(HttpStatus.NO_CONTENT)
  restore(@Req() request: AuthenticatedRequest, @Param('id', projectIdPipe) id: string) {
    return this.status.restore(id, request.user.id);
  }
}
