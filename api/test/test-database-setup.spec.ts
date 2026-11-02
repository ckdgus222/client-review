import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('node:fs', () => ({ existsSync: vi.fn() }));

describe('테스트 DB 설정과 마이그레이션', () => {
  const testDatabaseUrl = 'postgresql://localhost:5434/client_review_test';
  const developmentDatabaseUrl = 'postgresql://localhost:5434/client_review';

  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.mocked(existsSync).mockReturnValue(false);
    vi.spyOn(process, 'loadEnvFile').mockImplementation(() => {});
    vi.stubEnv('DATABASE_URL', developmentDatabaseUrl);
    vi.stubEnv('TEST_DATABASE_URL', testDatabaseUrl);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('개발 DB 주소를 테스트 DB 주소로 바꾸고 파일은 하나씩 실행한다', async () => {
    const { default: config } = await import('../vitest.config.js');

    expect(process.env.DATABASE_URL).toBe(testDatabaseUrl);
    expect(config.test?.fileParallelism).toBe(false);
    expect(config.test?.globalSetup).toContain('./test/global-setup.ts');
  });

  it.each([undefined, '', developmentDatabaseUrl])(
    'TEST_DATABASE_URL이 %j이면 마이그레이션 전에 설정 로딩이 실패한다',
    async (url) => {
      vi.stubEnv('TEST_DATABASE_URL', url);

      await expect(import('../vitest.config.js')).rejects.toThrowError(
        /TEST_DATABASE_URL/,
      );

      expect(execFileSync).not.toHaveBeenCalled();
    },
  );

  it('루트 .env가 있으면 거기서 읽은 테스트 DB 주소를 검사해 사용한다', async () => {
    vi.stubEnv('TEST_DATABASE_URL', undefined);
    vi.mocked(existsSync).mockReturnValue(true);
    const loadEnvFile = vi
      .spyOn(process, 'loadEnvFile')
      .mockImplementation(() => {
        vi.stubEnv('TEST_DATABASE_URL', testDatabaseUrl);
      });

    await import('../vitest.config.js');

    expect(loadEnvFile).toHaveBeenCalledExactlyOnceWith('../.env');
    expect(process.env.DATABASE_URL).toBe(testDatabaseUrl);
  });

  it('검사한 테스트 DB 주소를 물려받아 migrate deploy를 실행한다', async () => {
    await import('../vitest.config.js');
    const { default: setup } = await import('./global-setup.js');
    let migrationDatabaseUrl: string | undefined;
    vi.mocked(execFileSync).mockImplementation(() => {
      migrationDatabaseUrl = process.env.DATABASE_URL;
      return Buffer.from('');
    });

    setup();

    expect(migrationDatabaseUrl).toBe(testDatabaseUrl);
    expect(execFileSync).toHaveBeenCalledExactlyOnceWith(
      'npx',
      ['prisma', 'migrate', 'deploy'],
      expect.objectContaining({ stdio: 'pipe' }),
    );
  });

  it('마이그레이션이 실패하면 테스트 시작을 중단한다', async () => {
    await import('../vitest.config.js');
    const { default: setup } = await import('./global-setup.js');
    const error = new Error('마이그레이션 실패');
    vi.mocked(execFileSync).mockImplementation(() => {
      throw error;
    });

    expect(() => setup()).toThrowError(error);
  });
});
