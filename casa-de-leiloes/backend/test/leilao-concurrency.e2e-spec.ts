import request from 'supertest';
import { AuditService } from '../src/audit/audit.service';
import { bearer, createLot, createTestApp, createUser, MIN, resetDb, TestCtx, TestUser, wallet } from './helpers';

/**
 * Concorrência real contra o Postgres: as requisições são disparadas em paralelo
 * (Promise.all) e competem pelo pool de conexões e pelos locks de linha.
 */
describe('Concorrência do motor de lances', () => {
  let ctx: TestCtx;
  let audit: AuditService;
  let auctioneer: TestUser;

  beforeAll(async () => {
    ctx = await createTestApp();
    audit = ctx.app.get(AuditService);
  });
  afterAll(async () => {
    await ctx.app.close();
  });
  beforeEach(async () => {
    ctx.clock.reset();
    await resetDb(ctx.prisma);
    auctioneer = await createUser(ctx, 'AUCTIONEER');
  });

  const bid = (u: TestUser, lotId: string, amountCents: number) =>
    request(ctx.url).post(`/api/lots/${lotId}/bids`).set(bearer(u)).send({ amountCents });

  /** Invariantes que valem sempre: comprometido de todos = preço atual do líder, cadeia íntegra. */
  async function expectConsistent(lotId: string, users: TestUser[]) {
    const lot = await ctx.prisma.lot.findUniqueOrThrow({ where: { id: lotId } });
    const bids = await ctx.prisma.bid.findMany({ where: { lotId }, orderBy: { sequence: 'asc' } });
    expect(lot.bidCount).toBe(bids.length);
    expect(bids.map((b) => b.sequence)).toEqual(bids.map((_, i) => i + 1));
    for (let i = 1; i < bids.length; i++) {
      expect(bids[i].amountCents).toBeGreaterThanOrEqual(bids[i - 1].amountCents + lot.minIncrementCents);
    }
    const wallets = await Promise.all(users.map((u) => wallet(ctx.prisma, u.id)));
    const committedTotal = wallets.reduce((s, w) => s + w.committedCents, 0);
    expect(committedTotal).toBe(lot.currentPriceCents ?? 0);
    for (const [i, w] of wallets.entries()) {
      expect(w.committedCents).toBe(users[i].id === lot.leaderId ? lot.currentPriceCents : 0);
      expect(w.committedCents).toBeLessThanOrEqual(w.balanceCents);
    }
    // Extrato bate com o comprometido: Σ COMMIT − Σ RELEASE = committed
    for (const [i, u] of users.entries()) {
      const agg = await ctx.prisma.ledgerEntry.groupBy({
        by: ['type'],
        where: { walletId: u.walletId, type: { in: ['COMMIT', 'RELEASE'] } },
        _sum: { amountCents: true },
      });
      const sum = (t: string) => agg.find((a) => a.type === t)?._sum.amountCents ?? 0;
      expect(sum('COMMIT') - sum('RELEASE')).toBe(wallets[i].committedCents);
    }
    expect((await audit.verifyLot(lotId))?.status).toBe('INTACT');
  }

  it('20 lances simultâneos de licitantes diferentes no MESMO valor → exatamente 1 aceito', async () => {
    const lot = await createLot(ctx, { auctioneerId: auctioneer.id, startingPriceCents: 10_000, minIncrementCents: 1_000 });
    const users = await Promise.all(Array.from({ length: 20 }, () => createUser(ctx, 'BIDDER', 50_000)));

    const results = await Promise.all(users.map((u) => bid(u, lot.id, 10_000)));

    const ok = results.filter((r) => r.status === 201);
    const rejected = results.filter((r) => r.status !== 201);
    expect(ok).toHaveLength(1);
    expect(rejected).toHaveLength(19);
    // Os perdedores enxergaram o lance do vencedor (lock + releitura) → mínimo já subiu
    for (const r of rejected) {
      expect(r.status).toBe(422);
      expect(r.body).toMatchObject({ code: 'BELOW_MINIMUM', details: { minimumCents: 11_000 } });
    }

    const winnerIdx = results.findIndex((r) => r.status === 201);
    const lotDb = await ctx.prisma.lot.findUniqueOrThrow({ where: { id: lot.id } });
    expect(lotDb).toMatchObject({ bidCount: 1, currentPriceCents: 10_000, leaderId: users[winnerIdx].id });
    expect(await ctx.prisma.bid.count({ where: { lotId: lot.id } })).toBe(1);

    for (const [i, u] of users.entries()) {
      const w = await wallet(ctx.prisma, u.id);
      expect(w.balanceCents).toBe(50_000);
      expect(w.committedCents).toBe(i === winnerIdx ? 10_000 : 0);
    }
    expect(await ctx.prisma.ledgerEntry.count({ where: { type: 'COMMIT' } })).toBe(1);
    await expectConsistent(lot.id, users);
  });

  it('20 lances simultâneos com valores diferentes → cadeia contígua, crescente e saldos coerentes', async () => {
    const lot = await createLot(ctx, { auctioneerId: auctioneer.id, startingPriceCents: 10_000, minIncrementCents: 1_000 });
    const users = await Promise.all(Array.from({ length: 20 }, () => createUser(ctx, 'BIDDER', 1_000_000)));

    const results = await Promise.all(users.map((u, i) => bid(u, lot.id, 10_000 + i * 1_000)));

    const accepted = results.filter((r) => r.status === 201);
    expect(accepted.length).toBeGreaterThanOrEqual(1);
    for (const r of results.filter((x) => x.status !== 201)) {
      expect(r.status).toBe(422);
      expect(r.body.code).toBe('BELOW_MINIMUM');
    }
    // nenhum erro interno; o maior valor (29.000) sempre vence, pois nada pode superá-lo
    expect(results.some((r) => r.status >= 500)).toBe(false);
    const lotDb = await ctx.prisma.lot.findUniqueOrThrow({ where: { id: lot.id } });
    expect(lotDb.currentPriceCents).toBe(29_000);
    expect(lotDb.leaderId).toBe(users[19].id);
    expect(lotDb.bidCount).toBe(accepted.length);
    await expectConsistent(lot.id, users);
  });

  it('rajada de lances crescentes entre 2 licitantes (sem conflito de lock) mantém invariantes', async () => {
    const lot = await createLot(ctx, { auctioneerId: auctioneer.id, startingPriceCents: 10_000, minIncrementCents: 100 });
    const a = await createUser(ctx, 'BIDDER', 1_000_000);
    const b = await createUser(ctx, 'BIDDER', 1_000_000);
    // cada um tenta 15 valores em paralelo; vários vão falhar (ALREADY_WINNING/BELOW_MINIMUM)
    const reqs: Promise<request.Response>[] = [];
    for (let i = 0; i < 15; i++) {
      reqs.push(bid(a, lot.id, 10_000 + i * 200));
      reqs.push(bid(b, lot.id, 10_100 + i * 200));
    }
    const results = await Promise.all(reqs);
    expect(results.some((r) => r.status >= 500)).toBe(false);
    for (const r of results.filter((x) => x.status !== 201)) {
      expect(['BELOW_MINIMUM', 'ALREADY_WINNING']).toContain(r.body.code);
    }
    // nunca dois lances seguidos do mesmo licitante
    const bids = await ctx.prisma.bid.findMany({ where: { lotId: lot.id }, orderBy: { sequence: 'asc' } });
    for (let i = 1; i < bids.length; i++) expect(bids[i].bidderId).not.toBe(bids[i - 1].bidderId);
    await expectConsistent(lot.id, [a, b]);
  });

  it('mesmo licitante, 5 lotes ao mesmo tempo, saldo para só um → sem gasto duplo', async () => {
    const lots = await Promise.all(
      Array.from({ length: 5 }, () => createLot(ctx, { auctioneerId: auctioneer.id, startingPriceCents: 30_000 })),
    );
    const a = await createUser(ctx, 'BIDDER', 50_000); // dá para 1 lance de 30k, não 2

    const results = await Promise.all(lots.map((l) => bid(a, l.id, 30_000)));

    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    for (const r of results.filter((x) => x.status !== 201)) {
      expect(r.body).toMatchObject({ code: 'INSUFFICIENT_BALANCE', details: { availableCents: 20_000, requiredCents: 30_000 } });
    }
    expect(await wallet(ctx.prisma, a.id)).toMatchObject({ balanceCents: 50_000, committedCents: 30_000 });
  });

  it('duplo clique: o mesmo licitante envia o mesmo lance 10x em paralelo → 1 aceito, demais ALREADY_WINNING', async () => {
    const lot = await createLot(ctx, { auctioneerId: auctioneer.id, startingPriceCents: 10_000 });
    const a = await createUser(ctx, 'BIDDER', 100_000);
    const results = await Promise.all(Array.from({ length: 10 }, () => bid(a, lot.id, 10_000)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.body.code === 'ALREADY_WINNING')).toHaveLength(9);
    expect(await wallet(ctx.prisma, a.id)).toMatchObject({ committedCents: 10_000 });
  });

  it('lances cruzados em lotes diferentes (A supera B no lote 1, B supera A no lote 2) não geram deadlock', async () => {
    // Cada lance trava as carteiras de A e B. Sem ordem fixa por id, o par de
    // transações abaixo poderia travar em ordem inversa (deadlock 40P01).
    const a = await createUser(ctx, 'BIDDER', 10_000_000);
    const b = await createUser(ctx, 'BIDDER', 10_000_000);
    const pairs = await Promise.all(
      Array.from({ length: 8 }, async () => {
        const l1 = await createLot(ctx, { auctioneerId: auctioneer.id, startingPriceCents: 1_000, minIncrementCents: 100 });
        const l2 = await createLot(ctx, { auctioneerId: auctioneer.id, startingPriceCents: 1_000, minIncrementCents: 100 });
        await bid(b, l1.id, 1_000).expect(201);
        await bid(a, l2.id, 1_000).expect(201);
        return [l1, l2] as const;
      }),
    );

    const results = await Promise.all(
      pairs.flatMap(([l1, l2]) => [bid(a, l1.id, 1_100), bid(b, l2.id, 1_100)]),
    );
    expect(results.map((r) => r.status)).toEqual(results.map(() => 201));
    // cada um lidera 8 lotes de 1.100
    expect(await wallet(ctx.prisma, a.id)).toMatchObject({ committedCents: 8 * 1_100 });
    expect(await wallet(ctx.prisma, b.id)).toMatchObject({ committedCents: 8 * 1_100 });
  });

  it('lance que chega depois do fim enquanto outro segura o lock é recusado (fase avaliada após o lock)', async () => {
    const lot = await createLot(ctx, { auctioneerId: auctioneer.id, endsInMs: 5 * MIN });
    const a = await createUser(ctx, 'BIDDER', 100_000);

    // Segura o lock do lote numa transação externa, avança o relógio além do fim e
    // só então libera: o lance que estava esperando precisa ver LOT_ENDED.
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
    const pending = bid(a, lot.id, 10_000).then((r) => r);
    await new Promise((r) => setTimeout(r, 200)); // garante que o lance já está esperando o lock
    ctx.clock.advance(6 * MIN);
    release();
    await holder;
    const res = await pending;
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LOT_ENDED');
  });
});
