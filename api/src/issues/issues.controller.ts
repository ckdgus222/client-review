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
  Req,
  UnprocessableEntityException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { assetNotFound } from '../assets/assets.service.js';
import type { AuthenticatedRequest } from '../auth/guards/session.guard.js';
import { projectNotFound } from '../projects/projects.service.js';
import { CommentsService } from './comments.service.js';
import { CreateCommentDto } from './dto/create-comment.dto.js';
import { CreateIssueDto } from './dto/create-issue.dto.js';
import { StartIssueDto } from './dto/start-issue.dto.js';
import { UpdateIssueDto } from './dto/update-issue.dto.js';
import { IssueAttachmentsService } from './issue-attachments.service.js';
import { IssueTriageService } from './issue-triage.service.js';
import { issueNotFound, IssuesService } from './issues.service.js';

// 틀린 모양의 id는 DB에 묻기 전에, 없는 프로젝트·쪽지와 같은 404로 끝낸다.
const projectIdPipe = new ParseUUIDPipe({ exceptionFactory: projectNotFound });
const issueIdPipe = new ParseUUIDPipe({ exceptionFactory: issueNotFound });
const attachmentIdPipe = new ParseUUIDPipe({ exceptionFactory: assetNotFound });

// 주소가 /projects/:id/issues와 /issues/:id 두 갈래라 공통 앞머리를 두지 않는다.
@Controller()
export class IssuesController {
  constructor(
    private readonly issues: IssuesService,
    private readonly comments: CommentsService,
    private readonly attachments: IssueAttachmentsService,
    private readonly triage: IssueTriageService,
  ) {}

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

  // 분류·범위·마감일 중 보낸 칸만 바꾼다. 범위와 마감일을 바꾸면 자동 댓글이 든 쪽지 상세를 돌려준다.
  @Patch('issues/:id')
  update(
    @Req() request: AuthenticatedRequest,
    @Param('id', issueIdPipe) issueId: string,
    @Body() body: UpdateIssueDto,
  ) {
    const { category, scope, dueDate } = body;
    if (category === undefined && scope === undefined && dueDate === undefined) {
      throw new UnprocessableEntityException('바꿀 칸을 보내 주세요');
    }
    return this.triage.update(issueId, request.user.id, body);
  }

  @Post('issues/:id/comments')
  createComment(
    @Req() request: AuthenticatedRequest,
    @Param('id', issueIdPipe) issueId: string,
    @Body() body: CreateCommentDto,
  ) {
    return this.comments.create(issueId, request.user.id, body);
  }

  // 새로 만드는 것이 아니라 쪽지의 상태를 바꾸는 것이라 201 대신 200이다.
  @Post('issues/:id/start')
  @HttpCode(HttpStatus.OK)
  start(@Req() request: AuthenticatedRequest, @Param('id', issueIdPipe) issueId: string, @Body() body: StartIssueDto) {
    return this.issues.start(issueId, request.user.id, body.versionId);
  }

  // file 칸의 사진 한 장을 메모리(Buffer)에 받는다. 20 MiB를 넘으면 multer가 멈추고 Nest가 413으로 바꾼다(버전 화면 사진과 같다).
  @Post('issues/:id/attachments')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }))
  attach(
    @Req() request: AuthenticatedRequest,
    @Param('id', issueIdPipe) issueId: string,
    @UploadedFile() photo: Express.Multer.File | undefined,
  ) {
    if (!photo) throw new UnprocessableEntityException('사진 파일을 보내 주세요');
    return this.attachments.attach(issueId, request.user.id, photo.buffer);
  }

  // 지운 뒤의 쪽지 상세를 돌려줘서, 화면이 남은 사진을 다시 묻지 않는다.
  @Delete('issues/:id/attachments/:attachmentId')
  removeAttachment(
    @Req() request: AuthenticatedRequest,
    @Param('id', issueIdPipe) issueId: string,
    @Param('attachmentId', attachmentIdPipe) attachmentId: string,
  ) {
    return this.attachments.remove(issueId, attachmentId, request.user.id);
  }
}
