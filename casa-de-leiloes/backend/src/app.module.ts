import { ExecutionContext, Injectable, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { PrismaModule } from './prisma/prisma.service';
import { ClockModule } from './common/clock';
import { AuthCommonModule } from './common/auth/auth.guards';
import { RealtimeModule } from './realtime/realtime.gateway';
import { HealthModule } from './health/health.controller';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { WalletModule } from './wallet/wallet.module';
import { ArtworksModule } from './artworks/artworks.module';
import { LotsModule } from './lots/lots.module';
import { BidsModule } from './bids/bids.module';
import { SettlementModule } from './settlement/settlement.module';
import { AuditModule } from './audit/audit.module';
import { ReceiptsModule } from './receipts/receipts.module';
import { MeModule } from './me/me.module';
import { RATE_LIMIT } from './common/rate-limits';

/** ThrottlerGuard só para HTTP (no WebSocket não há `res` para os cabeçalhos). */
@Injectable()
export class HttpThrottlerGuard extends ThrottlerGuard {
  protected async shouldSkip(context: ExecutionContext): Promise<boolean> {
    return context.getType() !== 'http';
  }
}

@Module({
  imports: [
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([RATE_LIMIT]),
    PrismaModule,
    ClockModule,
    AuthCommonModule,
    RealtimeModule,
    HealthModule,
    // domínio
    AuthModule,
    UsersModule,
    WalletModule,
    ArtworksModule,
    LotsModule,
    BidsModule,
    SettlementModule,
    AuditModule,
    ReceiptsModule,
    MeModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: HttpThrottlerGuard }],
})
export class AppModule {}
