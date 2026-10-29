import { Injectable, Logger } from '@nestjs/common';
import { Bid, Lot, Wallet } from '@prisma/client';
import { AuthUser } from '../common/auth/auth.guards';
import { ANTI_SNIPING_WINDOW_MS, Clock } from '../common/clock';
import { bidderAlias, sealBid, signHead } from '../common/crypto/audit-crypto';
import { AppError } from '../common/errors';
import { appendLedger } from '../common/ledger';
import { lotPhase, minimumNextBid } from '../common/lot-phase';
import { toLotLiveState, toPublicBid, toWalletView } from '../common/lot-view';
import { PrismaService } from '../prisma/prisma.service';
import { LotLiveState, PublicBid, RealtimeService, WalletView } from '../realtime/realtime.gateway';
import { TX_OPTIONS } from '../common/tx-options';
import { lockLot, lockWallets, Tx, withTxRetry } from '../common/tx-utils';

/** Maior valor representável na coluna Int do Postgres. */
export const MAX_BID_CENTS = 2_147_483_647;

export interface PlaceBidResult {
  bid: PublicBid;
  state: LotLiveState;
  wallet: WalletView;
}

interface BidOutcome {
  bid: Bid;
  lot: Lot;
  now: Date;
  bidderWallet: Wallet;
  outbid: { userId: string; amountCents: number; wallet: Wallet } | null;
}

/** Aceita apenas inteiro (centavos) > 0 que caiba no Int do banco. Nada de string/float. */
export function parseAmount(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw <= 0 || raw > MAX_BID_CENTS) {
    throw new AppError('INVALID_AMOUNT');
  }
  return raw;
}

