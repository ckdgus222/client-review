import type { Prisma } from '../src/generated/prisma/client.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { resetDatabase } from './reset-database.js';

const toEmail = 'client@example.com';
const sentAt = new Date('2026-11-13T12:00:00Z');
const missingId = '00000000-0000-4000-8000-000000000001';

describe('알림 우편함 스키마 (e2e)', () => {
  let prisma: PrismaService;
  let projectId: string;
  let eventId: string;
  let eventData: Prisma.ActivityEventUncheckedCreateInput;

  beforeEach(async () => {
    // HTTP와 메일 발송 없이, 다른 api e2e와 같은 테스트 DB와 초기화 함수를 쓴다.
    prisma = new PrismaService();
    await resetDatabase(prisma);
    const developer = await prisma.user.create({ data: { email: 'developer@example.com', name: '개발자' } });
    const project = await prisma.project.create({
      data: {
        name: '메일 스키마 검수 프로젝트',
        members: { create: { userId: developer.id, role: 'DEVELOPER' } },
      },
    });
    projectId = project.id;
    const version = await prisma.deliveryVersion.create({
      data: { projectId, number: 1, status: 'IN_REVIEW', publishedAt: new Date() },
    });
    eventData = { projectId, actorId: developer.id, type: 'VERSION_PUBLISHED', versionId: version.id };
    const event = await prisma.activityEvent.create({ data: eventData });
    eventId = event.id;
  });

  afterEach(async () => {
    await prisma?.$disconnect();
  });

  it('사건과 받는 주소만 넣으면 DB가 PENDING·0회·빈 보낸 시각과 현재 시각을 채운다', async () => {
    const { delivery, now } = await prisma.$transaction(async (tx) => {
      const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
      // ORM이 값을 채우지 않도록 SQL로 필수 칸만 넣어 DB 기본값을 확인한다.
      await tx.$executeRaw`
        INSERT INTO notification_deliveries (event_id, to_email)
        VALUES (${eventId}::uuid, ${toEmail})
      `;
      const delivery = await tx.notificationDelivery.findUniqueOrThrow({
        where: { eventId_toEmail: { eventId, toEmail } },
      });
      return { delivery, now: clock.now };
    });

    expect(delivery).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
      eventId,
      toEmail,
      status: 'PENDING',
      attempts: 0,
      nextAttemptAt: now,
      sentAt: null,
      createdAt: now,
    });
  });

  it.each([
    { status: 'PENDING', attempts: 0, sentAt: null },
    { status: 'PENDING', attempts: 5, sentAt: null },
    { status: 'SENT', attempts: 0, sentAt },
    { status: 'SENT', attempts: 5, sentAt },
    { status: 'FAILED', attempts: 0, sentAt: null },
    { status: 'FAILED', attempts: 5, sentAt: null },
  ] as const)('$status이고 시도 횟수가 $attempts이면 상태에 맞는 보낸 시각을 저장한다', async (data) => {
    const delivery = await prisma.notificationDelivery.create({ data: { eventId, toEmail, ...data } });

    expect(await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).toMatchObject({
      eventId,
      toEmail,
      ...data,
    });
  });

  it.each([-1, 6])('시도 횟수가 %i인 줄은 넣을 수 없다', async (attempts) => {
    await expect(prisma.notificationDelivery.create({ data: { eventId, toEmail, attempts } })).rejects.toThrowError();

    expect(await prisma.notificationDelivery.count()).toBe(0);
  });

  it.each([-1, 6])('저장된 줄의 시도 횟수를 %i로 바꿀 수 없다', async (attempts) => {
    const delivery = await prisma.notificationDelivery.create({ data: { eventId, toEmail } });

    await expect(
      prisma.notificationDelivery.update({ where: { id: delivery.id }, data: { attempts } }),
    ).rejects.toThrowError();

    expect(await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).toEqual(delivery);
  });

  it.each([
    { status: 'SENT', sentAt: null },
    { status: 'PENDING', sentAt },
    { status: 'FAILED', sentAt },
  ] as const)('$status와 보낸 시각이 어긋난 줄은 넣을 수 없다', async (data) => {
    await expect(prisma.notificationDelivery.create({ data: { eventId, toEmail, ...data } })).rejects.toThrowError();

    expect(await prisma.notificationDelivery.count()).toBe(0);
  });

  it.each([
    { status: 'SENT', sentAt: null },
    { status: 'PENDING', sentAt },
    { status: 'FAILED', sentAt },
  ] as const)('저장된 줄도 $status와 보낸 시각이 어긋나게 바꿀 수 없다', async (data) => {
    const delivery = await prisma.notificationDelivery.create({ data: { eventId, toEmail } });

    await expect(prisma.notificationDelivery.update({ where: { id: delivery.id }, data })).rejects.toThrowError();

    expect(await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).toEqual(delivery);
  });

  it('PENDING 줄을 SENT와 보낸 시각으로 함께 바꾸면 저장된다', async () => {
    const delivery = await prisma.notificationDelivery.create({ data: { eventId, toEmail } });

    await prisma.notificationDelivery.update({ where: { id: delivery.id }, data: { status: 'SENT', sentAt } });

    expect(await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).toEqual({
      ...delivery,
      status: 'SENT',
      sentAt,
    });
  });

  it('같은 사건과 받는 주소의 중복은 거절하고 기존 줄을 유지한다', async () => {
    const delivery = await prisma.notificationDelivery.create({ data: { eventId, toEmail } });

    await expect(prisma.notificationDelivery.create({ data: { eventId, toEmail } })).rejects.toMatchObject({
      code: 'P2002',
    });

    expect(await prisma.notificationDelivery.findMany()).toEqual([delivery]);
  });

  it('같은 사건의 다른 주소와 다른 사건의 같은 주소는 각각 저장된다', async () => {
    const otherEvent = await prisma.activityEvent.create({ data: eventData });
    const deliveries = [
      { eventId, toEmail },
      { eventId, toEmail: 'other@example.com' },
      { eventId: otherEvent.id, toEmail },
    ];

    expect(await prisma.notificationDelivery.createMany({ data: deliveries })).toEqual({ count: 3 });

    expect(await prisma.notificationDelivery.findMany({ select: { eventId: true, toEmail: true } })).toEqual(
      expect.arrayContaining(deliveries),
    );
    expect(await prisma.notificationDelivery.count()).toBe(3);
  });

  it('없는 사건을 가리키는 우편함 줄은 넣을 수 없다', async () => {
    await expect(prisma.notificationDelivery.create({ data: { eventId: missingId, toEmail } })).rejects.toMatchObject({
      code: 'P2003',
    });

    expect(await prisma.notificationDelivery.count()).toBe(0);
  });

  it('프로젝트를 지우면 사건과 모든 상태의 우편함 줄도 지워진다', async () => {
    await prisma.notificationDelivery.createMany({
      data: [
        { eventId, toEmail, status: 'PENDING' },
        { eventId, toEmail: 'sent@example.com', status: 'SENT', sentAt },
        { eventId, toEmail: 'failed@example.com', status: 'FAILED', attempts: 5 },
      ],
    });
    expect(await prisma.notificationDelivery.count()).toBe(3);

    await prisma.project.delete({ where: { id: projectId } });

    expect(await prisma.activityEvent.count({ where: { projectId } })).toBe(0);
    expect(await prisma.notificationDelivery.count()).toBe(0);
  });

  it('같은 트랜잭션에서 쓴 두 사건의 시각은 다르고 쓴 순서대로 커진다', async () => {
    const [first, second] = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM projects WHERE id = ${projectId}::uuid FOR UPDATE`;
      const first = await tx.activityEvent.create({ data: eventData });
      // Date의 밀리초 정밀도보다 넓게 띄운다. now() 기본값이면 기다려도 두 시각이 같다.
      await tx.$executeRaw`SELECT pg_sleep(0.02)`;
      const second = await tx.activityEvent.create({ data: eventData });
      return [first, second];
    });

    expect(second.createdAt.getTime()).toBeGreaterThan(first.createdAt.getTime());
    expect(
      await prisma.activityEvent.findMany({
        where: { id: { in: [first.id, second.id] } },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      }),
    ).toEqual([{ id: first.id }, { id: second.id }]);
  });

  it('사건과 우편함을 함께 쓴 트랜잭션이 실패하면 두 줄 모두 남지 않는다', async () => {
    const failure = new Error('업무 저장 실패');
    let rolledBackEventId: string | undefined;

    await expect(
      prisma.$transaction(async (tx) => {
        const event = await tx.activityEvent.create({ data: eventData });
        rolledBackEventId = event.id;
        await tx.notificationDelivery.create({ data: { eventId: event.id, toEmail } });
        throw failure;
      }),
    ).rejects.toThrowError(failure);

    expect(rolledBackEventId).toEqual(expect.any(String));
    expect(await prisma.activityEvent.count({ where: { id: rolledBackEventId } })).toBe(0);
    expect(await prisma.activityEvent.count()).toBe(1);
    expect(await prisma.notificationDelivery.count()).toBe(0);
  });

  it('resetDatabase는 모든 상태의 우편함 줄을 비운다', async () => {
    await prisma.notificationDelivery.createMany({
      data: [
        { eventId, toEmail, status: 'PENDING' },
        { eventId, toEmail: 'sent@example.com', status: 'SENT', sentAt },
        { eventId, toEmail: 'failed@example.com', status: 'FAILED', attempts: 5 },
      ],
    });
    expect(await prisma.notificationDelivery.count()).toBe(3);

    await resetDatabase(prisma);

    expect(await prisma.notificationDelivery.count()).toBe(0);
    expect(await prisma.activityEvent.count()).toBe(0);
  });
});
