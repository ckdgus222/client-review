import { ForbiddenException, GoneException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { ActivityService } from '../activity/activity.service.js';
import { createSessionToken, hashSessionToken } from '../auth/token.js';
import { ActivityType, type Prisma, ProjectRole, ProjectStatus } from '../generated/prisma/client.js';
import { MailService } from '../mail/mail.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { assertWritable, ProjectsService } from '../projects/projects.service.js';
import { conflict } from '../versions/versions.service.js';

// 프로젝트마다 활성 클라이언트는 5명까지다(전체 기획 5장).
const MAX_CLIENTS = 5;

export type CreatedInvitation = { email: string; expiresAt: Date; link: string };

export type InvitationPreview = {
  projectName: string;
  inviterName: string;
  email: string;
  status: 'PENDING' | 'ACCEPTED';
};

// 없는 초대와 무효가 된 초대는 같은 404다. 수락된 초대를 다시 수락해도 404다.
const invitationNotFound = () => new NotFoundException('사용할 수 없는 초대예요');
const invitationExpired = () => new GoneException('초대가 만료됐어요');

// 초대할 때와 수락할 때 같은 기준으로 센다. 철회된 클라이언트는 세지 않는다.
const assertClientSlot = async (tx: Prisma.TransactionClient, projectId: string) => {
  const count = await tx.projectMember.count({ where: { projectId, role: ProjectRole.CLIENT, revokedAt: null } });
  if (count >= MAX_CLIENTS) throw conflict('PROJECT_FULL', `클라이언트는 ${MAX_CLIENTS}명까지 참여할 수 있어요`);
};

// 같은 이메일의 쓰지 않은 초대를 무효로 한다. 다시 초대할 때와 접근을 철회할 때 같은 기준을 쓴다.
// 그래서 그 이메일로 쓸 수 있는 링크는 늘 많아야 1개다.
export const revokeUnusedInvitations = (tx: Prisma.TransactionClient, projectId: string, email: string) =>
  tx.invitation.updateMany({
    where: { projectId, email, acceptedAt: null, revokedAt: null },
    data: { revokedAt: new Date() },
  });

@Injectable()
export class InvitationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
    private readonly activity: ActivityService,
    private readonly mail: MailService,
  ) {}

  // email은 입력 검사(DTO)에서 앞뒤 공백을 지우고 소문자로 바꾼 값이다. 로그인 이메일과 그대로 비교할 수 있다.
  async create(projectId: string, userId: string, email: string): Promise<CreatedInvitation> {
    // 메일 속 링크는 서버가 만들어서 서버가 자기 주소를 알아야 한다. 없으면 아무 주소나 쓰지 않고 500으로 끝낸다.
    const appUrl = process.env.APP_URL;
    if (!appUrl) throw new Error('APP_URL이 없어요');

    const token = createSessionToken();
    const created = await this.prisma.$transaction(async (tx) => {
      await this.projects.lockForDeveloper(tx, projectId, userId);

      const activeMember = await tx.projectMember.findFirst({
        where: { projectId, revokedAt: null, user: { email } },
        select: { id: true },
      });
      if (activeMember) throw conflict('ALREADY_MEMBER', '이미 참여한 사람이에요');
      await assertClientSlot(tx, projectId);

      await revokeUnusedInvitations(tx, projectId, email);
      // 7일 만료는 서버 시계가 아니라 DB 시계로 정한다. 확인할 때도 DB 시계로 비교한다.
      const [invitation] = await tx.$queryRaw<{ expires_at: Date }[]>`
        INSERT INTO invitations (project_id, email, token_hash, invited_by_id, expires_at)
        VALUES (${projectId}::uuid, ${email}, ${hashSessionToken(token)}, ${userId}::uuid, now() + interval '7 days')
        RETURNING expires_at
      `;
      await this.activity.record(tx, { projectId, actorId: userId, type: ActivityType.INVITATION_CREATED });

      // 메일에 넣을 프로젝트 이름과 초대한 사람 이름을 개발자 멤버 줄에서 한 번에 읽는다.
      const { project, user } = await tx.projectMember.findUniqueOrThrow({
        where: { projectId_userId: { projectId, userId } },
        select: { project: { select: { name: true } }, user: { select: { name: true } } },
      });
      return { expiresAt: invitation.expires_at, projectName: project.name, inviterName: user.name };
    });

    const link = `${appUrl}/app/invite/${token}`;
    // 메일은 커밋한 뒤에 보낸다. 저장이 되돌려졌는데 쓸 수 없는 링크가 가지 않게 하려는 것이다.
    this.mail.sendInvitation(email, link, created.projectName, created.inviterName);
    return { email, expiresAt: created.expiresAt, link };
  }

  // 로그인 없이 링크만으로 연다. 프로젝트 이름, 초대한 사람, 초대받은 이메일, 상태만 준다.
  async preview(token: string): Promise<InvitationPreview> {
    const [found] = await this.prisma.$queryRaw<
      {
        email: string;
        accepted: boolean;
        revoked: boolean;
        expired: boolean;
        project_name: string;
        inviter_name: string;
        project_deleted: boolean;
      }[]
    >`
      SELECT i.email, i.accepted_at IS NOT NULL AS accepted, i.revoked_at IS NOT NULL AS revoked,
             i.expires_at <= now() AS expired, p.name AS project_name, u.name AS inviter_name,
             p.status = 'DELETE_PENDING' AS project_deleted
      FROM invitations i
      JOIN projects p ON p.id = i.project_id
      JOIN users u ON u.id = i.invited_by_id
      WHERE i.token_hash = ${hashSessionToken(token)}
    `;
    // 지운(삭제 대기) 프로젝트의 초대는 없는 초대와 같다. 그 프로젝트는 클라이언트에게 404다.
    if (!found || found.revoked || found.project_deleted) throw invitationNotFound();

    // 수락한 사람이 메일 속 링크를 다시 눌러도 헷갈리지 않게, 수락된 초대는 만료와 상관없이 상태로 알려 준다.
    if (!found.accepted && found.expired) throw invitationExpired();
    return {
      projectName: found.project_name,
      inviterName: found.inviter_name,
      email: found.email,
      status: found.accepted ? 'ACCEPTED' : 'PENDING',
    };
  }

  async accept(token: string, user: { id: string; email: string }): Promise<{ projectId: string }> {
    // 잠글 프로젝트를 알려고 잠그기 전에 한 번 찾는다. 상태는 잠근 뒤에 다시 본다.
    const found = await this.prisma.invitation.findUnique({
      where: { tokenHash: hashSessionToken(token) },
      select: { id: true, projectId: true },
    });
    if (!found) throw invitationNotFound();
    const { projectId } = found;

    return this.prisma.$transaction(async (tx) => {
      const projectStatus = await this.projects.lockProject(tx, projectId);

      // 잠근 뒤의 상태로 판단한다. 같은 링크로 동시에 두 번 수락하면 두 번째는 여기서 수락된 초대를 본다.
      // 만료는 clock_timestamp()로 본다. now()는 트랜잭션을 시작한 시각이라, 잠금을 기다리는 동안 만료된 초대를 놓친다.
      const [invitation] = await tx.$queryRaw<
        { email: string; accepted: boolean; revoked: boolean; expired: boolean }[]
      >`
        SELECT email, accepted_at IS NOT NULL AS accepted, revoked_at IS NOT NULL AS revoked,
               expires_at <= clock_timestamp() AS expired
        FROM invitations WHERE id = ${found.id}::uuid
      `;
      if (invitation.accepted || invitation.revoked || projectStatus === ProjectStatus.DELETE_PENDING) {
        throw invitationNotFound();
      }
      if (invitation.expired) throw invitationExpired();
      if (invitation.email !== user.email) {
        throw new ForbiddenException({
          statusCode: HttpStatus.FORBIDDEN,
          message: '초대받은 이메일로 로그인해 주세요',
          code: 'EMAIL_MISMATCH',
        });
      }

      const existing = await tx.projectMember.findUnique({
        where: { projectId_userId: { projectId, userId: user.id } },
        select: { id: true, revokedAt: true },
      });
      if (existing && !existing.revokedAt) throw conflict('ALREADY_MEMBER', '이미 참여한 프로젝트예요');
      // 보관한 프로젝트에는 새로 들어올 수 없다. 보관을 풀고 다시 수락한다.
      assertWritable(projectStatus);
      await assertClientSlot(tx, projectId);

      // 마지막 방어: 쓰지 않은 초대일 때만 수락으로 바꾼다.
      const used = await tx.$executeRaw`
        UPDATE invitations SET accepted_at = now()
        WHERE id = ${found.id}::uuid AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > clock_timestamp()
      `;
      if (used === 0) throw invitationNotFound();

      // 철회됐던 사람은 예전 멤버 줄을 되살린다. 예전 쪽지·댓글이 그대로 그 사람 것으로 남는다.
      // 승인자로는 돌아오지 않는다(철회할 때 비웠다).
      const member = await tx.projectMember.upsert({
        where: { projectId_userId: { projectId, userId: user.id } },
        update: { revokedAt: null },
        create: { projectId, userId: user.id, role: ProjectRole.CLIENT },
        select: { id: true },
      });
      await this.activity.record(tx, {
        projectId,
        actorId: user.id,
        type: ActivityType.INVITATION_ACCEPTED,
        memberId: member.id,
      });
      return { projectId };
    });
  }
}
