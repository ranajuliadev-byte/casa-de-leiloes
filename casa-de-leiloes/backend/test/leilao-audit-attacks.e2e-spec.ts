import request from 'supertest';
import { ANTI_SNIPING_WINDOW_MS } from '../src/common/clock';
import { signCancel, signHead } from '../src/common/crypto/audit-crypto';
import { LedgerIntegrityService } from '../src/audit/ledger-integrity.service';
import { bearer, createLot, createTestApp, createUser, HOUR, MIN, resetDb, TestCtx, TestUser } from './helpers';

/**
 * Ataques encontrados na revisão independente — cada um precisa virar TAMPERED.
 * Todos são feitos DIRETO no banco (SQL), como faria quem tem acesso ao Postgres
 * mas não ao AUDIT_SECRET.
 */
describe('Auditoria — ataques da revisão (rollback, tempo, cancelamento, extrato)', () => {
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
    a = await createUser(ctx, 'BIDDER', 1_000_000);
    b = await createUser(ctx, 'BIDDER', 1_000_000);
  });

  const http = () => request(ctx.url);
  const bid = (u: TestUser, lotId: string, amountCents: number) =>
    http().post(`/api/lots/${lotId}/bids`).set(bearer(u)).send({ amountCents }).expect(201);
  const report = async (lotId: string) => (await http().get(`/api/audit/lots/${lotId}`).expect(200)).body;
  const codes = (r: any) => r.verification.issues.map((i: any) => i.code);

  async function lotWith3Bids(endsInMs = HOUR) {
    const lot = await createLot(ctx, { auctioneerId: auctioneer.id, startingPriceCents: 10_000, minIncrementCents: 1_000, endsInMs });
    await bid(a, lot.id, 10_000);
    ctx.clock.advance(1_000);
    await bid(b, lot.id, 11_000);
    ctx.clock.advance(1_000);
    await bid(a, lot.id, 12_000);
    return lot;
  }

  describe('C1 — rollback do head (replay de um estado anterior assinado)', () => {
    it('replay.sql do revisor: apaga os lances e restaura o head do gênese → TAMPERED (LEDGER_MISMATCH)', async () => {
      const lot = await lotWith3Bids();
      // Estado "antigo" público na auditoria: bidCount 0, head = gênese, assinatura do head 0.
      const before = await ctx.prisma.lot.findUniqueOrThrow({ where: { id: lot.id } });
      expect(before.bidCount).toBe(3);
      const genesisSig = signHead(lot.id, 0, lot.genesisHash); // o mesmo valor publicado quando o lote não tinha lances
      expect(genesisSig).toBe(lot.headSignature);

      // === replay.sql (adaptado ao lote do teste) ===
      await ctx.prisma.$transaction([
        ctx.prisma.$executeRaw`DELETE FROM "Bid" WHERE "lotId" = ${lot.id} AND sequence > 0`,
        ctx.prisma.$executeRaw`UPDATE "Lot" SET "bidCount" = 0, "headHash" = ${lot.genesisHash}, "headSignature" = ${genesisSig},
          "currentPriceCents" = NULL, "leaderId" = NULL WHERE id = ${lot.id}`,
      ]);

      const r = await report(lot.id);
      expect(r.verification.status).toBe('TAMPERED');
      expect(r.verification.summary.ledgerOk).toBe(false);
      // a cadeia em si parece íntegra (esse era o furo); o extrato denuncia
      expect(r.verification.summary).toMatchObject({ chainOk: true, headOk: true, countOk: true, signaturesOk: true });
      expect(codes(r)).toContain('LEDGER_MISMATCH');
      const msg = r.verification.issues.find((i: any) => i.code === 'LEDGER_MISMATCH').message;
      expect(msg).toMatch(/não corresponde a nenhum lance da cadeia/);
    });

    it('rollback parcial para o lance nº 2 (head nº 2 assinado, capturado ao vivo) → TAMPERED', async () => {
      const lot = await createLot(ctx, { auctioneerId: auctioneer.id, startingPriceCents: 10_000, minIncrementCents: 1_000 });
      await bid(a, lot.id, 10_000);
      ctx.clock.advance(1_000);
      await bid(b, lot.id, 11_000);
      const snap = await ctx.prisma.lot.findUniqueOrThrow({ where: { id: lot.id } }); // atacante guarda o estado público
      ctx.clock.advance(1_000);
      await bid(a, lot.id, 12_000);

      await ctx.prisma.$executeRaw`DELETE FROM "Bid" WHERE "lotId" = ${lot.id} AND sequence = 3`;
      await ctx.prisma.$executeRaw`UPDATE "Lot" SET "bidCount" = 2, "headHash" = ${snap.headHash}, "headSignature" = ${snap.headSignature},
        "currentPriceCents" = 11000, "leaderId" = ${b.id} WHERE id = ${lot.id}`;
      const r = await report(lot.id);
      expect(r.verification.status).toBe('TAMPERED');
      expect(r.verification.summary).toMatchObject({ chainOk: true, headOk: true, countOk: true, priceOk: true, ledgerOk: false });
      // sobra o COMMIT do lance 3 de A e o RELEASE de B ligado ao lance 3
      expect(r.verification.issues.filter((i: any) => i.code === 'LEDGER_MISMATCH').length).toBeGreaterThanOrEqual(2);
    });

    it('rollback + apagar também os lançamentos do lote → TAMPERED (cadeia do extrato da carteira)', async () => {
      const lot = await lotWith3Bids();
      await ctx.prisma.$executeRaw`DELETE FROM "Bid" WHERE "lotId" = ${lot.id}`;
      await ctx.prisma.$executeRaw`DELETE FROM "LedgerEntry" WHERE "lotId" = ${lot.id}`;
      await ctx.prisma.$executeRaw`UPDATE "Lot" SET "bidCount" = 0, "headHash" = ${lot.genesisHash}, "headSignature" = ${lot.headSignature},
        "currentPriceCents" = NULL, "leaderId" = NULL WHERE id = ${lot.id}`;
      // "conserta" os saldos comprometidos para bater com o que sobrou
      await ctx.prisma.$executeRaw`UPDATE "Wallet" SET "committedCents" = 0 WHERE id IN (${a.walletId}, ${b.walletId})`;
      const r = await report(lot.id);
      expect(r.verification.status).toBe('TAMPERED');
      expect(codes(r)).toContain('LEDGER_CHAIN_BROKEN');
      expect(r.verification.summary.ledgerOk).toBe(false);
    });

    it('apagar o pregão e "desligar" os lançamentos (lotId = NULL) → TAMPERED após a verificação completa', async () => {
      const lot = await lotWith3Bids();
      expect(await ctx.app.get(LedgerIntegrityService).runFullCheck()).toEqual([]); // dados íntegros: nada acusado
      // Rollback ao gênese (assinatura do head 0 é pública) + lançamentos mantidos, só sem o lotId:
      // contagens, somas e heads das carteiras continuam batendo; só o hash de cada lançamento muda.
      await ctx.prisma.$transaction([
        ctx.prisma.$executeRaw`DELETE FROM "Bid" WHERE "lotId" = ${lot.id}`,
        ctx.prisma.$executeRaw`UPDATE "Lot" SET "bidCount" = 0, "headHash" = ${lot.genesisHash}, "headSignature" = ${lot.headSignature},
          "currentPriceCents" = NULL, "leaderId" = NULL WHERE id = ${lot.id}`,
        ctx.prisma.$executeRaw`UPDATE "LedgerEntry" SET "lotId" = NULL WHERE "lotId" = ${lot.id}`,
      ]);
      // A checagem agregada (por requisição) não recalcula hashes: sozinha, não percebe.
      expect((await report(lot.id)).verification.status).toBe('INTACT');

      const broken = await ctx.app.get(LedgerIntegrityService).runFullCheck();
      expect(broken.map((w) => w.walletId).sort()).toEqual([a.walletId, b.walletId].sort());
      const r = await report(lot.id);
      expect(r.verification.status).toBe('TAMPERED');
      expect(codes(r)).toContain('LEDGER_CHAIN_BROKEN');
    });

    it('lançamento de COMMIT com valor alterado → TAMPERED (não confere com o lance)', async () => {
      const lot = await lotWith3Bids();
      await ctx.prisma.$executeRaw`UPDATE "LedgerEntry" SET "amountCents" = 9000 WHERE "lotId" = ${lot.id} AND type = 'COMMIT' AND "amountCents" = 11000`;
      const r = await report(lot.id);
      expect(r.verification.status).toBe('TAMPERED');
      expect(codes(r)).toEqual(expect.arrayContaining(['LEDGER_MISMATCH', 'LEDGER_CHAIN_BROKEN']));
    });

    it('COMMIT movido para a carteira de outro licitante → TAMPERED', async () => {
      const lot = await lotWith3Bids();
      // move o COMMIT do lance 2 (de B) para a carteira de A, renumerando para não colidir
      await ctx.prisma.$executeRaw`UPDATE "LedgerEntry" SET "walletId" = ${a.walletId}, seq = 999 WHERE "lotId" = ${lot.id} AND type = 'COMMIT' AND "amountCents" = 11000`;
      const r = await report(lot.id);
      expect(r.verification.status).toBe('TAMPERED');
      expect(codes(r)).toContain('LEDGER_MISMATCH');
    });

    it('UPDATE direto no saldo de uma carteira participante → TAMPERED', async () => {
      const lot = await lotWith3Bids();
      await ctx.prisma.$executeRaw`UPDATE "Wallet" SET "balanceCents" = "balanceCents" + 500000 WHERE id = ${b.walletId}`;
      const r = await report(lot.id);
      expect(r.verification.status).toBe('TAMPERED');
      expect(r.verification.issues.find((i: any) => i.code === 'LEDGER_CHAIN_BROKEN').message).toMatch(/saldo/);
    });

    it('extrato quebrado numa carteira de FORA do lote também é apontado (lances podem ter sido apagados junto)', async () => {
      const lot = await lotWith3Bids();
      const c = await createUser(ctx, 'BIDDER', 50_000);
      const other = await createLot(ctx, { auctioneerId: auctioneer.id });
      await bid(c, other.id, 10_000);
      // apaga o lance de C e os lançamentos dele — C some da cadeia de `other`
      await ctx.prisma.$executeRaw`DELETE FROM "LedgerEntry" WHERE "walletId" = ${c.walletId} AND type = 'COMMIT'`;
      const r = await report(lot.id);
      expect(r.verification.status).toBe('TAMPERED');
      expect(r.verification.issues.some((i: any) => /carteira\(s\) da plataforma/.test(i.message))).toBe(true);
    });

    it('lance liquidado: o vencedor tem SETTLEMENT_DEBIT e o leiloeiro SETTLEMENT_CREDIT ligados ao head', async () => {
      const lot = await lotWith3Bids(5 * MIN);
      ctx.clock.advance(6 * MIN);
      await ctx.settlement.settleDue();
      expect((await report(lot.id)).verification.status).toBe('INTACT');
      const entries = await ctx.prisma.ledgerEntry.findMany({ where: { lotId: lot.id, type: { in: ['SETTLEMENT_DEBIT', 'SETTLEMENT_CREDIT'] } } });
      const settled = await ctx.prisma.lot.findUniqueOrThrow({ where: { id: lot.id } });
      expect(entries.map((e) => e.bidHash)).toEqual([settled.headHash, settled.headHash]);

      // apagar o crédito do leiloeiro (desviar o dinheiro) → TAMPERED
      await ctx.prisma.$executeRaw`DELETE FROM "LedgerEntry" WHERE "lotId" = ${lot.id} AND type = 'SETTLEMENT_CREDIT'`;
      const r = await report(lot.id);
      expect(r.verification.status).toBe('TAMPERED');
      expect(codes(r)).toContain('LEDGER_MISMATCH');
    });
  });

  describe('C2 — endsAt e cancelamento alterados direto no banco', () => {
    it('UPDATE de endsAt (lote sem lances, prorrogando) → TAMPERED (END_MISMATCH)', async () => {
      const lot = await createLot(ctx, { auctioneerId: auctioneer.id, endsInMs: HOUR });
      await ctx.prisma.$executeRaw`UPDATE "Lot" SET "endsAt" = "endsAt" + interval '3 days' WHERE id = ${lot.id}`;
      const r = await report(lot.id);
      expect(r.verification.status).toBe('TAMPERED');
      expect(r.verification.summary.timingOk).toBe(false);
      expect(codes(r)).toEqual(['END_MISMATCH']);
    });

    it('UPDATE de endsAt antecipando o fim de um lote com lances → TAMPERED', async () => {
      const lot = await lotWith3Bids();
      await ctx.prisma.$executeRaw`UPDATE "Lot" SET "endsAt" = ${new Date(ctx.clock.now().getTime() + 1_000)} WHERE id = ${lot.id}`;
      const r = await report(lot.id);
      expect(r.verification.status).toBe('TAMPERED');
      expect(codes(r)).toContain('END_MISMATCH');
    });

    it('lote em andamento prorrogado legitimamente pelo anti-sniping → INTACT (endsAt = recalculado)', async () => {
      const lot = await createLot(ctx, { auctioneerId: auctioneer.id, endsInMs: 5 * MIN });
      ctx.clock.advance(4 * MIN); // falta 1 min
      await bid(a, lot.id, 10_000); // fim → agora + 2 min
      ctx.clock.advance(90_000); // faltam 30 s do fim prorrogado
      await bid(b, lot.id, 11_000); // fim → agora + 2 min
      ctx.clock.advance(10 * 1_000);
      await bid(a, lot.id, 12_000); // faltam 1m50s → prorroga de novo
      const r = await report(lot.id);
      expect(r.verification.issues).toEqual([]);
      expect(r.verification.status).toBe('INTACT');
      const bids = await ctx.prisma.bid.findMany({ where: { lotId: lot.id }, orderBy: { sequence: 'asc' } });
      expect(Date.parse(r.lot.endsAt)).toBe(bids[2].createdAt.getTime() + ANTI_SNIPING_WINDOW_MS);

      // desfazer a prorrogação (voltar para o fim original) → TAMPERED
      await ctx.prisma.$executeRaw`UPDATE "Lot" SET "endsAt" = "originalEndsAt" WHERE id = ${lot.id}`;
      expect(codes(await report(lot.id))).toContain('END_MISMATCH');
    });

    it('lance assinado com horário depois do fim (fim "esticado" para aceitá-lo) → TAMPERED (BID_OUTSIDE_WINDOW)', async () => {
      const lot = await createLot(ctx, { auctioneerId: auctioneer.id, endsInMs: 10 * MIN });
      await bid(a, lot.id, 10_000);
      // atacante estica o fim, deixa um lance entrar depois do fim original e "devolve" o fim
      await ctx.prisma.$executeRaw`UPDATE "Lot" SET "endsAt" = "endsAt" + interval '1 hour' WHERE id = ${lot.id}`;
      ctx.clock.advance(30 * MIN);
      await bid(b, lot.id, 11_000);
      const r = await report(lot.id);
      expect(r.verification.status).toBe('TAMPERED');
      expect(r.verification.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'BID_OUTSIDE_WINDOW', sequence: 2 })]),
      );
    });

    it('UPDATE de startsAt para depois de um lance → TAMPERED (gênese e janela)', async () => {
      const lot = await lotWith3Bids();
      await ctx.prisma.$executeRaw`UPDATE "Lot" SET "startsAt" = ${ctx.clock.now()} WHERE id = ${lot.id}`;
      const r = await report(lot.id);
      expect(codes(r)).toEqual(expect.arrayContaining(['GENESIS_MISMATCH', 'BID_OUTSIDE_WINDOW']));
    });

    it('UPDATE "cancelledAt" = now() (cancelar pelo banco) → TAMPERED (CANCEL_SIGNATURE_INVALID)', async () => {
      const lot = await createLot(ctx, { auctioneerId: auctioneer.id });
      await ctx.prisma.$executeRaw`UPDATE "Lot" SET "cancelledAt" = now() WHERE id = ${lot.id}`;
      const r = await report(lot.id);
      expect(r.verification.status).toBe('TAMPERED');
      expect(r.verification.summary.cancelOk).toBe(false);
      expect(codes(r)).toEqual(['CANCEL_SIGNATURE_INVALID']);
      expect(r.verification.issues[0].message).toMatch(/sem assinatura|não há assinatura/);
    });

    it('"descancelar" (cancelledAt = NULL) mantendo a assinatura → TAMPERED', async () => {
      const lot = await lotWith3Bids();
      await http().post(`/api/lots/${lot.id}/cancel`).set(bearer(auctioneer)).send({}).expect(200);
      expect((await report(lot.id)).verification.status).toBe('INTACT');
      await ctx.prisma.$executeRaw`UPDATE "Lot" SET "cancelledAt" = NULL, "leaderId" = ${a.id} WHERE id = ${lot.id}`;
      const r = await report(lot.id);
      expect(r.verification.status).toBe('TAMPERED');
      expect(codes(r)).toContain('CANCEL_SIGNATURE_INVALID');
      expect(codes(r)).toContain('LEDGER_MISMATCH'); // o estorno do cancelamento continua no extrato
    });

    it('"descancelar" apagando também a assinatura → TAMPERED (estorno órfão no extrato)', async () => {
      const lot = await lotWith3Bids();
      await http().post(`/api/lots/${lot.id}/cancel`).set(bearer(auctioneer)).send({}).expect(200);
      await ctx.prisma.$executeRaw`UPDATE "Lot" SET "cancelledAt" = NULL, "cancelSignature" = NULL, "leaderId" = ${a.id} WHERE id = ${lot.id}`;
      const r = await report(lot.id);
      expect(r.verification.status).toBe('TAMPERED');
      expect(codes(r)).toContain('LEDGER_MISMATCH');
    });

    it('mudar a data do cancelamento → TAMPERED (assinatura cobre a data)', async () => {
      const lot = await lotWith3Bids();
      await http().post(`/api/lots/${lot.id}/cancel`).set(bearer(auctioneer)).send({}).expect(200);
      await ctx.prisma.$executeRaw`UPDATE "Lot" SET "cancelledAt" = "cancelledAt" - interval '1 second' WHERE id = ${lot.id}`;
      expect(codes(await report(lot.id))).toContain('CANCEL_SIGNATURE_INVALID');
    });

    it('cancelamento assinado de OUTRO lote copiado → TAMPERED', async () => {
      const other = await createLot(ctx, { auctioneerId: auctioneer.id });
      await http().post(`/api/lots/${other.id}/cancel`).set(bearer(auctioneer)).send({}).expect(200);
      const o = await ctx.prisma.lot.findUniqueOrThrow({ where: { id: other.id } });
      const lot = await createLot(ctx, { auctioneerId: auctioneer.id });
      await ctx.prisma.$executeRaw`UPDATE "Lot" SET "cancelledAt" = ${o.cancelledAt}, "cancelSignature" = ${o.cancelSignature} WHERE id = ${lot.id}`;
      expect(codes(await report(lot.id))).toContain('CANCEL_SIGNATURE_INVALID');
    });

    it('cancelamento sem lances, pela API → INTACT e assinatura cobre (lote, data, 0, gênese)', async () => {
      const lot = await createLot(ctx, { auctioneerId: auctioneer.id, startsInMs: HOUR, endsInMs: 2 * HOUR });
      await http().post(`/api/lots/${lot.id}/cancel`).set(bearer(auctioneer)).send({}).expect(200);
      const l = await ctx.prisma.lot.findUniqueOrThrow({ where: { id: lot.id } });
      expect(l.cancelSignature).toBe(signCancel(lot.id, l.cancelledAt!, 0, lot.genesisHash));
      expect((await report(lot.id)).verification.status).toBe('INTACT');
    });
  });

  describe('gênese cobre imagem e atributos da obra', () => {
    it('trocar a imagem do lote → TAMPERED (GENESIS_MISMATCH)', async () => {
      const lot = await createLot(ctx, { auctioneerId: auctioneer.id });
      await ctx.prisma.$executeRaw`UPDATE "Lot" SET "imageUrl" = 'https://exemplo.com/outra.jpg' WHERE id = ${lot.id}`;
      expect(codes(await report(lot.id))).toContain('GENESIS_MISMATCH');
    });

    it('alterar um atributo (artista) → TAMPERED', async () => {
      const lot = await createLot(ctx, { auctioneerId: auctioneer.id });
      await ctx.prisma.$executeRaw`UPDATE "Lot" SET attributes = jsonb_set(attributes::jsonb, '{artist}', '"Falsificador"') WHERE id = ${lot.id}`;
      expect(codes(await report(lot.id))).toContain('GENESIS_MISMATCH');
    });

    it('reordenar as chaves do JSON (mesmo conteúdo) → continua INTACT', async () => {
      const lot = await createLot(ctx, { auctioneerId: auctioneer.id });
      await ctx.prisma.$executeRaw`UPDATE "Lot" SET attributes = (SELECT jsonb_object_agg(k, v) FROM jsonb_each(attributes::jsonb) AS t(k, v)) WHERE id = ${lot.id}`;
      expect((await report(lot.id)).verification.status).toBe('INTACT');
    });

    it('trocar o leiloeiro dono do lote (desviar o crédito) → TAMPERED', async () => {
      const lot = await createLot(ctx, { auctioneerId: auctioneer.id });
      const other = await createUser(ctx, 'AUCTIONEER');
      await ctx.prisma.$executeRaw`UPDATE "Lot" SET "auctioneerId" = ${other.id} WHERE id = ${lot.id}`;
      expect(codes(await report(lot.id))).toContain('GENESIS_MISMATCH');
    });
  });

  it('comprovante fica inválido quando o extrato do lote é adulterado', async () => {
    const lot = await lotWith3Bids(5 * MIN);
    ctx.clock.advance(6 * MIN);
    await ctx.settlement.settleDue();
    const receipt = await ctx.prisma.receipt.findFirstOrThrow({ where: { lotId: lot.id } });
    expect((await http().get(`/api/receipts/${receipt.code}`).expect(200)).body.valid).toBe(true);
    await ctx.prisma.$executeRaw`DELETE FROM "LedgerEntry" WHERE "lotId" = ${lot.id} AND type = 'RELEASE'`;
    expect((await http().get(`/api/receipts/${receipt.code}`).expect(200)).body.valid).toBe(false);
  });
});
