import { Controller, Get, Module } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { PrismaService } from '../prisma/prisma.service';
import { Clock } from '../common/clock';

// Health check (Docker/Render) a cada poucos segundos: fora do rate limit.
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService, private readonly clock: Clock) {}

  @Get()
  async health() {
    await this.prisma.$queryRaw`SELECT 1`;
    return { status: 'ok', serverTime: this.clock.now().toISOString() };
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
