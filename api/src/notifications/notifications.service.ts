import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ActivityType, type Prisma, ProjectRole } from '../generated/prisma/client.js';
import { MailService } from '../mail/mail.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { buildNotificationMessage, RECORD_TYPES } from './notification-message.js';

// 우편함에 넣을 때 필요한 사건 칸. ActivityService.record가 사건 줄을 쓴 직후 넘긴다.
export type EnqueuedEvent = {
  id: string;
  projectId: string;
  type: ActivityType;
  issueId?: string;
};

// 보내기 직전에 잡은 줄. leaseUntil은 "내가 잡았다"는 표시라, 결과를 적을 때 이 값이 그대로인지 본다.
type LeasedDelivery = { id: string; eventId: string; toEmail: string; attempts: number; leaseUntil: Date };

const TICK_MS = 10_000;
// 한 번 돌 때 보내는 최대 통수. 나머지는 다음 반복이 보낸다.
const BATCH_SIZE = 20;
// 다섯 번째 실패에서 FAILED가 된다. 마이그레이션의 CHECK(attempts 0~5)와 같은 값이다.
const MAX_ATTEMPTS = 5;

// 보내는 일(work)이 ms 안에 끝나지 않으면 실패로 끝낸다. nodemailer는 보내던 메일을 중간에 끊지 못해서,
// 늦게 끝난 결과는 버린다(then의 두 번째 함수가 이미 끝난 Promise에 다시 닿아도 아무 일도 없다).
const withinLimit = (work: Promise<void>, ms: number) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('메일 발송 한도를 넘겼어요')), ms);
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });

// 고쳤어요는 그 쪽지를 확인할 사람에게 간다: 쓴 사람이 활성 클라이언트면 그 사람,
// 아니면(개발자가 쓴 쪽지, 쓴 사람이 철회됨) 승인자. 승인자는 철회되면 비워지므로 있으면 활성이다.
const reviewerEmail = async (tx: Prisma.TransactionClient, projectId: string, issueId: string) => {
  const issue = await tx.issue.findUniqueOrThrow({
    where: { id: issueId },
    select: {
      authorId: true,
      project: { select: { approver: { select: { user: { select: { email: true } } } } } },
    },
  });
  const author = await tx.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId: issue.authorId } },
    select: { role: true, revokedAt: true, user: { select: { email: true } } },
  });
  if (author?.role === ProjectRole.CLIENT && !author.revokedAt) return [author.user.email];
  const approver = issue.project.approver;
  return approver ? [approver.user.email] : [];
};

// 받는 사람 규칙은 여기 한 곳에 둔다(docs/mail.md 정할 것 6). 목록에 없는 사건은 메일이 없다.
const recipients = async (tx: Prisma.TransactionClient, event: EnqueuedEvent): Promise<string[]> => {
  if (event.type === ActivityType.VERSION_PUBLISHED) {
    const clients = await tx.projectMember.findMany({
      where: { projectId: event.projectId, role: ProjectRole.CLIENT, revokedAt: null },
      select: { user: { select: { email: true } } },
    });
    return clients.map(({ user }) => user.email);
  }
  if (event.type === ActivityType.RESOLUTION_SUBMITTED && event.issueId) {
    return reviewerEmail(tx, event.projectId, event.issueId);
  }
  const toDeveloper: ActivityType[] = [ActivityType.VERSION_APPROVED, ...RECORD_TYPES];
  if (!toDeveloper.includes(event.type)) return [];
  const developer = await tx.projectMember.findFirst({
    where: { projectId: event.projectId, role: ProjectRole.DEVELOPER },
    select: { user: { select: { email: true } } },
  });
  return developer ? [developer.user.email] : [];
};

// 사건과 같은 트랜잭션에서 받는 사람마다 한 줄을 넣는다. 그 일이 되돌려지면 줄도 남지 않는다.
// 같은 사람이 두 역할이어도 (사건, 주소) 유니크 제약과 skipDuplicates로 한 줄이다.
export const enqueueNotifications = async (tx: Prisma.TransactionClient, event: EnqueuedEvent) => {
  const emails = await recipients(tx, event);
  if (emails.length === 0) return;
  await tx.notificationDelivery.createMany({
    data: emails.map((toEmail) => ({ eventId: event.id, toEmail })),
    skipDuplicates: true,
  });
};

// 실패 원인 글. nodemailer 오류의 message에는 SMTP 서버 응답 원문이 붙어 메일 내용이 섞일 수 있어서,
// 코드가 있는 오류(nodemailer, 네트워크, Prisma)는 코드만 남긴다. 코드가 없는 것은 이 파일이 만든 글이다.
const failureCause = (error: unknown) => {
  if (!(error instanceof Error)) return String(error);
  const { code, responseCode } = error as { code?: unknown; responseCode?: unknown };
  if (code === undefined) return error.message;
  if (responseCode === undefined) return `오류 코드 ${String(code)}`;
  return `오류 코드 ${String(code)}(SMTP ${String(responseCode)})`;
};

