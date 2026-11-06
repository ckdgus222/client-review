import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { assetPath, deleteAsset, saveAsset } from './asset-storage.js';

vi.mock('node:crypto', async (importOriginal) => {
  const crypto = await importOriginal<typeof import('node:crypto')>();
  return { ...crypto, randomUUID: vi.fn(crypto.randomUUID) };
});

describe('asset-storage', () => {
  const projectId = '38baae71-dd7a-4b1b-9327-7ba6a561efb1';
  const otherProjectId = '0c463633-bd71-43d5-8a84-593646dcad18';
  const fixedUuid = '15aaf79f-e432-46de-8ade-c9b9397dc362';
  const data = Buffer.from([0x00, 0xff, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
  let directory: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    directory = await mkdtemp(join(tmpdir(), 'asset-storage-'));
    vi.stubEnv('ASSET_DIR', directory);
    vi.mocked(randomUUID).mockReset();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    vi.unstubAllEnvs();
    vi.mocked(randomUUID).mockReset();
    await rm(directory, { recursive: true, force: true });
  });

  it('assetPath는 파일이 없어도 ASSET_DIR 아래의 절대 경로만 돌려준다', async () => {
    const storageKey = `${projectId}/${fixedUuid}.png`;

    const path = assetPath(storageKey);

    expect(isAbsolute(path)).toBe(true);
    expect(path).toBe(join(directory, storageKey));
    expect(await readdir(directory)).toEqual([]);
  });

  it.each(['png', 'jpg', 'webp'])(
    '%s 파일을 프로젝트 폴더에 UUID v4 이름으로 저장하고 바이트를 그대로 보존한다',
    async (extension) => {
      const storageKey = await saveAsset(projectId, extension, data);

      expect(storageKey).toMatch(
        new RegExp(`^${projectId}/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.${extension}$`),
      );
      expect(isAbsolute(storageKey)).toBe(false);
      const path = join(directory, storageKey);
      expect(assetPath(storageKey)).toBe(path);
      expect(dirname(path)).toBe(join(directory, projectId));
      expect(await readFile(path)).toEqual(data);
      expect(await readdir(join(directory, projectId))).toEqual([basename(storageKey)]);
    },
  );

  it('저장소와 프로젝트 폴더가 아직 없으면 함께 만든다', async () => {
    const assetDirectory = join(directory, 'new', 'assets');
    vi.stubEnv('ASSET_DIR', assetDirectory);
    await expect(stat(assetDirectory)).rejects.toMatchObject({ code: 'ENOENT' });

    const storageKey = await saveAsset(projectId, 'png', data);

    expect((await stat(join(assetDirectory, projectId))).isDirectory()).toBe(true);
    expect(await readFile(join(assetDirectory, storageKey))).toEqual(data);
  });

  it('같은 프로젝트에 두 번 저장하면 다른 이름으로 두 파일을 남긴다', async () => {
    const otherData = Buffer.from([0x00, 0x01, 0xfe]);

    const firstKey = await saveAsset(projectId, 'png', data);
    const secondKey = await saveAsset(projectId, 'png', otherData);

    expect(secondKey).not.toBe(firstKey);
    expect(await readFile(join(directory, firstKey))).toEqual(data);
    expect(await readFile(join(directory, secondKey))).toEqual(otherData);
    expect(await readdir(join(directory, projectId))).toHaveLength(2);
  });

  it('같은 이름이 이미 있으면 저장을 거부하고 기존 파일을 보존한다', async () => {
    vi.mocked(randomUUID).mockReturnValue(fixedUuid);
    const storageKey = `${projectId}/${fixedUuid}.png`;
    await mkdir(join(directory, projectId));
    await writeFile(join(directory, storageKey), data);

    await expect(saveAsset(projectId, 'png', Buffer.from('replacement'))).rejects.toMatchObject({
      code: 'EEXIST',
    });

    expect(await readFile(join(directory, storageKey))).toEqual(data);
    expect(await readdir(join(directory, projectId))).toEqual([`${fixedUuid}.png`]);
  });

  it('동시에 같은 이름으로 저장해도 한 번만 성공하고 성공한 파일을 보존한다', async () => {
    vi.mocked(randomUUID).mockReturnValue(fixedUuid);
    const inputs = [data, Buffer.from('another upload')];

    const results = await Promise.allSettled(inputs.map((input) => saveAsset(projectId, 'png', input)));

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: 'EEXIST' }) }),
    ]);
    const savedIndex = results.findIndex((result) => result.status === 'fulfilled');
    expect(await readFile(join(directory, projectId, `${fixedUuid}.png`))).toEqual(inputs[savedIndex]);
    expect(await readdir(join(directory, projectId))).toEqual([`${fixedUuid}.png`]);
  });

  it('다른 프로젝트는 같은 파일 이름이어도 서로 다른 폴더에 저장한다', async () => {
    vi.mocked(randomUUID).mockReturnValue(fixedUuid);
    const otherData = Buffer.from('another project');

    const firstKey = await saveAsset(projectId, 'png', data);
    const secondKey = await saveAsset(otherProjectId, 'png', otherData);

    expect(firstKey).toBe(`${projectId}/${fixedUuid}.png`);
    expect(secondKey).toBe(`${otherProjectId}/${fixedUuid}.png`);
    expect(await readFile(join(directory, firstKey))).toEqual(data);
    expect(await readFile(join(directory, secondKey))).toEqual(otherData);
  });

  it('프로젝트 폴더 자리에 파일이 있으면 저장 오류를 알리고 그 파일을 보존한다', async () => {
    await writeFile(join(directory, projectId), data);

    await expect(saveAsset(projectId, 'png', data)).rejects.toThrow();

    expect(await readFile(join(directory, projectId))).toEqual(data);
    expect(await readdir(directory)).toEqual([projectId]);
  });

  it('지정한 파일만 지우고 두 번 지워도 같은 프로젝트와 다른 프로젝트의 파일은 남긴다', async () => {
    const storageKey = await saveAsset(projectId, 'png', data);
    const siblingKey = await saveAsset(projectId, 'png', data);
    const otherKey = await saveAsset(otherProjectId, 'png', data);

    await expect(deleteAsset(storageKey)).resolves.toBeUndefined();
    await expect(readFile(join(directory, storageKey))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(deleteAsset(storageKey)).resolves.toBeUndefined();

    expect(await readFile(join(directory, siblingKey))).toEqual(data);
    expect(await readFile(join(directory, otherKey))).toEqual(data);
  });

  it('프로젝트 폴더도 없는 파일을 지워도 성공하고 폴더를 만들지 않는다', async () => {
    await expect(deleteAsset(`${projectId}/${fixedUuid}.png`)).resolves.toBeUndefined();

    expect(await readdir(directory)).toEqual([]);
  });

  it('파일 경로가 폴더이면 삭제 오류를 숨기지 않고 안의 파일을 보존한다', async () => {
    const storageKey = `${projectId}/${fixedUuid}.png`;
    const childPath = join(directory, storageKey, 'keep.txt');
    await mkdir(join(directory, storageKey), { recursive: true });
    await writeFile(childPath, data);

    await expect(deleteAsset(storageKey)).rejects.toThrow();

    expect(await readFile(childPath)).toEqual(data);
  });

  it('ASSET_DIR을 바꾸면 세 함수 모두 호출 시점의 폴더를 사용한다', async () => {
    vi.mocked(randomUUID).mockReturnValue(fixedUuid);
    const storageKey = await saveAsset(projectId, 'png', data);
    expect(assetPath(storageKey)).toBe(join(directory, storageKey));
    const nextDirectory = join(directory, 'next-assets');
    vi.stubEnv('ASSET_DIR', nextDirectory);
    const nextData = Buffer.from('next directory');

    expect(assetPath(storageKey)).toBe(join(nextDirectory, storageKey));
    expect(await saveAsset(projectId, 'png', nextData)).toBe(storageKey);
    expect(await readFile(join(nextDirectory, storageKey))).toEqual(nextData);
    await deleteAsset(storageKey);

    await expect(readFile(join(nextDirectory, storageKey))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(directory, storageKey))).toEqual(data);
  });

  it.each([
    { label: '없음', value: undefined },
    { label: '빈 문자열', value: '' },
    { label: '공백만', value: ' \t\n ' },
  ])('ASSET_DIR이 $label이면 세 함수 모두 오류이고 파일을 만들거나 지우지 않는다', async ({ value }) => {
    // 설정이 잘못되어 현재 폴더에 쓰는 구현도 개발 파일 대신 임시 폴더에서 검출한다.
    process.chdir(directory);
    const storageKey = `${projectId}/${fixedUuid}.png`;
    await mkdir(join(directory, projectId));
    await writeFile(join(directory, storageKey), data);
    vi.stubEnv('ASSET_DIR', value);

    expect(() => assetPath(storageKey)).toThrow(Error);
    await expect(saveAsset(projectId, 'png', data)).rejects.toThrow(Error);
    await expect(deleteAsset(storageKey)).rejects.toThrow(Error);

    expect(await readFile(join(directory, storageKey))).toEqual(data);
    expect(await readdir(join(directory, projectId))).toEqual([`${fixedUuid}.png`]);
    expect(await readdir(directory)).toEqual([projectId]);
  });

  it('상대 ASSET_DIR은 현재 작업 폴더 기준으로 해석하고 저장과 삭제에 같은 절대 경로를 쓴다', async () => {
    vi.stubEnv('ASSET_DIR', relative(process.cwd(), directory));

    const storageKey = await saveAsset(projectId, 'png', data);

    expect(isAbsolute(assetPath(storageKey))).toBe(true);
    expect(assetPath(storageKey)).toBe(join(directory, storageKey));
    expect(await readFile(join(directory, storageKey))).toEqual(data);
    await deleteAsset(storageKey);
    await expect(readFile(join(directory, storageKey))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
