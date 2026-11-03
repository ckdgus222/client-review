import { type CanActivate, type ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AuthService, type AuthUser } from '../auth.service.js';
import { IS_PUBLIC } from '../decorators/public.decorator.js';

export const SESSION_COOKIE = 'sid';

// 세션 가드를 통과한 요청. 컨트롤러는 request.user로 로그인한 사람을 본다.
export type AuthenticatedRequest = Request & { user: AuthUser };

// cookie-parser는 "j:"로 시작하는 값을 객체로 바꿔서, 문자열일 때만 세션 ID로 본다.
export const readSessionToken = (request: Request) => {
  const token: unknown = request.cookies?.[SESSION_COOKIE];
  return typeof token === 'string' ? token : undefined;
};

// 모든 주소에 걸 가드다. 새 주소에 로그인 검사를 깜빡해도 막힌 쪽으로 남는다.
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = readSessionToken(request);
    if (token === undefined) throw new UnauthorizedException();

    const user = await this.auth.findSessionUser(token);
    if (!user) throw new UnauthorizedException();

    request.user = user;
    return true;
  }
}
