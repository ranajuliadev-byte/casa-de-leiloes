import { Injectable } from '@nestjs/common';
import { LedgerType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService, WalletView } from '../realtime/realtime.gateway';
import { toWalletView } from '../common/lot-view';
import { AppError } from '../common/errors';
import { formatBRL } from '../common/money';
import { appendLedger, MAX_WALLET_BALANCE_CENTS } from '../common/ledger';
import { TX_OPTIONS } from '../common/tx-options';
import { lockWallets } from '../common/tx-utils';
import { Clock } from '../common/clock';
import { MAX_DEPOSIT_CENTS, MIN_DEPOSIT_CENTS } from './wallet.dto';

/** Ver docs/CONTRATO.md → LedgerEntryView */
export interface LedgerEntryView {
  id: string;
  type: LedgerType;
  amountCents: number;
  lotId: string | null;
  lotTitle: string | null;
  description: string | null;
  createdAt: string;
}

const ENTRIES_LIMIT = 50;

@Injectable()
export class WalletService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly clock: Clock,
  ) {}

  /** Só os saldos (null se o usuário não tiver carteira). */
  async getWalletView(userId: string): Promise<WalletView | null> {
    const w = await this.prisma.wallet.findUnique({ where: { userId } });
    return w ? toWalletView(w) : null;
  }

  /** Saldos + 50 últimas entradas do extrato (mais recentes primeiro). */
  async getView(userId: string): Promise<{ wallet: WalletView; entries: LedgerEntryView[] }> {
    const w = await this.ensureWallet(userId);
    const entries = await this.prisma.ledgerEntry.findMany({
      where: { walletId: w.id },
      orderBy: [{ seq: 'desc' }],
      take: ENTRIES_LIMIT,
      include: { lot: { select: { title: true } } },
    });
    return {
      wallet: toWalletView(w),
      entries: entries.map((e) => ({
        id: e.id,
        type: e.type,
        amountCents: e.amountCents,
        lotId: e.lotId,
        lotTitle: e.lot?.title ?? null,
        description: e.description,
        createdAt: e.createdAt.toISOString(),
      })),
    };
  }

  /**
   * Depósito simulado: entrada DEPOSIT encadeada no extrato. A carteira é travada
   * (FOR UPDATE) e relida antes de somar — o teto é checado sobre o saldo real.
   */
  async deposit(userId: string, amountCents: number): Promise<{ wallet: WalletView }> {
    if (!Number.isSafeInteger(amountCents) || amountCents < MIN_DEPOSIT_CENTS || amountCents > MAX_DEPOSIT_CENTS) {
      throw new AppError('INVALID_DEPOSIT', { minCents: MIN_DEPOSIT_CENTS, maxCents: MAX_DEPOSIT_CENTS });
    }
    await this.ensureWallet(userId);
    const wallet = await this.prisma.$transaction(async (tx) => {
      const w = (await lockWallets(tx, [userId])).get(userId);
      if (!w) throw new Error(`Carteira de ${userId} não encontrada logo após o upsert`);
      if (w.balanceCents + BigInt(amountCents) > BigInt(MAX_WALLET_BALANCE_CENTS)) {
        throw new AppError(
          'INVALID_DEPOSIT',
          {
            minCents: MIN_DEPOSIT_CENTS,
            maxCents: MAX_DEPOSIT_CENTS,
            maxBalanceCents: MAX_WALLET_BALANCE_CENTS,
            balanceCents: Number(w.balanceCents),
          },
          `Depósito recusado: o saldo total da carteira não pode passar de ${formatBRL(MAX_WALLET_BALANCE_CENTS)}.`,
        );
      }
      return appendLedger(tx, w, [
        { type: 'DEPOSIT', amountCents, description: 'Depósito simulado', createdAt: this.clock.now() },
      ]);
    }, TX_OPTIONS);
    const view = toWalletView(wallet);
    this.realtime.wallet(userId, view);
    return { wallet: view };
  }

  /** Usuários antigos/seed sem carteira ganham uma vazia (upsert idempotente). */
  private ensureWallet(userId: string) {
    return this.prisma.wallet.upsert({ where: { userId }, update: {}, create: { userId } });
  }
}
