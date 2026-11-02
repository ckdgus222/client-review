import { assertTestDatabaseUrl } from './test-database-url.js';

describe('assertTestDatabaseUrl', () => {
  it.each([undefined, ''])('주소가 %j이면 오류를 던진다', (url) => {
    expect(() => assertTestDatabaseUrl(url)).toThrowError(/TEST_DATABASE_URL/);
  });

  it.each([
    'postgresql://localhost:5434/client_review',
    'postgresql://localhost:5434/client_review_test_backup',
    'postgresql://localhost:5434/other_client_review_test',
    'postgresql://localhost:5434/',
    'postgresql://localhost:5434/client_review_test/extra',
    'postgresql://localhost:5434/client_review?application_name=client_review_test',
  ])('DB 이름이 정확히 일치하지 않는 주소 %s를 거부한다', (url) => {
    expect(() => assertTestDatabaseUrl(url)).toThrowError(/client_review_test/);
  });

  it.each([' ', 'not-a-database-url'])('잘못된 주소 %j를 거부한다', (url) => {
    expect(() => assertTestDatabaseUrl(url)).toThrowError();
  });

  it.each([
    'postgresql://localhost:5434/client_review_test',
    'postgres://localhost:5434/client_review_test?schema=public',
  ])('테스트 DB 주소 %s를 바꾸지 않고 돌려준다', (url) => {
    expect(assertTestDatabaseUrl(url)).toBe(url);
  });

  it.each(['client_review', 'client_review_test_backup'])(
    '잘못된 DB 이름 %s의 오류 문구에 비밀번호를 넣지 않는다',
    (databaseName) => {
      // 실제 비밀번호가 아닌 오류 메시지 검사용 문자열이다.
      const password = 'fake-password-for-test';
      const url = `postgresql://tester:${password}@localhost:5434/${databaseName}`;
      const check = vi.fn(() => assertTestDatabaseUrl(url));

      expect(check).toThrowError();
      const error = check.mock.results[0].value as Error;
      expect(error.message).not.toContain(password);
      expect(error.message).not.toContain(url);
    },
  );
});
