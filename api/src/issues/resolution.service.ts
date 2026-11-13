import { ForbiddenException, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { ActivityService } from '../activity/activity.service.js';
import { ActivityType, IssueStatus, type Prisma, ProjectRole, ResolutionResult } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { screenNotFound } from '../screens/screens.service.js';
import { conflict } from '../versions/versions.service.js';
import { type IssueDetail, IssuesService } from './issues.service.js';

// summary와 reason은 앞뒤 공백을 지운 값이다(입력 검사 DTO). versionId는 보내는 사람이 보고 있던 버전이다.
export type NewResolution = { versionId: string; summary: string; screenId?: string };
export type Verification = { versionId: string; attemptId: string };
// attemptId가 있으면 확인 요청을 보고 누른 "재요청"이고, 없으면 끝난 쪽지(확인 완료·철회)를 "다시 열기"다.
export type Reopening = { versionId: string; reason: string; attemptId?: string };
export type Withdrawal = { versionId: string; reason: string };

// 네 요청 모두 "지금 상태가 그 요청을 받을 수 있을 때만" 적용한다. 옛 화면을 보고 누른 요청과,
// 응답을 못 받아 다시 보낸 요청(이미 저장되어 상태가 달라졌다)이 여기서 멈춘다. 그래서 요청 번호를 따로 받지 않는다.
const requireStatus = (status: IssueStatus, allowed: IssueStatus[]) => {
  if (!allowed.includes(status)) throw conflict('ISSUE_STATE_CHANGED', '쪽지 상태가 바뀌었어요');
};

// 고쳤어요(개발자)와 그 답(쪽지를 쓴 클라이언트나 승인자): 확인 완료, 재요청, 철회, 다시 열기.
// 네 요청의 순서가 같다: 프로젝트 줄 잠금 → 권한(403) → 버전(409) → 쪽지 상태(409) → 고쳤어요 줄(409) → 저장 → 사유 댓글 → 일지.
// 모두 한 트랜잭션이라 사유 댓글이나 일지 저장이 실패하면 상태도 바뀌지 않는다.
// 사유는 그 사람 이름의 보통 댓글로 남긴다. 사람이 쓴 댓글과 달리 requestId가 비어 있고, 시각은 DB 기본값이다.
@Injectable()
export class ResolutionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly issues: IssuesService,
    private readonly activity: ActivityService,
  ) {}

  // 보낼 때마다 줄을 하나 더한다. 지난 줄은 고치지 않는다.
  async submit(issueId: string, userId: string, input: NewResolution): Promise<IssueDetail> {
    return this.prisma.$transaction(async (tx) => {
      const issue = await this.issues.lockIssue(tx, issueId, userId);
      if (issue.role !== ProjectRole.DEVELOPER) throw new ForbiddenException('개발자만 할 수 있어요');
      const versionId = await this.issues.requireVersionInReview(tx, issue.projectId, input.versionId);
      requireStatus(issue.status, [IssueStatus.OPEN, IssueStatus.IN_PROGRESS]);
      const versionScreenId = await this.findVersionScreen(tx, issueId, versionId, input.screenId);

      // createdAt은 적지 않는다. DB 기본값이 넣는 순간의 실제 시각(잠금을 얻은 뒤)을 적는다.
      await tx.resolutionAttempt.create({
        data: { issueId, versionId, versionScreenId, summary: input.summary, submittedById: userId },
      });
      await tx.issue.update({ where: { id: issueId }, data: { status: IssueStatus.READY_FOR_REVIEW } });
      await this.activity.record(tx, {
        projectId: issue.projectId,
        actorId: userId,
        type: ActivityType.RESOLUTION_SUBMITTED,
        issueId,
      });
      return this.issues.loadDetail(issueId, userId, tx);
    });
  }

  async verify(issueId: string, userId: string, input: Verification): Promise<IssueDetail> {
    return this.prisma.$transaction(async (tx) => {
      const { issue } = await this.lockForReview(tx, issueId, userId, input.versionId);
      requireStatus(issue.status, [IssueStatus.READY_FOR_REVIEW]);
      await this.answerLatestAttempt(tx, issueId, input.attemptId, userId, ResolutionResult.VERIFIED);

      await tx.issue.update({ where: { id: issueId }, data: { status: IssueStatus.VERIFIED } });
      await this.activity.record(tx, {
        projectId: issue.projectId,
        actorId: userId,
        type: ActivityType.ISSUE_VERIFIED,
        issueId,
      });
      return this.issues.loadDetail(issueId, userId, tx);
    });
  }

  async reopen(issueId: string, userId: string, input: Reopening): Promise<IssueDetail> {
    return this.prisma.$transaction(async (tx) => {
      const { issue, versionId } = await this.lockForReview(tx, issueId, userId, input.versionId);
      // 재요청은 확인 요청일 때만, 다시 열기는 끝난 쪽지일 때만 받는다. 확인 요청을 보고 누른 재요청이
      // 그사이 확인 완료된 쪽지를 다시 열거나, 끝난 쪽지를 보고 누른 다시 열기가 새 고쳤어요를 돌려보내지 않는다.
      const { attemptId } = input;
      const isRejection = attemptId !== undefined;
      requireStatus(
        issue.status,
        isRejection ? [IssueStatus.READY_FOR_REVIEW] : [IssueStatus.VERIFIED, IssueStatus.WITHDRAWN],
      );
      if (isRejection) await this.answerLatestAttempt(tx, issueId, attemptId, userId, ResolutionResult.REOPENED);

      await tx.issue.update({ where: { id: issueId }, data: { status: IssueStatus.OPEN } });
      const reasonLabel = isRejection ? '재요청 사유' : '다시 연 사유';
      const body = `${reasonLabel}: ${input.reason}`;
      await tx.comment.create({ data: { issueId, authorId: userId, versionId, body } });
      await this.activity.record(tx, {
        projectId: issue.projectId,
        actorId: userId,
        type: ActivityType.ISSUE_REOPENED,
        issueId,
      });
      return this.issues.loadDetail(issueId, userId, tx);
    });
  }

  // 확인 요청 중에 철회해도 고쳤어요 줄은 건드리지 않는다. 그 줄은 결과 없이 남는다.
  async withdraw(issueId: string, userId: string, input: Withdrawal): Promise<IssueDetail> {
    return this.prisma.$transaction(async (tx) => {
      const { issue, versionId } = await this.lockForReview(tx, issueId, userId, input.versionId);
      requireStatus(issue.status, [IssueStatus.OPEN, IssueStatus.IN_PROGRESS, IssueStatus.READY_FOR_REVIEW]);

      await tx.issue.update({ where: { id: issueId }, data: { status: IssueStatus.WITHDRAWN } });
      const body = `철회 사유: ${input.reason}`;
      await tx.comment.create({ data: { issueId, authorId: userId, versionId, body } });
      await this.activity.record(tx, {
        projectId: issue.projectId,
        actorId: userId,
        type: ActivityType.ISSUE_WITHDRAWN,
        issueId,
      });
      return this.issues.loadDetail(issueId, userId, tx);
    });
  }

  // 확인 완료·재요청·철회·다시 열기의 공통 앞부분. 잠근 뒤의 쪽지와 현재 버전(사유 댓글에 적는다)을 돌려준다.
  private async lockForReview(tx: Prisma.TransactionClient, issueId: string, userId: string, viewedVersionId: string) {
    const issue = await this.issues.lockIssue(tx, issueId, userId);
    if (!(await this.issues.canReview(tx, issue, userId))) {
      throw new ForbiddenException('쪽지를 쓴 사람과 승인자만 할 수 있어요');
    }
    const versionId = await this.issues.requireVersionInReview(tx, issue.projectId, viewedVersionId);
    return { issue, versionId };
  }

  // 고쳤어요에 붙일 화면은 현재 버전의 화면이어야 한다. 남의 프로젝트 화면, 이번 버전에 없는 화면은 없는 화면과 같은 404다.
  // 핀이 있는 쪽지는 화면을 꼭 골라야 한다. 그래야 처음 사진과 고친 사진을 나란히 볼 수 있다.
  private async findVersionScreen(tx: Prisma.TransactionClient, issueId: string, versionId: string, screenId?: string) {
    if (screenId === undefined) {
      const { originVersionScreenId } = await tx.issue.findUniqueOrThrow({
        where: { id: issueId },
        select: { originVersionScreenId: true },
      });
      if (originVersionScreenId !== null) throw new UnprocessableEntityException('고친 화면을 골라 주세요');
      return null;
    }
    const versionScreen = await tx.versionScreen.findUnique({
      where: { versionId_screenId: { versionId, screenId } },
      select: { id: true },
    });
    if (!versionScreen) throw screenNotFound();
    return versionScreen.id;
  }

  // 확인 완료와 재요청이 답하는 줄은 "이 쪽지의 가장 최근 줄이면서 아직 결과가 없는 줄"뿐이다.
  // 옛 창에 보이던 줄의 id로 온 요청은, 그사이 재요청되고 새 고쳤어요가 왔으면 여기서 멈춘다.
  private async answerLatestAttempt(
    tx: Prisma.TransactionClient,
    issueId: string,
    attemptId: string,
    userId: string,
    result: ResolutionResult,
  ) {
    const latest = await tx.resolutionAttempt.findFirst({
      where: { issueId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, result: true },
    });
    // DB의 id는 소문자다. 받은 id가 대문자여도 같은 id로 본다.
    if (!latest || latest.id !== attemptId.toLowerCase() || latest.result !== null) {
      throw conflict('ATTEMPT_CHANGED', '새 고쳤어요가 왔어요');
    }
    // 확인 시각은 댓글처럼 DB 시계(clock_timestamp)로 적는다. 잠금을 기다린 뒤의 실제 시각이다.
    await tx.$executeRaw`
      UPDATE resolution_attempts
      SET result = ${result}::resolution_result, reviewed_by = ${userId}::uuid, reviewed_at = clock_timestamp()
      WHERE id = ${latest.id}::uuid
    `;
  }
}
