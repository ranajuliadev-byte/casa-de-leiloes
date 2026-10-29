import { Injectable } from '@nestjs/common';
import { Lot, Prisma, Role } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { Clock } from '../common/clock';
import { AppError } from '../common/errors';
import { AuthUser } from '../common/auth/auth.guards';
import { bidderAlias, genesisHash, signCancel, signHead } from '../common/crypto/audit-crypto';
import { appendLedger } from '../common/ledger';
import { TX_OPTIONS } from '../common/tx-options';
import { lockLot, lockWallets, withTxRetry } from '../common/tx-utils';
import { storableText } from '../common/text';
import { lotPhase, LotPhase } from '../common/lot-phase';
import { LotAttributes, LotSummary, toLotLiveState, toLotSummary, toPublicBid, toWalletView } from '../common/lot-view';
import { PublicBid, RealtimeService } from '../realtime/realtime.gateway';
import { ArtworksService } from '../artworks/artworks.service';
import { CreateLotDto, ListBidsDto, ListLotsDto } from './lots.dto';

export interface LotViewer {
  role: Role;
  alias: string | null;
  isLeader: boolean;
  myHighestBidCents: number | null;
  position: number | null;
  canBid: boolean;
  isOwner: boolean;
}

export type LotDetail = LotSummary & { description: string | null; bids: PublicBid[]; viewer: LotViewer | null };

export type LotResult = 'PENDING' | 'SOLD' | 'UNSOLD' | 'CANCELLED';

export type AuctioneerLotView = LotSummary & {
  cancelledAt: string | null;
  cancelReason: string | null;
  result: LotResult;
  receivedCents: number;
  canCancel: boolean;
};

type LotWithAuctioneer = Lot & { auctioneer: { name: string } };

const DETAIL_BIDS = 50;
const DEFAULT_PAGE_SIZE = 24;
/** Tolerância para `startsAt` um pouco no passado (relógio do navegador, tempo de preencher o formulário). */
const START_GRACE_MS = 5 * 60 * 1000;

/** Resultado do lote do ponto de vista do leiloeiro. */
export function lotResult(lot: Lot, phase: LotPhase): LotResult {
  if (phase === 'CANCELLED') return 'CANCELLED';
  if (phase !== 'ENDED' || !lot.settledAt) return 'PENDING'; // encerrado mas ainda não liquidado → PENDING
  return lot.winnerId ? 'SOLD' : 'UNSOLD';
}

