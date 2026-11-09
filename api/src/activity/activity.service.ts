import { Injectable } from '@nestjs/common';
import type { ActivityType, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProjectsService } from '../projects/projects.service.js';

export type ActivityView = {
  id: string;
  type: ActivityType;
  createdAt: Date;
  actorName: string;
  version: { id: string; number: number | null } | null;
};

type ActivityEventInput = { projectId: string; actorId: string; type: ActivityType; versionId?: string };

@Injectable()
export class ActivityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
  ) {}

  // 사건을 일으킨 일(게시 등)의 트랜잭션 tx 안에서 쓴다. 그 일이 되돌려지면 사건 줄도 남지 않는다.
  // 일지를 쓰는 곳을 여기 하나로 모은다. 사건 종류가 늘어도 쓰는 방식은 같다.
  async record(tx: Prisma.TransactionClient, event: ActivityEventInput) {
    await tx.activityEvent.create({ data: event });
  }

  async listForMember(projectId: string, userId: string): Promise<ActivityView[]> {
    await this.projects.requireMemberRole(projectId, userId);
    const events = await this.prisma.activityEvent.findMany({
      where: { projectId },
      select: {
        id: true,
        type: true,
        createdAt: true,
        actor: { select: { name: true } },
        version: { select: { id: true, number: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return events.map(({ actor, ...event }) => ({ ...event, actorName: actor.name }));
  }
}
