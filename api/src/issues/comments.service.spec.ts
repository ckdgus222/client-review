import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { resetDatabase } from '../../test/reset-database.js';
import { ActivityService } from '../activity/activity.service.js';
import type { DeliveryVersion, User } from '../generated/prisma/client.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { CommentsService, type NewComment } from './comments.service.js';
import { IssuesService } from './issues.service.js';

const notFound = { status: 404, response: { statusCode: 404, message: '없는 쪽지예요', error: 'Not Found' } };
const versionChanged = {
  status: 409,
  response: { statusCode: 409, code: 'VERSION_CHANGED', message: '새 버전이 올라왔어요' },
};
const versionNotInReview = {
  status: 409,
  response: { statusCode: 409, code: 'VERSION_NOT_IN_REVIEW', message: '검수 중인 버전이 아니에요' },
};
const missingId = '00000000-0000-4000-8000-000000000001';

describe('CommentsService', () => {
  let module: TestingModule | undefined;
  let prisma: PrismaService;
  let service: CommentsService;
  let developer: User;
  let client: User;
  let outsider: User;
  let projectId: string;
  let issueId: string;
  let current: DeliveryVersion;

  const input = (changes: Partial<NewComment> = {}): NewComment => ({
    requestId: randomUUID(),
    versionId: current.id,
    body: '확인 부탁드려요',
    ...changes,
  });
  const readState = async () => ({
    comments: await prisma.comment.findMany({ orderBy: { id: 'asc' } }),
    issues: await prisma.issue.findMany({ orderBy: { id: 'asc' } }),
    events: await prisma.activityEvent.findMany({ orderBy: { id: 'asc' } }),
  });
  const publishVersion = async (number: number, targetProjectId = projectId) => {
    const version = await prisma.deliveryVersion.create({
      data: { projectId: targetProjectId, number, status: 'IN_REVIEW', publishedAt: new Date() },
    });
    await prisma.project.update({ where: { id: targetProjectId }, data: { currentVersionId: version.id } });
    return version;
  };

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [CommentsService, IssuesService, ProjectsService, ActivityService],
    }).compile();
    prisma = module.get(PrismaService);
    service = module.get(CommentsService);
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    developer = await prisma.user.create({ data: { email: 'developer@example.com', name: '개발자' } });
    client = await prisma.user.create({ data: { email: 'client@example.com', name: '클라이언트' } });
    outsider = await prisma.user.create({ data: { email: 'outsider@example.com', name: '외부인' } });
    const project = await prisma.project.create({
      data: {
        name: '댓글 검수',
        members: {
          create: [
            { userId: developer.id, role: 'DEVELOPER' },
            { userId: client.id, role: 'CLIENT' },
          ],
        },
      },
    });
    projectId = project.id;
    current = await publishVersion(0);
    const issue = await prisma.issue.create({
      data: {
        projectId,
        originVersionId: current.id,
        number: 1,
        authorId: client.id,
        requestId: randomUUID(),
        title: '버튼 수정',
        body: '',
      },
    });
    issueId = issue.id;
  });

  afterAll(async () => {
    await module?.close();
  });

  it('남의 쪽지에 현재 버전의 댓글 하나를 저장하고 공개 응답만 돌려주며 일지는 쓰지 않는다', async () => {
    const next = await publishVersion(1);
    const request = input({ versionId: next.id });
    const before = await readState();
    const result = await service.create(issueId, developer.id, request);
    expect(result).toEqual({
      id: expect.any(String),
      authorName: developer.name,
      versionNumber: 1,
      body: request.body,
      createdAt: expect.any(Date),
    });
    expect(await prisma.comment.findMany()).toEqual([
      {
        id: result.id,
        issueId,
        authorId: developer.id,
        versionId: next.id,
        body: request.body,
        requestId: request.requestId,
        createdAt: result.createdAt,
      },
    ]);
    const after = await readState();
    expect(after.issues).toEqual(before.issues);
    expect(after.events).toEqual(before.events);
  });

  it.each(['없는 쪽지', '멤버 아님', '철회된 멤버'] as const)(
    '%s이면 같은 404이고 저장하지 않는다',
    async (scenario) => {
      if (scenario === '철회된 멤버') {
        await prisma.projectMember.update({
          where: { projectId_userId: { projectId, userId: developer.id } },
          data: { revokedAt: new Date() },
        });
      }
      const before = await readState();
      await expect(
        service.create(
          scenario === '없는 쪽지' ? missingId : issueId,
          scenario === '멤버 아님' ? outsider.id : developer.id,
          input(),
        ),
      ).rejects.toMatchObject(notFound);
      expect(await readState()).toEqual(before);
    },
  );

  it.each(['새 버전 게시', '현재 버전 승인'] as const)('재전송 확인은 %s의 버전 검사보다 먼저다', async (change) => {
    const request = input();
    const first = await service.create(issueId, developer.id, request);
    if (change === '새 버전 게시') await publishVersion(1);
    if (change === '현재 버전 승인') {
      await prisma.deliveryVersion.update({ where: { id: current.id }, data: { status: 'APPROVED' } });
    }
    const before = await readState();
    await expect(service.create(issueId, developer.id, { ...request, body: '고친 글' })).resolves.toEqual(first);
    expect(await readState()).toEqual(before);
  });

  it('재전송 확인은 이 쪽지로 좁혀 다른 쪽지의 댓글을 반환하지 않는다', async () => {
    const request = input();
    await service.create(issueId, developer.id, request);
    const other = await prisma.issue.create({
      data: {
        projectId,
        originVersionId: current.id,
        number: 2,
        authorId: client.id,
        requestId: randomUUID(),
        title: '다른 쪽지',
        body: '',
      },
    });
    const before = await readState();
    await expect(service.create(other.id, developer.id, request)).rejects.toMatchObject({
      status: 409,
      response: { statusCode: 409, code: 'REQUEST_ID_REUSED', message: '이미 쓴 요청 번호예요' },
    });
    expect(await readState()).toEqual(before);
  });

  it('재전송 확인은 작성자와 requestId도 구분한다', async () => {
    const request = input();
    const first = await service.create(issueId, developer.id, request);
    const otherAuthor = await service.create(issueId, client.id, request);
    const otherRequest = await service.create(issueId, developer.id, input());
    expect(new Set([first.id, otherAuthor.id, otherRequest.id]).size).toBe(3);
    expect(otherAuthor.authorName).toBe(client.name);
    expect(await prisma.comment.count()).toBe(3);
  });

  it.each(['지난 버전', '게시 전 버전', '다른 프로젝트 현재 버전', '없는 버전', '현재 버전 없음'] as const)(
    '%s을 보내면 VERSION_CHANGED이고 저장하지 않는다',
    async (scenario) => {
      let versionId = missingId;
      if (scenario === '지난 버전') {
        versionId = current.id;
        await publishVersion(1);
      }
      if (scenario === '게시 전 버전') {
        versionId = (await prisma.deliveryVersion.create({ data: { projectId } })).id;
      }
      if (scenario === '다른 프로젝트 현재 버전') {
        const other = await prisma.project.create({
          data: { name: '다른 프로젝트', members: { create: { userId: developer.id, role: 'DEVELOPER' } } },
        });
        versionId = (await publishVersion(0, other.id)).id;
      }
      if (scenario === '현재 버전 없음') {
        versionId = current.id;
        await prisma.project.update({ where: { id: projectId }, data: { currentVersionId: null } });
      }
      const before = await readState();
      await expect(service.create(issueId, developer.id, input({ versionId }))).rejects.toMatchObject(versionChanged);
      expect(await readState()).toEqual(before);
    },
  );

  it('현재 버전이 승인됐으면 VERSION_NOT_IN_REVIEW이고 저장하지 않는다', async () => {
    await prisma.deliveryVersion.update({ where: { id: current.id }, data: { status: 'APPROVED' } });
    const before = await readState();
    await expect(service.create(issueId, developer.id, input())).rejects.toMatchObject(versionNotInReview);
    expect(await readState()).toEqual(before);
  });

  it.each(['멤버 철회', '재전송 전 멤버 철회', '새 버전 게시', '현재 버전 승인', '대기 중 같은 요청 저장'] as const)(
    'Project 잠금을 기다린 뒤 %s를 확인한다',
    async (change) => {
      const request = input();
      if (change === '재전송 전 멤버 철회') await service.create(issueId, developer.id, request);
      const before = await readState();
      let pending: Promise<unknown> | undefined;
      let settled = false;
      let savedId: string | undefined;
      try {
        await prisma.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT id FROM projects WHERE id = ${projectId}::uuid FOR UPDATE`;
            const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
            pending = service
              .create(issueId, developer.id, request)
              .catch((error: unknown) => error)
              .finally(() => {
                settled = true;
              });
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
            if (change === '멤버 철회' || change === '재전송 전 멤버 철회') {
              await tx.projectMember.update({
                where: { projectId_userId: { projectId, userId: developer.id } },
                data: { revokedAt: new Date() },
              });
              return;
            }
            if (change === '현재 버전 승인') {
              await tx.deliveryVersion.update({ where: { id: current.id }, data: { status: 'APPROVED' } });
              return;
            }
            if (change === '대기 중 같은 요청 저장') {
              const saved = await tx.comment.create({
                data: { issueId, authorId: developer.id, ...request },
              });
              savedId = saved.id;
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
      const result = await pending;
      if (change === '대기 중 같은 요청 저장') {
        expect(result).toEqual({
          id: savedId,
          authorName: developer.name,
          versionNumber: 0,
          body: request.body,
          createdAt: expect.any(Date),
        });
        expect(await prisma.comment.count()).toBe(1);
        return;
      }
      const expected = {
        '멤버 철회': notFound,
        '재전송 전 멤버 철회': notFound,
        '새 버전 게시': versionChanged,
        '현재 버전 승인': versionNotInReview,
      }[change];
      expect(result).toMatchObject(expected);
      expect(await readState()).toEqual(before);
    },
  );
});
