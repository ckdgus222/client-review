import { Inject, Injectable, Logger } from '@nestjs/common';
import { developerEmail } from '../auth/developer.js';
import { MAIL_TRANSPORT, type MailTransport } from '../mail/mail.service.js';

// 같은 오류가 이어져도 메일함이 넘치지 않게, 오류 알림은 이 시간에 한 통만 보낸다.
const ERROR_ALERT_GAP_MS = 10 * 60 * 1000;

type ServerError = { method: string; route: string; status: number; errorName: string };

// 개발자에게 바로 보내는 알림 메일(docs/deploy.md 정할 것 5). 우편함(DB)을 거치지 않아서 DB가 원인인 오류도 알린다.
@Injectable()
export class AlertService {
  private readonly logger = new Logger(AlertService.name);
  // 아직 보낸 적이 없으면 첫 알림이 늘 나가게 아주 먼 과거로 둔다.
  private lastErrorAlertAt = -Infinity;

  constructor(@Inject(MAIL_TRANSPORT) private readonly transport: MailTransport) {}

  // 백업 실패 같은 운영 알림(send-alert 스크립트)이 쓴다. 못 보내면 부른 쪽이 알게 실패를 그대로 던진다.
  async send(subject: string, text: string) {
    const to = developerEmail();
    if (!to) throw new Error('DEVELOPER_EMAIL이 없어요');
    await this.transport({ to, subject: `[Client Review 알림] ${subject}`, text });
  }

  // 500대 응답을 알린다. 요청은 메일을 기다리지 않고, 보내기가 실패해도 원래 응답은 그대로 나간다.
  // 실제 주소·쿼리·본문·쿠키·오류 메시지는 받지 않는다. 초대 토큰, 로그인 코드, 고객 글이 섞일 수 있다.
  notifyServerError({ method, route, status, errorName }: ServerError) {
    const now = Date.now();
    if (now - this.lastErrorAlertAt < ERROR_ALERT_GAP_MS) return;
    this.lastErrorAlertAt = now;

    const text = [
      `시각: ${new Date(now).toISOString()}`,
      `요청: ${method} ${route}`,
      `상태: ${status}`,
      `오류: ${errorName}`,
    ].join('\n');
    this.send(`서버 오류 ${status}`, text).catch(() => {
      this.logger.error('오류 알림 메일을 보내지 못했어요');
    });
  }
}
