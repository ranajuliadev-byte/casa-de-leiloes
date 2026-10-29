import { Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';
import { LedgerIntegrityService } from './ledger-integrity.service';

/** Auditoria pública da cadeia de lances (hashes encadeados + Ed25519). */
@Module({
  controllers: [AuditController],
  providers: [AuditService, LedgerIntegrityService],
  exports: [AuditService, LedgerIntegrityService],
})
export class AuditModule {}
