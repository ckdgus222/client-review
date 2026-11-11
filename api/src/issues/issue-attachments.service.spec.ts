import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import sharp from 'sharp';
import { resetDatabase } from '../../test/reset-database.js';
import { ActivityService } from '../activity/activity.service.js';
import { deleteAsset, saveAsset } from '../assets/asset-storage.js';
import { processImage } from '../assets/image.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { IssueAttachmentsService } from './issue-attachments.service.js';
import { IssuesService } from './issues.service.js';

vi.mock('../assets/asset-storage.js', async (importOriginal) => {
  const storage = await importOriginal<typeof import('../assets/asset-storage.js')>();
  return { ...storage, saveAsset: vi.fn(storage.saveAsset), deleteAsset: vi.fn(storage.deleteAsset) };
});
vi.mock('../assets/image.js', async (importOriginal) => {
  const image = await importOriginal<typeof import('../assets/image.js')>();
  return { ...image, processImage: vi.fn(image.processImage) };
});

const missingId = '00000000-0000-4000-8000-000000000001';
const quota = 1024 * 1024 * 1024;
const issueNotFound = { status: 404, response: { statusCode: 404, message: '없는 쪽지예요', error: 'Not Found' } };
const notAuthor = {
  status: 403,
  response: { statusCode: 403, message: '쪽지를 쓴 사람만 할 수 있어요', error: 'Forbidden' },
};
const notInReview = { status: 409, response: { code: 'VERSION_NOT_IN_REVIEW' } };

