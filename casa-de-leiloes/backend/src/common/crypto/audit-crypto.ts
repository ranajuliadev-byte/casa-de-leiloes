import { Logger } from '@nestjs/common';
import { createHash, createHmac, createPrivateKey, createPublicKey, KeyObject, sign, verify } from 'crypto';

/**
 * ===== Histórico à prova de adulteração =====
 *
 * Cada lote tem uma CADEIA DE HASHES (estilo blockchain, sem mineração):
 *
 *   genesisHash = SHA256(["GENESIS", lotId, título, descrição, imagem, atributos, vendedor,
 *                         lance inicial, incremento, início, fim original])
 *   bid[n].hash = SHA256(["BID", lotId, n, pseudônimo, valor, createdAt, bid[n-1].hash | genesisHash])
 *
 * Além disso, o servidor ASSINA cada hash com Ed25519 e mantém no lote um
 * "head" assinado (quantidade de lances + último hash). A chave privada é
 * derivada de AUDIT_SECRET (variável de ambiente, NÃO fica no banco).
 *
 * Também são assinados: o cancelamento (["CANCEL", lotId, cancelledAt, nº lances, head])
 * e o head do EXTRATO de cada carteira (outra cadeia de hashes, ver abaixo) — a
 * auditoria cruza o extrato com a cadeia de lances.
 *
 * Consequências:
 *  - Alterar um lance (valor, autor, horário)  → hash não bate.
 *  - Recalcular todos os hashes no banco       → assinaturas não batem.
 *  - Remover um lance do meio                  → sequência/encadeamento quebra.
 *  - Remover o(s) último(s) lance(s)           → head assinado não bate.
 *  - Inserir lance falso                       → sem assinatura válida.
 *  - Alterar parâmetros do lote                → genesis não bate.
 *  - Alterar endsAt                            → fim recalculado pela cadeia não bate.
 *  - Marcar/desmarcar cancelamento             → assinatura do cancelamento.
 *  - Apagar lances + "voltar" o head do lote   → extrato (COMMIT/RELEASE) sem lance.
 *  - Apagar também o extrato                   → cadeia/head assinado da carteira.
 *
 * Qualquer pessoa pode verificar com a CHAVE PÚBLICA (GET /api/audit/public-key),
 * inclusive no navegador (WebCrypto), sem confiar no servidor.
 */

/**
 * JSON canônico: chaves de objetos ordenadas recursivamente (o jsonb do Postgres
 * reordena chaves, então a ordem de inserção não é confiável). Para arrays de
 * primitivos o resultado é idêntico a JSON.stringify.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = sortKeysDeep(x);
    }
    return out;
  }
  return v;
}

/** Serialização canônica: JSON de array com ordem fixa (objetos aninhados com chaves ordenadas). */
export function canonical(parts: unknown[]): string {
  return stableStringify(parts);
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

// ---------- chaves ----------

let cachedKeys: { privateKey: KeyObject; publicKey: KeyObject; publicKeyPem: string; publicKeyRawB64: string } | null =
  null;
let cachedSecret: string | null = null;

export const MIN_SECRET_LENGTH = 16;
const DEV_AUDIT_SECRET = 'dev-audit-secret-change-me';

/**
 * Valores de exemplo publicados no repositório (.env.example, docker-compose):
 * em produção são recusados como se estivessem ausentes.
 */
export const PUBLIC_PLACEHOLDER_SECRETS = new Set([
  DEV_AUDIT_SECRET,
  'dev-jwt-secret-change-me',
  'troque-este-segredo',
  'troque-este-segredo-jwt',
  'troque-este-segredo-de-auditoria',
]);

const warned = new Set<string>();

/**
 * Lê um segredo obrigatório. Em produção (NODE_ENV=production) falha com mensagem
 * clara se estiver ausente, curto ou for um valor de exemplo público; fora de
 * produção usa o padrão de desenvolvimento e avisa uma única vez.
 */
export function requireSecret(name: string, devDefault: string): string {
  const s = process.env[name];
  const bad = !s || s.length < MIN_SECRET_LENGTH || PUBLIC_PLACEHOLDER_SECRETS.has(s);
  if (!bad) return s;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      `${name} ausente, com menos de ${MIN_SECRET_LENGTH} caracteres ou igual a um valor de exemplo público. ` +
        `Defina ${name} com um valor longo e aleatório (ex.: \`openssl rand -base64 32\`) antes de subir em produção.`,
    );
  }
  if (!warned.has(name)) {
    warned.add(name);
    new Logger('Secrets').warn(
      s
        ? `${name} é curto ou é um valor de exemplo público — aceitável só em desenvolvimento.`
        : `${name} não definido — usando o padrão de desenvolvimento. Em produção a API não sobe sem ele.`,
    );
  }
  return s && s.length >= 8 ? s : devDefault;
}

