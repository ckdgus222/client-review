import { PrismaService } from './prisma.service.js';

describe('PrismaService', () => {
  let service: PrismaService | undefined;

  afterEach(async () => {
    vi.unstubAllEnvs();
    await service?.$disconnect();
    service = undefined;
  });

  it('실제 DB에서 SELECT 1을 실행하면 1을 반환한다', async () => {
    service = new PrismaService();

    const result = await service.$queryRaw<{ value: number }[]>`
      SELECT 1 AS value
    `;

    expect(result).toEqual([{ value: 1 }]);
  });

  it.each([undefined, ''])('DATABASE_URL이 %j이면 생성할 때 오류를 던진다', (url) => {
    vi.stubEnv('DATABASE_URL', url);

    expect(() => {
      service = new PrismaService();
    }).toThrowError(/DATABASE_URL/);
  });
});
