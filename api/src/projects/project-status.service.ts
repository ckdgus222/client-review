import { HttpStatus, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { ActivityService } from '../activity/activity.service.js';
import { ActivityType, ProjectStatus } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { conflict, DELETE_GRACE_DAYS, ProjectsService } from './projects.service.js';

// 보관·보관 풀기·삭제·되살리기(docs/archive.md 정할 것 8·9·10). 모두 개발자만 하고, 상태 줄과 사건 줄을 한 트랜잭션에 쓴다.
// 삭제·되살리기 사건은 record가 같은 트랜잭션에서 개발자 기록 메일을 우편함에 넣는다(정할 것 11).
@Injectable()
export class ProjectStatusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
    private readonly activity: ActivityService,
  ) {}

  // 이미 보관했거나 삭제 대기면 lockForDeveloper가 409로 멈춘다.
  async archive(projectId: string, userId: string) {
    await this.prisma.$transaction(async (tx) => {
      await this.projects.lockForDeveloper(tx, projectId, userId);
      await tx.project.update({ where: { id: projectId }, data: { status: ProjectStatus.ARCHIVED } });
      await this.activity.record(tx, { projectId, actorId: userId, type: ActivityType.PROJECT_ARCHIVED });
    });
  }

  async unarchive(projectId: string, userId: string) {
    await this.prisma.$transaction(async (tx) => {
      const status = await this.projects.lockForDeveloper(tx, projectId, userId, { allowArchived: true });
      if (status !== ProjectStatus.ARCHIVED) throw conflict('PROJECT_NOT_ARCHIVED', '보관한 프로젝트가 아니에요');
      await tx.project.update({ where: { id: projectId }, data: { status: ProjectStatus.ACTIVE } });
      await this.activity.record(tx, { projectId, actorId: userId, type: ActivityType.PROJECT_UNARCHIVED });
    });
  }

  // 대소문자까지 그대로 비교한다.
  async delete(projectId: string, userId: string, name: string) {
    await this.prisma.$transaction(async (tx) => {
      await this.projects.lockForDeveloper(tx, projectId, userId, { allowArchived: true });
      const project = await tx.project.findUniqueOrThrow({ where: { id: projectId }, select: { name: true } });
      if (project.name !== name) {
        throw new UnprocessableEntityException({
          statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
          message: '프로젝트 이름이 달라요',
          code: 'PROJECT_NAME_MISMATCH',
        });
      }
      // 되돌아갈 상태와 삭제 시각을 DB가 한 문장에 적는다. 시각은 되살리기·정리 작업과 같은 DB 시계다.
      await tx.$executeRaw`
        UPDATE projects
        SET status_before_delete = status, status = 'DELETE_PENDING', delete_requested_at = clock_timestamp()
        WHERE id = ${projectId}::uuid
      `;
      await this.activity.record(tx, { projectId, actorId: userId, type: ActivityType.PROJECT_DELETE_REQUESTED });
    });
  }

  // 삭제 대기의 클라이언트는 requireMemberRole에서 404라서 이 프로젝트가 있는지 알 수 없다(정할 것 9).
  // 7일이 지나면 되살리지 않는다. 정리 작업이 사진을 지우다 멈춘 프로젝트가 깨진 채 되살아나지 않게 한다.
  async restore(projectId: string, userId: string) {
    await this.prisma.$transaction(async (tx) => {
      const status = await this.projects.lockAsDeveloper(tx, projectId, userId);
      if (status !== ProjectStatus.DELETE_PENDING) {
        throw conflict('PROJECT_NOT_DELETED', '삭제 대기 중인 프로젝트가 아니에요');
      }
      // 정리 작업은 "7일 지남"만 지우고 여기는 "7일 안"만 받는다. 같은 DB 시계와 경계라 둘이 겹치지 않는다.
      const restored = await tx.$executeRaw`
        UPDATE projects
        SET status = status_before_delete, status_before_delete = NULL, delete_requested_at = NULL
        WHERE id = ${projectId}::uuid
          AND delete_requested_at > clock_timestamp() - make_interval(days => ${DELETE_GRACE_DAYS}::int)
      `;
      if (restored === 0) {
        throw conflict('RESTORE_PERIOD_OVER', `되살릴 수 있는 ${DELETE_GRACE_DAYS}일이 지났어요`);
      }
      await this.activity.record(tx, { projectId, actorId: userId, type: ActivityType.PROJECT_RESTORED });
    });
  }
}
