import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Req,
  UnprocessableEntityException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { AuthenticatedRequest } from '../auth/guards/session.guard.js';
import { projectNotFound } from '../projects/projects.service.js';
import { screenNotFound } from '../screens/screens.service.js';
import { ApprovalService } from './approval.service.js';
import { certificateNotFound, CertificateService } from './certificate.service.js';
import { DraftScreensService } from './draft-screens.service.js';
import { ApproveVersionDto } from './dto/approve-version.dto.js';
import { UpdateDraftDto } from './dto/update-draft.dto.js';
import { versionNotFound, VersionsService } from './versions.service.js';

// 틀린 모양의 id는 DB에 묻기 전에, 없는 프로젝트·버전·화면과 같은 404로 끝낸다.
const projectIdPipe = new ParseUUIDPipe({ exceptionFactory: projectNotFound });
const versionIdPipe = new ParseUUIDPipe({ exceptionFactory: versionNotFound });
const screenIdPipe = new ParseUUIDPipe({ exceptionFactory: screenNotFound });
// 확인서는 없는 버전도 "없는 확인서예요" 하나로 답한다(certificate.service.ts). 모양이 틀린 id도 같은 404다.
const certificateIdPipe = new ParseUUIDPipe({ exceptionFactory: certificateNotFound });

// 주소가 /projects/:id/versions와 /versions/:id 두 갈래라 공통 앞머리를 두지 않는다.
@Controller()
export class VersionsController {
  constructor(
    private readonly versions: VersionsService,
    private readonly draftScreens: DraftScreensService,
    private readonly approval: ApprovalService,
    private readonly certificate: CertificateService,
  ) {}

  @Get('projects/:id/versions')
  list(@Req() request: AuthenticatedRequest, @Param('id', projectIdPipe) projectId: string) {
    return this.versions.list(projectId, request.user.id);
  }

  @Post('projects/:id/versions')
  createDraft(@Req() request: AuthenticatedRequest, @Param('id', projectIdPipe) projectId: string) {
    return this.versions.createDraft(projectId, request.user.id);
  }

  @Get('versions/:id')
  get(@Req() request: AuthenticatedRequest, @Param('id', versionIdPipe) versionId: string) {
    return this.versions.getDetail(versionId, request.user.id);
  }

  @Patch('versions/:id')
  update(
    @Req() request: AuthenticatedRequest,
    @Param('id', versionIdPipe) versionId: string,
    @Body() body: UpdateDraftDto,
  ) {
    return this.versions.updateDraft(versionId, request.user.id, body);
  }

  // file 칸의 사진 한 장을 메모리(Buffer)에 받는다. 20 MiB를 넘으면 multer가 멈추고 Nest가 413으로 바꾼다.
  // 파일이 2개이거나 칸 이름이 file이 아니면 400이다. 로그인과 Origin 검사(가드)는 파일을 읽기 전에 끝난다.
  @Put('versions/:id/screens/:screenId/asset')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }))
  putAsset(
    @Req() request: AuthenticatedRequest,
    @Param('id', versionIdPipe) versionId: string,
    @Param('screenId', screenIdPipe) screenId: string,
    @UploadedFile() photo: Express.Multer.File | undefined,
  ) {
    if (!photo) throw new UnprocessableEntityException('사진 파일을 보내 주세요');
    return this.draftScreens.putAsset(versionId, screenId, request.user.id, photo.buffer);
  }

  @Delete('versions/:id/screens/:screenId')
  removeScreen(
    @Req() request: AuthenticatedRequest,
    @Param('id', versionIdPipe) versionId: string,
    @Param('screenId', screenIdPipe) screenId: string,
  ) {
    return this.draftScreens.removeScreen(versionId, screenId, request.user.id);
  }

  // 게시는 새로 만드는 것이 아니라 게시 전 버전의 상태를 바꾸는 것이라 201 대신 200이다.
  @Post('versions/:id/publish')
  @HttpCode(HttpStatus.OK)
  publish(@Req() request: AuthenticatedRequest, @Param('id', versionIdPipe) versionId: string) {
    return this.versions.publish(versionId, request.user.id);
  }

  // 승인자가 승인하기 전에 지금 상태(끝나지 않은 쪽지, 이번 버전의 댓글, 서버 시각)를 본다.
  @Get('versions/:id/approval-check')
  approvalCheck(@Req() request: AuthenticatedRequest, @Param('id', versionIdPipe) versionId: string) {
    return this.approval.check(versionId, request.user.id);
  }

  // 승인도 게시처럼 버전의 상태를 바꾸는 것이라 200이다.
  @Post('versions/:id/approve')
  @HttpCode(HttpStatus.OK)
  approve(
    @Req() request: AuthenticatedRequest,
    @Param('id', versionIdPipe) versionId: string,
    @Body() body: ApproveVersionDto,
  ) {
    return this.approval.approve(versionId, request.user.id, body.seenAt);
  }

  @Get('versions/:id/certificate')
  getCertificate(@Req() request: AuthenticatedRequest, @Param('id', certificateIdPipe) versionId: string) {
    return this.certificate.get(versionId, request.user.id);
  }
}
