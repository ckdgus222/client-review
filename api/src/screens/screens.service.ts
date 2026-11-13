import { ConflictException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type Viewport } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProjectsService } from '../projects/projects.service.js';

export type ScreenView = { id: string; name: string; viewport: Viewport; hiddenAt: Date | null };

const SCREEN_FIELDS = { id: true, name: true, viewport: true, hiddenAt: true } as const;

// 오류 본문은 로그인 오류와 같이 Nest 기본 모양에 code를 더한다. web은 code를 보고 문구를 고른다.
const screenExistsError = () =>
  new ConflictException({ statusCode: HttpStatus.CONFLICT, message: '이미 있는 화면이에요', code: 'SCREEN_EXISTS' });

const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

// 없는 화면, 남의 화면, 틀린 모양 id(컨트롤러)가 모두 이 본문으로 답한다.
export const screenNotFound = () => new NotFoundException('없는 화면이에요');

@Injectable()
export class ScreensService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
  ) {}

  // 숨긴 화면도 함께 돌려준다. web이 보이는 목록과 숨긴 목록으로 나눈다.
  async list(projectId: string, userId: string): Promise<ScreenView[]> {
    await this.projects.requireMemberRole(projectId, userId);
    return this.prisma.screen.findMany({
      where: { projectId },
      select: SCREEN_FIELDS,
      orderBy: { createdAt: 'asc' },
    });
  }

  // name은 입력 검사(DTO)에서 앞뒤 공백을 지운 값이다.
  async create(projectId: string, userId: string, name: string, viewport: Viewport): Promise<ScreenView> {
    return this.prisma.$transaction(async (tx) => {
      // 같은 프로젝트의 화면 쓰기는 프로젝트 줄 잠금 때문에 하나씩 차례로 처리된다(숨기기와 보이기가 동시에 와도).
      await this.projects.lockForDeveloper(tx, projectId, userId);
      // 같은 이름·기기는 숨긴 화면까지 유니크 제약이 거절한다. 그래서 먼저 찾아보는 코드를 두지 않는다.
      return tx.screen.create({ data: { projectId, name, viewport }, select: SCREEN_FIELDS }).catch((error) => {
        throw isUniqueViolation(error) ? screenExistsError() : error;
      });
    });
  }

  // 이미 그 상태면 바꾸지 않고 지금 상태를 돌려준다. 두 번 눌러도 안전하고, 처음 숨긴 시각이 남는다.
  async setHidden(screenId: string, userId: string, hidden: boolean): Promise<ScreenView> {
    // 화면의 project_id는 바뀌지 않아서 잠그기 전에 읽어도 된다.
    const found = await this.prisma.screen.findUnique({ where: { id: screenId }, select: { projectId: true } });
    if (!found) throw screenNotFound();

    return this.prisma.$transaction(async (tx) => {
      // 남의 화면도 없는 화면과 같은 404로 답한다. 문구가 다르면 그 화면 id가 어딘가 있다는 것이 드러난다.
      await this.projects.lockForDeveloper(tx, found.projectId, userId).catch((error) => {
        throw error instanceof NotFoundException ? screenNotFound() : error;
      });
      const screen = await tx.screen.findUniqueOrThrow({ where: { id: screenId }, select: SCREEN_FIELDS });
      const isHidden = screen.hiddenAt !== null;
      if (isHidden === hidden) return screen;

      return tx.screen.update({
        where: { id: screenId },
        data: { hiddenAt: hidden ? new Date() : null },
        select: SCREEN_FIELDS,
      });
    });
  }

}
