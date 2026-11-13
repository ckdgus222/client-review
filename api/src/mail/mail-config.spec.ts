import { readMailConfig } from './mail-config.js';

describe('readMailConfig', () => {
  const smtpEnv = {
    MAIL_MODE: 'smtp',
    SMTP_HOST: 'smtp.example.com',
    SMTP_PORT: '587',
    SMTP_USER: 'test-user',
    SMTP_PASS: 'fake-password-for-mail-config',
    MAIL_FROM: 'Client Review <noreply@example.com>',
  };

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([undefined, '', '   ', 'log', ' log '])('MAIL_MODE가 %j이면 SMTP 설정 없이 log 모드다', (mode) => {
    expect(readMailConfig({ MAIL_MODE: mode })).toEqual({ mode: 'log' });
  });

  it('log 모드는 남아 있는 잘못된 SMTP 설정을 사용하지 않는다', () => {
    expect(readMailConfig({ ...smtpEnv, MAIL_MODE: 'log', SMTP_PORT: '잘못된 포트' })).toEqual({ mode: 'log' });
  });

  it.each(['SMTP', 'LOG', 'disabled', 'smtp-invalid'])('log/smtp가 아닌 MAIL_MODE=%s는 오류다', (mode) => {
    expect(() => readMailConfig({ ...smtpEnv, MAIL_MODE: mode })).toThrow(/MAIL_MODE/);
  });

  it('인자를 생략하면 process.env에서 설정을 읽는다', () => {
    for (const [name, value] of Object.entries(smtpEnv)) vi.stubEnv(name, value);

    expect(readMailConfig()).toEqual({
      mode: 'smtp',
      host: smtpEnv.SMTP_HOST,
      port: 587,
      user: smtpEnv.SMTP_USER,
      pass: smtpEnv.SMTP_PASS,
      from: smtpEnv.MAIL_FROM,
    });
  });

  it('SMTP 설정이 모두 빠지면 필요한 이름을 모두 알린다', () => {
    expect(() => readMailConfig({ MAIL_MODE: 'smtp' })).toThrow(
      /SMTP_HOST.*SMTP_PORT.*SMTP_USER.*SMTP_PASS.*MAIL_FROM/,
    );
  });

  it.each(['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM'])(
    '%s가 없거나 빈 문자열이면 그 이름을 알리고 비밀번호는 숨긴다',
    (name) => {
      for (const value of [undefined, '']) {
        const read = () => readMailConfig({ ...smtpEnv, [name]: value });
        expect(read).toThrow(name);
        expect(read).not.toThrow(smtpEnv.SMTP_PASS);
      }
    },
  );

  it('여러 값이 함께 빠져도 한 번에 모두 알리고 비밀번호 값은 숨긴다', () => {
    const read = () => readMailConfig({ MAIL_MODE: 'smtp', SMTP_PASS: smtpEnv.SMTP_PASS });

    expect(read).toThrow(/SMTP_HOST.*SMTP_PORT.*SMTP_USER.*MAIL_FROM/);
    expect(read).not.toThrow(smtpEnv.SMTP_PASS);
    expect(read).not.toThrow('SMTP_PASS');
  });

  it.each(['0', '-1', '65536', '587.5', 'NaN', 'Infinity', '587smtp'])(
    '포트 %s는 정수 1~65535가 아니므로 거부한다',
    (port) => {
      const read = () => readMailConfig({ ...smtpEnv, SMTP_PORT: port });

      expect(read).toThrow(/SMTP_PORT/);
      expect(read).not.toThrow(smtpEnv.SMTP_PASS);
    },
  );

  it.each(['1', '465', '587', '65535'])('범위 안의 포트 %s를 숫자로 읽는다', (port) => {
    expect(readMailConfig({ ...smtpEnv, SMTP_PORT: port })).toEqual({
      mode: 'smtp',
      host: smtpEnv.SMTP_HOST,
      port: Number(port),
      user: smtpEnv.SMTP_USER,
      pass: smtpEnv.SMTP_PASS,
      from: smtpEnv.MAIL_FROM,
    });
  });

  it('설정의 앞뒤 공백은 제거하되 비밀번호에 포함된 공백은 보존한다', () => {
    const env = Object.fromEntries(Object.entries(smtpEnv).map(([name, value]) => [name, ` ${value} `]));

    expect(readMailConfig(env)).toEqual({
      mode: 'smtp',
      host: smtpEnv.SMTP_HOST,
      port: 587,
      user: smtpEnv.SMTP_USER,
      pass: ` ${smtpEnv.SMTP_PASS} `,
      from: smtpEnv.MAIL_FROM,
    });
  });

  it.each(['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'MAIL_FROM'])('%s가 공백뿐이면 빠진 값으로 알린다', (name) => {
    expect(() => readMailConfig({ ...smtpEnv, [name]: ' \t ' })).toThrow(name);
  });
});
