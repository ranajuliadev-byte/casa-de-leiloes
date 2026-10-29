import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { Lot, Receipt, Wallet } from '@prisma/client';
import { randomBytes } from 'crypto';
import { Clock } from '../common/clock';
import { bidderAlias, signReceipt } from '../common/crypto/audit-crypto';
import { appendLedger, WalletOverflowError } from '../common/ledger';
import { toLotLiveState, toWalletView } from '../common/lot-view';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.gateway';
import { TX_OPTIONS } from '../common/tx-options';
import { lockLot, lockWallets, Tx, withTxRetry } from '../common/tx-utils';

export interface SettleOutcome {
  lot: Lot;
  now: Date;
  receipt: Receipt | null;
  winnerWallet: Wallet | null;
  auctioneerWallet: Wallet | null;
}

export interface SettleRunResult {
  settled: string[]; // lotes liquidados nesta rodada
  // lotes ocupados (lock), prorrogados, com falha ou em backoff — ficam para um próximo ciclo.
  // Os em backoff são os conhecidos em memória (podados a cada ciclo de nova tentativa).
  skipped: number;
  failed: string[]; // lotes cuja liquidação falhou nesta rodada (logado; não trava os demais)
}

/** Depois de tantas falhas seguidas, um lote só é re-tentado a cada N ciclos (evita log em loop). */
const FAILURE_BACKOFF_AFTER = 3;
const FAILURE_BACKOFF_CYCLES = 30; // ~1 min com o job de 2 s
const DUE_BATCH = 200; // lotes vencidos buscados por ciclo

/** Código público do comprovante (12 caracteres base64url, ~72 bits). */
export function newReceiptCode(): string {
  return randomBytes(9).toString('base64url');
}

