import { readFile } from 'node:fs/promises';
import { ActivityType, type Prisma, ProjectRole } from '../generated/prisma/client.js';
import type { NotificationEvent } from '../notifications/notification-message.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { withdrawUserIn } from './withdraw-user.js';

// 백업으로 복원한 뒤, 백업 뒤에 생긴 일을 다시 적용한다(docs/deploy.md 정할 것 16, 절차는 docs/operations.md).
// 입력은 개발자 메일함의 기록 메일 본문과 운영 기록 항목을 빈 줄로 나눠 붙여 넣은 글이고, 항목은 모두 "열쇠: 값" 줄이다.
// api를 켜기 전에 돈다. 한 트랜잭션이라 기록 하나라도 틀리면 아무것도 바뀌지 않는다. 같은 글을 두 번 적용해도 결과가 같다.

const REDACTED_TEXT = '[요청으로 지운 내용]';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// DB가 만든 백만분의 1초 시각 글자다. 모양이 늘 같아서 글자 비교가 곧 시각 비교다.
// Date로 바꾸면 천분의 1초 아래가 잘려서 같은 밀리초에 생긴 두 사건의 순서가 뒤집힐 수 있다.
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

// 기록 메일의 사건마다 대상 멤버가 꼭 있어야 하는지(required), 없어야 하는지(none), 둘 다 되는지(optional).
const PROJECT_EVENTS = {
  [ActivityType.MEMBER_REVOKED]: 'required',
  [ActivityType.INVITATION_ACCEPTED]: 'required',
  [ActivityType.APPROVER_CHANGED]: 'optional',
  [ActivityType.PROJECT_DELETE_REQUESTED]: 'none',
  [ActivityType.PROJECT_RESTORED]: 'none',
  [ActivityType.PROJECT_ARCHIVED]: 'none',
  [ActivityType.PROJECT_UNARCHIVED]: 'none',
} as const;
type ProjectEvent = keyof typeof PROJECT_EVENTS;

// 기록 메일을 쓰는 쪽(notification-message.ts)의 멤버 칸과 같은 타입을 쓴다. 칸이 바뀌면 읽는 쪽도 컴파일에서 걸린다.
type Member = NonNullable<NotificationEvent['member']>;
type RedactionTarget =
  | { table: 'issues.title' | 'issues.body' | 'comments.body' | 'issue_attachments'; rowId: string }
  | { table: 'approvals.summary'; rowId: string; issueNumber: number };
type ProjectRecord = { event: ProjectEvent; id: string; time: string; projectId: string; member: Member | null };
type WithdrawalRecord = { event: 'USER_WITHDRAWN'; id: string; time: string; userId: string };
type RedactionRecord = { event: 'CONTENT_REDACTED'; id: string; time: string; target: RedactionTarget };
type ReplayRecord = ProjectRecord | WithdrawalRecord | RedactionRecord;

export type ReplayResult = { applied: number; skippedBeforeSince: number; skipped: string[] };

const isProjectEvent = (event: string): event is ProjectEvent => event in PROJECT_EVENTS;
const isProjectRecord = (record: ReplayRecord): record is ProjectRecord => isProjectEvent(record.event);

const parseFields = (block: string) => {
  const fields = new Map<string, string>();
  for (const line of block.split(/\r?\n/).map((text) => text.trim())) {
    const separator = line.indexOf(': ');
    if (separator < 0) throw new Error(`"열쇠: 값" 모양이 아닌 줄이 있어요: ${line}`);
    const key = line.slice(0, separator);
    // 이름에 줄바꿈과 "사건: …"을 넣어 다른 항목을 끼워 넣으려는 시도를 여기서 막는다.
    if (fields.has(key)) throw new Error(`열쇠가 겹쳐요: ${key}`);
    fields.set(key, line.slice(separator + 2));
  }
  return fields;
};

