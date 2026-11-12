-- CreateEnum
CREATE TYPE "issue_category" AS ENUM ('BUG', 'DESIGN', 'COPY', 'OTHER');

-- CreateEnum
CREATE TYPE "issue_scope" AS ENUM ('IN_SCOPE', 'OUT_OF_SCOPE');

-- AlterTable
ALTER TABLE "issues" ADD COLUMN     "category" "issue_category" NOT NULL DEFAULT 'BUG',
ADD COLUMN     "scope" "issue_scope" NOT NULL DEFAULT 'IN_SCOPE',
ADD COLUMN     "due_date" DATE;
