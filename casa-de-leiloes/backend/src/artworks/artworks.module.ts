import { Module } from '@nestjs/common';
import { AicClient } from './aic.client';
import { ArtworksController } from './artworks.controller';
import { ArtworksService } from './artworks.service';

@Module({
  controllers: [ArtworksController],
  providers: [AicClient, ArtworksService],
  exports: [ArtworksService],
})
export class ArtworksModule {}
