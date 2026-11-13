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
import { ReopenIssueDto } from './dto/reopen-issue.dto.js';
import { StartIssueDto } from './dto/start-issue.dto.js';
import { SubmitResolutionDto } from './dto/submit-resolution.dto.js';
import { UpdateIssueDto } from './dto/update-issue.dto.js';
import { VerifyIssueDto } from './dto/verify-issue.dto.js';
import { WithdrawIssueDto } from './dto/withdraw-issue.dto.js';
import { IssueAttachmentsService } from './issue-attachments.service.js';
import { IssueTriageService } from './issue-triage.service.js';
import { issueNotFound, IssuesService } from './issues.service.js';
import { ResolutionService } from './resolution.service.js';

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
    private readonly resolution: ResolutionService,
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

  // 고쳤어요와 그 답(확인 완료, 재요청·다시 열기, 철회). 모두 쪽지의 상태를 바꾸는 것이라 200이고, 바뀐 쪽지 상세를 돌려준다.

  // 개발자가 "고쳤어요"를 보낸다. 쪽지는 확인 요청이 된다.
  @Post('issues/:id/submit-resolution')
  @HttpCode(HttpStatus.OK)
  submitResolution(
    @Req() request: AuthenticatedRequest,
    @Param('id', issueIdPipe) issueId: string,
    @Body() body: SubmitResolutionDto,
  ) {
    return this.resolution.submit(issueId, request.user.id, body);
  }

  @Post('issues/:id/verify')
  @HttpCode(HttpStatus.OK)
  verify(
    @Req() request: AuthenticatedRequest,
    @Param('id', issueIdPipe) issueId: string,
    @Body() body: VerifyIssueDto,
  ) {
    return this.resolution.verify(issueId, request.user.id, body);
  }

  // 확인 요청을 돌려보내는 재요청과, 끝난 쪽지를 다시 여는 것이 같은 주소다(attemptId가 있으면 재요청).
  @Post('issues/:id/reopen')
  @HttpCode(HttpStatus.OK)
  reopen(
    @Req() request: AuthenticatedRequest,
    @Param('id', issueIdPipe) issueId: string,
    @Body() body: ReopenIssueDto,
  ) {
    return this.resolution.reopen(issueId, request.user.id, body);
  }

  @Post('issues/:id/withdraw')
  @HttpCode(HttpStatus.OK)
  withdraw(
    @Req() request: AuthenticatedRequest,
    @Param('id', issueIdPipe) issueId: string,
    @Body() body: WithdrawIssueDto,
  ) {
    return this.resolution.withdraw(issueId, request.user.id, body);
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
