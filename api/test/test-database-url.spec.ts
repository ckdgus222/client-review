import { inspect } from 'node:util';
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

  it.each([
    ['포트에 글자가 있음', 'postgresql://user:SECRET_PW@localhost:abc/client_review_test'],
    ['주소가 아닌 글', 'not a url'],
    ['닫히지 않은 호스트 괄호', 'postgresql://user:SECRET_PW@[bad/x'],
    ['포트 범위 초과', 'postgresql://user:SECRET_PW@localhost:65536/client_review_test'],
  ])('%s이면 형식 오류를 던지고 오류 전체에 비밀번호와 주소를 남기지 않는다', (_label, url) => {
    // SECRET_PW는 실제 비밀번호가 아닌 노출 검사용 문자열이다.
    const check = vi.fn(() => assertTestDatabaseUrl(url));

    expect(check).toThrowError(/형식이 잘못/);
    const error = check.mock.results[0].value as Error;
    expect(error).toBeInstanceOf(Error);

    // 숨겨진 속성, Symbol 속성, 중첩된 cause까지 펼쳐 검사한다.
    const errorDetails = inspect(error, {
      showHidden: true,
      depth: null,
      customInspect: false,
      getters: true,
      maxArrayLength: null,
      maxStringLength: null,
    });
    const errorOutput = [
      error.message,
      error.stack,
      inspect(error.cause, { showHidden: true, depth: null, customInspect: false, maxStringLength: null }),
      errorDetails,
      JSON.stringify(error),
      JSON.stringify(Object.entries(error)),
      JSON.stringify(Object.getOwnPropertyDescriptors(error)),
    ].join('\n');

    expect(errorOutput).not.toContain('SECRET_PW');
    expect(errorOutput).not.toContain(url);
  });

  it.each([
    'postgresql://localhost:5434/CLIENT_REVIEW_TEST',
    'postgresql://localhost:5434/client_review_test/',
    'postgresql://localhost:5434/client_review#client_review_test',
  ])('DB 이름의 대소문자·끝 슬래시·해시로 일치 조건을 우회한 주소 %s를 거부한다', (url) => {
    expect(() => assertTestDatabaseUrl(url)).toThrowError(/client_review_test/);
  });

  it('계정 정보와 쿼리가 있는 정상 테스트 DB 주소를 그대로 돌려준다', () => {
    const url = 'postgresql://user:SECRET_PW@localhost:5434/client_review_test?schema=public';

    expect(assertTestDatabaseUrl(url)).toBe(url);
  });
});
