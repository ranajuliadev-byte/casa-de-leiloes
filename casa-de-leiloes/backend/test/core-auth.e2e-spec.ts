import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/main';
import { Clock } from '../src/common/clock';
import { MailService } from '../src/mail/mail.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { RESET_COOLDOWN_MS, RESET_TOKEN_TTL_MS } from '../src/auth/auth.service';
import { createLot, MIN, resetDb } from './helpers';

/**
 * Conta com dois perfis (mesmo e-mail para leiloeiro e comprador), login escolhendo o
 * perfil, troca de perfil e recuperação de senha.
 */
describe('Auth — dois perfis por conta e recuperação de senha', () => {
  let app: INestApplication;
  let url: string;
  let prisma: PrismaService;
  let clock: Clock;
  let mail: MailService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await configureApp(app);
    await app.listen(0, '127.0.0.1');
    url = `http://127.0.0.1:${app.getHttpServer().address().port}`;
    prisma = app.get(PrismaService);
    clock = app.get(Clock);
    mail = app.get(MailService);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    clock.reset();
    await resetDb(prisma);
    mail.outbox.length = 0;
  });

  const http = () => request(url);
  const register = (email: string, role: 'BIDDER' | 'AUCTIONEER', password = 'senha123') =>
    http().post('/api/auth/register').send({ name: 'Pessoa Teste', email, password, role });
  const login = (email: string, password: string, role?: 'BIDDER' | 'AUCTIONEER') =>
    http().post('/api/auth/login').send({ email, password, ...(role ? { role } : {}) });
  const resetLink = () => {
    const m = /token=([A-Za-z0-9_-]{43})/.exec(mail.outbox.at(-1)?.text ?? '');
    return m?.[1];
  };
  /** O link é gerado e enviado em segundo plano: espera o e-mail nº `n` chegar. */
  const waitForMail = async (n: number) => {
    for (let i = 0; i < 100 && mail.outbox.length < n; i++) await new Promise((r) => setTimeout(r, 20));
    expect(mail.outbox).toHaveLength(n);
  };
  const requestReset = async (email: string, expectedMails: number) => {
    await http().post('/api/auth/forgot-password').send({ email }).expect(200);
    await waitForMail(expectedMails);
    return resetLink()!;
  };

  describe('dois perfis com o mesmo e-mail', () => {
    it('cadastrar o segundo perfil com a MESMA senha habilita os dois na mesma conta', async () => {
      const a = await register('dupla@teste.dev', 'BIDDER').expect(201);
      expect(a.body.user).toMatchObject({ role: 'BIDDER', roles: ['BIDDER'] });

      const b = await register('dupla@teste.dev', 'AUCTIONEER').expect(201);
      expect(b.body.user).toMatchObject({ id: a.body.user.id, role: 'AUCTIONEER', roles: ['BIDDER', 'AUCTIONEER'] });
      expect(await prisma.user.count()).toBe(1);
      expect(await prisma.wallet.count()).toBe(1);
    });

    it('com outra senha é recusado (EMAIL_TAKEN) e não muda a conta', async () => {
      await register('dupla@teste.dev', 'BIDDER').expect(201);
      const r = await register('dupla@teste.dev', 'AUCTIONEER', 'outra-senha').expect(409);
      expect(r.body.code).toBe('EMAIL_TAKEN');
      expect((await prisma.user.findFirstOrThrow()).roles).toEqual(['BIDDER']);
    });

    it('o mesmo perfil de novo → ROLE_ALREADY_ENABLED', async () => {
      await register('dupla@teste.dev', 'BIDDER').expect(201);
      expect((await register('dupla@teste.dev', 'BIDDER').expect(409)).body.code).toBe('ROLE_ALREADY_ENABLED');
    });

    it('login escolhe o perfil; perfil não habilitado → ROLE_NOT_ENABLED; conta dupla sem perfil → 400', async () => {
      await register('so-comprador@teste.dev', 'BIDDER').expect(201);
      expect((await login('so-comprador@teste.dev', 'senha123').expect(200)).body.user.role).toBe('BIDDER');
      expect((await login('so-comprador@teste.dev', 'senha123', 'AUCTIONEER').expect(403)).body.code).toBe('ROLE_NOT_ENABLED');

      await register('dupla@teste.dev', 'BIDDER').expect(201);
      await register('dupla@teste.dev', 'AUCTIONEER').expect(201);
      expect((await login('dupla@teste.dev', 'senha123', 'AUCTIONEER').expect(200)).body.user.role).toBe('AUCTIONEER');
      expect((await login('dupla@teste.dev', 'senha123', 'BIDDER').expect(200)).body.user.role).toBe('BIDDER');
      await login('dupla@teste.dev', 'senha123').expect(400);
      // senha errada continua genérica, mesmo informando o perfil
      expect((await login('dupla@teste.dev', 'errada', 'BIDDER').expect(401)).body.code).toBe('INVALID_CREDENTIALS');
    });

    it('troca de perfil emite token novo; o perfil vale nas rotas protegidas', async () => {
      await register('dupla@teste.dev', 'BIDDER').expect(201);
      const auc = await register('dupla@teste.dev', 'AUCTIONEER').expect(201);
      const asAuctioneer = { Authorization: `Bearer ${auc.body.accessToken}` };
      await http().get('/api/auctioneer/lots').set(asAuctioneer).expect(200);
      await http().get('/api/me/bids').set(asAuctioneer).expect(403);

      const sw = await http().post('/api/auth/switch-role').set(asAuctioneer).send({ role: 'BIDDER' }).expect(200);
      const asBidder = { Authorization: `Bearer ${sw.body.accessToken}` };
      expect(sw.body.user).toMatchObject({ role: 'BIDDER', roles: ['BIDDER', 'AUCTIONEER'] });
      await http().get('/api/me/bids').set(asBidder).expect(200);
      expect((await http().get('/api/auth/me').set(asBidder).expect(200)).body.user.role).toBe('BIDDER');

      // Não serve para renovar a sessão: mesmo perfil é recusado e o token novo herda a expiração.
      const same = await http().post('/api/auth/switch-role').set(asBidder).send({ role: 'BIDDER' }).expect(409);
      expect(same.body.code).toBe('ROLE_ALREADY_ACTIVE');
      const exp = (t: string) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()).exp as number;
      expect(exp(sw.body.accessToken)).toBeLessThanOrEqual(exp(auc.body.accessToken));
    });

    it('com o perfil de comprador, não dá lance no próprio lote (CANNOT_BID_OWN_LOT)', async () => {
      const b = await register('dupla@teste.dev', 'BIDDER').expect(201);
      await register('dupla@teste.dev', 'AUCTIONEER').expect(201);
      const userId = b.body.user.id as string;
      const lot = await createLot({ prisma, clock }, { auctioneerId: userId, endsInMs: 60 * MIN });
      const asBidder = { Authorization: `Bearer ${b.body.accessToken}` };
      const r = await http().post(`/api/lots/${lot.id}/bids`).set(asBidder).send({ amountCents: 10_000 }).expect(403);
      expect(r.body.code).toBe('CANNOT_BID_OWN_LOT');
      expect((await http().get(`/api/lots/${lot.id}`).set(asBidder).expect(200)).body.viewer.canBid).toBe(false);
    });
  });

  describe('recuperação de senha', () => {
    it('resposta igual para e-mail existente e inexistente; só o existente recebe o link', async () => {
      await register('pessoa@teste.dev', 'BIDDER').expect(201);
      const unknown = await http().post('/api/auth/forgot-password').send({ email: 'ninguem@teste.dev' }).expect(200);
      expect(mail.outbox).toHaveLength(0);
      const known = await http().post('/api/auth/forgot-password').send({ email: 'Pessoa@Teste.dev' }).expect(200);
      expect(known.body).toEqual(unknown.body);
      await waitForMail(1); // envio é assíncrono
      expect(mail.outbox).toHaveLength(1);
      expect(mail.outbox[0].to).toBe('pessoa@teste.dev');
      expect(resetLink()).toBeDefined();
      // só o hash vai para o banco
      const row = await prisma.passwordResetToken.findFirstOrThrow();
      expect(row.tokenHash).not.toBe(resetLink());
    });

    it('link redefine a senha uma única vez; a senha antiga deixa de valer', async () => {
      await register('pessoa@teste.dev', 'BIDDER').expect(201);
      const token = await requestReset('pessoa@teste.dev', 1);

      await http().post('/api/auth/reset-password').send({ token, password: 'nova-senha' }).expect(200);
      await login('pessoa@teste.dev', 'senha123').expect(401);
      await login('pessoa@teste.dev', 'nova-senha').expect(200);
      const again = await http().post('/api/auth/reset-password').send({ token, password: 'outra' + 'senha' }).expect(400);
      expect(again.body.code).toBe('INVALID_RESET_TOKEN');
    });

    it('redefinir a senha derruba as sessões abertas (token antigo → 401)', async () => {
      const r = await register('pessoa@teste.dev', 'BIDDER').expect(201);
      const stolen = { Authorization: `Bearer ${r.body.accessToken}` };
      await http().get('/api/auth/me').set(stolen).expect(200);

      const token = await requestReset('pessoa@teste.dev', 1);
      await http().post('/api/auth/reset-password').send({ token, password: 'nova-senha' }).expect(200);

      await http().get('/api/auth/me').set(stolen).expect(401);
      await http().post('/api/auth/switch-role').set(stolen).send({ role: 'AUCTIONEER' }).expect(401);
      const fresh = await login('pessoa@teste.dev', 'nova-senha').expect(200);
      await http().get('/api/auth/me').set({ Authorization: `Bearer ${fresh.body.accessToken}` }).expect(200);
    });

    it('intervalo mínimo entre links: pedido repetido logo em seguida não envia outro e-mail', async () => {
      await register('pessoa@teste.dev', 'BIDDER').expect(201);
      const first = await requestReset('pessoa@teste.dev', 1);
      await http().post('/api/auth/forgot-password').send({ email: 'pessoa@teste.dev' }).expect(200);
      await new Promise((r) => setTimeout(r, 200));
      expect(mail.outbox).toHaveLength(1);
      // o link recebido continua válido (não foi anulado pelo pedido repetido)
      await http().post('/api/auth/reset-password').send({ token: first, password: 'nova-senha' }).expect(200);
    });

    it('link expira em 30 min e um pedido novo (após o intervalo) invalida o anterior', async () => {
      await register('pessoa@teste.dev', 'BIDDER').expect(201);
      const first = await requestReset('pessoa@teste.dev', 1);
      clock.advance(RESET_COOLDOWN_MS + 1);
      const second = await requestReset('pessoa@teste.dev', 2);
      expect(second).not.toBe(first);
      expect((await http().post('/api/auth/reset-password').send({ token: first, password: 'nova-senha' }).expect(400)).body.code).toBe(
        'INVALID_RESET_TOKEN',
      );

      clock.advance(RESET_TOKEN_TTL_MS + 1);
      expect((await http().post('/api/auth/reset-password').send({ token: second, password: 'nova-senha' }).expect(400)).body.code).toBe(
        'INVALID_RESET_TOKEN',
      );
      await login('pessoa@teste.dev', 'senha123').expect(200);
    });

    it('token malformado → 400 de validação', async () => {
      const r = await http().post('/api/auth/reset-password').send({ token: 'curto', password: 'nova-senha' }).expect(400);
      expect(r.body.code).toBe('VALIDATION_ERROR');
    });
  });
});
