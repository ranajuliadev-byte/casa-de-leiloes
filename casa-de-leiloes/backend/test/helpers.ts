import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { Role } from '@prisma/client';
import { randomUUID } from 'crypto';
import { configureApp } from '../src/main';
import { PrismaModule, PrismaService } from '../src/prisma/prisma.service';
import { Clock, ClockModule } from '../src/common/clock';
import { AuthCommonModule } from '../src/common/auth/auth.guards';
import { RealtimeModule } from '../src/realtime/realtime.gateway';
import { genesisHash, signHead } from '../src/common/crypto/audit-crypto';
import { appendLedger } from '../src/common/ledger';
import { BidsModule } from '../src/bids/bids.module';
import { SettlementModule } from '../src/settlement/settlement.module';
import { SettlementService } from '../src/settlement/settlement.service';
import { AuditModule } from '../src/audit/audit.module';
import { ReceiptsModule } from '../src/receipts/receipts.module';
import { MeModule } from '../src/me/me.module';
import { LotsModule } from '../src/lots/lots.module';

export const MIN = 60_000;
export const HOUR = 60 * MIN;

export interface TestCtx {
  app: INestApplication;
  /** URL base do servidor HTTP de teste (já escutando em porta efêmera). */
  url: string;
  moduleRef: TestingModule;
  prisma: PrismaService;
  clock: Clock;
  jwt: JwtService;
  settlement: SettlementService;
}

/**
 * App de teste com o MÍNIMO necessário para o motor do leilão (sem AppModule):
 * infraestrutura comum + Bids, Settlement, Audit, Receipts, Me, Lots (cancelamento real).
 * O ScheduleModule NÃO é importado — a liquidação é disparada com `settleDue()`.
 */
export async function createTestApp(): Promise<TestCtx> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      PrismaModule,
      ClockModule,
      AuthCommonModule,
      RealtimeModule,
      BidsModule,
      SettlementModule,
      AuditModule,
      ReceiptsModule,
      MeModule,
      LotsModule,
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: ['error'] });
  await configureApp(app);
  // Escuta UMA vez numa porta efêmera: o supertest reaproveita o servidor
  // (em vez de abrir um listener por requisição nas rajadas de concorrência).
  await app.listen(0, '127.0.0.1');
  const addr = app.getHttpServer().address();
  return {
    app,
    url: `http://127.0.0.1:${addr.port}`,
    moduleRef,
    prisma: app.get(PrismaService),
    clock: app.get(Clock),
    jwt: app.get(JwtService),
    settlement: app.get(SettlementService),
  };
}

/** Limpa todas as tabelas entre testes. */
export async function resetDb(prisma: PrismaService) {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "Receipt", "Bid", "LedgerEntry", "Lot", "Wallet", "Artwork", "User" RESTART IDENTITY CASCADE',
  );
}

export interface TestUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  walletId: string;
  token: string;
}

let userSeq = 0;

/** Cria usuário + carteira direto no banco e gera o JWT ({ sub, role, name, email }). */
export async function createUser(
  ctx: Pick<TestCtx, 'prisma' | 'jwt'>,
  role: Role,
  balanceCents = 0,
  name?: string,
): Promise<TestUser> {
  userSeq++;
  const n = name ?? `${role === 'AUCTIONEER' ? 'Leiloeiro' : 'Licitante'} ${userSeq}`;
  const email = `u${userSeq}-${randomUUID().slice(0, 8)}@teste.dev`;
  const user = await ctx.prisma.user.create({
    data: { name: n, email, passwordHash: 'x', roles: [role], wallet: { create: {} } },
    include: { wallet: true },
  });
  if (balanceCents > 0) {
    // Mesmo caminho do app: lançamento encadeado + head da carteira assinado.
    await ctx.prisma.$transaction((tx) =>
      appendLedger(tx, user.wallet!, [
        { type: 'DEPOSIT', amountCents: balanceCents, description: 'Depósito (teste)', createdAt: new Date(Date.now() - HOUR) },
      ]),
    );
  }
  const token = ctx.jwt.sign({ sub: user.id, role, name: n, email });
  return { id: user.id, name: n, email, role, walletId: user.wallet!.id, token };
}

export interface CreateLotOpts {
  auctioneerId: string;
  title?: string;
  startingPriceCents?: number;
  minIncrementCents?: number;
  /** relativo ao Clock (ms). Padrão: começou há 1 min. */
  startsInMs?: number;
  /** relativo ao Clock (ms). Padrão: termina em 1 h. */
  endsInMs?: number;
}

/** Cria lote direto via Prisma, com genesis + head assinado igual à criação real. */
export async function createLot(ctx: Pick<TestCtx, 'prisma' | 'clock'>, o: CreateLotOpts) {
  const now = ctx.clock.now().getTime();
  const id = randomUUID();
  const title = o.title ?? 'Noite Estrelada (cópia de teste)';
  const startingPriceCents = o.startingPriceCents ?? 10_000;
  const minIncrementCents = o.minIncrementCents ?? 1_000;
  const startsAt = new Date(now + (o.startsInMs ?? -MIN));
  const endsAt = new Date(now + (o.endsInMs ?? HOUR));
  const description = 'Lote de teste';
  const imageUrl = 'https://www.artic.edu/iiif/2/abc/full/843,/0/default.jpg';
  const attributes = { artist: 'Artista X', date: '1889', medium: 'Óleo', dimensions: '73 × 92 cm', origin: 'Holanda', source: 'aic', externalId: 1 };
  const genesis = genesisHash({
    lotId: id,
    auctioneerId: o.auctioneerId,
    title,
    description,
    imageUrl,
    attributes,
    startingPriceCents,
    minIncrementCents,
    startsAt,
    originalEndsAt: endsAt,
  });
  return ctx.prisma.lot.create({
    data: {
      id,
      auctioneerId: o.auctioneerId,
      title,
      description,
      imageUrl,
      attributes,
      startingPriceCents,
      minIncrementCents,
      startsAt,
      endsAt,
      originalEndsAt: endsAt,
      genesisHash: genesis,
      headHash: genesis,
      headSignature: signHead(id, 0, genesis),
    },
  });
}

/** Carteira com saldos convertidos para number (no banco são BigInt). */
export async function wallet(prisma: PrismaService, userId: string) {
  const w = await prisma.wallet.findUniqueOrThrow({ where: { userId } });
  return { ...w, balanceCents: Number(w.balanceCents), committedCents: Number(w.committedCents) };
}

export const bearer = (u: { token: string }) => ({ Authorization: `Bearer ${u.token}` });
