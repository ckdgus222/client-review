-- AlterEnum
ALTER TYPE "activity_type" ADD VALUE 'VERSION_APPROVED';

-- CreateTable
CREATE TABLE "approvals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "version_id" UUID NOT NULL,
    "approver_id" UUID NOT NULL,
    "approved_at" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    "summary" JSONB NOT NULL,

    CONSTRAINT "approvals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "approvals_version_id_key" ON "approvals"("version_id");

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "delivery_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_approver_id_fkey" FOREIGN KEY ("approver_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
