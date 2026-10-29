-- Índice do job de liquidação: settledAt IS NULL AND cancelledAt IS NULL AND endsAt <= agora.
-- CreateIndex
CREATE INDEX "Lot_settledAt_cancelledAt_endsAt_idx" ON "Lot"("settledAt", "cancelledAt", "endsAt");