// 열쇠를 하나씩 꺼내 쓴다. 다 꺼낸 뒤에도 남은 열쇠는 모르는 열쇠다.
const take = (fields: Map<string, string>, key: string, pattern?: RegExp) => {
  const value = fields.get(key);
  if (value === undefined) throw new Error(`열쇠가 빠졌어요: ${key}`);
  fields.delete(key);
  if (pattern && !pattern.test(value)) throw new Error(`${key} 값의 모양이 틀려요: ${value}`);
  return value;
};

// 이메일과 이름은 기록 메일이 JSON 문자열로 적는다(줄바꿈은 \n).
const takeJsonString = (fields: Map<string, string>, key: string) => {
  const raw = take(fields, key);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${key} 값이 JSON 문자열이 아니에요: ${raw}`);
  }
  if (typeof parsed !== 'string') throw new Error(`${key} 값이 JSON 문자열이 아니에요: ${raw}`);
  return parsed;
};

const parseMember = (event: ProjectEvent, fields: Map<string, string>): Member | null => {
  const rule = PROJECT_EVENTS[event];
  const id = take(fields, '대상 멤버 id');
  if (id === (event === 'APPROVER_CHANGED' ? '지정하지 않음' : '-')) {
    if (rule === 'required') throw new Error(`${event} 기록에 대상 멤버가 없어요`);
    return null;
  }
  if (rule === 'none') throw new Error(`${event} 기록에는 대상 멤버가 없어야 해요`);
  if (!UUID.test(id)) throw new Error(`대상 멤버 id 값의 모양이 틀려요: ${id}`);
  const role = take(fields, '대상 역할');
  if (role !== ProjectRole.CLIENT && role !== ProjectRole.DEVELOPER) {
    throw new Error(`대상 역할 값의 모양이 틀려요: ${role}`);
  }
  return {
    id,
    role,
    userId: take(fields, '대상 사용자 id', UUID),
    email: takeJsonString(fields, '대상 이메일'),
    name: takeJsonString(fields, '대상 이름'),
    joinedAt: take(fields, '대상 참여 시각', TIME),
  };
};

const parseTarget = (text: string): RedactionTarget => {
  const [table, rowId, issueNumber, ...rest] = text.split(' ');
  if (!UUID.test(rowId ?? '') || rest.length > 0) throw new Error(`대상 값의 모양이 틀려요: ${text}`);
  if (table === 'approvals.summary' && /^#\d+$/.test(issueNumber ?? '')) {
    return { table, rowId, issueNumber: Number(issueNumber.slice(1)) };
  }
  if (issueNumber !== undefined) throw new Error(`대상 값의 모양이 틀려요: ${text}`);
  if (
    table === 'issues.title' ||
    table === 'issues.body' ||
    table === 'comments.body' ||
    table === 'issue_attachments'
  ) {
    return { table, rowId };
  }
  throw new Error(`대상 값의 모양이 틀려요: ${text}`);
};

const parseRecord = (block: string): ReplayRecord => {
  const fields = parseFields(block);
  const event = take(fields, '사건');
  const id = take(fields, '사건 id', UUID);
  const time = take(fields, '시각', TIME);

  let record: ReplayRecord;
  if (event === 'USER_WITHDRAWN') {
    record = { event, id, time, userId: take(fields, '대상 사용자 id', UUID) };
  } else if (event === 'CONTENT_REDACTED') {
    record = { event, id, time, target: parseTarget(take(fields, '대상')) };
  } else if (isProjectEvent(event)) {
    const projectId = take(fields, '프로젝트 id', UUID);
    record = { event, id, time, projectId, member: parseMember(event, fields) };
  } else {
    throw new Error(`모르는 사건이에요: ${event}`);
  }
  if (fields.size > 0) throw new Error(`모르는 열쇠가 있어요: ${[...fields.keys()].join(', ')}`);
  return record;
};

// 탈퇴 처리가 바꾼 이메일(withdrawn-<id>@invalid)인지 본다.
const isAnonymized = (record: ReplayRecord) =>
  isProjectRecord(record) && record.member !== null && record.member.email.endsWith('@invalid');

// 사람 값(이메일·이름)을 뺀 나머지. 같은 사건의 사본끼리는 이것이 같아야 한다.
const withoutPersonValues = (record: ReplayRecord) =>
  JSON.stringify(
    isProjectRecord(record) && record.member
      ? { ...record, member: { ...record.member, email: '', name: '' } }
      : record,
  );

// 같은 사건 id의 사본은 하나로 친다. 발송기는 메일을 보낸 뒤 완료 기록에 실패하면 다시 보내는데,
// 그 사이에 그 사람이 탈퇴하면 사람 값만 다른 사본이 둘 생긴다. 그때는 익명화된 사본을 쓴다(탈퇴한 사람의 원래 이메일을 되살리지 않는다).
const dedupe = (records: ReplayRecord[]) => {
  const byId = new Map<string, ReplayRecord>();
  for (const record of records) {
    const kept = byId.get(record.id);
    if (kept && withoutPersonValues(kept) !== withoutPersonValues(record)) {
      throw new Error(`사건 id가 같은데 내용이 다른 기록이 있어요: ${record.id}`);
    }
    if (!kept || isAnonymized(record)) byId.set(record.id, record);
  }
  return [...byId.values()];
};

// 같은 프로젝트에서 시각이 완전히 같은 두 사건은 어느 것이 먼저인지 알 수 없다. 짐작해서 적용하지 않는다.
const assertOrderIsKnown = (records: ReplayRecord[]) => {
  const seen = new Set<string>();
  for (const record of records.filter(isProjectRecord)) {
    const key = `${record.projectId} ${record.time}`;
    if (seen.has(key))
      throw new Error(`한 프로젝트에 시각이 완전히 같은 기록이 둘 있어 순서를 알 수 없어요: ${record.time}`);
    seen.add(key);
  }
};

// 백업 뒤에 처음 들어온 사람은 복원된 DB에 없다. 기록에 적힌 값으로 사용자와 멤버를 같은 id로 만든다.
// 이미 있으면 그대로 둔다(백업에 있던 값이 기준이다).
const ensureMember = async (tx: Prisma.TransactionClient, projectId: string, member: Member) => {
  await tx.$executeRaw`
    INSERT INTO users (id, email, name) VALUES (${member.userId}::uuid, ${member.email}, ${member.name})
    ON CONFLICT (id) DO NOTHING
  `;
  await tx.$executeRaw`
    INSERT INTO project_members (id, project_id, user_id, role, created_at)
    VALUES (${member.id}::uuid, ${projectId}::uuid, ${member.userId}::uuid, ${member.role}::project_role, ${member.joinedAt}::timestamptz)
    ON CONFLICT (id) DO NOTHING
  `;
};

// 건너뛰었으면 그 까닭을 돌려준다.
const applyProjectRecord = async (tx: Prisma.TransactionClient, record: ProjectRecord) => {
  const { event, projectId, member, time } = record;
  const [project] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM projects WHERE id = ${projectId}::uuid FOR UPDATE
  `;
  // 백업 뒤에 만든 프로젝트는 백업에 없어서 되살릴 것이 없다.
  if (!project) return '복원된 DB에 없는 프로젝트';
  if (member) await ensureMember(tx, projectId, member);

  // 수락과 철회는 읽을 때 대상 멤버가 없으면 이미 거절했다. 아래 "&& member"는 타입을 좁히려는 것이다.
  if (event === 'INVITATION_ACCEPTED' && member) {
    // 철회됐다가 다시 수락한 사람이면 철회 시각을 비운다. 승인자였더라도 승인자 칸은 비워 둔 그대로다.
    await tx.$executeRaw`
      UPDATE project_members SET revoked_at = NULL WHERE id = ${member.id}::uuid AND project_id = ${projectId}::uuid
    `;
  } else if (event === 'MEMBER_REVOKED' && member) {
    // 철회 API와 같다: 승인자였으면 승인자 칸도 비운다. 나중에 다시 들어와도 승인자로 돌아오지 않는다.
    await tx.$executeRaw`
      UPDATE projects SET approver_member_id = NULL
      WHERE id = ${projectId}::uuid AND approver_member_id = ${member.id}::uuid
    `;
    await tx.$executeRaw`
      UPDATE project_members SET revoked_at = ${time}::timestamptz
      WHERE id = ${member.id}::uuid AND project_id = ${projectId}::uuid
    `;
  } else if (event === 'APPROVER_CHANGED') {
    // 다른 프로젝트의 멤버를 넣으면 DB의 외래키((승인자 id, 프로젝트 id))가 거절한다.
    await tx.$executeRaw`
      UPDATE projects SET approver_member_id = ${member?.id ?? null}::uuid WHERE id = ${projectId}::uuid
    `;
  } else if (event === 'PROJECT_DELETE_REQUESTED') {
    // 이미 삭제 대기면(같은 기록을 다시 적용) 되돌아갈 상태는 그대로 두고 시각만 맞춘다.
    await tx.$executeRaw`
      UPDATE projects
      SET status_before_delete = CASE WHEN status = 'DELETE_PENDING' THEN status_before_delete ELSE status END,
          status = 'DELETE_PENDING',
          delete_requested_at = ${time}::timestamptz
      WHERE id = ${projectId}::uuid
    `;
  } else if (event === 'PROJECT_RESTORED') {
    await tx.$executeRaw`
      UPDATE projects SET status = status_before_delete, status_before_delete = NULL, delete_requested_at = NULL
      WHERE id = ${projectId}::uuid AND status = 'DELETE_PENDING'
    `;
  } else if (event === 'PROJECT_ARCHIVED') {
    await tx.$executeRaw`UPDATE projects SET status = 'ARCHIVED' WHERE id = ${projectId}::uuid AND status = 'ACTIVE'`;
  } else if (event === 'PROJECT_UNARCHIVED') {
    await tx.$executeRaw`UPDATE projects SET status = 'ACTIVE' WHERE id = ${projectId}::uuid AND status = 'ARCHIVED'`;
  }
  return undefined;
};

