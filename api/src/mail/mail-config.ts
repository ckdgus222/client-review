export type MailConfig =
  { mode: 'log' } | { mode: 'smtp'; host: string; port: number; user: string; pass: string; from: string };

// 메일 설정은 이 함수 하나만 읽는다. 잘못된 설정이면 앱을 만들 때 던져서 api가 켜지지 않는다.
// 메일이 조용히 안 가는 것보다 켜지지 않는 편이 바로 알 수 있다.
// env를 인자로 받아서 테스트가 process.env를 바꾸지 않고 확인할 수 있다.
export const readMailConfig = (env: NodeJS.ProcessEnv = process.env): MailConfig => {
  // 비우면 log다. 지금의 .env와 테스트가 설정을 더하지 않아도 그대로 돈다.
  const mode = env.MAIL_MODE?.trim() || 'log';
  if (mode === 'log') return { mode };
  if (mode !== 'smtp') throw new Error(`MAIL_MODE는 log나 smtp여야 해요: ${mode}`);

  const values = {
    SMTP_HOST: env.SMTP_HOST?.trim() ?? '',
    SMTP_PORT: env.SMTP_PORT?.trim() ?? '',
    SMTP_USER: env.SMTP_USER?.trim() ?? '',
    SMTP_PASS: env.SMTP_PASS ?? '',
    MAIL_FROM: env.MAIL_FROM?.trim() ?? '',
  };
  // 빠진 값의 이름만 알린다. 값(특히 비밀번호)은 오류에 넣지 않는다.
  const missing = Object.entries(values)
    .filter(([, value]) => value === '')
    .map(([name]) => name);
  if (missing.length > 0) throw new Error(`MAIL_MODE=smtp에 필요한 값이 비어 있어요: ${missing.join(', ')}`);

  const port = Number(values.SMTP_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SMTP_PORT는 1~65535의 숫자여야 해요');

  return {
    mode,
    host: values.SMTP_HOST,
    port,
    user: values.SMTP_USER,
    pass: values.SMTP_PASS,
    from: values.MAIL_FROM,
  };
};
