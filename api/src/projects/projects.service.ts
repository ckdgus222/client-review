import { Injectable, NotFoundException } from '@nestjs/common';
import { type Prisma, ProjectRole } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

// 프로젝트에 이 사람의 역할을 붙인 모양. 목록과 만들기가 같은 모양을 돌려준다.
export type MyProject = { id: string; name: string; myRole: ProjectRole; createdAt: Date };

const PROJECT_FIELDS = { id: true, name: true, createdAt: true } as const;

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
      where: { userId },
      select: { role: true, project: { select: PROJECT_FIELDS } },
      orderBy: { project: { createdAt: 'desc' } },
    });
    return members.map(({ role, project }) => ({ ...project, myRole: role }));
  }

  // 특정 프로젝트를 다루는 요청은 모두 여기서 멤버인지 확인한다.
  // 멤버가 아니면 403이 아니라 404다. 남의 프로젝트가 있는지도 알 수 없게 하려는 것이다.
  // 트랜잭션 안에서 부를 때는 그 트랜잭션(db)으로 찾아야 잠근 뒤의 상태를 본다.
  async requireMemberRole(
    projectId: string,
    userId: string,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<ProjectRole> {
    const member = await db.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
      select: { role: true },
    });
    if (!member) throw new NotFoundException('없는 프로젝트예요');
    return member.role;
  }

  async getForMember(projectId: string, userId: string) {
    const myRole = await this.requireMemberRole(projectId, userId);
    // 멤버 줄이 있으면 FK 때문에 프로젝트 줄도 있다.
    const project = await this.prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { id: true, name: true },
    });
    return { ...project, myRole };
  }
}
