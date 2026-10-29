import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp, trustProxySetting } from '../src/main';
import { Clock } from '../src/common/clock';
import { MAX_WALLET_BALANCE_CENTS, WalletOverflowError } from '../src/common/ledger';
import { PrismaService } from '../src/prisma/prisma.service';
import { SettlementService } from '../src/settlement/settlement.service';
import { AuditService } from '../src/audit/audit.service';
import { bearer, createLot, createUser, MIN, resetDb, wallet } from './helpers';
import { JwtService } from '@nestjs/jwt';

/**
 * Endurecimentos da revisão: teto de carteira (I1), estouro na liquidação isolado
 * por lote (I1), rajada de cadastros (I4) e rate limit global (throttler).
 * Usa o AppModule completo (com ThrottlerGuard global).
 */
describe('Endurecimento — carteira, liquidação, cadastros e rate limit', () => {
  let app: INestApplication;
  let url: string;
  let prisma: PrismaService;
  let clock: Clock;
  let jwt: JwtService;
  let settlement: SettlementService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await configureApp(app);
    await app.listen(0, '127.0.0.1');
    url = `http://127.0.0.1:${app.getHttpServer().address().port}`;
    prisma = app.get(PrismaService);
    clock = app.get(Clock);
    jwt = app.get(JwtService);
    settlement = app.get(SettlementService);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    clock.reset();
    await resetDb(prisma);
  });

  const ctx = () => ({ prisma, jwt, clock });

  describe('I1 — teto da carteira e estouro', () => {
    it('22 depósitos de R$ 1.000.000,00: os 10 primeiros entram, os seguintes → INVALID_DEPOSIT (teto R$ 10 mi)', async () => {
      const u = await createUser(ctx(), 'BIDDER');
      const statuses: number[] = [];
      let last: any;
      for (let i = 0; i < 22; i++) {
        last = await request(url).post('/api/wallet/deposit').set(bearer(u)).send({ amountCents: 100_000_000 });
        statuses.push(last.status);
      }
      expect(statuses.filter((s) => s === 201 || s === 200)).toHaveLength(10);
      expect(statuses.filter((s) => s === 400)).toHaveLength(12);
      expect(last.body.code).toBe('INVALID_DEPOSIT');
      expect(last.body.message).toMatch(/10\.000\.000,00/);
      expect(last.body.details).toMatchObject({ maxBalanceCents: MAX_WALLET_BALANCE_CENTS, balanceCents: MAX_WALLET_BALANCE_CENTS });
      expect(statuses).not.toContain(500);
      expect(await wallet(prisma, u.id)).toMatchObject({ balanceCents: MAX_WALLET_BALANCE_CENTS });
    });

    it('depósitos concorrentes não passam do teto (carteira travada antes de somar)', async () => {
      const u = await createUser(ctx(), 'BIDDER', MAX_WALLET_BALANCE_CENTS - 300);
      const rs = await Promise.all(
        Array.from({ length: 10 }, () => request(url).post('/api/wallet/deposit').set(bearer(u)).send({ amountCents: 100 })),
      );
      expect(rs.filter((r) => r.status < 300)).toHaveLength(3);
      expect(rs.filter((r) => r.status === 400)).toHaveLength(7);
      expect(await wallet(prisma, u.id)).toMatchObject({ balanceCents: MAX_WALLET_BALANCE_CENTS });
    });

    it('saldo do leiloeiro passa de 2^31 sem estourar (BigInt) e a API devolve number', async () => {
      const auc = await createUser(ctx(), 'AUCTIONEER');
      // leiloeiro já perto do limite do INT antigo (histórico grande simulado com um crédito encadeado)
      const { appendLedger } = await import('../src/common/ledger');
      const w0 = await prisma.wallet.findUniqueOrThrow({ where: { id: auc.walletId } });
      await prisma.$transaction((tx) =>
        appendLedger(tx, w0, [
          { type: 'SETTLEMENT_CREDIT', amountCents: 2_147_000_000, description: 'Histórico (teste)', createdAt: clock.now() },
        ]),
      );
      const bidder = await createUser(ctx(), 'BIDDER', 1_000_000);
      const lot = await createLot(ctx(), { auctioneerId: auc.id, startingPriceCents: 900_000, endsInMs: 5 * MIN });
      await request(url).post(`/api/lots/${lot.id}/bids`).set(bearer(bidder)).send({ amountCents: 900_000 }).expect(201);
      clock.advance(6 * MIN);
      const run = await settlement.settleDue();
      expect(run.settled).toEqual([lot.id]);
      const res = await request(url).get('/api/wallet').set(bearer(auc)).expect(200);
      expect(res.body.wallet.balanceCents).toBe(2_147_900_000);
      expect(typeof res.body.wallet.balanceCents).toBe('number');
      expect((await app.get(AuditService).verifyLot(lot.id))?.status).toBe('INTACT');
    });

    it('estouro na liquidação é isolado por lote: o lote problemático fica pendente, os outros liquidam', async () => {
      const auc = await createUser(ctx(), 'AUCTIONEER');
      const bidder = await createUser(ctx(), 'BIDDER', 1_000_000);
      const bad = await createLot(ctx(), { auctioneerId: auc.id, endsInMs: 5 * MIN, title: 'problemático' });
      const good = await createLot(ctx(), { auctioneerId: auc.id, endsInMs: 5 * MIN, title: 'normal' });
      await request(url).post(`/api/lots/${bad.id}/bids`).set(bearer(bidder)).send({ amountCents: 10_000 }).expect(201);
      await request(url).post(`/api/lots/${good.id}/bids`).set(bearer(bidder)).send({ amountCents: 10_000 }).expect(201);
      clock.advance(6 * MIN);

      // Faz o crédito do lote `bad` estourar (simulado no ponto exato: appendLedger da liquidação).
      const ledger = await import('../src/common/ledger');
      const original = ledger.appendLedger;
      const spy = jest.spyOn(ledger, 'appendLedger').mockImplementation(async (tx, w, ops) => {
        if (ops.some((o) => o.type === 'SETTLEMENT_CREDIT' && o.lotId === bad.id)) throw new WalletOverflowError(w.id, 2n ** 60n);
        return original(tx, w, ops);
      });
      try {
        const run = await settlement.settleDue();
        expect(run.settled).toEqual([good.id]);
        expect(run.failed).toEqual([bad.id]);
      } finally {
        spy.mockRestore();
      }
      // transação do lote problemático foi desfeita por inteiro
      const b = await prisma.lot.findUniqueOrThrow({ where: { id: bad.id } });
      expect(b.settledAt).toBeNull();
      expect(await prisma.ledgerEntry.count({ where: { lotId: bad.id, type: { in: ['SETTLEMENT_DEBIT', 'SETTLEMENT_CREDIT'] } } })).toBe(0);
      expect(await wallet(prisma, bidder.id)).toMatchObject({ balanceCents: 990_000, committedCents: 10_000 });
      expect((await app.get(AuditService).verifyLot(bad.id))?.status).toBe('INTACT');
    });
  });

  describe('I4 — rajada de cadastros', () => {
    it('40 cadastros simultâneos → todos 201 (sem "Unable to start a transaction")', async () => {
      const tag = Date.now();
      const rs = await Promise.all(
        Array.from({ length: 40 }, (_, i) =>
          request(url)
            .post('/api/auth/register')
            .send({ name: `Pessoa ${i}`, email: `rajada${i}.${tag}@teste.dev`, password: 'senha123', role: 'BIDDER' }),
        ),
      );
      const byStatus = rs.reduce<Record<number, number>>((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {});
      expect(byStatus).toEqual({ 201: 40 });
      expect(await prisma.wallet.count()).toBe(40);
    }, 60_000);
  });

  describe('texto que o Postgres altera ao gravar', () => {
    it('NUL em query, corpo ou parâmetro → 400 (não 500)', async () => {
      // rota de lances (não a da vitrine: o teste do limite global conta as requisições dela)
      const q = await request(url).get('/api/lots/00000000-0000-4000-8000-000000000000/bids?cursor=%00').expect(400);
      expect(q.body.code).toBe('VALIDATION_ERROR');
      const body = await request(url).post('/api/auth/forgot-password').send({ email: 'a\u0000@b.dev' }).expect(400);
      expect(body.body.code).toBe('VALIDATION_ERROR');
      await request(url).get('/api/lots/abc%00def').expect(400);
    });

    it('descrição com surrogate isolado não faz o lote nascer "adulterado"', async () => {
      const auc = await createUser(ctx(), 'AUCTIONEER');
      await prisma.artwork.upsert({
        where: { id: 'aic:999001' },
        update: {},
        create: { id: 'aic:999001', externalId: 999001, title: 'Obra de teste', imageUrl: 'https://www.artic.edu/iiif/2/x/full/843,/0/default.jpg' },
      });
      const now = clock.now().getTime();
      const res = await request(url)
        .post('/api/lots')
        .set(bearer(auc))
        .send({
          artworkId: 'aic:999001',
          startingPriceCents: 10_000,
          minIncrementCents: 1_000,
          startsAt: new Date(now).toISOString(),
          endsAt: new Date(now + 60 * MIN).toISOString(),
          description: 'antes \ud800 depois',
        })
        .expect(201);
      const stored = await prisma.lot.findUniqueOrThrow({ where: { id: res.body.id } });
      expect(stored.description).toBe('antes � depois');
      expect((await app.get(AuditService).verifyLot(res.body.id))?.status).toBe('INTACT');
    });
  });

  describe('rate limit (ThrottlerGuard global)', () => {
    it('limite generoso por IP: 429 só depois de 600 req/min; /api/health fica fora', async () => {
      // vitrine pública: muitas requisições seguidas do mesmo IP
      const N = 600;
      let ok = 0;
      for (let i = 0; i < N; i += 50) {
        const batch = await Promise.all(Array.from({ length: 50 }, () => request(url).get('/api/lots')));
        ok += batch.filter((r) => r.status === 200).length;
      }
      expect(ok).toBe(N);
      const blocked = await request(url).get('/api/lots');
      expect(blocked.status).toBe(429);
      expect(blocked.body).toMatchObject({ statusCode: 429, code: 'RATE_LIMITED' });
      expect(blocked.body.message).toMatch(/Muitas requisições/);
      // health check não é limitado
      await request(url).get('/api/health').expect(200);
    }, 60_000);

    it('login e cadastro dividem um limite próprio de tentativas de senha (AUTH_RATE_LIMIT)', async () => {
      const previous = process.env.AUTH_RATE_LIMIT;
      process.env.AUTH_RATE_LIMIT = '5';
      try {
        const login = () => request(url).post('/api/auth/login').send({ email: 'ninguem@teste.dev', password: 'senha-errada' });
        // O contador também já inclui os cadastros deste arquivo (mesma janela de 1 min):
        // em até 5 tentativas a partir daqui, o limite tem de bloquear.
        let blocked = await login();
        for (let i = 0; i < 5 && blocked.status !== 429; i++) blocked = await login();
        expect(blocked.status).toBe(429);
        expect(blocked.body).toMatchObject({ code: 'RATE_LIMITED' });
        // ...e o cadastro (que também confere senha) cai no MESMO contador.
        const reg = await request(url)
          .post('/api/auth/register')
          .send({ name: 'Pessoa', email: 'limite@teste.dev', password: 'senha123', role: 'BIDDER' });
        expect(reg.status).toBe(429);
      } finally {
        process.env.AUTH_RATE_LIMIT = previous;
      }
    });

    it('cabeçalhos de segurança e corpo grande demais → 413 (não 500)', async () => {
      const health = await request(url).get('/api/health').expect(200);
      expect(health.headers['x-content-type-options']).toBe('nosniff');
      expect(health.headers['x-powered-by']).toBeUndefined();
      const big = await request(url)
        .post('/api/wallet/deposit')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ amountCents: 100, pad: 'x'.repeat(200_000) }));
      expect(big.status).toBe(413);
      expect(big.body).toMatchObject({ statusCode: 413, code: 'HTTP_413' });
    });

    it('trust proxy não vem de NODE_ENV (X-Forwarded-For forjado burlaria o rate limit)', () => {
      // Sem proxy declarado, só proxies locais: um cliente externo não escolhe o próprio IP.
      expect(trustProxySetting({ NODE_ENV: 'production' })).toBe('loopback');
      expect(trustProxySetting({})).toBe('loopback');
      expect(trustProxySetting({ RENDER: 'true' })).toBe(1);
      expect(trustProxySetting({ TRUST_PROXY: '2' })).toBe(2);
      expect(trustProxySetting({ TRUST_PROXY: '10.0.0.0/8', RENDER: 'true' })).toBe('10.0.0.0/8');
    });

    it('auditoria pública tem limite próprio (AUDIT_RATE_LIMIT)', async () => {
      const previous = process.env.AUDIT_RATE_LIMIT;
      process.env.AUDIT_RATE_LIMIT = '3';
      try {
        const audit = () => request(url).get('/api/audit/lots/00000000-0000-4000-8000-000000000000');
        for (let i = 0; i < 3; i++) expect((await audit()).status).toBe(404);
        const blocked = await audit();
        expect(blocked.status).toBe(429);
        expect(blocked.body).toMatchObject({ code: 'RATE_LIMITED' });
      } finally {
        if (previous === undefined) delete process.env.AUDIT_RATE_LIMIT;
        else process.env.AUDIT_RATE_LIMIT = previous;
      }
    });
  });
});