function auditSecret(): string {
  return requireSecret('AUDIT_SECRET', DEV_AUDIT_SECRET);
}

/**
 * Checagem na SUBIDA da API (main.ts): em produção, falha antes de abrir a porta se
 * AUDIT_SECRET ou JWT_SECRET forem inválidos; fora dela, só registra o aviso.
 */
export function assertSecretsAtBoot(): void {
  auditSecret();
  requireSecret('JWT_SECRET', 'dev-jwt-secret-change-me');
}

/** Deriva um par Ed25519 determinístico a partir do AUDIT_SECRET. */
export function auditKeys() {
  const secret = auditSecret();
  if (cachedKeys && cachedSecret === secret) return cachedKeys;
  const seed = createHash('sha256').update(`ed25519|${secret}`).digest(); // 32 bytes
  // PKCS#8 DER para Ed25519 = prefixo fixo + seed de 32 bytes
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  const privateKey = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const publicKey = createPublicKey(privateKey);
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const publicKeyRawB64 = spki.subarray(spki.length - 32).toString('base64');
  cachedKeys = { privateKey, publicKey, publicKeyPem, publicKeyRawB64 };
  cachedSecret = secret;
  verifyCache.clear();
  return cachedKeys;
}

export function signText(text: string): string {
  return sign(null, Buffer.from(text, 'utf8'), auditKeys().privateKey).toString('base64');
}

/**
 * Resultados de verificação já calculados. A auditoria pública reverifica as mesmas
 * assinaturas (heads de todas as carteiras, lances) a cada requisição; o resultado é
 * determinístico para (texto, assinatura, chave), então adulterar texto ou assinatura
 * gera outra chave de cache e é verificado de verdade. Zerado quando a chave muda.
 *
 * Limite de escala: a checagem AGREGADA de cada auditoria verifica o head de todas as
 * carteiras. Com mais carteiras que VERIFY_CACHE_MAX, a varredura cíclica com despejo
 * FIFO erra sempre e o cache só custa; nessa escala, a checagem agregada também deve
 * ir para o job periódico (LedgerIntegrityService) em vez de aumentar este número.
 */
const verifyCache = new Map<string, boolean>();
const VERIFY_CACHE_MAX = 50_000;

export function verifyText(text: string, signatureB64: string): boolean {
  const publicKey = auditKeys().publicKey;
  const cacheKey = `${signatureB64}\u0000${text}`;
  const cached = verifyCache.get(cacheKey);
  if (cached !== undefined) return cached;
  let ok: boolean;
  try {
    ok = verify(null, Buffer.from(text, 'utf8'), publicKey, Buffer.from(signatureB64, 'base64'));
  } catch {
    ok = false;
  }
  if (verifyCache.size >= VERIFY_CACHE_MAX) verifyCache.delete(verifyCache.keys().next().value as string);
  verifyCache.set(cacheKey, ok);
  return ok;
}

// ---------- pseudônimos (privacidade) ----------

/**
 * Pseudônimo público, estável DENTRO de um lote e diferente entre lotes
 * (impede rastrear a mesma pessoa entre leilões). HMAC com segredo do servidor:
 * ninguém consegue descobrir o usuário a partir do pseudônimo.
 */
export function bidderAlias(lotId: string, userId: string): string {
  const mac = createHmac('sha256', auditSecret()).update(`alias|${lotId}|${userId}`).digest();
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i++) out += alphabet[mac[i] % alphabet.length];
  return `Licitante ${out}`;
}

// ---------- payloads canônicos ----------

/**
 * Pseudônimo do VENDEDOR no gênese: amarra o lote ao leiloeiro (quem recebe o
 * crédito do arremate) sem publicar o id interno. Trocar `auctioneerId` direto no
 * banco para desviar o valor da venda quebra o gênese.
 */
export function sellerTag(lotId: string, auctioneerId: string): string {
  return createHmac('sha256', auditSecret()).update(`seller|${lotId}|${auctioneerId}`).digest('hex').slice(0, 32);
}

export interface GenesisInput {
  lotId: string;
  auctioneerId: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
  /** snapshot da obra (JSON); serializado com chaves ordenadas */
  attributes: unknown;
  startingPriceCents: number;
  minIncrementCents: number;
  startsAt: Date;
  originalEndsAt: Date;
}

export function genesisPayload(l: GenesisInput): string {
  return canonical([
    'GENESIS',
    l.lotId,
    l.title,
    l.description ?? null,
    l.imageUrl ?? null,
    l.attributes ?? null,
    sellerTag(l.lotId, l.auctioneerId),
    l.startingPriceCents,
    l.minIncrementCents,
    l.startsAt.toISOString(),
    l.originalEndsAt.toISOString(),
  ]);
}

