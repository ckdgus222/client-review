-- AlterTable
ALTER TABLE "login_codes" ADD COLUMN     "privacy_agreed" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "privacy_agreed_at" TIMESTAMPTZ;
