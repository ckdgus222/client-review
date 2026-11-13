import type { Prisma } from '../src/generated/prisma/client.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { resetDatabase } from './reset-database.js';

describe('승인 테이블', () => {
  const prisma = new PrismaService();
  const missingId = '00000000-0000-4000-8000-000000000001';
  let approvalData: Prisma.ApprovalUncheckedCreateInput;
  let projectId: string;

  beforeEach(async () => {
    await resetDatabase(prisma);
    const approver = await prisma.user.create({ data: { email: 'approver@example.com', name: '승인자' } });
    const project = await prisma.project.create({ data: { name: '프로젝트' } });
    const version = await prisma.deliveryVersion.create({
      data: { projectId: project.id, status: 'APPROVED', number: 1, publishedAt: new Date() },
    });
    projectId = project.id;
    approvalData = { versionId: version.id, approverId: approver.id, summary: { issues: [] } };
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('UUID와 approved_at은 DB가 만들고 승인 시각은 트랜잭션 시작 뒤의 실제 시각이다', async () => {
    const { versionId, approverId, summary } = approvalData;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_sleep(0.05)`;
      const [row] = await tx.$queryRaw<{ id: string; after_start: boolean; before_read: boolean }[]>`
        INSERT INTO approvals (version_id, approver_id, summary)
        VALUES (${versionId}::uuid, ${approverId}::uuid, ${JSON.stringify(summary)}::jsonb)
        RETURNING id, approved_at > now() AS after_start, approved_at <= clock_timestamp() AS before_read
      `;

      expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      expect(row.after_start).toBe(true);
      expect(row.before_read).toBe(true);
      expect(await tx.approval.findUniqueOrThrow({ where: { id: row.id } })).toEqual({
        ...approvalData, id: row.id, approvedAt: expect.any(Date),
      });
    });
  });

  it.each(['같은 승인자', '다른 승인자'] as const)('%s가 같은 버전에 승인 줄을 두 개 넣으면 거절하고 첫 승인을 보존한다', async (who) => {
    const first = await prisma.approval.create({ data: approvalData });
    const approverId = who === '같은 승인자'
      ? approvalData.approverId
      : (await prisma.user.create({ data: { email: 'other@example.com', name: '다른 승인자' } })).id;

    await expect(prisma.approval.create({ data: { ...approvalData, approverId } })).rejects.toMatchObject({ code: 'P2002' });

    expect(await prisma.approval.findMany()).toEqual([first]);
  });

  it('같은 승인자가 서로 다른 버전을 승인하면 버전마다 승인 줄이 저장된다', async () => {
    const first = await prisma.approval.create({ data: approvalData });
    const version = await prisma.deliveryVersion.create({
      data: { projectId, status: 'APPROVED', number: 2, publishedAt: new Date() },
    });
    const second = await prisma.approval.create({ data: { ...approvalData, versionId: version.id } });

    expect(second.id).not.toBe(first.id);
    expect(await prisma.approval.findUnique({ where: { versionId: first.versionId } })).toEqual(first);
    expect(await prisma.approval.findUnique({ where: { versionId: second.versionId } })).toEqual(second);
    expect(await prisma.approval.count()).toBe(2);
  });

  it.each(['versionId', 'approverId'] as const)('없는 %s를 가리키는 승인 줄은 저장할 수 없다', async (field) => {
    await expect(prisma.approval.create({
      data: { ...approvalData, [field]: missingId },
    })).rejects.toMatchObject({ code: 'P2003' });

    expect(await prisma.approval.count()).toBe(0);
  });

  it('버전을 지우면 그 승인 줄만 함께 지워지고 다른 버전의 승인·프로젝트·사용자는 남는다', async () => {
    await prisma.approval.create({ data: approvalData });
    const otherVersion = await prisma.deliveryVersion.create({
      data: { projectId, status: 'APPROVED', number: 2, publishedAt: new Date() },
    });
    const remaining = await prisma.approval.create({ data: { ...approvalData, versionId: otherVersion.id } });

    await prisma.deliveryVersion.delete({ where: { id: approvalData.versionId } });

    expect(await prisma.approval.findMany()).toEqual([remaining]);
    expect(await prisma.deliveryVersion.findMany()).toEqual([otherVersion]);
    expect(await prisma.project.count()).toBe(1);
    expect(await prisma.user.count()).toBe(1);
  });

  it('승인이 있는 프로젝트를 DB에서 지우면 승인 줄도 함께 지워진다', async () => {
    await prisma.approval.create({ data: approvalData });
    await prisma.project.update({ where: { id: projectId }, data: { currentVersionId: approvalData.versionId } });
    await prisma.activityEvent.create({
      data: { projectId, actorId: approvalData.approverId, type: 'VERSION_APPROVED', versionId: approvalData.versionId },
    });
    const otherProject = await prisma.project.create({ data: { name: '다른 프로젝트' } });
    const otherVersion = await prisma.deliveryVersion.create({
      data: { projectId: otherProject.id, status: 'APPROVED', number: 1, publishedAt: new Date() },
    });
    const remaining = await prisma.approval.create({ data: { ...approvalData, versionId: otherVersion.id } });

    await prisma.$executeRaw`DELETE FROM projects WHERE id = ${projectId}::uuid`;

    expect(await prisma.approval.findMany()).toEqual([remaining]);
    expect(await prisma.project.findMany()).toEqual([otherProject]);
    expect(await prisma.deliveryVersion.findMany()).toEqual([otherVersion]);
    expect(await prisma.activityEvent.count()).toBe(0);
    expect(await prisma.user.count()).toBe(1);
  });

  it('승인자 사용자는 RESTRICT로 지울 수 없고 사용자와 승인 줄은 그대로다', async () => {
    const approval = await prisma.approval.create({ data: approvalData });
    const user = await prisma.user.findUniqueOrThrow({ where: { id: approvalData.approverId } });

    // 멤버·쪽지·일지와 연결하지 않아 승인 외래키만 삭제를 막는지 확인한다.
    await expect(prisma.$executeRaw`DELETE FROM users WHERE id = ${user.id}::uuid`).rejects.toMatchObject({
      code: 'P2010', message: expect.stringContaining('23503'),
    });

    expect(await prisma.user.findUnique({ where: { id: user.id } })).toEqual(user);
    expect(await prisma.approval.findMany()).toEqual([approval]);
  });

  it.each([
    { name: '쪽지가 없는 목록', summary: { issues: [] } },
    {
      name: '번호·제목·분류·범위·상태가 있는 목록',
      summary: {
        issues: [
          { number: 1, title: '버튼의 "색상" 수정\n완료 ✓', category: 'DESIGN', scope: 'IN_SCOPE', status: 'VERIFIED' },
          { number: 2, title: '검색 추가 요청', category: 'OTHER', scope: 'OUT_OF_SCOPE', status: 'OPEN' },
        ],
      },
    },
  ])('summary에 $name을 JSONB로 저장하고 그대로 읽는다', async ({ summary }) => {
    const approval = await prisma.approval.create({ data: { ...approvalData, summary } });

    expect(await prisma.approval.findUniqueOrThrow({ where: { id: approval.id } })).toEqual({
      ...approvalData, summary, id: approval.id, approvedAt: expect.any(Date),
    });
    const [row] = await prisma.$queryRaw<{ summary: Prisma.JsonValue; type: string }[]>`
      SELECT summary, pg_typeof(summary)::text AS type FROM approvals WHERE id = ${approval.id}::uuid
    `;
    expect(row).toEqual({ summary, type: 'jsonb' });
  });

  it('일지 사건 VERSION_APPROVED와 승인자·버전이 저장된다', async () => {
    await prisma.approval.create({ data: approvalData });
    const data = { projectId, actorId: approvalData.approverId, type: 'VERSION_APPROVED' as const, versionId: approvalData.versionId };
    const event = await prisma.activityEvent.create({ data });

    expect(await prisma.activityEvent.findMany()).toEqual([
      { ...data, id: event.id, memberId: null, issueId: null, createdAt: expect.any(Date) },
    ]);
  });

  it('resetDatabase는 승인 줄과 연결된 표도 비우고 다시 실행할 수 있다', async () => {
    await prisma.approval.create({ data: approvalData });
    await prisma.activityEvent.create({
      data: { projectId, actorId: approvalData.approverId, type: 'VERSION_APPROVED', versionId: approvalData.versionId },
    });

    await resetDatabase(prisma);

    expect(await prisma.approval.count()).toBe(0);
    expect(await prisma.activityEvent.count()).toBe(0);
    expect(await prisma.deliveryVersion.count()).toBe(0);
    expect(await prisma.project.count()).toBe(0);
    expect(await prisma.user.count()).toBe(0);
    await resetDatabase(prisma);
    expect(await prisma.approval.count()).toBe(0);
  });
});
