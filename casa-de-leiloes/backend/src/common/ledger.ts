import { LedgerEntry, LedgerType, Prisma, Wallet } from '@prisma/client';
import { ledgerHash, signWalletHead, verifyText, walletGenesis, walletHeadPayload } from './crypto/audit-crypto';
import { Tx } from './tx-utils';

/**
 * ===== Extrato encadeado por carteira =====
 *
 * Todo lançamento passa por `appendLedger`, que:
 *  1. numera o lançamento (seq 1..n por carteira) e o encadeia no anterior (prevHash → hash);
 *  2. aplica o efeito no saldo/comprometido a partir da linha JÁ TRAVADA da carteira;
 *  3. regrava o head da carteira e assina (nº, último hash, saldo, comprometido) com Ed25519.
 *
 * Por que encadear em vez de só assinar cada lançamento: com assinatura isolada,
 * APAGAR um lançamento (ex.: o COMMIT de um lance removido) continuaria invisível.
 * Com a cadeia, apagar do meio quebra o encadeamento e apagar do fim quebra o head
 * assinado — que também cobre o saldo, então um UPDATE direto do saldo aparece.
 *
 * PRÉ-CONDIÇÃO: a carteira foi travada com `SELECT ... FOR UPDATE` na mesma transação
 * e `wallet` foi lido DEPOIS do lock (os novos valores são absolutos, não incrementos).
 */

/** Teto do saldo de uma carteira de licitante via depósito: R$ 10.000.000,00. */
export const MAX_WALLET_BALANCE_CENTS = 1_000_000_000;

/**
 * Limite técnico de qualquer saldo (inclusive do leiloeiro, que acumula créditos):
 * a API devolve `number`, exato só até 2^53 − 1.
 */
export const MAX_SAFE_BALANCE_CENTS = BigInt(Number.MAX_SAFE_INTEGER);

export class WalletOverflowError extends Error {
  constructor(walletId: string, wouldBe: bigint) {
    super(`Saldo da carteira ${walletId} passaria do limite técnico (${wouldBe} > ${MAX_SAFE_BALANCE_CENTS} centavos)`);
    this.name = 'WalletOverflowError';
  }
}

export interface LedgerOp {
  type: LedgerType;
  amountCents: number;
  lotId?: string | null;
  /** hash do lance a que o lançamento se refere (ver schema.prisma) */
  bidHash?: string | null;
  description: string;
  createdAt: Date;
}

/** Efeito de cada tipo de lançamento no saldo total e no comprometido. */
export function ledgerEffect(type: LedgerType, amountCents: number): { balance: bigint; committed: bigint } {
  const a = BigInt(amountCents);
  switch (type) {
    case 'DEPOSIT':
      return { balance: a, committed: 0n };
    case 'COMMIT':
      return { balance: 0n, committed: a };
    case 'RELEASE':
      return { balance: 0n, committed: -a };
    case 'SETTLEMENT_DEBIT':
      return { balance: -a, committed: -a };
    case 'SETTLEMENT_CREDIT':
      return { balance: a, committed: 0n };
  }
}

