import { ConflictException, ForbiddenException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { ActivityService } from '../activity/activity.service.js';
import {
  ActivityType,
  IssueStatus,
  Prisma,
  ProjectRole,
  VersionStatus,
  type Viewport,
} from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProjectsService } from '../projects/projects.service.js';

export type VersionSummary = { id: string; number: number | null; status: VersionStatus; publishedAt: Date | null };

export type VersionDetail = {
  id: string;
  projectId: string;
  number: number | null;
  status: VersionStatus;
  summary: string;
  testUrl: string | null;
  publishedAt: Date | null;
  screens: {
    screenId: string;
    name: string;
    viewport: Viewport;
    hiddenAt: Date | null;
    asset: { id: string; width: number; height: number };
  }[];
};

// summary는 앞뒤 공백을 지운 값, testUrl은 빈 글을 null로 바꾼 값이다(입력 검사 DTO).
export type DraftChanges = { summary?: string; testUrl?: string | null };

// 없는 버전, 남의 버전, 클라이언트가 보려는 게시 전 버전, 틀린 모양 id(컨트롤러)가 모두 이 본문으로 답한다.
export const versionNotFound = () => new NotFoundException('없는 버전이에요');

// 오류 본문은 화면 409와 같이 Nest 기본 모양에 code를 더한다. web은 code를 보고 문구를 고른다.
export const conflict = (code: string, message: string) =>
  new ConflictException({ statusCode: HttpStatus.CONFLICT, message, code });

export const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

