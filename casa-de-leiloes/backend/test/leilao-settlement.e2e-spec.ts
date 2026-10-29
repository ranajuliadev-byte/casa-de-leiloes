import request from 'supertest';
import { bidderAlias, receiptPayload, verifyText } from '../src/common/crypto/audit-crypto';
import { bearer, createLot, createTestApp, createUser, HOUR, MIN, resetDb, TestCtx, TestUser, wallet } from './helpers';

describe('Liquidação, comprovante e minha área', () => {
  let ctx: TestCtx;
  let auctioneer: TestUser;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(async () => {
    await ctx.app.close();
  });
  beforeEach(async () => {
    ctx.clock.reset();
    await resetDb(ctx.prisma);
    auctioneer = await createUser(ctx, 'AUCTIONEER', 0, 'Galeria Aurora');
  });

  const http = () => request(ctx.url);
  const bid = (u: TestUser, lotId: string, amountCents: number) =>
    http().post(`/api/lots/${lotId}/bids`).set(bearer(u)).send({ amountCents });

  describe('settleDue()', () => {
    it('debita vencedor (total e comprometido), credita leiloeiro e emite comprovante assinado', async () => {
      const lot = await createLot(ctx, { auctioneerId: auctioneer.id, endsInMs: 30 * MIN, startingPriceCents: 10_000 });
      const a = await createUser(ctx, 'BIDDER', 100_000);
      const b = await createUser(ctx, 'BIDDER', 100_000);
      await bid(a, lot.id, 10_000).expect(201);
      await bid(b, lot.id, 25_000).expect(201);

      // antes do fim: nada a liquidar
      expect((await ctx.settlement.settleDue()).settled).toEqual([]);

      ctx.clock.advance(31 * MIN);
      const run = await ctx.settlement.settleDue();
      expect(run.settled).toEqual([lot.id]);

      expect(await wallet(ctx.prisma, b.id)).toMatchObject({ balanceCents: 75_000, committedCents: 0 });
      expect(await wallet(ctx.prisma, a.id)).toMatchObject({ balanceCents: 100_000, committedCents: 0 });
      expect(await wallet(ctx.prisma, auctioneer.id)).toMatchObject({ balanceCents: 25_000, committedCents: 0 });

      const debit = await ctx.prisma.ledgerEntry.findMany({ where: { walletId: b.walletId, type: 'SETTLEMENT_DEBIT' } });
      const credit = await ctx.prisma.ledgerEntry.findMany({ where: { walletId: auctioneer.walletId, type: 'SETTLEMENT_CREDIT' } });
      expect(debit).toHaveLength(1);
      expect(debit[0]).toMatchObject({ amountCents: 25_000, lotId: lot.id });
      expect(credit).toHaveLength(1);
      expect(credit[0]).toMatchObject({ amountCents: 25_000, lotId: lot.id });

      const settled = await ctx.prisma.lot.findUniqueOrThrow({ where: { id: lot.id } });
      expect(settled.settledAt).not.toBeNull();
      expect(settled).toMatchObject({ winnerId: b.id, finalPriceCents: 25_000, leaderId: b.id });

      const receipt = await ctx.prisma.receipt.findUniqueOrThrow({ where: { lotId: lot.id } });
      expect(receipt).toMatchObject({
        winnerId: b.id,
        winnerAlias: bidderAlias(lot.id, b.id),
        amountCents: 25_000,
        bidCount: 2,
        chainHead: settled.headHash,
      });
      expect(receipt.code).toMatch(/^[A-Za-z0-9_-]{12}$/);
      expect(verifyText(receiptPayload(receipt), receipt.signature)).toBe(true);
    });

    it('é idempotente: rodar de novo (ou em paralelo) não liquida duas vezes', async () => {
      const lot = await createLot(ctx, { auctioneerId: auctioneer.id, endsInMs: 10 * MIN });
      const a = await createUser(ctx, 'BIDDER', 100_000);
      await bid(a, lot.id, 40_000).expect(201);
      ctx.clock.advance(11 * MIN);

      // chamada direta em paralelo (driblando a flag de reentrância) → SKIP LOCKED + recheck
      const results = await Promise.all([
        ctx.settlement.settleLot(lot.id),
        ctx.settlement.settleLot(lot.id),
        ctx.settlement.settleLot(lot.id),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      await ctx.settlement.settleDue();
      await ctx.settlement.settleDue();

      expect(await wallet(ctx.prisma, a.id)).toMatchObject({ balanceCents: 60_000, committedCents: 0 });
      expect(await wallet(ctx.prisma, auctioneer.id)).toMatchObject({ balanceCents: 40_000 });
      expect(await ctx.prisma.receipt.count()).toBe(1);
      expect(await ctx.prisma.ledgerEntry.count({ where: { type: 'SETTLEMENT_DEBIT' } })).toBe(1);
      expect(await ctx.prisma.ledgerEntry.count({ where: { type: 'SETTLEMENT_CREDIT' } })).toBe(1);
    });

    it('flag de reentrância: settleDue concorrente retorna vazio sem processar', async () => {
      const lot = await createLot(ctx, { auctioneerId: auctioneer.id, endsInMs: MIN });
      ctx.clock.advance(2 * MIN);
      const [r1, r2] = await Promise.all([ctx.settlement.settleDue(), ctx.settlement.settleDue()]);
      expect([...r1.settled, ...r2.settled]).toEqual([lot.id]);
    });

    it('lote sem lances fecha sem vencedor (sem comprovante, sem movimentação)', async () => {
      const lot = await createLot(ctx, { auctioneerId: auctioneer.id, endsInMs: 5 * MIN });
      ctx.clock.advance(6 * MIN);
      expect((await ctx.settlement.settleDue()).settled).toEqual([lot.id]);
      const l = await ctx.prisma.lot.findUniqueOrThrow({ where: { id: lot.id } });
      expect(l.settledAt).not.toBeNull();
      expect(l.winnerId).toBeNull();
      expect(l.finalPriceCents).toBeNull();
      expect(await ctx.prisma.receipt.count()).toBe(0);
      expect(await ctx.prisma.ledgerEntry.count({ where: { type: { in: ['SETTLEMENT_DEBIT', 'SETTLEMENT_CREDIT'] } } })).toBe(0);
    });

    it('não liquida lote cancelado, agendado ou ainda ao vivo', async () => {
      const cancelled = await createLot(ctx, { auctioneerId: auctioneer.id, endsInMs: MIN });
      await ctx.prisma.lot.update({ where: { id: cancelled.id }, data: { cancelledAt: ctx.clock.now() } });
      await createLot(ctx, { auctioneerId: auctioneer.id, startsInMs: HOUR, endsInMs: 2 * HOUR });
      await createLot(ctx, { auctioneerId: auctioneer.id, endsInMs: HOUR });
      ctx.clock.advance(2 * MIN);
      expect((await ctx.settlement.settleDue()).settled).toEqual([]);
      expect(await ctx.prisma.lot.count({ where: { settledAt: { not: null } } })).toBe(0);
    });

    it('lote prorrogado pelo anti-sniping só é liquidado no novo fim', async () => {
      const lot = await createLot(ctx, { auctioneerId: auctioneer.id, endsInMs: 5 * MIN });
      const a = await createUser(ctx, 'BIDDER', 100_000);
      ctx.clock.advance(4 * MIN + 30_000); // faltam 30 s
      await bid(a, lot.id, 10_000).expect(201); // fim → agora + 2 min
      ctx.clock.advance(MIN); // passou do fim ORIGINAL, mas não do prorrogado
      expect((await ctx.settlement.settleDue()).settled).toEqual([]);
      ctx.clock.advance(MIN + 1_000);
      expect((await ctx.settlement.settleDue()).settled).toEqual([lot.id]);
    });

    it('liquida o lance que chegou enquanto a liquidação esperava: SKIP LOCKED pula o lote ocupado', async () => {
      const lot = await createLot(ctx, { auctioneerId: auctioneer.id, endsInMs: MIN });
      ctx.clock.advance(2 * MIN);
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let locked!: () => void;
      const lockedP = new Promise<void>((r) => (locked = r));
      const holder = ctx.prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "Lot" WHERE id = ${lot.id} FOR UPDATE`;
          locked();
          await gate;
        },
        { timeout: 15_000 },
      );
      await lockedP;
      const busy = await ctx.settlement.settleDue();
      expect(busy).toEqual({ settled: [], skipped: 1, failed: [] }); // não bloqueou
      release();
      await holder;
      expect((await ctx.settlement.settleDue()).settled).toEqual([lot.id]);
    });

    it('após liquidar, lances são recusados com LOT_ENDED', async () => {
      const lot = await createLot(ctx, { auctioneerId: auctioneer.id, endsInMs: MIN });
      const a = await createUser(ctx, 'BIDDER', 100_000);
      await bid(a, lot.id, 10_000).expect(201);
      ctx.clock.advance(2 * MIN);
      await ctx.settlement.settleDue();
      const b = await createUser(ctx, 'BIDDER', 100_000);
      expect((await bid(b, lot.id, 20_000).expect(409)).body.code).toBe('LOT_ENDED');
    });
  });

  describe('GET /api/receipts/:code (público)', () => {
    it('devolve ReceiptView válido, com URLs do front e sem dados pessoais', async () => {
      const lot = await createLot(ctx, { auctioneerId: auctioneer.id, endsInMs: MIN, title: 'Os Girassóis' });
      const a = await createUser(ctx, 'BIDDER', 100_000, 'Maria Secreta');
      await bid(a, lot.id, 12_345).expect(201);
      ctx.clock.advance(2 * MIN);
      await ctx.settlement.settleDue();
      const { code } = await ctx.prisma.receipt.findUniqueOrThrow({ where: { lotId: lot.id } });

      const res = await http().get(`/api/receipts/${code}`).expect(200);
      expect(res.body).toMatchObject({
        code,
        url: `http://localhost:3000/comprovante/${code}`,
        lot: { id: lot.id, title: 'Os Girassóis', auctioneerName: 'Galeria Aurora', attributes: { source: 'aic' } },
        winnerAlias: bidderAlias(lot.id, a.id),
        amountCents: 12_345,
        bidCount: 1,
        valid: true,
        auditUrl: `http://localhost:3000/auditoria/${lot.id}`,
      });
      const raw = JSON.stringify(res.body);
      expect(raw).not.toContain(a.id);
      expect(raw).not.toContain(a.email);
      expect(raw).not.toContain('Maria Secreta');
    });

    it('comprovante adulterado (valor) → valid=false', async () => {
      const lot = await createLot(ctx, { auctioneerId: auctioneer.id, endsInMs: MIN });
      const a = await createUser(ctx, 'BIDDER', 100_000);
      await bid(a, lot.id, 10_000).expect(201);
      ctx.clock.advance(2 * MIN);
      await ctx.settlement.settleDue();
      const r = await ctx.prisma.receipt.findUniqueOrThrow({ where: { lotId: lot.id } });
      await ctx.prisma.$executeRaw`UPDATE "Receipt" SET "amountCents" = 1 WHERE id = ${r.id}`;
      const res = await http().get(`/api/receipts/${r.code}`).expect(200);
      expect(res.body.valid).toBe(false);
    });

    it('cadeia do lote adulterada → comprovante valid=false', async () => {
      const lot = await createLot(ctx, { auctioneerId: auctioneer.id, endsInMs: MIN });
      const a = await createUser(ctx, 'BIDDER', 100_000);
      await bid(a, lot.id, 10_000).expect(201);
      ctx.clock.advance(2 * MIN);
      await ctx.settlement.settleDue();
      await ctx.prisma.$executeRaw`UPDATE "Bid" SET "amountCents" = 9000 WHERE "lotId" = ${lot.id}`;
      const r = await ctx.prisma.receipt.findUniqueOrThrow({ where: { lotId: lot.id } });
      expect((await http().get(`/api/receipts/${r.code}`).expect(200)).body.valid).toBe(false);
    });

    it('código inexistente → 404 RECEIPT_NOT_FOUND', async () => {
      const res = await http().get('/api/receipts/naoexiste123').expect(404);
      expect(res.body.code).toBe('RECEIPT_NOT_FOUND');
    });
  });

  describe('GET /api/me/bids', () => {
    it('agrupa por lote com status WINNING / OUTBID / AWAITING_SETTLEMENT / WON / LOST / CANCELLED', async () => {
      const a = await createUser(ctx, 'BIDDER', 1_000_000);
      const b = await createUser(ctx, 'BIDDER', 1_000_000);
      const winning = await createLot(ctx, { auctioneerId: auctioneer.id, endsInMs: 5 * HOUR, title: 'winning' });
      const outbid = await createLot(ctx, { auctioneerId: auctioneer.id, endsInMs: 5 * HOUR, title: 'outbid' });
      const awaiting = await createLot(ctx, { auctioneerId: auctioneer.id, endsInMs: 30 * MIN, title: 'awaiting' });
      const won = await createLot(ctx, { auctioneerId: auctioneer.id, endsInMs: 10 * MIN, title: 'won' });
      const lost = await createLot(ctx, { auctioneerId: auctioneer.id, endsInMs: 10 * MIN, title: 'lost' });
      const cancelled = await createLot(ctx, { auctioneerId: auctioneer.id, endsInMs: 5 * HOUR, title: 'cancelled' });
      await createLot(ctx, { auctioneerId: auctioneer.id, title: 'sem lance meu' });

      await bid(a, winning.id, 10_000).expect(201);
      await bid(a, outbid.id, 10_000).expect(201);
      await bid(b, outbid.id, 11_000).expect(201);
      await bid(a, awaiting.id, 10_000).expect(201);
      await bid(b, won.id, 10_000).expect(201);
      await bid(a, won.id, 11_000).expect(201);
      await bid(b, won.id, 12_000).expect(201);
      await bid(a, won.id, 15_000).expect(201);
      await bid(a, lost.id, 10_000).expect(201);
      await bid(b, lost.id, 11_000).expect(201);
      await bid(a, cancelled.id, 10_000).expect(201);
      await ctx.prisma.lot.update({ where: { id: cancelled.id }, data: { cancelledAt: ctx.clock.now() } });

      ctx.clock.advance(11 * MIN);
      await ctx.settlement.settleDue(); // liquida won e lost
      ctx.clock.advance(20 * MIN); // awaiting encerrou mas não foi liquidado

      const res = await http().get('/api/me/bids').set(bearer(a)).expect(200);
      const byTitle = Object.fromEntries(res.body.items.map((i: any) => [i.lot.title, i]));
      expect(Object.keys(byTitle).sort()).toEqual(['awaiting', 'cancelled', 'lost', 'outbid', 'winning', 'won']);
      expect(byTitle.winning.status).toBe('WINNING');
      expect(byTitle.outbid.status).toBe('OUTBID');
      expect(byTitle.awaiting.status).toBe('AWAITING_SETTLEMENT');
      expect(byTitle.won.status).toBe('WON');
      expect(byTitle.lost.status).toBe('LOST');
      expect(byTitle.cancelled.status).toBe('CANCELLED');

      expect(byTitle.won).toMatchObject({ myHighestBidCents: 15_000, myBidCount: 2, alias: bidderAlias(won.id, a.id) });
      expect(byTitle.won.receipt).toMatchObject({ amountCents: 15_000 });
      expect(byTitle.won.receipt.url).toBe(`http://localhost:3000/comprovante/${byTitle.won.receipt.code}`);
      expect(byTitle.lost.receipt).toBeNull();
      expect(byTitle.winning.receipt).toBeNull();
      expect(byTitle.won.lot).toMatchObject({ id: won.id, settled: true, auctioneerName: 'Galeria Aurora', phase: 'ENDED' });
      // ordem: o que exige atenção primeiro
      expect(res.body.items[0].status).toBe('WINNING');
    });

    it('lista vazia para quem nunca deu lance; leiloeiro → 403', async () => {
      const a = await createUser(ctx, 'BIDDER', 0);
      expect((await http().get('/api/me/bids').set(bearer(a)).expect(200)).body).toEqual({ items: [] });
      await http().get('/api/me/bids').set(bearer(auctioneer)).expect(403);
      await http().get('/api/me/bids').expect(401);
    });
  });
});
