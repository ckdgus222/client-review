// 테스트는 표를 비운다. 개발 DB 주소를 잘못 넣어도 마이그레이션이나 표 비우기 전에 멈추도록 DB 이름을 확인한다.
export const TEST_DATABASE_NAME = 'client_review_test';

export const assertTestDatabaseUrl = (url: string | undefined) => {
  if (!url) throw new Error('TEST_DATABASE_URL이 없어요. 루트 .env에 테스트 DB 주소를 적어 주세요');

  // 주소 안에 비밀번호가 있어서 오류 어디에도 주소를 넣지 않는다.
  // new URL이 던지는 오류는 주소를 통째로 담고 있어서, 먼저 읽을 수 있는 주소인지만 본다.
  if (!URL.canParse(url)) throw new Error('TEST_DATABASE_URL 형식이 잘못됐어요. 주소를 확인해 주세요');
  const databaseName = new URL(url).pathname.slice(1);
  if (databaseName !== TEST_DATABASE_NAME) {
    throw new Error(`TEST_DATABASE_URL의 DB 이름은 ${TEST_DATABASE_NAME}여야 해요. 지금 값: ${databaseName}`);
  }

  return url;
};
