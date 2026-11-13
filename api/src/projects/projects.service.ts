import { ConflictException, ForbiddenException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ProjectRole, ProjectStatus } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

// 프로젝트에 이 사람의 역할을 붙인 모양. 목록과 만들기가 같은 모양을 돌려준다.
// purgeAfter는 삭제 대기일 때 정리 작업이 완전히 지우는 때다. 아니면 null.
export type MyProject = {
  id: string;
  name: string;
  myRole: ProjectRole;
  createdAt: Date;
  status: ProjectStatus;
  purgeAfter: Date | null;
};

const PROJECT_FIELDS = { id: true, name: true, createdAt: true, status: true, deleteRequestedAt: true } as const;

// 지운 프로젝트를 되살릴 수 있는 기간. 정리 작업과 되살리기의 SQL도 같은 7일을 쓴다(docs/archive.md 정할 것 9·13).
export const DELETE_GRACE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const purgeAfterOf = (deleteRequestedAt: Date | null) =>
  deleteRequestedAt && new Date(deleteRequestedAt.getTime() + DELETE_GRACE_DAYS * DAY_MS);

const toMyProject = (
  { deleteRequestedAt, ...project }: Prisma.ProjectGetPayload<{ select: typeof PROJECT_FIELDS }>,
  myRole: ProjectRole,
): MyProject => ({
  ...project,
  myRole,
  purgeAfter: purgeAfterOf(deleteRequestedAt),
});

// 프로젝트 상세와 승인자 바꾸기가 같은 모양으로 승인자를 돌려준다.
export type ApproverView = { memberId: string; name: string } | null;
export const APPROVER_FIELDS = { id: true, user: { select: { name: true } } } as const;
export const toApproverView = (approver: { id: string; user: { name: string } } | null): ApproverView =>
  approver ? { memberId: approver.id, name: approver.user.name } : null;

// 멤버가 아님, 없는 프로젝트, 틀린 모양 id(컨트롤러)가 모두 이 본문으로 답한다. 셋을 구별할 수 없게 하려는 것이다.
export const projectNotFound = () => new NotFoundException('없는 프로젝트예요');

// 오류 본문은 화면 409와 같이 Nest 기본 모양에 code를 더한다. web은 code를 보고 문구를 고른다.
// 버전·쪽지·초대도 이것을 쓴다. versions.service가 이 파일을 가져와서 여기 둔다(반대로 두면 서로 가져오는 고리가 생긴다).
export const conflict = (code: string, message: string) =>
  new ConflictException({ statusCode: HttpStatus.CONFLICT, message, code });

