-- Revogação de sessões: a redefinição de senha incrementa a versão e os JWTs antigos
-- (claim `ver`) deixam de valer.
-- AlterTable
ALTER TABLE "User" ADD COLUMN     "tokenVersion" INTEGER NOT NULL DEFAULT 0;
