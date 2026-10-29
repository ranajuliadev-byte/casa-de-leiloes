import { createPublicKey, verify } from 'crypto';
import {
  auditKeys,
  bidderAlias,
  bidHash,
  bidPayload,
  canonical,
  cancelPayload,
  genesisHash,
  genesisPayload,
  headPayload,
  ledgerHash,
  ledgerPayload,
  requireSecret,
  sellerTag,
  signCancel,
  signWalletHead,
  stableStringify,
  walletGenesis,
  walletHeadPayload,
  receiptPayload,
  sealBid,
  sha256Hex,
  signHead,
  signReceipt,
  signText,
  verifyText,
} from '../../src/common/crypto/audit-crypto';

const LOT = '0b6f0c8e-2f7a-4c55-9a3e-6a7f1a2b3c4d';
const OTHER_LOT = '9d1e2f3a-4b5c-4d6e-8f70-112233445566';
const USER = 'a1b2c3d4-0000-4000-8000-000000000001';
const OTHER_USER = 'a1b2c3d4-0000-4000-8000-000000000002';

const genesisInput = {
  lotId: LOT,
  auctioneerId: USER,
  title: 'Noite Estrelada',
  description: 'Óleo sobre tela',
  imageUrl: 'https://www.artic.edu/iiif/2/abc/full/843,/0/default.jpg',
  attributes: { source: 'aic', externalId: 1, artist: 'Vincent van Gogh', date: '1889' },
  startingPriceCents: 10_000,
  minIncrementCents: 1_000,
  startsAt: new Date('2026-10-27T12:00:00.000Z'),
  originalEndsAt: new Date('2026-10-28T12:00:00.000Z'),
};

const link = (over: Partial<Parameters<typeof bidHash>[0]> = {}) => ({
  lotId: LOT,
  sequence: 1,
  bidderAlias: bidderAlias(LOT, USER),
  amountCents: 10_000,
  createdAt: new Date('2026-10-27T13:00:00.000Z'),
  prevHash: genesisHash(genesisInput),
  ...over,
});

