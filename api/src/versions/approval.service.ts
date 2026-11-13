import { ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { ActivityService } from '../activity/activity.service.js';
import {
  ActivityType,
  IssueScope,
  IssueStatus,
  type Prisma,
  ProjectRole,
  ProjectStatus,
  VersionStatus,
} from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { assertWritable, ProjectsService } from '../projects/projects.service.js';
import { conflict, type VersionDetail, versionNotFound, VersionsService } from './versions.service.js';

type CheckIssue = { id: string; number: number; title: string; status: IssueStatus };

// 승인자가 승인하기 전에 보는 것. serverTime은 이 목록을 읽은 때의 DB 시각이고, 승인 요청이 seenAt으로 그대로 돌려보낸다.
export type ApprovalCheck = {
  // DB가 만든 글자다(UTC, 마이크로초까지). 댓글 시각이 마이크로초까지 적혀서, 밀리초로 자르면 같은 밀리초의 댓글을 놓친다.
  serverTime: string;
  // 범위 안의 끝나지 않은 쪽지. 하나라도 있으면 승인할 수 없다.
  unresolved: CheckIssue[];
  // 범위 밖(추가 요청)의 끝나지 않은 쪽지. 승인 검사에서 빼지만, 남은 채로 승인된다는 것을 승인자가 알게 보여 준다.
  outOfScope: CheckIssue[];
  // 이번 버전에 달린 댓글 전부, 오래된 순.
  comments: {
    id: string;
    issueId: string;
    issueNumber: number;
    issueTitle: string;
    authorName: string;
    body: string;
    createdAt: Date;
  }[];
};

// 아직 끝나지 않은 쪽지의 상태(접수, 수정 중, 확인 요청).
const UNRESOLVED_STATUSES = [IssueStatus.OPEN, IssueStatus.IN_PROGRESS, IssueStatus.READY_FOR_REVIEW];

type LockedVersion = {
  id: string;
  projectId: string;
  status: VersionStatus;
  isCurrent: boolean;
  projectStatus: ProjectStatus;
};

// 승인은 현재 버전이 검수 중일 때만 한다. 지난 버전이면 "새 버전이 올라왔어요", 이미 승인된 현재 버전이면 "검수 중이 아니에요"다.
// 응답을 못 받아 다시 보낸 승인도 여기서 멈춘다(이미 승인됐다). 그래서 요청 번호를 따로 받지 않는다.
const requireCurrentInReview = (version: LockedVersion) => {
  if (!version.isCurrent) throw conflict('VERSION_CHANGED', '새 버전이 올라왔어요');
  if (version.status !== VersionStatus.IN_REVIEW) throw conflict('VERSION_NOT_IN_REVIEW', '검수 중인 버전이 아니에요');
};

// 버전 승인과, 승인하기 전에 지금 상태를 보는 승인 검토 조회.
@Injectable()
export class ApprovalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly versions: VersionsService,
    private readonly activity: ActivityService,
    private readonly projects: ProjectsService,
  ) {}

  async check(versionId: string, userId: string): Promise<ApprovalCheck> {
    return this.prisma.$transaction(async (tx) => {
      // 공유 잠금은 저장 중인 쓰기(프로젝트 줄을 FOR UPDATE로 잠근다)가 끝나기를 기다리고, 조회끼리는 서로 막지 않는다.
      // 잠근 뒤에 시각을 정해서, 그때 저장 중이던 댓글은 아래 목록에 들어 있고, 이 조회 뒤에 시작한 쓰기의 댓글은
      // 시각이 serverTime보다 뒤다(댓글 시각도 잠근 뒤의 DB 시계다). 그래서 승인자가 못 본 댓글은 승인 때 반드시 걸린다.
      const version = await this.lockAsApprover(tx, versionId, userId, 'SHARE');
      requireCurrentInReview(version);
      const [{ serverTime }] = await tx.$queryRaw<{ serverTime: string }[]>`
        SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "serverTime"`;

      // 지난 버전에서 시작한 쪽지와 숨긴 화면의 쪽지도 센다. 프로젝트의 쪽지 전부가 대상이다.
      const open = await tx.issue.findMany({
        where: { projectId: version.projectId, status: { in: UNRESOLVED_STATUSES } },
        select: { id: true, number: true, title: true, status: true, scope: true },
        orderBy: { number: 'asc' },
      });
      const withScope = (wanted: IssueScope) =>
        open.filter((issue) => issue.scope === wanted).map(({ scope: _scope, ...issue }) => issue);

      // 댓글의 버전은 쓸 때의 현재 버전이라, 이 버전의 댓글이 곧 "이번 차수에 오간 말"이다.
      const comments = await tx.comment.findMany({
        where: { versionId: version.id },
        select: {
          id: true,
          issueId: true,
          body: true,
          createdAt: true,
          author: { select: { name: true } },
          issue: { select: { number: true, title: true } },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });

      return {
        serverTime,
        unresolved: withScope(IssueScope.IN_SCOPE),
        outOfScope: withScope(IssueScope.OUT_OF_SCOPE),
        comments: comments.map(({ author, issue, ...comment }) => ({
          ...comment,
          issueNumber: issue.number,
          issueTitle: issue.title,
          authorName: author.name,
        })),
      };
    });
  }

  // seenAt은 승인 검토가 준 serverTime 그대로다(입력 검사 DTO가 모양과 실제 날짜·시각을 본다).
  // 순서: 프로젝트 줄 잠금 → 멤버(404) → 승인자(403) → 보관·삭제 대기(409) → seenAt(422) → 버전(409) → 미해결(409) → 새 댓글(409) → 저장.
  // 승인 줄·버전 상태·일지가 한 트랜잭션이라, 하나라도 실패하면 버전은 검수 중 그대로다.
  async approve(versionId: string, userId: string, seenAt: string): Promise<VersionDetail> {
    return this.prisma.$transaction(async (tx) => {
      const version = await this.lockAsApprover(tx, versionId, userId, 'UPDATE');
      assertWritable(version.projectStatus);
      // 승인 검토를 건너뛰고 먼 미래의 시각을 보내면 아래 새 댓글 검사가 아무것도 못 잡는다. 서버가 준 적 없는 시각이라 틀린 입력이다.
      // 시각 비교는 DB가 한다. 자바스크립트의 Date는 밀리초까지만 알아서 마이크로초를 잃는다.
      const [{ isFuture }] = await tx.$queryRaw<{ isFuture: boolean }[]>`
        SELECT ${seenAt}::timestamptz > clock_timestamp() AS "isFuture"`;
      if (isFuture) throw new UnprocessableEntityException('승인 검토를 다시 열어 주세요');
      requireCurrentInReview(version);

      const { projectId } = version;
      const unresolved = await tx.issue.count({
        where: { projectId, scope: IssueScope.IN_SCOPE, status: { in: UNRESOLVED_STATUSES } },
      });
      if (unresolved > 0) throw conflict('UNRESOLVED_ISSUES', '아직 끝나지 않은 쪽지가 있어요');

      // 승인 검토를 연 뒤에 다른 사람이 쓴 댓글이 있으면 멈춘다. 자동 댓글(범위·마감일 변경)과 사유 댓글도 댓글이라 걸린다.
      // 그래서 검토를 연 뒤 개발자가 쪽지를 범위 밖으로 돌려 미해결 검사를 피해도 여기서 걸린다. 승인자 자신의 댓글은 세지 않는다.
      const [{ hasNewComments }] = await tx.$queryRaw<{ hasNewComments: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM comments
          JOIN issues ON issues.id = comments.issue_id
          WHERE issues.project_id = ${projectId}::uuid
            AND comments.author_id <> ${userId}::uuid
            AND comments.created_at > ${seenAt}::timestamptz
        ) AS "hasNewComments"`;
      if (hasNewComments) throw conflict('NEW_COMMENTS', '새 댓글이 있어요');

      // 승인한 순간의 쪽지 목록을 남긴다. 승인 뒤에 쪽지가 다시 열려도 검수 확인서는 이 목록을 쓴다.
      const issues = await tx.issue.findMany({
        where: { projectId },
        select: { number: true, title: true, category: true, scope: true, status: true },
        orderBy: { number: 'asc' },
      });
      // approvedAt은 적지 않는다. DB 기본값이 넣는 순간의 실제 시각을 적는다.
      await tx.approval.create({ data: { versionId: version.id, approverId: userId, summary: { issues } } });
      await tx.deliveryVersion.update({ where: { id: version.id }, data: { status: VersionStatus.APPROVED } });
      await this.activity.record(tx, {
        projectId,
        actorId: userId,
        type: ActivityType.VERSION_APPROVED,
        versionId: version.id,
      });
      return this.versions.loadDetail(version.id, tx);
    });
  }

  // 프로젝트 줄을 잠근 뒤에 권한과 버전을 읽는다. 잠그기 전에 읽으면 그사이 바뀐 승인자·버전으로 판단할 수 있다.
  // 멤버가 아니면 404(남의 버전이 있는지 드러나지 않는다), 클라이언트에게 게시 전 버전도 404, 승인자가 아니면 403이다.
  private async lockAsApprover(
    tx: Prisma.TransactionClient,
    versionId: string,
    userId: string,
    lock: 'UPDATE' | 'SHARE',
  ): Promise<LockedVersion> {
    // 어느 프로젝트를 잠글지 알려고 먼저 한 번 찾는다.
    const found = await tx.deliveryVersion.findUnique({ where: { id: versionId }, select: { projectId: true } });
    if (!found) throw versionNotFound();
    const { projectId } = found;
    const projectStatus = await this.projects.lockProject(tx, projectId, lock);

    // 멤버가 아님·철회됨·삭제 대기의 클라이언트는 없는 버전과 같은 404다(문구가 다르면 그 버전 id가 있다는 것이 드러난다).
    const role = await this.projects.requireMemberRole(projectId, userId, tx).catch((error) => {
      throw error instanceof NotFoundException ? versionNotFound() : error;
    });
    const project = await tx.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { currentVersionId: true, approver: { select: { userId: true } } },
    });
    // 잠근 뒤의 상태를 다시 읽는다. 기다리는 사이 게시되거나 승인됐을 수 있다. id는 DB가 준 값(소문자)을 쓴다.
    // 버전은 지워지지 않아서, 위에서 찾은 줄은 잠근 뒤에도 있다.
    const version = await tx.deliveryVersion.findUniqueOrThrow({
      where: { id: versionId },
      select: { id: true, status: true },
    });
    if (role !== ProjectRole.DEVELOPER && version.status === VersionStatus.DRAFT) throw versionNotFound();
    // 멤버 줄은 (프로젝트, 사용자)마다 하나라서, 승인자 줄의 사용자가 나면 내가 승인자다.
    if (project.approver?.userId !== userId) throw new ForbiddenException('승인자만 할 수 있어요');
    return { ...version, projectId, isCurrent: project.currentVersionId === version.id, projectStatus };
  }
}
