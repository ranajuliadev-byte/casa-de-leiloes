import { Controller, Get, Param } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AUDIT_RATE_LIMIT } from '../common/rate-limits';
import { ReceiptsService, ReceiptView } from './receipts.service';

/** Comprovante público e compartilhável — sem login. */
@Controller('receipts')
export class ReceiptsController {
  constructor(private readonly receipts: ReceiptsService) {}

  @Get(':code')
  @Throttle({ default: AUDIT_RATE_LIMIT })
  get(@Param('code') code: string): Promise<ReceiptView> {
    return this.receipts.byCode(code);
  }
}
