import { Module } from '@nestjs/common';
import { CleanupService } from './cleanup.service.js';

// 매일 도는 정리 작업(cleanup.service.ts).
@Module({
  providers: [CleanupService],
  exports: [CleanupService],
})
export class CleanupModule {}
