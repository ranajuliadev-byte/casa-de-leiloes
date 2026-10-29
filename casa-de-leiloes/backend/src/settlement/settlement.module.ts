import { Module } from '@nestjs/common';
import { SettlementService } from './settlement.service';

/** Liquidação automática (job de 2 s, idempotente) + emissão de comprovante assinado. */
@Module({
  providers: [SettlementService],
  exports: [SettlementService],
})
export class SettlementModule {}
