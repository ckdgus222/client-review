import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/guards/session.guard.js';
import { projectNotFound } from '../projects/projects.service.js';
import { CreateIssueDto } from './dto/create-issue.dto.js';
import { StartIssueDto } from './dto/start-issue.dto.js';
import { issueNotFound, IssuesService } from './issues.service.js';

// 틀린 모양의 id는 DB에 묻기 전에, 없는 프로젝트·쪽지와 같은 404로 끝낸다.
const projectIdPipe = new ParseUUIDPipe({ exceptionFactory: projectNotFound });
const issueIdPipe = new ParseUUIDPipe({ exceptionFactory: issueNotFound });

// 주소가 /projects/:id/issues와 /issues/:id 두 갈래라 공통 앞머리를 두지 않는다.
@Controller()
export class IssuesController {
  constructor(private readonly issues: IssuesService) {}

  @Get('projects/:id/issues')
  list(@Req() request: AuthenticatedRequest, @Param('id', projectIdPipe) projectId: string) {
    return this.issues.list(projectId, request.user.id);
  }

  // 같은 requestId를 다시 보내도 처음 만든 쪽지를 같은 201로 돌려준다. 보내는 쪽은 두 경우를 구별할 필요가 없다.
  @Post('projects/:id/issues')
  create(
    @Req() request: AuthenticatedRequest,
    @Param('id', projectIdPipe) projectId: string,
    @Body() body: CreateIssueDto,
  ) {
    const { screenId, xRatio, yRatio, ...issue } = body;
    // DTO가 "셋 다 있거나 셋 다 없다"를 이미 검사했다. 타입이 그것을 몰라서 셋 다 확인한다.
    const pin =
      screenId !== undefined && xRatio !== undefined && yRatio !== undefined ? { screenId, xRatio, yRatio } : undefined;
    return this.issues.create(projectId, request.user.id, { ...issue, pin });
  }

  @Get('issues/:id')
  get(@Req() request: AuthenticatedRequest, @Param('id', issueIdPipe) issueId: string) {
    return this.issues.getDetail(issueId, request.user.id);
  }

  // 새로 만드는 것이 아니라 쪽지의 상태를 바꾸는 것이라 201 대신 200이다.
  @Post('issues/:id/start')
  @HttpCode(HttpStatus.OK)
  start(@Req() request: AuthenticatedRequest, @Param('id', issueIdPipe) issueId: string, @Body() body: StartIssueDto) {
    return this.issues.start(issueId, request.user.id, body.versionId);
  }
}
