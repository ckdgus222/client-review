import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { conflict, isUniqueViolation } from '../versions/versions.service.js';
import { COMMENT_FIELDS, type IssueDetail, IssuesService, toCommentView } from './issues.service.js';

export type CommentView = IssueDetail['comments'][number];

// body는 앞뒤 공백을 지운 값이다(입력 검사 DTO).
export type NewComment = { requestId: string; versionId: string; body: string };

@Injectable()
export class CommentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly issues: IssuesService,
  ) {}

  // 활성 멤버면 누구나, 남이 쓴 쪽지에도 쓴다. 댓글은 쪽지 안에서 보이므로 활동 일지에는 남기지 않는다.
  async create(issueId: string, userId: string, input: NewComment): Promise<CommentView> {
    return this.prisma.$transaction(async (tx) => {
      const { projectId } = await this.issues.lockIssue(tx, issueId, userId);

      // 다시 보낸 요청이면 처음 만든 댓글을 그대로 돌려준다. 쪽지 쓰기와 같은 이유로 버전 검사보다 먼저 본다.
      const existing = await tx.comment.findFirst({
        where: { authorId: userId, requestId: input.requestId, issueId },
        select: COMMENT_FIELDS,
      });
      if (existing) return toCommentView(existing);

      const versionId = await this.issues.requireVersionInReview(tx, projectId, input.versionId);
      // createdAt은 적지 않는다. DB 기본값이 넣는 순간의 실제 시각(잠금을 얻은 뒤)을 적는다.
      const comment = await tx.comment
        .create({
          data: { issueId, authorId: userId, versionId, body: input.body, requestId: input.requestId },
          select: COMMENT_FIELDS,
        })
        .catch((error) => {
          // 위에서 이 쪽지의 댓글은 걸렀으니, 같은 번호를 다른 쪽지의 댓글에 이미 쓴 경우다.
          throw isUniqueViolation(error) ? conflict('REQUEST_ID_REUSED', '이미 쓴 요청 번호예요') : error;
        });
      return toCommentView(comment);
    });
  }
}
