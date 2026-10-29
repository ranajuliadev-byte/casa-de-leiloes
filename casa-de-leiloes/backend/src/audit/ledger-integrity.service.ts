import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { LedgerEntry } from '@prisma/client';
import { Clock } from '../common/clock';
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
/** Carteiras consideradas por consulta de ids. */
const WALLET_PAGE = 200;
/** Teto de lançamentos lidos por snapshot (carteira maior que isso vai sozinha). */
const ENTRIES_PER_CHUNK = 50_000;
/** Sem verificação completa bem-sucedida há mais que isto: resultado velho (log de erro). */
const STALE_AFTER_MS = 3 * CHECK_INTERVAL_MS;

/**
 * Verificação COMPLETA do extrato de todas as carteiras (recalcula o hash de cada
 * lançamento), em job periódico com o resultado em memória.
 *
 * A checagem agregada feita a cada auditoria (contagem, último hash, somas, head
 * assinado) é barata, mas não recalcula hashes: alterar um campo que não entra nas
 * somas — ex.: `lotId` de um COMMIT — passa por ela. Com isso, apagar o pregão de um
 * lote e "desligar" os lançamentos dele deixava a auditoria INTACT. Este job pega a
 * alteração (o hash recalculado diverge) e a auditoria passa a acusar o extrato quebrado.
 * Roda ao subir e a cada CHECK_INTERVAL_MS; `checkedAt()` diz quando foi a última
 * passada bem-sucedida (a auditoria expõe, para ninguém confundir "não verificado" com
 * "íntegro").
 */
@Injectable()
export class LedgerIntegrityService implements OnApplicationBootstrap {
  private readonly logger = new Logger('LedgerIntegrity');
  private broken: BrokenWallet[] = [];
  private lastSuccessAt: Date | null = null;
  private readonly startedAt: Date;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {
    this.startedAt = clock.now();
  }

  /**
   * Primeira passada logo ao subir (sem segurar a inicialização). LEDGER_CHECK_ON_BOOT=false
   * desliga: nos testes, ela disputaria locks com o TRUNCATE que limpa o banco (deadlock).
   */
  onApplicationBootstrap() {
    if (process.env.LEDGER_CHECK_ON_BOOT !== 'false') void this.tick();
  }

  /** Carteiras com extrato inconsistente segundo a última verificação completa. */
  knownBroken(): readonly BrokenWallet[] {
    return this.broken;
  }

  /** Fim da última verificação completa bem-sucedida (null: nenhuma desde que subiu). */
  checkedAt(): Date | null {
    return this.lastSuccessAt;
  }

  @Interval('ledger-integrity', CHECK_INTERVAL_MS)
  async tick() {
    try {
      await this.runFullCheck();
    } catch (e) {
      this.logger.error(`Falha na verificação completa do extrato: ${(e as Error)?.stack ?? e}`);
    }
    const since = (this.lastSuccessAt ?? this.startedAt).getTime();
    if (this.clock.now().getTime() - since > STALE_AFTER_MS) {
      this.logger.error(
        `Verificação completa do extrato sem sucesso há mais de ${STALE_AFTER_MS / 60_000} min: a auditoria só tem a checagem agregada.`,
      );
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
        const page = await this.prisma.wallet.findMany({
          orderBy: { id: 'asc' },
          take: WALLET_PAGE,
          select: { id: true, ledgerCount: true },
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        });
        for (const chunk of chunkByEntries(page)) {
          found.push(...(await this.verifyChunk(chunk)));
          // Devolve o event loop entre blocos: lances e Socket.IO não ficam parados.
          await new Promise((r) => setImmediate(r));
        }
        if (page.length < WALLET_PAGE) break;
        cursor = page[page.length - 1].id;
      }
      if (found.length) this.logger.warn(`${found.length} carteira(s) com extrato inconsistente na verificação completa.`);
      this.broken = found;
      this.lastSuccessAt = this.clock.now();
      return found;
    } finally {
      this.running = false;
    }
  }

  /** Carteiras e lançamentos de um bloco no MESMO snapshot: lance no meio da leitura não gera falso alarme. */
  private async verifyChunk(walletIds: string[]): Promise<BrokenWallet[]> {
    const { wallets, entries } = await this.prisma.$transaction(
      async (tx) => {
        const wallets = await tx.wallet.findMany({ where: { id: { in: walletIds } } });
        const entries = await tx.ledgerEntry.findMany({
          where: { walletId: { in: walletIds } },
          orderBy: [{ walletId: 'asc' }, { seq: 'asc' }],
        });
        return { wallets, entries };
      },
      // Leitura grande: mais tempo que o padrão das transações de lance.
      { ...TX_OPTIONS, timeout: 60_000, isolationLevel: 'RepeatableRead' },
    );
    const byWallet = new Map<string, LedgerEntry[]>();
    for (const e of entries) {
      const list = byWallet.get(e.walletId);
      if (list) list.push(e);
      else byWallet.set(e.walletId, [e]);
    }
    const broken: BrokenWallet[] = [];
    for (const w of wallets) {
      const problems = verifyWalletLedger(w, byWallet.get(w.id) ?? []);
      if (problems.length) broken.push({ walletId: w.id, userId: w.userId, problems });
    }
    return broken;
  }
}

/** Agrupa carteiras até ENTRIES_PER_CHUNK lançamentos por bloco (pelo contador gravado). */
function chunkByEntries(wallets: { id: string; ledgerCount: number }[]): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const w of wallets) {
    if (current.length && size + w.ledgerCount > ENTRIES_PER_CHUNK) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(w.id);
    size += w.ledgerCount;
  }
  if (current.length) chunks.push(current);
  return chunks;
}
