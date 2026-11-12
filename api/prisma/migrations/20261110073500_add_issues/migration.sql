-- CreateEnum
CREATE TYPE "issue_status" AS ENUM ('OPEN', 'IN_PROGRESS');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "activity_type" ADD VALUE 'ISSUE_CREATED';
ALTER TYPE "activity_type" ADD VALUE 'ISSUE_STARTED';

-- AlterTable
ALTER TABLE "activity_events" ADD COLUMN     "issue_id" UUID;

-- CreateTable
CREATE TABLE "issues" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "origin_version_id" UUID NOT NULL,
    "origin_version_screen_id" UUID,
    "x_ratio" DOUBLE PRECISION,
    "y_ratio" DOUBLE PRECISION,
    "author_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "issue_status" NOT NULL DEFAULT 'OPEN',
    "request_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "issues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "issue_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "request_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "issue_attachments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "issue_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "issue_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "issues_project_id_number_key" ON "issues"("project_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "issues_author_id_request_id_key" ON "issues"("author_id", "request_id");

-- CreateIndex
CREATE INDEX "comments_issue_id_created_at_idx" ON "comments"("issue_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "comments_author_id_request_id_key" ON "comments"("author_id", "request_id");

-- CreateIndex
CREATE UNIQUE INDEX "issue_attachments_asset_id_key" ON "issue_attachments"("asset_id");

-- CreateIndex
CREATE INDEX "issue_attachments_issue_id_idx" ON "issue_attachments"("issue_id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_versions_id_project_id_key" ON "delivery_versions"("id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "version_screens_id_version_id_key" ON "version_screens"("id", "version_id");

-- AddForeignKey
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_issue_id_fkey" FOREIGN KEY ("issue_id") REFERENCES "issues"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issues" ADD CONSTRAINT "issues_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issues" ADD CONSTRAINT "issues_origin_version_id_project_id_fkey" FOREIGN KEY ("origin_version_id", "project_id") REFERENCES "delivery_versions"("id", "project_id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issues" ADD CONSTRAINT "issues_origin_version_screen_id_origin_version_id_fkey" FOREIGN KEY ("origin_version_screen_id", "origin_version_id") REFERENCES "version_screens"("id", "version_id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issues" ADD CONSTRAINT "issues_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_issue_id_fkey" FOREIGN KEY ("issue_id") REFERENCES "issues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "delivery_versions"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issue_attachments" ADD CONSTRAINT "issue_attachments_issue_id_fkey" FOREIGN KEY ("issue_id") REFERENCES "issues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issue_attachments" ADD CONSTRAINT "issue_attachments_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE NO ACTION ON UPDATE CASCADE;


-- 핀은 시작 화면·x·y가 셋 다 있거나 셋 다 없다. 반쯤 꽂힌 핀을 DB가 막는다. CHECK는 Prisma 스키마로 적을 수 없어서 직접 넣는다.
ALTER TABLE "issues" ADD CONSTRAINT "issues_pin_shape_check" CHECK (
    ("origin_version_screen_id" IS NULL AND "x_ratio" IS NULL AND "y_ratio" IS NULL)
    OR ("origin_version_screen_id" IS NOT NULL AND "x_ratio" IS NOT NULL AND "y_ratio" IS NOT NULL)
);

-- 핀 위치는 사진 가로·세로에 대한 비율이라 0 이상 1 이하다. 숫자가 아닌 값(NaN)도 이 비교에서 걸러진다.
ALTER TABLE "issues" ADD CONSTRAINT "issues_pin_ratio_check" CHECK (
    "x_ratio" BETWEEN 0 AND 1 AND "y_ratio" BETWEEN 0 AND 1
);

-- 쓰이는 버전·화면·사진·쪽지를 지우지 못하게 막는 외래키는 트랜잭션 끝에 검사한다(3번 마이그레이션과 같은 이유).
-- 프로젝트를 지우면 DB는 버전을 쪽지·댓글보다 먼저 지우는데, 바로 검사하면 곧 함께 지워질 쪽지·댓글 때문에 거절된다.
-- Prisma 스키마로는 적을 수 없어서 직접 넣는다.
ALTER TABLE "issues" ALTER CONSTRAINT "issues_origin_version_id_project_id_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "issues" ALTER CONSTRAINT "issues_origin_version_screen_id_origin_version_id_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "comments" ALTER CONSTRAINT "comments_version_id_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "issue_attachments" ALTER CONSTRAINT "issue_attachments_asset_id_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "activity_events" ALTER CONSTRAINT "activity_events_issue_id_fkey" DEFERRABLE INITIALLY DEFERRED;
