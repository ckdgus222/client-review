import {
  Controller,
  Get,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator.js';
import { PrismaService } from '../prisma/prisma.service.js';

// DB가 멈춰도 health 요청은 이 시간 안에 503으로 끝난다.
const DB_TIMEOUT_MS = 5_000;

// 서버가 살아 있는지 보는 주소라 로그인 없이 연다.
@Public()
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async check() {
    let timer: NodeJS.Timeout | undefined;
    // connectionTimeoutMillis는 새 연결에만 걸린다. 이미 열린 연결에서 조회가 멈추면 이 타이머가 끊는다.
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('DB 응답 시간 초과')),
        DB_TIMEOUT_MS,
      );
    });
    try {
      await Promise.race([this.prisma.$queryRaw`SELECT 1`, timeout]);
    } catch (error) {
      this.logger.error('DB 확인 실패', error);
      throw new ServiceUnavailableException();
    } finally {
      clearTimeout(timer);
    }
    return { status: 'ok' };
  }
}
