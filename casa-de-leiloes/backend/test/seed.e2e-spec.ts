import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { receiptPayload, verifyText } from '../src/common/crypto/audit-crypto';
import { lotPhase } from '../src/common/lot-phase';
import { loadLotAuditData, verifyChain } from '../src/audit/audit.service';
import { runSeed, SEED_DEPOSIT_CENTS } from '../prisma/seed';

/**
 * O seed precisa produzir dados que a própria auditoria considere ÍNTEGROS,
 * carteiras coerentes com o extrato e o cenário de demonstração descrito no README.
 */
describe('Seed de demonstração', () => {
  let prisma: PrismaClient;
  const now = new Date();
  let result: Awaited<ReturnType<typeof runSeed>>;

  beforeAll(async () => {
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL as string }) });
    result = await runSeed(prisma, { offline: true, now });
  });
  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "Receipt", "Bid", "LedgerEntry", "Lot", "Wallet", "Artwork", "User" RESTART IDENTITY CASCADE',
    );
    await prisma.$disconnect();
  });

  it('cria leiloeiro e dois licitantes com R$ 50.000', async () => {
    const users = await prisma.user.findMany({ include: { wallet: true }, orderBy: { email: 'asc' } });
    expect(users.map((u) => [u.email, u.role])).toEqual([
      ['ana@leilao.dev', 'BIDDER'],
      ['bruno@leilao.dev', 'BIDDER'],
      ['leiloeiro@leilao.dev', 'AUCTIONEER'],
    ]);
    const deposits = await prisma.ledgerEntry.findMany({ where: { type: 'DEPOSIT' } });
    expect(deposits).toHaveLength(2);
    expect(deposits.every((d) => d.amountCents === SEED_DEPOSIT_CENTS)).toBe(true);
  });

  it('usa o snapshot embutido quando offline e grava as obras no cache', async () => {
    expect(result.artworkSource).toBe('snapshot');
    expect(await prisma.artwork.count()).toBeGreaterThanOrEqual(8);
  });

  it('monta o cenário: 3 ao vivo, 2 agendados, 2 encerrados, 1 cancelado', async () => {
    const lots = await prisma.lot.findMany();
    const phases = lots.map((l) => lotPhase(l, now));
    const count = (p: string) => phases.filter((x) => x === p).length;
    expect(count('LIVE')).toBe(3);
    expect(count('SCHEDULED')).toBe(2);
    expect(count('ENDED')).toBe(2);
    expect(count('CANCELLED')).toBe(1);

    const byKey = async (k: string) => prisma.lot.findUniqueOrThrow({ where: { id: result.lots[k] } });
    const soon = await byKey('liveEndingSoon');
    expect(soon.bidCount).toBe(0);
    expect(soon.endsAt.getTime() - now.getTime()).toBe(10 * 60_000);
    expect((await byKey('liveAna')).bidCount).toBeGreaterThan(0);
    expect((await byKey('liveBruno')).bidCount).toBeGreaterThan(0);
    const unsold = await byKey('unsold');
    expect(unsold.settledAt).not.toBeNull();
    expect(unsold.winnerId).toBeNull();
    const cancelled = await byKey('cancelled');
    expect(cancelled.leaderId).toBeNull();
    expect(cancelled.bidCount).toBeGreaterThan(0);
  });

  it('a auditoria de TODOS os lotes dá INTACT', async () => {
    const lots = await prisma.lot.findMany();
    expect(lots).toHaveLength(8);
    for (const l of lots) {
      const { lot, bids, ledger } = (await loadLotAuditData(prisma, l.id))!;
      const { verification } = verifyChain(lot, bids, now, ledger);
      expect({ title: lot.title, status: verification.status, issues: verification.issues }).toEqual({
        title: lot.title,
        status: 'INTACT',
        issues: [],
      });
    }
  });

  it('comprovante do lote liquidado tem assinatura válida e bate com a cadeia', async () => {
    const receipt = await prisma.receipt.findUniqueOrThrow({ where: { code: result.receiptCode }, include: { lot: true } });
    expect(verifyText(receiptPayload(receipt), receipt.signature)).toBe(true);
    expect(receipt.chainHead).toBe(receipt.lot.headHash);
    expect(receipt.bidCount).toBe(receipt.lot.bidCount);
    expect(receipt.amountCents).toBe(receipt.lot.finalPriceCents);
    const ana = await prisma.user.findUniqueOrThrow({ where: { email: 'ana@leilao.dev' } });
    expect(receipt.winnerId).toBe(ana.id);
  });

  it('carteiras coerentes: saldo = extrato e comprometido = soma dos lances liderados em lotes abertos', async () => {
    const wallets = await prisma.wallet.findMany({ include: { entries: true, user: true } });
    for (const w of wallets) {
      const sum = (t: string) => w.entries.filter((e) => e.type === t).reduce((s, e) => s + e.amountCents, 0);
      const balance = Number(w.balanceCents);
      const committed = Number(w.committedCents);
      expect(balance).toBe(sum('DEPOSIT') + sum('SETTLEMENT_CREDIT') - sum('SETTLEMENT_DEBIT'));
      expect(committed).toBe(sum('COMMIT') - sum('RELEASE') - sum('SETTLEMENT_DEBIT'));

      const leading = await prisma.lot.findMany({ where: { leaderId: w.userId, settledAt: null, cancelledAt: null } });
      expect(committed).toBe(leading.reduce((s, l) => s + (l.currentPriceCents ?? 0), 0));
      expect(committed).toBeLessThanOrEqual(balance);
      // extrato encadeado: seq 1..n e head da carteira gravado
      expect(w.entries.map((e) => e.seq).sort((a, b) => a - b)).toEqual(w.entries.map((_, i) => i + 1));
      expect(w.ledgerCount).toBe(w.entries.length);
    }
  });

  it('é idempotente: rodar de novo recria o mesmo cenário sem duplicar', async () => {
    const again = await runSeed(prisma, { offline: true, now });
    expect(await prisma.user.count()).toBe(3);
    expect(await prisma.lot.count()).toBe(8);
    expect(await prisma.receipt.count()).toBe(1);
    result = again;
  });
});