@Injectable()
export class BidsService {
  private readonly logger = new Logger('Bids');

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly realtime: RealtimeService,
  ) {}

  /**
   * Registra um lance. Ordem de checagem (contrato):
   * papel → valor → lote existe/cancelado → fase → já líder → mínimo → saldo.
   */
  async placeBid(user: AuthUser, lotId: string, rawAmount: unknown): Promise<PlaceBidResult> {
    if (user.role === 'AUCTIONEER') throw new AppError('AUCTIONEER_CANNOT_BID');
    if (user.role !== 'BIDDER') throw new AppError('FORBIDDEN_ROLE');
    const amount = parseAmount(rawAmount);

    const outcome = await withTxRetry(() =>
      this.prisma.$transaction((tx) => this.placeBidTx(tx, user, lotId, amount), TX_OPTIONS),
    );

    // Eventos só DEPOIS do commit: ninguém vê um lance que poderia ser desfeito.
    this.publish(outcome);

    return {
      bid: toPublicBid(outcome.bid),
      state: toLotLiveState(outcome.lot, outcome.now),
      wallet: toWalletView(outcome.bidderWallet),
    };
  }

  private async placeBidTx(tx: Tx, user: AuthUser, lotId: string, amount: number): Promise<BidOutcome> {
    // 1) Lock do lote: serializa TODOS os lances deste lote. Quem chegar depois
    //    espera aqui e enxerga o preço/líder já atualizados pelo anterior.
    if (!(await lockLot(tx, lotId))) throw new AppError('LOT_NOT_FOUND');
    const lot = await tx.lot.findUniqueOrThrow({ where: { id: lotId } });

    // 2) "Agora" lido DEPOIS do lock — a fase é avaliada no instante em que o
    //    lance realmente entra na fila do lote, não quando a requisição chegou.
    const now = this.clock.now();
    if (lot.cancelledAt) throw new AppError('LOT_CANCELLED');
    const phase = lotPhase(lot, now);
    if (phase === 'SCHEDULED') throw new AppError('LOT_NOT_STARTED');
    if (phase === 'ENDED' || lot.settledAt) throw new AppError('LOT_ENDED');

    if (lot.leaderId === user.id) throw new AppError('ALREADY_WINNING');

    const minimumCents = minimumNextBid(lot);
    if (amount < minimumCents) throw new AppError('BELOW_MINIMUM', { minimumCents });

    // 3) Lock das carteiras envolvidas (licitante + líder anterior), em ordem de id.
    const prevLeaderId = lot.leaderId;
    const prevAmount = lot.currentPriceCents;
    const wallets = await lockWallets(tx, prevLeaderId ? [user.id, prevLeaderId] : [user.id]);
    const myWallet = wallets.get(user.id);
    const availableCents = myWallet ? Number(myWallet.balanceCents - myWallet.committedCents) : 0;
    if (!myWallet || amount > availableCents) {
      throw new AppError('INSUFFICIENT_BALANCE', { availableCents: Math.max(0, availableCents), requiredCents: amount });
    }

    // 4) Elo da cadeia de auditoria: hash encadeado ao head atual + assinatura Ed25519.
    //    Calculado antes do extrato porque os lançamentos guardam o hash do lance (bidHash).
    const sequence = lot.bidCount + 1;
    const alias = bidderAlias(lot.id, user.id);
    const { hash, signature } = sealBid({
      lotId: lot.id,
      sequence,
      bidderAlias: alias,
      amountCents: amount,
      createdAt: now,
      prevHash: lot.headHash,
    });
    // 5) Saldo comprometido: o valor do novo líder fica reservado (COMMIT com o hash
    //    deste lance)...
    const bidderWallet = await appendLedger(tx, myWallet, [
      { type: 'COMMIT', amountCents: amount, lotId, bidHash: hash, description: 'Lance comprometido', createdAt: now },
    ]);

    // ...e o do líder anterior volta ao disponível NA MESMA transação (RELEASE com o
    // hash do lance que o superou). A auditoria cruza esses lançamentos com a cadeia.
    let outbid: BidOutcome['outbid'] = null;
    if (prevLeaderId && prevAmount != null) {
      const prevWallet = wallets.get(prevLeaderId);
      if (!prevWallet) throw new Error(`Carteira do líder anterior ${prevLeaderId} não encontrada (lote ${lotId})`);
      const updated = await appendLedger(tx, prevWallet, [
        { type: 'RELEASE', amountCents: prevAmount, lotId, bidHash: hash, description: 'Lance superado', createdAt: now },
      ]);
      outbid = { userId: prevLeaderId, amountCents: prevAmount, wallet: updated };
    }

    const bid = await tx.bid.create({
      data: {
        lotId: lot.id,
        bidderId: user.id,
        sequence,
        amountCents: amount,
        bidderAlias: alias,
        createdAt: now,
        prevHash: lot.headHash,
        hash,
        signature,
      },
    });

    // 6) Anti-sniping: lance aceito com ≤ 2 min restantes empurra o fim para agora + 2 min.
    const remainingMs = lot.endsAt.getTime() - now.getTime();
    const endsAt = remainingMs <= ANTI_SNIPING_WINDOW_MS ? new Date(now.getTime() + ANTI_SNIPING_WINDOW_MS) : lot.endsAt;

    // 7) Estado desnormalizado do lote + novo head assinado (protege contra remoção do último lance).
    const updatedLot = await tx.lot.update({
      where: { id: lot.id },
      data: {
        currentPriceCents: amount,
        bidCount: sequence,
        leaderId: user.id,
        endsAt,
        headHash: hash,
        headSignature: signHead(lot.id, sequence, hash),
      },
    });

    return { bid, lot: updatedLot, now, bidderWallet, outbid };
  }

  private publish(o: BidOutcome) {
    try {
      this.realtime.lotBid(toPublicBid(o.bid));
      this.realtime.lotState(toLotLiveState(o.lot, o.now));
      this.realtime.wallet(o.bid.bidderId, toWalletView(o.bidderWallet));
      if (o.outbid) {
        this.realtime.wallet(o.outbid.userId, toWalletView(o.outbid.wallet));
        this.realtime.outbid(o.outbid.userId, {
          lotId: o.lot.id,
          title: o.lot.title,
          newPriceCents: o.bid.amountCents,
          yourAmountCents: o.outbid.amountCents,
        });
      }
    } catch (e) {
      // Falha de publicação não desfaz o lance (já commitado); o front ressincroniza via REST.
      this.logger.error(`Falha ao publicar eventos do lance: ${(e as Error)?.message ?? e}`);
    }
  }
}
