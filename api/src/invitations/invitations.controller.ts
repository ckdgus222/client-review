import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator.js';
import type { AuthenticatedRequest } from '../auth/guards/session.guard.js';
import { projectNotFound } from '../projects/projects.service.js';
import { AcceptInvitationDto } from './dto/accept-invitation.dto.js';
import { CreateInvitationDto } from './dto/create-invitation.dto.js';
import { InvitationsService } from './invitations.service.js';

// 틀린 모양의 프로젝트 id는 DB에 묻기 전에 없는 프로젝트와 같은 404로 끝낸다.
const projectIdPipe = new ParseUUIDPipe({ exceptionFactory: projectNotFound });

// 주소가 /projects/:id/invitations와 /invitations/... 두 갈래라 공통 앞머리를 두지 않는다.
@Controller()
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Post('projects/:id/invitations')
  create(
    @Req() request: AuthenticatedRequest,
    @Param('id', projectIdPipe) projectId: string,
    @Body() body: CreateInvitationDto,
  ) {
    return this.invitations.create(projectId, request.user.id, body.email);
  }

  // 링크를 연 사람이 로그인 전에 어떤 이메일로 들어가야 하는지 볼 수 있게 로그인 없이 연다.
  @Public()
  @Get('invitations/:token')
  preview(@Param('token') token: string) {
    return this.invitations.preview(token);
  }

  // 새로 만드는 것이 아니라 있는 초대를 쓰는 요청이라 201 대신 200이다.
  @Post('invitations/accept')
  @HttpCode(HttpStatus.OK)
  accept(@Req() request: AuthenticatedRequest, @Body() body: AcceptInvitationDto) {
    return this.invitations.accept(body.token, request.user);
  }
}
