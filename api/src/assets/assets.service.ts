import { Injectable, NotFoundException } from '@nestjs/common';
import { ProjectRole, VersionStatus } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { assetPath } from './asset-storage.js';

export type AssetFile = { path: string; mime: string };

// 없는 사진, 남의 사진, 클라이언트가 보려는 초안 사진, 틀린 모양 id(컨트롤러)가 모두 이 본문으로 답한다.
// 넷을 구별할 수 없게 해서 사진이 있는지 드러나지 않게 하려는 것이다.
export const assetNotFound = () => new NotFoundException('없는 사진이에요');

@Injectable()
export class AssetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
  ) {}

  async getFileForMember(assetId: string, userId: string): Promise<AssetFile> {
    const asset = await this.prisma.asset.findUnique({
      where: { id: assetId },
      select: { projectId: true, storageKey: true, mime: true },
    });
    if (!asset) throw assetNotFound();

    const role = await this.projects.requireMemberRole(asset.projectId, userId).catch((error) => {
      throw error instanceof NotFoundException ? assetNotFound() : error;
    });
    // 클라이언트는 게시된 버전이 쓰는 사진만 본다. 사진 id를 알아내도 아직 게시 안 된 초안 사진은 미리 볼 수 없다.
    if (role !== ProjectRole.DEVELOPER) {
      const publishedUse = await this.prisma.versionScreen.findFirst({
        where: { assetId, version: { status: { not: VersionStatus.DRAFT } } },
        select: { id: true },
      });
      if (!publishedUse) throw assetNotFound();
    }
    return { path: assetPath(asset.storageKey), mime: asset.mime };
  }
}
