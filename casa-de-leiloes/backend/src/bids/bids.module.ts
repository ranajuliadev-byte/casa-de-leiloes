import { Module } from '@nestjs/common';
import { BidsController } from './bids.controller';
import { BidsService } from './bids.service';

/** Motor de lances: lock transacional, saldo comprometido, anti-sniping e cadeia de hashes. */
@Module({
  controllers: [BidsController],
  providers: [BidsService],
  exports: [BidsService],
})
export class BidsModule {}
