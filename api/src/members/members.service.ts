import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ActivityService } from '../activity/activity.service.js';
import { ActivityType, ProjectRole } from '../generated/prisma/client.js';
import { revokeUnusedInvitations } from '../invitations/invitations.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  APPROVER_FIELDS,
  type ApproverView,
  ProjectsService,
  toApproverView,
} from '../projects/projects.service.js';

export type MemberView = { id: string; name: string; email: string; role: ProjectRole; lastSeenAt: Date | null };
export type PendingInvitationView = { email: string; expiresAt: Date };

// 없는 참여자, 남의 프로젝트 참여자, 이미 철회한 참여자가 모두 이 본문으로 답한다. 셋을 구별할 수 없게 하려는 것이다.
export const memberNotFound = () => new NotFoundException('없는 참여자예요');

@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
    private readonly activity: ActivityService,
  ) {}

  // 다른 클라이언트의 이메일과 접속 시각이 보이지 않게 개발자만 본다.
  async list(
    projectId: string,
    userId: string,
  ): Promise<{ members: MemberView[]; invitations: PendingInvitationView[] }> {
    const role = await this.projects.requireMemberRole(projectId, userId);
    if (role !== ProjectRole.DEVELOPER) throw new ForbiddenException('개발자만 볼 수 있어요');

    const [members, invitations] = await Promise.all([
      this.prisma.projectMember.findMany({
        where: { projectId, revokedAt: null },
        select: { id: true, role: true, user: { select: { name: true, email: true, lastSeenAt: true } } },
        // 역할은 DB enum이 적힌 순서(DEVELOPER, CLIENT)로 정렬된다. 그래서 개발자가 먼저, 그다음 참여한 순이다.
        orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
      }),
      // 만료는 수락할 때처럼 DB 시계로 판단한다. 앱 서버 시계와 어긋나도 목록과 수락 결과가 같다.
      this.prisma.$queryRaw<PendingInvitationView[]>`
        SELECT email, expires_at AS "expiresAt" FROM invitations
        WHERE project_id = ${projectId}::uuid AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
        ORDER BY created_at
      `,
    ]);
    return {
      members: members.map(({ user, ...member }) => ({ ...member, ...user })),
      invitations,
    };
  }

  async revoke(memberId: string, userId: string): Promise<void> {
    const target = await this.prisma.projectMember.findUnique({ where: { id: memberId }, select: { projectId: true } });
    if (!target) throw memberNotFound();
    const { projectId } = target;

    await this.prisma.$transaction(async (tx) => {
      // 남의 프로젝트 참여자면 "없는 프로젝트" 대신 "없는 참여자"로 답해서, 그 id가 있는지 드러나지 않게 한다.
      // 보관한 프로젝트에서도 사람은 뺄 수 있다. 누가 볼 수 있는지는 끝난 뒤에도 바꿀 수 있어야 한다(docs/archive.md 정할 것 4).
      await this.projects.lockForDeveloper(tx, projectId, userId, { allowArchived: true }).catch((error: unknown) => {
        throw error instanceof NotFoundException ? memberNotFound() : error;
      });
      const member = await tx.projectMember.findUniqueOrThrow({
        where: { id: memberId },
        select: { role: true, revokedAt: true, user: { select: { email: true } } },
      });
      if (member.revokedAt) throw memberNotFound();
      if (member.role === ProjectRole.DEVELOPER) throw new ForbiddenException('개발자의 접근은 철회할 수 없어요');

      await tx.projectMember.update({ where: { id: memberId }, data: { revokedAt: new Date() } });
      // 그 사람 이메일로 된 쓰지 않은 초대도 무효로 한다. 예전 링크로 다시 들어오지 못한다.
      await revokeUnusedInvitations(tx, projectId, member.user.email);
      // 승인자였으면 비운다. 새로 정할 때까지 승인이 막힌다.
      await tx.project.updateMany({
        where: { id: projectId, approverMemberId: memberId },
        data: { approverMemberId: null },
      });
      await this.activity.record(tx, { projectId, actorId: userId, type: ActivityType.MEMBER_REVOKED, memberId });
    });
  }

  // memberId가 null이면 승인자를 비운다("지정하지 않음").
  async setApprover(projectId: string, userId: string, memberId: string | null): Promise<ApproverView> {
    return this.prisma.$transaction(async (tx) => {
      await this.projects.lockForDeveloper(tx, projectId, userId);

      // 같은 프로젝트라는 것은 DB의 복합 외래키도 지킨다. 역할과 철회 여부는 잠근 뒤 여기서 본다.
      let view: ApproverView = null;
      if (memberId !== null) {
        const approver = await tx.projectMember.findFirst({
          where: { id: memberId, projectId, role: ProjectRole.CLIENT, revokedAt: null },
          select: APPROVER_FIELDS,
        });
        if (!approver) throw new UnprocessableEntityException('승인자는 이 프로젝트에 참여 중인 클라이언트만 될 수 있어요');
        view = toApproverView(approver);
      }

      const { approverMemberId } = await tx.project.findUniqueOrThrow({
        where: { id: projectId },
        select: { approverMemberId: true },
      });
      // 설정 화면에서 바꾸지 않고 다시 저장해도 일지가 쌓이지 않게 한다.
      // 받은 id는 대문자일 수 있어서, DB에서 읽은 id끼리 비교한다.
      if (approverMemberId === (view?.memberId ?? null)) return view;

      await tx.project.update({ where: { id: projectId }, data: { approverMemberId: memberId } });
      await this.activity.record(tx, {
        projectId,
        actorId: userId,
        type: ActivityType.APPROVER_CHANGED,
        memberId: memberId ?? undefined,
      });
      return view;
    });
  }
}