/** Grava os lançamentos (encadeados) e devolve a carteira atualizada e re-assinada. */
export async function appendLedger(tx: Tx, wallet: Wallet, ops: LedgerOp[]): Promise<Wallet> {
  let count = wallet.ledgerCount;
  let head = wallet.ledgerHead ?? walletGenesis(wallet.id, wallet.userId);
  let balance = wallet.balanceCents;
  let committed = wallet.committedCents;
  const rows: Prisma.LedgerEntryCreateManyInput[] = [];

  for (const op of ops) {
    if (!Number.isSafeInteger(op.amountCents) || op.amountCents <= 0) {
      throw new Error(`Lançamento inválido (${op.type} ${op.amountCents})`);
    }
    const seq = ++count;
    const link = {
      walletId: wallet.id,
      seq,
      type: op.type,
      amountCents: op.amountCents,
      lotId: op.lotId ?? null,
      bidHash: op.bidHash ?? null,
      createdAt: op.createdAt,
      description: op.description,
      prevHash: head,
    };
    const hash = ledgerHash(link);
    rows.push({ ...link, hash });
    head = hash;

    const fx = ledgerEffect(op.type, op.amountCents);
    balance += fx.balance;
    committed += fx.committed;
  }

  if (balance > MAX_SAFE_BALANCE_CENTS) throw new WalletOverflowError(wallet.id, balance);
  if (balance < 0n || committed < 0n || committed > balance) {
    // Invariante do motor: nunca deveria acontecer (o lance só entra se couber no disponível).
    throw new Error(`Carteira ${wallet.id} ficaria incoerente (saldo ${balance}, comprometido ${committed})`);
  }

  if (rows.length) await tx.ledgerEntry.createMany({ data: rows });
  return tx.wallet.update({
    where: { id: wallet.id },
    data: {
      balanceCents: balance,
      committedCents: committed,
      ledgerCount: count,
      ledgerHead: head,
      ledgerSignature: signWalletHead({
        walletId: wallet.id,
        userId: wallet.userId,
        ledgerCount: count,
        ledgerHead: head,
        balanceCents: balance,
        committedCents: committed,
      }),
    },
  });
}

/** Resumo agregado (SQL) do extrato de uma carteira — ver `walletHealthProblems`. */
export interface WalletAggregate {
  id: string;
  userId: string;
  balanceCents: bigint;
  committedCents: bigint;
  ledgerCount: number;
  ledgerHead: string | null;
  ledgerSignature: string | null;
  entryCount: number;
  maxSeq: number;
  lastHash: string | null;
  sumBalance: bigint;
  sumCommitted: bigint;
}

/**
 * Checagem BARATA de uma carteira (sem recalcular hashes dos lançamentos): contagem,
 * último hash, soma do extrato = saldos e assinatura do head. Pega lançamentos
 * apagados/inseridos e saldos alterados em QUALQUER carteira da plataforma — inclusive
 * de quem não aparece mais no lote auditado (ex.: lances e lançamentos removidos juntos).
 */
export function walletHealthProblems(a: WalletAggregate): string[] {
  const problems: string[] = [];
  if (a.entryCount !== a.ledgerCount || a.maxSeq !== a.entryCount || (a.ledgerHead ?? null) !== (a.lastHash ?? null)) {
    problems.push('nº de lançamentos ou último hash diferente do topo do extrato');
  }
  if (a.sumBalance !== a.balanceCents || a.sumCommitted !== a.committedCents) {
    problems.push('saldo gravado diferente da soma do extrato');
  }
  const pristine = a.ledgerCount === 0 && a.ledgerHead == null && a.balanceCents === 0n && a.committedCents === 0n;
  if (!(pristine && a.ledgerSignature == null)) {
    const ok =
      !!a.ledgerSignature &&
      verifyText(
        walletHeadPayload({
          walletId: a.id,
          userId: a.userId,
          ledgerCount: a.ledgerCount,
          ledgerHead: a.ledgerHead,
          balanceCents: a.balanceCents,
          committedCents: a.committedCents,
        }),
        a.ledgerSignature,
      );
    if (!ok) problems.push('assinatura do topo do extrato inválida');
  }
  return problems;
}

