import { Injectable, Logger } from '@nestjs/common';

// 메일을 보내는 부품. 실제 메일은 메일 기능에서 붙이고, 그 전까지는 api 로그에 찍는다.
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  // 로그에 코드가 그대로 남는다. 실제 메일을 붙이기 전까지는 배포하지 않으므로 허용한다.
  sendLoginCode(email: string, code: string) {
    this.logger.log(`로그인 코드 ${code} → ${email}`);
  }

  // 링크에 초대 토큰이 들어 있다. 로그인 코드와 같은 이유로, 실제 메일을 붙이기 전까지만 로그에 찍는다.
  sendInvitation(email: string, link: string, projectName: string, inviterName: string) {
    this.logger.log(`초대 ${inviterName} → ${email} (${projectName}): ${link}`);
  }
}
