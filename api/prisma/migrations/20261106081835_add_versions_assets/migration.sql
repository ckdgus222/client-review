-- CreateEnum
CREATE TYPE "version_status" AS ENUM ('DRAFT', 'IN_REVIEW', 'APPROVED');

-- CreateEnum
CREATE TYPE "activity_type" AS ENUM ('VERSION_PUBLISHED');

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "current_version_id" UUID;

-- CreateTable
CREATE TABLE "delivery_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "number" INTEGER,
    "status" "version_status" NOT NULL DEFAULT 'DRAFT',
    "summary" TEXT NOT NULL DEFAULT '',
    "test_url" TEXT,
    "published_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "storage_key" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "version_screens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "version_id" UUID NOT NULL,
    "screen_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "version_screens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "type" "activity_type" NOT NULL,
    "version_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "delivery_versions_project_id_number_key" ON "delivery_versions"("project_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "assets_storage_key_key" ON "assets"("storage_key");

-- CreateIndex
CREATE UNIQUE INDEX "version_screens_version_id_screen_id_key" ON "version_screens"("version_id", "screen_id");

-- CreateIndex
CREATE UNIQUE INDEX "projects_current_version_id_key" ON "projects"("current_version_id");

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_current_version_id_fkey" FOREIGN KEY ("current_version_id") REFERENCES "delivery_versions"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_versions" ADD CONSTRAINT "delivery_versions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "version_screens" ADD CONSTRAINT "version_screens_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "delivery_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "version_screens" ADD CONSTRAINT "version_screens_screen_id_fkey" FOREIGN KEY ("screen_id") REFERENCES "screens"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "version_screens" ADD CONSTRAINT "version_screens_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "delivery_versions"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- 초안은 프로젝트마다 1개다. Prisma 스키마로는 조건이 붙은 유니크를 적을 수 없어서 직접 넣는다.
CREATE UNIQUE INDEX "delivery_versions_one_draft_key" ON "delivery_versions"("project_id") WHERE "status" = 'DRAFT';

-- 초안은 번호와 게시 시각이 둘 다 비어 있고, 게시한 버전은 둘 다 있다. 반쯤 게시된 줄을 DB가 막는다.
ALTER TABLE "delivery_versions" ADD CONSTRAINT "delivery_versions_published_shape_check" CHECK (
    ("status" = 'DRAFT' AND "number" IS NULL AND "published_at" IS NULL)
    OR ("status" <> 'DRAFT' AND "number" IS NOT NULL AND "published_at" IS NOT NULL)
);

-- 쓰이는 화면·사진을 지우지 못하게 막는 외래키는 트랜잭션 끝에 검사한다. 프로젝트를 지우면 DB는 외래키를 만든
-- 순서대로 연쇄 삭제한다. version_screens는 버전을 거쳐 지워지는 손자 줄이라, 화면이나 사진이 먼저 지워지는
-- 순서(지금 screens, pg_dump로 복원하면 assets)에서 바로 검사하면 거절된다. Prisma 스키마로는 적을 수 없어서 직접 넣는다.
ALTER TABLE "version_screens" ALTER CONSTRAINT "version_screens_screen_id_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "version_screens" ALTER CONSTRAINT "version_screens_asset_id_fkey" DEFERRABLE INITIALLY DEFERRED;
