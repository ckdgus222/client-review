import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';

// 앱 전체에 PrismaService를 하나만 둔다. 기능 모듈마다 등록하면 DB 연결 묶음이 여러 개 생긴다.
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
