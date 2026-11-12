import { Logger } from '@nestjs/common';
import { deleteAsset } from './asset-storage.js';

const logger = new Logger('AssetCleanup');

// DB 작업이 끝난 뒤(실패해서 새 파일을 치울 때, 성공해서 옛 파일을 치울 때) 파일을 지운다.
// 파일 지우기가 실패해도 요청의 결과(원래 오류나 성공)를 바꾸지 않는다. DB에 없는 파일이 남을 뿐이고, 9번 정리 작업이 지운다.
export const deleteAssetQuietly = async (storageKey: string) => {
  await deleteAsset(storageKey).catch((error) => {
    logger.error(`사진 파일을 지우지 못했어요: ${storageKey}`, error);
  });
};
