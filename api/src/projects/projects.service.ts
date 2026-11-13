import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { type Prisma, ProjectRole } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

// 프로젝트에 이 사람의 역할을 붙인 모양. 목록과 만들기가 같은 모양을 돌려준다.
export type MyProject = { id: string; name: string; myRole: ProjectRole; createdAt: Date };

const PROJECT_FIELDS = { id: true, name: true, createdAt: true } as const;

// 프로젝트 상세와 승인자 바꾸기가 같은 모양으로 승인자를 돌려준다.
export type ApproverView = { memberId: string; name: string } | null;
export const APPROVER_FIELDS = { id: true, user: { select: { name: true } } } as const;
export const toApproverView = (approver: { id: string; user: { name: string } } | null): ApproverView =>
  approver ? { memberId: approver.id, name: approver.user.name } : null;

// 멤버가 아님, 없는 프로젝트, 틀린 모양 id(컨트롤러)가 모두 이 본문으로 답한다. 셋을 구별할 수 없게 하려는 것이다.
export const projectNotFound = () => new NotFoundException('없는 프로젝트예요');

@Injectable()
export class ProjectsService {
  constructor(private readonly prisma: PrismaService) {}

  // name은 입력 검사(DTO)에서 앞뒤 공백을 지운 값이다.
  async create(userId: string, name: string): Promise<MyProject> {
    // 프로젝트와 DEVELOPER 멤버 줄을 create 한 번으로 만든다. Prisma가 한 트랜잭션으로 묶어서
    // 멤버 줄이 실패하면 프로젝트도 남지 않는다.
    const project = await this.prisma.project.create({
      data: { name, members: { create: { userId, role: ProjectRole.DEVELOPER } } },
      select: PROJECT_FIELDS,
    });
    return { ...project, myRole: ProjectRole.DEVELOPER };
  }

  // 내 멤버 줄에서 출발해서, 멤버가 아닌 프로젝트는 처음부터 섞이지 않는다.
  async listMine(userId: string): Promise<MyProject[]> {
    const members = await this.prisma.projectMember.findMany({
      // 접근이 철회된 프로젝트는 목록에서도 빠진다.
      where: { userId, revokedAt: null },
      select: { role: true, project: { select: PROJECT_FIELDS } },
      orderBy: { project: { createdAt: 'desc' } },
    });
    return members.map(({ role, project }) => ({ ...project, myRole: role }));
  }

  // 특정 프로젝트를 다루는 요청은 모두 여기서 멤버인지 확인한다.
  // 멤버가 아니면 403이 아니라 404다. 남의 프로젝트가 있는지도 알 수 없게 하려는 것이다.
  // 트랜잭션 안에서 부를 때는 그 트랜잭션(db)으로 찾아야 잠근 뒤의 상태를 본다.
  // 접근이 철회된 줄은 멤버가 아닌 것과 같다. 모든 프로젝트·버전·사진·일지 요청이 여기를 지나서, 철회하면 바로 모두 막힌다.
  async requireMemberRole(
    projectId: string,
    userId: string,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<ProjectRole> {
    const member = await db.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
      select: { role: true, revokedAt: true },
    });
    if (!member || member.revokedAt) throw projectNotFound();
    return member.role;
  }

  async getForMember(projectId: string, userId: string) {
    const myRole = await this.requireMemberRole(projectId, userId);
    // 멤버 줄이 있으면 FK 때문에 프로젝트 줄도 있다.
    const project = await this.prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: {
        id: true,
        name: true,
        currentVersion: { select: { id: true, number: true } },
        approver: { select: { ...APPROVER_FIELDS, userId: true } },
      },
    });
    const { approver, ...rest } = project;
    // 내가 승인자인지는 서버가 정해서 알려 준다. 화면은 내 멤버 id를 몰라서 스스로 판단할 수 없다.
    // 멤버 줄은 (프로젝트, 사용자)마다 하나라서, 승인자 줄의 사용자가 나면 내 멤버 줄이 승인자 줄이다.
    return { ...rest, myRole, approver: toApproverView(approver), isApprover: approver?.userId === userId };
  }

  // 같은 프로젝트의 쓰기 명령은 프로젝트 줄을 잠가서 하나씩 차례로 처리한다.
  async lockProject(tx: Prisma.TransactionClient, projectId: string) {
    await tx.$queryRaw`SELECT id FROM projects WHERE id = ${projectId}::uuid FOR UPDATE`;
  }

  // 개발자만 하는 쓰기 명령은 잠근 뒤 권한을 본다. 잠그기 전에 보면 그사이 바뀐 상태로 판단할 수 있다.
  async lockForDeveloper(tx: Prisma.TransactionClient, projectId: string, userId: string) {
    await this.lockProject(tx, projectId);
    const role = await this.requireMemberRole(projectId, userId, tx);
    if (role !== ProjectRole.DEVELOPER) throw new ForbiddenException('개발자만 할 수 있어요');
  }
}