@Injectable()
export class VersionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
    private readonly activity: ActivityService,
  ) {}

  async list(projectId: string, userId: string): Promise<VersionSummary[]> {
    const role = await this.projects.requireMemberRole(projectId, userId);
    return this.prisma.deliveryVersion.findMany({
      // 클라이언트에게 게시 전 버전은 없는 것과 같다.
      where: role === ProjectRole.DEVELOPER ? { projectId } : { projectId, status: { not: VersionStatus.DRAFT } },
      select: { id: true, number: true, status: true, publishedAt: true },
      // 게시 전 버전은 번호가 비어 있어서 맨 앞에 오고, 그다음은 번호가 큰 순이다.
      orderBy: { number: { sort: 'desc', nulls: 'first' } },
    });
  }

  async createDraft(projectId: string, userId: string): Promise<VersionDetail> {
    return this.prisma.$transaction(async (tx) => {
      // 복사하는 동안 게시(현재 버전 바꾸기)나 화면 숨기기가 끼어들지 않게 프로젝트 줄을 잠근다.
      await tx.$queryRaw`SELECT id FROM projects WHERE id = ${projectId}::uuid FOR UPDATE`;
      const role = await this.projects.requireMemberRole(projectId, userId, tx);
      if (role !== ProjectRole.DEVELOPER) throw new ForbiddenException('개발자만 할 수 있어요');

      // 사진은 새로 만들지 않고 같은 Asset을 가리킨다. 숨긴 화면은 새 게시 전 버전에 넣지 않는다.
      const { currentVersion } = await tx.project.findUniqueOrThrow({
        where: { id: projectId },
        select: { currentVersion: { select: { id: true, testUrl: true } } },
      });
      const copied = currentVersion
        ? await tx.versionScreen.findMany({
            where: { versionId: currentVersion.id, screen: { hiddenAt: null } },
            select: { screenId: true, assetId: true },
          })
        : [];
      // 테스트 주소는 보통 차수마다 같아서 이어받는다. 설명은 이번 차수에서 바뀐 점이라 빈 칸에서 시작한다.
      const testUrl = currentVersion?.testUrl ?? null;

      // 게시 전 버전이 이미 있으면 "게시 전 버전은 프로젝트마다 1개" 인덱스가 거절한다. 그래서 먼저 찾아보는 코드를 두지 않는다.
      const draft = await tx.deliveryVersion
        .create({ data: { projectId, testUrl, screens: { create: copied } }, select: { id: true } })
        .catch((error) => {
          throw isUniqueViolation(error) ? conflict('DRAFT_EXISTS', '이미 준비 중인 버전이 있어요') : error;
        });
      return this.loadDetail(draft.id, tx);
    });
  }

  async getDetail(versionId: string, userId: string): Promise<VersionDetail> {
    const version = await this.findVersion(versionId);
    const role = await this.requireMember(version.projectId, userId);
    if (role !== ProjectRole.DEVELOPER && version.status === VersionStatus.DRAFT) throw versionNotFound();
    return this.loadDetail(versionId);
  }

  async updateDraft(versionId: string, userId: string, changes: DraftChanges): Promise<VersionDetail> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockDraft(tx, versionId, userId);
      await tx.deliveryVersion.update({ where: { id: versionId }, data: changes });
      return this.loadDetail(versionId, tx);
    });
  }

  async publish(versionId: string, userId: string): Promise<VersionDetail> {
    return this.prisma.$transaction(async (tx) => {
      const projectId = await this.lockDraft(tx, versionId, userId);
      const draftScreens = await tx.versionScreen.findMany({
        where: { versionId },
        select: { screen: { select: { hiddenAt: true } } },
      });
      if (draftScreens.length === 0) throw conflict('NO_SCREENS', '사진을 올린 화면이 없어요');
      // 게시 전 버전에 넣은 뒤 숨긴 화면이 남아 있으면 막는다. 숨겼다는 것은 이제 안 쓴다는 뜻이라 그대로 게시하면 대부분 실수다.
      if (draftScreens.some(({ screen }) => screen.hiddenAt !== null)) {
        throw conflict('SCREEN_HIDDEN', '숨긴 화면을 빼고 게시해 주세요');
      }

      // 번호는 0부터다. 화면에서 0은 "초안", 1부터는 그 번호 그대로 "1차"·"2차"라서 번호와 이름이 어긋나지 않는다.
      const { _max } = await tx.deliveryVersion.aggregate({ where: { projectId }, _max: { number: true } });
      await tx.deliveryVersion.update({
        where: { id: versionId },
        data: { status: VersionStatus.IN_REVIEW, number: (_max.number ?? -1) + 1, publishedAt: new Date() },
      });
      await tx.project.update({ where: { id: projectId }, data: { currentVersionId: versionId } });
      // 확인 요청 쪽지의 "고쳤어요"는 지난 버전의 화면을 가리킨다. 새 버전이 올라오면 그 화면은 옛것이라, 수정 중으로 돌려서
      // 개발자가 새 버전의 화면으로 고쳤어요를 다시 보내게 한다. 고쳤어요 줄은 건드리지 않는다(결과 없이 남는다).
      // 쪽지마다 일지를 남기지 않는다. 아래 게시 사건 하나면 된다.
      await tx.issue.updateMany({
        where: { projectId, status: IssueStatus.READY_FOR_REVIEW },
        data: { status: IssueStatus.IN_PROGRESS },
      });
      await this.activity.record(tx, { projectId, actorId: userId, type: ActivityType.VERSION_PUBLISHED, versionId });
      return this.loadDetail(versionId, tx);
    });
  }

  // 버전 id로 오는 쓰기의 권한 순서: 없음·남의 것은 404, 개발자가 아니면 게시 전 버전은 404·게시된 버전은 403.
  // 클라이언트는 게시 전 버전이 있는지도 알 수 없다. 사진 올리기는 무거운 사진 처리 전에 잠그지 않고 먼저 부른다.
  async requireDeveloperOf(versionId: string, userId: string, db: Prisma.TransactionClient = this.prisma) {
    const version = await this.findVersion(versionId, db);
    const role = await this.requireMember(version.projectId, userId, db);
    if (role === ProjectRole.DEVELOPER) return version;
    throw version.status === VersionStatus.DRAFT ? versionNotFound() : new ForbiddenException('개발자만 할 수 있어요');
  }

  // 게시 전 버전을 바꾸는 명령은 프로젝트 줄을 잠근 뒤 권한과 상태를 본다. 같은 프로젝트의 쓰기가 하나씩 차례로 처리되고,
  // 잠그기 전에 게시됐어도 여기서 409로 멈춘다.
  async lockDraft(tx: Prisma.TransactionClient, versionId: string, userId: string) {
    const { projectId } = await this.findVersion(versionId, tx);
    await tx.$queryRaw`SELECT id FROM projects WHERE id = ${projectId}::uuid FOR UPDATE`;
    const version = await this.requireDeveloperOf(versionId, userId, tx);
    if (version.status !== VersionStatus.DRAFT) throw conflict('VERSION_NOT_DRAFT', '게시한 버전은 고칠 수 없어요');
    return projectId;
  }

  // 권한을 확인한 뒤에만 부른다.
  async loadDetail(versionId: string, db: Prisma.TransactionClient = this.prisma): Promise<VersionDetail> {
    const { screens, ...version } = await db.deliveryVersion.findUniqueOrThrow({
      where: { id: versionId },
      select: {
        id: true,
        projectId: true,
        number: true,
        status: true,
        summary: true,
        testUrl: true,
        publishedAt: true,
        screens: {
          select: {
            screen: { select: { id: true, name: true, viewport: true, hiddenAt: true } },
            asset: { select: { id: true, width: true, height: true } },
          },
          orderBy: { screen: { createdAt: 'asc' } },
        },
      },
    });
    return {
      ...version,
      screens: screens.map(({ screen: { id, ...screen }, asset }) => ({ screenId: id, ...screen, asset })),
    };
  }

  private async findVersion(versionId: string, db: Prisma.TransactionClient = this.prisma) {
    const version = await db.deliveryVersion.findUnique({
      where: { id: versionId },
      select: { projectId: true, status: true },
    });
    if (!version) throw versionNotFound();
    return version;
  }

  // 남의 버전도 없는 버전과 같은 404로 답한다. 문구가 다르면 그 버전 id가 어딘가 있다는 것이 드러난다.
  private async requireMember(projectId: string, userId: string, db: Prisma.TransactionClient = this.prisma) {
    return this.projects.requireMemberRole(projectId, userId, db).catch((error) => {
      throw error instanceof NotFoundException ? versionNotFound() : error;
    });
  }
}
