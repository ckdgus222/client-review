import type { PrismaClient } from '../src/generated/prisma/client.js';
import { resetDatabase } from './reset-database.js';

describe('resetDatabase 안전 검사', () => {
  const queryRaw = vi.fn();
  const executeRaw = vi.fn();
  const prisma = {
    $queryRaw: queryRaw,
    $executeRaw: executeRaw,
  } as unknown as PrismaClient;

  beforeEach(() => {
    vi.resetAllMocks();
    executeRaw.mockResolvedValue(0);
  });

  it('실제로 연결된 DB가 테스트 DB이면 확인 뒤 표를 비운다', async () => {
    queryRaw.mockResolvedValue([{ name: 'client_review_test' }]);

    await resetDatabase(prisma);

    expect(queryRaw).toHaveBeenCalledOnce();
    expect(executeRaw).toHaveBeenCalledOnce();
    expect(queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      executeRaw.mock.invocationCallOrder[0],
    );
  });

  it.each(['client_review', 'postgres', 'client_review_test_backup', ''])(
    '실제 DB 이름이 %j이면 표를 비우지 않고 오류를 던진다',
    async (name) => {
      queryRaw.mockResolvedValue([{ name }]);

      await expect(resetDatabase(prisma)).rejects.toThrowError();

      expect(executeRaw).not.toHaveBeenCalled();
    },
  );

  it('DB 이름 조회가 실패하면 표를 비우지 않는다', async () => {
    const error = new Error('DB 이름 조회 실패');
    queryRaw.mockRejectedValue(error);

    await expect(resetDatabase(prisma)).rejects.toThrowError(error);

    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('DB 이름 조회 결과가 없으면 표를 비우지 않는다', async () => {
    queryRaw.mockResolvedValue([]);

    await expect(resetDatabase(prisma)).rejects.toThrowError();

    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('표 비우기가 실패하면 오류를 호출한 쪽에 전달한다', async () => {
    queryRaw.mockResolvedValue([{ name: 'client_review_test' }]);
    const error = new Error('표 비우기 실패');
    executeRaw.mockRejectedValue(error);

    await expect(resetDatabase(prisma)).rejects.toThrowError(error);
  });
});
