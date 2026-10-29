-- Saldos de carteira em BIGINT (o leiloeiro acumula créditos e estouraria o INT de 32 bits).
-- AlterTable
ALTER TABLE "Wallet" ADD COLUMN     "ledgerCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "ledgerHead" TEXT,
ADD COLUMN     "ledgerSignature" TEXT,
ALTER COLUMN "balanceCents" SET DATA TYPE BIGINT,
ALTER COLUMN "committedCents" SET DATA TYPE BIGINT;

-- Extrato encadeado por carteira (seq, prevHash, hash) + vínculo com o lance (bidHash).
-- Bancos que já tinham lançamentos recebem seq por ordem de criação e hash vazio:
-- esses dados antigos NÃO são verificáveis no novo formato (a auditoria os aponta);
-- para a demonstração, recrie os dados com `npm run db:seed`.
-- AlterTable
ALTER TABLE "LedgerEntry" ADD COLUMN     "bidHash" TEXT,
ADD COLUMN     "hash" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "prevHash" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "seq" INTEGER NOT NULL DEFAULT 0;

UPDATE "LedgerEntry" e SET "seq" = x.rn
FROM (SELECT id, row_number() OVER (PARTITION BY "walletId" ORDER BY "createdAt", id) AS rn FROM "LedgerEntry") x
WHERE e.id = x.id;

ALTER TABLE "LedgerEntry" ALTER COLUMN "hash" DROP DEFAULT,
ALTER COLUMN "prevHash" DROP DEFAULT,
ALTER COLUMN "seq" DROP DEFAULT;

-- Cancelamento assinado.
-- AlterTable
ALTER TABLE "Lot" ADD COLUMN     "cancelSignature" TEXT;

-- CreateIndex
CREATE INDEX "LedgerEntry_lotId_idx" ON "LedgerEntry"("lotId");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_walletId_seq_key" ON "LedgerEntry"("walletId", "seq");