const applyWithdrawal = async (tx: Prisma.TransactionClient, record: WithdrawalRecord) => {
  const [user] = await tx.$queryRaw<{ email: string }[]>`SELECT email FROM users WHERE id = ${record.userId}::uuid`;
  // 백업 뒤에 가입하고 초대를 수락하지 않은 채 탈퇴한 사람은 백업에도 수락 기록에도 없다. 이미 없는 것이다.
  if (!user) return '복원된 DB에 없는 사용자';
  // 같은 트랜잭션에서 돈다. 따로 확정하면 뒤의 기록이 실패해도 탈퇴만 남고, 앞에서 만든 사용자가 보이지 않는다.
  // 철회 시각은 기록의 시각으로 적는다. 같은 기록을 두 번 적용해도 결과가 같다.
  await withdrawUserIn(tx, user.email, record.time);
  return undefined;
};

type ApprovalSummary = { issues: { number: number; title: string }[] };

const applyRedaction = async (tx: Prisma.TransactionClient, { target }: RedactionRecord) => {
  const missing = '복원된 DB에 없는 글';
  if (target.table === 'approvals.summary') {
    const approval = await tx.approval.findUnique({ where: { id: target.rowId }, select: { summary: true } });
    const summary = approval?.summary as ApprovalSummary | undefined;
    if (!summary?.issues.some((issue) => issue.number === target.issueNumber)) return missing;
    const issues = summary.issues.map((issue) =>
      issue.number === target.issueNumber ? { ...issue, title: REDACTED_TEXT } : issue,
    );
    await tx.approval.update({ where: { id: target.rowId }, data: { summary: { ...summary, issues } } });
    return undefined;
  }
  if (target.table === 'issue_attachments') {
    // DB 줄만 지운다. 파일은 api가 켜질 때 정리 작업이 "DB에 없는 1시간 넘은 파일"로 지운다.
    // 여기서 파일을 지우면 뒤의 기록이 실패해 DB가 되돌려져도 파일은 돌아오지 않는다.
    const [attachment] = await tx.$queryRaw<{ assetId: string }[]>`
      DELETE FROM issue_attachments WHERE id = ${target.rowId}::uuid RETURNING asset_id AS "assetId"
    `;
    if (!attachment) return missing;
    await tx.$executeRaw`DELETE FROM assets WHERE id = ${attachment.assetId}::uuid`;
    return undefined;
  }

  const changed = {
    'issues.title': () => tx.$executeRaw`UPDATE issues SET title = ${REDACTED_TEXT} WHERE id = ${target.rowId}::uuid`,
    'issues.body': () => tx.$executeRaw`UPDATE issues SET body = ${REDACTED_TEXT} WHERE id = ${target.rowId}::uuid`,
    'comments.body': () => tx.$executeRaw`UPDATE comments SET body = ${REDACTED_TEXT} WHERE id = ${target.rowId}::uuid`,
  }[target.table];
  return (await changed()) === 0 ? missing : undefined;
};

