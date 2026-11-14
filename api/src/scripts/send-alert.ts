import { AlertService } from '../alert/alert.service.js';
import { readMailConfig } from '../mail/mail-config.js';
import { createMailTransport, type MailTransport } from '../mail/mail.service.js';

// 운영 스크립트(백업·업데이트)가 실패를 개발자에게 알릴 때 쓴다(docs/deploy.md 정할 것 5).
// api가 꺼져 있어도 돌게 api 서버 없이 메일 발송기만 만든다.
export const sendAlert = async (text: string, transport: MailTransport = createMailTransport(readMailConfig())) => {
  await new AlertService(transport).send('운영 알림', text);
};

// npm run send-alert -- "<글>"로 직접 실행했을 때만 돈다(테스트는 함수만 가져다 쓴다).
if (import.meta.main) {
  const text = process.argv[2];
  if (!text) {
    console.error('사용: npm run send-alert -- "<알릴 글>"');
    process.exit(1);
  }
  try {
    await sendAlert(text);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
