-- Uma pessoa pode ter os dois perfis (leiloeiro e comprador) com o mesmo e-mail:
-- "role" (um perfil) vira "roles" (lista). Copia o perfil atual ANTES de apagar a coluna.
-- AlterTable
ALTER TABLE "User" ADD COLUMN     "roles" "Role"[];
UPDATE "User" SET "roles" = ARRAY["role"];
ALTER TABLE "User" DROP COLUMN "role";

-- Recuperação de senha: só o hash do token, uso único, com validade.
-- CreateTable
CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PasswordResetToken_userId_idx" ON "PasswordResetToken"("userId");

-- AddForeignKey
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
