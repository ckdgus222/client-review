import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import sharp from 'sharp';
import { resetDatabase } from '../../test/reset-database.js';
import { ActivityService } from '../activity/activity.service.js';
import { deleteAsset, saveAsset } from '../assets/asset-storage.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { DraftScreensService } from './draft-screens.service.js';
import { VersionsService } from './versions.service.js';

// 실제 파일을 쓰고 지운다. 실패나 요청 사이의 상태 변화가 필요한 테스트에서만 바꾼다.
vi.mock('../assets/asset-storage.js', async (importOriginal) => {
  const storage = await importOriginal<typeof import('../assets/asset-storage.js')>();
  return { ...storage, saveAsset: vi.fn(storage.saveAsset), deleteAsset: vi.fn(storage.deleteAsset) };
});

const expectConflict = (error: unknown, code: string) => {
  expect(error).toBeInstanceOf(ConflictException);
  if (!(error instanceof ConflictException)) throw new Error('409 오류가 필요해요');
  expect(error.getResponse()).toEqual({ statusCode: 409, message: expect.any(String), code });
};

const expectNotFound = (error: unknown, message: string) => {
  expect(error).toBeInstanceOf(NotFoundException);
  if (!(error instanceof NotFoundException)) throw new Error('404 오류가 필요해요');
  expect(error.getResponse()).toEqual({ statusCode: 404, message, error: 'Not Found' });
};

