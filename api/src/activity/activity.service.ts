import { Injectable } from '@nestjs/common';
import { type ActivityType, DeliveryStatus, type Prisma, ProjectRole } from '../generated/prisma/client.js';
import { enqueueNotifications } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProjectsService } from '../projects/projects.service.js';

export type ActivityView = {
  id: string;
  type: ActivityType;
  createdAt: Date;
  actorName: string;
  version: { id: string; number: number | null } | null;
  // 초대 수락·접근 철회·승인자 변경의 대상 사람. 대상이 없는 사건(게시, 초대)은 null이다.
  memberName: string | null;
  // 쪽지 작성·수정 시작의 대상 쪽지. 화면이 "쪽지 #14"로 보여 주고, 누르면 그 쪽지로 간다.
  issue: { id: string; number: number } | null;
  // 다섯 번 실패해 FAILED가 된 알림 메일의 받는 주소(주소 순). 개발자에게만 채우고 클라이언트에게는 늘 빈 목록이다.
  // 클라이언트에게 다른 사람의 이메일을 보이지 않으려는 것이다. 개발자는 참여자 목록에서 이미 이메일을 본다.
  mailFailedTo: string[];
};

type ActivityEventInput = {
  projectId: string;
  actorId: string;
  type: ActivityType;
  versionId?: string;
  memberId?: string;
  issueId?: string;
};

@Injectable()
export class ActivityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
  ) {}

  // 사건을 일으킨 일(게시 등)의 트랜잭션 tx 안에서 쓴다. 그 일이 되돌려지면 사건 줄도, 알림 메일 우편함 줄도 남지 않는다.
  // 일지를 쓰는 곳을 여기 하나로 모은다. 사건 종류가 늘어도 쓰는 방식은 같다.
  async record(tx: Prisma.TransactionClient, event: ActivityEventInput) {
    const { id } = await tx.activityEvent.create({ data: event, select: { id: true } });
    await enqueueNotifications(tx, { ...event, id });
  }

  async listForMember(projectId: string, userId: string): Promise<ActivityView[]> {
    const role = await this.projects.requireMemberRole(projectId, userId);
    const isDeveloper = role === ProjectRole.DEVELOPER;
    const events = await this.prisma.activityEvent.findMany({
      where: { projectId },
      select: {
        id: true,
        type: true,
        createdAt: true,
        actor: { select: { name: true } },
        version: { select: { id: true, number: true } },
        member: { select: { user: { select: { name: true } } } },
        issue: { select: { id: true, number: true } },
        // 클라이언트에게는 실패 줄을 읽지도 않는다(take 0).
        deliveries: {
          where: { status: DeliveryStatus.FAILED },
          select: { toEmail: true },
          orderBy: { toEmail: 'asc' },
          take: isDeveloper ? undefined : 0,
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    return events.map(({ actor, member, deliveries, ...event }) => ({
      ...event,
      actorName: actor.name,
      memberName: member?.user.name ?? null,
      mailFailedTo: deliveries.map(({ toEmail }) => toEmail),
    }));
  }
}