describe('IssueAttachmentsService', () => {
  let module: TestingModule | undefined;
  let prisma: PrismaService;
  let service: IssueAttachmentsService;
  let issues: IssuesService;
  let projects: ProjectsService;
  let directory: string;
  let projectId: string;
  let versionId: string;
  let issueId: string;
  let authorId: string;
  let developerId: string;
  let outsiderId: string;
  let photo: Buffer;
  let storedBytes: number;

  const createIssue = async (number = 1) =>
    prisma.issue.create({
      data: {
        projectId,
        originVersionId: versionId,
        authorId,
        number,
        title: '참고 시안',
        body: '본문',
        requestId: randomUUID(),
      },
    });
  // 붙이기 구현에 기대지 않고 실제 파일과 DB 줄을 준비한다.
  const createAsset = async (bytes = storedBytes, targetProjectId = projectId) => {
    const storageKey = await saveAsset(targetProjectId, 'png', photo);
    return prisma.asset.create({
      data: {
        projectId: targetProjectId,
        storageKey,
        mime: 'image/png',
        bytes,
        width: 32,
        height: 24,
      },
    });
  };
  const seedAttachment = async (targetIssueId = issueId) => {
    const asset = await createAsset();
    const attachment = await prisma.issueAttachment.create({ data: { issueId: targetIssueId, assetId: asset.id } });
    return { attachment, asset };
  };
  const assetFiles = async () => {
    const entries = await readdir(directory, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => relative(directory, join(entry.parentPath, entry.name)))
      .sort();
  };
  const readState = async () => ({
    assets: await prisma.asset.findMany({ orderBy: { id: 'asc' } }),
    attachments: await prisma.issueAttachment.findMany({ orderBy: { id: 'asc' } }),
    events: await prisma.activityEvent.findMany({ orderBy: { id: 'asc' } }),
    files: await Promise.all(
      (await assetFiles()).map(async (key) => ({ key, data: await readFile(join(directory, key)) })),
    ),
  });
  const revokeAuthor = () =>
    prisma.projectMember.updateMany({
      where: { projectId, userId: authorId },
      data: { revokedAt: new Date() },
    });

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [IssueAttachmentsService, IssuesService, ProjectsService, ActivityService],
    }).compile();
    prisma = module.get(PrismaService);
    service = module.get(IssueAttachmentsService);
    issues = module.get(IssuesService);
    projects = module.get(ProjectsService);
    photo = await sharp({ create: { width: 32, height: 24, channels: 3, background: 'red' } })
      .png()
      .toBuffer();
    storedBytes = (await sharp(photo).png().toBuffer()).length;
  });
  beforeEach(async () => {
    vi.mocked(saveAsset).mockReset();
    vi.mocked(deleteAsset).mockReset();
    vi.mocked(processImage).mockReset();
    directory = await mkdtemp(join(tmpdir(), 'issue-attachments-'));
    vi.stubEnv('ASSET_DIR', directory);
    await resetDatabase(prisma);
    authorId = (await prisma.user.create({ data: { email: 'author@example.com', name: '쓴 사람' } })).id;
    developerId = (await prisma.user.create({ data: { email: 'developer@example.com', name: '개발자' } })).id;
    outsiderId = (await prisma.user.create({ data: { email: 'outsider@example.com', name: '외부인' } })).id;
    projectId = (
      await prisma.project.create({
        data: {
          name: '참고 사진',
          members: {
            create: [
              { userId: authorId, role: 'CLIENT' },
              { userId: developerId, role: 'DEVELOPER' },
            ],
          },
        },
      })
    ).id;
    versionId = (
      await prisma.deliveryVersion.create({
        data: {
          projectId,
          status: 'IN_REVIEW',
          number: 0,
          publishedAt: new Date(),
        },
      })
    ).id;
    await prisma.project.update({ where: { id: projectId }, data: { currentVersionId: versionId } });
    issueId = (await createIssue()).id;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.mocked(saveAsset).mockReset();
    vi.mocked(deleteAsset).mockReset();
    vi.mocked(processImage).mockReset();
    vi.unstubAllEnvs();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  afterAll(async () => {
    await module?.close();
  });

  it.each(['없는 쪽지', '멤버 아님', '철회된 작성자', '쓴 사람이 아닌 개발자'] as const)(
    '잠그기 전 %s는 사진 처리와 파일 저장 전에 거절한다',
    async (scenario) => {
      if (scenario === '철회된 작성자') await revokeAuthor();
      const targetId = scenario === '없는 쪽지' ? missingId : issueId;
      const userId =
        scenario === '멤버 아님' ? outsiderId : scenario === '쓴 사람이 아닌 개발자' ? developerId : authorId;
      const lock = vi.spyOn(projects, 'lockProject');
      const expected = scenario === '쓴 사람이 아닌 개발자' ? notAuthor : issueNotFound;
      await expect(service.attach(targetId, userId, Buffer.from('잘못된 사진'))).rejects.toMatchObject(expected);
      expect(processImage).not.toHaveBeenCalled();
      expect(saveAsset).not.toHaveBeenCalled();
      expect(deleteAsset).not.toHaveBeenCalled();
      expect(lock).not.toHaveBeenCalled();
      expect(await prisma.asset.count()).toBe(0);
      expect(await prisma.issueAttachment.count()).toBe(0);
      expect(await assetFiles()).toEqual([]);
    },
  );

  it('잠그기 전 멤버 확인은 작성자 확인보다 먼저라 철회된 남의 쪽지도 404다', async () => {
    await prisma.projectMember.updateMany({
      where: { projectId, userId: developerId },
      data: { revokedAt: new Date() },
    });
    await expect(service.attach(issueId, developerId, photo)).rejects.toMatchObject(issueNotFound);
    expect(processImage).not.toHaveBeenCalled();
    expect(saveAsset).not.toHaveBeenCalled();
  });

  it('붙이기는 잠근 뒤 멤버를 다시 확인하고 검수 상태를 본 뒤 저장한다', async () => {
    const order: string[] = [];
    const realLock = projects.lockProject.bind(projects);
    const realMember = issues.requireMember.bind(issues);
    const realVersion = issues.requireVersionInReview.bind(issues);
    vi.spyOn(projects, 'lockProject').mockImplementation(async (...args) => {
      const result = await realLock(...args);
      order.push('잠금');
      return result;
    });
    vi.spyOn(issues, 'requireMember').mockImplementation(async (...args) => {
      const result = await realMember(...args);
      order.push('멤버');
      return result;
    });
    vi.spyOn(issues, 'requireVersionInReview').mockImplementation(async (...args) => {
      const result = await realVersion(...args);
      order.push('검수 중');
      return result;
    });
    const response = await service.attach(issueId, authorId, photo);
    expect(order).toEqual(['멤버', '잠금', '멤버', '검수 중']);
    expect(response).toMatchObject({
      id: issueId,
      isMine: true,
      attachments: [{ id: expect.any(String), assetId: expect.any(String), width: 32, height: 24 }],
    });
    expect(await issues.getDetail(issueId, authorId)).toEqual(response);
    expect(await prisma.activityEvent.count()).toBe(0);
  });

  it.each(['철회·작성자 변경·승인', '작성자 변경·승인', '승인', '현재 버전 없음', '현재 버전이 초안'] as const)(
    '파일 저장 중 %s가 되면 잠근 뒤 멤버·작성자·검수 중 순서로 거절하고 새 파일을 지운다',
    async (change) => {
      const old = await seedAttachment();
      const before = await readState();
      const storage = await vi.importActual<typeof import('../assets/asset-storage.js')>('../assets/asset-storage.js');
      vi.mocked(saveAsset).mockImplementationOnce(async (...args) => {
        const key = await storage.saveAsset(...args);
        if (change === '철회·작성자 변경·승인') await revokeAuthor();
        if (change.includes('작성자 변경'))
          await prisma.issue.update({ where: { id: issueId }, data: { authorId: developerId } });
        if (change.includes('승인'))
          await prisma.deliveryVersion.update({ where: { id: versionId }, data: { status: 'APPROVED' } });
        if (change === '현재 버전 없음')
          await prisma.project.update({ where: { id: projectId }, data: { currentVersionId: null } });
        if (change === '현재 버전이 초안') {
          const draft = await prisma.deliveryVersion.create({ data: { projectId } });
          await prisma.project.update({ where: { id: projectId }, data: { currentVersionId: draft.id } });
        }
        return key;
      });
      const versionCheck = vi.spyOn(issues, 'requireVersionInReview');
      const expected = change.startsWith('철회')
        ? issueNotFound
        : change.startsWith('작성자')
          ? notAuthor
          : notInReview;
      await expect(service.attach(issueId, authorId, photo)).rejects.toMatchObject(expected);
      if (change.includes('작성자 변경')) expect(versionCheck).not.toHaveBeenCalled();
      expect(deleteAsset).toHaveBeenCalledTimes(1);
      expect(deleteAsset).not.toHaveBeenCalledWith(old.asset.storageKey);
      expect(await readState()).toEqual(before);
    },
  );

  it('세 번째는 받고 네 번째는 용량 검사보다 먼저 409로 거절하며 다른 쪽지의 사진은 세지 않는다', async () => {
    const other = await createIssue(2);
    for (let i = 0; i < 3; i++) await seedAttachment(other.id);
    await seedAttachment();
    await seedAttachment();
    const third = await service.attach(issueId, authorId, photo);
    expect(third.attachments).toHaveLength(3);
    await prisma.asset.update({ where: { id: third.attachments[0].assetId }, data: { bytes: quota } });
    const before = await readState();
    await expect(service.attach(issueId, authorId, photo)).rejects.toMatchObject({
      status: 409,
      response: { code: 'TOO_MANY_ATTACHMENTS' },
    });
    expect(await readState()).toEqual(before);
    expect(await prisma.issueAttachment.count({ where: { issueId: other.id } })).toBe(3);
  });

  it('검수 중 검사는 세 장 한도보다 먼저다', async () => {
    for (let i = 0; i < 3; i++) await seedAttachment();
    await prisma.deliveryVersion.update({ where: { id: versionId }, data: { status: 'APPROVED' } });
    const before = await readState();
    await expect(service.attach(issueId, authorId, photo)).rejects.toMatchObject(notInReview);
    expect(await readState()).toEqual(before);
  });

  it('다른 프로젝트 용량은 빼고 정확히 1 GiB까지 받으며 한 바이트 초과부터 거절한다', async () => {
    const other = await prisma.project.create({ data: { name: '다른 프로젝트' } });
    await createAsset(quota, other.id);
    const old = await createAsset(quota - storedBytes);
    await service.attach(issueId, authorId, photo);
    expect((await prisma.asset.aggregate({ where: { projectId }, _sum: { bytes: true } }))._sum.bytes).toBe(quota);
    await prisma.asset.update({ where: { id: old.id }, data: { bytes: quota - 2 * storedBytes + 1 } });
    const before = await readState();
    await expect(service.attach(issueId, authorId, photo)).rejects.toMatchObject({ status: 413 });
    expect(await readState()).toEqual(before);
  });

  it('사진 검사가 실패하면 파일과 DB를 건드리지 않는다', async () => {
    const before = await readState();
    await expect(service.attach(issueId, authorId, Buffer.from('가짜 사진'))).rejects.toMatchObject({ status: 415 });
    expect(saveAsset).not.toHaveBeenCalled();
    expect(deleteAsset).not.toHaveBeenCalled();
    expect(await readState()).toEqual(before);
  });

  it('새 파일 저장 실패는 기존 파일을 지우지 않고 원래 오류를 돌려준다', async () => {
    await seedAttachment();
    const before = await readState();
    const failure = new Error('디스크 저장 실패');
    vi.mocked(saveAsset).mockRejectedValueOnce(failure);
    await expect(service.attach(issueId, authorId, photo)).rejects.toBe(failure);
    expect(deleteAsset).not.toHaveBeenCalled();
    expect(await readState()).toEqual(before);
  });

  it.each([false, true])(
    'DB 실패는 새 파일만 정리하고 원래 오류를 보존한다 (파일 삭제 실패: %s)',
    async (cleanupFails) => {
      const old = await seedAttachment();
      const before = await readState();
      const failure = new Error('상세 조회 실패');
      vi.spyOn(issues, 'loadDetail').mockRejectedValueOnce(failure);
      vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
      if (cleanupFails) vi.mocked(deleteAsset).mockRejectedValueOnce(new Error('정리 실패'));
      await expect(service.attach(issueId, authorId, photo)).rejects.toBe(failure);
      expect(await prisma.asset.findMany({ orderBy: { id: 'asc' } })).toEqual(before.assets);
      expect(await prisma.issueAttachment.findMany({ orderBy: { id: 'asc' } })).toEqual(before.attachments);
      expect(deleteAsset).toHaveBeenCalledTimes(1);
      expect(deleteAsset).not.toHaveBeenCalledWith(old.asset.storageKey);
      expect(await readFile(join(directory, old.asset.storageKey))).toEqual(photo);
      expect(await assetFiles()).toHaveLength(cleanupFails ? 2 : 1);
    },
  );

  it('지우기는 DB 커밋이 끝난 뒤에만 파일을 지우고 남은 상세를 돌려준다', async () => {
    const target = await seedAttachment();
    const remaining = await seedAttachment();
    const before = await issues.getDetail(issueId, authorId);
    const storage = await vi.importActual<typeof import('../assets/asset-storage.js')>('../assets/asset-storage.js');
    vi.mocked(deleteAsset).mockImplementationOnce(async (key) => {
      // 트랜잭션 밖 연결에서 줄이 사라져 있어야 커밋이 끝난 것이다.
      expect(await prisma.issueAttachment.findUnique({ where: { id: target.attachment.id } })).toBeNull();
      expect(await prisma.asset.findUnique({ where: { id: target.asset.id } })).toBeNull();
      await storage.deleteAsset(key);
    });
    const response = await service.remove(issueId, target.attachment.id, authorId);
    expect(response).toEqual({
      ...before,
      attachments: before.attachments.filter(({ id }) => id !== target.attachment.id),
    });
    expect(deleteAsset).toHaveBeenCalledExactlyOnceWith(target.asset.storageKey);
    await expect(readFile(join(directory, target.asset.storageKey))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(directory, remaining.asset.storageKey))).toEqual(photo);
    expect(await issues.getDetail(issueId, authorId)).toEqual(response);
    expect(await prisma.activityEvent.count()).toBe(0);
  });

  it.each(['철회·작성자 변경·승인', '작성자 변경·승인', '승인'] as const)(
    '지우기는 %s여도 멤버·작성자·검수 중 확인이 사진 찾기보다 먼저다',
    async (change) => {
      const target = await seedAttachment();
      if (change.startsWith('철회')) await revokeAuthor();
      if (change.includes('작성자 변경'))
        await prisma.issue.update({ where: { id: issueId }, data: { authorId: developerId } });
      await prisma.deliveryVersion.update({ where: { id: versionId }, data: { status: 'APPROVED' } });
      const before = await readState();
      const expected = change.startsWith('철회')
        ? issueNotFound
        : change.startsWith('작성자')
          ? notAuthor
          : notInReview;
      const lock = vi.spyOn(projects, 'lockProject');
      const versionCheck = vi.spyOn(issues, 'requireVersionInReview');
      for (const attachmentId of [target.attachment.id, missingId]) {
        await expect(service.remove(issueId, attachmentId, authorId)).rejects.toMatchObject(expected);
      }
      expect(lock).toHaveBeenCalledTimes(2);
      if (change.includes('작성자 변경')) expect(versionCheck).not.toHaveBeenCalled();
      expect(deleteAsset).not.toHaveBeenCalled();
      expect(await readState()).toEqual(before);
    },
  );

  it('지우기는 이 쪽지의 첨부 id로만 찾고 다른 쪽지·Asset id·없는 id를 건드리지 않는다', async () => {
    const own = await seedAttachment();
    const otherIssue = await createIssue(2);
    const other = await seedAttachment(otherIssue.id);
    const before = await readState();
    for (const attachmentId of [other.attachment.id, own.asset.id, missingId]) {
      await expect(service.remove(issueId, attachmentId, authorId)).rejects.toMatchObject({
        status: 404,
        response: { message: '없는 사진이에요' },
      });
      expect(await readState()).toEqual(before);
    }
    expect(deleteAsset).not.toHaveBeenCalled();
  });

  it('지우기 도중 DB 실패는 첨부와 사진 줄을 되돌리고 파일을 보존한다', async () => {
    const target = await seedAttachment();
    const before = await readState();
    const failure = new Error('상세 조회 실패');
    vi.spyOn(issues, 'loadDetail').mockRejectedValueOnce(failure);
    await expect(service.remove(issueId, target.attachment.id, authorId)).rejects.toBe(failure);
    expect(deleteAsset).not.toHaveBeenCalled();
    expect(await readState()).toEqual(before);
  });

  it('지우기의 커밋 시점에 DB가 실패해도 파일을 먼저 지우지 않는다', async () => {
    const target = await seedAttachment();
    const before = await readState();
    try {
      await prisma.$executeRaw`CREATE FUNCTION attachments_service_fail_commit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'attachment commit failure'; END; $$`;
      await prisma.$executeRaw`CREATE CONSTRAINT TRIGGER attachments_service_fail_commit
        AFTER DELETE ON assets DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION attachments_service_fail_commit()`;
      await expect(service.remove(issueId, target.attachment.id, authorId)).rejects.toThrow();
      expect(deleteAsset).not.toHaveBeenCalled();
      expect(await readState()).toEqual(before);
    } finally {
      await prisma.$executeRaw`DROP TRIGGER IF EXISTS attachments_service_fail_commit ON assets`;
      await prisma.$executeRaw`DROP FUNCTION IF EXISTS attachments_service_fail_commit()`;
    }
  });

  it('지우기 파일 정리가 실패해도 DB 삭제와 성공 결과를 유지한다', async () => {
    const target = await seedAttachment();
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    vi.mocked(deleteAsset).mockRejectedValueOnce(new Error('디스크 삭제 실패'));
    const response = await service.remove(issueId, target.attachment.id, authorId);
    expect(response.attachments).toEqual([]);
    expect(await prisma.issueAttachment.count()).toBe(0);
    expect(await prisma.asset.count()).toBe(0);
    expect(await readFile(join(directory, target.asset.storageKey))).toEqual(photo);
  });
});
