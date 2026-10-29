import { Module } from '@nestjs/common';
import { AicClient } from './aic.client';
import { ArtworksController } from './artworks.controller';
import { ArtworksService } from './artworks.service';
import { WikimediaImages } from './wikimedia.client';

@Module({
  controllers: [ArtworksController],
  providers: [AicClient, WikimediaImages, ArtworksService],
  exports: [ArtworksService],
})
export class ArtworksModule {}