describe('DraftScreensService', () => {
  let module: TestingModule | undefined;
  let prisma: PrismaService;
  let service: DraftScreensService;
  let versions: VersionsService;
  let directory: string;
  let developerId: string;
  let clientId: string;
  let outsiderId: string;
  let projectId: string;
  let otherProjectId: string;
  let draftId: string;
  let photo: Buffer;
  let oldPhoto: Buffer;
  let storedPhotoBytes: number;
  const quota = 1024 * 1024 * 1024;
  const missingId = '00000000-0000-4000-8000-000000000001';
  const publishedAt = new Date('2026-01-01T00:00:00Z');

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [DraftScreensService, VersionsService, ProjectsService, ActivityService],
    }).compile();
    prisma = module.get(PrismaService);
    service = module.get(DraftScreensService);
    versions = module.get(VersionsService);
    photo = await sharp({ create: { width: 32, height: 24, channels: 3, background: 'red' } })
      .png()
      .toBuffer();
    oldPhoto = await sharp({ create: { width: 16, height: 12, channels: 3, background: 'blue' } })
      .png()
      .toBuffer();
    storedPhotoBytes = (await sharp(photo).png().toBuffer()).length;
  });

  beforeEach(async () => {
    vi.mocked(saveAsset).mockReset();
    vi.mocked(deleteAsset).mockReset();
    directory = await mkdtemp(join(tmpdir(), 'draft-screens-'));
    vi.stubEnv('ASSET_DIR', directory);
    await resetDatabase(prisma);
    const developer = await prisma.user.create({ data: { email: 'developer@example.com', name: '개발자' } });
    const client = await prisma.user.create({ data: { email: 'client@example.com', name: '클라이언트' } });
    const outsider = await prisma.user.create({ data: { email: 'outsider@example.com', name: '다른 개발자' } });
    developerId = developer.id;
    clientId = client.id;
    outsiderId = outsider.id;
    const project = await prisma.project.create({
      data: {
        name: '사진 검수',
        members: {
          create: [
            { userId: developerId, role: 'DEVELOPER' },
            { userId: clientId, role: 'CLIENT' },
          ],
        },
      },
    });
    projectId = project.id;
    const otherProject = await prisma.project.create({
      data: { name: '다른 프로젝트', members: { create: { userId: outsiderId, role: 'DEVELOPER' } } },
    });
    otherProjectId = otherProject.id;
    const draft = await prisma.deliveryVersion.create({
      data: { projectId, summary: '초안 설명', testUrl: 'https://example.com' },
    });
    draftId = draft.id;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.mocked(saveAsset).mockReset();
    vi.mocked(deleteAsset).mockReset();
    vi.unstubAllEnvs();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  afterAll(async () => {
    await module?.close();
  });

  const createScreen = (ownerProjectId = projectId) =>
    prisma.screen.create({ data: { projectId: ownerProjectId, name: `화면 ${randomUUID()}`, viewport: 'PC' } });

  // 서비스 호출과 독립적으로 기존 DB 줄과 실제 사진 파일을 준비한다.
  const attachScreen = async (versionId = draftId, ownerProjectId = projectId, bytes = oldPhoto.length) => {
    const screen = await createScreen(ownerProjectId);
    const storageKey = await saveAsset(ownerProjectId, 'png', oldPhoto);
    const asset = await prisma.asset.create({
      data: { projectId: ownerProjectId, storageKey, mime: 'image/png', bytes, width: 16, height: 12 },
    });
    const link = await prisma.versionScreen.create({ data: { versionId, screenId: screen.id, assetId: asset.id } });
    return { screen, asset, link };
  };

  const expectPreserved = async ({ asset, link }: Awaited<ReturnType<typeof attachScreen>>) => {
    expect(await prisma.asset.findUnique({ where: { id: asset.id } })).toEqual(asset);
    expect(await prisma.versionScreen.findUnique({ where: { id: link.id } })).toEqual(link);
    expect(await readFile(join(directory, asset.storageKey))).toEqual(oldPhoto);
  };

  const projectFiles = async () => {
    const names = await readdir(join(directory, projectId)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    return names.sort((left, right) => left.localeCompare(right));
  };

  const fillScreens = async (count: number) => {
    const screens = [];
    for (let index = 0; index < count; index += 1) screens.push(await attachScreen());
    return screens;
  };

  // 두 요청 모두 실제 파일 저장을 마친 뒤 DB 처리를 시작하게 한다. 시간 지연에 기대지 않는다.
  const synchronizeNextTwoUploads = async () => {
    const storage = await vi.importActual<typeof import('../assets/asset-storage.js')>('../assets/asset-storage.js');
    let release: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    let saved = 0;
    vi.mocked(saveAsset).mockImplementation(async (...args) => {
      const key = await storage.saveAsset(...args);
      saved += 1;
      if (saved === 2) release();
      await ready;
      return key;
    });
  };

  it.each(['png', 'jpeg', 'webp'] as const)(
    'putAsset은 %s를 저장하고 사진 정보와 버전 상세를 반환한다',
    async (format) => {
      const screen = await createScreen();
      const input = await sharp(photo).toFormat(format).toBuffer();

      const detail = await service.putAsset(draftId, screen.id, developerId, input);

      const asset = await prisma.asset.findFirstOrThrow({ where: { projectId } });
      const saved = await readFile(join(directory, asset.storageKey));
      expect(asset).toMatchObject({ mime: `image/${format}`, bytes: saved.length, width: 32, height: 24 });
      expect(asset.storageKey).toMatch(new RegExp(`^${projectId}/[^/]+\\.${format === 'jpeg' ? 'jpg' : format}$`));
      expect(await sharp(saved).metadata()).toMatchObject({ format, width: 32, height: 24 });
      expect(detail).toEqual({
        id: draftId,
        projectId,
        number: null,
        status: 'DRAFT',
        summary: '초안 설명',
        testUrl: 'https://example.com',
        publishedAt: null,
        approval: null,
        screens: [
          {
            screenId: screen.id,
            name: screen.name,
            viewport: 'PC',
            hiddenAt: null,
            asset: { id: asset.id, width: 32, height: 24 },
          },
        ],
      });
      expect(await versions.getDetail(draftId, developerId)).toEqual(detail);
      expect(await prisma.versionScreen.findMany({ where: { versionId: draftId } })).toEqual([
        expect.objectContaining({ screenId: screen.id, assetId: asset.id }),
      ]);
      expect(await prisma.asset.count({ where: { projectId } })).toBe(1);
      expect(await projectFiles()).toEqual([basename(asset.storageKey)]);
    },
  );

  it('회전된 JPEG의 최종 크기를 저장하고 EXIF를 파일에서 지운다', async () => {
    const screen = await createScreen();
    const input = await sharp(photo).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    expect((await sharp(input).metadata()).exif).toBeDefined();

    const detail = await service.putAsset(draftId, screen.id, developerId, input);

    const asset = await prisma.asset.findFirstOrThrow({ where: { projectId } });
    const saved = await readFile(join(directory, asset.storageKey));
    const metadata = await sharp(saved).metadata();
    expect(asset).toMatchObject({ mime: 'image/jpeg', bytes: saved.length, width: 24, height: 32 });
    expect(detail.screens[0].asset).toEqual({ id: asset.id, width: 24, height: 32 });
    expect(metadata).toMatchObject({ width: 24, height: 32 });
    expect(metadata.exif).toBeUndefined();
    expect(metadata.orientation).toBeUndefined();
  });

  it('같은 화면의 사진을 바꾸면 새 Asset을 쓰고 옛 줄·파일만 지운다', async () => {
    const old = await attachScreen();
    const unchanged = await attachScreen();

    const detail = await service.putAsset(draftId, old.screen.id, developerId, photo);

    const replacement = detail.screens.find(({ screenId }) => screenId === old.screen.id)!;
    expect(replacement.asset.id).not.toBe(old.asset.id);
    expect(replacement.asset).toMatchObject({ width: 32, height: 24 });
    expect(await prisma.versionScreen.count({ where: { versionId: draftId } })).toBe(2);
    expect(await prisma.asset.findUnique({ where: { id: old.asset.id } })).toBeNull();
    await expect(readFile(join(directory, old.asset.storageKey))).rejects.toMatchObject({ code: 'ENOENT' });
    const asset = await prisma.asset.findUniqueOrThrow({ where: { id: replacement.asset.id } });
    expect(await sharp(await readFile(join(directory, asset.storageKey))).metadata()).toMatchObject({
      width: 32,
      height: 24,
    });
    expect(await projectFiles()).toEqual([basename(asset.storageKey), basename(unchanged.asset.storageKey)].sort());
    await expectPreserved(unchanged);
    expect(await versions.getDetail(draftId, developerId)).toEqual(detail);
  });

  it.each(['putAsset', 'removeScreen'] as const)(
    '%s는 지난 버전이 쓰는 사진과 그 버전 연결을 보존한다',
    async (operation) => {
      const first = await prisma.deliveryVersion.create({
        data: { projectId, status: 'IN_REVIEW', number: 1, publishedAt },
      });
      const old = await attachScreen(first.id);
      await prisma.versionScreen.create({
        data: { versionId: draftId, screenId: old.screen.id, assetId: old.asset.id },
      });

      const detail =
        operation === 'putAsset'
          ? await service.putAsset(draftId, old.screen.id, developerId, photo)
          : await service.removeScreen(draftId, old.screen.id, developerId);

      await expectPreserved(old);
      expect(await prisma.versionScreen.count({ where: { assetId: old.asset.id } })).toBe(1);
      expect(detail.screens.map(({ asset }) => asset.id)).not.toContain(old.asset.id);
      expect(await prisma.asset.count({ where: { projectId } })).toBe(operation === 'putAsset' ? 2 : 1);
      expect(await projectFiles()).toHaveLength(operation === 'putAsset' ? 2 : 1);
      expect(await versions.getDetail(draftId, developerId)).toEqual(detail);
    },
  );

  it.each([false, true])(
    'DB 실패 때 기존 사진과 원래 오류를 보존한다 (새 파일 삭제 실패: %s)',
    async (cleanupFails) => {
      const old = await attachScreen();
      const failure = new Error('상세 조회 중 DB 실패');
      vi.spyOn(versions, 'loadDetail').mockRejectedValueOnce(failure);
      const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
      if (cleanupFails) vi.mocked(deleteAsset).mockRejectedValueOnce(new Error('파일 삭제 실패'));

      await expect(service.putAsset(draftId, old.screen.id, developerId, photo)).rejects.toBe(failure);

      await expectPreserved(old);
      expect(await prisma.asset.count({ where: { projectId } })).toBe(1);
      expect(await prisma.versionScreen.count({ where: { versionId: draftId } })).toBe(1);
      const files = await projectFiles();
      expect(files).toContain(basename(old.asset.storageKey));
      expect(files).toHaveLength(cleanupFails ? 2 : 1);
      if (cleanupFails) expect(log).toHaveBeenCalled();
    },
  );

  it('새 화면을 더하다 DB가 실패하면 사진 파일·Asset·연결이 남지 않는다', async () => {
    const screen = await createScreen();
    const failure = new Error('새 화면 저장 실패');
    vi.spyOn(versions, 'loadDetail').mockRejectedValueOnce(failure);

    await expect(service.putAsset(draftId, screen.id, developerId, photo)).rejects.toBe(failure);

    expect(await prisma.asset.count()).toBe(0);
    expect(await prisma.versionScreen.count()).toBe(0);
    expect(await projectFiles()).toEqual([]);
  });

  it.each(['putAsset', 'removeScreen'] as const)(
    '%s 성공 뒤 파일 삭제가 실패해도 DB 결과와 성공 응답은 유지한다',
    async (operation) => {
      const old = await attachScreen();
      vi.mocked(deleteAsset).mockRejectedValueOnce(new Error('옛 파일 삭제 실패'));
      const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

      const detail =
        operation === 'putAsset'
          ? await service.putAsset(draftId, old.screen.id, developerId, photo)
          : await service.removeScreen(draftId, old.screen.id, developerId);

      expect(await prisma.asset.findUnique({ where: { id: old.asset.id } })).toBeNull();
      expect(await prisma.versionScreen.count({ where: { assetId: old.asset.id } })).toBe(0);
      expect(await readFile(join(directory, old.asset.storageKey))).toEqual(oldPhoto);
      expect(detail.screens).toHaveLength(operation === 'putAsset' ? 1 : 0);
      expect(await versions.getDetail(draftId, developerId)).toEqual(detail);
      expect(await projectFiles()).toHaveLength(operation === 'putAsset' ? 2 : 1);
      if (operation === 'putAsset') {
        const asset = await prisma.asset.findUniqueOrThrow({ where: { id: detail.screens[0].asset.id } });
        expect(await sharp(await readFile(join(directory, asset.storageKey))).metadata()).toMatchObject({
          width: 32,
          height: 24,
        });
      }
      expect(log).toHaveBeenCalled();
    },
  );

  it.each(['DRAFT', 'IN_REVIEW', 'APPROVED'] as const)(
    '클라이언트의 %s 업로드는 사진 처리 전에 거절한다',
    async (status) => {
      const screen = await createScreen();
      if (status !== 'DRAFT')
        await prisma.deliveryVersion.update({ where: { id: draftId }, data: { status, number: 1, publishedAt } });

      // 잘못된 사진도 권한 오류가 먼저 나야 한다. 사진부터 검사하는 구현도 잡는다.
      for (const input of [photo, Buffer.from('가짜 PNG')]) {
        const error = await service.putAsset(draftId, screen.id, clientId, input).catch((caught: unknown) => caught);
        if (status === 'DRAFT') expectNotFound(error, '없는 버전이에요');
        if (status !== 'DRAFT') expect(error).toBeInstanceOf(ForbiddenException);
      }
      expect(await readdir(directory)).toEqual([]);
      expect(await prisma.asset.count()).toBe(0);
      expect(await prisma.versionScreen.count()).toBe(0);
    },
  );

  it.each(['putAsset', 'removeScreen'] as const)(
    '%s는 없는 버전과 비멤버에게 같은 404를 돌려준다',
    async (operation) => {
      const screen = await createScreen();
      for (const [versionId, userId] of [
        [missingId, developerId],
        [draftId, outsiderId],
      ]) {
        const error = await (
          operation === 'putAsset'
            ? service.putAsset(versionId, screen.id, userId, Buffer.from('잘못된 사진'))
            : service.removeScreen(versionId, screen.id, userId)
        ).catch((caught: unknown) => caught);
        expectNotFound(error, '없는 버전이에요');
      }
      expect(await readdir(directory)).toEqual([]);
      expect(await prisma.asset.count()).toBe(0);
    },
  );

  it.each(['없는 화면', '다른 프로젝트 화면'] as const)(
    'putAsset은 %s에 404를 돌려주고 새 파일을 지운다',
    async (target) => {
      const screenId = target === '없는 화면' ? missingId : (await createScreen(otherProjectId)).id;

      const error = await service.putAsset(draftId, screenId, developerId, photo).catch((caught: unknown) => caught);

      expectNotFound(error, '없는 화면이에요');
      expect(await projectFiles()).toEqual([]);
      expect(await prisma.asset.count()).toBe(0);
      expect(await prisma.versionScreen.count()).toBe(0);
    },
  );

  it.each([false, true])('숨긴 화면에는 새로 올리거나 바꿀 수 없다 (기존 사진: %s)', async (hasAsset) => {
    const old = hasAsset ? await attachScreen() : null;
    const screen = old?.screen ?? (await createScreen());
    await prisma.screen.update({ where: { id: screen.id }, data: { hiddenAt: new Date() } });

    const error = await service.putAsset(draftId, screen.id, developerId, photo).catch((caught: unknown) => caught);

    expectConflict(error, 'SCREEN_HIDDEN');
    expect(await projectFiles()).toEqual(old ? [basename(old.asset.storageKey)] : []);
    expect(await prisma.asset.count()).toBe(old ? 1 : 0);
    if (old) await expectPreserved(old);
  });

  it('20개면 21번째 화면을 거절하지만 기존 화면 사진은 바꿀 수 있다', async () => {
    const originals = await fillScreens(20);
    const extra = await createScreen();
    const beforeFiles = await projectFiles();

    const error = await service.putAsset(draftId, extra.id, developerId, photo).catch((caught: unknown) => caught);

    expectConflict(error, 'TOO_MANY_SCREENS');
    expect(await projectFiles()).toEqual(beforeFiles);
    expect(await prisma.asset.count()).toBe(20);
    const detail = await service.putAsset(draftId, originals[0].screen.id, developerId, photo);
    expect(detail.screens).toHaveLength(20);
    expect(detail.screens.find(({ screenId }) => screenId === originals[0].screen.id)?.asset.id).not.toBe(
      originals[0].asset.id,
    );
    expect(await prisma.versionScreen.count()).toBe(20);
    expect(await prisma.asset.count()).toBe(20);
    expect(await projectFiles()).toHaveLength(20);
    expect(await prisma.asset.findUnique({ where: { id: originals[0].asset.id } })).toBeNull();
    await expect(readFile(join(directory, originals[0].asset.storageKey))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('19개에서 20번째 화면은 추가할 수 있다', async () => {
    await fillScreens(19);
    const screen = await createScreen();

    const detail = await service.putAsset(draftId, screen.id, developerId, photo);

    expect(detail.screens).toHaveLength(20);
    expect(await prisma.versionScreen.count()).toBe(20);
    expect(await projectFiles()).toHaveLength(20);
  });

  it.each([false, true])('용량이 1바이트라도 넘으면 옛 크기를 빼지 않고 413이다 (교체: %s)', async (replace) => {
    const old = await attachScreen(draftId, projectId, quota - storedPhotoBytes + 1);
    const screen = replace ? old.screen : await createScreen();

    await expect(service.putAsset(draftId, screen.id, developerId, photo)).rejects.toBeInstanceOf(
      PayloadTooLargeException,
    );

    await expectPreserved(old);
    expect(await prisma.asset.count()).toBe(1);
    expect(await prisma.versionScreen.count()).toBe(1);
    expect(await projectFiles()).toEqual([basename(old.asset.storageKey)]);
  });

  it('프로젝트 Asset 합계가 정확히 1,024 MiB면 허용하고 공유 사진을 중복 계산하거나 다른 프로젝트를 세지 않는다', async () => {
    const shared = await attachScreen(draftId, projectId, quota - storedPhotoBytes - oldPhoto.length);
    await attachScreen();
    const first = await prisma.deliveryVersion.create({
      data: { projectId, status: 'IN_REVIEW', number: 1, publishedAt },
    });
    await prisma.versionScreen.create({
      data: { versionId: first.id, screenId: shared.screen.id, assetId: shared.asset.id },
    });
    const otherVersion = await prisma.deliveryVersion.create({ data: { projectId: otherProjectId } });
    const other = await attachScreen(otherVersion.id, otherProjectId, quota);
    const screen = await createScreen();

    const detail = await service.putAsset(draftId, screen.id, developerId, photo);

    expect(detail.screens).toHaveLength(3);
    expect((await prisma.asset.aggregate({ where: { projectId }, _sum: { bytes: true } }))._sum.bytes).toBe(quota);
    await expectPreserved(other);
  });

  it('지난 버전에서만 쓰는 사진 용량도 프로젝트 합계에 넣는다', async () => {
    const first = await prisma.deliveryVersion.create({
      data: { projectId, status: 'IN_REVIEW', number: 1, publishedAt },
    });
    const old = await attachScreen(first.id, projectId, quota);
    const screen = await createScreen();

    await expect(service.putAsset(draftId, screen.id, developerId, photo)).rejects.toBeInstanceOf(
      PayloadTooLargeException,
    );

    await expectPreserved(old);
    expect(await prisma.versionScreen.count({ where: { versionId: draftId } })).toBe(0);
    expect(await projectFiles()).toEqual([basename(old.asset.storageKey)]);
  });

  it.each(['IN_REVIEW', 'APPROVED'] as const)('개발자도 %s에는 올릴 수 없고 새 파일을 지운다', async (status) => {
    const old = await attachScreen();
    await prisma.deliveryVersion.update({ where: { id: draftId }, data: { status, number: 1, publishedAt } });

    const error = await service.putAsset(draftId, old.screen.id, developerId, photo).catch((caught: unknown) => caught);

    expectConflict(error, 'VERSION_NOT_DRAFT');
    await expectPreserved(old);
    expect(await prisma.asset.count()).toBe(1);
    expect(await projectFiles()).toEqual([basename(old.asset.storageKey)]);
  });

  it.each([Buffer.alloc(0), Buffer.from('사진이 아닌 글자')])(
    '잘못된 사진은 415이고 파일·DB를 만들지 않는다 (%#)',
    async (input) => {
      const screen = await createScreen();

      await expect(service.putAsset(draftId, screen.id, developerId, input)).rejects.toBeInstanceOf(
        UnsupportedMediaTypeException,
      );

      expect(await readdir(directory)).toEqual([]);
      expect(await prisma.asset.count()).toBe(0);
      expect(await prisma.versionScreen.count()).toBe(0);
    },
  );

  it('긴 변이 20,000px를 넘으면 413이고 기존 사진을 보존한다', async () => {
    const old = await attachScreen();
    const input = await sharp({ create: { width: 20_001, height: 1, channels: 3, background: 'red' } })
      .png()
      .toBuffer();

    await expect(service.putAsset(draftId, old.screen.id, developerId, input)).rejects.toBeInstanceOf(
      PayloadTooLargeException,
    );

    await expectPreserved(old);
    expect(await projectFiles()).toEqual([basename(old.asset.storageKey)]);
  });

  it('새 파일 저장이 실패하면 DB와 기존 파일을 건드리지 않고 원래 오류를 돌려준다', async () => {
    const old = await attachScreen();
    const failure = new Error('디스크 저장 실패');
    vi.mocked(saveAsset).mockRejectedValueOnce(failure);

    await expect(service.putAsset(draftId, old.screen.id, developerId, photo)).rejects.toBe(failure);

    await expectPreserved(old);
    expect(await prisma.asset.count()).toBe(1);
    expect(await projectFiles()).toEqual([basename(old.asset.storageKey)]);
  });

  it('removeScreen은 연결·Asset·파일을 지우고 화면 이름표와 다른 사진을 남긴다', async () => {
    const old = await attachScreen();
    const unchanged = await attachScreen();

    const detail = await service.removeScreen(draftId, old.screen.id, developerId);

    expect(detail.screens).toEqual([
      {
        screenId: unchanged.screen.id,
        name: unchanged.screen.name,
        viewport: 'PC',
        hiddenAt: null,
        asset: { id: unchanged.asset.id, width: 16, height: 12 },
      },
    ]);
    expect(await versions.getDetail(draftId, developerId)).toEqual(detail);
    expect(await prisma.versionScreen.findUnique({ where: { id: old.link.id } })).toBeNull();
    expect(await prisma.asset.findUnique({ where: { id: old.asset.id } })).toBeNull();
    expect(await prisma.screen.findUnique({ where: { id: old.screen.id } })).toEqual(old.screen);
    await expect(readFile(join(directory, old.asset.storageKey))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await projectFiles()).toEqual([basename(unchanged.asset.storageKey)]);
    await expectPreserved(unchanged);
  });

  it('removeScreen은 숨겨진 마지막 화면도 뺄 수 있다', async () => {
    const old = await attachScreen();
    await prisma.screen.update({ where: { id: old.screen.id }, data: { hiddenAt: new Date() } });

    const detail = await service.removeScreen(draftId, old.screen.id, developerId);

    expect(detail.screens).toEqual([]);
    expect(await prisma.versionScreen.count()).toBe(0);
    expect(await prisma.asset.count()).toBe(0);
    expect(await projectFiles()).toEqual([]);
  });

  it('removeScreen 도중 DB가 실패하면 연결·Asset·파일을 모두 보존한다', async () => {
    const old = await attachScreen();
    const failure = new Error('화면 빼기 트랜잭션 실패');
    vi.spyOn(versions, 'loadDetail').mockRejectedValueOnce(failure);

    await expect(service.removeScreen(draftId, old.screen.id, developerId)).rejects.toBe(failure);

    await expectPreserved(old);
    expect(await projectFiles()).toEqual([basename(old.asset.storageKey)]);
  });

  it('removeScreen은 초안에 없는 화면·없는 id·다른 프로젝트 화면에 같은 404를 준다', async () => {
    const old = await attachScreen();
    const unlinked = await createScreen();
    const foreign = await createScreen(otherProjectId);
    for (const screenId of [unlinked.id, missingId, foreign.id]) {
      const error = await service.removeScreen(draftId, screenId, developerId).catch((caught: unknown) => caught);
      expectNotFound(error, '없는 화면이에요');
    }
    await expectPreserved(old);
    expect(await projectFiles()).toEqual([basename(old.asset.storageKey)]);
  });

  it.each(['DRAFT', 'IN_REVIEW', 'APPROVED'] as const)(
    'removeScreen은 %s에서 클라이언트의 쓰기를 막는다',
    async (status) => {
      const old = await attachScreen();
      if (status !== 'DRAFT')
        await prisma.deliveryVersion.update({ where: { id: draftId }, data: { status, number: 1, publishedAt } });

      const error = await service.removeScreen(draftId, old.screen.id, clientId).catch((caught: unknown) => caught);

      if (status === 'DRAFT') expectNotFound(error, '없는 버전이에요');
      if (status !== 'DRAFT') expect(error).toBeInstanceOf(ForbiddenException);
      await expectPreserved(old);
    },
  );

  it.each(['IN_REVIEW', 'APPROVED'] as const)('removeScreen은 개발자에게도 %s를 바꾸지 못하게 한다', async (status) => {
    const old = await attachScreen();
    await prisma.deliveryVersion.update({ where: { id: draftId }, data: { status, number: 1, publishedAt } });

    const error = await service.removeScreen(draftId, old.screen.id, developerId).catch((caught: unknown) => caught);

    expectConflict(error, 'VERSION_NOT_DRAFT');
    await expectPreserved(old);
  });

  it('사진을 저장하는 사이 게시되면 새 파일을 지우고 게시된 사진은 바꾸지 않는다', async () => {
    const old = await attachScreen();
    const storage = await vi.importActual<typeof import('../assets/asset-storage.js')>('../assets/asset-storage.js');
    vi.mocked(saveAsset).mockImplementationOnce(async (...args) => {
      const key = await storage.saveAsset(...args);
      await versions.publish(draftId, developerId);
      return key;
    });

    const error = await service.putAsset(draftId, old.screen.id, developerId, photo).catch((caught: unknown) => caught);

    expectConflict(error, 'VERSION_NOT_DRAFT');
    await expectPreserved(old);
    expect(await prisma.deliveryVersion.findUnique({ where: { id: draftId } })).toMatchObject({
      status: 'IN_REVIEW',
      number: 0,
    });
    expect(await prisma.asset.count()).toBe(1);
    expect(await projectFiles()).toEqual([basename(old.asset.storageKey)]);
  });

  it.each(['멤버 삭제', '클라이언트로 변경', '화면 숨김'] as const)(
    '사진을 저장하는 사이 %s가 되면 잠금 뒤 다시 검사한다',
    async (change) => {
      const old = await attachScreen();
      const storage = await vi.importActual<typeof import('../assets/asset-storage.js')>('../assets/asset-storage.js');
      vi.mocked(saveAsset).mockImplementationOnce(async (...args) => {
        const key = await storage.saveAsset(...args);
        if (change === '멤버 삭제')
          await prisma.projectMember.deleteMany({ where: { projectId, userId: developerId } });
        if (change === '클라이언트로 변경')
          await prisma.projectMember.updateMany({
            where: { projectId, userId: developerId },
            data: { role: 'CLIENT' },
          });
        if (change === '화면 숨김')
          await prisma.screen.update({ where: { id: old.screen.id }, data: { hiddenAt: new Date() } });
        return key;
      });

      const error = await service
        .putAsset(draftId, old.screen.id, developerId, photo)
        .catch((caught: unknown) => caught);

      if (change === '화면 숨김') expectConflict(error, 'SCREEN_HIDDEN');
      if (change !== '화면 숨김') expectNotFound(error, '없는 버전이에요');
      await expectPreserved(old);
      expect(await prisma.asset.count()).toBe(1);
      expect(await projectFiles()).toEqual([basename(old.asset.storageKey)]);
    },
  );

  it('19개에서 서로 다른 두 화면을 동시에 올려도 하나만 성공해 20개를 넘지 않는다', async () => {
    await fillScreens(19);
    const first = await createScreen();
    const second = await createScreen();
    await synchronizeNextTwoUploads();

    const results = await Promise.allSettled([
      service.putAsset(draftId, first.id, developerId, photo),
      service.putAsset(draftId, second.id, developerId, photo),
    ]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    const failures = results.filter((result) => result.status === 'rejected');
    expect(failures).toHaveLength(1);
    expectConflict(failures[0].reason, 'TOO_MANY_SCREENS');
    expect(await prisma.versionScreen.count()).toBe(20);
    const assets = await prisma.asset.findMany({ where: { projectId } });
    expect(assets).toHaveLength(20);
    expect(await projectFiles()).toEqual(assets.map(({ storageKey }) => basename(storageKey)).sort());
  });

  it('두 사진을 동시에 올려도 함께 1,024 MiB를 넘을 수 없다', async () => {
    const old = await attachScreen(draftId, projectId, quota - storedPhotoBytes);
    const first = await createScreen();
    const second = await createScreen();
    await synchronizeNextTwoUploads();

    const results = await Promise.allSettled([
      service.putAsset(draftId, first.id, developerId, photo),
      service.putAsset(draftId, second.id, developerId, photo),
    ]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    const failures = results.filter((result) => result.status === 'rejected');
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toBeInstanceOf(PayloadTooLargeException);
    expect((await prisma.asset.aggregate({ where: { projectId }, _sum: { bytes: true } }))._sum.bytes).toBe(quota);
    expect(await prisma.versionScreen.count()).toBe(2);
    const assets = await prisma.asset.findMany({ where: { projectId } });
    expect(assets).toHaveLength(2);
    expect(await projectFiles()).toEqual(assets.map(({ storageKey }) => basename(storageKey)).sort());
    await expectPreserved(old);
  });
});
