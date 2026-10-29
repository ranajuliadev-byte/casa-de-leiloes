import { Bid, Lot } from '@prisma/client';
import { bidderAlias } from './crypto/audit-crypto';
import { lotPhase, minimumNextBid } from './lot-phase';
import type { LotLiveState, PublicBid, WalletView } from '../realtime/realtime.gateway';

/** Estado "ao vivo" de um lote, no formato publicado via WebSocket e REST. */
export function toLotLiveState(lot: Lot, now: Date): LotLiveState {
  return {
    lotId: lot.id,
    phase: lotPhase(lot, now),
    currentPriceCents: lot.currentPriceCents,
    bidCount: lot.bidCount,
    leaderAlias: lot.leaderId ? bidderAlias(lot.id, lot.leaderId) : null,
    minNextBidCents: minimumNextBid(lot),
    startsAt: lot.startsAt.toISOString(),
    endsAt: lot.endsAt.toISOString(),
    extended: lot.endsAt.getTime() > lot.originalEndsAt.getTime(),
    settled: !!lot.settledAt,
    winnerAlias: lot.winnerId ? bidderAlias(lot.id, lot.winnerId) : null,
    finalPriceCents: lot.finalPriceCents,
    serverTime: now.toISOString(),
  };
}

/** Lance no formato público (só pseudônimo, nunca o id do licitante). */
export function toPublicBid(
  b: Pick<Bid, 'id' | 'lotId' | 'sequence' | 'amountCents' | 'bidderAlias' | 'createdAt' | 'hash'>,
): PublicBid {
  return {
    id: b.id,
    lotId: b.lotId,
    sequence: b.sequence,
    amountCents: b.amountCents,
    bidderAlias: b.bidderAlias,
    createdAt: b.createdAt.toISOString(),
    hash: b.hash,
  };
}

export interface LotAttributes {
  artist: string | null;
  date: string | null;
  medium: string | null;
  dimensions: string | null;
  origin: string | null;
  source: 'aic';
  externalId: number | null;
}

export type LotSummary = LotLiveState & {
  id: string;
  title: string;
  imageUrl: string | null;
  attributes: LotAttributes;
  startingPriceCents: number;
  minIncrementCents: number;
  originalEndsAt: string;
  auctioneerName: string;
};

/** Card da vitrine (ver docs/CONTRATO.md → LotSummary). Exige `auctioneer: { name }` incluído na consulta. */
export function toLotSummary(lot: Lot & { auctioneer: { name: string } }, now: Date): LotSummary {
  return {
    ...toLotLiveState(lot, now),
    id: lot.id,
    title: lot.title,
    imageUrl: lot.imageUrl,
    attributes: lot.attributes as unknown as LotAttributes,
    startingPriceCents: lot.startingPriceCents,
    minIncrementCents: lot.minIncrementCents,
    originalEndsAt: lot.originalEndsAt.toISOString(),
    auctioneerName: lot.auctioneer.name,
  };
}

/**
 * Saldos são BigInt no banco; a API continua devolvendo `number` (exato até 2^53 − 1,
 * limite garantido por common/ledger.ts).
 */
export function toWalletView(w: { balanceCents: bigint | number; committedCents: bigint | number }): WalletView {
  const balance = Number(w.balanceCents);
  const committed = Number(w.committedCents);
  return { balanceCents: balance, committedCents: committed, availableCents: balance - committed };
}