/** SQL do resumo agregado de TODAS as carteiras (uma varredura do extrato). */
export const WALLET_AGGREGATE_SQL = Prisma.sql`
  SELECT w.id, w."userId", w."balanceCents", w."committedCents", w."ledgerCount", w."ledgerHead", w."ledgerSignature",
         COALESCE(e.cnt, 0)::int AS "entryCount",
         COALESCE(e.maxseq, 0)::int AS "maxSeq",
         e.lasthash AS "lastHash",
         COALESCE(e.bal, 0)::bigint AS "sumBalance",
         COALESCE(e.com, 0)::bigint AS "sumCommitted"
  FROM "Wallet" w
  LEFT JOIN (
    SELECT "walletId",
           COUNT(*) AS cnt,
           MAX(seq) AS maxseq,
           (ARRAY_AGG(hash ORDER BY seq DESC))[1] AS lasthash,
           SUM(CASE type WHEN 'DEPOSIT' THEN "amountCents" WHEN 'SETTLEMENT_CREDIT' THEN "amountCents"
                         WHEN 'SETTLEMENT_DEBIT' THEN -"amountCents" ELSE 0 END) AS bal,
           SUM(CASE type WHEN 'COMMIT' THEN "amountCents" WHEN 'RELEASE' THEN -"amountCents"
                         WHEN 'SETTLEMENT_DEBIT' THEN -"amountCents" ELSE 0 END) AS com
    FROM "LedgerEntry" GROUP BY "walletId"
  ) e ON e."walletId" = w.id`;

/**
 * Verifica a cadeia do extrato de uma carteira a partir dos dados crus.
 * Devolve a lista de problemas (vazia = íntegra). Mensagens sem dados pessoais.
 */
export function verifyWalletLedger(wallet: Wallet, entriesRaw: LedgerEntry[]): string[] {
  const problems: string[] = [];
  const entries = [...entriesRaw].sort((a, b) => a.seq - b.seq);
  let prev = walletGenesis(wallet.id, wallet.userId);
  let balance = 0n;
  let committed = 0n;

  entries.forEach((e, i) => {
    if (e.seq !== i + 1) problems.push(`lançamento nº ${i + 1} ausente ou fora de ordem (encontrado nº ${e.seq})`);
    if (e.prevHash !== prev) problems.push(`o lançamento nº ${e.seq} não aponta para o lançamento anterior`);
    const recomputed = ledgerHash({
      walletId: e.walletId,
      seq: e.seq,
      type: e.type,
      amountCents: e.amountCents,
      lotId: e.lotId,
      bidHash: e.bidHash,
      createdAt: e.createdAt,
      description: e.description,
      prevHash: e.prevHash,
    });
    if (recomputed !== e.hash) problems.push(`os dados do lançamento nº ${e.seq} não correspondem ao hash registrado`);
    const fx = ledgerEffect(e.type, e.amountCents);
    balance += fx.balance;
    committed += fx.committed;
    prev = e.hash;
  });

  const lastHash = entries.length ? entries[entries.length - 1].hash : null;
  if (wallet.ledgerCount !== entries.length || (wallet.ledgerHead ?? null) !== lastHash) {
    problems.push(`o topo do extrato (${wallet.ledgerCount} lançamento(s)) não corresponde aos ${entries.length} lançamento(s) encontrados`);
  }
  if (wallet.balanceCents !== balance || wallet.committedCents !== committed) {
    problems.push('o saldo gravado não corresponde à soma do extrato');
  }

  // Carteira nunca movimentada: sem assinatura, tudo zerado. Fora disso, a assinatura é obrigatória.
  const pristine =
    wallet.ledgerCount === 0 && wallet.ledgerHead == null && wallet.balanceCents === 0n && wallet.committedCents === 0n;
  if (!(pristine && wallet.ledgerSignature == null)) {
    const sigOk =
      !!wallet.ledgerSignature &&
      verifyText(
        walletHeadPayload({
          walletId: wallet.id,
          userId: wallet.userId,
          ledgerCount: wallet.ledgerCount,
          ledgerHead: wallet.ledgerHead,
          balanceCents: wallet.balanceCents,
          committedCents: wallet.committedCents,
        }),
        wallet.ledgerSignature,
      );
    if (!sigOk) problems.push('a assinatura do topo do extrato (nº de lançamentos, último hash e saldos) é inválida');
  }
  return problems;
}
