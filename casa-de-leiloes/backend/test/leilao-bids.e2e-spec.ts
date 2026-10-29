import request from 'supertest';
import { ANTI_SNIPING_WINDOW_MS } from '../src/common/clock';
import { bidderAlias } from '../src/common/crypto/audit-crypto';
import { bearer, createLot, createTestApp, createUser, HOUR, MIN, resetDb, TestCtx, TestUser, wallet } from './helpers';

describe('Lances — POST /api/lots/:id/bids', () => {
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
    auctioneer = await createUser(ctx, 'AUCTIONEER', 0, 'Galeria Teste');
  });

  const bid = (u: TestUser | null, lotId: string, amountCents: unknown) => {
    const r = request(ctx.url).post(`/api/lots/${lotId}/bids`);
    if (u) r.set(bearer(u));
    return r.send(amountCents === undefined ? {} : { amountCents });
  };

  describe('lance aceito', () => {
    it('1º lance igual ao lance inicial é aceito e devolve bid/state/wallet', async () => {
      const lot = await createLot(ctx, { auctioneerId: auctioneer.id, startingPriceCents: 10_000, minIncrementCents: 1_000 });
      const ana = await createUser(ctx, 'BIDDER', 50_000);

      const res = await bid(ana, lot.id, 10_000).expect(201);

      expect(res.body.bid).toMatchObject({
        lotId: lot.id,
        sequence: 1,
        amountCents: 10_000,
        bidderAlias: bidderAlias(lot.id, ana.id),
      });
      expect(res.body.bid.hash).toMatch(/^[0-9a-f]{64}$/);
      // nada de dados pessoais na resposta pública do lance
      expect(JSON.stringify(res.body.bid)).not.toContain(ana.id);
      expect(JSON.stringify(res.body)).not.toContain(ana.email);
      expect(res.body.state).toMatchObject({
        lotId: lot.id,
        phase: 'LIVE',
        currentPriceCents: 10_000,
        bidCount: 1,
        leaderAlias: bidderAlias(lot.id, ana.id),
        minNextBidCents: 11_000,
        extended: false,
        settled: false,
      });
      expect(res.body.wallet).toEqual({ balanceCents: 50_000, committedCents: 10_000, availableCents: 40_000 });

      const dbLot = await ctx.prisma.lot.findUniqueOrThrow({ where: { id: lot.id } });
      expect(dbLot).toMatchObject({ currentPriceCents: 10_000, bidCount: 1, leaderId: ana.id, headHash: res.body.bid.hash });

      const entries = await ctx.prisma.ledgerEntry.findMany({ where: { walletId: ana.walletId, type: 'COMMIT' } });
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ amountCents: 10_000, lotId: lot.id });
    });

    it('lance seguinte exatamente = atual + incremento é aceito', async () => {
      const lot = await createLot(ctx, { auctioneerId: auctioneer.id, startingPriceCents: 10_000, minIncrementCents: 1_000 });
      const a = await createUser(ctx, 'BIDDER', 100_000);
      const b = await createUser(ctx, 'BIDDER', 100_000);
      await bid(a, lot.id, 10_000).expect(201);
      const res = await bid(b, lot.id, 11_000).expect(201);
      expect(res.body.bid.sequence).toBe(2);
      expect(res.body.state.minNextBidCents).toBe(12_000);
    });

    it('licitante superado pode voltar a dar lance', async () => {
      const lot = await createLot(ctx, { auctioneerId: auctioneer.id });
      const a = await createUser(ctx, 'BIDDER', 100_000);
      const b = await createUser(ctx, 'BIDDER', 100_000);
      await bid(a, lot.id, 10_000).expect(201);
      await bid(b, lot.id, 11_000).expect(201);
      await bid(a, lot.id, 12_000).expect(201);
      expect(await wallet(ctx.prisma, a.id)).toMatchObject({ committedCents: 12_000 });
      expect(await wallet(ctx.prisma, b.id)).toMatchObject({ committedCents: 0 });
    });
  });

  describe('recusas do contrato', () => {
    it('1º lance abaixo do lance inicial → BELOW_MINIMUM { minimumCents }', async () => {
      const lot = await createLot(ctx, { auctioneerId: auctioneer.id, startingPriceCents: 10_000 });
      const a = await createUser(ctx, 'BIDDER', 100_000);
      const res = await bid(a, lot.id, 9_999).expect(422);
      expect(res.body).toMatchObject({ statusCode: 422, code: 'BELOW_MINIMUM', details: { minimumCents: 10_000 } });
      expect(typeof res.body.message).toBe('string');
    });

    it('lance abaixo de atual + incremento → BELOW_MINIMUM', async () => {
      const lot = await createLot(ctx, { auctioneerId: auctioneer.id, startingPriceCents: 10_000, minIncrementCents: 2_500 });
      const a = await createUser(ctx, 'BIDDER', 100_000);
      const b = await createUser(ctx, 'BIDDER', 100_000);
      await bid(a, lot.id, 10_000).expect(201);
      const res = await bid(b, lot.id, 12_499).expect(422);
      expect(res.body).toMatchObject({ code: 'BELOW_MINIMUM', details: { minimumCents: 12_500 } });
      // nada mudou
      expect(await wallet(ctx.prisma, b.id)).toMatchObject({ committedCents: 0 });
      expect(await ctx.prisma.bid.count()).toBe(1);
    });

    it('saldo disponível insuficiente → INSUFFICIENT_BALANCE { availableCents, requiredCents }', async () => {
      const lot = await createLot(ctx, { auctioneerId: auctioneer.id, startingPriceCents: 10_000 });
      const a = await createUser(ctx, 'BIDDER', 9_000);
      const res = await bid(a, lot.id, 10_000).expect(422);
      expect(res.body).toMatchObject({ code: 'INSUFFICIENT_BALANCE', details: { availableCents: 9_000, requiredCents: 10_000 } });
    });

    it('saldo comprometido em outro lote reduz o disponível', async () => {
      const lot1 = await createLot(ctx, { auctioneerId: auctioneer.id, startingPriceCents: 30_000 });
      const lot2 = await createLot(ctx, { auctioneerId: auctioneer.id, startingPriceCents: 30_000 });
      const a = await createUser(ctx, 'BIDDER', 50_000);
      await bid(a, lot1.id, 30_000).expect(201);
      const res = await bid(a, lot2.id, 30_000).expect(422);
      expect(res.body).toMatchObject({ code: 'INSUFFICIENT_BALANCE', details: { availableCents: 20_000, requiredCents: 30_000 } });
    });

    it('líder não cobre o próprio lance → ALREADY_WINNING', async () => {
      const lot = await createLot(ctx, { auctioneerId: auctioneer.id });
      const a = await createUser(ctx, 'BIDDER', 100_000);
      await bid(a, lot.id, 10_000).expect(201);
      const res = await bid(a, lot.id, 20_000).expect(409);
      expect(res.body.code).toBe('ALREADY_WINNING');
    });

    it('lote ainda não iniciado → LOT_NOT_STARTED', async () => {
      const lot = await createLot(ctx, { auctioneerId: auctioneer.id, startsInMs: 10 * MIN, endsInMs: HOUR });
      const a = await createUser(ctx, 'BIDDER', 100_000);
      const res = await bid(a, lot.id, 10_000).expect(409);
      expect(res.body.code).toBe('LOT_NOT_STARTED');
    });

    it('lote passa a aceitar lances quando o relógio chega ao início', async () => {
      const lot = await createLot(ctx, { auctioneerId: auctioneer.id, startsInMs: 10 * MIN, endsInMs: HOUR });
      const a = await createUser(ctx, 'BIDDER', 100_000);
      await bid(a, lot.id, 10_000).expect(409);
      ctx.clock.advance(10 * MIN);
      await bid(a, lot.id, 10_000).expect(201);
    });

    it('lote encerrado → LOT_ENDED (inclusive exatamente no instante do fim)', async () => {
      const lot = await createLot(ctx, { auctioneerId: auctioneer.id, endsInMs: 30 * MIN });
      const a = await createUser(ctx, 'BIDDER', 100_000);
      ctx.clock.advance(31 * MIN);
      const res = await bid(a, lot.id, 10_000).expect(409);
      expect(res.body.code).toBe('LOT_ENDED');

      // fim exato: endsAt <= agora já é encerrado
      const lot2 = await createLot(ctx, { auctioneerId: auctioneer.id, endsInMs: 0 });
      const res2 = await bid(a, lot2.id, 10_000).expect(409);
      expect(res2.body.code).toBe('LOT_ENDED');
    });

    it('lote cancelado → LOT_CANCELLED (antes da checagem de fase)', async () => {
      const lot = await createLot(ctx, { auctioneerId: auctioneer.id, startsInMs: 10 * MIN });
      await ctx.prisma.lot.update({ where: { id: lot.id }, data: { cancelledAt: ctx.clock.now() } });
      const a = await createUser(ctx, 'BIDDER', 100_000);
      const res = await bid(a, lot.id, 10_000).expect(409);
      expect(res.body.code).toBe('LOT_CANCELLED');
    });

    it('leiloeiro não dá lance → AUCTIONEER_CANNOT_BID (primeira checagem)', async () => {
      const lot = await createLot(ctx, { auctioneerId: auctioneer.id });
      const res = await bid(auctioneer, lot.id, 10_000).expect(403);
      expect(res.body.code).toBe('AUCTIONEER_CANNOT_BID');
      // papel vem antes de valor e de existência do lote
      expect((await bid(auctioneer, lot.id, -1).expect(403)).body.code).toBe('AUCTIONEER_CANNOT_BID');
      expect((await bid(auctioneer, 'nao-existe', 10_000).expect(403)).body.code).toBe('AUCTIONEER_CANNOT_BID');
    });

    it.each([
      ['zero', 0],
      ['negativo', -100],
      ['fracionário', 10_000.5],
      ['string', '10000'],
      ['ausente', undefined],
      ['null', null],
      ['maior que Int32', 2_147_483_648],
    ])('valor inválido (%s) → INVALID_AMOUNT', async (_label, amount) => {
      const lot = await createLot(ctx, { auctioneerId: auctioneer.id });
      const a = await createUser(ctx, 'BIDDER', 100_000);
      const res = await bid(a, lot.id, amount).expect(400);
      expect(res.body.code).toBe('INVALID_AMOUNT');
    });

    it('lote inexistente → 404 LOT_NOT_FOUND', async () => {
      const a = await createUser(ctx, 'BIDDER', 100_000);
      const res = await bid(a, '00000000-0000-0000-0000-000000000000', 10_000).expect(404);
      expect(res.body.code).toBe('LOT_NOT_FOUND');
    });

    it('sem token → 401 UNAUTHORIZED', async () => {
      const lot = await createLot(ctx, { auctioneerId: auctioneer.id });
      const res = await bid(null, lot.id, 10_000).expect(401);
      expect(res.body.code).toBe('UNAUTHORIZED');
    });

    it('ordem: líder com lance abaixo do mínimo recebe ALREADY_WINNING (não BELOW_MINIMUM)', async () => {
      const lot = await createLot(ctx, { auctioneerId: auctioneer.id });
      const a = await createUser(ctx, 'BIDDER', 100_000);
      await bid(a, lot.id, 10_000).expect(201);
      expect((await bid(a, lot.id, 1).expect(409)).body.code).toBe('ALREADY_WINNING');
    });

    it('ordem: mínimo é checado antes do saldo', async () => {
      const lot = await createLot(ctx, { auctioneerId: auctioneer.id, startingPriceCents: 10_000 });
      const pobre = await createUser(ctx, 'BIDDER', 0);
      expect((await bid(pobre, lot.id, 5_000).expect(422)).body.code).toBe('BELOW_MINIMUM');
      expect((await bid(pobre, lot.id, 10_000).expect(422)).body.code).toBe('INSUFFICIENT_BALANCE');
    });
  });

  describe('saldo comprometido', () => {
    it('ao ser superado, o valor volta ao disponível imediatamente (RELEASE no extrato)', async () => {
      const lot = await createLot(ctx, { auctioneerId: auctioneer.id, startingPriceCents: 10_000, minIncrementCents: 1_000 });
      const a = await createUser(ctx, 'BIDDER', 50_000);
      const b = await createUser(ctx, 'BIDDER', 50_000);

      await bid(a, lot.id, 10_000).expect(201);
      expect(await wallet(ctx.prisma, a.id)).toMatchObject({ balanceCents: 50_000, committedCents: 10_000 });

      const res = await bid(b, lot.id, 15_000).expect(201);
      expect(res.body.wallet).toEqual({ balanceCents: 50_000, committedCents: 15_000, availableCents: 35_000 });

      // A recupera o disponível na mesma transação do lance de B
      expect(await wallet(ctx.prisma, a.id)).toMatchObject({ balanceCents: 50_000, committedCents: 0 });
      const release = await ctx.prisma.ledgerEntry.findMany({ where: { walletId: a.walletId, type: 'RELEASE' } });
      expect(release).toHaveLength(1);
      expect(release[0]).toMatchObject({ amountCents: 10_000, lotId: lot.id, description: 'Lance superado' });

      // e pode usar o saldo liberado em outro lote
      const lot2 = await createLot(ctx, { auctioneerId: auctioneer.id, startingPriceCents: 50_000 });
      await bid(a, lot2.id, 50_000).expect(201);
    });

    it('comprometido acumula entre lotes e o total nunca muda durante o pregão', async () => {
      const l1 = await createLot(ctx, { auctioneerId: auctioneer.id, startingPriceCents: 10_000 });
      const l2 = await createLot(ctx, { auctioneerId: auctioneer.id, startingPriceCents: 20_000 });
      const a = await createUser(ctx, 'BIDDER', 100_000);
      await bid(a, l1.id, 10_000).expect(201);
      const res = await bid(a, l2.id, 20_000).expect(201);
      expect(res.body.wallet).toEqual({ balanceCents: 100_000, committedCents: 30_000, availableCents: 70_000 });
    });
  });

  describe('anti-sniping', () => {
    it('lance com 1 min restante → fim = agora + 2 min (e extended=true)', async () => {
      const lot = await createLot(ctx, { auctioneerId: auctioneer.id, endsInMs: 10 * MIN });
      const a = await createUser(ctx, 'BIDDER', 100_000);
      ctx.clock.advance(9 * MIN); // falta 1 min

      const res = await bid(a, lot.id, 10_000).expect(201);
      const createdAt = Date.parse(res.body.bid.createdAt);
      const endsAt = Date.parse(res.body.state.endsAt);
      expect(endsAt - createdAt).toBe(ANTI_SNIPING_WINDOW_MS);
      expect(endsAt).toBeGreaterThan(lot.endsAt.getTime());
      expect(res.body.state.extended).toBe(true);

      const dbLot = await ctx.prisma.lot.findUniqueOrThrow({ where: { id: lot.id } });
      expect(dbLot.endsAt.getTime()).toBe(endsAt);
      expect(dbLot.originalEndsAt.getTime()).toBe(lot.endsAt.getTime()); // original preservado
    });

    it('lance com 10 min restantes não prorroga', async () => {
      const lot = await createLot(ctx, { auctioneerId: auctioneer.id, endsInMs: 20 * MIN });
      const a = await createUser(ctx, 'BIDDER', 100_000);
      ctx.clock.advance(10 * MIN);
      const res = await bid(a, lot.id, 10_000).expect(201);
      expect(Date.parse(res.body.state.endsAt)).toBe(lot.endsAt.getTime());
      expect(res.body.state.extended).toBe(false);
    });

    it('lance com 3 min restantes não prorroga; prorrogações sucessivas sempre agora + 2 min', async () => {
      const lot = await createLot(ctx, { auctioneerId: auctioneer.id, endsInMs: 10 * MIN });
      const a = await createUser(ctx, 'BIDDER', 100_000);
      const b = await createUser(ctx, 'BIDDER', 100_000);

      ctx.clock.advance(7 * MIN); // faltam 3 min
      const r1 = await bid(a, lot.id, 10_000).expect(201);
      expect(Date.parse(r1.body.state.endsAt)).toBe(lot.endsAt.getTime());

      ctx.clock.advance(2 * MIN + 30_000); // faltam 30 s
      const r2 = await bid(b, lot.id, 11_000).expect(201);
      const end2 = Date.parse(r2.body.state.endsAt);
      expect(end2 - Date.parse(r2.body.bid.createdAt)).toBe(ANTI_SNIPING_WINDOW_MS);

      ctx.clock.advance(MIN + 50_000); // faltam ~10 s do fim prorrogado
      const r3 = await bid(a, lot.id, 12_000).expect(201);
      const end3 = Date.parse(r3.body.state.endsAt);
      expect(end3 - Date.parse(r3.body.bid.createdAt)).toBe(ANTI_SNIPING_WINDOW_MS);
      expect(end3).toBeGreaterThan(end2);

      // depois do fim prorrogado, não aceita mais
      ctx.clock.advance(ANTI_SNIPING_WINDOW_MS + 1_000);
      expect((await bid(b, lot.id, 13_000).expect(409)).body.code).toBe('LOT_ENDED');
    });

    it('limite da janela: 2 min − 1 ms restantes prorroga; 2 min + 1 ms não', async () => {
      const a = await createUser(ctx, 'BIDDER', 100_000);
      // Relógio congelado para o "agora" ser determinístico no milissegundo.
      const frozen = ctx.clock.now().getTime();
      const spy = jest.spyOn(ctx.clock, 'now').mockImplementation(() => new Date(frozen));
      try {
        const inside = await createLot(ctx, { auctioneerId: auctioneer.id, endsInMs: ANTI_SNIPING_WINDOW_MS - 1 });
        const r1 = await bid(a, inside.id, 10_000).expect(201);
        expect(Date.parse(r1.body.state.endsAt)).toBe(frozen + ANTI_SNIPING_WINDOW_MS);
        expect(r1.body.state.extended).toBe(true);

        const outside = await createLot(ctx, { auctioneerId: auctioneer.id, endsInMs: ANTI_SNIPING_WINDOW_MS + 1 });
        const r2 = await bid(a, outside.id, 10_000).expect(201);
        expect(Date.parse(r2.body.state.endsAt)).toBe(frozen + ANTI_SNIPING_WINDOW_MS + 1);
        expect(r2.body.state.extended).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('cadeia de hashes', () => {
    it('cada lance encadeia no anterior (prevHash) e atualiza o head assinado', async () => {
      const lot = await createLot(ctx, { auctioneerId: auctioneer.id });
      const a = await createUser(ctx, 'BIDDER', 100_000);
      const b = await createUser(ctx, 'BIDDER', 100_000);
      const r1 = await bid(a, lot.id, 10_000).expect(201);
      const r2 = await bid(b, lot.id, 11_000).expect(201);
      const bids = await ctx.prisma.bid.findMany({ where: { lotId: lot.id }, orderBy: { sequence: 'asc' } });
      expect(bids.map((x) => x.sequence)).toEqual([1, 2]);
      expect(bids[0].prevHash).toBe(lot.genesisHash);
      expect(bids[1].prevHash).toBe(r1.body.bid.hash);
      const dbLot = await ctx.prisma.lot.findUniqueOrThrow({ where: { id: lot.id } });
      expect(dbLot.headHash).toBe(r2.body.bid.hash);
    });
  });
});
