import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';

// 읽기 요청은 데이터를 바꾸지 않아서 검사하지 않는다.
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// 다른 사이트의 페이지가 사용자 브라우저로 쓰기 요청을 보내는 것(CSRF)을 막는다.
// SameSite 쿠키는 포트나 서브도메인만 다른 주소를 같은 사이트로 봐서, 출처(Origin)를 통째로 비교한다.
// Origin은 브라우저가 붙이는 값이라 페이지의 코드가 바꿀 수 없다.
@Injectable()
export class OriginGuard implements CanActivate {
  private readonly allowedOrigins: Set<string>;

  constructor() {
    const appOrigins = process.env.APP_ORIGINS;
    // 값이 없으면 모든 쓰기 요청이 403이 된다. 켜질 때 바로 멈춰서 알린다.
    if (!appOrigins) throw new Error('APP_ORIGINS가 없어요');
    this.allowedOrigins = new Set(appOrigins.split(',').map((origin) => origin.trim()));
  }

  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request>();
    if (READ_METHODS.has(request.method)) return true;

    // 앞부분만 같은 주소(http://localhost:5173.evil.com)도 막으려고 글자 그대로 비교한다.
    const origin = request.headers.origin;
    if (!origin || !this.allowedOrigins.has(origin)) {
      throw new ForbiddenException();
    }
    return true;
  }
}
