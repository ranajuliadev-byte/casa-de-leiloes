import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { LedgerEntry } from '@prisma/client';
import { verifyWalletLedger } from '../common/ledger';
import { TX_OPTIONS } from '../common/tx-options';
import { PrismaService } from '../prisma/prisma.service';

export interface BrokenWallet {
  walletId: string;
  userId: string;
  problems: string[];
}

/** Intervalo da verificação completa (janela máxima de detecção). */
export const CHECK_INTERVAL_MS = 60_000;
/** Carteiras lidas por snapshot (cada página numa transação REPEATABLE READ). */
const PAGE_SIZE = 200;

/**
 * Verificação COMPLETA do extrato de todas as carteiras (recalcula o hash de cada
 * lançamento), em job periódico com o resultado em memória.
 *
 * A checagem agregada feita a cada auditoria (contagem, último hash, somas, head
 * assinado) é barata, mas não recalcula hashes: alterar um campo que não entra nas
 * somas — ex.: `lotId` de um COMMIT — passa por ela. Com isso, apagar o pregão de um
 * lote e "desligar" os lançamentos dele deixava a auditoria INTACT. Este job pega a
 * alteração (o hash recalculado diverge) e a auditoria passa a acusar o extrato quebrado.
 * Janela de detecção: um ciclo (CHECK_INTERVAL_MS).
 */
@Injectable()
export class LedgerIntegrityService {
  private readonly logger = new Logger('LedgerIntegrity');
  private broken: BrokenWallet[] = [];
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  /** Carteiras com extrato inconsistente segundo a última verificação completa. */
  knownBroken(): readonly BrokenWallet[] {
    return this.broken;
  }

  @Interval('ledger-integrity', CHECK_INTERVAL_MS)
  async tick() {
    try {
      await this.runFullCheck();
    } catch (e) {
      this.logger.error(`Falha na verificação completa do extrato: ${(e as Error)?.stack ?? e}`);
    }
  }

  /** Percorre todas as carteiras e recalcula cada extrato. Sem reentrância. */
  async runFullCheck(): Promise<readonly BrokenWallet[]> {
    if (this.running) return this.broken;
    this.running = true;
    try {
      const found: BrokenWallet[] = [];
      let cursor: string | undefined;
      for (;;) {
        // Carteira e lançamentos no MESMO snapshot: um lance no meio da leitura não gera falso alarme.
        const { wallets, entries } = await this.prisma.$transaction(
          async (tx) => {
            const wallets = await tx.wallet.findMany({
              orderBy: { id: 'asc' },
              take: PAGE_SIZE,
              ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            });
            const entries = wallets.length
              ? await tx.ledgerEntry.findMany({
                  where: { walletId: { in: wallets.map((w) => w.id) } },
                  orderBy: [{ walletId: 'asc' }, { seq: 'asc' }],
                })
              : [];
            return { wallets, entries };
          },
          { ...TX_OPTIONS, isolationLevel: 'RepeatableRead' },
        );

        const byWallet = new Map<string, LedgerEntry[]>();
        for (const e of entries) {
          const list = byWallet.get(e.walletId);
          if (list) list.push(e);
          else byWallet.set(e.walletId, [e]);
        }
        for (const w of wallets) {
          const problems = verifyWalletLedger(w, byWallet.get(w.id) ?? []);
          if (problems.length) found.push({ walletId: w.id, userId: w.userId, problems });
        }

        if (wallets.length < PAGE_SIZE) break;
        cursor = wallets[wallets.length - 1].id;
      }
      if (found.length) this.logger.warn(`${found.length} carteira(s) com extrato inconsistente na verificação completa.`);
      this.broken = found;
      return found;
    } finally {
      this.running = false;
    }
  }
}
