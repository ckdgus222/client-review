-- CreateEnum
CREATE TYPE "project_status" AS ENUM ('ACTIVE', 'ARCHIVED', 'DELETE_PENDING');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "activity_type" ADD VALUE 'PROJECT_ARCHIVED';
ALTER TYPE "activity_type" ADD VALUE 'PROJECT_UNARCHIVED';
ALTER TYPE "activity_type" ADD VALUE 'PROJECT_DELETE_REQUESTED';
ALTER TYPE "activity_type" ADD VALUE 'PROJECT_RESTORED';

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "delete_requested_at" TIMESTAMPTZ,
ADD COLUMN     "status" "project_status" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "status_before_delete" "project_status";


-- 삭제 대기일 때만 삭제한 시각과 되돌아갈 상태가 있다. 셋이 어긋난 줄이 생기지 않게 한다(docs/archive.md 정할 것 2).
ALTER TABLE "projects" ADD CONSTRAINT "projects_delete_requested_at_check" CHECK (("status" = 'DELETE_PENDING') = ("delete_requested_at" IS NOT NULL));
ALTER TABLE "projects" ADD CONSTRAINT "projects_status_before_delete_check" CHECK (("status" = 'DELETE_PENDING') = ("status_before_delete" IS NOT NULL));

-- 되살리면 돌아갈 상태라서 삭제 대기일 수 없다.
ALTER TABLE "projects" ADD CONSTRAINT "projects_status_before_delete_value_check" CHECK ("status_before_delete" <> 'DELETE_PENDING');

-- 정리 작업이 하루 한 번 "7일 지난 삭제 대기"를 고를 때 쓴다.
CREATE INDEX "projects_delete_requested_at_idx" ON "projects"("delete_requested_at") WHERE "status" = 'DELETE_PENDING';
