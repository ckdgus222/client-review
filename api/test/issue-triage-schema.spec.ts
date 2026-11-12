import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Prisma } from '../src/generated/prisma/client.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { resetDatabase } from './reset-database.js';

describe('쪽지 정리 테이블', () => {
  const prisma = new PrismaService();
  let issueData: Prisma.IssueUncheckedCreateInput;
  const invalidValues = [
    { field: 'category', column: Prisma.sql`category`, label: 'enum 밖의 값', value: Prisma.sql`'UNKNOWN'`, code: '22P02' },
    { field: 'scope', column: Prisma.sql`scope`, label: 'enum 밖의 값', value: Prisma.sql`'UNKNOWN'`, code: '22P02' },
    { field: 'category', column: Prisma.sql`category`, label: 'NULL', value: Prisma.sql`NULL`, code: '23502' },
    { field: 'scope', column: Prisma.sql`scope`, label: 'NULL', value: Prisma.sql`NULL`, code: '23502' },
  ] as const;

  beforeEach(async () => {
    await resetDatabase(prisma);
    const project = await prisma.project.create({ data: { name: '프로젝트' } });
    const version = await prisma.deliveryVersion.create({ data: { projectId: project.id } });
    const author = await prisma.user.create({ data: { email: 'author@example.com', name: '작성자' } });
    issueData = {
      projectId: project.id,
      originVersionId: version.id,
      authorId: author.id,
      number: 1,
      title: '수정해 주세요',
      body: '',
      requestId: randomUUID(),
    };
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('칸을 정하지 않고 DB에 넣은 쪽지는 버그, 하자 수정, 마감일 없음으로 보인다', async () => {
    const { projectId, originVersionId, authorId, number, title, body, requestId } = issueData;
    const [row] = await prisma.$queryRaw<{ id: string; category: string; scope: string; due_date: null }[]>`
      INSERT INTO issues (project_id, origin_version_id, author_id, number, title, body, request_id)
      VALUES (${projectId}::uuid, ${originVersionId}::uuid, ${authorId}::uuid, ${number}, ${title}, ${body}, ${requestId}::uuid)
      RETURNING id, category, scope, due_date
    `;

    expect(row).toEqual({ id: expect.any(String), category: 'BUG', scope: 'IN_SCOPE', due_date: null });
    expect(await prisma.issue.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      ...issueData,
      category: 'BUG',
      scope: 'IN_SCOPE',
      dueDate: null,
    });
  });

  it('category와 scope는 DB enum이고 due_date는 비워 둘 수 있는 date 칸이다', async () => {
    const columns = await prisma.$queryRaw<{
      column_name: string; data_type: string; udt_name: string; is_nullable: string;
    }[]>`
      SELECT column_name, data_type, udt_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'issues'
        AND column_name IN ('category', 'scope', 'due_date')
      ORDER BY column_name
    `;

    expect(columns).toEqual([
      { column_name: 'category', data_type: 'USER-DEFINED', udt_name: 'issue_category', is_nullable: 'NO' },
      { column_name: 'due_date', data_type: 'date', udt_name: 'date', is_nullable: 'YES' },
      { column_name: 'scope', data_type: 'USER-DEFINED', udt_name: 'issue_scope', is_nullable: 'NO' },
    ]);
    const enumValues = await prisma.$queryRaw<{ name: string; values: string[] }[]>`
      SELECT t.typname AS name, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS values
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = current_schema() AND t.typname IN ('issue_category', 'issue_scope')
      GROUP BY t.typname ORDER BY t.typname
    `;
    expect(enumValues).toEqual([
      { name: 'issue_category', values: ['BUG', 'DESIGN', 'COPY', 'OTHER'] },
      { name: 'issue_scope', values: ['IN_SCOPE', 'OUT_OF_SCOPE'] },
    ]);
  });

  it.each(['BUG', 'DESIGN', 'COPY', 'OTHER'] as const)('분류 %s를 저장하고 그대로 읽는다', async (category) => {
    const issue = await prisma.issue.create({ data: { ...issueData, category } });

    expect(await prisma.issue.findUniqueOrThrow({ where: { id: issue.id } })).toMatchObject({ category });
  });

  it.each(['IN_SCOPE', 'OUT_OF_SCOPE'] as const)('범위 %s를 저장하고 그대로 읽는다', async (scope) => {
    const issue = await prisma.issue.create({ data: { ...issueData, scope } });

    expect(await prisma.issue.findUniqueOrThrow({ where: { id: issue.id } })).toMatchObject({ scope });
  });

  it.each(invalidValues)('$field에 $label를 넣으면 DB가 거부하고 쪽지가 생기지 않는다', async ({ column, value, code }) => {
    const { projectId, originVersionId, authorId, requestId } = issueData;

    // enum으로 직접 형변환하지 않아 칸의 제약 자체가 잘못된 입력을 막는지 확인한다.
    await expect(prisma.$executeRaw`
      INSERT INTO issues (project_id, origin_version_id, author_id, number, title, body, request_id, ${column})
      VALUES (${projectId}::uuid, ${originVersionId}::uuid, ${authorId}::uuid, 1, '쪽지', '', ${requestId}::uuid, ${value})
    `).rejects.toMatchObject({ code: 'P2010', message: expect.stringContaining(code) });
    expect(await prisma.issue.count()).toBe(0);
  });

  it.each(invalidValues)('$field를 $label로 바꾸면 DB가 거부하고 기존 쪽지가 그대로다', async ({ column, value, code }) => {
    const issue = await prisma.issue.create({ data: issueData });

    await expect(prisma.$executeRaw`
      UPDATE issues SET ${column} = ${value} WHERE id = ${issue.id}::uuid
    `).rejects.toMatchObject({ code: 'P2010', message: expect.stringContaining(code) });
    expect(await prisma.issue.findMany()).toEqual([issue]);
  });

  it.each(['2024-02-29', '2026-12-31', '2027-01-01'])('마감일 %s는 DB 시간대가 달라도 넣은 날짜 그대로 읽힌다', async (date) => {
    const dueDate = new Date(`${date}T00:00:00.000Z`);
    const issue = await prisma.issue.create({ data: { ...issueData, dueDate } });

    for (const timeZone of ['UTC', 'Asia/Seoul', 'America/Los_Angeles']) {
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT set_config('TimeZone', ${timeZone}, true)`;
        const [row] = await tx.$queryRaw<{ due_date: string; column_type: string }[]>`
          SELECT to_char(due_date, 'YYYY-MM-DD') AS due_date, pg_typeof(due_date)::text AS column_type
          FROM issues WHERE id = ${issue.id}::uuid
        `;

        expect(row).toEqual({ due_date: date, column_type: 'date' });
        expect(await tx.issue.findUniqueOrThrow({ where: { id: issue.id } })).toMatchObject({ dueDate });
      });
    }
  });

  it('마감일에 시각을 함께 넣어도 날짜만 저장된다', async () => {
    const issue = await prisma.issue.create({
      data: { ...issueData, dueDate: new Date('2026-11-15T23:59:59.999Z') },
    });

    expect(await prisma.issue.findUniqueOrThrow({ where: { id: issue.id } })).toMatchObject({
      dueDate: new Date('2026-11-15T00:00:00.000Z'),
    });
  });

  it('정해 둔 마감일을 NULL로 지워도 다른 칸은 그대로다', async () => {
    const issue = await prisma.issue.create({
      data: { ...issueData, category: 'DESIGN', scope: 'OUT_OF_SCOPE', dueDate: new Date('2026-11-15T00:00:00.000Z') },
    });
    await prisma.issue.update({ where: { id: issue.id }, data: { dueDate: null } });

    expect(await prisma.issue.findMany()).toEqual([{ ...issue, dueDate: null }]);
  });

  it.each([
    ['2026-02-30', Prisma.sql`'2026-02-30'`],
    ['2026-13-01', Prisma.sql`'2026-13-01'`],
  ])('달력에 없는 마감일 %s는 DB가 거부하고 기존 날짜를 보존한다', async (_, date) => {
    const issue = await prisma.issue.create({
      data: { ...issueData, dueDate: new Date('2026-11-15T00:00:00.000Z') },
    });

    await expect(prisma.$executeRaw`
      UPDATE issues SET due_date = ${date} WHERE id = ${issue.id}::uuid
    `).rejects.toMatchObject({ code: 'P2010', message: expect.stringContaining('22008') });
    expect(await prisma.issue.findMany()).toEqual([issue]);
  });
});

describe('쪽지 정리 마이그레이션', () => {
  it('이미 있던 쪽지에도 category와 scope의 NOT NULL 기본값을 주고 due_date는 비워 둔다', () => {
    const sql = readFileSync(
      new URL('../prisma/migrations/20261112093000_add_issue_triage/migration.sql', import.meta.url),
      'utf8',
    ).replace(/--[^\n]*/g, '');

    expect(sql).toMatch(/ALTER\s+TABLE\s+"issues"\s+ADD\s+COLUMN/i);
    expect(sql).toMatch(/ADD\s+COLUMN\s+"category"\s+"issue_category"\s+NOT\s+NULL\s+DEFAULT\s+'BUG'/i);
    expect(sql).toMatch(/ADD\s+COLUMN\s+"scope"\s+"issue_scope"\s+NOT\s+NULL\s+DEFAULT\s+'IN_SCOPE'/i);
    expect(sql).toMatch(/ADD\s+COLUMN\s+"due_date"\s+DATE\s*;/i);
  });
});
