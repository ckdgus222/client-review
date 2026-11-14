import { type ArgumentsHost, Catch, HttpException, HttpStatus } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { Request } from 'express';
import { AlertService } from './alert.service.js';

// 모든 예외를 받아 응답은 Nest 기본 필터에 그대로 맡기고, 500대 응답이면 개발자에게 알린다.
@Catch()
export class ErrorAlertFilter extends BaseExceptionFilter {
  constructor(private readonly alert: AlertService) {
    super();
  }

  catch(exception: unknown, host: ArgumentsHost) {
    super.catch(exception, host);

    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    if (status < HttpStatus.INTERNAL_SERVER_ERROR) return;

    const request = host.switchToHttp().getRequest<Request>();
    this.alert.notifyServerError({
      method: request.method,
      // 실제 주소가 아니라 맞춘 경로의 틀(/api/invitations/:token)이다. 실제 주소에는 초대 토큰이 들어 있다.
      route: request.route?.path ?? '(경로 모름)',
      status,
      errorName: exception instanceof Error ? exception.constructor.name : typeof exception,
    });
  }
}
