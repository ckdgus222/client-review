import { PrismaService } from '../src/prisma/prisma.service.js';
import { resetDatabase } from './reset-database.js';

const deleteRequestedAt = new Date('2026-11-14T03:00:00Z');
const mismatchedStates = [
  {
    status: 'DELETE_PENDING',
    statusBeforeDelete: 'ACTIVE',
    deleteRequestedAt: null,
    constraint: 'projects_delete_requested_at_check',
  },
  {
    status: 'DELETE_PENDING',
    statusBeforeDelete: null,
    deleteRequestedAt,
    constraint: 'projects_status_before_delete_check',
  },
  {
    status: 'ACTIVE',
    statusBeforeDelete: null,
    deleteRequestedAt,
    constraint: 'projects_delete_requested_at_check',
  },
  {
    status: 'ARCHIVED',
    statusBeforeDelete: null,
    deleteRequestedAt,
    constraint: 'projects_delete_requested_at_check',
  },
  {
    status: 'ACTIVE',
    statusBeforeDelete: 'ARCHIVED',
    deleteRequestedAt: null,
    constraint: 'projects_status_before_delete_check',
  },
  {
    status: 'ARCHIVED',
    statusBeforeDelete: 'ACTIVE',
    deleteRequestedAt: null,
    constraint: 'projects_status_before_delete_check',
  },
] as const;