// 쓰기 API는 잠금과 멤버 확인, 자기 권한·숨김·재전송 확인을 마친 뒤 이것을 부른다(docs/archive.md 정할 것 3).
// 순서가 멤버(404) → 권한(403) → 상태(409)라서 남의 프로젝트가 보관됐는지 드러나지 않는다.
// 접근 철회·보관 풀기·삭제만 allowArchived로 보관한 프로젝트를 바꾼다.
export const assertWritable = (status: ProjectStatus, { allowArchived = false }: { allowArchived?: boolean } = {}) => {
  if (status === ProjectStatus.DELETE_PENDING) {
    throw conflict('PROJECT_DELETE_PENDING', '삭제 대기 중인 프로젝트예요. 되살려야 바꿀 수 있어요');
  }
  if (status === ProjectStatus.ARCHIVED && !allowArchived) {
    throw conflict('PROJECT_ARCHIVED', '보관한 프로젝트예요. 보관을 풀어야 바꿀 수 있어요');
  }
};

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
    return toMyProject(project, ProjectRole.DEVELOPER);
  }

  // 내 멤버 줄에서 출발해서, 멤버가 아닌 프로젝트는 처음부터 섞이지 않는다.
  async listMine(userId: string): Promise<MyProject[]> {
    const members = await this.prisma.projectMember.findMany({
      // 접근이 철회된 프로젝트는 목록에서도 빠진다. 삭제 대기 프로젝트는 개발자 목록에만 남는다(되살리기 버튼).
      where: {
        userId,
        revokedAt: null,
        OR: [{ role: ProjectRole.DEVELOPER }, { project: { status: { not: ProjectStatus.DELETE_PENDING } } }],
      },
      select: { role: true, project: { select: PROJECT_FIELDS } },
      orderBy: { project: { createdAt: 'desc' } },
    });
    return members.map(({ role, project }) => toMyProject(project, role));
  }

  // 특정 프로젝트를 다루는 요청은 모두 여기서 멤버인지 확인한다.
  // 멤버가 아니면 403이 아니라 404다. 남의 프로젝트가 있는지도 알 수 없게 하려는 것이다.
  // 트랜잭션 안에서 부를 때는 그 트랜잭션(db)으로 찾아야 잠근 뒤의 상태를 본다.
  // 접근이 철회된 줄은 멤버가 아닌 것과 같다. 모든 프로젝트·버전·사진·일지 요청이 여기를 지나서, 철회하면 바로 모두 막힌다.
  // 삭제 대기 프로젝트도 개발자가 아니면 없는 것과 같다. 개발자는 읽기만 한다(쓰기는 assertWritable이 막는다).
  async requireMemberRole(
    projectId: string,
    userId: string,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<ProjectRole> {
    // 규칙을 조건에 넣어 한 번의 조회로 본다. 셋 중 하나라도 걸리면 줄이 없어서 같은 404다.
    const member = await db.projectMember.findFirst({
      where: {
        projectId,
        userId,
        revokedAt: null,
        OR: [{ role: ProjectRole.DEVELOPER }, { project: { status: { not: ProjectStatus.DELETE_PENDING } } }],
      },
      select: { role: true },
    });
    if (!member) throw projectNotFound();
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
        status: true,
        deleteRequestedAt: true,
        currentVersion: { select: { id: true, number: true } },
        approver: { select: { ...APPROVER_FIELDS, userId: true } },
      },
    });
    const { approver, deleteRequestedAt, ...rest } = project;
    // 내가 승인자인지는 서버가 정해서 알려 준다. 화면은 내 멤버 id를 몰라서 스스로 판단할 수 없다.
    // 멤버 줄은 (프로젝트, 사용자)마다 하나라서, 승인자 줄의 사용자가 나면 내 멤버 줄이 승인자 줄이다.
    return {
      ...rest,
      purgeAfter: purgeAfterOf(deleteRequestedAt),
      myRole,
      approver: toApproverView(approver),
      isApprover: approver?.userId === userId,
    };
  }

  // 같은 프로젝트의 쓰기 명령은 프로젝트 줄을 잠가서 하나씩 차례로 처리한다. 잠근 뒤의 상태를 돌려줘서
  // 부른 쪽이 자기 검사를 마친 뒤 assertWritable에 넘긴다. 승인 창 조회처럼 읽기만 하는 곳은 공유 잠금(SHARE)을 쓴다.
  async lockProject(tx: Prisma.TransactionClient, projectId: string, mode: 'UPDATE' | 'SHARE' = 'UPDATE') {
    // mode는 두 값뿐인 타입이라 SQL에 그대로 넣어도 된다.
    const [project] = await tx.$queryRaw<{ status: ProjectStatus }[]>`
      SELECT status FROM projects WHERE id = ${projectId}::uuid FOR ${Prisma.raw(mode)}`;
    if (!project) throw projectNotFound();
    return project.status;
  }

  // 개발자만 하는 명령은 잠근 뒤 권한을 본다. 잠그기 전에 보면 그사이 바뀐 상태로 판단할 수 있다.
  // 상태 검사는 하지 않는다. 삭제 대기에서만 하는 되살리기가 이것을 그대로 쓴다.
  async lockAsDeveloper(tx: Prisma.TransactionClient, projectId: string, userId: string) {
    const status = await this.lockProject(tx, projectId);
    const role = await this.requireMemberRole(projectId, userId, tx);
    if (role !== ProjectRole.DEVELOPER) throw new ForbiddenException('개발자만 할 수 있어요');
    return status;
  }

  // 개발자만 하는 쓰기 명령. 상태를 돌려줘서, 보관 풀기처럼 상태에 따라 갈리는 명령이 다시 읽지 않는다.
  async lockForDeveloper(
    tx: Prisma.TransactionClient,
    projectId: string,
    userId: string,
    options: { allowArchived?: boolean } = {},
  ) {
    const status = await this.lockAsDeveloper(tx, projectId, userId);
    assertWritable(status, options);
    return status;
  }
}