/** Escapa curingas do LIKE para buscar o texto literal. */
function likePattern(q: string) {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

@Injectable()
export class LotsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly artworks: ArtworksService,
    private readonly realtime: RealtimeService,
  ) {}

  // ---------------------------------------------------------------- criação

  async create(user: AuthUser, dto: CreateLotDto): Promise<LotDetail> {
    const now = this.clock.now();
    let startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
      throw new AppError('INVALID_SCHEDULE');
    }
    if (startsAt.getTime() < now.getTime() - START_GRACE_MS) {
      throw new AppError('INVALID_SCHEDULE', { reason: 'STARTS_IN_PAST' }, 'O início não pode estar no passado.');
    }
    // "Começar agora": um início levemente no passado vira o instante atual.
    if (startsAt.getTime() < now.getTime()) startsAt = now;
    if (endsAt.getTime() <= startsAt.getTime() || endsAt.getTime() <= now.getTime()) {
      throw new AppError('INVALID_SCHEDULE');
    }

    const artwork = await this.artworks.getForLot(dto.artworkId);

    // Snapshot da obra: o lote não depende mais da API externa nem do cache.
    const attributes: LotAttributes = {
      artist: artwork.artist,
      date: artwork.dateLabel,
      medium: artwork.medium,
      dimensions: artwork.dimensions,
      origin: artwork.origin,
      source: 'aic',
      externalId: artwork.externalId,
    };

    // O id é gerado antes do INSERT porque entra no payload do genesis.
    const id = randomUUID();
    // Normalizado antes do genesis: o hash precisa bater com o valor que o Postgres grava.
    const description = dto.description != null ? storableText(dto.description) : null;
    const genesis = genesisHash({
      lotId: id,
      auctioneerId: user.id,
      title: artwork.title,
      description,
      imageUrl: artwork.imageUrl,
      attributes,
      startingPriceCents: dto.startingPriceCents,
      minIncrementCents: dto.minIncrementCents,
      startsAt,
      originalEndsAt: endsAt,
    });

    const lot = await this.prisma.lot.create({
      data: {
        id,
        auctioneerId: user.id,
        artworkId: artwork.id,
        title: artwork.title,
        description,
        imageUrl: artwork.imageUrl,
        attributes: attributes as unknown as Prisma.InputJsonValue,
        startingPriceCents: dto.startingPriceCents,
        minIncrementCents: dto.minIncrementCents,
        startsAt,
        endsAt,
        originalEndsAt: endsAt,
        genesisHash: genesis,
        headHash: genesis,
        headSignature: signHead(id, 0, genesis),
      },
    });

    this.realtime.lotState(toLotLiveState(lot, this.clock.now()));
    return this.findDetail(id, user);
  }

  // ---------------------------------------------------------------- vitrine

  async list(dto: ListLotsDto) {
    const now = this.clock.now();
    const page = dto.page ?? 1;
    const pageSize = dto.pageSize ?? DEFAULT_PAGE_SIZE;
    const sort = dto.sort ?? 'ending';
    // As colunas são `timestamp(3)` sem fuso, gravadas em UTC. Passa o instante como ISO com
    // `Z` e converte explicitamente para UTC: não depende de como o driver serializa um
    // `Date` nem do TimeZone da sessão/processo.
    const nowSql = Prisma.sql`(${now.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;

    // Fase calculada no SQL a partir do Clock (mesma regra de common/lot-phase.ts).
    const conds: Prisma.Sql[] = [Prisma.sql`l."cancelledAt" IS NULL`];
    if (dto.phase === 'LIVE') conds.push(Prisma.sql`l."startsAt" <= ${nowSql} AND l."endsAt" > ${nowSql}`);
    if (dto.phase === 'SCHEDULED') conds.push(Prisma.sql`l."startsAt" > ${nowSql}`);
    if (dto.phase === 'ENDED') conds.push(Prisma.sql`l."endsAt" <= ${nowSql}`);
    if (dto.q) {
      const pattern = likePattern(dto.q);
      conds.push(Prisma.sql`(l."title" ILIKE ${pattern} OR l."attributes"->>'artist' ILIKE ${pattern})`);
    }
    const where = Prisma.join(conds, ' AND ');

    const price = Prisma.sql`COALESCE(l."currentPriceCents", l."startingPriceCents")`;
    let orderBy: Prisma.Sql;
    switch (sort) {
      case 'newest':
        orderBy = Prisma.sql`l."createdAt" DESC`;
        break;
      case 'price_asc':
        orderBy = Prisma.sql`${price} ASC`;
        break;
      case 'price_desc':
        orderBy = Prisma.sql`${price} DESC`;
        break;
      default:
        // "Terminando": ao vivo (fim mais próximo) → agendados (início mais próximo) → encerrados (mais recentes).
        orderBy = Prisma.sql`
          CASE WHEN l."endsAt" <= ${nowSql} THEN 2 WHEN l."startsAt" > ${nowSql} THEN 1 ELSE 0 END ASC,
          CASE WHEN l."endsAt" <= ${nowSql} THEN NULL WHEN l."startsAt" > ${nowSql} THEN l."startsAt" ELSE l."endsAt" END ASC,
          l."endsAt" DESC`;
    }

    const [countRows, idRows] = await Promise.all([
      this.prisma.$queryRaw<{ total: number }[]>`SELECT COUNT(*)::int AS total FROM "Lot" l WHERE ${where}`,
      this.prisma.$queryRaw<{ id: string }[]>`
        SELECT l.id FROM "Lot" l WHERE ${where}
        ORDER BY ${orderBy}, l.id ASC
        LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    ]);

    const ids = idRows.map((r) => r.id);
    const lots = ids.length
      ? await this.prisma.lot.findMany({ where: { id: { in: ids } }, include: { auctioneer: { select: { name: true } } } })
      : [];
    const byId = new Map(lots.map((l) => [l.id, l]));

    return {
      items: ids.map((id) => byId.get(id)).filter((l): l is LotWithAuctioneer => !!l).map((l) => toLotSummary(l, now)),
      total: countRows[0]?.total ?? 0,
      page,
      pageSize,
      serverTime: now.toISOString(),
    };
  }

  // ---------------------------------------------------------------- detalhe

  /** LotDetail (contrato). Cancelado só é visível para o leiloeiro dono. */
  async findDetail(id: string, viewer?: AuthUser | null): Promise<LotDetail> {
    const lot = await this.prisma.lot.findUnique({
      where: { id },
      include: { auctioneer: { select: { name: true } } },
    });
    if (!lot) throw new AppError('LOT_NOT_FOUND');
    const isOwner = !!viewer && viewer.role === 'AUCTIONEER' && viewer.id === lot.auctioneerId;
    if (lot.cancelledAt && !isOwner) throw new AppError('LOT_NOT_FOUND');

    const bids = await this.prisma.bid.findMany({
      where: { lotId: id },
      orderBy: { sequence: 'desc' },
      take: DETAIL_BIDS,
    });

    const now = this.clock.now();
    const summary = toLotSummary(lot, now);
    return {
      ...summary,
      description: lot.description,
      bids: bids.map(toPublicBid),
      viewer: viewer ? await this.viewerBlock(lot, viewer, summary.phase, isOwner) : null,
    };
  }

  private async viewerBlock(lot: Lot, viewer: AuthUser, phase: LotPhase, isOwner: boolean): Promise<LotViewer> {
    if (viewer.role !== 'BIDDER') {
      return { role: viewer.role, alias: null, isLeader: false, myHighestBidCents: null, position: null, canBid: false, isOwner };
    }
    // Maior lance de cada licitante; como todo lance supera o anterior, não há empates.
    const ranking = await this.prisma.bid.groupBy({
      by: ['bidderId'],
      where: { lotId: lot.id },
      _max: { amountCents: true },
      orderBy: { _max: { amountCents: 'desc' } },
    });
    const idx = ranking.findIndex((r) => r.bidderId === viewer.id);
    const isLeader = lot.leaderId === viewer.id;
    return {
      role: viewer.role,
      alias: bidderAlias(lot.id, viewer.id),
      isLeader,
      myHighestBidCents: idx >= 0 ? ranking[idx]._max.amountCents ?? null : null,
      position: idx >= 0 ? idx + 1 : null,
      // Quem também é o leiloeiro deste lote (perfil de comprador ativo) não pode dar lance nele.
      canBid: phase === 'LIVE' && !isLeader && viewer.id !== lot.auctioneerId,
      isOwner: false,
    };
  }

  /** Histórico paginado (mais recentes primeiro). `cursor` = sequence do último item recebido. */
  async listBids(id: string, dto: ListBidsDto) {
    const lot = await this.prisma.lot.findUnique({ where: { id }, select: { cancelledAt: true } });
    if (!lot || lot.cancelledAt) throw new AppError('LOT_NOT_FOUND');
    const limit = dto.limit ?? 50;
    const bids = await this.prisma.bid.findMany({
      where: { lotId: id, ...(dto.cursor ? { sequence: { lt: dto.cursor } } : {}) },
      orderBy: { sequence: 'desc' },
      take: limit,
    });
    const last = bids[bids.length - 1];
    return {
      items: bids.map(toPublicBid),
      nextCursor: bids.length === limit && last && last.sequence > 1 ? last.sequence : null,
    };
  }

  // ---------------------------------------------------------------- painel do leiloeiro

  async listForAuctioneer(user: AuthUser) {
    const lots = await this.prisma.lot.findMany({
      where: { auctioneerId: user.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      include: { auctioneer: { select: { name: true } } },
    });
    const received = await this.receivedByLot(user.id, lots.map((l) => l.id));
    const now = this.clock.now();
    const items = lots.map((l) => this.toAuctioneerView(l, now, received.get(l.id)));

    const totals = { soldCount: 0, unsoldCount: 0, liveCount: 0, scheduledCount: 0, totalReceivedCents: 0 };
    for (const it of items) {
      if (it.result === 'SOLD') totals.soldCount++;
      if (it.result === 'UNSOLD') totals.unsoldCount++;
      if (it.phase === 'LIVE') totals.liveCount++;
      if (it.phase === 'SCHEDULED') totals.scheduledCount++;
      totals.totalReceivedCents += it.receivedCents;
    }
    return { items, totals };
  }

  private toAuctioneerView(lot: LotWithAuctioneer, now: Date, receivedFromLedger?: number): AuctioneerLotView {
    const summary = toLotSummary(lot, now);
    const result = lotResult(lot, summary.phase);
    return {
      ...summary,
      cancelledAt: lot.cancelledAt?.toISOString() ?? null,
      cancelReason: lot.cancelReason,
      result,
      // Valor efetivamente creditado (extrato); se faltar, usa o preço final do arremate.
      receivedCents: result === 'SOLD' ? receivedFromLedger ?? lot.finalPriceCents ?? 0 : 0,
      canCancel: summary.phase === 'SCHEDULED' || summary.phase === 'LIVE',
    };
  }

  /** Soma dos SETTLEMENT_CREDIT na carteira do leiloeiro, por lote. */
  private async receivedByLot(auctioneerId: string, lotIds: string[]) {
    const out = new Map<string, number>();
    if (!lotIds.length) return out;
    const rows = await this.prisma.ledgerEntry.groupBy({
      by: ['lotId'],
      where: { type: 'SETTLEMENT_CREDIT', lotId: { in: lotIds }, wallet: { userId: auctioneerId } },
      _sum: { amountCents: true },
    });
    for (const r of rows) if (r.lotId) out.set(r.lotId, r._sum.amountCents ?? 0);
    return out;
  }

  // ---------------------------------------------------------------- cancelamento

  async cancel(user: AuthUser, id: string, reason?: string): Promise<AuctioneerLotView> {
    // Retry só em erro transitório de banco (deadlock/serialização): a transação é desfeita por inteiro.
    const { lot, releasedTo } = await withTxRetry(() =>
      this.prisma.$transaction(async (tx) => {
        // Lock do lote: serializa com lances e com a liquidação.
        if (!(await lockLot(tx, id))) throw new AppError('LOT_NOT_FOUND');
        const current = await tx.lot.findUniqueOrThrow({ where: { id } });
        if (current.auctioneerId !== user.id) throw new AppError('NOT_LOT_OWNER');

        // Fase avaliada DEPOIS do lock, com o relógio de agora.
        const now = this.clock.now();
        const phase = lotPhase(current, now);
        if (phase !== 'SCHEDULED' && phase !== 'LIVE') throw new AppError('CANNOT_CANCEL', { phase });

        // Estorno: o valor comprometido do líder volta ao disponível (lançamento
        // encadeado no extrato, com o head da cadeia do lote no instante do cancelamento).
        let releasedTo: string | null = null;
        if (current.leaderId && current.currentPriceCents) {
          const w = (await lockWallets(tx, [current.leaderId])).get(current.leaderId);
          if (!w) throw new Error(`Carteira do líder ${current.leaderId} não encontrada (lote ${id})`);
          await appendLedger(tx, w, [
            {
              type: 'RELEASE',
              amountCents: current.currentPriceCents,
              lotId: id,
              bidHash: current.headHash,
              description: 'Estorno: lote cancelado',
              createdAt: now,
            },
          ]);
          releasedTo = current.leaderId;
        }

        // Cancelamento assinado: amarra a data ao estado da cadeia (nº de lances + head).
        const lot = await tx.lot.update({
          where: { id },
          data: {
            cancelledAt: now,
            cancelReason: reason ?? null,
            leaderId: null,
            cancelSignature: signCancel(id, now, current.bidCount, current.headHash),
          },
          include: { auctioneer: { select: { name: true } } },
        });
        return { lot, releasedTo };
      }, TX_OPTIONS),
    );

    // Eventos só depois do commit.
    const now = this.clock.now();
    this.realtime.lotState(toLotLiveState(lot, now));
    if (releasedTo) {
      const w = await this.prisma.wallet.findUnique({ where: { userId: releasedTo } });
      if (w) this.realtime.wallet(releasedTo, toWalletView(w));
    }
    return this.toAuctioneerView(lot, now);
  }
}
