import { ForbiddenException, Injectable } from '@nestjs/common';
import { type IssueCategory, type IssueScope, type Prisma, ProjectRole } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { type IssueDetail, IssuesService, toDateText } from './issues.service.js';

// 보낸 칸만 바꾼다. dueDate는 "YYYY-MM-DD" 글자이고 null은 마감일을 지운다는 뜻이다(입력 검사 DTO).
export type IssueChange = {
  versionId: string;
  category?: IssueCategory;
  scope?: IssueScope;
  dueDate?: string | null;
};

// 자동 댓글에 적는 글자. 화면(web/src/api/issues.ts)의 범위 이름과 같아야 한다. 바꾸면 함께 바꾼다.
const SCOPE_LABELS: Record<IssueScope, string> = { IN_SCOPE: '하자 수정', OUT_OF_SCOPE: '추가 요청' };

// 받은 글자를 그대로 나눠 적는다. Date로 바꿔 계산하지 않아서 시간대에 따라 하루가 밀리지 않는다.
// 화면은 올해의 해를 빼고 보여 주지만, 댓글은 나중에 읽는 기록이라 늘 해를 적는다.
const dueDateLabel = (date: string | null) => {
  if (date === null) return '없음';
  const [year, month, day] = date.split('-').map(Number);
  return `${year}년 ${month}월 ${day}일`;
};

@Injectable()
export class IssueTriageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly issues: IssuesService,
  ) {}

  // 분류는 개발자와 쓴 사람이, 범위와 마감일은 개발자만 바꾼다. 범위와 마감일은 추가 비용의 근거라서
  // 바꿀 때마다 바꾸기 전과 뒤 값을 댓글로 남긴다. 쪽지 저장과 댓글이 한 트랜잭션이라 기록 없이 값만 바뀌지 않는다.
  async update(issueId: string, userId: string, change: IssueChange): Promise<IssueDetail> {
    return this.prisma.$transaction(async (tx) => {
      const { projectId, authorId, role } = await this.issues.lockIssue(tx, issueId, userId);

      // 칸마다 권한을 먼저 다 본다. 하나라도 안 되면 바꿀 수 있는 칸도 저장하지 않는다.
      const isDeveloper = role === ProjectRole.DEVELOPER;
      const isAuthor = authorId === userId;
      const changesScopeOrDueDate = change.scope !== undefined || change.dueDate !== undefined;
      // 범위와 마감일은 개발자만 바꾼다.
      if (changesScopeOrDueDate && !isDeveloper) throw new ForbiddenException('개발자만 할 수 있어요');
      // 분류는 개발자와 쓴 사람이 바꾼다. 위를 지난 개발자 아닌 사람의 요청에는 분류만 남아 있다.
      if (!isDeveloper && !isAuthor) throw new ForbiddenException('쓴 사람과 개발자만 할 수 있어요');
      const versionId = await this.issues.requireVersionInReview(tx, projectId, change.versionId);

      // 잠근 뒤에 읽은 값과 비교해서 달라진 칸만 고른다. 같은 값이면 쪽지도 댓글도 쓰지 않아서,
      // 응답을 못 받아 다시 보낸 요청이 댓글을 두 번 남기지 않는다.
      const issue = await tx.issue.findUniqueOrThrow({
        where: { id: issueId },
        select: { category: true, scope: true, dueDate: true },
      });
      const data: Prisma.IssueUpdateInput = {};
      const comments: string[] = [];
      if (change.category !== undefined && change.category !== issue.category) data.category = change.category;
      if (change.scope !== undefined && change.scope !== issue.scope) {
        data.scope = change.scope;
        comments.push(`범위: ${SCOPE_LABELS[issue.scope]} → ${SCOPE_LABELS[change.scope]}`);
      }
      const currentDueDate = issue.dueDate && toDateText(issue.dueDate);
      if (change.dueDate !== undefined && change.dueDate !== currentDueDate) {
        // date 칸에는 UTC 자정의 Date로 넣어야 받은 날짜 그대로 저장된다.
        data.dueDate = change.dueDate === null ? null : new Date(`${change.dueDate}T00:00:00.000Z`);
        comments.push(`마감일: ${dueDateLabel(currentDueDate)} → ${dueDateLabel(change.dueDate)}`);
      }

      if (Object.keys(data).length > 0) await tx.issue.update({ where: { id: issueId }, data });
      // 바꾼 개발자 이름의 보통 댓글로 남긴다. 다시 보낸 요청을 가려내는 requestId는 비운다.
      // 하나씩 차례로 넣어서 범위 댓글이 마감일 댓글보다 먼저 보인다(시각은 DB가 넣는 순간으로 적는다).
      for (const body of comments) {
        await tx.comment.create({ data: { issueId, authorId: userId, versionId, body } });
      }
      return this.issues.loadDetail(issueId, userId, tx);
    });
  }
}
