import { createPublicKey, createHash, verify } from 'crypto';
import request from 'supertest';
import { bidderAlias, sealBid, signCancel } from '../src/common/crypto/audit-crypto';
import { bearer, createLot, createTestApp, createUser, HOUR, MIN, resetDb, TestCtx, TestUser } from './helpers';

const ALL_OK = {
  genesisOk: true,
  headOk: true,
  chainOk: true,
  signaturesOk: true,
  countOk: true,
  priceOk: true,
  timingOk: true,
  cancelOk: true,
  ledgerOk: true,
};

describe('Auditoria pública — GET /api/audit/*', () => {
  let ctx: TestCtx;
  let auctioneer: TestUser;
  let a: TestUser;
  let b: TestUser;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(async () => {
    await ctx.app.close();
  });
  beforeEach(async () => {
    ctx.clock.reset();
    await resetDb(ctx.prisma);
    auctioneer = await createUser(ctx, 'AUCTIONEER');
    a = await createUser(ctx, 'BIDDER', 1_000_000, 'Ana Pessoa');
    b = await createUser(ctx, 'BIDDER', 1_000_000, 'Bruno Pessoa');
  });

  const http = () => request(ctx.url);
  const bid = (u: TestUser, lotId: string, amountCents: number) =>
    http().post(`/api/lots/${lotId}/bids`).set(bearer(u)).send({ amountCents }).expect(201);
  const report = async (lotId: string) => (await http().get(`/api/audit/lots/${lotId}`).expect(200)).body;

  /** Lote com 3 lances: A 10.000, B 11.000, A 12.000. */
  async function lotWith3Bids() {
    const lot = await createLot(ctx, { auctioneerId: auctioneer.id, startingPriceCents: 10_000, minIncrementCents: 1_000 });
    await bid(a, lot.id, 10_000);
    ctx.clock.advance(1_000);
    await bid(b, lot.id, 11_000);
    ctx.clock.advance(1_000);
    await bid(a, lot.id, 12_000);
    return lot;
  }

  it('chave pública: Ed25519 em PEM e raw base64 (32 bytes)', async () => {
    const res = await http().get('/api/audit/public-key').expect(200);
    expect(res.body.algorithm).toBe('Ed25519');
    expect(res.body.publicKeyPem).toContain('BEGIN PUBLIC KEY');
    expect(Buffer.from(res.body.publicKeyRawBase64, 'base64')).toHaveLength(32);
  });

  it('lote íntegro → INTACT, com payload verificável de forma independente', async () => {
    const lot = await lotWith3Bids();
    const r = await report(lot.id);

    expect(r.verification.status).toBe('INTACT');
    expect(r.verification.issues).toEqual([]);
    expect(r.verification.summary).toEqual(ALL_OK);
    expect(r.lot).toMatchObject({ id: lot.id, bidCount: 3, cancelled: false, settled: false, phase: 'LIVE', genesisHash: lot.genesisHash });
    expect(r.bids.map((x: any) => x.sequence)).toEqual([1, 2, 3]);
    expect(r.bids.every((x: any) => Object.values(x.checks).every(Boolean))).toBe(true);

    // Verificação independente (como faria o navegador): só payload + chave pública.
    const pub = createPublicKey((await http().get('/api/audit/public-key')).body.publicKeyPem);
    expect(createHash('sha256').update(r.genesisPayload).digest('hex')).toBe(r.lot.genesisHash);
    let prev = r.lot.genesisHash;
    for (const x of r.bids) {
      expect(JSON.parse(x.payload)[6]).toBe(prev);
      expect(createHash('sha256').update(x.payload).digest('hex')).toBe(x.hash);
      expect(verify(null, Buffer.from(x.hash), pub, Buffer.from(x.signature, 'base64'))).toBe(true);
      prev = x.hash;
    }
    expect(r.lot.headHash).toBe(prev);

    // privacidade: só pseudônimos
    const raw = JSON.stringify(r);
    for (const u of [a, b]) {
      expect(raw).not.toContain(u.id);
      expect(raw).not.toContain(u.email);
      expect(raw).not.toContain(u.name);
    }
    expect(r.bids[0].bidderAlias).toBe(bidderAlias(lot.id, a.id));
  });

  it('lote sem lances → INTACT', async () => {
    const lot = await createLot(ctx, { auctioneerId: auctioneer.id });
    const r = await report(lot.id);
    expect(r.verification.status).toBe('INTACT');
    expect(r.bids).toEqual([]);
  });

  it('lote cancelado e lote liquidado continuam auditáveis (INTACT)', async () => {
    const lot = await lotWith3Bids();
    await http().post(`/api/lots/${lot.id}/cancel`).set(bearer(auctioneer)).send({ reason: 'teste' }).expect(200);
    const r = await report(lot.id);
    expect(r.lot.cancelled).toBe(true);
    expect(r.lot.phase).toBe('CANCELLED');
    expect(r.verification.issues).toEqual([]);
    expect(r.verification.status).toBe('INTACT');
    // cancelamento assinado e verificável só com a chave pública
    expect(r.lot.cancelledAt).toEqual(expect.any(String));
    const pub = createPublicKey((await http().get('/api/audit/public-key')).body.publicKeyPem);
    expect(JSON.parse(r.lot.cancelPayload)).toEqual(['CANCEL', lot.id, r.lot.cancelledAt, 3, r.lot.headHash]);
    expect(verify(null, Buffer.from(r.lot.cancelPayload), pub, Buffer.from(r.lot.cancelSignature, 'base64'))).toBe(true);

    const lot2 = await createLot(ctx, { auctioneerId: auctioneer.id, endsInMs: MIN });
    await bid(b, lot2.id, 10_000);
    ctx.clock.advance(2 * MIN);
    await ctx.settlement.settleDue();
    const r2 = await report(lot2.id);
    expect(r2.lot.settled).toBe(true);
    expect(r2.verification.status).toBe('INTACT');
  });

  it('UPDATE direto no valor de um lance → TAMPERED (hash não bate)', async () => {
    const lot = await lotWith3Bids();
    await ctx.prisma.$executeRaw`UPDATE "Bid" SET "amountCents" = 10500 WHERE "lotId" = ${lot.id} AND sequence = 2`;
    const r = await report(lot.id);
    expect(r.verification.status).toBe('TAMPERED');
    expect(r.verification.summary.chainOk).toBe(false);
    expect(r.verification.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'HASH_MISMATCH', sequence: 2 })]));
    expect(r.bids[1].checks.hashOk).toBe(false);
    expect(r.bids[0].checks.hashOk).toBe(true);
  });

  it('UPDATE no valor do ÚLTIMO lance (e no preço do lote) → TAMPERED', async () => {
    const lot = await lotWith3Bids();
    await ctx.prisma.$executeRaw`UPDATE "Bid" SET "amountCents" = 99999 WHERE "lotId" = ${lot.id} AND sequence = 3`;
    await ctx.prisma.$executeRaw`UPDATE "Lot" SET "currentPriceCents" = 99999 WHERE id = ${lot.id}`;
    const r = await report(lot.id);
    expect(r.verification.status).toBe('TAMPERED');
    expect(r.verification.issues.map((i: any) => i.code)).toContain('HASH_MISMATCH');
  });

  it('recalcular hash após adulterar (sem a chave privada) → TAMPERED (assinatura e encadeamento)', async () => {
    const lot = await lotWith3Bids();
    const bids = await ctx.prisma.bid.findMany({ where: { lotId: lot.id }, orderBy: { sequence: 'asc' } });
    const b2 = bids[1];
    // atacante altera o valor e recalcula o SHA-256 do elo, mas não consegue assinar
    const forgedHash = createHash('sha256')
      .update(JSON.stringify(['BID', lot.id, 2, b2.bidderAlias, 10_500, b2.createdAt.toISOString(), b2.prevHash]))
      .digest('hex');
    await ctx.prisma.$executeRaw`UPDATE "Bid" SET "amountCents" = 10500, hash = ${forgedHash} WHERE id = ${b2.id}`;
    const r = await report(lot.id);
    expect(r.verification.status).toBe('TAMPERED');
    expect(r.bids[1].checks).toMatchObject({ hashOk: true, signatureOk: false });
    expect(r.bids[2].checks.linkOk).toBe(false); // elo seguinte aponta para o hash antigo
    expect(r.verification.summary.signaturesOk).toBe(false);
  });

  it('DELETE do último lance → TAMPERED (head assinado não bate)', async () => {
    const lot = await lotWith3Bids();
    await ctx.prisma.$executeRaw`DELETE FROM "Bid" WHERE "lotId" = ${lot.id} AND sequence = 3`;
    const r = await report(lot.id);
    expect(r.verification.status).toBe('TAMPERED');
    expect(r.verification.summary.headOk).toBe(false);
    expect(r.verification.summary.countOk).toBe(false);
    expect(r.verification.issues.map((i: any) => i.code)).toEqual(expect.arrayContaining(['HEAD_MISMATCH', 'COUNT_MISMATCH']));
  });

  it('DELETE do último lance + "conserto" do lote (bidCount, preço, head) → TAMPERED (assinatura do head)', async () => {
    const lot = await lotWith3Bids();
    const bids = await ctx.prisma.bid.findMany({ where: { lotId: lot.id }, orderBy: { sequence: 'asc' } });
    await ctx.prisma.$executeRaw`DELETE FROM "Bid" WHERE id = ${bids[2].id}`;
    await ctx.prisma.$executeRaw`UPDATE "Lot" SET "bidCount" = 2, "currentPriceCents" = 11000, "leaderId" = ${b.id}, "headHash" = ${bids[1].hash} WHERE id = ${lot.id}`;
    const r = await report(lot.id);
    expect(r.verification.status).toBe('TAMPERED');
    expect(r.verification.issues.map((i: any) => i.code)).toContain('HEAD_SIGNATURE_INVALID');
  });

  it('DELETE de um lance do meio → TAMPERED (sequência e encadeamento quebrados)', async () => {
    const lot = await lotWith3Bids();
    await ctx.prisma.$executeRaw`DELETE FROM "Bid" WHERE "lotId" = ${lot.id} AND sequence = 2`;
    const r = await report(lot.id);
    expect(r.verification.status).toBe('TAMPERED');
    const codes = r.verification.issues.map((i: any) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['SEQUENCE_GAP', 'LINK_BROKEN']));
  });

  it('INSERT de lance falso (sem assinatura válida) → TAMPERED', async () => {
    const lot = await lotWith3Bids();
    const last = await ctx.prisma.bid.findFirstOrThrow({ where: { lotId: lot.id, sequence: 3 } });
    const alias = bidderAlias(lot.id, b.id);
    const createdAt = ctx.clock.now();
    const payload = JSON.stringify(['BID', lot.id, 4, alias, 13_000, createdAt.toISOString(), last.hash]);
    const hash = createHash('sha256').update(payload).digest('hex');
    await ctx.prisma.$executeRaw`
      INSERT INTO "Bid" (id, "lotId", "bidderId", sequence, "amountCents", "bidderAlias", "createdAt", "prevHash", hash, signature)
      VALUES (gen_random_uuid()::text, ${lot.id}, ${b.id}, 4, 13000, ${alias}, ${createdAt}, ${last.hash}, ${hash}, 'assinatura-falsa')`;
    const r = await report(lot.id);
    expect(r.verification.status).toBe('TAMPERED');
    expect(r.bids[3].checks.signatureOk).toBe(false);
    expect(r.verification.issues.map((i: any) => i.code)).toEqual(
      expect.arrayContaining(['BAD_SIGNATURE', 'HEAD_MISMATCH', 'COUNT_MISMATCH']),
    );
  });

  it('INSERT de lance com assinatura de OUTRO elo copiada → TAMPERED', async () => {
    const lot = await lotWith3Bids();
    const last = await ctx.prisma.bid.findFirstOrThrow({ where: { lotId: lot.id, sequence: 3 } });
    await ctx.prisma.$executeRaw`
      INSERT INTO "Bid" (id, "lotId", "bidderId", sequence, "amountCents", "bidderAlias", "createdAt", "prevHash", hash, signature)
      VALUES (gen_random_uuid()::text, ${lot.id}, ${b.id}, 4, 13000, ${bidderAlias(lot.id, b.id)}, ${ctx.clock.now()}, ${last.hash}, ${last.hash}, ${last.signature})`;
    const r = await report(lot.id);
    expect(r.verification.status).toBe('TAMPERED');
    expect(r.bids[3].checks.hashOk).toBe(false);
  });

  it('troca do autor de um lance (bidderId) → TAMPERED (pseudônimo não confere)', async () => {
    const lot = await lotWith3Bids();
    await ctx.prisma.$executeRaw`UPDATE "Bid" SET "bidderId" = ${b.id} WHERE "lotId" = ${lot.id} AND sequence = 1`;
    const r = await report(lot.id);
    expect(r.verification.status).toBe('TAMPERED');
    expect(r.bids[0].checks.aliasOk).toBe(false);
    expect(r.verification.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'ALIAS_MISMATCH', sequence: 1 })]));
  });

  it('alteração dos parâmetros do lote (lance inicial) → TAMPERED (genesis)', async () => {
    const lot = await lotWith3Bids();
    await ctx.prisma.$executeRaw`UPDATE "Lot" SET "startingPriceCents" = 100 WHERE id = ${lot.id}`;
    const r = await report(lot.id);
    expect(r.verification.status).toBe('TAMPERED');
    expect(r.verification.summary.genesisOk).toBe(false);
  });

  it('elo assinado legitimamente mas com valor abaixo do incremento → TAMPERED (regra de valor)', async () => {
    // Defesa extra: mesmo com assinatura válida, a sequência de valores precisa respeitar as regras.
    const lot = await createLot(ctx, { auctioneerId: auctioneer.id, startingPriceCents: 10_000, minIncrementCents: 1_000 });
    await bid(a, lot.id, 10_000);
    const first = await ctx.prisma.bid.findFirstOrThrow({ where: { lotId: lot.id } });
    const alias = bidderAlias(lot.id, b.id);
    const createdAt = ctx.clock.now();
    const sealed = sealBid({ lotId: lot.id, sequence: 2, bidderAlias: alias, amountCents: 10_100, createdAt, prevHash: first.hash });
    await ctx.prisma.bid.create({
      data: { lotId: lot.id, bidderId: b.id, sequence: 2, amountCents: 10_100, bidderAlias: alias, createdAt, prevHash: first.hash, ...sealed },
    });
    const r = await report(lot.id);
    expect(r.verification.status).toBe('TAMPERED');
    expect(r.verification.issues.map((i: any) => i.code)).toContain('AMOUNT_BELOW_MINIMUM');
  });

  it('mensagens de problema em pt-BR', async () => {
    const lot = await lotWith3Bids();
    await ctx.prisma.$executeRaw`UPDATE "Bid" SET "amountCents" = 10500 WHERE "lotId" = ${lot.id} AND sequence = 2`;
    const r = await report(lot.id);
    const issue = r.verification.issues.find((i: any) => i.code === 'HASH_MISMATCH');
    expect(issue.message).toMatch(/lance nº 2/);
  });

  it('lote inexistente → 404 LOT_NOT_FOUND', async () => {
    const res = await http().get('/api/audit/lots/00000000-0000-0000-0000-000000000000').expect(404);
    expect(res.body.code).toBe('LOT_NOT_FOUND');
  });
});
