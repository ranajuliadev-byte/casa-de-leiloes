/**
 * Fase de um lote, derivada do tempo + flags. Fonte única de verdade
 * usada por vitrine, sala, painel e motor de lances.
 *
 *  CANCELLED  -> cancelledAt preenchido (não aparece na vitrine)
 *  SCHEDULED  -> agora < startsAt
 *  LIVE       -> startsAt <= agora < endsAt   (únicos que aceitam lance)
 *  ENDED      -> agora >= endsAt (settledAt indica se já foi liquidado)
 */
export type LotPhase = 'SCHEDULED' | 'LIVE' | 'ENDED' | 'CANCELLED';

export interface PhaseInput {
  startsAt: Date;
  endsAt: Date;
  cancelledAt: Date | null;
}

export function lotPhase(lot: PhaseInput, now: Date): LotPhase {
  if (lot.cancelledAt) return 'CANCELLED';
  if (now.getTime() < lot.startsAt.getTime()) return 'SCHEDULED';
  if (now.getTime() < lot.endsAt.getTime()) return 'LIVE';
  return 'ENDED';
}

/** Lance mínimo aceito no próximo lance. */
export function minimumNextBid(lot: {
  bidCount: number;
  startingPriceCents: number;
  minIncrementCents: number;
  currentPriceCents: number | null;
}): number {
  if (lot.bidCount === 0 || lot.currentPriceCents == null) return lot.startingPriceCents;
  return lot.currentPriceCents + lot.minIncrementCents;
}
