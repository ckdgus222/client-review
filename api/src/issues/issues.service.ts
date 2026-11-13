import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ActivityService } from '../activity/activity.service.js';
import {
  ActivityType,
  type IssueCategory,
  type IssueScope,
  IssueStatus,
  Prisma,
  ProjectRole,
  type ResolutionResult,
  VersionStatus,
  type Viewport,
} from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { screenNotFound } from '../screens/screens.service.js';
import { conflict, isUniqueViolation } from '../versions/versions.service.js';

// 핀이 꽂힌 자리. 위치 없는 쪽지는 이 값이 null이다. 비율은 사진 가로·세로에 대한 0~1 값이다.
export type IssuePin = {
  screenId: string;
  screenName: string;
  viewport: Viewport;
  asset: { id: string; width: number; height: number };
  xRatio: number;
  yRatio: number;
};

export type IssueSummary = {
  id: string;
  number: number;
  title: string;
  status: IssueStatus;
  category: IssueCategory;
  scope: IssueScope;
  // "YYYY-MM-DD" 글자. 시각이 없는 날짜라서 Date로 주면 받는 쪽 시간대에 따라 하루가 밀린다.
  dueDate: string | null;
  authorName: string;
  createdAt: Date;
  commentCount: number;
  // 쓸 때의 현재 버전. 위치 없는 쪽지에도 늘 있다.
  originVersion: { id: string; number: number | null };
  origin: IssuePin | null;
};

// 고쳤어요 한 번이 한 줄이다. 새 버전 게시나 철회로 답을 받지 못한 줄은 결과·확인한 사람·확인 시각이 null로 남는다.
export type IssueAttempt = {
  id: string;
  // 고쳤어요를 보낼 때의 현재 버전.
  versionId: string;
  versionNumber: number | null;
  // 고친 결과를 볼 수 있는 화면. 위치 없는 쪽지의 고쳤어요는 null일 수 있다.
  screen: Omit<IssuePin, 'xRatio' | 'yRatio'> | null;
  summary: string;
  submittedByName: string;
  createdAt: Date;
  result: ResolutionResult | null;
  reviewedByName: string | null;
  reviewedAt: Date | null;
};

export type IssueDetail = IssueSummary & {
  // 비교 화면이 검수실로 돌아가는 주소를 만드는 데 쓴다.
  projectId: string;
  body: string;
  isMine: boolean;
  // 내가 이 쪽지를 확인 완료·재요청·철회·다시 열기 할 수 있는 사람인가. 쪽지 상태와는 상관없다.
  canReview: boolean;
  // 이 쪽지의 프로젝트의 현재 버전과 그 상태. 비교 화면이 "보고 있는 고쳤어요의 버전이 지금도 현재 버전이고 검수 중인가"를
  // 아는 데 쓴다. 쪽지는 게시한 버전이 있어야 쓸 수 있어서 실제로는 늘 있다(DB의 칸은 비울 수 있어서 타입은 null도 받는다).
  currentVersion: { id: string; status: VersionStatus } | null;
  attachments: { id: string; assetId: string; width: number; height: number }[];
  comments: { id: string; authorName: string; versionNumber: number | null; body: string; createdAt: Date }[];
  // 오래된 순.
  attempts: IssueAttempt[];
};

// title은 앞뒤 공백을 지운 값이다(입력 검사 DTO). pin은 화면·x·y를 셋 다 보냈을 때만 있다(컨트롤러).
export type NewIssue = {
  requestId: string;
  versionId: string;
  title: string;
  body: string;
  // 없으면 DB 기본값(BUG)이 들어간다.
  category?: IssueCategory;
  pin?: { screenId: string; xRatio: number; yRatio: number };
};

// 없는 쪽지, 남의 프로젝트의 쪽지, 틀린 모양 id(컨트롤러)가 모두 이 본문으로 답한다.
export const issueNotFound = () => new NotFoundException('없는 쪽지예요');

// 버전 화면 하나를 화면 이름표와 사진으로 읽는다. 쪽지의 핀과 고쳤어요의 화면이 같은 모양이다.
const SCREEN_FIELDS = {
  screen: { select: { id: true, name: true, viewport: true } },
  asset: { select: { id: true, width: true, height: true } },
} satisfies Prisma.VersionScreenSelect;

