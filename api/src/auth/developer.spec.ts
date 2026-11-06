import { isDeveloper } from './developer.js';

describe('isDeveloper', () => {
  const email = 'developer@example.com';

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    { label: '같은 이메일', value: email },
    { label: '대소문자가 다름', value: email.toUpperCase() },
    { label: '앞뒤 공백이 있음', value: `  ${email}  ` },
    { label: '대소문자와 앞뒤 공백이 다름', value: ` \t${email.toUpperCase()}\n ` },
  ])('설정이 $label이면 true다', ({ value }) => {
    vi.stubEnv('DEVELOPER_EMAIL', value);

    expect(isDeveloper(email)).toBe(true);
  });

  it.each([
    { label: '다른 사용자', address: 'client@example.com' },
    { label: '다른 도메인', address: 'developer@other.example' },
    { label: '설정 이메일을 포함하는 주소', address: `other-${email}` },
    { label: '설정 이메일의 일부인 주소', address: 'veloper@example.com' },
  ])('$label이면 false다', ({ address }) => {
    vi.stubEnv('DEVELOPER_EMAIL', email);

    expect(isDeveloper(address)).toBe(false);
  });

  it.each([
    { label: '없음', value: undefined },
    { label: '빈 문자열', value: '' },
    { label: '공백만', value: ' \t\n ' },
  ])('설정이 $label이면 빈 이메일을 포함해 누구도 개발자가 아니다', ({ value }) => {
    vi.stubEnv('DEVELOPER_EMAIL', value);

    expect(isDeveloper(email)).toBe(false);
    expect(isDeveloper('')).toBe(false);
  });
});
