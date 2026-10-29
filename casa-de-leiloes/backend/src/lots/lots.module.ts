import { Module } from '@nestjs/common';
import { ArtworksModule } from '../artworks/artworks.module';
import { AuctioneerLotsController, LotsController } from './lots.controller';
import { LotsService } from './lots.service';

@Module({
  imports: [ArtworksModule],
  controllers: [LotsController, AuctioneerLotsController],
  providers: [LotsService],
  exports: [LotsService],
})
export class LotsModule {}
