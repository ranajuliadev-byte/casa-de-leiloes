import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { AuthUser, CurrentUser, JwtAuthGuard, Roles, RolesGuard } from '../common/auth/auth.guards';
import { DepositDto } from './wallet.dto';
import { WalletService } from './wallet.service';

@Controller('wallet')
@UseGuards(JwtAuthGuard, RolesGuard)
export class WalletController {
  constructor(private readonly wallets: WalletService) {}

  @Get()
  get(@CurrentUser() user: AuthUser) {
    return this.wallets.getView(user.id);
  }

  @Post('deposit')
  @HttpCode(200)
  @Roles('BIDDER')
  deposit(@CurrentUser() user: AuthUser, @Body() dto: DepositDto) {
    return this.wallets.deposit(user.id, dto.amountCents);
  }
}
