import { Inject, Injectable, Logger } from '@nestjs/common';
import { createTransport } from 'nodemailer';
import type { MailConfig } from './mail-config.js';

export type Mail = { to: string; subject: string; text: string };

// 메일 한 통을 실제로 보내는 함수. 테스트는 MailService 대신 이것만 가짜로 바꿔서,
// MailService 안의 실패 처리(기다리지 않기, 로그에 코드를 남기지 않기)까지 확인한다.
export type MailTransport = (mail: Mail) => Promise<void>;
export const MAIL_TRANSPORT = Symbol('MAIL_TRANSPORT');

// 한 단계(연결, 서버 인사, 응답 없는 시간)마다 이만큼 기다리면 실패로 센다.
const SMTP_STEP_LIMIT_MS = 20_000;

export const createMailTransport = (config: MailConfig): MailTransport => {
  if (config.mode === 'log') {
    // 개발용이다. 보내지 않고 api 로그에 찍어서 로그인 코드와 초대 링크도 그대로 남는다. 배포에서는 smtp로 켠다.
    const logger = new Logger('MailLog');
    return async ({ to, subject, text }) => {
      logger.log(`${subject} → ${to}\n${text}`);
    };
  }

  // 465는 처음부터 TLS로 붙는 포트다. 그 밖의 포트(587 등)는 STARTTLS를 꼭 쓰게 해서 비밀번호가 맨글자로 가지 않는다.
  const isImplicitTls = config.port === 465;
  const transporter = createTransport({
    host: config.host,
    port: config.port,
    secure: isImplicitTls,
    requireTLS: !isImplicitTls,
    auth: { user: config.user, pass: config.pass },
    connectionTimeout: SMTP_STEP_LIMIT_MS,
    greetingTimeout: SMTP_STEP_LIMIT_MS,
    socketTimeout: SMTP_STEP_LIMIT_MS,
  });
  return async (mail) => {
    await transporter.sendMail({ from: config.from, ...mail });
  };
};

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(@Inject(MAIL_TRANSPORT) private readonly transport: MailTransport) {}

  // 우편함(알림 메일)이 쓴다. 실패는 부르는 쪽이 받아서 다시 보낼 차례를 정한다.
  async send(mail: Mail) {
    await this.transport(mail);
  }

  // 요청은 메일을 기다리지 않는다. 메일을 보내는 이메일(가입·초대된 사람)만 응답이 늦으면
  // 응답 시간으로 가입 여부가 드러난다(docs/mail.md 정할 것 4). 못 받으면 60초 뒤 다시 요청한다.
  sendLoginCode(email: string, code: string) {
    this.sendWithoutWaiting('로그인 코드', {
      to: email,
      subject: '[Client Review] 로그인 코드',
      text: `로그인 코드는 ${code}예요.\n10분 동안 쓸 수 있어요. 요청하지 않았다면 이 메일을 지워 주세요.`,
    });
  }

  // 초대한 개발자는 화면의 링크 복사로도 보낼 수 있어서, 메일이 실패해도 초대는 성공으로 둔다.
  // 제목에는 프로젝트 이름을 넣지 않는다. 사용자가 쓴 글이 메일 머리말에 들어가지 않게 한다.
  sendInvitation(email: string, link: string, projectName: string, inviterName: string) {
    this.sendWithoutWaiting('초대', {
      to: email,
      subject: '[Client Review] 프로젝트 초대',
      text: `${inviterName}님이 "${projectName}" 검수에 초대했어요.\n아래 링크를 열고 이 이메일로 로그인하면 참여할 수 있어요. 링크는 7일 동안 쓸 수 있어요.\n${link}`,
    });
  }

  private sendWithoutWaiting(kind: string, mail: Mail) {
    // 실패 로그에는 종류와 받는 주소만 남긴다. 오류 내용에 메일 본문(코드, 초대 링크)이 섞일 수 있어서 적지 않는다.
    this.transport(mail).catch(() => {
      this.logger.error(`${kind} 메일을 보내지 못했어요 → ${mail.to}`);
    });
  }
}