export function genesisHash(l: GenesisInput): string {
  return sha256Hex(genesisPayload(l));
}

export interface BidLinkInput {
  lotId: string;
  sequence: number;
  bidderAlias: string;
  amountCents: number;
  createdAt: Date;
  prevHash: string;
}

export function bidPayload(b: BidLinkInput): string {
  return canonical(['BID', b.lotId, b.sequence, b.bidderAlias, b.amountCents, b.createdAt.toISOString(), b.prevHash]);
}

export function bidHash(b: BidLinkInput): string {
  return sha256Hex(bidPayload(b));
}

/** Cria o elo: hash + assinatura Ed25519 do hash. */
export function sealBid(b: BidLinkInput): { hash: string; signature: string } {
  const hash = bidHash(b);
  return { hash, signature: signText(hash) };
}

export function headPayload(lotId: string, bidCount: number, headHash: string): string {
  return canonical(['HEAD', lotId, bidCount, headHash]);
}

export function signHead(lotId: string, bidCount: number, headHash: string): string {
  return signText(headPayload(lotId, bidCount, headHash));
}

// ---------- cancelamento ----------

/** Cancelamento assinado: amarra a data do cancelamento ao estado da cadeia naquele instante. */
export function cancelPayload(lotId: string, cancelledAt: Date, bidCount: number, headHash: string): string {
  return canonical(['CANCEL', lotId, cancelledAt.toISOString(), bidCount, headHash]);
}

export function signCancel(lotId: string, cancelledAt: Date, bidCount: number, headHash: string): string {
  return signText(cancelPayload(lotId, cancelledAt, bidCount, headHash));
}

// ---------- extrato (LedgerEntry) ----------

/**
 * O extrato de cada carteira também é uma cadeia de hashes:
 *
 *   gênese da carteira = SHA256(["WALLET", walletId, userId])
 *   entry[k].hash      = SHA256(["LEDGER", walletId, k, tipo, valor, lotId, bidHash,
 *                                createdAt, descrição, entry[k-1].hash | gênese])
 *   head da carteira   = Ed25519(["WALLET_HEAD", walletId, userId, nº lançamentos,
 *                                 último hash, saldo, comprometido])
 *
 * `bidHash` amarra o lançamento ao lance da cadeia do lote (a auditoria cruza os dois).
 * Saldo e comprometido entram no head assinado: UPDATE direto do saldo é detectado.
 */
export function walletGenesis(walletId: string, userId: string): string {
  return sha256Hex(canonical(['WALLET', walletId, userId]));
}

export interface LedgerLinkInput {
  walletId: string;
  seq: number;
  type: string;
  amountCents: number;
  lotId: string | null;
  bidHash: string | null;
  createdAt: Date;
  description: string | null;
  prevHash: string;
}

export function ledgerPayload(e: LedgerLinkInput): string {
  return canonical([
    'LEDGER',
    e.walletId,
    e.seq,
    e.type,
    e.amountCents,
    e.lotId ?? null,
    e.bidHash ?? null,
    e.createdAt.toISOString(),
    e.description ?? null,
    e.prevHash,
  ]);
}

export function ledgerHash(e: LedgerLinkInput): string {
  return sha256Hex(ledgerPayload(e));
}

export interface WalletHeadInput {
  walletId: string;
  userId: string;
  ledgerCount: number;
  ledgerHead: string | null;
  balanceCents: bigint | number;
  committedCents: bigint | number;
}

export function walletHeadPayload(w: WalletHeadInput): string {
  return canonical([
    'WALLET_HEAD',
    w.walletId,
    w.userId,
    w.ledgerCount,
    w.ledgerHead ?? null,
    // BigInt não é serializável em JSON: vai como texto decimal.
    BigInt(w.balanceCents).toString(),
    BigInt(w.committedCents).toString(),
  ]);
}

export function signWalletHead(w: WalletHeadInput): string {
  return signText(walletHeadPayload(w));
}

export interface ReceiptInput {
  code: string;
  lotId: string;
  winnerAlias: string;
  amountCents: number;
  bidCount: number;
  chainHead: string;
  issuedAt: Date;
}

export function receiptPayload(r: ReceiptInput): string {
  return canonical([
    'RECEIPT',
    r.code,
    r.lotId,
    r.winnerAlias,
    r.amountCents,
    r.bidCount,
    r.chainHead,
    r.issuedAt.toISOString(),
  ]);
}

export function signReceipt(r: ReceiptInput): string {
  return signText(receiptPayload(r));
}
