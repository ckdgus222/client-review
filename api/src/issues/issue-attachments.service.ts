import { ForbiddenException, Injectable } from '@nestjs/common';
import { deleteAssetQuietly } from '../assets/asset-cleanup.js';
import { requireProjectQuota } from '../assets/asset-quota.js';
import { saveAsset } from '../assets/asset-storage.js';
import { assetNotFound } from '../assets/assets.service.js';
import { processImage } from '../assets/image.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { conflict } from '../versions/versions.service.js';
import { type IssueDetail, issueNotFound, IssuesService } from './issues.service.js';

const MAX_ATTACHMENTS = 3;

const notAuthor = () => new ForbiddenException('쪽지를 쓴 사람만 할 수 있어요');

// 쪽지에 붙이는 참고 사진(시안 등). 쪽지를 쓴 사람만 붙이고 지운다.
@Injectable()
export class IssueAttachmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly issues: IssuesService,
  ) {}

  // 파일과 DB는 함께 되돌릴 수 없어서 순서를 지킨다(버전 화면 사진과 같다): 새 파일 저장 → DB → 실패하면 새 파일 지우기.
  async attach(issueId: string, userId: string, photo: Buffer): Promise<IssueDetail> {
    // 권한 없는 사람이 사진 처리 시간과 디스크를 쓰지 못하게, 잠그기 전에 먼저 본다. 잠근 뒤 다시 본다.
    const projectId = await this.requireAuthor(issueId, userId);
    const image = await processImage(photo);
    const storageKey = await saveAsset(projectId, image.extension, image.data);

    return this.prisma
      .$transaction(async (tx) => {
        await this.lockForAuthor(tx, issueId, userId);
        // 잠근 뒤에 세어서, 동시에 여러 장을 올려도 함께 한도를 넘지 못한다.
        const attached = await tx.issueAttachment.count({ where: { issueId } });
        if (attached >= MAX_ATTACHMENTS) {
          throw conflict('TOO_MANY_ATTACHMENTS', `참고 사진은 ${MAX_ATTACHMENTS}장까지 붙일 수 있어요`);
        }
        await requireProjectQuota(tx, projectId, image.bytes);

        await tx.issueAttachment.create({
          data: {
            issue: { connect: { id: issueId } },
            asset: {
              create: {
                projectId,
                storageKey,
                mime: image.mime,
                bytes: image.bytes,
                width: image.width,
                height: image.height,
              },
            },
          },
        });
        return this.issues.loadDetail(issueId, userId, tx);
      })
      .catch(async (error) => {
        await deleteAssetQuietly(storageKey);
        throw error;
      });
  }

  async remove(issueId: string, attachmentId: string, userId: string): Promise<IssueDetail> {
    const { detail, storageKey } = await this.prisma.$transaction(async (tx) => {
      await this.lockForAuthor(tx, issueId, userId);
      // 이 쪽지에 붙은 사진만 찾는다. 다른 쪽지의 사진 id는 없는 사진과 같은 404다.
      // 버전 화면의 사진은 첨부 줄이 없어서 이 길로는 지울 수 없다.
      const attachment = await tx.issueAttachment.findFirst({
        where: { id: attachmentId, issueId },
        select: { assetId: true },
      });
      if (!attachment) throw assetNotFound();

      await tx.issueAttachment.delete({ where: { id: attachmentId } });
      const asset = await tx.asset.delete({ where: { id: attachment.assetId }, select: { storageKey: true } });
      return { detail: await this.issues.loadDetail(issueId, userId, tx), storageKey: asset.storageKey };
    });

    // 파일은 DB가 커밋된 뒤에 지운다. 먼저 지우면 DB가 실패했을 때 DB가 가리키는 파일이 없어진다.
    await deleteAssetQuietly(storageKey);
    return detail;
  }

  // 잠근 뒤의 순서: 활성 멤버가 아니면 404, 쓴 사람이 아니면 403, 현재 버전이 검수 중이 아니면 409.
  // 참고 사진은 어느 버전을 보며 붙였는지가 뜻이 없어서 보던 버전을 받지 않는다. 승인된 뒤에는 막아야 해서 검수 중인지는 본다.
  private async lockForAuthor(tx: Prisma.TransactionClient, issueId: string, userId: string) {
    const issue = await this.issues.lockIssue(tx, issueId, userId);
    if (issue.authorId !== userId) throw notAuthor();
    await this.issues.requireVersionInReview(tx, issue.projectId);
  }

  private async requireAuthor(issueId: string, userId: string) {
    const issue = await this.prisma.issue.findUnique({
      where: { id: issueId },
      select: { projectId: true, authorId: true },
    });
    if (!issue) throw issueNotFound();
    await this.issues.requireMember(issue.projectId, userId);
    if (issue.authorId !== userId) throw notAuthor();
    return issue.projectId;
  }
}
