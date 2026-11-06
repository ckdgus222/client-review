import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

// 값이 비어 있으면 아무 폴더에나 쓰지 않고 멈춘다(요청은 500으로 끝난다).
// 상대 경로는 api를 켠 폴더(api/) 기준이다.
export const assetPath = (storageKey: string) => {
  const dir = process.env.ASSET_DIR?.trim();
  if (!dir) throw new Error('ASSET_DIR가 비어 있어요');
  return resolve(dir, storageKey);
};

// 경로의 세 부분(프로젝트 id, 무작위 UUID, 정해진 확장자)은 모두 서버가 만든 값이라 사용자가 다른 폴더를 가리킬 수 없다.
// 'wx'는 같은 이름이 있으면 실패해서, 지난 버전이 쓰는 파일을 덮어쓰지 않는다.
export const saveAsset = async (projectId: string, extension: string, data: Buffer) => {
  const storageKey = `${projectId}/${randomUUID()}.${extension}`;
  const path = assetPath(storageKey);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data, { flag: 'wx' });
  return storageKey;
};

// 이미 없는 파일은 지운 것으로 친다. 실패 뒤 정리를 다시 해도 오류가 나지 않는다.
export const deleteAsset = async (storageKey: string) => {
  await rm(assetPath(storageKey), { force: true });
};
