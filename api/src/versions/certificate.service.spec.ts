import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { resetDatabase } from '../../test/reset-database.js';
import { ActivityService } from '../activity/activity.service.js';
import type { DeliveryVersion, Prisma, User } from '../generated/prisma/client.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { ApprovalService } from './approval.service.js';
import { CertificateService } from './certificate.service.js';
import { VersionsService } from './versions.service.js';

const missingId = '00000000-0000-4000-8000-000000000001';
const notFound = {
  status: 404,
  response: { statusCode: 404, message: '없는 확인서예요', error: 'Not Found' },
};

describe('CertificateService', () => {
  let module: TestingModule | undefined;
  let prisma: PrismaService;
  let service: CertificateService;
  let approvals: ApprovalService;
  let projects: ProjectsService;
  let developer: User;
  let approver: User;
  let client: User;
  let outsider: User;
  let projectId: string;
  let approverMemberId: string;
  let clientMemberId: string;
  let current: DeliveryVersion;

  const createIssue = async (data: Partial<Prisma.IssueUncheckedCreateInput> = {}) =>
    prisma.issue.create({
      data: {
        projectId,
        originVersionId: current.id,
        authorId: client.id,
        requestId: randomUUID(),
        number: (await prisma.issue.count({ where: { projectId } })) + 1,
        title: '버튼 색 수정',
        body: '버튼 색을 확인해 주세요',
        category: 'BUG',
        scope: 'IN_SCOPE',
        status: 'VERIFIED',
        ...data,
      },
    });

  const approve = async () => {
    const { serverTime } = await approvals.check(current.id, approver.id);
    await approvals.approve(current.id, approver.id, serverTime);
    return prisma.approval.findUniqueOrThrow({ where: { versionId: current.id } });
  };

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [CertificateService, ApprovalService, VersionsService, ActivityService, ProjectsService],
    }).compile();
    prisma = module.get(PrismaService);
    service = module.get(CertificateService);
    approvals = module.get(ApprovalService);
    projects = module.get(ProjectsService);
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    developer = await prisma.user.create({ data: { email: 'developer@example.com', name: '김개발' } });
    approver = await prisma.user.create({ data: { email: 'approver@example.com', name: '홍승인' } });
    client = await prisma.user.create({ data: { email: 'client@example.com', name: '이클라이언트' } });
    outsider = await prisma.user.create({ data: { email: 'outsider@example.com', name: '외부인' } });
    const project = await prisma.project.create({
      data: {
        name: '쇼핑몰 리뉴얼',
        members: {
          create: [
            { userId: client.id, role: 'CLIENT' },
            { userId: approver.id, role: 'CLIENT' },
            { userId: developer.id, role: 'DEVELOPER' },
          ],
        },
      },
      include: { members: true },
    });
    projectId = project.id;
    approverMemberId = project.members.find(({ userId }) => userId === approver.id)!.id;
    clientMemberId = project.members.find(({ userId }) => userId === client.id)!.id;
    current = await prisma.deliveryVersion.create({
      data: { projectId, number: 2, status: 'IN_REVIEW', publishedAt: new Date('2026-11-10T01:00:00.000Z') },
    });
    await prisma.project.update({
      where: { id: projectId },
      data: { approverMemberId, currentVersionId: current.id },
    });
    const firstScreen = await prisma.screen.create({
      data: { projectId, name: '홈', viewport: 'PC', createdAt: new Date('2026-11-01T00:00:00.000Z') },
    });
    const secondScreen = await prisma.screen.create({
      data: { projectId, name: '결제', viewport: 'MOBILE', createdAt: new Date('2026-11-02T00:00:00.000Z') },
    });
    const asset = await prisma.asset.create({
      data: {
        projectId,
        storageKey: `${projectId}/${randomUUID()}.png`,
        mime: 'image/png',
        bytes: 100,
        width: 1200,
        height: 800,
      },
    });
    // 화면을 만든 순서, 이름 순서, 버전에 붙인 순서를 서로 다르게 둔다.
    await prisma.versionScreen.create({
      data: {
        versionId: current.id,
        screenId: secondScreen.id,
        assetId: asset.id,
        createdAt: new Date('2026-11-03T00:00:00.000Z'),
      },
    });
    await prisma.versionScreen.create({
      data: {
        versionId: current.id,
        screenId: firstScreen.id,
        assetId: asset.id,
        createdAt: new Date('2026-11-04T00:00:00.000Z'),
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await module?.close();
  });

  it('개발자, 승인자, 다른 클라이언트 모두 같은 확인서를 받는다', async () => {
    await createIssue();
    const approval = await approve();
    const expected = {
      certificateNumber: approval.id,
      project: { id: projectId, name: '쇼핑몰 리뉴얼' },
      version: { id: current.id, number: 2, publishedAt: current.publishedAt },
      approval: { approverName: '홍승인', approvedAt: approval.approvedAt },
      developerName: '김개발',
      screens: [
        { name: '홈', viewport: 'PC' },
        { name: '결제', viewport: 'MOBILE' },
      ],
      counts: { verified: 1, withdrawn: 0, outOfScope: 0 },
      issues: [{ number: 1, title: '버튼 색 수정', category: 'BUG', scope: 'IN_SCOPE', status: 'VERIFIED' }],
    };

    for (const user of [developer, approver, client]) {
      expect(await service.get(current.id, user.id)).toStrictEqual(expected);
    }
    expect(await prisma.approval.findUniqueOrThrow({ where: { id: approval.id } })).toEqual(approval);
  });

  it('멤버가 아닌 사람에게는 404다', async () => {
    await approve();
    await expect(service.get(current.id, outsider.id)).rejects.toMatchObject(notFound);
  });

  it('접근이 철회된 클라이언트에게는 404다', async () => {
    await approve();
    await prisma.projectMember.update({ where: { id: clientMemberId }, data: { revokedAt: new Date() } });
    await expect(service.get(current.id, client.id)).rejects.toMatchObject(notFound);
  });

  it('다른 프로젝트의 멤버는 그 프로젝트의 확인서를 못 본다', async () => {
    await approve();
    await prisma.project.create({
      data: { name: '다른 프로젝트', members: { create: { userId: outsider.id, role: 'DEVELOPER' } } },
    });
    await expect(service.get(current.id, outsider.id)).rejects.toMatchObject(notFound);
  });

  it('없는 버전은 같은 문구의 404이고 멤버 검사를 하지 않는다', async () => {
    const membership = vi.spyOn(projects, 'requireMemberRole');
    await expect(service.get(missingId, developer.id)).rejects.toMatchObject(notFound);
    expect(membership).not.toHaveBeenCalled();
  });

  it('검수 중인 버전의 확인서는 404다', async () => {
    const membership = vi.spyOn(projects, 'requireMemberRole');
    for (const user of [developer, approver, client, outsider]) {
      await expect(service.get(current.id, user.id)).rejects.toMatchObject(notFound);
      expect(membership).toHaveBeenLastCalledWith(projectId, user.id);
    }
  });

  it('게시 전 버전의 확인서는 개발자에게도 404다', async () => {
    const draft = await prisma.deliveryVersion.create({ data: { projectId } });
    const membership = vi.spyOn(projects, 'requireMemberRole');
    for (const user of [developer, approver, client, outsider]) {
      await expect(service.get(draft.id, user.id)).rejects.toMatchObject(notFound);
      expect(membership).toHaveBeenLastCalledWith(projectId, user.id);
    }
  });

  it('승인 상태여도 승인 줄이 없으면 같은 문구의 404다', async () => {
    const approval = await approve();
    // 정상 승인 뒤 승인 줄만 없어진 경우에도 확인서를 만들지 않는지 확인한다.
    await prisma.approval.delete({ where: { id: approval.id } });
    await expect(service.get(current.id, developer.id)).rejects.toMatchObject(notFound);
  });

  it('멤버 검사에서 발생한 404 이외의 오류는 그대로 전달한다', async () => {
    await approve();
    const error = new Error('멤버 조회 실패');
    vi.spyOn(projects, 'requireMemberRole').mockRejectedValueOnce(error);
    await expect(service.get(current.id, developer.id)).rejects.toBe(error);
  });

  it('쪽지 수는 범위 안의 확인 완료와 철회, 범위 밖을 따로 센다', async () => {
    await createIssue({ status: 'VERIFIED' });
    await createIssue({ status: 'VERIFIED' });
    await createIssue({ status: 'WITHDRAWN' });
    for (const status of ['OPEN', 'IN_PROGRESS', 'READY_FOR_REVIEW', 'VERIFIED', 'WITHDRAWN'] as const) {
      await createIssue({ scope: 'OUT_OF_SCOPE', status });
    }
    const approval = await approve();

    const certificate = await service.get(current.id, developer.id);
    expect(certificate.counts).toStrictEqual({ verified: 2, withdrawn: 1, outOfScope: 5 });
    expect(certificate.issues).toHaveLength(8);
    expect(approval.summary).toEqual({ issues: certificate.issues });
  });

  it('쪽지 없이 승인된 버전은 수가 모두 0이고 목록이 비어 있다', async () => {
    await approve();
    const certificate = await service.get(current.id, client.id);
    expect(certificate.counts).toStrictEqual({ verified: 0, withdrawn: 0, outOfScope: 0 });
    expect(certificate.issues).toStrictEqual([]);
  });

  it('승인 뒤 다음 버전에서 쪽지를 다시 열고 범위를 바꿔도 확인서의 쪽지 목록과 수는 그대로다', async () => {
    const issue = await createIssue();
    await createIssue({ status: 'WITHDRAWN', title: '철회한 문구', category: 'COPY' });
    await approve();
    const before = await service.get(current.id, client.id);
    const next = await prisma.deliveryVersion.create({
      data: { projectId, number: 3, status: 'IN_REVIEW', publishedAt: new Date() },
    });
    await prisma.project.update({ where: { id: projectId }, data: { currentVersionId: next.id } });
    await prisma.issue.update({
      where: { id: issue.id },
      data: { status: 'OPEN', title: '다시 열린 추가 요청', category: 'DESIGN', scope: 'OUT_OF_SCOPE' },
    });
    await createIssue({ originVersionId: next.id, title: '다음 버전에서 생긴 쪽지', status: 'OPEN' });

    const certificate = await service.get(current.id, client.id);
    expect(certificate).toStrictEqual(before);
    expect(certificate.counts).toStrictEqual({ verified: 1, withdrawn: 1, outOfScope: 0 });
    expect(certificate.issues).toStrictEqual([
      { number: 1, title: '버튼 색 수정', category: 'BUG', scope: 'IN_SCOPE', status: 'VERIFIED' },
      { number: 2, title: '철회한 문구', category: 'COPY', scope: 'IN_SCOPE', status: 'WITHDRAWN' },
    ]);
  });

  it('승인자가 그 뒤 철회돼도 확인서에 승인자 이름이 남는다', async () => {
    await approve();
    const before = await service.get(current.id, developer.id);
    await prisma.project.update({ where: { id: projectId }, data: { approverMemberId: clientMemberId } });
    await prisma.projectMember.update({ where: { id: approverMemberId }, data: { revokedAt: new Date() } });

    expect(await service.get(current.id, developer.id)).toStrictEqual(before);
    expect(await service.get(current.id, client.id)).toStrictEqual(before);
    await expect(service.get(current.id, approver.id)).rejects.toMatchObject(notFound);
  });

  it('화면은 만든 순서로 나오고 그 버전에 없는 화면은 포함하지 않는다', async () => {
    await prisma.screen.create({
      data: { projectId, name: '미포함 화면', viewport: 'PC', createdAt: new Date('2026-10-01T00:00:00.000Z') },
    });
    await approve();
    const certificate = await service.get(current.id, developer.id);
    expect(certificate.screens).toStrictEqual([
      { name: '홈', viewport: 'PC' },
      { name: '결제', viewport: 'MOBILE' },
    ]);
  });

  it('쪽지 목록은 범위를 섞은 채 승인 당시의 번호 순서와 내용을 그대로 준다', async () => {
    await createIssue({
      number: 3,
      category: 'OTHER',
      title: '<b>추가 요청</b>',
      scope: 'OUT_OF_SCOPE',
      status: 'OPEN',
    });
    await createIssue({ number: 1, category: 'DESIGN', title: '첫 번째 쪽지' });
    await createIssue({
      number: 2,
      category: 'COPY',
      title: '두 번째 쪽지',
      scope: 'OUT_OF_SCOPE',
      status: 'WITHDRAWN',
    });
    const approval = await approve();

    const certificate = await service.get(current.id, developer.id);
    expect(certificate.issues).toStrictEqual([
      { number: 1, title: '첫 번째 쪽지', category: 'DESIGN', scope: 'IN_SCOPE', status: 'VERIFIED' },
      { number: 2, title: '두 번째 쪽지', category: 'COPY', scope: 'OUT_OF_SCOPE', status: 'WITHDRAWN' },
      { number: 3, title: '<b>추가 요청</b>', category: 'OTHER', scope: 'OUT_OF_SCOPE', status: 'OPEN' },
    ]);
    expect(approval.summary).toEqual({ issues: certificate.issues });
  });

  it('응답에는 정해진 칸만 있고 이메일과 사진 주소가 없다', async () => {
    const issue = await createIssue();
    await prisma.comment.create({
      data: { issueId: issue.id, authorId: client.id, versionId: current.id, body: '확인서에 싣지 않는 댓글' },
    });
    await approve();
    const certificate = await service.get(current.id, client.id);

    expect(Object.keys(certificate).sort()).toEqual([
      'approval',
      'certificateNumber',
      'counts',
      'developerName',
      'issues',
      'project',
      'screens',
      'version',
    ]);
    expect(Object.keys(certificate.project).sort()).toEqual(['id', 'name']);
    expect(Object.keys(certificate.version).sort()).toEqual(['id', 'number', 'publishedAt']);
    expect(Object.keys(certificate.approval).sort()).toEqual(['approvedAt', 'approverName']);
    expect(Object.keys(certificate.counts).sort()).toEqual(['outOfScope', 'verified', 'withdrawn']);
    expect(certificate.screens).toHaveLength(2);
    for (const screen of certificate.screens) {
      expect(Object.keys(screen).sort()).toEqual(['name', 'viewport']);
    }
    expect(certificate.issues).toHaveLength(1);
    expect(Object.keys(certificate.issues[0]).sort()).toEqual(['category', 'number', 'scope', 'status', 'title']);
  });

  it('게시한 초안의 번호 0도 승인되면 확인서를 받는다', async () => {
    current = await prisma.deliveryVersion.update({ where: { id: current.id }, data: { number: 0 } });
    const approval = await approve();
    const certificate = await service.get(current.id, developer.id);
    expect(certificate.version).toStrictEqual({ id: current.id, number: 0, publishedAt: current.publishedAt });
    expect(certificate.certificateNumber).toBe(approval.id);
  });

  it('대문자 UUID로도 확인서를 받는다', async () => {
    await approve();
    const certificate = await service.get(current.id, developer.id);
    expect(await service.get(current.id.toUpperCase(), developer.id)).toStrictEqual(certificate);
  });
});