const toScreenView = ({ screen, asset }: Prisma.VersionScreenGetPayload<{ select: typeof SCREEN_FIELDS }>) => ({
  screenId: screen.id,
  screenName: screen.name,
  viewport: screen.viewport,
  asset,
});

const SUMMARY_FIELDS = {
  id: true,
  number: true,
  title: true,
  status: true,
  category: true,
  scope: true,
  dueDate: true,
  createdAt: true,
  xRatio: true,
  yRatio: true,
  author: { select: { name: true } },
  originVersion: { select: { id: true, number: true } },
  originVersionScreen: { select: SCREEN_FIELDS },
  _count: { select: { comments: true } },
} satisfies Prisma.IssueSelect;

// 쪽지 상세의 댓글 목록과 댓글 쓰기의 응답이 같은 모양이다.
export const COMMENT_FIELDS = {
  id: true,
  body: true,
  createdAt: true,
  author: { select: { name: true } },
  version: { select: { number: true } },
} satisfies Prisma.CommentSelect;

export const toCommentView = ({
  author,
  version,
  ...comment
}: Prisma.CommentGetPayload<{ select: typeof COMMENT_FIELDS }>): IssueDetail['comments'][number] => ({
  ...comment,
  authorName: author.name,
  versionNumber: version.number,
});

const ATTEMPT_FIELDS = {
  id: true,
  versionId: true,
  summary: true,
  createdAt: true,
  result: true,
  reviewedAt: true,
  version: { select: { number: true } },
  versionScreen: { select: SCREEN_FIELDS },
  submittedBy: { select: { name: true } },
  reviewedBy: { select: { name: true } },
} satisfies Prisma.ResolutionAttemptSelect;

const toAttemptView = ({
  version,
  versionScreen,
  submittedBy,
  reviewedBy,
  ...attempt
}: Prisma.ResolutionAttemptGetPayload<{ select: typeof ATTEMPT_FIELDS }>): IssueAttempt => ({
  ...attempt,
  versionNumber: version.number,
  screen: versionScreen && toScreenView(versionScreen),
  submittedByName: submittedBy.name,
  reviewedByName: reviewedBy?.name ?? null,
});

const DETAIL_FIELDS = {
  ...SUMMARY_FIELDS,
  body: true,
  projectId: true,
  authorId: true,
  project: { select: { currentVersion: { select: { id: true, status: true } } } },
  attachments: {
    select: { id: true, asset: { select: { id: true, width: true, height: true } } },
    orderBy: { createdAt: 'asc' },
  },
  comments: { select: COMMENT_FIELDS, orderBy: { createdAt: 'asc' } },
  attempts: { select: ATTEMPT_FIELDS, orderBy: { createdAt: 'asc' } },
} satisfies Prisma.IssueSelect;

// date 칸은 UTC 자정의 Date로 읽힌다. 그래서 앞 10글자가 저장한 날짜 그대로다.
export const toDateText = (date: Date) => date.toISOString().slice(0, 10);

const toSummary = ({
  author,
  originVersionScreen,
  xRatio,
  yRatio,
  dueDate,
  _count,
  ...issue
}: Prisma.IssueGetPayload<{ select: typeof SUMMARY_FIELDS }>): IssueSummary => ({
  ...issue,
  dueDate: dueDate && toDateText(dueDate),
  authorName: author.name,
  commentCount: _count.comments,
  // 화면·x·y는 셋 다 있거나 셋 다 없다(DB CHECK 제약). 타입이 그것을 몰라서 셋 다 확인한다.
  origin:
    originVersionScreen && xRatio !== null && yRatio !== null
      ? { ...toScreenView(originVersionScreen), xRatio, yRatio }
      : null,
});

