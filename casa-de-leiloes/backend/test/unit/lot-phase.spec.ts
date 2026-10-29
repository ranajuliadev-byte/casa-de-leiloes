import { lotPhase, minimumNextBid } from '../../src/common/lot-phase';

const t = (iso: string) => new Date(iso);
const lot = {
  startsAt: t('2026-10-27T12:00:00.000Z'),
  endsAt: t('2026-10-27T14:00:00.000Z'),
  cancelledAt: null as Date | null,
};

describe('lotPhase', () => {
  it('antes do início → SCHEDULED', () => {
    expect(lotPhase(lot, t('2026-10-27T11:59:59.999Z'))).toBe('SCHEDULED');
  });

  it('exatamente no início → LIVE (início inclusivo)', () => {
    expect(lotPhase(lot, t('2026-10-27T12:00:00.000Z'))).toBe('LIVE');
  });

  it('entre início e fim → LIVE', () => {
    expect(lotPhase(lot, t('2026-10-27T13:00:00.000Z'))).toBe('LIVE');
    expect(lotPhase(lot, t('2026-10-27T13:59:59.999Z'))).toBe('LIVE');
  });

  it('exatamente no fim → ENDED (fim exclusivo)', () => {
    expect(lotPhase(lot, t('2026-10-27T14:00:00.000Z'))).toBe('ENDED');
  });

  it('depois do fim → ENDED', () => {
    expect(lotPhase(lot, t('2026-10-28T00:00:00.000Z'))).toBe('ENDED');
  });

  it('cancelado tem precedência sobre qualquer horário', () => {
    const c = { ...lot, cancelledAt: t('2026-10-27T12:30:00.000Z') };
    expect(lotPhase(c, t('2026-10-27T11:00:00.000Z'))).toBe('CANCELLED');
    expect(lotPhase(c, t('2026-10-27T13:00:00.000Z'))).toBe('CANCELLED');
    expect(lotPhase(c, t('2026-10-28T00:00:00.000Z'))).toBe('CANCELLED');
  });

  it('usa o endsAt vigente (prorrogado pelo anti-sniping)', () => {
    const extended = { ...lot, endsAt: t('2026-10-27T14:01:30.000Z') };
    expect(lotPhase(extended, t('2026-10-27T14:01:00.000Z'))).toBe('LIVE');
  });
});

describe('minimumNextBid', () => {
  const base = { startingPriceCents: 10_000, minIncrementCents: 500 };

  it('sem lances → lance inicial', () => {
    expect(minimumNextBid({ ...base, bidCount: 0, currentPriceCents: null })).toBe(10_000);
  });

  it('com lances → lance atual + incremento mínimo', () => {
    expect(minimumNextBid({ ...base, bidCount: 3, currentPriceCents: 12_000 })).toBe(12_500);
  });

  it('estado inconsistente (contagem sem preço) cai no lance inicial', () => {
    expect(minimumNextBid({ ...base, bidCount: 2, currentPriceCents: null })).toBe(10_000);
  });
});
