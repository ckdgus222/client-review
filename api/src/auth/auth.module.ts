import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { MailService } from '../mail/mail.service.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { OriginGuard } from './guards/origin.guard.js';
import { SessionGuard } from './guards/session.guard.js';

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    MailService,
    // APP_GUARD로 등록하면 모든 주소에 걸린다. 적은 순서대로 돌아서,
    // 다른 사이트의 요청은 세션을 찾아보기 전에 403으로 막는다.
    { provide: APP_GUARD, useClass: OriginGuard },
    { provide: APP_GUARD, useClass: SessionGuard },
  ],
})
export class AuthModule {}
