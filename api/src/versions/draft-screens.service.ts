import { Injectable, Logger, PayloadTooLargeException } from '@nestjs/common';
import { deleteAsset, saveAsset } from '../assets/asset-storage.js';
import { processImage } from '../assets/image.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { screenNotFound } from '../screens/screens.service.js';
import { conflict, type VersionDetail, VersionsService } from './versions.service.js';

const MAX_SCREENS = 20;
const PROJECT_QUOTA_MIB = 500;
const PROJECT_QUOTA_BYTES = PROJECT_QUOTA_MIB * 1024 * 1024;

@Injectable()
export class DraftScreensService {
  private readonly logger = new Logger(DraftScreensService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly versions: VersionsService,
  ) {}

  // 파일과 DB는 함께 되돌릴 수 없어서 순서를 지킨다: 새 파일 저장 → DB → (성공하면) 옛 파일 지우기.
  // 그래서 중간에 멈춰도 DB가 가리키는 파일은 남아 있고, 남는 것은 대개 DB에 없는 파일이다.
  async putAsset(versionId: string, screenId: string, userId: string, photo: Buffer): Promise<VersionDetail> {
    // 권한 없는 사람이 사진 처리 시간과 디스크를 쓰지 못하게, 잠그기 전에 먼저 본다. 잠근 뒤 다시 본다.
    const { projectId } = await this.versions.requireDeveloperOf(versionId, userId);
    const image = await processImage(photo);
    const storageKey = await saveAsset(projectId, image.extension, image.data);

    const result = await this.prisma
      .$transaction(async (tx) => {
        await this.versions.lockDraft(tx, versionId, userId);
        // 다른 프로젝트의 화면도 없는 화면과 같은 404다.
        const screen = await tx.screen.findUnique({ where: { id: screenId, projectId }, select: { hiddenAt: true } });
        if (!screen) throw screenNotFound();
        if (screen.hiddenAt) throw conflict('SCREEN_HIDDEN', '숨긴 화면에는 사진을 올릴 수 없어요');

        const where = { versionId_screenId: { versionId, screenId } };
        const existing = await tx.versionScreen.findUnique({ where, select: { assetId: true } });
        const screenCount = await tx.versionScreen.count({ where: { versionId } });
        if (!existing && screenCount >= MAX_SCREENS) {
          throw conflict('TOO_MANY_SCREENS', `화면은 ${MAX_SCREENS}개까지 올릴 수 있어요`);
        }
        // 잠근 뒤에 합계를 계산해서, 사진 두 장을 동시에 올려도 함께 한도를 넘지 못한다.
        const { _sum } = await tx.asset.aggregate({ where: { projectId }, _sum: { bytes: true } });
        if ((_sum.bytes ?? 0) + image.bytes > PROJECT_QUOTA_BYTES) {
          throw new PayloadTooLargeException(`프로젝트 사진 용량(${PROJECT_QUOTA_MIB} MiB)을 넘어요`);
        }

        const asset = await tx.asset.create({
          data: {
            projectId,
            storageKey,
            mime: image.mime,
            bytes: image.bytes,
            width: image.width,
            height: image.height,
          },
          select: { id: true },
        });
        await tx.versionScreen.upsert({
          where,
          create: { versionId, screenId, assetId: asset.id },
          update: { assetId: asset.id },
        });
        const removedKey = existing ? await this.deleteIfUnused(tx, existing.assetId) : null;
        return { detail: await this.versions.loadDetail(versionId, tx), removedKey };
      })
      .catch(async (error) => {
        await this.deleteFileQuietly(storageKey);
        throw error;
      });

    if (result.removedKey) await this.deleteFileQuietly(result.removedKey);
    return result.detail;
  }

  async removeScreen(versionId: string, screenId: string, userId: string): Promise<VersionDetail> {
    const result = await this.prisma.$transaction(async (tx) => {
      await this.versions.lockDraft(tx, versionId, userId);
      const link = await tx.versionScreen.findUnique({
        where: { versionId_screenId: { versionId, screenId } },
        select: { id: true, assetId: true },
      });
      if (!link) throw screenNotFound();

      await tx.versionScreen.delete({ where: { id: link.id } });
      const removedKey = await this.deleteIfUnused(tx, link.assetId);
      return { detail: await this.versions.loadDetail(versionId, tx), removedKey };
    });

    if (result.removedKey) await this.deleteFileQuietly(result.removedKey);
    return result.detail;
  }

  // 지난 버전이 아직 쓰는 사진은 남긴다. 어느 버전 화면도 쓰지 않을 때만 줄을 지우고, 파일은 커밋 뒤에 지우도록 경로를 돌려준다.
  private async deleteIfUnused(tx: Prisma.TransactionClient, assetId: string) {
    const usage = await tx.versionScreen.count({ where: { assetId } });
    if (usage > 0) return null;
    const { storageKey } = await tx.asset.delete({ where: { id: assetId }, select: { storageKey: true } });
    return storageKey;
  }

  // 파일 지우기가 실패해도 요청의 결과(원래 오류나 성공)를 바꾸지 않는다. DB에 없는 파일이 남을 뿐이다.
  private async deleteFileQuietly(storageKey: string) {
    await deleteAsset(storageKey).catch((error) => {
      this.logger.error(`사진 파일을 지우지 못했어요: ${storageKey}`, error);
    });
  }
}