@Injectable()
export class SettlementService {
  private readonly logger = new Logger('Settlement');
  private running = false;
  /** Falhas consecutivas por lote (em memória): isola lotes problemáticos. */
  private readonly failures = new Map<string, number>();
  private cycle = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly realtime: RealtimeService,
  ) {}

  /** Job: a cada 2 s liquida lotes vencidos. Reentrância bloqueada pela flag. */
  @Interval('settlement', 2000)
  async tick() {
    try {
      await this.settleDue();
    } catch (e) {
      this.logger.error(`Falha no ciclo de liquidação: ${(e as Error)?.stack ?? e}`);
    }
  }

  /**
   * Liquida todos os lotes com `endsAt <= agora`, não liquidados e não cancelados.
   * Idempotente: pode rodar em paralelo com outra instância (SKIP LOCKED + recheck).
   */
  async settleDue(): Promise<SettleRunResult> {
    if (this.running) return { settled: [], skipped: 0, failed: [] };
    this.running = true;
    this.cycle++;
    try {
      const now = this.clock.now();
      // Lote que já falhou várias vezes seguidas: só tenta de novo a cada N ciclos.
      // Fica FORA da consulta (não só pulado), senão ocuparia as vagas do `take` e
      // lotes vencidos depois dele nunca seriam buscados.
      const retryCycle = this.cycle % FAILURE_BACKOFF_CYCLES === 0;
      const backedOff = retryCycle
        ? []
        : [...this.failures].filter(([, n]) => n >= FAILURE_BACKOFF_AFTER).map(([id]) => id);
      const due = await this.prisma.lot.findMany({
        where: { endsAt: { lte: now }, settledAt: null, cancelledAt: null, id: { notIn: backedOff } },
        select: { id: true },
        orderBy: { endsAt: 'asc' },
        take: DUE_BATCH,
      });
      if (retryCycle) await this.forgetResolvedFailures();
      const result: SettleRunResult = { settled: [], skipped: backedOff.length, failed: [] };
      for (const { id } of due) {
        const fails = this.failures.get(id) ?? 0;
        try {
          const outcome = await this.settleLot(id);
          this.failures.delete(id);
          if (outcome) {
            result.settled.push(id);
            this.publish(outcome);
          } else {
            result.skipped++;
          }
        } catch (e) {
          // Isolamento por lote: a falha de um (ex.: carteira do leiloeiro no limite)
          // não impede os outros. A transação inteira daquele lote foi desfeita.
          result.skipped++;
          result.failed.push(id);
          this.failures.set(id, fails + 1);
          if (e instanceof WalletOverflowError) {
            this.logger.error(
              `Lote ${id} NÃO liquidado: o crédito estouraria o limite técnico da carteira do leiloeiro. ` +
                `O lote fica aguardando liquidação (o lance do vencedor continua comprometido) até intervenção manual.`,
            );
          } else {
            this.logger.error(`Falha ao liquidar lote ${id}: ${(e as Error)?.message ?? e}`);
          }
        }
      }
      return result;
    } finally {
      this.running = false;
    }
  }

  /** Esquece falhas de lotes que deixaram de estar pendentes (cancelados, liquidados por outra instância). */
  private async forgetResolvedFailures() {
    if (this.failures.size === 0) return;
    const pending = await this.prisma.lot.findMany({
      where: { id: { in: [...this.failures.keys()] }, settledAt: null, cancelledAt: null },
      select: { id: true },
    });
    const keep = new Set(pending.map((l) => l.id));
    for (const id of this.failures.keys()) if (!keep.has(id)) this.failures.delete(id);
  }

  /** Liquida um lote (ou devolve null se não for o caso / estiver ocupado). */
  async settleLot(lotId: string): Promise<SettleOutcome | null> {
    return withTxRetry(() => this.prisma.$transaction((tx) => this.settleLotTx(tx, lotId), TX_OPTIONS));
  }

  private async settleLotTx(tx: Tx, lotId: string): Promise<SettleOutcome | null> {
    // SKIP LOCKED: se um lance está em andamento neste lote, não espera — o lance
    // pode prorrogar o fim (anti-sniping). Tentamos de novo no próximo ciclo.
    if (!(await lockLot(tx, lotId, { skipLocked: true }))) return null;
    const lot = await tx.lot.findUniqueOrThrow({ where: { id: lotId } });

    // Re-checagem sob lock: idempotência (já liquidado), cancelado no meio, ou
    // prorrogado por um lance que entrou entre a consulta e o lock.
    const now = this.clock.now();
    if (lot.settledAt || lot.cancelledAt) return null;
    if (lot.endsAt.getTime() > now.getTime()) return null;

    // Sem lances: fecha sem vencedor.
    if (lot.bidCount === 0 || !lot.leaderId || lot.currentPriceCents == null) {
      const closed = await tx.lot.update({ where: { id: lot.id }, data: { settledAt: now } });
      return { lot: closed, now, receipt: null, winnerWallet: null, auctioneerWallet: null };
    }

    const price = lot.currentPriceCents;
    const winnerId = lot.leaderId;
    // Uma conta pode ter os dois perfis, mas o lance no próprio lote é recusado
    // (CANNOT_BID_OWN_LOT). Se mesmo assim existir (seed/script/banco), a mesma carteira
    // seria debitada e creditada com o mesmo nº de lançamento: falha clara, não retry.
    if (winnerId === lot.auctioneerId) throw new Error(`Lote ${lot.id}: vencedor é o próprio leiloeiro; liquidação recusada.`);
    const wallets = await lockWallets(tx, [winnerId, lot.auctioneerId]);
    const winnerW = wallets.get(winnerId);
    const auctioneerW = wallets.get(lot.auctioneerId);
    if (!winnerW || !auctioneerW) {
      throw new Error(`Carteira ausente na liquidação do lote ${lot.id}`);
    }

    // Vencedor: o valor sai do total E do comprometido (já estava reservado desde o lance).
    // Os lançamentos guardam o head da cadeia (hash do lance vencedor) — a auditoria cruza.
    const winnerWallet = await appendLedger(tx, winnerW, [
      { type: 'SETTLEMENT_DEBIT', amountCents: price, lotId: lot.id, bidHash: lot.headHash, description: `Arremate: ${lot.title}`, createdAt: now },
    ]);
    // Leiloeiro recebe o valor do arremate. Saldo em BigInt; se ainda assim passar do
    // limite técnico (2^53 − 1), appendLedger lança WalletOverflowError e a transação
    // deste lote é desfeita (ver settleDue).
    const auctioneerWallet = await appendLedger(tx, auctioneerW, [
      { type: 'SETTLEMENT_CREDIT', amountCents: price, lotId: lot.id, bidHash: lot.headHash, description: `Venda: ${lot.title}`, createdAt: now },
    ]);

    // Comprovante assinado: amarra vencedor (pseudônimo), valor e head da cadeia.
    const code = newReceiptCode();
    const winnerAlias = bidderAlias(lot.id, winnerId);
    const signature = signReceipt({
      code,
      lotId: lot.id,
      winnerAlias,
      amountCents: price,
      bidCount: lot.bidCount,
      chainHead: lot.headHash,
      issuedAt: now,
    });
    const receipt = await tx.receipt.create({
      data: {
        code,
        lotId: lot.id,
        winnerId,
        winnerAlias,
        amountCents: price,
        bidCount: lot.bidCount,
        chainHead: lot.headHash,
        issuedAt: now,
        signature,
      },
    });

    const settled = await tx.lot.update({
      where: { id: lot.id },
      data: { settledAt: now, winnerId, finalPriceCents: price },
    });

    return { lot: settled, now, receipt, winnerWallet, auctioneerWallet };
  }

  private publish(o: SettleOutcome) {
    try {
      this.realtime.lotState(toLotLiveState(o.lot, o.now));
      if (o.receipt && o.winnerWallet && o.auctioneerWallet) {
        this.realtime.wallet(o.receipt.winnerId, toWalletView(o.winnerWallet));
        this.realtime.wallet(o.lot.auctioneerId, toWalletView(o.auctioneerWallet));
        this.realtime.won(o.receipt.winnerId, {
          lotId: o.lot.id,
          title: o.lot.title,
          amountCents: o.receipt.amountCents,
          receiptCode: o.receipt.code,
        });
      }
    } catch (e) {
      this.logger.error(`Falha ao publicar eventos da liquidação: ${(e as Error)?.message ?? e}`);
    }
  }
}
