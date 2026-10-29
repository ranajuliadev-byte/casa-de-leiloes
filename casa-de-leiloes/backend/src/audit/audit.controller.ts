import { Controller, Get, Param } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AUDIT_RATE_LIMIT } from '../common/rate-limits';
import { AuditService } from './audit.service';

/** Auditoria pública — sem login. */
@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get('public-key')
  publicKey() {
    return this.audit.publicKey();
  }

  @Get('lots/:id')
  @Throttle({ default: AUDIT_RATE_LIMIT })
  lot(@Param('id') id: string) {
    return this.audit.lotReport(id);
  }
}
