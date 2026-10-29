import request from 'supertest';
import { io, Socket } from 'socket.io-client';
import { bidderAlias } from '../src/common/crypto/audit-crypto';
import { bearer, createLot, createTestApp, createUser, MIN, resetDb, TestCtx, TestUser } from './helpers';

/** Coleta eventos de um socket. */
function collector(s: Socket) {
  const events: { name: string; data: any }[] = [];
  s.onAny((name, data) => events.push({ name, data }));
  return {
    events,
    of: (name: string) => events.filter((e) => e.name === name).map((e) => e.data),
    async waitFor(name: string, n = 1, ms = 3_000) {
      const t0 = Date.now();
      while (events.filter((e) => e.name === name).length < n) {
        if (Date.now() - t0 > ms) throw new Error(`timeout esperando ${name}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    },
  };
}

describe('Tempo real — eventos publicados após o commit', () => {
  let ctx: TestCtx;
  let auctioneer: TestUser;
  const sockets: Socket[] = [];

  const connect = async (u?: TestUser) => {
    const s = io(ctx.url, { transports: ['websocket'], auth: u ? { token: u.token } : {}, forceNew: true });
    sockets.push(s);
    await new Promise<void>((res, rej) => {
      s.once('connect', () => res());
      s.once('connect_error', rej);
    });
    return s;
  };
  const join = (s: Socket, lotId: string) => new Promise((r) => s.emit('lot:join', { lotId }, r));

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(async () => {
    sockets.forEach((s) => s.disconnect());
    await ctx.app.close();
  });
  beforeEach(async () => {
    ctx.clock.reset();
    await resetDb(ctx.prisma);
    auctioneer = await createUser(ctx, 'AUCTIONEER');
  });
  afterEach(() => {
    sockets.splice(0).forEach((s) => s.disconnect());
  });

  it('lance: lot:bid + lot:state na sala; user:wallet e user:outbid para o superado', async () => {
    const lot = await createLot(ctx, { auctioneerId: auctioneer.id, title: 'Lírios', endsInMs: 30 * MIN });
    const a = await createUser(ctx, 'BIDDER', 100_000);
    const b = await createUser(ctx, 'BIDDER', 100_000);

    const viewer = await connect(); // visitante anônimo
    await join(viewer, lot.id);
    const v = collector(viewer);
    const sa = collector(await connect(a));

    await request(ctx.url).post(`/api/lots/${lot.id}/bids`).set(bearer(a)).send({ amountCents: 10_000 }).expect(201);
    await request(ctx.url).post(`/api/lots/${lot.id}/bids`).set(bearer(b)).send({ amountCents: 12_000 }).expect(201);

    await v.waitFor('lot:bid', 2);
    await v.waitFor('lot:state', 2);
    expect(v.of('lot:bid').map((x) => x.sequence)).toEqual([1, 2]);
    expect(v.of('lot:bid')[1]).toMatchObject({ lotId: lot.id, amountCents: 12_000, bidderAlias: bidderAlias(lot.id, b.id) });
    expect(v.of('lot:state')[1]).toMatchObject({ currentPriceCents: 12_000, bidCount: 2, minNextBidCents: 13_000 });
    // visitante não recebe eventos privados
    expect(v.of('user:wallet')).toEqual([]);
    expect(JSON.stringify(v.events)).not.toContain(a.id);

    await sa.waitFor('user:outbid');
    expect(sa.of('user:outbid')[0]).toEqual({ lotId: lot.id, title: 'Lírios', newPriceCents: 12_000, yourAmountCents: 10_000 });
    await sa.waitFor('user:wallet', 2);
    expect(sa.of('user:wallet').at(-1)).toEqual({ balanceCents: 100_000, committedCents: 0, availableCents: 100_000 });
  });

  it('liquidação: user:won com código do comprovante e lot:state liquidado', async () => {
    const lot = await createLot(ctx, { auctioneerId: auctioneer.id, title: 'Marinha', endsInMs: MIN });
    const a = await createUser(ctx, 'BIDDER', 100_000);
    const sa = collector(await connect(a));
    const sAuc = collector(await connect(auctioneer));
    const viewer = await connect();
    await join(viewer, lot.id);
    const v = collector(viewer);

    await request(ctx.url).post(`/api/lots/${lot.id}/bids`).set(bearer(a)).send({ amountCents: 20_000 }).expect(201);
    ctx.clock.advance(2 * MIN);
    await ctx.settlement.settleDue();

    await sa.waitFor('user:won');
    const receipt = await ctx.prisma.receipt.findUniqueOrThrow({ where: { lotId: lot.id } });
    expect(sa.of('user:won')[0]).toEqual({ lotId: lot.id, title: 'Marinha', amountCents: 20_000, receiptCode: receipt.code });
    await sAuc.waitFor('user:wallet');
    expect(sAuc.of('user:wallet').at(-1)).toMatchObject({ balanceCents: 20_000 });
    await v.waitFor('lot:state', 2);
    expect(v.of('lot:state').at(-1)).toMatchObject({ settled: true, phase: 'ENDED', winnerAlias: bidderAlias(lot.id, a.id), finalPriceCents: 20_000 });
  });

  it('lance recusado não publica nada', async () => {
    const lot = await createLot(ctx, { auctioneerId: auctioneer.id, startingPriceCents: 10_000 });
    const a = await createUser(ctx, 'BIDDER', 100_000);
    const viewer = await connect();
    await join(viewer, lot.id);
    const v = collector(viewer);
    await request(ctx.url).post(`/api/lots/${lot.id}/bids`).set(bearer(a)).send({ amountCents: 5_000 }).expect(422);
    await new Promise((r) => setTimeout(r, 200));
    expect(v.events).toEqual([]);
  });
});
