import { Body, Controller, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { Allow } from 'class-validator';
import { AuthUser, CurrentUser, JwtAuthGuard } from '../common/auth/auth.guards';
import { BidsService, PlaceBidResult } from './bids.service';

export class PlaceBidDto {
  // Validação feita no serviço (depois da checagem de papel), para devolver
  // INVALID_AMOUNT / AUCTIONEER_CANNOT_BID na ordem do contrato.
  @Allow()
  amountCents: unknown;
}

@Controller('lots')
export class BidsController {
  constructor(private readonly bids: BidsService) {}

  /**
   * POST /api/lots/:id/bids — só exige login; o papel é checado no serviço para
   * responder AUCTIONEER_CANNOT_BID (e não um FORBIDDEN_ROLE genérico).
   */
  @Post(':id/bids')
  @HttpCode(201)
  @UseGuards(JwtAuthGuard)
  place(@CurrentUser() user: AuthUser, @Param('id') lotId: string, @Body() body: PlaceBidDto): Promise<PlaceBidResult> {
    return this.bids.placeBid(user, lotId, body?.amountCents);
  }
}