const applyRecord = (tx: Prisma.TransactionClient, record: ReplayRecord) => {
  if (record.event === 'USER_WITHDRAWN') return applyWithdrawal(tx, record);
  if (record.event === 'CONTENT_REDACTED') return applyRedaction(tx, record);
  return applyProjectRecord(tx, record);
};

export const replayRecords = async (prisma: PrismaService, text: string, since: string): Promise<ReplayResult> => {
  // 기준 시각이 없으면 백업에 이미 든 옛 기록까지 다시 적용해 상태가 뒤로 간다. 그래서 꼭 받는다.
  if (!TIME.test(since)) {
    throw new Error('--since에 백업의 기준 시각을 적어 주세요(예: 2026-11-14T03:04:05.123456Z)');
  }
  const blocks = text
    .split(/\r?\n[ \t]*\r?\n/)
    .map((block) => block.trim())
    .filter((block) => block !== '');
  const records = dedupe(blocks.map(parseRecord));
  // 기준 시각보다 앞선 기록은 백업에 이미 들어 있다.
  const fresh = records.filter((record) => record.time >= since);
  assertOrderIsKnown(fresh);
  fresh.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));

  const skipped: string[] = [];
  await prisma.$transaction(
    async (tx) => {
      for (const record of fresh) {
        const reason = await applyRecord(tx, record);
        if (reason) skipped.push(`${record.event} ${record.id}: ${reason}`);
      }
    },
    // 기록이 많으면 기본 한도(5초)를 넘긴다. api가 멈춰 있을 때 돌아서 오래 잡아도 기다리는 요청이 없다.
    { timeout: 60_000 },
  );
  return { applied: fresh.length - skipped.length, skippedBeforeSince: records.length - fresh.length, skipped };
};

// npm run replay-records -- <기록 파일> --since <백업 기준 시각>으로 직접 실행했을 때만 돈다(테스트는 함수만 가져다 쓴다).
if (import.meta.main) {
  const [file, flag, since] = process.argv.slice(2);
  if (!file || flag !== '--since' || !since) {
    console.error('사용: npm run replay-records -- <기록 파일> --since <백업 기준 시각>');
    process.exit(1);
  }
  const prisma = new PrismaService();
  try {
    const result = await replayRecords(prisma, await readFile(file, 'utf8'), since);
    console.log(
      `적용 ${result.applied}건, 기준 시각보다 앞서 건너뜀 ${result.skippedBeforeSince}건, 대상이 없어 건너뜀 ${result.skipped.length}건`,
    );
    for (const line of result.skipped) console.log(`건너뜀: ${line}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