@Injectable()
export class IssuesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
    private readonly activity: ActivityService,
  ) {}

  // 프로젝트 전체 쪽지다. 지난 버전에서 시작한 쪽지도 함께 준다(목록은 한 번에 다 불러온다).
  async list(projectId: string, userId: string): Promise<IssueSummary[]> {
    await this.projects.requireMemberRole(projectId, userId);
    const issues = await this.prisma.issue.findMany({
      where: { projectId },
      select: SUMMARY_FIELDS,
      orderBy: { number: 'desc' },
    });
    return issues.map(toSummary);
  }

  async getDetail(issueId: string, userId: string): Promise<IssueDetail> {
    const issue = await this.prisma.issue.findUnique({ where: { id: issueId }, select: { projectId: true } });
    if (!issue) throw issueNotFound();
    await this.requireMember(issue.projectId, userId);
    return this.loadDetail(issueId, userId);
  }

  async create(projectId: string, userId: string, input: NewIssue): Promise<IssueDetail> {
    return this.prisma.$transaction(async (tx) => {
      // 같은 프로젝트의 쓰기를 하나씩 처리한다. 그래서 아래 검사와 번호 정하기 사이에 게시나 다른 쪽지가 끼어들지 못한다.
      await this.projects.lockProject(tx, projectId);
      await this.projects.requireMemberRole(projectId, userId, tx);

      // 다시 보낸 요청이면 처음 만든 쪽지를 그대로 돌려준다. 버전 검사보다 먼저 본다. 쪽지가 저장된 직후
      // 새 버전이 게시됐고 응답만 못 받은 경우에, 다시 보낸 요청이 409가 아니라 그 쪽지를 받아야 한다.
      const existing = await tx.issue.findFirst({
        where: { authorId: userId, requestId: input.requestId, projectId },
        select: { id: true },
      });
      if (existing) return this.loadDetail(existing.id, userId, tx);

      const versionId = await this.requireVersionInReview(tx, projectId, input.versionId);
      const pin = input.pin ? await this.findPin(tx, versionId, input.pin) : {};
      const { _max } = await tx.issue.aggregate({ where: { projectId }, _max: { number: true } });

      const issue = await tx.issue
        .create({
          data: {
            projectId,
            number: (_max.number ?? 0) + 1,
            originVersionId: versionId,
            ...pin,
            authorId: userId,
            title: input.title,
            body: input.body,
            category: input.category,
            requestId: input.requestId,
          },
          select: { id: true },
        })
        .catch((error) => {
          // 번호는 잠근 뒤에 정해서 겹치지 않는다. 남는 유니크는 (쓴 사람, requestId)뿐이고,
          // 위에서 이 프로젝트 것은 걸렀으니 같은 번호를 다른 프로젝트 쪽지에 이미 쓴 경우다.
          throw isUniqueViolation(error) ? conflict('REQUEST_ID_REUSED', '이미 쓴 요청 번호예요') : error;
        });
      await this.activity.record(tx, {
        projectId,
        actorId: userId,
        type: ActivityType.ISSUE_CREATED,
        issueId: issue.id,
      });
      return this.loadDetail(issue.id, userId, tx);
    });
  }

  async start(issueId: string, userId: string, viewedVersionId: string): Promise<IssueDetail> {
    return this.prisma.$transaction(async (tx) => {
      const issue = await this.lockIssue(tx, issueId, userId);
      if (issue.role !== ProjectRole.DEVELOPER) throw new ForbiddenException('개발자만 할 수 있어요');
      await this.requireVersionInReview(tx, issue.projectId, viewedVersionId);
      // 두 번 눌러도 두 번째는 여기서 멈춘다. 그래서 다시 보낸 요청을 따로 가려내지 않는다.
      if (issue.status !== IssueStatus.OPEN) throw conflict('ISSUE_NOT_OPEN', '접수 상태의 쪽지만 시작할 수 있어요');

      await tx.issue.update({ where: { id: issueId }, data: { status: IssueStatus.IN_PROGRESS } });
      await this.activity.record(tx, {
        projectId: issue.projectId,
        actorId: userId,
        type: ActivityType.ISSUE_STARTED,
        issueId,
      });
      return this.loadDetail(issueId, userId, tx);
    });
  }

  // 쪽지 id로 오는 쓰기는 모두 여기서 시작한다. 쪽지로 프로젝트를 알아내 그 줄을 잠그고, 잠근 뒤의 쪽지와 내 역할을 읽는다.
  // 잠그기 전에 읽은 상태는 그사이 바뀌었을 수 있어서 쪽지를 다시 읽는다.
  async lockIssue(tx: Prisma.TransactionClient, issueId: string, userId: string) {
    const found = await tx.issue.findUnique({ where: { id: issueId }, select: { projectId: true } });
    if (!found) throw issueNotFound();
    await this.projects.lockProject(tx, found.projectId);
    const role = await this.requireMember(found.projectId, userId, tx);
    const issue = await tx.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: { projectId: true, authorId: true, status: true },
    });
    return { ...issue, role };
  }

  // 쪽지·댓글 쓰기와 상태 변경은 현재 버전이 검수 중일 때만 받는다. 프로젝트 줄을 잠근 뒤에 부른다.
  // viewedVersionId는 보내는 사람이 보고 있던 버전이다. 그사이 새 버전이 게시됐으면 여기서 멈춘다.
  // 없는 id, 지난 버전, 게시 전 버전, 남의 버전을 보내도 모두 같은 409라서 그 버전이 있는지 드러나지 않는다.
  async requireVersionInReview(tx: Prisma.TransactionClient, projectId: string, viewedVersionId?: string) {
    // "이 프로젝트의 현재 버전이면서 보고 있던 그 버전"을 DB가 찾는다. 받은 id가 대문자여도 DB는 같은 id로 본다.
    // viewedVersionId가 없으면(undefined) Prisma가 그 조건을 빼고 현재 버전만 찾는다.
    const current = await tx.deliveryVersion.findFirst({
      where: { currentOf: { id: projectId }, id: viewedVersionId },
      select: { id: true, status: true },
    });
    if (!current && viewedVersionId !== undefined) throw conflict('VERSION_CHANGED', '새 버전이 올라왔어요');
    if (current?.status !== VersionStatus.IN_REVIEW) {
      throw conflict('VERSION_NOT_IN_REVIEW', '검수 중인 버전이 아니에요');
    }
    return current.id;
  }

  // 권한을 확인한 뒤에만 부른다.
  async loadDetail(issueId: string, userId: string, db: Prisma.TransactionClient = this.prisma): Promise<IssueDetail> {
    const issue = await db.issue.findUniqueOrThrow({ where: { id: issueId }, select: DETAIL_FIELDS });
    const { body, projectId, authorId, project, attachments, comments, attempts, ...summary } = issue;
    const canReview = await this.canReview(db, issue, userId);
    return {
      ...toSummary(summary),
      projectId,
      body,
      isMine: authorId === userId,
      canReview,
      currentVersion: project.currentVersion,
      attachments: attachments.map(({ id, asset: { id: assetId, ...size } }) => ({ id, assetId, ...size })),
      comments: comments.map(toCommentView),
      attempts: attempts.map(toAttemptView),
    };
  }

  // 확인 완료·재요청·철회·다시 열기를 할 수 있는 사람인가: 개발자가 아닌 활성 멤버이면서, 그 쪽지를 썼거나 승인자다.
  // 개발자는 자기가 쓴 쪽지도 확인할 수 없다(자기가 고치고 자기가 확인하는 길을 막는다).
  // 이 규칙은 여기 한 곳에만 둔다. 쪽지 상세의 canReview와 네 요청의 권한 검사가 같은 답을 낸다.
  async canReview(db: Prisma.TransactionClient, issue: { projectId: string; authorId: string }, userId: string) {
    const member = await db.projectMember.findUnique({
      where: { projectId_userId: { projectId: issue.projectId, userId } },
      select: { id: true, role: true, revokedAt: true, project: { select: { approverMemberId: true } } },
    });
    if (!member || member.revokedAt !== null || member.role === ProjectRole.DEVELOPER) return false;
    return issue.authorId === userId || member.project.approverMemberId === member.id;
  }

  // 남의 프로젝트의 쪽지도 없는 쪽지와 같은 404로 답한다. 문구가 다르면 그 쪽지 id가 어딘가 있다는 것이 드러난다.
  async requireMember(projectId: string, userId: string, db: Prisma.TransactionClient = this.prisma) {
    return this.projects.requireMemberRole(projectId, userId, db).catch((error) => {
      throw error instanceof NotFoundException ? issueNotFound() : error;
    });
  }

  // 핀은 현재 버전의 화면에만 꽂는다. 남의 프로젝트 화면, 이번 버전에 없는 화면은 없는 화면과 같은 404다.
  private async findPin(tx: Prisma.TransactionClient, versionId: string, pin: NonNullable<NewIssue['pin']>) {
    const versionScreen = await tx.versionScreen.findUnique({
      where: { versionId_screenId: { versionId, screenId: pin.screenId } },
      select: { id: true },
    });
    if (!versionScreen) throw screenNotFound();
    return { originVersionScreenId: versionScreen.id, xRatio: pin.xRatio, yRatio: pin.yRatio };
  }
}