describe('프로젝트 상태 테이블 (e2e)', () => {
  let prisma: PrismaService;

  beforeEach(async () => {
    prisma = new PrismaService();
    await resetDatabase(prisma);
  });

  afterEach(async () => {
    await prisma?.$disconnect();
  });

  it('새 프로젝트의 기본 상태는 ACTIVE이고 삭제 시각과 삭제 전 상태는 비어 있다', async () => {
    // ORM이 값을 채우지 않도록 필수 칸만 SQL로 넣어 DB 기본값을 확인한다.
    const [project] = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO projects (name) VALUES ('새 프로젝트') RETURNING id
    `;

    expect(await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).toMatchObject({
      name: '새 프로젝트',
      status: 'ACTIVE',
      statusBeforeDelete: null,
      deleteRequestedAt: null,
    });
  });

  it.each([
    { status: 'ACTIVE', statusBeforeDelete: null, deleteRequestedAt: null },
    { status: 'ARCHIVED', statusBeforeDelete: null, deleteRequestedAt: null },
    { status: 'DELETE_PENDING', statusBeforeDelete: 'ACTIVE', deleteRequestedAt },
    { status: 'DELETE_PENDING', statusBeforeDelete: 'ARCHIVED', deleteRequestedAt },
  ] as const)('$status 상태에 삭제 전 상태가 $statusBeforeDelete인 올바른 줄을 저장한다', async (data) => {
    const project = await prisma.project.create({ data: { name: '상태 검수 프로젝트', ...data } });

    expect(await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).toMatchObject(data);
  });

  it('삭제 대기와 시각·삭제 전 상태는 함께 있거나 함께 없다', async () => {
    // 각 줄은 CHECK 하나만 어긴다. 다른 제약이 대신 막아 테스트가 통과하지 않게 한다.
    for (const data of mismatchedStates) {
      await expect(prisma.$executeRaw`
        INSERT INTO projects (name, status, status_before_delete, delete_requested_at)
        VALUES ('어긋난 상태', ${data.status}::project_status,
                ${data.statusBeforeDelete}::project_status, ${data.deleteRequestedAt}::timestamptz)
      `).rejects.toThrowError(data.constraint);

      expect(await prisma.project.count()).toBe(0);
    }
  });

  it('저장된 줄도 삭제 대기와 시각·삭제 전 상태가 어긋나게 바꿀 수 없다', async () => {
    const project = await prisma.project.create({ data: { name: '유지할 프로젝트' } });

    for (const data of mismatchedStates) {
      await expect(prisma.$executeRaw`
        UPDATE projects
        SET status = ${data.status}::project_status,
            status_before_delete = ${data.statusBeforeDelete}::project_status,
            delete_requested_at = ${data.deleteRequestedAt}::timestamptz
        WHERE id = ${project.id}::uuid
      `).rejects.toThrowError(data.constraint);

      expect(await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).toEqual(project);
    }
  });

  it('삭제 전 상태로 삭제 대기를 적을 수 없다', async () => {
    await expect(prisma.$executeRaw`
      INSERT INTO projects (name, status, status_before_delete, delete_requested_at)
      VALUES ('잘못된 삭제 전 상태', 'DELETE_PENDING', 'DELETE_PENDING', ${deleteRequestedAt})
    `).rejects.toThrowError('projects_status_before_delete_value_check');
    expect(await prisma.project.count()).toBe(0);

    const project = await prisma.project.create({
      data: {
        name: '삭제 대기 프로젝트',
        status: 'DELETE_PENDING',
        statusBeforeDelete: 'ARCHIVED',
        deleteRequestedAt,
      },
    });

    await expect(prisma.$executeRaw`
      UPDATE projects SET status_before_delete = 'DELETE_PENDING' WHERE id = ${project.id}::uuid
    `).rejects.toThrowError('projects_status_before_delete_value_check');

    expect(await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).toEqual(project);
  });

  it.each(['ACTIVE', 'ARCHIVED'] as const)(
    '%s에서 삭제 대기 정보 셋을 함께 바꾸고 함께 비우면 원래 상태로 저장된다',
    async (status) => {
      const project = await prisma.project.create({ data: { name: '상태 변경 프로젝트', status } });
      const pendingState = { status: 'DELETE_PENDING' as const, statusBeforeDelete: status, deleteRequestedAt };

      await prisma.project.update({ where: { id: project.id }, data: pendingState });

      expect(await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).toEqual({
        ...project,
        ...pendingState,
      });

      await prisma.project.update({
        where: { id: project.id },
        data: { status, statusBeforeDelete: null, deleteRequestedAt: null },
      });

      expect(await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).toEqual(project);
    },
  );

  it.each(['PROJECT_ARCHIVED', 'PROJECT_UNARCHIVED', 'PROJECT_DELETE_REQUESTED', 'PROJECT_RESTORED'] as const)(
    '%s 사건을 버전·멤버·쪽지 없이 저장한다',
    async (type) => {
      const developer = await prisma.user.create({ data: { email: 'developer@example.com', name: '개발자' } });
      const project = await prisma.project.create({
        data: {
          name: '사건 검수 프로젝트',
          members: { create: { userId: developer.id, role: 'DEVELOPER' } },
        },
      });
      const event = await prisma.activityEvent.create({
        data: { projectId: project.id, actorId: developer.id, type },
      });

      expect(await prisma.activityEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({
        projectId: project.id,
        actorId: developer.id,
        type,
        versionId: null,
        memberId: null,
        issueId: null,
      });
    },
  );

  it('삭제 대기의 삭제 요청 시각만 찾는 부분 인덱스가 있다', async () => {
    const indexes = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = current_schema() AND tablename = 'projects'
        AND indexname = 'projects_delete_requested_at_idx'
    `;

    expect(indexes).toHaveLength(1);
    expect(indexes[0].indexdef).toMatch(/USING btree \(delete_requested_at\)/);
    expect(indexes[0].indexdef).toMatch(/WHERE \(status = 'DELETE_PENDING'::project_status\)$/);
  });

  it('resetDatabase는 보관·삭제 대기 프로젝트와 새 사건도 비운다', async () => {
    const developer = await prisma.user.create({ data: { email: 'developer@example.com', name: '개발자' } });
    await prisma.project.create({ data: { name: '보관 프로젝트', status: 'ARCHIVED' } });
    const project = await prisma.project.create({
      data: {
        name: '삭제 대기 프로젝트',
        status: 'DELETE_PENDING',
        statusBeforeDelete: 'ARCHIVED',
        deleteRequestedAt,
        members: { create: { userId: developer.id, role: 'DEVELOPER' } },
      },
    });
    await prisma.activityEvent.create({
      data: { projectId: project.id, actorId: developer.id, type: 'PROJECT_DELETE_REQUESTED' },
    });
    expect(await prisma.project.count()).toBe(2);
    expect(await prisma.activityEvent.count()).toBe(1);

    await resetDatabase(prisma);

    expect(await prisma.project.count()).toBe(0);
    expect(await prisma.activityEvent.count()).toBe(0);
    expect(await prisma.projectMember.count()).toBe(0);
    expect(await prisma.user.count()).toBe(0);
  });
});
