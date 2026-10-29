import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthUser, CurrentUser, JwtAuthGuard, Roles, RolesGuard } from '../common/auth/auth.guards';
import { MeService, MyLotView } from './me.service';

@Controller('me')
@UseGuards(JwtAuthGuard, RolesGuard)
export class MeController {
  constructor(private readonly me: MeService) {}

  /** GET /api/me/bids — "meus lances / arremates" do licitante. */
  @Get('bids')
  @Roles('BIDDER')
  bids(@CurrentUser() user: AuthUser): Promise<{ items: MyLotView[] }> {
    return this.me.myBids(user.id);
  }
}
