import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor() {
    const connectionString = process.env.DATABASE_URL;
    // 값이 없으면 pg가 기본 주소 localhost:5432로 붙는다. 이 맥의 5432는 다른 프로젝트 DB라서 바로 멈춘다.
    if (!connectionString) throw new Error('DATABASE_URL이 없어요');
    // pg는 새 연결을 끝없이 기다린다. DB가 응답하지 않으면 5초 뒤 실패하게 한다.
    super({
      adapter: new PrismaPg({
        connectionString,
        connectionTimeoutMillis: 5_000,
      }),
    });
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
