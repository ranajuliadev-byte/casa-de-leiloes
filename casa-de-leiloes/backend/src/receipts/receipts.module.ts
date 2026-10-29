import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { ReceiptsController } from './receipts.controller';
import { ReceiptsService } from './receipts.service';

/** Comprovante público de arremate (assinatura Ed25519 + verificação da cadeia). */
@Module({
  imports: [AuditModule],
  controllers: [ReceiptsController],
  providers: [ReceiptsService],
  exports: [ReceiptsService],
})
export class ReceiptsModule {}
