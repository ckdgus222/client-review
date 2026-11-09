import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/guards/session.guard.js';
import { projectNotFound } from '../projects/projects.service.js';
import { SetApproverDto } from './dto/set-approver.dto.js';
import { memberNotFound, MembersService } from './members.service.js';

// 틀린 모양의 id는 DB에 묻기 전에, 없는 프로젝트·참여자와 같은 404로 끝낸다.
const projectIdPipe = new ParseUUIDPipe({ exceptionFactory: projectNotFound });
const memberIdPipe = new ParseUUIDPipe({ exceptionFactory: memberNotFound });

// 주소가 /projects/:id/...와 /members/:id/... 두 갈래라 공통 앞머리를 두지 않는다.
@Controller()
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Get('projects/:id/members')
  list(@Req() request: AuthenticatedRequest, @Param('id', projectIdPipe) projectId: string) {
    return this.members.list(projectId, request.user.id);
  }

  @Post('members/:id/revoke')
  @HttpCode(HttpStatus.NO_CONTENT)
  revoke(@Req() request: AuthenticatedRequest, @Param('id', memberIdPipe) memberId: string) {
    return this.members.revoke(memberId, request.user.id);
  }

  // 승인자를 바꾸는 요청이라 201 대신 200이다.
  @Post('projects/:id/approver')
  @HttpCode(HttpStatus.OK)
  async setApprover(
    @Req() request: AuthenticatedRequest,
    @Param('id', projectIdPipe) projectId: string,
    @Body() body: SetApproverDto,
  ) {
    const approver = await this.members.setApprover(projectId, request.user.id, body.memberId);
    return { approver };
  }
}