describe('audit-crypto', () => {
  describe('serialização e hash', () => {
    it('canonical é JSON de array com ordem fixa', () => {
      expect(canonical(['A', 1, null, 'ç'])).toBe('["A",1,null,"ç"]');
    });

    it('sha256Hex confere com vetor conhecido', () => {
      expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    });

    it('stableStringify ordena chaves recursivamente (o jsonb do Postgres reordena chaves)', () => {
      expect(stableStringify({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[1,{"y":2,"z":1}]},"b":1}');
      expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
      expect(canonical(['X', { b: 1, a: 2 }])).toBe('["X",{"a":2,"b":1}]');
    });

    it('genesis é determinístico e muda com qualquer parâmetro do lote', () => {
      const g = genesisHash(genesisInput);
      expect(genesisHash({ ...genesisInput })).toBe(g);
      expect(g).toMatch(/^[0-9a-f]{64}$/);
      expect(genesisPayload(genesisInput)).toBe(
        '["GENESIS","0b6f0c8e-2f7a-4c55-9a3e-6a7f1a2b3c4d","Noite Estrelada","Óleo sobre tela",' +
          '"https://www.artic.edu/iiif/2/abc/full/843,/0/default.jpg",' +
          '{"artist":"Vincent van Gogh","date":"1889","externalId":1,"source":"aic"},' +
          `"${sellerTag(LOT, USER)}",10000,1000,"2026-10-27T12:00:00.000Z","2026-10-28T12:00:00.000Z"]`,
      );
      // ordem das chaves dos atributos não importa (jsonb devolve em outra ordem)
      expect(genesisHash({ ...genesisInput, attributes: { date: '1889', artist: 'Vincent van Gogh', externalId: 1, source: 'aic' } })).toBe(g);
      expect(genesisHash({ ...genesisInput, attributes: { ...genesisInput.attributes, artist: 'Outro' } })).not.toBe(g);
      expect(genesisHash({ ...genesisInput, imageUrl: 'https://exemplo.com/falsa.jpg' })).not.toBe(g);
      expect(genesisHash({ ...genesisInput, imageUrl: null })).not.toBe(g);
      expect(genesisHash({ ...genesisInput, description: 'Outra descrição' })).not.toBe(g);
      expect(genesisHash({ ...genesisInput, auctioneerId: OTHER_USER })).not.toBe(g);
      expect(genesisPayload(genesisInput)).not.toContain(USER); // vendedor só como HMAC
      expect(genesisHash({ ...genesisInput, title: 'Outra obra' })).not.toBe(g);
      expect(genesisHash({ ...genesisInput, startingPriceCents: 10_001 })).not.toBe(g);
      expect(genesisHash({ ...genesisInput, minIncrementCents: 999 })).not.toBe(g);
      expect(genesisHash({ ...genesisInput, startsAt: new Date('2026-10-27T12:00:00.001Z') })).not.toBe(g);
      expect(genesisHash({ ...genesisInput, originalEndsAt: new Date('2026-10-29T12:00:00.000Z') })).not.toBe(g);
    });

    it('hash do lance é determinístico e cobre valor, autor, horário, sequência e elo anterior', () => {
      const h = bidHash(link());
      expect(bidHash(link())).toBe(h);
      expect(sha256Hex(bidPayload(link()))).toBe(h);
      expect(bidHash(link({ amountCents: 10_001 }))).not.toBe(h);
      expect(bidHash(link({ bidderAlias: bidderAlias(LOT, OTHER_USER) }))).not.toBe(h);
      expect(bidHash(link({ createdAt: new Date('2026-10-27T13:00:01.000Z') }))).not.toBe(h);
      expect(bidHash(link({ sequence: 2 }))).not.toBe(h);
      expect(bidHash(link({ prevHash: '0'.repeat(64) }))).not.toBe(h);
      expect(bidHash(link({ lotId: OTHER_LOT }))).not.toBe(h);
    });
  });

  describe('assinaturas Ed25519', () => {
    it('par de chaves é derivado de forma determinística do AUDIT_SECRET', () => {
      const a = auditKeys();
      const b = auditKeys();
      expect(a.publicKeyRawB64).toBe(b.publicKeyRawB64);
      expect(Buffer.from(a.publicKeyRawB64, 'base64')).toHaveLength(32);
      expect(a.publicKeyPem).toContain('BEGIN PUBLIC KEY');
    });

    it('assinatura Ed25519 é determinística e verifica com a chave pública', () => {
      const s1 = signText('olá');
      expect(signText('olá')).toBe(s1); // Ed25519 é determinístico
      expect(verifyText('olá', s1)).toBe(true);
      // verificação independente, só com a chave pública exportada (como faria um auditor externo)
      const pub = createPublicKey(auditKeys().publicKeyPem);
      expect(verify(null, Buffer.from('olá', 'utf8'), pub, Buffer.from(s1, 'base64'))).toBe(true);
    });

    it('rejeita texto alterado, assinatura alterada e lixo', () => {
      const s = signText('mensagem');
      expect(verifyText('mensagem!', s)).toBe(false);
      const bytes = Buffer.from(s, 'base64');
      bytes[0] ^= 0xff;
      expect(verifyText('mensagem', bytes.toString('base64'))).toBe(false);
      expect(verifyText('mensagem', 'não-é-base64')).toBe(false);
      expect(verifyText('mensagem', '')).toBe(false);
    });

    it('cache de verificação: resultado estável e adulteração ainda detectada depois do acerto', () => {
      const s = signText('extrato');
      expect(verifyText('extrato', s)).toBe(true);
      expect(verifyText('extrato', s)).toBe(true); // do cache
      expect(verifyText('extrato!', s)).toBe(false);
      expect(verifyText('extrato!', s)).toBe(false);
    });

    it('cache de verificação é descartado quando AUDIT_SECRET muda', () => {
      const original = process.env.AUDIT_SECRET;
      const s = signText('rotação');
      expect(verifyText('rotação', s)).toBe(true);
      try {
        process.env.AUDIT_SECRET = 'outro-segredo-de-auditoria-dos-testes';
        expect(verifyText('rotação', s)).toBe(false);
      } finally {
        process.env.AUDIT_SECRET = original;
      }
      expect(verifyText('rotação', s)).toBe(true);
    });

    it('sealBid assina o hash do elo; signHead e signReceipt assinam os payloads canônicos', () => {
      const sealed = sealBid(link());
      expect(sealed.hash).toBe(bidHash(link()));
      expect(verifyText(sealed.hash, sealed.signature)).toBe(true);

      const head = signHead(LOT, 3, sealed.hash);
      expect(verifyText(headPayload(LOT, 3, sealed.hash), head)).toBe(true);
      expect(verifyText(headPayload(LOT, 2, sealed.hash), head)).toBe(false); // remover o último lance quebra o head

      const r = { code: 'ABC123', lotId: LOT, winnerAlias: bidderAlias(LOT, USER), amountCents: 50_000, bidCount: 3, chainHead: sealed.hash, issuedAt: new Date('2026-10-28T12:00:02.000Z') };
      const rs = signReceipt(r);
      expect(verifyText(receiptPayload(r), rs)).toBe(true);
      expect(verifyText(receiptPayload({ ...r, amountCents: 50_001 }), rs)).toBe(false);
    });

    it('signCancel amarra data do cancelamento, nº de lances e head', () => {
      const at = new Date('2026-10-27T15:00:00.000Z');
      const head = '0'.repeat(64);
      const s = signCancel(LOT, at, 3, head);
      expect(cancelPayload(LOT, at, 3, head)).toBe(`["CANCEL","${LOT}","2026-10-27T15:00:00.000Z",3,"${head}"]`);
      expect(verifyText(cancelPayload(LOT, at, 3, head), s)).toBe(true);
      expect(verifyText(cancelPayload(LOT, new Date(at.getTime() + 1), 3, head), s)).toBe(false);
      expect(verifyText(cancelPayload(LOT, at, 2, head), s)).toBe(false);
      expect(verifyText(cancelPayload(OTHER_LOT, at, 3, head), s)).toBe(false);
    });

    it('extrato: lançamento encadeado e head da carteira assinado (inclui saldos)', () => {
      const W = 'wallet-1';
      const entry = {
        walletId: W,
        seq: 1,
        type: 'COMMIT',
        amountCents: 10_000,
        lotId: LOT,
        bidHash: 'a'.repeat(64),
        createdAt: new Date('2026-10-27T13:00:00.000Z'),
        description: 'Lance comprometido',
        prevHash: walletGenesis(W, USER),
      };
      const h = ledgerHash(entry);
      expect(sha256Hex(ledgerPayload(entry))).toBe(h);
      expect(ledgerHash({ ...entry, amountCents: 10_001 })).not.toBe(h);
      expect(ledgerHash({ ...entry, bidHash: 'b'.repeat(64) })).not.toBe(h);
      expect(ledgerHash({ ...entry, seq: 2 })).not.toBe(h);
      expect(ledgerHash({ ...entry, prevHash: '0'.repeat(64) })).not.toBe(h);
      expect(walletGenesis(W, USER)).not.toBe(walletGenesis(W, OTHER_USER));

      const head = { walletId: W, userId: USER, ledgerCount: 1, ledgerHead: h, balanceCents: 50_000n, committedCents: 10_000n };
      const sig = signWalletHead(head);
      expect(verifyText(walletHeadPayload(head), sig)).toBe(true);
      expect(verifyText(walletHeadPayload({ ...head, balanceCents: 50_001n }), sig)).toBe(false);
      expect(verifyText(walletHeadPayload({ ...head, committedCents: 0n }), sig)).toBe(false);
      expect(verifyText(walletHeadPayload({ ...head, ledgerCount: 0 }), sig)).toBe(false);
      // BigInt e number equivalentes geram o mesmo payload (saldo vai como texto decimal)
      expect(walletHeadPayload({ ...head, balanceCents: 50_000 })).toBe(walletHeadPayload(head));
    });

    it('outro AUDIT_SECRET gera outra chave (assinaturas antigas deixam de valer)', () => {
      const original = process.env.AUDIT_SECRET;
      const sig = signText('x');
      const pub = auditKeys().publicKeyRawB64;
      try {
        process.env.AUDIT_SECRET = 'um-segredo-completamente-diferente';
        expect(auditKeys().publicKeyRawB64).not.toBe(pub);
        expect(verifyText('x', sig)).toBe(false);
      } finally {
        process.env.AUDIT_SECRET = original;
      }
      expect(verifyText('x', sig)).toBe(true);
    });
  });

  describe('segredos (requireSecret)', () => {
    const env = { ...process.env };
    afterEach(() => {
      process.env = { ...env };
    });

    it('em produção: ausente, curto ou de exemplo → erro claro', () => {
      process.env.NODE_ENV = 'production';
      delete process.env.X_SECRET;
      expect(() => requireSecret('X_SECRET', 'padrao-dev')).toThrow(/X_SECRET ausente/);
      process.env.X_SECRET = 'curto';
      expect(() => requireSecret('X_SECRET', 'padrao-dev')).toThrow(/16 caracteres/);
      process.env.X_SECRET = 'troque-este-segredo-de-auditoria';
      expect(() => requireSecret('X_SECRET', 'padrao-dev')).toThrow(/exemplo/);
      process.env.X_SECRET = 'um-segredo-longo-e-aleatorio-123';
      expect(requireSecret('X_SECRET', 'padrao-dev')).toBe('um-segredo-longo-e-aleatorio-123');
    });

    it('fora de produção: usa o padrão de desenvolvimento (com aviso)', () => {
      process.env.NODE_ENV = 'development';
      delete process.env.Y_SECRET;
      expect(requireSecret('Y_SECRET', 'padrao-dev')).toBe('padrao-dev');
    });
  });

  describe('pseudônimo (bidderAlias)', () => {
    it('tem o formato "Licitante XXXXXX" sem caracteres ambíguos', () => {
      expect(bidderAlias(LOT, USER)).toMatch(/^Licitante [A-HJ-NP-Z2-9]{6}$/);
    });

    it('é estável para o mesmo licitante no mesmo lote', () => {
      expect(bidderAlias(LOT, USER)).toBe(bidderAlias(LOT, USER));
    });

    it('é diferente entre lotes (não permite rastrear a pessoa entre leilões)', () => {
      expect(bidderAlias(LOT, USER)).not.toBe(bidderAlias(OTHER_LOT, USER));
    });

    it('é diferente entre licitantes do mesmo lote', () => {
      expect(bidderAlias(LOT, USER)).not.toBe(bidderAlias(LOT, OTHER_USER));
    });

    it('não contém o id do usuário e depende do segredo do servidor', () => {
      const alias = bidderAlias(LOT, USER);
      expect(alias).not.toContain(USER.slice(0, 6).toUpperCase());
      const original = process.env.AUDIT_SECRET;
      try {
        process.env.AUDIT_SECRET = 'outro-segredo-qualquer-123';
        expect(bidderAlias(LOT, USER)).not.toBe(alias);
      } finally {
        process.env.AUDIT_SECRET = original;
      }
    });
  });
});
