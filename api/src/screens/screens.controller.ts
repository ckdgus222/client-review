import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/guards/session.guard.js';
import { projectNotFound } from '../projects/projects.service.js';
import { CreateScreenDto } from './dto/create-screen.dto.js';
import { screenNotFound, ScreensService } from './screens.service.js';

// 틀린 모양의 id는 DB에 묻기 전에, 없는 프로젝트·화면과 같은 404로 끝낸다.
const projectIdPipe = new ParseUUIDPipe({ exceptionFactory: projectNotFound });
const screenIdPipe = new ParseUUIDPipe({ exceptionFactory: screenNotFound });

// 주소가 /projects/:id/screens와 /screens/:id 두 갈래라 공통 앞머리를 두지 않는다.
@Controller()
export class ScreensController {
  constructor(private readonly screens: ScreensService) {}

  @Get('projects/:id/screens')
  list(@Req() request: AuthenticatedRequest, @Param('id', projectIdPipe) projectId: string) {
    return this.screens.list(projectId, request.user.id);
  }

  @Post('projects/:id/screens')
  create(
    @Req() request: AuthenticatedRequest,
    @Param('id', projectIdPipe) projectId: string,
    @Body() body: CreateScreenDto,
  ) {
    return this.screens.create(projectId, request.user.id, body.name, body.viewport);
  }

  // 숨기기·보이기는 새로 만드는 것이 아니라 상태를 바꾸는 것이라 201 대신 200이다.
  @Post('screens/:id/hide')
  @HttpCode(HttpStatus.OK)
  hide(@Req() request: AuthenticatedRequest, @Param('id', screenIdPipe) screenId: string) {
    return this.screens.setHidden(screenId, request.user.id, true);
  }

  @Post('screens/:id/show')
  @HttpCode(HttpStatus.OK)
  show(@Req() request: AuthenticatedRequest, @Param('id', screenIdPipe) screenId: string) {
    return this.screens.setHidden(screenId, request.user.id, false);
  }
}
