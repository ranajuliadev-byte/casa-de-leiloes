import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard, Roles, RolesGuard } from '../common/auth/auth.guards';
import { ARTWORK_SEARCH_RATE_LIMIT } from '../common/rate-limits';
import { SearchArtworksDto } from './artworks.dto';
import { ArtworksService } from './artworks.service';

@Controller('artworks')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('AUCTIONEER')
export class ArtworksController {
  constructor(private readonly artworks: ArtworksService) {}

  @Get('search')
  @Throttle({ default: ARTWORK_SEARCH_RATE_LIMIT })
  search(@Query() query: SearchArtworksDto) {
    return this.artworks.search(query.q, query.page);
  }
}
