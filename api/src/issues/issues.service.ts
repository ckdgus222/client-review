import { Injectable, NotFoundException } from '@nestjs/common';
import { ActivityService } from '../activity/activity.service.js';
import { ActivityType, type IssueStatus, Prisma, VersionStatus, type Viewport } from '../generated/prisma/client.js';
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
  authorName: string;
  createdAt: Date;
  commentCount: number;
  // 쓸 때의 현재 버전. 위치 없는 쪽지에도 늘 있다.
  originVersion: { id: string; number: number | null };
  origin: IssuePin | null;
};

export type IssueDetail = IssueSummary & {
  body: string;
  isMine: boolean;
  attachments: { id: string; assetId: string; width: number; height: number }[];
  comments: { id: string; authorName: string; versionNumber: number | null; body: string; createdAt: Date }[];
};

// title은 앞뒤 공백을 지운 값이다(입력 검사 DTO). pin은 화면·x·y를 셋 다 보냈을 때만 있다(컨트롤러).
export type NewIssue = {
  requestId: string;
  versionId: string;
  title: string;
  body: string;
  pin?: { screenId: string; xRatio: number; yRatio: number };
};

// 없는 쪽지, 남의 프로젝트의 쪽지, 틀린 모양 id(컨트롤러)가 모두 이 본문으로 답한다.
export const issueNotFound = () => new NotFoundException('없는 쪽지예요');

const SUMMARY_FIELDS = {
  id: true,
  number: true,
  title: true,
  status: true,
  createdAt: true,
  xRatio: true,
  yRatio: true,
  author: { select: { name: true } },
  originVersion: { select: { id: true, number: true } },
  originVersionScreen: {
    select: {
      screen: { select: { id: true, name: true, viewport: true } },
      asset: { select: { id: true, width: true, height: true } },
    },
  },
  _count: { select: { comments: true } },
} satisfies Prisma.IssueSelect;

const DETAIL_FIELDS = {
  ...SUMMARY_FIELDS,
  body: true,
  authorId: true,
  attachments: {
    select: { id: true, asset: { select: { id: true, width: true, height: true } } },
    orderBy: { createdAt: 'asc' },
  },
  comments: {
    select: {
      id: true,
      body: true,
      createdAt: true,
      author: { select: { name: true } },
      version: { select: { number: true } },
    },
    orderBy: { createdAt: 'asc' },
  },
} satisfies Prisma.IssueSelect;

const toSummary = ({
  author,
  originVersionScreen,
  xRatio,
  yRatio,
  _count,
  ...issue
}: Prisma.IssueGetPayload<{ select: typeof SUMMARY_FIELDS }>): IssueSummary => ({
  ...issue,
  authorName: author.name,
  commentCount: _count.comments,
  // 화면·x·y는 셋 다 있거나 셋 다 없다(DB CHECK 제약). 타입이 그것을 몰라서 셋 다 확인한다.
  origin:
    originVersionScreen && xRatio !== null && yRatio !== null
      ? {
          screenId: originVersionScreen.screen.id,
          screenName: originVersionScreen.screen.name,
          viewport: originVersionScreen.screen.viewport,
          asset: originVersionScreen.asset,
          xRatio,
          yRatio,
        }
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
    const { body, authorId, attachments, comments, ...summary } = await db.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: DETAIL_FIELDS,
    });
    return {
      ...toSummary(summary),
      body,
      isMine: authorId === userId,
      attachments: attachments.map(({ id, asset: { id: assetId, ...size } }) => ({ id, assetId, ...size })),
      comments: comments.map(({ author, version, ...comment }) => ({
        ...comment,
        authorName: author.name,
        versionNumber: version.number,
      })),
    };
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
