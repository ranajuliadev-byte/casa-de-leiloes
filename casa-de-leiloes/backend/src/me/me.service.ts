import { Injectable } from '@nestjs/common';
import { Clock } from '../common/clock';
import { bidderAlias } from '../common/crypto/audit-crypto';
import { lotPhase } from '../common/lot-phase';
import { LotSummary, toLotSummary } from '../common/lot-view';
import { PrismaService } from '../prisma/prisma.service';
import { receiptUrl } from '../receipts/receipts.service';

export type MyLotStatus = 'WINNING' | 'OUTBID' | 'WON' | 'LOST' | 'CANCELLED' | 'AWAITING_SETTLEMENT';

export interface MyLotView {
  lot: LotSummary;
  myHighestBidCents: number;
  myBidCount: number;
  alias: string;
  status: MyLotStatus;
  receipt: null | { code: string; url: string; amountCents: number; issuedAt: string };
}

/** Prioridade na listagem: o que exige atenção primeiro. */
const STATUS_ORDER: Record<MyLotStatus, number> = {
  WINNING: 0,
  OUTBID: 1,
  AWAITING_SETTLEMENT: 2,
  WON: 3,
  LOST: 4,
  CANCELLED: 5,
};

@Injectable()
export class MeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  /** Lotes em que o licitante deu lance, agrupados por lote. */
  async myBids(userId: string): Promise<{ items: MyLotView[] }> {
    const groups = await this.prisma.bid.groupBy({
      by: ['lotId'],
      where: { bidderId: userId },
      _max: { amountCents: true },
      _count: { _all: true },
    });
    if (groups.length === 0) return { items: [] };

    const lots = await this.prisma.lot.findMany({
      where: { id: { in: groups.map((g) => g.lotId) } },
      include: { auctioneer: { select: { name: true } }, receipt: true },
    });
    const byId = new Map(lots.map((l) => [l.id, l]));
    const now = this.clock.now();

    const items: MyLotView[] = [];
    for (const g of groups) {
      const lot = byId.get(g.lotId);
      if (!lot) continue;
      const phase = lotPhase(lot, now);
      let status: MyLotStatus;
      if (phase === 'CANCELLED') status = 'CANCELLED';
      else if (lot.settledAt) status = lot.winnerId === userId ? 'WON' : 'LOST';
      else if (phase === 'ENDED') status = 'AWAITING_SETTLEMENT';
      else status = lot.leaderId === userId ? 'WINNING' : 'OUTBID';

      const receipt =
        status === 'WON' && lot.receipt && lot.receipt.winnerId === userId
          ? {
              code: lot.receipt.code,
              url: receiptUrl(lot.receipt.code),
              amountCents: lot.receipt.amountCents,
              issuedAt: lot.receipt.issuedAt.toISOString(),
            }
          : null;

      items.push({
        lot: toLotSummary(lot, now),
        myHighestBidCents: g._max.amountCents ?? 0,
        myBidCount: g._count._all,
        alias: bidderAlias(lot.id, userId),
        status,
        receipt,
      });
    }

    items.sort(
      (a, b) =>
        STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
        // ao vivo: termina antes primeiro; encerrados: mais recentes primeiro
        (a.status === 'WINNING' || a.status === 'OUTBID'
          ? Date.parse(a.lot.endsAt) - Date.parse(b.lot.endsAt)
          : Date.parse(b.lot.endsAt) - Date.parse(a.lot.endsAt)),
    );
    return { items };
  }
}
