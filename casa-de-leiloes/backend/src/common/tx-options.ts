/**
 * Opções padrão de toda transação interativa (`prisma.$transaction(fn, TX_OPTIONS)`).
 *
 * - `maxWait`: quanto a transação pode esperar por uma conexão livre do pool. O
 *   padrão do Prisma (2 s) estoura sob rajada (ex.: 40 cadastros simultâneos →
 *   "Unable to start a transaction in the given time"); 10 s absorve picos.
 * - `timeout`: quanto a transação pode durar segurando locks antes de ser abortada.
 */
export const TX_OPTIONS = { maxWait: 10_000, timeout: 15_000 } as const;
