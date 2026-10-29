import { Logger } from '@nestjs/common';
import { Prisma, Wallet } from '@prisma/client';
import { AppError } from './errors';

/** Cliente de transação interativa do Prisma. */
export type Tx = Prisma.TransactionClient;

/**
 * Trava a linha do lote (`SELECT ... FOR UPDATE`). Todas as operações que mudam o
 * estado do pregão (lance, liquidação, cancelamento) passam por esse lock, então
 * ficam SERIALIZADAS por lote: a segunda transação espera a primeira terminar e
 * depois relê o estado já atualizado (READ COMMITTED relê a versão mais nova).
 *
 * `skipLocked`: usado pela liquidação — se o lote está ocupado, pula e tenta no
 * próximo ciclo em vez de ficar bloqueado.
 */
export async function lockLot(tx: Tx, lotId: string, opts: { skipLocked?: boolean } = {}): Promise<boolean> {
  const rows = opts.skipLocked
    ? await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Lot" WHERE id = ${lotId} FOR UPDATE SKIP LOCKED`
    : await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Lot" WHERE id = ${lotId} FOR UPDATE`;
  return rows.length > 0;
}

/**
 * Trava as carteiras dos usuários informados SEMPRE em ordem crescente de id da
 * carteira (o `ORDER BY` fica abaixo do `LockRows` no plano, então os locks são
 * adquiridos nessa ordem). Ordem global fixa = sem deadlock entre transações que
 * travam o mesmo par de carteiras em lotes diferentes.
 *
 * Devolve as carteiras já relidas depois do lock (valores autoritativos).
 */
export async function lockWallets(tx: Tx, userIds: string[]): Promise<Map<string, Wallet>> {
  const ids = Array.from(new Set(userIds));
  if (ids.length === 0) return new Map();
  await tx.$queryRaw`SELECT id FROM "Wallet" WHERE "userId" IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`;
  const wallets = await tx.wallet.findMany({ where: { userId: { in: ids } } });
  return new Map(wallets.map((w) => [w.userId, w]));
}

/** Erros transitórios de banco em que é seguro repetir a transação inteira. */
export function isRetryableTxError(e: unknown): boolean {
  if (e instanceof AppError) return false;
  const err = e as any;
  const code: unknown = err?.code;
  // P2002 = unique (ex.: (lotId, sequence) duplicado); P2034 = conflito de escrita/deadlock
  if (code === 'P2002' || code === 'P2034') return true;
  const pgCode = err?.meta?.code ?? err?.cause?.code ?? err?.cause?.originalCode ?? err?.meta?.driverAdapterError?.cause?.originalCode;
  if (pgCode === '40001' || pgCode === '40P01' || pgCode === '23505') return true;
  const msg = String(err?.message ?? '');
  return /could not serialize access|deadlock detected|40001|40P01/i.test(msg);
}

const logger = new Logger('Tx');

/**
 * Repete a transação em erros transitórios (até `attempts` vezes). Com o lock do
 * lote isso não deveria acontecer — é só defesa em profundidade.
 */
export async function withTxRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (!isRetryableTxError(e) || i === attempts) throw e;
      logger.warn(`Transação repetida (tentativa ${i + 1}/${attempts}): ${(e as Error)?.message ?? e}`);
      await new Promise((r) => setTimeout(r, 5 * i + Math.floor(Math.random() * 10)));
    }
  }
  throw lastError;
}
