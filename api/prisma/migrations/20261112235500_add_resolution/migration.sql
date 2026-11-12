-- CreateEnum
CREATE TYPE "resolution_result" AS ENUM ('VERIFIED', 'REOPENED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "issue_status" ADD VALUE 'READY_FOR_REVIEW';
ALTER TYPE "issue_status" ADD VALUE 'VERIFIED';
ALTER TYPE "issue_status" ADD VALUE 'WITHDRAWN';

-- AlterEnum
ALTER TYPE "activity_type" ADD VALUE 'RESOLUTION_SUBMITTED';
ALTER TYPE "activity_type" ADD VALUE 'ISSUE_VERIFIED';
ALTER TYPE "activity_type" ADD VALUE 'ISSUE_REOPENED';
ALTER TYPE "activity_type" ADD VALUE 'ISSUE_WITHDRAWN';

-- CreateTable
CREATE TABLE "resolution_attempts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "issue_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "version_screen_id" UUID,
    "summary" TEXT NOT NULL,
    "submitted_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    "result" "resolution_result",
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ,

    CONSTRAINT "resolution_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "resolution_attempts_issue_id_created_at_idx" ON "resolution_attempts"("issue_id", "created_at");

-- AddForeignKey
ALTER TABLE "resolution_attempts" ADD CONSTRAINT "resolution_attempts_issue_id_fkey" FOREIGN KEY ("issue_id") REFERENCES "issues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resolution_attempts" ADD CONSTRAINT "resolution_attempts_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "delivery_versions"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resolution_attempts" ADD CONSTRAINT "resolution_attempts_version_screen_id_version_id_fkey" FOREIGN KEY ("version_screen_id", "version_id") REFERENCES "version_screens"("id", "version_id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resolution_attempts" ADD CONSTRAINT "resolution_attempts_submitted_by_fkey" FOREIGN KEY ("submitted_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resolution_attempts" ADD CONSTRAINT "resolution_attempts_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- 결과·확인한 사람·확인 시각은 셋 다 있거나 셋 다 없다. 반쯤 적힌 결과를 DB가 막는다. CHECK는 Prisma 스키마로 적을 수 없어서 직접 넣는다.
ALTER TABLE "resolution_attempts" ADD CONSTRAINT "resolution_attempts_review_shape_check" CHECK (
    ("result" IS NULL AND "reviewed_by" IS NULL AND "reviewed_at" IS NULL)
    OR ("result" IS NOT NULL AND "reviewed_by" IS NOT NULL AND "reviewed_at" IS NOT NULL)
);

-- 쓰이는 버전·화면을 지우지 못하게 막는 외래키는 트랜잭션 끝에 검사한다(6번 마이그레이션의 쪽지와 같은 이유).
-- 프로젝트를 지우면 DB는 버전을 쪽지·고쳤어요 줄보다 먼저 지우는데, 바로 검사하면 곧 함께 지워질 줄 때문에 거절된다.
-- Prisma 스키마로는 적을 수 없어서 직접 넣는다.
ALTER TABLE "resolution_attempts" ALTER CONSTRAINT "resolution_attempts_version_id_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "resolution_attempts" ALTER CONSTRAINT "resolution_attempts_version_screen_id_version_id_fkey" DEFERRABLE INITIALLY DEFERRED;
