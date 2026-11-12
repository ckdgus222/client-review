import { PayloadTooLargeException } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';

const PROJECT_QUOTA_MIB = 1024;
const PROJECT_QUOTA_BYTES = PROJECT_QUOTA_MIB * 1024 * 1024;

// 버전 화면의 사진과 쪽지의 참고 사진이 프로젝트 용량을 함께 쓴다.
// 프로젝트 줄을 잠근 뒤에 부른다. 잠근 뒤에 합계를 계산해서, 사진 두 장을 동시에 올려도 함께 한도를 넘지 못한다.
export const requireProjectQuota = async (tx: Prisma.TransactionClient, projectId: string, addedBytes: number) => {
  const { _sum } = await tx.asset.aggregate({ where: { projectId }, _sum: { bytes: true } });
  if ((_sum.bytes ?? 0) + addedBytes > PROJECT_QUOTA_BYTES) {
    throw new PayloadTooLargeException(`프로젝트 사진 용량(${PROJECT_QUOTA_MIB} MiB)을 넘어요`);
  }
};
