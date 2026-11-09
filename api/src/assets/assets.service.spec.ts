import { randomUUID } from 'node:crypto';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { resetDatabase } from '../../test/reset-database.js';
import type { VersionStatus } from '../generated/prisma/client.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { AssetsService } from './assets.service.js';

const expectAssetNotFound = (error: unknown) => {
  expect(error).toBeInstanceOf(NotFoundException);
  if (!(error instanceof NotFoundException)) throw new Error('404 오류가 필요해요');
  expect(error.getStatus()).toBe(404);
  expect(error.getResponse()).toStrictEqual({ statusCode: 404, message: '없는 사진이에요', error: 'Not Found' });
};

describe('AssetsService', () => {
  let module: TestingModule | undefined;
  let prisma: PrismaService;
  let service: AssetsService;
  let directory: string;
  let developerId: string;
  let clientId: string;
  let outsiderId: string;
  let projectId: string;
  let otherProjectId: string;
  const missingId = '00000000-0000-4000-8000-000000000001';
  const publishedAt = new Date('2026-01-01T00:00:00Z');

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [AssetsService, ProjectsService],
    }).compile();
    prisma = module.get(PrismaService);
    service = module.get(AssetsService);
  });

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'assets-service-'));
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
    const otherProject = await prisma.project.create({
      data: { name: '다른 프로젝트', members: { create: { userId: outsiderId, role: 'DEVELOPER' } } },
    });
    projectId = project.id;
    otherProjectId = otherProject.id;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  afterAll(async () => {
    await module?.close();
  });

  // 파일 읽기는 컨트롤러 몫이다. 실제 DB에 사진 정보와 사용 관계만 준비한다.
  const createAsset = (ownerProjectId = projectId, mime = 'image/png', extension = 'png') =>
    prisma.asset.create({
      data: {
        projectId: ownerProjectId,
        storageKey: `${ownerProjectId}/${randomUUID()}.${extension}`,
        mime,
        bytes: 100,
        width: 800,
        height: 600,
      },
    });

  const createVersion = (status: VersionStatus, ownerProjectId = projectId, number = 1) =>
    prisma.deliveryVersion.create({
      data: {
        projectId: ownerProjectId,
        status,
        number: status === 'DRAFT' ? null : number,
        publishedAt: status === 'DRAFT' ? null : publishedAt,
      },
    });

  const attachAsset = async (versionId: string, asset: { id: string; projectId: string }) => {
    const screen = await prisma.screen.create({
      data: { projectId: asset.projectId, name: `화면 ${randomUUID()}`, viewport: 'PC' },
    });
    await prisma.versionScreen.create({ data: { versionId, screenId: screen.id, assetId: asset.id } });
    return screen;
  };

  it.each(['DRAFT', 'IN_REVIEW', 'APPROVED', null] as const)(
    '개발자는 사용 버전 상태가 %s인 사진도 받는다(null은 어디에도 안 쓰임)',
    async (status) => {
      const asset = await createAsset();
      if (status) {
        const version = await createVersion(status);
        await attachAsset(version.id, asset);
      }

      await expect(service.getFileForMember(asset.id, developerId)).resolves.toStrictEqual({
        path: join(directory, asset.storageKey),
        mime: asset.mime,
      });
    },
  );

  it.each(['IN_REVIEW', 'APPROVED'] as const)('클라이언트는 %s 버전이 쓰는 사진을 받는다', async (status) => {
    const asset = await createAsset();
    const version = await createVersion(status);
    await attachAsset(version.id, asset);

    await expect(service.getFileForMember(asset.id, clientId)).resolves.toStrictEqual({
      path: join(directory, asset.storageKey),
      mime: asset.mime,
    });
  });

  it.each(['DRAFT', null] as const)(
    '다른 사진이 게시되어 있어도 클라이언트에게 %s 전용 사진은 없는 사진과 같은 404다',
    async (status) => {
      const publishedAsset = await createAsset();
      const published = await createVersion('IN_REVIEW');
      await attachAsset(published.id, publishedAsset);
      const asset = await createAsset();
      if (status) {
        const draft = await createVersion(status);
        await attachAsset(draft.id, asset);
      }

      const denied = await service.getFileForMember(asset.id, clientId).catch((error: unknown) => error);
      const missing = await service.getFileForMember(missingId, clientId).catch((error: unknown) => error);

      expectAssetNotFound(denied);
      expectAssetNotFound(missing);
    },
  );

  it.each(['DRAFT', 'IN_REVIEW', 'APPROVED', null] as const)(
    '비멤버에게는 사용 버전 상태가 %s인 사진도 없는 사진과 같은 404다',
    async (status) => {
      const asset = await createAsset();
      if (status) {
        const version = await createVersion(status);
        await attachAsset(version.id, asset);
      }

      const denied = await service.getFileForMember(asset.id, outsiderId).catch((error: unknown) => error);
      const missing = await service.getFileForMember(missingId, outsiderId).catch((error: unknown) => error);

      expectAssetNotFound(denied);
      expectAssetNotFound(missing);
    },
  );

  it('개발자도 없는 사진 id로 요청하면 같은 404를 받는다', async () => {
    const error = await service.getFileForMember(missingId, developerId).catch((error: unknown) => error);

    expectAssetNotFound(error);
  });

  it.each(['DEVELOPER', 'CLIENT'] as const)(
    '자기 프로젝트에서 %s여도 멤버가 아닌 다른 프로젝트의 게시 사진은 404다',
    async (role) => {
      const asset = await createAsset(otherProjectId);
      const version = await createVersion('IN_REVIEW', otherProjectId);
      await attachAsset(version.id, asset);
      const userId = role === 'DEVELOPER' ? developerId : clientId;

      const error = await service.getFileForMember(asset.id, userId).catch((error: unknown) => error);

      expectAssetNotFound(error);
    },
  );

  it('다른 프로젝트에서는 클라이언트인 개발자는 그 프로젝트의 초안 사진을 못 받는다', async () => {
    await prisma.projectMember.create({
      data: { projectId: otherProjectId, userId: developerId, role: 'CLIENT' },
    });
    const asset = await createAsset(otherProjectId);
    const draft = await createVersion('DRAFT', otherProjectId);
    await attachAsset(draft.id, asset);

    const error = await service.getFileForMember(asset.id, developerId).catch((error: unknown) => error);

    expectAssetNotFound(error);
  });

  it('1차 게시 버전과 2차 초안이 함께 쓰는 사진은 클라이언트도 받는다', async () => {
    const asset = await createAsset();
    const published = await createVersion('IN_REVIEW');
    const draft = await createVersion('DRAFT');
    const screen = await attachAsset(published.id, asset);
    await prisma.versionScreen.create({ data: { versionId: draft.id, screenId: screen.id, assetId: asset.id } });

    await expect(service.getFileForMember(asset.id, clientId)).resolves.toStrictEqual({
      path: join(directory, asset.storageKey),
      mime: asset.mime,
    });
  });

  it('현재 2차 버전이 다른 사진을 써도 클라이언트는 지난 1차 사진을 받는다', async () => {
    const firstAsset = await createAsset();
    const first = await createVersion('IN_REVIEW');
    await attachAsset(first.id, firstAsset);
    const secondAsset = await createAsset();
    const second = await createVersion('IN_REVIEW', projectId, 2);
    await attachAsset(second.id, secondAsset);
    await prisma.project.update({ where: { id: projectId }, data: { currentVersionId: second.id } });

    await expect(service.getFileForMember(firstAsset.id, clientId)).resolves.toStrictEqual({
      path: join(directory, firstAsset.storageKey),
      mime: firstAsset.mime,
    });
  });

  it('게시 뒤 화면 이름표가 숨겨져도 클라이언트는 게시된 사진을 받는다', async () => {
    const asset = await createAsset();
    const published = await createVersion('IN_REVIEW');
    const screen = await attachAsset(published.id, asset);
    await prisma.screen.update({ where: { id: screen.id }, data: { hiddenAt: new Date() } });

    await expect(service.getFileForMember(asset.id, clientId)).resolves.toStrictEqual({
      path: join(directory, asset.storageKey),
      mime: asset.mime,
    });
  });

  it('사진을 받은 뒤 멤버에서 빠지면 다음 요청은 같은 404다', async () => {
    const asset = await createAsset();
    const published = await createVersion('IN_REVIEW');
    await attachAsset(published.id, asset);
    await expect(service.getFileForMember(asset.id, clientId)).resolves.toStrictEqual({
      path: join(directory, asset.storageKey),
      mime: asset.mime,
    });
    await prisma.projectMember.delete({ where: { projectId_userId: { projectId, userId: clientId } } });

    const error = await service.getFileForMember(asset.id, clientId).catch((error: unknown) => error);

    expectAssetNotFound(error);
  });

  it.each([
    ['image/png', 'png'],
    ['image/jpeg', 'jpg'],
    ['image/webp', 'webp'],
  ])('ASSET_DIR 기준 절대 경로와 저장된 mime %s를 반환한다', async (mime, extension) => {
    const asset = await createAsset(projectId, mime, extension);
    vi.stubEnv('ASSET_DIR', relative(process.cwd(), directory));

    const file = await service.getFileForMember(asset.id, developerId);

    expect(isAbsolute(file.path)).toBe(true);
    expect(file).toStrictEqual({ path: resolve(directory, asset.storageKey), mime });
  });

  it('실제 사진 파일이 없어도 파일을 읽지 않고 경로와 mime만 반환한다', async () => {
    const asset = await createAsset();
    const published = await createVersion('IN_REVIEW');
    await attachAsset(published.id, asset);
    const path = join(directory, asset.storageKey);
    await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });

    await expect(service.getFileForMember(asset.id, clientId)).resolves.toStrictEqual({ path, mime: asset.mime });
  });

  it('ASSET_DIR가 비었으면 임의의 경로를 반환하지 않고 실패한다', async () => {
    const asset = await createAsset();
    vi.stubEnv('ASSET_DIR', '');

    await expect(service.getFileForMember(asset.id, developerId)).rejects.toThrow('ASSET_DIR가 비어 있어요');
  });
});
