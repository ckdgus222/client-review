import { Body, Controller, ForbiddenException, Get, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/guards/session.guard.js';
import { CreateProjectDto } from './dto/create-project.dto.js';
import { projectNotFound, ProjectsService } from './projects.service.js';

// 틀린 모양의 id는 DB에 묻기 전에 끝낸다. 그대로 넘기면 DB가 오류를 내서 500이 된다.
// 없는 프로젝트와 같은 404로 답한다.
const projectIdPipe = new ParseUUIDPipe({ exceptionFactory: projectNotFound });

// 개발자는 서버 설정에 적은 이메일 하나다. 값이 비어 있으면 아무도 프로젝트를 만들 수 없다(막힌 쪽으로 남긴다).
// 로그인 이메일은 소문자로 저장되므로 설정 값도 정리해서 비교한다.
const isDeveloper = (email: string) => {
  const developerEmail = process.env.DEVELOPER_EMAIL?.trim().toLowerCase();
  return Boolean(developerEmail) && email === developerEmail;
};

// 로그인 검사와 다른 사이트 요청 검사는 전역 가드가 이미 한다.
@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  list(@Req() request: AuthenticatedRequest) {
    return this.projects.listMine(request.user.id);
  }

  @Post()
  create(@Req() request: AuthenticatedRequest, @Body() body: CreateProjectDto) {
    if (!isDeveloper(request.user.email)) throw new ForbiddenException('프로젝트는 개발자만 만들 수 있어요');
    return this.projects.create(request.user.id, body.name);
  }

  @Get(':id')
  get(@Req() request: AuthenticatedRequest, @Param('id', projectIdPipe) id: string) {
    return this.projects.getForMember(id, request.user.id);
  }
}