@Injectable()
export class NotificationsService implements OnModuleDestroy {
  private readonly logger = new Logger(NotificationsService.name);
  // 한 통 전체 한도(docs/mail.md 정할 것 13). 임대(5분)보다 짧아야 한다. 테스트가 짧게 바꿔 끝나지 않는 발송을 흉내 낸다.
  sendLimitMs = 60_000;
  private running = false;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
  ) {}

  // main.ts가 앱을 켠 뒤 부른다. api e2e는 앱을 직접 만들어서 이 반복이 돌지 않고, processDue를 직접 부른다.
  start() {
    this.timer = setInterval(() => {
      this.processDue().catch((error: unknown) => {
        // DB가 잠깐 끊겨도 반복은 이어 간다. 다음 반복이 같은 줄을 다시 고른다.
        this.logger.error(
          `알림 메일 반복 작업이 실패했어요: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, TICK_MS);
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  // 보낼 때가 된 줄을 한 줄씩 잡아 보낸다. 앞의 반복이 아직 돌고 있으면 이번 반복은 건너뛴다.
  async processDue() {
    if (this.running) return;
    this.running = true;
    try {
      for (let attempted = 0; attempted < BATCH_SIZE; attempted += 1) {
        const delivery = await this.leaseNext();
        if (!delivery) return;
        await this.deliver(delivery);
      }
    } finally {
      this.running = false;
    }
  }

  // 보낼 때가 된 PENDING 줄 하나를 잡고, 같은 문장에서 다음 시각을 5분 뒤로 미룬다(임대).
  // SKIP LOCKED라서 다른 작업자가 잡고 있는 줄은 건너뛴다. 임대 시각은 밀리초로 잘라서,
  // JS Date로 읽어 결과를 적을 때 그대로 비교할 수 있다(Date는 마이크로초를 모른다).
  private async leaseNext(): Promise<LeasedDelivery | undefined> {
    const [delivery] = await this.prisma.$queryRaw<LeasedDelivery[]>`
      UPDATE notification_deliveries
      SET next_attempt_at = date_trunc('milliseconds', now() + interval '5 minutes')
      WHERE id = (
        SELECT id FROM notification_deliveries
        WHERE status = 'PENDING' AND next_attempt_at <= now()
        ORDER BY next_attempt_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, event_id AS "eventId", to_email AS "toEmail", attempts, next_attempt_at AS "leaseUntil"
    `;
    return delivery;
  }

  private async deliver(delivery: LeasedDelivery) {
    try {
      const appUrl = process.env.APP_URL;
      if (!appUrl) throw new Error('APP_URL이 없어요');
      const message = buildNotificationMessage(await this.loadEvent(delivery.eventId), appUrl);
      await withinLimit(this.mail.send({ to: delivery.toEmail, ...message }), this.sendLimitMs);
    } catch (error) {
      // 원인(APP_URL 빠짐, SMTP 인증 실패 등)을 남겨야 다섯 번 실패하기 전에 고칠 수 있다.
      this.logger.warn(
        `알림 메일을 보내지 못했어요(${delivery.attempts + 1}번째) → ${delivery.toEmail}: ${failureCause(error)}`,
      );
      await this.recordFailure(delivery);
      return;
    }
    await this.recordSent(delivery);
  }

  private async loadEvent(eventId: string) {
    const event = await this.prisma.activityEvent.findUniqueOrThrow({
      where: { id: eventId },
      select: {
        type: true,
        createdAt: true,
        projectId: true,
        memberId: true,
        project: { select: { name: true } },
        version: { select: { id: true, number: true } },
        issue: { select: { id: true, number: true, title: true } },
      },
    });
    const { project, ...rest } = event;
    return { ...rest, projectName: project.name };
  }

  // 결과는 내가 잡은 임대가 그대로일 때만 적는다. 임대가 끝나 다른 작업자가 다시 잡았으면 늦게 끝난 결과는 버린다.
  private async recordSent({ id, leaseUntil }: LeasedDelivery) {
    await this.prisma.$executeRaw`
      UPDATE notification_deliveries SET status = 'SENT', sent_at = clock_timestamp()
      WHERE id = ${id}::uuid AND status = 'PENDING' AND next_attempt_at = ${leaseUntil}::timestamptz
    `;
  }

  // 1분 뒤 다시 보낸다. 다섯 번째 실패면 FAILED로 끝낸다.
  private async recordFailure({ id, leaseUntil }: LeasedDelivery) {
    await this.prisma.$executeRaw`
      UPDATE notification_deliveries
      SET attempts = attempts + 1,
          status = CASE WHEN attempts + 1 >= ${MAX_ATTEMPTS} THEN 'FAILED'::delivery_status ELSE 'PENDING'::delivery_status END,
          next_attempt_at = clock_timestamp() + interval '1 minute'
      WHERE id = ${id}::uuid AND status = 'PENDING' AND next_attempt_at = ${leaseUntil}::timestamptz
    `;
  }
}
