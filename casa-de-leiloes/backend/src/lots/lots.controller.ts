import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import {
  AuthUser,
  CurrentUser,
  JwtAuthGuard,
  OptionalJwtAuthGuard,
  Roles,
  RolesGuard,
} from '../common/auth/auth.guards';
import { CancelLotDto, CreateLotDto, ListBidsDto, ListLotsDto } from './lots.dto';
import { LotsService } from './lots.service';

@Controller('lots')
export class LotsController {
  constructor(private readonly lots: LotsService) {}

  @Get()
  list(@Query() query: ListLotsDto) {
    return this.lots.list(query);
  }

  @Get(':id')
  @UseGuards(OptionalJwtAuthGuard)
  detail(@Param('id') id: string, @CurrentUser() user?: AuthUser) {
    return this.lots.findDetail(id, user);
  }

  @Get(':id/bids')
  bids(@Param('id') id: string, @Query() query: ListBidsDto) {
    return this.lots.listBids(id, query);
  }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('AUCTIONEER')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateLotDto) {
    return this.lots.create(user, dto);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('AUCTIONEER')
  cancel(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: CancelLotDto) {
    return this.lots.cancel(user, id, dto.reason);
  }
}

@Controller('auctioneer/lots')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('AUCTIONEER')
export class AuctioneerLotsController {
  constructor(private readonly lots: LotsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.lots.listForAuctioneer(user);
  }
}
