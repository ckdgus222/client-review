import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { CookieOptions, Request, Response } from 'express';
import { AuthService } from './auth.service.js';
import { Public } from './decorators/public.decorator.js';
import { RequestCodeDto } from './dto/request-code.dto.js';
import { VerifyCodeDto } from './dto/verify-code.dto.js';
import {
  type AuthenticatedRequest,
  readSessionToken,
  SESSION_COOKIE,
} from './guards/session.guard.js';

// DB의 세션 끝 시각(7일)과 맞춘다. Express는 초가 아니라 밀리초로 받는다.
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// 쿠키를 만들 때와 지울 때 같이 쓴다. path가 다르면 브라우저가 다른 쿠키로 보고 지우지 않는다.
const sessionCookieOptions = (): CookieOptions => ({
  // 페이지의 JS가 쿠키를 읽지 못하게 한다.
  httpOnly: true,
  // 다른 사이트에서 보낸 POST에는 쿠키를 붙이지 않는다.
  sameSite: 'lax',
  // api 요청에만 붙고 화면 파일(/app/...) 요청에는 붙지 않는다. setup-app.ts의 /api 앞머리와 같아야 한다.
  path: '/api',
  // https에서만 보내게 한다. 맥(http)에서는 끄고 배포에서 켠다.
  secure: process.env.COOKIE_SECURE === 'true',
});

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  // 처음 보는 이메일이든 아니든 같은 응답이라 가입 여부가 드러나지 않는다.
  @Public()
  @Post('email-code')
  @HttpCode(HttpStatus.NO_CONTENT)
  async requestCode(@Body() body: RequestCodeDto) {
    await this.auth.requestCode(body.email);
  }

  @Public()
  @Post('verify-code')
  @HttpCode(HttpStatus.OK)
  async verifyCode(
    @Body() body: VerifyCodeDto,
    // passthrough: 쿠키만 직접 붙이고, 돌려준 값은 Nest가 평소처럼 JSON으로 보낸다.
    @Res({ passthrough: true }) response: Response,
  ) {
    const { user, token } = await this.auth.verifyCode(
      body.email,
      body.code,
      body.name,
    );
    // 본문에 넣으면 페이지의 JS가 읽을 수 있어서 httpOnly가 소용없어진다. 그래서 쿠키로만 보낸다.
    response.cookie(SESSION_COOKIE, token, {
      ...sessionCookieOptions(),
      maxAge: SESSION_MAX_AGE_MS,
    });
    return user;
  }

  @Get('me')
  me(@Req() request: AuthenticatedRequest) {
    return request.user;
  }

  // 세션이 이미 끝났어도 쿠키를 지울 수 있게 로그인 검사 없이 연다.
  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const token = readSessionToken(request);
    if (token !== undefined) await this.auth.deleteSession(token);
    response.clearCookie(SESSION_COOKIE, sessionCookieOptions());
  }
}
