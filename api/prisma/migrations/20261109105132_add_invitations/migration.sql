-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "activity_type" ADD VALUE 'INVITATION_CREATED';
ALTER TYPE "activity_type" ADD VALUE 'INVITATION_ACCEPTED';
ALTER TYPE "activity_type" ADD VALUE 'MEMBER_REVOKED';
ALTER TYPE "activity_type" ADD VALUE 'APPROVER_CHANGED';

-- AlterTable
ALTER TABLE "activity_events" ADD COLUMN     "member_id" UUID;

-- AlterTable
ALTER TABLE "project_members" ADD COLUMN     "revoked_at" TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "approver_member_id" UUID;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "last_seen_at" TIMESTAMPTZ;

-- CreateTable
CREATE TABLE "invitations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "invited_by_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "accepted_at" TIMESTAMPTZ,
    "revoked_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "invitations_token_hash_key" ON "invitations"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "project_members_id_project_id_key" ON "project_members"("id", "project_id");

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_approver_member_id_id_fkey" FOREIGN KEY ("approver_member_id", "id") REFERENCES "project_members"("id", "project_id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "project_members"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- 아직 쓰지 않은 초대(수락 안 함, 무효 아님)는 (프로젝트, 이메일)마다 1개다. 같은 이메일로 다시 초대하면
-- 코드가 예전 초대를 먼저 무효로 하고, 동시에 두 번 만들면 이 인덱스가 두 번째를 거절한다.
-- Prisma 스키마로는 부분 유니크를 미리보기 기능으로만 적을 수 있어서 직접 넣는다.
CREATE UNIQUE INDEX "invitations_one_pending_key" ON "invitations"("project_id", "email")
    WHERE "accepted_at" IS NULL AND "revoked_at" IS NULL;

-- 한 초대가 수락되면서 무효일 수는 없다. CHECK는 Prisma 스키마로 적을 수 없어서 직접 넣는다.
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_accepted_or_revoked_check" CHECK (
    "accepted_at" IS NULL OR "revoked_at" IS NULL
);
