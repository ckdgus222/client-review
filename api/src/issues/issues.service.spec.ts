import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { resetDatabase } from '../../test/reset-database.js';
import { ActivityService } from '../activity/activity.service.js';
import type { Asset, DeliveryVersion, ProjectMember, Screen, User, VersionScreen } from '../generated/prisma/client.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { ApprovalService } from '../versions/approval.service.js';
import { VersionsService } from '../versions/versions.service.js';
import { IssuesService, type NewIssue, toDateText } from './issues.service.js';

describe('toDateText', () => {
  it.each([
    ['UTC', 0],
    ['Asia/Seoul', -540],
    ['America/Los_Angeles', 480],
  ] as const)('서버 시간대 %s에서도 연초·윤일·연말의 날짜를 그대로 돌려준다', (timezone, offset) => {
    vi.stubEnv('TZ', timezone);
    try {
      expect(new Date('2026-01-01T00:00:00.000Z').getTimezoneOffset()).toBe(offset);
      for (const date of ['2026-01-01', '2028-02-29', '2026-12-31']) {
        expect(toDateText(new Date(`${date}T00:00:00.000Z`))).toBe(date);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

const notFound = (message: string) => ({ status: 404, response: { statusCode: 404, message, error: 'Not Found' } });
const versionChanged = {
  status: 409,
  response: { statusCode: 409, code: 'VERSION_CHANGED', message: '새 버전이 올라왔어요' },
};
const versionNotInReview = {
  status: 409,
  response: { statusCode: 409, code: 'VERSION_NOT_IN_REVIEW', message: '검수 중인 버전이 아니에요' },
};

describe('IssuesService', () => {
  let module: TestingModule | undefined;
  let prisma: PrismaService;
  let service: IssuesService;
  let versions: VersionsService;
  let approvals: ApprovalService;
  let developer: User;
  let client: User;
  let approver: User;
  let outsider: User;
  let clientMember: ProjectMember;
  let projectId: string;
  let otherProjectId: string;
  let current: DeliveryVersion;
  let otherCurrent: DeliveryVersion;
  let screen: Screen;
  let asset: Asset;
  let versionScreen: VersionScreen;
  let otherScreen: Screen;
  const missingId = '00000000-0000-4000-8000-000000000001';

  const publishVersion = async (targetProjectId = projectId, number = 1) => {
    const version = await prisma.deliveryVersion.create({
      data: { projectId: targetProjectId, number, status: 'IN_REVIEW', publishedAt: new Date() },
    });
    await prisma.project.update({ where: { id: targetProjectId }, data: { currentVersionId: version.id } });
    return version;
  };

  // 파일 읽기는 이 서비스의 책임이 아니다. 화면과 사진의 실제 DB 연결만 준비한다.
  const attachScreen = async (versionId: string, targetProjectId = projectId) => {
    const screen = await prisma.screen.create({
      data: { projectId: targetProjectId, name: '상품 상세', viewport: 'PC' },
    });
    const asset = await prisma.asset.create({
      data: {
        projectId: targetProjectId,
        storageKey: `${targetProjectId}/${randomUUID()}.png`,
        mime: 'image/png',
        bytes: 100,
        width: 1200,
        height: 800,
      },
    });
    const versionScreen = await prisma.versionScreen.create({
      data: { versionId, screenId: screen.id, assetId: asset.id },
    });
    return { screen, asset, versionScreen };
  };

  const input = (changes: Partial<NewIssue> = {}): NewIssue => ({
    requestId: randomUUID(),
    versionId: current.id,
    title: '버튼을 크게 해 주세요',
    body: '휴대폰에서 누르기 어려워요.\n확인 부탁드려요.',
    ...changes,
  });

  const readState = async () => ({
    issues: await prisma.issue.findMany({ orderBy: { id: 'asc' } }),
    events: await prisma.activityEvent.findMany({ orderBy: { id: 'asc' } }),
  });

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [IssuesService, ProjectsService, ActivityService, VersionsService, ApprovalService],
    }).compile();
    prisma = module.get(PrismaService);
    service = module.get(IssuesService);
    versions = module.get(VersionsService);
    approvals = module.get(ApprovalService);
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    developer = await prisma.user.create({ data: { email: 'developer@example.com', name: '개발자' } });
    client = await prisma.user.create({ data: { email: 'client@example.com', name: '클라이언트' } });
    approver = await prisma.user.create({ data: { email: 'approver@example.com', name: '승인자' } });
    outsider = await prisma.user.create({ data: { email: 'outsider@example.com', name: '다른 개발자' } });
    const project = await prisma.project.create({
      data: {
        name: '쇼핑몰 리뉴얼',
        members: {
          create: [
            { userId: developer.id, role: 'DEVELOPER' },
            { userId: client.id, role: 'CLIENT' },
            { userId: approver.id, role: 'CLIENT' },
          ],
        },
      },
      include: { members: true },
    });
    projectId = project.id;
    clientMember = project.members.find(({ userId }) => userId === client.id)!;
    await prisma.project.update({
      where: { id: projectId },
      data: { approverMemberId: project.members.find(({ userId }) => userId === approver.id)!.id },
    });
    const otherProject = await prisma.project.create({
      data: {
        name: '다른 프로젝트',
        members: {
          create: [
            { userId: outsider.id, role: 'DEVELOPER' },
            { userId: developer.id, role: 'CLIENT' },
          ],
        },
      },
    });
    otherProjectId = otherProject.id;
    current = await publishVersion(projectId, 0);
    otherCurrent = await publishVersion(otherProjectId, 0);
    ({ screen, asset, versionScreen } = await attachScreen(current.id));
    ({ screen: otherScreen } = await attachScreen(otherCurrent.id, otherProjectId));
  });

  afterAll(async () => {
    await module?.close();
  });

  // 기획 표의 테스트 이름을 유지한다. 이 조각은 서비스 반환값을 보고, HTTP 201은 조각 4에서 확인한다.
  it.each(['개발자', '클라이언트', '승인자'] as const)(
    '%s가 쪽지를 쓰면 201이고 목록·상세에 그 이름으로 보인다',
    async (role) => {
      const author = { 개발자: developer, 클라이언트: client, 승인자: approver }[role];
      const request = input();
      const detail = await service.create(projectId, author.id, request);
      const summary = {
        id: expect.any(String),
        number: 1,
        title: request.title,
        status: 'OPEN',
        category: 'BUG',
        scope: 'IN_SCOPE',
        dueDate: null,
        authorName: author.name,
        createdAt: expect.any(Date),
        commentCount: 0,
        originVersion: { id: current.id, number: 0 },
        origin: null,
      };
      expect(detail).toEqual({
        ...summary,
        body: request.body,
        isMine: true,
        attachments: [],
        comments: [],
        attempts: [],
        canReview: role !== '개발자',
        currentVersion: { id: current.id, status: 'IN_REVIEW' },
        projectId,
      });
      expect(await service.list(projectId, client.id)).toEqual([summary]);
      expect(await service.getDetail(detail.id, author.id)).toEqual(detail);
      expect(await service.getDetail(detail.id, author.id === client.id ? developer.id : client.id)).toEqual({
        ...detail,
        isMine: false,
        canReview: false,
      });
      expect(await prisma.issue.findUniqueOrThrow({ where: { id: detail.id } })).toEqual({
        id: detail.id,
        projectId,
        number: 1,
        title: request.title,
        body: request.body,
        status: 'OPEN',
        category: 'BUG',
        scope: 'IN_SCOPE',
        dueDate: null,
        authorId: author.id,
        requestId: request.requestId,
        originVersionId: current.id,
        originVersionScreenId: null,
        xRatio: null,
        yRatio: null,
        createdAt: detail.createdAt,
      });
      expect(await prisma.activityEvent.findMany()).toEqual([
        {
          id: expect.any(String),
          projectId,
          actorId: author.id,
          type: 'ISSUE_CREATED',
          issueId: detail.id,
          versionId: null,
          memberId: null,
          createdAt: expect.any(Date),
        },
      ]);
    },
  );

  it('currentVersion은 게시 전 버전이나 다른 프로젝트의 버전이 아니라 이 프로젝트의 현재 버전이다', async () => {
    const own = await service.create(projectId, client.id, input());
    const foreign = await service.create(otherProjectId, developer.id, input({ versionId: otherCurrent.id }));
    const draft = await versions.createDraft(projectId, developer.id);
    expect(draft.id).not.toBe(current.id);

    for (const reader of [client, approver, developer]) {
      const detail = await service.getDetail(own.id, reader.id);
      expect(detail.currentVersion).toEqual({ id: current.id, status: 'IN_REVIEW' });
    }
    expect((await service.getDetail(foreign.id, developer.id)).currentVersion).toEqual({
      id: otherCurrent.id,
      status: 'IN_REVIEW',
    });
  });

  it('새 버전을 게시하면 지난 버전에서 시작한 쪽지도 새 현재 버전을 주고 처음 버전은 유지한다', async () => {
    const issue = await service.create(projectId, client.id, input());
    const draft = await versions.createDraft(projectId, developer.id);
    await versions.publish(draft.id, developer.id);
    await versions.createDraft(projectId, developer.id);

    for (const reader of [client, developer]) {
      const detail = await service.getDetail(issue.id, reader.id);
      expect(detail.originVersion).toEqual({ id: current.id, number: 0 });
      expect(detail.currentVersion).toEqual({ id: draft.id, status: 'IN_REVIEW' });
    }
  });

  it('현재 버전을 승인하면 지난 버전 쪽지의 currentVersion도 APPROVED이고 다음 버전을 게시하면 IN_REVIEW다', async () => {
    const issue = await service.create(projectId, client.id, input());
    await prisma.issue.update({ where: { id: issue.id }, data: { scope: 'OUT_OF_SCOPE' } });
    const draft = await versions.createDraft(projectId, developer.id);
    await versions.publish(draft.id, developer.id);
    const review = await approvals.check(draft.id, approver.id);
    await approvals.approve(draft.id, approver.id, review.serverTime);
    const next = await versions.createDraft(projectId, developer.id);

    for (const reader of [client, developer]) {
      expect((await service.getDetail(issue.id, reader.id)).currentVersion).toEqual({
        id: draft.id,
        status: 'APPROVED',
      });
    }
    expect((await prisma.deliveryVersion.findUniqueOrThrow({ where: { id: current.id } })).status).toBe('IN_REVIEW');
    await versions.publish(next.id, developer.id);
    expect((await service.getDetail(issue.id, client.id)).currentVersion).toEqual({
      id: next.id,
      status: 'IN_REVIEW',
    });
  });

  it.each(['BUG', 'DESIGN', 'COPY', 'OTHER'] as const)(
    '분류 %s로 쓰면 DB와 목록·상세에 그 분류가 남고 범위는 하자 수정, 마감일은 없다',
    async (category) => {
      const detail = await service.create(projectId, client.id, input({ category }));
      const triage = { category, scope: 'IN_SCOPE', dueDate: null };
      expect(detail).toMatchObject(triage);
      expect(await prisma.issue.findUniqueOrThrow({ where: { id: detail.id } })).toMatchObject(triage);
      expect(await service.list(projectId, client.id)).toEqual([expect.objectContaining({ id: detail.id, ...triage })]);
      expect(await service.getDetail(detail.id, client.id)).toEqual(detail);
      expect(await prisma.comment.count({ where: { issueId: detail.id } })).toBe(0);
    },
  );

  it.each([undefined, 'DESIGN'] as const)(
    '처음 분류가 %s인 쪽지를 같은 requestId로 다른 분류와 함께 다시 보내도 처음 분류가 남는다',
    async (category) => {
      const request = input({ category });
      const first = await service.create(projectId, client.id, request);
      expect(first.category).toBe(category ?? 'BUG');
      const before = await readState();
      const replay = await service.create(projectId, client.id, { ...request, category: 'OTHER' });
      expect(replay).toEqual(first);
      expect(await readState()).toEqual(before);
      expect(before.issues).toHaveLength(1);
      expect(before.events).toHaveLength(1);
    },
  );

  it.each(['UTC', 'Asia/Seoul', 'America/Los_Angeles'])(
    '서버 시간대가 %s여도 DB의 마감일을 목록·상세에 YYYY-MM-DD로 주고 저장된 분류·범위를 유지한다',
    async (timezone) => {
      vi.stubEnv('TZ', timezone);
      try {
        const issue = await prisma.issue.create({
          data: {
            projectId,
            number: 1,
            title: '이미 마감일이 있는 쪽지',
            body: '',
            requestId: randomUUID(),
            authorId: client.id,
            originVersionId: current.id,
            category: 'COPY',
            scope: 'OUT_OF_SCOPE',
            dueDate: new Date('2028-02-29T00:00:00.000Z'),
          },
        });
        const triage = { category: 'COPY', scope: 'OUT_OF_SCOPE', dueDate: '2028-02-29' };
        expect(await service.list(projectId, client.id)).toEqual([
          expect.objectContaining({ id: issue.id, ...triage }),
        ]);
        expect(await service.getDetail(issue.id, client.id)).toMatchObject(triage);
        expect(await prisma.issue.findUniqueOrThrow({ where: { id: issue.id } })).toEqual(issue);
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it.each([
    [0, 1],
    [1, 0],
    [0.25, 0.75],
  ])('핀 (%s, %s)은 경계값도 받고 목록·상세에 처음 화면과 사진만 정해진 모양으로 준다', async (xRatio, yRatio) => {
    const request = input({ pin: { screenId: screen.id, xRatio, yRatio } });
    const detail = await service.create(projectId, client.id, request);
    const summary = {
      id: detail.id,
      number: 1,
      title: request.title,
      status: 'OPEN',
      category: 'BUG',
      scope: 'IN_SCOPE',
      dueDate: null,
      authorName: client.name,
      createdAt: detail.createdAt,
      commentCount: 0,
      originVersion: { id: current.id, number: 0 },
      origin: {
        screenId: screen.id,
        screenName: screen.name,
        viewport: 'PC',
        asset: { id: asset.id, width: 1200, height: 800 },
        xRatio,
        yRatio,
      },
    };
    expect(detail).toEqual({
      ...summary,
      body: request.body,
      isMine: true,
      attachments: [],
      comments: [],
      attempts: [],
      canReview: true,
      currentVersion: { id: current.id, status: 'IN_REVIEW' },
      projectId,
    });
    expect(await service.list(projectId, client.id)).toEqual([summary]);
    expect(await service.getDetail(detail.id, client.id)).toEqual(detail);
    expect(await prisma.issue.findUniqueOrThrow({ where: { id: detail.id } })).toMatchObject({
      originVersionId: current.id,
      originVersionScreenId: versionScreen.id,
      xRatio,
      yRatio,
    });
  });

  it.each(['멤버 아님', '철회된 멤버', '없는 프로젝트'] as const)(
    '%s는 목록·쓰기 모두 404이고 버전과 화면 검사를 먼저 하지 않는다',
    async (scenario) => {
      const userId = scenario === '멤버 아님' ? outsider.id : client.id;
      const targetProjectId = scenario === '없는 프로젝트' ? missingId : projectId;
      if (scenario === '철회된 멤버') {
        await prisma.projectMember.update({ where: { id: clientMember.id }, data: { revokedAt: new Date() } });
      }
      const before = await readState();
      await expect(service.list(targetProjectId, userId)).rejects.toMatchObject(notFound('없는 프로젝트예요'));
      await expect(
        service.create(
          targetProjectId,
          userId,
          input({ versionId: missingId, pin: { screenId: missingId, xRatio: 0, yRatio: 0 } }),
        ),
      ).rejects.toMatchObject(notFound('없는 프로젝트예요'));
      expect(await readState()).toEqual(before);
    },
  );

  it.each(['멤버 아님', '철회된 작성자', '남의 프로젝트 쪽지', '없는 쪽지'] as const)(
    'getDetail은 %s를 같은 없는 쪽지 404로 답한다',
    async (scenario) => {
      const own = await service.create(projectId, client.id, input());
      const other = await service.create(otherProjectId, outsider.id, input({ versionId: otherCurrent.id }));
      if (scenario === '철회된 작성자') {
        await prisma.projectMember.update({ where: { id: clientMember.id }, data: { revokedAt: new Date() } });
      }
      const issueId = scenario === '없는 쪽지' ? missingId : scenario === '남의 프로젝트 쪽지' ? other.id : own.id;
      const userId = scenario === '멤버 아님' ? outsider.id : client.id;
      const before = await readState();
      await expect(service.getDetail(issueId, userId)).rejects.toMatchObject(notFound('없는 쪽지예요'));
      expect(await readState()).toEqual(before);
    },
  );

  it('같은 requestId로 다시 보내면 201이고 처음 쪽지를 돌려주며 쪽지·일지는 하나다', async () => {
    const request = input({ pin: { screenId: screen.id, xRatio: 0.2, yRatio: 0.8 } });
    const first = await service.create(projectId, client.id, request);
    const before = await readState();
    const replay = await service.create(projectId, client.id, {
      ...request,
      title: '고친 제목',
      body: '고친 본문',
      pin: { screenId: missingId, xRatio: 1, yRatio: 0 },
    });
    expect(replay).toEqual(first);
    expect(await readState()).toEqual(before);
    expect(before.issues).toHaveLength(1);
    expect(before.events).toHaveLength(1);
  });

  it('저장된 뒤 새 버전이 게시돼도 같은 requestId는 409가 아니라 처음 쪽지를 받는다', async () => {
    const request = input({ pin: { screenId: screen.id, xRatio: 0.2, yRatio: 0.8 } });
    const first = await service.create(projectId, client.id, request);
    const draft = await versions.createDraft(projectId, developer.id);
    await versions.publish(draft.id, developer.id);
    const before = await readState();
    expect(await service.create(projectId, client.id, request)).toEqual({
      ...first,
      currentVersion: { id: draft.id, status: 'IN_REVIEW' },
    });
    expect(await readState()).toEqual(before);
  });

  it('저장된 뒤 승인돼도 같은 requestId는 처음 쪽지를 돌려준다', async () => {
    const request = input();
    const first = await service.create(projectId, client.id, request);
    await prisma.$transaction([
      prisma.deliveryVersion.update({ where: { id: current.id }, data: { status: 'APPROVED' } }),
      prisma.approval.create({ data: { versionId: current.id, approverId: approver.id, summary: { issues: [] } } }),
    ]);
    const before = await readState();
    expect(await service.create(projectId, client.id, request)).toEqual({
      ...first,
      currentVersion: { id: current.id, status: 'APPROVED' },
    });
    expect(await readState()).toEqual(before);
  });

  it('저장된 뒤 작성자의 접근이 철회되면 같은 requestId도 404이고 처음 쪽지를 노출하지 않는다', async () => {
    const request = input();
    await service.create(projectId, client.id, request);
    await prisma.projectMember.update({ where: { id: clientMember.id }, data: { revokedAt: new Date() } });
    const before = await readState();
    await expect(service.create(projectId, client.id, request)).rejects.toMatchObject(notFound('없는 프로젝트예요'));
    expect(await readState()).toEqual(before);
  });

  it.each(['지난 버전', '게시 전 버전', '남의 프로젝트 버전', '없는 id', '게시한 버전이 없는 프로젝트'] as const)(
    'versionId가 %s이면 409 VERSION_CHANGED이고 저장하지 않는다',
    async (scenario) => {
      const draft = await prisma.deliveryVersion.create({ data: { projectId } });
      const versionIds = {
        '지난 버전': current.id,
        '게시 전 버전': draft.id,
        '남의 프로젝트 버전': otherCurrent.id,
        '없는 id': missingId,
        '게시한 버전이 없는 프로젝트': draft.id,
      };
      if (scenario === '지난 버전') await publishVersion();
      if (scenario === '게시한 버전이 없는 프로젝트') {
        await prisma.project.update({ where: { id: projectId }, data: { currentVersionId: null } });
      }
      const before = await readState();
      await expect(
        service.create(projectId, developer.id, input({ versionId: versionIds[scenario] })),
      ).rejects.toMatchObject(versionChanged);
      expect(await readState()).toEqual(before);
    },
  );

  it('보던 버전 뒤에 새 버전이 게시되면 쪽지 쓰기는 409 VERSION_CHANGED이고 쪽지·일지가 없다', async () => {
    const draft = await versions.createDraft(projectId, developer.id);
    await versions.publish(draft.id, developer.id);
    const before = await readState();
    await expect(
      service.create(projectId, client.id, input({ pin: { screenId: missingId, xRatio: 0.5, yRatio: 0.5 } })),
    ).rejects.toMatchObject(versionChanged);
    expect(await readState()).toEqual(before);
    expect(await prisma.issue.count()).toBe(0);
    expect(await prisma.activityEvent.count({ where: { type: 'ISSUE_CREATED' } })).toBe(0);
  });

  it('현재 버전 id는 대문자로 보내도 같은 버전으로 받아 저장한다', async () => {
    const detail = await service.create(projectId, client.id, input({ versionId: current.id.toUpperCase() }));
    expect(detail.originVersion).toEqual({ id: current.id, number: 0 });
    expect(await prisma.issue.count()).toBe(1);
  });

  it.each(['쪽지 쓰기'])(
    '현재 버전이 승인된 뒤 %s는 409 VERSION_NOT_IN_REVIEW이고 아무것도 바뀌지 않는다',
    async () => {
      await prisma.deliveryVersion.update({ where: { id: current.id }, data: { status: 'APPROVED' } });
      const before = await readState();
      await expect(
        service.create(projectId, client.id, input({ pin: { screenId: missingId, xRatio: 0.5, yRatio: 0.5 } })),
      ).rejects.toMatchObject(versionNotInReview);
      expect(await readState()).toEqual(before);
      expect((await prisma.deliveryVersion.findUniqueOrThrow({ where: { id: current.id } })).status).toBe('APPROVED');
    },
  );

  it('버전이 다르고 현재 버전도 승인됐으면 VERSION_CHANGED를 먼저 돌려준다', async () => {
    const next = await publishVersion();
    await prisma.deliveryVersion.update({ where: { id: next.id }, data: { status: 'APPROVED' } });
    const before = await readState();
    await expect(service.create(projectId, client.id, input())).rejects.toMatchObject(versionChanged);
    expect(await readState()).toEqual(before);
  });

  it.each(['남의 프로젝트 화면', '이번 버전에서 뺀 화면', '없는 id'] as const)(
    '현재 버전에 없는 화면(%s)에 핀을 꽂으면 404이고 저장하지 않는다',
    async (scenario) => {
      const next = await publishVersion();
      const screenIds = {
        '남의 프로젝트 화면': otherScreen.id,
        '이번 버전에서 뺀 화면': screen.id,
        '없는 id': missingId,
      };
      const before = await readState();
      await expect(
        service.create(
          projectId,
          client.id,
          input({ versionId: next.id, pin: { screenId: screenIds[scenario], xRatio: 0.5, yRatio: 0.5 } }),
        ),
      ).rejects.toMatchObject(notFound('없는 화면이에요'));
      expect(await readState()).toEqual(before);
    },
  );

  it('번호는 쪽지 개수가 아니라 프로젝트의 가장 큰 번호 다음부터 붙인다', async () => {
    const first = await service.create(projectId, client.id, input());
    await prisma.issue.update({ where: { id: first.id }, data: { number: 7 } });
    const other = await service.create(otherProjectId, developer.id, input({ versionId: otherCurrent.id }));
    await prisma.issue.update({ where: { id: other.id }, data: { number: 99 } });
    const next = await service.create(projectId, developer.id, input());
    expect(next.number).toBe(8);
    expect((await service.list(projectId, client.id)).map(({ number }) => number)).toEqual([8, 7]);
  });

  it('다른 프로젝트에 쓴 requestId는 409 REQUEST_ID_REUSED이고 그 쪽지 내용을 돌려주지 않는다', async () => {
    const request = input();
    await service.create(otherProjectId, developer.id, {
      ...request,
      versionId: otherCurrent.id,
      body: '다른 프로젝트 내용',
    });
    const before = await readState();
    await expect(service.create(projectId, developer.id, request)).rejects.toMatchObject({
      status: 409,
      response: { statusCode: 409, code: 'REQUEST_ID_REUSED', message: '이미 쓴 요청 번호예요' },
    });
    expect(await readState()).toEqual(before);
    expect((await service.create(projectId, developer.id, input())).number).toBe(1);
  });

  it('다른 사람이 같은 requestId를 써도 각자 쪽지가 생긴다', async () => {
    const request = input();
    const first = await service.create(projectId, client.id, request);
    const second = await service.create(projectId, developer.id, { ...request, title: '개발자의 쪽지' });
    expect(second.id).not.toBe(first.id);
    expect(second).toMatchObject({ number: 2, authorName: developer.name, title: '개발자의 쪽지', isMine: true });
    expect(await service.getDetail(first.id, developer.id)).toMatchObject({ authorName: client.name, isMine: false });
    expect(await prisma.issue.count({ where: { requestId: request.requestId } })).toBe(2);
    expect(await prisma.activityEvent.count({ where: { type: 'ISSUE_CREATED' } })).toBe(2);
  });

  it('쪽지 쓰기와 게시를 동시에 보내면 쪽지는 보던 버전에 저장되거나 409이고 새 버전의 쪽지가 되지 않는다', async () => {
    const draft = await versions.createDraft(projectId, developer.id);
    const [creation, publication] = await Promise.allSettled([
      service.create(projectId, client.id, input({ pin: { screenId: screen.id, xRatio: 0.4, yRatio: 0.6 } })),
      versions.publish(draft.id, developer.id),
    ]);
    expect(publication.status).toBe('fulfilled');
    expect((await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).currentVersionId).toBe(draft.id);
    if (creation.status === 'rejected') {
      expect(creation.reason).toMatchObject(versionChanged);
      expect(await prisma.issue.count()).toBe(0);
      expect(await prisma.activityEvent.count({ where: { type: 'ISSUE_CREATED' } })).toBe(0);
      return;
    }
    expect(creation.value.originVersion).toEqual({ id: current.id, number: 0 });
    expect(await prisma.issue.findMany()).toEqual([
      expect.objectContaining({
        originVersionId: current.id,
        originVersionScreenId: versionScreen.id,
        xRatio: 0.4,
        yRatio: 0.6,
      }),
    ]);
    expect(await prisma.activityEvent.findMany({ where: { type: 'ISSUE_CREATED' } })).toEqual([
      expect.objectContaining({ issueId: creation.value.id, projectId }),
    ]);
  });

  it.each(['멤버 철회', '새 버전 게시', '현재 버전 승인', '재전송 전 멤버 철회'] as const)(
    '쪽지 쓰기는 Project 잠금을 기다린 뒤 %s를 확인한다',
    async (change) => {
      const request = input();
      if (change === '재전송 전 멤버 철회') await service.create(projectId, client.id, request);
      const before = await readState();
      let pending: Promise<unknown> | undefined;
      let settled = false;
      try {
        await prisma.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT id FROM projects WHERE id = ${projectId}::uuid FOR UPDATE`;
            const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
            pending = service
              .create(projectId, client.id, request)
              .catch((error: unknown) => error)
              .finally(() => {
                settled = true;
              });
            // 고정 시간만 기다리지 않고 다른 연결이 실제로 이 잠금을 기다리는지 확인한다.
            await vi.waitFor(
              async () => {
                const [{ waiting }] = await prisma.$queryRaw<{ waiting: boolean }[]>`
              SELECT EXISTS (
                SELECT 1 FROM pg_stat_activity
                WHERE datname = current_database() AND ${pid}::int = ANY(pg_blocking_pids(pid))
              ) AS waiting
            `;
                expect(settled).toBe(false);
                expect(waiting).toBe(true);
              },
              { timeout: 2_000, interval: 20 },
            );
            if (change === '멤버 철회' || change === '재전송 전 멤버 철회') {
              await tx.projectMember.update({ where: { id: clientMember.id }, data: { revokedAt: new Date() } });
              return;
            }
            if (change === '현재 버전 승인') {
              await tx.deliveryVersion.update({ where: { id: current.id }, data: { status: 'APPROVED' } });
              return;
            }
            const next = await tx.deliveryVersion.create({
              data: { projectId, number: 1, status: 'IN_REVIEW', publishedAt: new Date() },
            });
            await tx.project.update({ where: { id: projectId }, data: { currentVersionId: next.id } });
          },
          { maxWait: 5_000, timeout: 10_000 },
        );
      } finally {
        await pending;
      }
      const expected = {
        '멤버 철회': notFound('없는 프로젝트예요'),
        '새 버전 게시': versionChanged,
        '현재 버전 승인': versionNotInReview,
        '재전송 전 멤버 철회': notFound('없는 프로젝트예요'),
      };
      expect(await pending).toMatchObject(expected[change]);
      expect(await readState()).toEqual(before);
    },
    20_000,
  );

  it('list는 빈 프로젝트에 빈 배열을 주고 모든 버전의 쪽지를 번호 큰 순으로 주며 남의 프로젝트는 섞지 않는다', async () => {
    expect(await service.list(projectId, client.id)).toEqual([]);
    const first = await service.create(projectId, client.id, input());
    const next = await publishVersion();
    const second = await service.create(projectId, developer.id, input({ versionId: next.id }));
    const third = await service.create(projectId, approver.id, input({ versionId: next.id }));
    // 시각순·삽입순 정렬로 우연히 통과하지 않게 번호와 반대 순서로 시각을 둔다.
    await prisma.issue.update({ where: { id: first.id }, data: { createdAt: new Date('2026-03-03T00:00:00Z') } });
    await prisma.issue.update({
      where: { id: second.id },
      data: { createdAt: new Date('2026-03-02T00:00:00Z'), status: 'IN_PROGRESS' },
    });
    await prisma.issue.update({ where: { id: third.id }, data: { createdAt: new Date('2026-03-01T00:00:00Z') } });
    await service.create(otherProjectId, developer.id, input({ versionId: otherCurrent.id }));
    const list = await service.list(projectId, developer.id);
    expect(list.map(({ id, number, status, originVersion }) => ({ id, number, status, originVersion }))).toEqual([
      { id: third.id, number: 3, status: 'OPEN', originVersion: { id: next.id, number: 1 } },
      { id: second.id, number: 2, status: 'IN_PROGRESS', originVersion: { id: next.id, number: 1 } },
      { id: first.id, number: 1, status: 'OPEN', originVersion: { id: current.id, number: 0 } },
    ]);
  });

  it('새 버전을 게시하고 화면을 숨겨도 예전 쪽지의 처음 위치와 사진은 그대로다', async () => {
    const pinned = await service.create(
      projectId,
      client.id,
      input({ pin: { screenId: screen.id, xRatio: 0.25, yRatio: 0.75 } }),
    );
    const unpinned = await service.create(projectId, client.id, input());
    const before = await service.list(projectId, client.id);
    const draft = await versions.createDraft(projectId, developer.id);
    const replacement = await prisma.asset.create({
      data: {
        projectId,
        storageKey: `${projectId}/${randomUUID()}.png`,
        mime: 'image/png',
        bytes: 200,
        width: 640,
        height: 480,
      },
    });
    await prisma.versionScreen.update({
      where: { versionId_screenId: { versionId: draft.id, screenId: screen.id } },
      data: { assetId: replacement.id },
    });
    await versions.publish(draft.id, developer.id);
    await prisma.screen.update({ where: { id: screen.id }, data: { hiddenAt: new Date() } });
    expect(await service.list(projectId, client.id)).toEqual(before);
    expect(await service.getDetail(pinned.id, client.id)).toEqual({
      ...pinned,
      currentVersion: { id: draft.id, status: 'IN_REVIEW' },
    });
    expect(await service.getDetail(unpinned.id, client.id)).toEqual({
      ...unpinned,
      currentVersion: { id: draft.id, status: 'IN_REVIEW' },
    });
    expect((await service.getDetail(pinned.id, client.id)).origin?.asset.id).toBe(asset.id);
  });

  it('getDetail은 이 쪽지의 댓글만 오래된 순서와 작성 버전 번호로 주고 목록·상세의 commentCount가 같다', async () => {
    const issue = await service.create(projectId, client.id, input());
    const next = await publishVersion();
    const latest = await prisma.comment.create({
      data: {
        issueId: issue.id,
        authorId: developer.id,
        versionId: next.id,
        requestId: randomUUID(),
        body: '가장 늦은 댓글',
        createdAt: new Date('2026-03-03T00:00:00Z'),
      },
    });
    const earliest = await prisma.comment.create({
      data: {
        issueId: issue.id,
        authorId: client.id,
        versionId: current.id,
        requestId: randomUUID(),
        body: '처음 댓글\n둘째 줄',
        createdAt: new Date('2026-03-01T00:00:00Z'),
      },
    });
    const middle = await prisma.comment.create({
      data: {
        issueId: issue.id,
        authorId: approver.id,
        versionId: next.id,
        requestId: randomUUID(),
        body: '<script>글자</script>',
        createdAt: new Date('2026-03-02T00:00:00Z'),
      },
    });
    const other = await service.create(projectId, developer.id, input({ versionId: next.id }));
    await prisma.comment.create({
      data: {
        issueId: other.id,
        authorId: developer.id,
        versionId: next.id,
        requestId: randomUUID(),
        body: '다른 쪽지의 댓글',
      },
    });
    expect(await service.getDetail(issue.id, developer.id)).toEqual({
      ...issue,
      currentVersion: { id: next.id, status: 'IN_REVIEW' },
      isMine: false,
      canReview: false,
      commentCount: 3,
      comments: [
        {
          id: earliest.id,
          authorName: client.name,
          versionNumber: 0,
          body: earliest.body,
          createdAt: earliest.createdAt,
        },
        { id: middle.id, authorName: approver.name, versionNumber: 1, body: middle.body, createdAt: middle.createdAt },
        { id: latest.id, authorName: developer.name, versionNumber: 1, body: latest.body, createdAt: latest.createdAt },
      ],
    });
    expect((await service.list(projectId, client.id)).map(({ id, commentCount }) => ({ id, commentCount }))).toEqual([
      { id: other.id, commentCount: 1 },
      { id: issue.id, commentCount: 3 },
    ]);
  });

  it('getDetail은 이 쪽지의 참고 사진만 첨부 id·사진 id·크기로 주고 저장 경로를 노출하지 않는다', async () => {
    const issue = await service.create(projectId, client.id, input());
    const other = await service.create(projectId, developer.id, input());
    const attachment = await prisma.issueAttachment.create({
      data: {
        issue: { connect: { id: issue.id } },
        asset: {
          create: {
            projectId,
            storageKey: `${projectId}/${randomUUID()}.png`,
            mime: 'image/png',
            bytes: 100,
            width: 400,
            height: 300,
          },
        },
      },
    });
    await prisma.issueAttachment.create({
      data: {
        issue: { connect: { id: other.id } },
        asset: {
          create: {
            projectId,
            storageKey: `${projectId}/${randomUUID()}.png`,
            mime: 'image/png',
            bytes: 200,
            width: 900,
            height: 600,
          },
        },
      },
    });
    expect(await service.getDetail(issue.id, developer.id)).toEqual({
      ...issue,
      isMine: false,
      canReview: false,
      attachments: [{ id: attachment.id, assetId: attachment.assetId, width: 400, height: 300 }],
    });
  });

  it('철회된 사람의 쪽지·댓글은 그 이름으로 남고 다시 들어오면 isMine이 참이다', async () => {
    const issue = await service.create(projectId, client.id, input());
    const comment = await prisma.comment.create({
      data: {
        issueId: issue.id,
        authorId: client.id,
        versionId: current.id,
        requestId: randomUUID(),
        body: '제가 남긴 댓글',
      },
    });
    const expected = {
      ...issue,
      commentCount: 1,
      comments: [
        { id: comment.id, authorName: client.name, versionNumber: 0, body: comment.body, createdAt: comment.createdAt },
      ],
    };
    await prisma.projectMember.update({ where: { id: clientMember.id }, data: { revokedAt: new Date() } });
    expect(await service.getDetail(issue.id, developer.id)).toEqual({ ...expected, isMine: false, canReview: false });
    expect(await service.list(projectId, developer.id)).toEqual([
      expect.objectContaining({ id: issue.id, authorName: client.name, commentCount: 1 }),
    ]);
    await expect(service.getDetail(issue.id, client.id)).rejects.toMatchObject(notFound('없는 쪽지예요'));
    // 초대 수락 자체는 InvitationsService의 테스트가 맡고, 여기서는 복귀 뒤 읽기를 확인한다.
    await prisma.projectMember.update({ where: { id: clientMember.id }, data: { revokedAt: null } });
    expect(await service.getDetail(issue.id, client.id)).toEqual(expected);
    expect(await prisma.issue.count()).toBe(1);
    expect(await prisma.comment.count()).toBe(1);
  });

  // HTTP의 같은 시나리오는 조각 4에서 확인한다. 여기서는 실제 DB에 저장한 줄과 서비스 응답을 비교한다.
  it('쪽지 상세에 고쳤어요 이력이 오래된 순으로 오고 canReview는 쓴 클라이언트와 승인자에게만 참이다', async () => {
    const issue = await service.create(projectId, client.id, input());
    const next = await publishVersion();
    const fixed = await prisma.versionScreen.create({
      data: {
        version: { connect: { id: next.id } },
        screen: { create: { projectId, name: '고친 모바일 화면', viewport: 'MOBILE' } },
        asset: {
          create: {
            projectId,
            storageKey: `${projectId}/${randomUUID()}.png`,
            mime: 'image/png',
            bytes: 100,
            width: 390,
            height: 844,
          },
        },
      },
      include: { screen: true, asset: true },
    });

    // 저장 순서와 시각 순서를 다르게 둔다. 결과 없는 옛 줄도 빠지면 안 된다.
    const latest = await prisma.resolutionAttempt.create({
      data: {
        issueId: issue.id,
        versionId: next.id,
        versionScreenId: fixed.id,
        summary: '모바일 버튼을 고쳤어요',
        submittedById: developer.id,
        createdAt: new Date('2026-03-03T00:00:00Z'),
        result: 'VERIFIED',
        reviewedById: approver.id,
        reviewedAt: new Date('2026-03-03T01:00:00Z'),
      },
    });
    const earliest = await prisma.resolutionAttempt.create({
      data: {
        issueId: issue.id,
        versionId: current.id,
        versionScreenId: versionScreen.id,
        summary: '처음 고친 내용\n다시 확인해 주세요',
        submittedById: developer.id,
        createdAt: new Date('2026-03-01T00:00:00Z'),
        result: 'REOPENED',
        reviewedById: client.id,
        reviewedAt: new Date('2026-03-01T01:00:00Z'),
      },
    });
    const unanswered = await prisma.resolutionAttempt.create({
      data: {
        issueId: issue.id,
        versionId: current.id,
        summary: '화면 없이 보낸 설명',
        submittedById: developer.id,
        createdAt: new Date('2026-03-02T00:00:00Z'),
      },
    });
    const otherIssue = await service.create(projectId, client.id, input({ versionId: next.id }));
    const foreignIssue = await service.create(otherProjectId, outsider.id, input({ versionId: otherCurrent.id }));
    const foreignScreen = await prisma.versionScreen.findUniqueOrThrow({
      where: { versionId_screenId: { versionId: otherCurrent.id, screenId: otherScreen.id } },
    });
    await prisma.resolutionAttempt.createMany({
      data: [
        {
          issueId: otherIssue.id,
          versionId: next.id,
          versionScreenId: fixed.id,
          summary: '같은 프로젝트의 다른 쪽지',
          submittedById: developer.id,
        },
        {
          issueId: foreignIssue.id,
          versionId: otherCurrent.id,
          versionScreenId: foreignScreen.id,
          summary: '다른 프로젝트의 쪽지',
          submittedById: outsider.id,
        },
      ],
    });
    await prisma.projectMember.create({ data: { projectId, userId: outsider.id, role: 'CLIENT' } });
    const before = await prisma.resolutionAttempt.findMany({ orderBy: { id: 'asc' } });
    const attempts = [
      {
        id: earliest.id,
        versionId: current.id,
        versionNumber: 0,
        screen: {
          screenId: screen.id,
          screenName: '상품 상세',
          viewport: 'PC',
          asset: { id: asset.id, width: 1200, height: 800 },
        },
        summary: '처음 고친 내용\n다시 확인해 주세요',
        submittedByName: developer.name,
        createdAt: new Date('2026-03-01T00:00:00Z'),
        result: 'REOPENED',
        reviewedByName: client.name,
        reviewedAt: new Date('2026-03-01T01:00:00Z'),
      },
      {
        id: unanswered.id,
        versionId: current.id,
        versionNumber: 0,
        screen: null,
        summary: '화면 없이 보낸 설명',
        submittedByName: developer.name,
        createdAt: new Date('2026-03-02T00:00:00Z'),
        result: null,
        reviewedByName: null,
        reviewedAt: null,
      },
      {
        id: latest.id,
        versionId: next.id,
        versionNumber: 1,
        screen: {
          screenId: fixed.screen.id,
          screenName: '고친 모바일 화면',
          viewport: 'MOBILE',
          asset: { id: fixed.asset.id, width: 390, height: 844 },
        },
        summary: '모바일 버튼을 고쳤어요',
        submittedByName: developer.name,
        createdAt: new Date('2026-03-03T00:00:00Z'),
        result: 'VERIFIED',
        reviewedByName: approver.name,
        reviewedAt: new Date('2026-03-03T01:00:00Z'),
      },
    ];
    for (const [reader, canReview] of [
      [client, true],
      [approver, true],
      [developer, false],
      [outsider, false],
    ] as const) {
      const detail = await service.getDetail(issue.id, reader.id);
      expect(detail).toEqual({
        ...issue,
        currentVersion: { id: next.id, status: 'IN_REVIEW' },
        attempts,
        canReview,
        projectId,
        isMine: reader.id === client.id,
      });
    }
    expect(await prisma.resolutionAttempt.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
  });

  it('고쳤어요가 없는 쪽지는 남의 이력이 있어도 빈 배열과 자기 프로젝트 id를 준다', async () => {
    const own = await service.create(projectId, client.id, input());
    const foreign = await service.create(otherProjectId, developer.id, input({ versionId: otherCurrent.id }));
    await prisma.resolutionAttempt.create({
      data: { issueId: own.id, versionId: current.id, summary: '다른 프로젝트의 이력', submittedById: developer.id },
    });
    const detail = await service.getDetail(foreign.id, developer.id);
    expect(detail.attempts).toEqual([]);
    expect(detail.projectId).toBe(otherProjectId);
    // 이 사람은 첫 프로젝트에서는 개발자지만, 이 프로젝트에서는 쪽지를 쓴 클라이언트다.
    expect(detail.canReview).toBe(true);
  });

  it.each(['OPEN', 'IN_PROGRESS', 'READY_FOR_REVIEW', 'VERIFIED', 'WITHDRAWN'] as const)(
    '쪽지 상태가 %s여도 canReview는 쓴 클라이언트와 승인자에게만 참이고 개발자는 자기 쪽지도 거짓이다',
    async (status) => {
      for (const author of [client, approver, developer]) {
        const detail = await service.create(projectId, author.id, input());
        const issue = await prisma.issue.update({ where: { id: detail.id }, data: { status } });
        expect(await service.canReview(prisma, issue, client.id)).toBe(author.id === client.id);
        expect(await service.canReview(prisma, issue, approver.id)).toBe(true);
        expect(await service.canReview(prisma, issue, developer.id)).toBe(false);
        expect((await service.getDetail(issue.id, client.id)).canReview).toBe(author.id === client.id);
        expect((await service.getDetail(issue.id, approver.id)).canReview).toBe(true);
        expect((await service.getDetail(issue.id, developer.id)).canReview).toBe(false);
      }
    },
  );

  it('개발자가 쓴 쪽지는 승인자만 확인하고 승인자가 없으면 누구도 확인할 수 없다', async () => {
    const detail = await service.create(projectId, developer.id, input());
    const issue = { projectId, authorId: developer.id };
    expect(await service.canReview(prisma, issue, approver.id)).toBe(true);
    await prisma.project.update({ where: { id: projectId }, data: { approverMemberId: null } });
    for (const reader of [developer, client, approver]) {
      expect(await service.canReview(prisma, issue, reader.id)).toBe(false);
      expect((await service.getDetail(detail.id, reader.id)).canReview).toBe(false);
    }
    expect(await service.canReview(prisma, issue, outsider.id)).toBe(false);
    const own = await service.create(projectId, client.id, input());
    expect((await service.getDetail(own.id, client.id)).canReview).toBe(true);
    expect((await service.getDetail(own.id, approver.id)).canReview).toBe(false);
  });

  it.each(['철회된 승인자', '철회된 작성자', '멤버 아님'] as const)(
    'canReview는 %s에게 자기 쪽지든 남의 쪽지든 거짓이다',
    async (scenario) => {
      const reader = { '철회된 승인자': approver, '철회된 작성자': client, '멤버 아님': outsider }[scenario];
      if (scenario !== '멤버 아님') {
        await prisma.projectMember.update({
          where: { projectId_userId: { projectId, userId: reader.id } },
          data: { revokedAt: new Date() },
        });
      }
      expect(await service.canReview(prisma, { projectId, authorId: reader.id }, reader.id)).toBe(false);
      expect(await service.canReview(prisma, { projectId, authorId: developer.id }, reader.id)).toBe(false);
    },
  );

  it('다른 프로젝트의 승인자인 클라이언트는 이 프로젝트에서 남의 쪽지를 확인할 수 없다', async () => {
    const member = await prisma.projectMember.create({
      data: { projectId: otherProjectId, userId: client.id, role: 'CLIENT' },
    });
    await prisma.project.update({ where: { id: otherProjectId }, data: { approverMemberId: member.id } });
    const detail = await service.create(projectId, developer.id, input());
    expect(await service.canReview(prisma, { projectId, authorId: developer.id }, client.id)).toBe(false);
    expect((await service.getDetail(detail.id, client.id)).canReview).toBe(false);
    const foreign = await service.create(otherProjectId, outsider.id, input({ versionId: otherCurrent.id }));
    expect((await service.getDetail(foreign.id, client.id)).canReview).toBe(true);
  });

  it('승인자가 바뀌면 이전 승인자는 남의 쪽지 확인 권한을 잃고 새 승인자는 얻는다', async () => {
    const detail = await service.create(projectId, developer.id, input());
    expect((await service.getDetail(detail.id, approver.id)).canReview).toBe(true);
    await prisma.project.update({ where: { id: projectId }, data: { approverMemberId: clientMember.id } });
    expect((await service.getDetail(detail.id, approver.id)).canReview).toBe(false);
    expect((await service.getDetail(detail.id, client.id)).canReview).toBe(true);
  });

  it('requireVersionInReview는 버전 id를 생략해도 검수 중인 현재 버전 id를 돌려준다', async () => {
    const versionId = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM projects WHERE id = ${projectId}::uuid FOR UPDATE`;
      return service.requireVersionInReview(tx, projectId);
    });
    expect(versionId).toBe(current.id);
  });

  it.each(['현재 버전 없음', 'APPROVED', 'DRAFT'] as const)(
    'requireVersionInReview는 versionId 없이 호출해도 %s이면 VERSION_NOT_IN_REVIEW다',
    async (state) => {
      if (state === '현재 버전 없음') {
        await prisma.project.update({ where: { id: projectId }, data: { currentVersionId: null } });
      }
      if (state === 'APPROVED') {
        await prisma.deliveryVersion.update({ where: { id: current.id }, data: { status: 'APPROVED' } });
      }
      if (state === 'DRAFT') {
        const draft = await prisma.deliveryVersion.create({ data: { projectId } });
        await prisma.project.update({ where: { id: projectId }, data: { currentVersionId: draft.id } });
      }
      const before = await readState();
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM projects WHERE id = ${projectId}::uuid FOR UPDATE`;
          return service.requireVersionInReview(tx, projectId);
        }),
      ).rejects.toMatchObject(versionNotInReview);
      expect(await readState()).toEqual(before);
    },
  );

  it('같은 requestId로 동시에 두 번 보내면 둘 다 같은 쪽지를 받고 쪽지·일지는 하나다', async () => {
    const request = input({ pin: { screenId: screen.id, xRatio: 0.3, yRatio: 0.7 } });
    const [first, second] = await Promise.all([
      service.create(projectId, client.id, request),
      service.create(projectId, client.id, request),
    ]);
    expect(second).toEqual(first);
    expect(first.number).toBe(1);
    expect(await prisma.issue.count()).toBe(1);
    expect(await prisma.activityEvent.findMany()).toEqual([
      expect.objectContaining({ type: 'ISSUE_CREATED', issueId: first.id, actorId: client.id, projectId }),
    ]);
  });

  it('동시에 다섯 개를 써도 번호는 1~5로 겹치지 않고 다른 프로젝트는 다시 1부터다', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, index) => service.create(projectId, client.id, input({ title: `쪽지 ${index}` }))),
    );
    expect(results.map(({ number }) => number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(results.map(({ id }) => id)).size).toBe(5);
    expect(await prisma.issue.count({ where: { projectId } })).toBe(5);
    const events = await prisma.activityEvent.findMany({ where: { projectId } });
    expect(events).toHaveLength(5);
    expect(events.map(({ issueId }) => issueId)).toEqual(expect.arrayContaining(results.map(({ id }) => id)));
    expect(events.every(({ type, actorId }) => type === 'ISSUE_CREATED' && actorId === client.id)).toBe(true);
    const other = await service.create(otherProjectId, developer.id, input({ versionId: otherCurrent.id }));
    expect(other.number).toBe(1);
  });

  it('쪽지 쓰기가 일지 저장에서 실패하면 쪽지가 없고 다음 쪽지가 그 번호를 쓴다', async () => {
    await service.create(projectId, client.id, input());
    const request = input();
    const before = await readState();
    try {
      await prisma.$executeRaw`
        CREATE FUNCTION issues_service_fail_create_event() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.type = 'ISSUE_CREATED' THEN
            RAISE EXCEPTION 'issues service event failure';
          END IF;
          RETURN NEW;
        END;
        $$
      `;
      await prisma.$executeRaw`
        CREATE TRIGGER issues_service_fail_create_event
        BEFORE INSERT ON activity_events FOR EACH ROW
        EXECUTE FUNCTION issues_service_fail_create_event()
      `;
      await expect(service.create(projectId, client.id, request)).rejects.toThrow('issues service event failure');
      expect(await readState()).toEqual(before);
      expect(await prisma.issue.count({ where: { requestId: request.requestId } })).toBe(0);
    } finally {
      try {
        await prisma.$executeRaw`DROP TRIGGER IF EXISTS issues_service_fail_create_event ON activity_events`;
      } finally {
        await prisma.$executeRaw`DROP FUNCTION IF EXISTS issues_service_fail_create_event()`;
      }
    }
    const saved = await service.create(projectId, client.id, request);
    expect(saved.number).toBe(2);
    expect(await prisma.issue.count()).toBe(2);
    expect(await prisma.activityEvent.count({ where: { type: 'ISSUE_CREATED' } })).toBe(2);
  });

  describe('start와 lockIssue', () => {
    const issueNotOpen = {
      status: 409,
      response: { statusCode: 409, code: 'ISSUE_NOT_OPEN', message: '접수 상태의 쪽지만 시작할 수 있어요' },
    };
    const developerOnly = {
      status: 403,
      response: { statusCode: 403, message: '개발자만 할 수 있어요', error: 'Forbidden' },
    };

    it.each(['클라이언트', '개발자'] as const)(
      'start는 %s의 OPEN 쪽지를 IN_PROGRESS로 바꾸고 상세와 쪽지 번호가 있는 일지를 준다',
      async (author) => {
        const authorId = author === '개발자' ? developer.id : client.id;
        const issue = await service.create(
          projectId,
          authorId,
          input({ pin: { screenId: screen.id, xRatio: 0.25, yRatio: 0.75 } }),
        );
        const untouched = await service.create(projectId, client.id, input());
        const before = await readState();
        const expected = { ...issue, status: 'IN_PROGRESS', isMine: authorId === developer.id, canReview: false };
        expect(await service.start(issue.id, developer.id, current.id)).toEqual(expected);
        expect(await service.getDetail(issue.id, developer.id)).toEqual(expected);
        const after = await readState();
        expect(after.issues).toEqual(
          before.issues.map((row) => (row.id === issue.id ? { ...row, status: 'IN_PROGRESS' } : row)),
        );
        expect(await service.getDetail(untouched.id, client.id)).toEqual(untouched);
        expect(after.events).toEqual(expect.arrayContaining(before.events));
        expect(after.events).toHaveLength(before.events.length + 1);
        expect(after.events.filter(({ type }) => type === 'ISSUE_STARTED')).toEqual([
          {
            id: expect.any(String),
            projectId,
            actorId: developer.id,
            type: 'ISSUE_STARTED',
            issueId: issue.id,
            versionId: null,
            memberId: null,
            createdAt: expect.any(Date),
          },
        ]);
        const activity = await module!.get(ActivityService).listForMember(projectId, client.id);
        expect(activity.filter(({ type }) => type === 'ISSUE_STARTED')).toEqual([
          expect.objectContaining({ actorName: developer.name, issue: { id: issue.id, number: issue.number } }),
        ]);
      },
    );

    it.each(['개발자', '클라이언트', '승인자'] as const)(
      'lockIssue는 활성 %s에게 쪽지의 프로젝트·작성자·상태와 역할을 주고 아무것도 바꾸지 않는다',
      async (role) => {
        const issue = await service.create(projectId, client.id, input());
        await prisma.issue.update({ where: { id: issue.id }, data: { status: 'IN_PROGRESS' } });
        const user = { 개발자: developer, 클라이언트: client, 승인자: approver }[role];
        const before = await readState();
        expect(await prisma.$transaction((tx) => service.lockIssue(tx, issue.id, user.id))).toEqual({
          projectId,
          authorId: client.id,
          status: 'IN_PROGRESS',
          role: role === '개발자' ? 'DEVELOPER' : 'CLIENT',
        });
        expect(await readState()).toEqual(before);
      },
    );

    it.each(['멤버 아님', '철회된 작성자', '철회된 개발자', '없는 쪽지'] as const)(
      'lockIssue와 start는 %s에게 버전·개발자 검사보다 먼저 없는 쪽지 404를 준다',
      async (scenario) => {
        const issue = await service.create(projectId, client.id, input());
        const userId = scenario === '멤버 아님' ? outsider.id : scenario === '철회된 개발자' ? developer.id : client.id;
        if (scenario === '철회된 작성자' || scenario === '철회된 개발자') {
          await prisma.projectMember.update({
            where: { projectId_userId: { projectId, userId } },
            data: { revokedAt: new Date() },
          });
        }
        const targetId = scenario === '없는 쪽지' ? missingId : issue.id;
        const before = await readState();
        await expect(prisma.$transaction((tx) => service.lockIssue(tx, targetId, userId))).rejects.toMatchObject(
          notFound('없는 쪽지예요'),
        );
        await expect(service.start(targetId, userId, missingId)).rejects.toMatchObject(notFound('없는 쪽지예요'));
        expect(await readState()).toEqual(before);
      },
    );

    it.each(['클라이언트', '승인자', '다른 프로젝트의 개발자'] as const)(
      'start는 %s에게 현재·지난 버전 모두 403을 주고 상태·일지를 바꾸지 않는다',
      async (role) => {
        const targetProjectId = role === '다른 프로젝트의 개발자' ? otherProjectId : projectId;
        const targetVersion = role === '다른 프로젝트의 개발자' ? otherCurrent : current;
        const user = { 클라이언트: client, 승인자: approver, '다른 프로젝트의 개발자': developer }[role];
        const issue = await service.create(targetProjectId, user.id, input({ versionId: targetVersion.id }));
        const next = await publishVersion(targetProjectId);
        const before = await readState();
        await expect(service.start(issue.id, user.id, targetVersion.id)).rejects.toMatchObject(developerOnly);
        await expect(service.start(issue.id, user.id, next.id)).rejects.toMatchObject(developerOnly);
        expect(await readState()).toEqual(before);
      },
    );

    it.each(['지난 버전', '게시 전 버전', '남의 프로젝트 버전', '없는 id', '현재 버전 없음'] as const)(
      'start는 %s이면 VERSION_CHANGED이고 상태·일지가 그대로다',
      async (scenario) => {
        const issue = await service.create(projectId, client.id, input());
        let viewedVersionId = missingId;
        if (scenario === '지난 버전') {
          viewedVersionId = current.id;
          await publishVersion();
        }
        if (scenario === '게시 전 버전') {
          viewedVersionId = (await prisma.deliveryVersion.create({ data: { projectId } })).id;
        }
        if (scenario === '남의 프로젝트 버전') viewedVersionId = otherCurrent.id;
        if (scenario === '현재 버전 없음') {
          viewedVersionId = current.id;
          await prisma.project.update({ where: { id: projectId }, data: { currentVersionId: null } });
        }
        const before = await readState();
        await expect(service.start(issue.id, developer.id, viewedVersionId)).rejects.toMatchObject(versionChanged);
        expect(await readState()).toEqual(before);
      },
    );

    it('start는 지난 버전의 쪽지도 현재 버전 id로 시작하고 처음 위치는 바꾸지 않는다', async () => {
      const issue = await service.create(
        projectId,
        client.id,
        input({ pin: { screenId: screen.id, xRatio: 0.2, yRatio: 0.8 } }),
      );
      const next = await publishVersion();
      expect(await service.start(issue.id, developer.id, next.id)).toEqual({
        ...issue,
        currentVersion: { id: next.id, status: 'IN_REVIEW' },
        status: 'IN_PROGRESS',
        isMine: false,
        canReview: false,
      });
    });

    it('start는 현재 버전이 승인되면 VERSION_NOT_IN_REVIEW이고 상태·일지가 그대로다', async () => {
      const issue = await service.create(projectId, client.id, input());
      await prisma.deliveryVersion.update({ where: { id: current.id }, data: { status: 'APPROVED' } });
      const before = await readState();
      await expect(service.start(issue.id, developer.id, current.id)).rejects.toMatchObject(versionNotInReview);
      expect(await readState()).toEqual(before);
    });

    it('start는 버전 검사를 OPEN 검사보다 먼저 하고 이미 수정 중인 쪽지의 일지를 더 쓰지 않는다', async () => {
      const issue = await service.create(projectId, client.id, input());
      await service.start(issue.id, developer.id, current.id);
      const before = await readState();
      await expect(service.start(issue.id, developer.id, current.id)).rejects.toMatchObject(issueNotOpen);
      await expect(service.start(issue.id, developer.id, missingId)).rejects.toMatchObject(versionChanged);
      await prisma.deliveryVersion.update({ where: { id: current.id }, data: { status: 'APPROVED' } });
      await expect(service.start(issue.id, developer.id, missingId)).rejects.toMatchObject(versionChanged);
      await expect(service.start(issue.id, developer.id, current.id)).rejects.toMatchObject(versionNotInReview);
      expect(await readState()).toEqual(before);
      expect(before.events.filter(({ type }) => type === 'ISSUE_STARTED')).toHaveLength(1);
    });

    it('start를 동시에 두 번 보내면 하나만 성공하고 나머지는 ISSUE_NOT_OPEN이며 일지는 하나다', async () => {
      const issue = await service.create(projectId, client.id, input());
      const results = await Promise.allSettled([
        service.start(issue.id, developer.id, current.id),
        service.start(issue.id, developer.id, current.id),
      ]);
      expect(results.filter(({ status }) => status === 'fulfilled')).toEqual([
        { status: 'fulfilled', value: { ...issue, status: 'IN_PROGRESS', isMine: false, canReview: false } },
      ]);
      expect(results.filter(({ status }) => status === 'rejected')).toEqual([
        { status: 'rejected', reason: expect.objectContaining(issueNotOpen) },
      ]);
      expect(await prisma.activityEvent.findMany({ where: { type: 'ISSUE_STARTED' } })).toEqual([
        expect.objectContaining({ issueId: issue.id, actorId: developer.id, projectId }),
      ]);
      expect(await service.getDetail(issue.id, client.id)).toEqual({ ...issue, status: 'IN_PROGRESS' });
    });

    it.each(['쪽지 상태 변경', '멤버 철회', '개발자 역할 변경', '새 버전 게시', '현재 버전 승인'] as const)(
      'start는 Project 잠금을 기다린 뒤 %s를 다시 읽고 거절한다',
      async (change) => {
        const issue = await service.create(projectId, client.id, input());
        const before = await readState();
        let pending: Promise<unknown> | undefined;
        let settled = false;
        try {
          await prisma.$transaction(
            async (tx) => {
              await tx.$queryRaw`SELECT id FROM projects WHERE id = ${projectId}::uuid FOR UPDATE`;
              const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
              pending = service
                .start(issue.id, developer.id, current.id)
                .catch((error: unknown) => error)
                .finally(() => {
                  settled = true;
                });
              // start가 실제로 Project 행 잠금을 기다린 뒤에만 다른 연결의 변경을 커밋한다.
              await vi.waitFor(
                async () => {
                  const [{ waiting }] = await prisma.$queryRaw<{ waiting: boolean }[]>`
                SELECT EXISTS (
                  SELECT 1 FROM pg_stat_activity
                  WHERE datname = current_database() AND ${pid}::int = ANY(pg_blocking_pids(pid))
                    AND query ILIKE '%projects%' AND query ILIKE '%FOR UPDATE%'
                ) AS waiting
              `;
                  expect(settled).toBe(false);
                  expect(waiting).toBe(true);
                },
                { timeout: 2_000, interval: 20 },
              );
              if (change === '쪽지 상태 변경') {
                await tx.issue.update({ where: { id: issue.id }, data: { status: 'IN_PROGRESS' } });
                return;
              }
              if (change === '멤버 철회') {
                await tx.projectMember.update({
                  where: { projectId_userId: { projectId, userId: developer.id } },
                  data: { revokedAt: new Date() },
                });
                return;
              }
              if (change === '개발자 역할 변경') {
                await tx.projectMember.update({
                  where: { projectId_userId: { projectId, userId: developer.id } },
                  data: { role: 'CLIENT' },
                });
                return;
              }
              if (change === '현재 버전 승인') {
                await tx.deliveryVersion.update({ where: { id: current.id }, data: { status: 'APPROVED' } });
                return;
              }
              const next = await tx.deliveryVersion.create({
                data: { projectId, number: 1, status: 'IN_REVIEW', publishedAt: new Date() },
              });
              await tx.project.update({ where: { id: projectId }, data: { currentVersionId: next.id } });
            },
            { maxWait: 5_000, timeout: 10_000 },
          );
        } finally {
          await pending;
        }
        const expected = {
          '쪽지 상태 변경': issueNotOpen,
          '멤버 철회': notFound('없는 쪽지예요'),
          '개발자 역할 변경': developerOnly,
          '새 버전 게시': versionChanged,
          '현재 버전 승인': versionNotInReview,
        };
        expect(await pending).toMatchObject(expected[change]);
        expect(await readState()).toEqual({
          ...before,
          issues: before.issues.map((row) => ({
            ...row,
            status: change === '쪽지 상태 변경' ? 'IN_PROGRESS' : 'OPEN',
          })),
        });
      },
      20_000,
    );

    it('start가 일지 저장에서 실패하면 상태가 접수로 되돌아가고 다시 시작할 수 있다', async () => {
      const issue = await service.create(projectId, client.id, input());
      const before = await readState();
      try {
        await prisma.$executeRaw`
          CREATE FUNCTION issues_service_fail_start_event() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF NEW.type = 'ISSUE_STARTED' THEN
              RAISE EXCEPTION 'issues service start event failure';
            END IF;
            RETURN NEW;
          END;
          $$
        `;
        await prisma.$executeRaw`
          CREATE TRIGGER issues_service_fail_start_event
          BEFORE INSERT ON activity_events FOR EACH ROW
          EXECUTE FUNCTION issues_service_fail_start_event()
        `;
        await expect(service.start(issue.id, developer.id, current.id)).rejects.toThrow(
          'issues service start event failure',
        );
        expect(await readState()).toEqual(before);
        expect(await service.getDetail(issue.id, client.id)).toEqual(issue);
      } finally {
        try {
          await prisma.$executeRaw`DROP TRIGGER IF EXISTS issues_service_fail_start_event ON activity_events`;
        } finally {
          await prisma.$executeRaw`DROP FUNCTION IF EXISTS issues_service_fail_start_event()`;
        }
      }
      expect(await service.start(issue.id, developer.id, current.id)).toEqual({
        ...issue,
        status: 'IN_PROGRESS',
        isMine: false,
        canReview: false,
      });
      expect(await prisma.activityEvent.count({ where: { issueId: issue.id, type: 'ISSUE_STARTED' } })).toBe(1);
    });
  });
});
