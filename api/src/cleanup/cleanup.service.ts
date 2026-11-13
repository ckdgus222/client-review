import { readdir, stat } from 'node:fs/promises';
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { assetPath, deleteAsset, deleteProjectAssets } from '../assets/asset-storage.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { DAY_MS, DELETE_GRACE_DAYS } from '../projects/projects.service.js';

// 올리는 중인 사진(파일 저장 → DB 저장 사이)을 지우지 않으려는 여유(docs/archive.md 정할 것 14).
const ORPHAN_AGE_MS = 60 * 60 * 1000;
// 끝난 개인정보 기록을 두는 날 수(정할 것 15). 개인정보처리방침의 보유 기간과 같아야 한다.
const RECORD_KEEP_DAYS = 30;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

// 매일 한 번: 7일 지난 삭제 대기 프로젝트, DB에 없는 사진 파일, 30일 지난 개인정보 기록을 지운다(정할 것 12~15).
// 한 곳이 실패해도 로그만 남기고 나머지를 이어 간다. 남은 것은 다음 날 다시 지운다.
@Injectable()
export class CleanupService implements OnModuleDestroy {
  private readonly logger = new Logger(CleanupService.name);
  private running = false;
  private timer?: NodeJS.Timeout;

  constructor(private readonly prisma: PrismaService) {}

  // main.ts가 앱을 켠 뒤 부른다. 켤 때 한 번, 그 뒤 24시간마다. api e2e는 runOnce를 직접 부른다.
  start() {
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), DAY_MS);
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  // 앞의 정리가 아직 돌고 있으면 건너뛴다. 세 단계는 서로 막지 않는다.
  async runOnce() {
    if (this.running) return;
    this.running = true;
    try {
      await this.attempt('삭제 대기 프로젝트 정리', () => this.purgeDeletedProjects());
      await this.attempt('DB에 없는 사진 파일 정리', () => this.removeOrphanFiles());
      await this.attempt('30일 지난 기록 정리', () => this.removeOldRecords());
    } finally {
      this.running = false;
    }
  }

  // 단계·프로젝트·폴더·파일마다 이것으로 감싸서, 실패는 로그만 남기고 다음 것으로 넘어간다.
  private async attempt(label: string, run: () => Promise<void>) {
    await run().catch((error: unknown) => {
      this.logger.error(`${label}에 실패했어요: ${messageOf(error)}`);
    });
  }

  private async purgeDeletedProjects() {
    const due = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM projects
      WHERE status = 'DELETE_PENDING' AND delete_requested_at <= now() - make_interval(days => ${DELETE_GRACE_DAYS}::int)
    `;
    for (const { id } of due) {
      await this.attempt(`프로젝트 ${id} 지우기`, () => this.purgeProject(id));
    }
  }

  // 사진 파일 먼저, 그 뒤 DB 줄(전체 기획 7장). 줄을 잠근 채 지워서 그사이 되살리기가 끼어들지 못한다.
  // 파일이나 DB 지우기가 실패하면 트랜잭션이 되돌려져 줄이 남는다. 7일이 지나 되살릴 수 없고, 다음 정리가 끝까지 지운다.
  private async purgeProject(projectId: string) {
    await this.prisma.$transaction(
      async (tx) => {
        // 고른 뒤 되살렸으면 조건이 맞지 않아 건너뛴다. 되살리기와 같은 DB 시계와 경계다.
        const [locked] = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM projects
          WHERE id = ${projectId}::uuid AND status = 'DELETE_PENDING'
            AND delete_requested_at <= clock_timestamp() - make_interval(days => ${DELETE_GRACE_DAYS}::int)
          FOR UPDATE
        `;
        if (!locked) return;
        await deleteProjectAssets(projectId);
        // 딸린 줄(버전, 쪽지, 멤버, 사건 등)은 Cascade로 같이 지워진다.
        await tx.$executeRaw`DELETE FROM projects WHERE id = ${projectId}::uuid`;
      },
      { timeout: 60_000 },
    );
  }

  // <ASSET_DIR>/<폴더>/<파일> 중 1시간 넘었고 assets.storage_key에 없는 파일을 지운다. 비어 버린 폴더는 남긴다.
  private async removeOrphanFiles() {
    const root = assetPath(''); // ASSET_DIR 그 자체
    const folders = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      // 사진을 아직 한 번도 올리지 않아 폴더가 없으면 지울 것도 없다.
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const folder of folders.filter((entry) => entry.isDirectory())) {
      await this.attempt(`사진 폴더 ${folder.name} 정리`, () => this.removeOrphansIn(folder.name));
    }
  }

  // 폴더마다 이름 목록을 한 번에 DB에 묻는다.
  private async removeOrphansIn(folder: string) {
    const files = await readdir(assetPath(folder), { withFileTypes: true });
    const keys = files.filter((entry) => entry.isFile()).map((entry) => `${folder}/${entry.name}`);
    if (keys.length === 0) return;
    const known = await this.prisma.asset.findMany({
      where: { storageKey: { in: keys } },
      select: { storageKey: true },
    });
    const knownKeys = new Set(known.map((asset) => asset.storageKey));
    for (const key of keys.filter((candidate) => !knownKeys.has(candidate))) {
      await this.attempt(`사진 파일 ${key} 지우기`, () => this.removeIfOld(key));
    }
  }

  private async removeIfOld(storageKey: string) {
    const { mtimeMs } = await stat(assetPath(storageKey));
    if (Date.now() - mtimeMs <= ORPHAN_AGE_MS) return;
    await deleteAsset(storageKey);
  }

  // 기준은 "끝난 때"다(정할 것 15). 세션은 만료나 24시간 안 씀(로그인 확인이 끝내는 규칙) 중 이른 때,
  // 초대는 수락·철회·만료 중 처음 쓸 수 없게 된 때(LEAST는 빈 값을 건너뛴다), 메일 줄은 다 보냈거나 포기한 때다.
  private async removeOldRecords() {
    const cutoff = Prisma.sql`now() - make_interval(days => ${RECORD_KEEP_DAYS}::int)`;
    await this.prisma.$executeRaw`
      DELETE FROM sessions WHERE LEAST(expires_at, last_seen_at + interval '24 hours') < ${cutoff}`;
    await this.prisma.$executeRaw`DELETE FROM login_codes WHERE expires_at < ${cutoff}`;
    await this.prisma.$executeRaw`
      DELETE FROM invitations WHERE LEAST(accepted_at, revoked_at, expires_at) < ${cutoff}`;
    await this.prisma.$executeRaw`
      DELETE FROM notification_deliveries
      WHERE status <> 'PENDING' AND COALESCE(sent_at, next_attempt_at) < ${cutoff}`;
  }
}
