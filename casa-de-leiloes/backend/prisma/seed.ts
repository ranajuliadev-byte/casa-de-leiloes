/**
 * Seed de demonstração da Casa de Leilões.
 *
 *   npm run db:seed              → APAGA todos os dados e recria a demonstração (idempotente)
 *   npm run db:seed -- --if-empty → só semeia se o banco não tiver nenhum usuário (usado no Docker)
 *
 * Os lances são gerados com os MESMOS helpers de cripto do app (genesis, sealBid,
 * signHead, signCancel, bidderAlias, signReceipt) e o extrato com o mesmo
 * `appendLedger` (lançamentos encadeados + head da carteira assinado), formando
 * cadeias válidas: a auditoria de todos os lotes semeados dá ÍNTEGRO — inclusive o
 * cruzamento extrato × lances (saldo comprometido = lances em que o licitante lidera).
 *
 * Datas são relativas ao momento em que o seed roda. Rode de novo para "rebobinar"
 * a demonstração (por exemplo, depois que o lote de 10 minutos encerrar).
 */
import 'dotenv/config';
import { randomBytes, randomUUID } from 'crypto';
import * as bcrypt from 'bcryptjs';
import { Prisma, PrismaClient, Role } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  bidderAlias,
  genesisHash,
  sealBid,
  signCancel,
  signHead,
  signReceipt,
} from '../src/common/crypto/audit-crypto';
import { appendLedger, LedgerOp } from '../src/common/ledger';
import { AicArtwork, AicClient } from '../src/artworks/aic.client';
import { fromAic } from '../src/artworks/aic.mapper';
import { WikimediaImages } from '../src/artworks/wikimedia.client';
import { ANTI_SNIPING_WINDOW_MS } from '../src/common/clock';
import { BCRYPT_COST } from '../src/auth/password';

// ---------------------------------------------------------------- constantes

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const BRL = (reais: number) => Math.round(reais * 100); // reais → centavos

export const SEED_PASSWORD = 'leilao123';
export const SEED_USERS = {
  auctioneer: { name: 'Galeria Aurora', email: 'leiloeiro@leilao.dev', roles: ['AUCTIONEER'] as Role[] },
  // Ana tem os dois perfis (mesmo e-mail e senha): entra como compradora ou como leiloeira.
  ana: { name: 'Ana Souza', email: 'ana@leilao.dev', roles: ['BIDDER', 'AUCTIONEER'] as Role[] },
  bruno: { name: 'Bruno Lima', email: 'bruno@leilao.dev', roles: ['BIDDER'] as Role[] },
};
export const SEED_DEPOSIT_CENTS = BRL(50_000);

// ---------------------------------------------------------------- obras

/**
 * Snapshot embutido (usado se a API do Art Institute of Chicago não responder em 5 s).
 * Obras famosas de domínio público do acervo do AIC. Com internet, os dados (inclusive
 * `image_id`) são substituídos pelos da API; sem internet, se algum `image_id` estiver
 * desatualizado (o AIC às vezes troca a imagem principal de uma obra), o front mostra
 * um placeholder no lugar da imagem — vitrine, sala, auditoria e comprovante seguem
 * funcionando. Os `image_id` de "Two Sisters" e "Stacks of Wheat" não foram conferidos
 * offline; os demais são os publicados pelo AIC.
 */
export const ARTWORK_SNAPSHOT: AicArtwork[] = [
  {
    id: 27992,
    title: 'A Sunday on La Grande Jatte — 1884',
    artist_display: 'Georges Seurat\nFrench, 1859–1891',
    date_display: '1884–86',
    medium_display: 'Oil on canvas',
    dimensions: '207.5 × 308.1 cm (81 3/4 × 121 1/4 in.)',
    image_id: '2d484387-2509-5e8e-2c43-22f9981972eb',
    place_of_origin: 'France',
  },
  {
    id: 28560,
    title: 'The Bedroom',
    artist_display: 'Vincent van Gogh\nDutch, 1853–1890',
    date_display: '1889',
    medium_display: 'Oil on canvas',
    dimensions: '73.6 × 92.3 cm (29 × 36 5/8 in.)',
    image_id: '25c31d8d-21a4-9ea1-1d73-6a2eca4dda7e',
    place_of_origin: 'France',
  },
  {
    id: 16568,
    title: 'Water Lilies',
    artist_display: 'Claude Monet\nFrench, 1840–1926',
    date_display: '1906',
    medium_display: 'Oil on canvas',
    dimensions: '89.9 × 94.1 cm (35 3/8 × 37 1/16 in.)',
    image_id: '3c27b499-af56-f0d5-93b5-a7f2f1ad5813',
    place_of_origin: 'France',
  },
  {
    id: 20684,
    title: 'Paris Street; Rainy Day',
    artist_display: 'Gustave Caillebotte\nFrench, 1848–1894',
    date_display: '1877',
    medium_display: 'Oil on canvas',
    dimensions: '212.2 × 276.2 cm (83 1/2 × 108 3/4 in.)',
    image_id: 'f8fd76e9-c396-5678-36ed-6a348c904d27',
    place_of_origin: 'France',
  },
  {
    id: 6565,
    title: 'American Gothic',
    artist_display: 'Grant Wood\nAmerican, 1891–1942',
    date_display: '1930',
    medium_display: 'Oil on beaverboard',
    dimensions: '78 × 65.3 cm (30 3/4 × 25 3/4 in.)',
    image_id: 'b272df73-a965-ac37-4172-be4e99483637',
    place_of_origin: 'United States',
  },
  {
    id: 14655,
    title: 'Two Sisters (On the Terrace)',
    artist_display: 'Pierre-Auguste Renoir\nFrench, 1841–1919',
    date_display: '1881',
    medium_display: 'Oil on canvas',
    dimensions: '100.5 × 81 cm (39 5/8 × 31 7/8 in.)',
    image_id: 'b6c0a5d5-0b46-2d4c-0e7b-0d1e3c7e2e1f',
    place_of_origin: 'France',
  },
  {
    id: 64818,
    title: 'Stacks of Wheat (End of Summer)',
    artist_display: 'Claude Monet\nFrench, 1840–1926',
    date_display: '1890–91',
    medium_display: 'Oil on canvas',
    dimensions: '60 × 100 cm (23 5/8 × 39 3/8 in.)',
    image_id: '4a5d6b5e-7d0d-9f25-1d8b-4d4e8f5b3b72',
    place_of_origin: 'France',
  },
  {
    id: 24645,
    title: 'Under the Wave off Kanagawa (Kanagawa oki nami ura), also known as The Great Wave',
    artist_display: 'Katsushika Hokusai\nJapanese, 1760-1849',
    date_display: '1830/33',
    medium_display: 'Color woodblock print; oban',
    dimensions: '25.4 × 37.6 cm (10 × 14 3/4 in.)',
    image_id: 'b3974542-b9b4-7568-fc4b-966738f61d78',
    place_of_origin: 'Japan',
  },
];

/** Tenta buscar as obras reais na API (mesmo cliente do app, timeout de 5 s). Devolve null se falhar. */
async function fetchFromAic(ids: number[]): Promise<Map<number, AicArtwork> | null> {
  try {
    const out = new Map<number, AicArtwork>();
    for (const a of await new AicClient().getMany(ids)) if (a && typeof a.id === 'number' && a.image_id) out.set(a.id, a);
    return out;
  } catch (e) {
    console.warn(`  ! API do AIC indisponível (${(e as Error).message}); usando snapshot embutido.`);
    return null;
  }
}

/** Mesmo mapeamento do app (artworks.service), com a data da busca. */
function toArtworkRow(a: AicArtwork, fetchedAt: Date, commonsFile?: string): Prisma.ArtworkCreateInput {
  return { ...fromAic(a, commonsFile), fetchedAt };
}

// ---------------------------------------------------------------- simulação do motor

type Tx = Prisma.TransactionClient;

interface SeedUser {
  id: string;
  walletId: string;
}

interface LotSpec {
  key: string;
  artworkId: number;
  description: string;
  startingPriceCents: number;
  minIncrementCents: number;
  startsAt: Date;
  originalEndsAt: Date;
  /** [quem, valor, quando] em ordem cronológica */
  bids?: Array<[SeedUser, number, Date]>;
  /** liquida (com vencedor = último lance, ou sem vencedor se não houver lances) */
  settleAt?: Date;
  /** cancela (com estorno do líder, se houver) */
  cancelAt?: Date;
  cancelReason?: string;
  createdAt: Date;
}

/**
 * Lançamentos acumulados por carteira, gravados no FIM com `appendLedger` (mesmo
 * caminho do app: encadeados por carteira, em ordem cronológica, head assinado).
 * O saldo em memória serve para validar o cenário (saldo suficiente etc.).
 */
interface WalletState {
  walletId: string;
  balanceCents: number;
  committedCents: number;
  ops: LedgerOp[];
}

export interface SeedResult {
  lots: Record<string, string>; // chave → id
  receiptCode: string;
  artworkSource: 'live' | 'snapshot';
}

function ledger(w: WalletState, op: LedgerOp) {
  w.ops.push(op);
}

/**
 * Cria um lote reproduzindo exatamente o que o app faria: genesis + head assinado,
 * lances encadeados (com COMMIT/RELEASE no extrato e anti-sniping), liquidação ou
 * cancelamento. Atualiza `wallets` em memória; os saldos são gravados no fim.
 */
async function createLot(
  tx: Tx,
  auctioneer: SeedUser,
  artwork: Prisma.ArtworkCreateInput,
  spec: LotSpec,
  wallets: Map<string, WalletState>,
): Promise<{ id: string; receiptCode: string | null }> {
  const id = randomUUID();
  const title = artwork.title;
  const imageUrl = artwork.imageUrl ?? null;
  const attributes = {
    artist: artwork.artist ?? null,
    date: artwork.dateLabel ?? null,
    medium: artwork.medium ?? null,
    dimensions: artwork.dimensions ?? null,
    origin: artwork.origin ?? null,
    source: 'aic',
    externalId: artwork.externalId,
  };
  const genesis = genesisHash({
    lotId: id,
    auctioneerId: auctioneer.id,
    title,
    description: spec.description,
    imageUrl,
    attributes,
    startingPriceCents: spec.startingPriceCents,
    minIncrementCents: spec.minIncrementCents,
    startsAt: spec.startsAt,
    originalEndsAt: spec.originalEndsAt,
  });

  await tx.lot.create({
    data: {
      id,
      auctioneerId: auctioneer.id,
      artworkId: artwork.id,
      title,
      description: spec.description,
      imageUrl,
      attributes,
      startingPriceCents: spec.startingPriceCents,
      minIncrementCents: spec.minIncrementCents,
      startsAt: spec.startsAt,
      endsAt: spec.originalEndsAt,
      originalEndsAt: spec.originalEndsAt,
      genesisHash: genesis,
      headHash: genesis,
      headSignature: signHead(id, 0, genesis),
      createdAt: spec.createdAt,
    },
  });

  // ----- lances (mesmas regras do BidsService) -----
  let head = genesis;
  let price: number | null = null;
  let leader: SeedUser | null = null;
  let endsAt = spec.originalEndsAt;
  let seq = 0;
  for (const [user, amount, at] of spec.bids ?? []) {
    const minimum = price == null ? spec.startingPriceCents : price + spec.minIncrementCents;
    if (amount < minimum) throw new Error(`Seed inválido (${spec.key}): lance ${amount} < mínimo ${minimum}`);
    if (leader?.id === user.id) throw new Error(`Seed inválido (${spec.key}): líder cobrindo o próprio lance`);
    if (at < spec.startsAt || at >= endsAt) throw new Error(`Seed inválido (${spec.key}): lance fora do horário`);
    const w = wallets.get(user.id)!;
    if (amount > w.balanceCents - w.committedCents) throw new Error(`Seed inválido (${spec.key}): saldo insuficiente`);

    seq++;
    const alias = bidderAlias(id, user.id);
    const { hash, signature } = sealBid({ lotId: id, sequence: seq, bidderAlias: alias, amountCents: amount, createdAt: at, prevHash: head });

    // compromete o novo líder e libera o anterior (ambos com o hash deste lance)
    w.committedCents += amount;
    ledger(w, { type: 'COMMIT', amountCents: amount, lotId: id, bidHash: hash, description: 'Lance comprometido', createdAt: at });
    if (leader && price != null) {
      const lw = wallets.get(leader.id)!;
      lw.committedCents -= price;
      ledger(lw, { type: 'RELEASE', amountCents: price, lotId: id, bidHash: hash, description: 'Lance superado', createdAt: at });
    }

    await tx.bid.create({
      data: { lotId: id, bidderId: user.id, sequence: seq, amountCents: amount, bidderAlias: alias, createdAt: at, prevHash: head, hash, signature },
    });
    head = hash;
    price = amount;
    leader = user;
    // anti-sniping: lance nos últimos 2 min empurra o fim para agora + 2 min
    if (endsAt.getTime() - at.getTime() <= ANTI_SNIPING_WINDOW_MS) endsAt = new Date(at.getTime() + ANTI_SNIPING_WINDOW_MS);
  }

  await tx.lot.update({
    where: { id },
    data: {
      currentPriceCents: price,
      bidCount: seq,
      leaderId: leader?.id ?? null,
      endsAt,
      headHash: head,
      headSignature: signHead(id, seq, head),
    },
  });

  // ----- cancelamento com estorno (mantém bidCount/preço/head; só limpa o líder) -----
  if (spec.cancelAt) {
    if (spec.cancelAt < spec.createdAt || spec.cancelAt >= endsAt) throw new Error(`Seed inválido (${spec.key}): cancelamento fora do pregão`);
    if (leader && price != null) {
      const lw = wallets.get(leader.id)!;
      lw.committedCents -= price;
      ledger(lw, { type: 'RELEASE', amountCents: price, lotId: id, bidHash: head, description: 'Estorno: lote cancelado', createdAt: spec.cancelAt });
    }
    await tx.lot.update({
      where: { id },
      data: {
        cancelledAt: spec.cancelAt,
        cancelReason: spec.cancelReason ?? null,
        leaderId: null,
        cancelSignature: signCancel(id, spec.cancelAt, seq, head),
      },
    });
    return { id, receiptCode: null };
  }

  // ----- liquidação (mesmas regras do SettlementService) -----
  if (spec.settleAt) {
    if (spec.settleAt < endsAt) throw new Error(`Seed inválido (${spec.key}): liquidação antes do fim`);
    if (!leader || price == null) {
      await tx.lot.update({ where: { id }, data: { settledAt: spec.settleAt } });
      return { id, receiptCode: null };
    }
    const winner = wallets.get(leader.id)!;
    winner.balanceCents -= price;
    winner.committedCents -= price;
    ledger(winner, { type: 'SETTLEMENT_DEBIT', amountCents: price, lotId: id, bidHash: head, description: `Arremate: ${title}`, createdAt: spec.settleAt });
    const aw = wallets.get(auctioneer.id)!;
    aw.balanceCents += price;
    ledger(aw, { type: 'SETTLEMENT_CREDIT', amountCents: price, lotId: id, bidHash: head, description: `Venda: ${title}`, createdAt: spec.settleAt });

    const code = randomBytes(9).toString('base64url');
    const winnerAlias = bidderAlias(id, leader.id);
    const signature = signReceipt({ code, lotId: id, winnerAlias, amountCents: price, bidCount: seq, chainHead: head, issuedAt: spec.settleAt });
    await tx.receipt.create({
      data: { code, lotId: id, winnerId: leader.id, winnerAlias, amountCents: price, bidCount: seq, chainHead: head, issuedAt: spec.settleAt, signature },
    });
    await tx.lot.update({ where: { id }, data: { settledAt: spec.settleAt, winnerId: leader.id, finalPriceCents: price } });
    return { id, receiptCode: code };
  }

  return { id, receiptCode: null };
}

// ---------------------------------------------------------------- seed

export interface SeedOptions {
  /** não tenta a API externa (testes) */
  offline?: boolean;
  /** "agora" de referência (testes) */
  now?: Date;
}

export async function runSeed(prisma: PrismaClient, opts: SeedOptions = {}): Promise<SeedResult> {
  const now = opts.now ?? new Date();
  const at = (ms: number) => new Date(now.getTime() + ms);

  // Obras: API real (se responder) com fallback no snapshot embutido.
  const ids = ARTWORK_SNAPSHOT.map((a) => a.id);
  const live = opts.offline ? null : await fetchFromAic(ids);
  // Imagens pelo Wikimedia Commons (o IIIF do AIC bloqueia <img> com desafio anti-bot).
  const files = opts.offline ? new Map<number, string>() : await new WikimediaImages().filesFor(ids);
  const artworks = ARTWORK_SNAPSHOT.map((snap) => toArtworkRow(live?.get(snap.id) ?? snap, now, files.get(snap.id)));
  const artworkSource: SeedResult['artworkSource'] = live && live.size > 0 ? 'live' : 'snapshot';
  const art = (externalId: number) => artworks.find((a) => a.externalId === externalId)!;

  const passwordHash = await bcrypt.hash(SEED_PASSWORD, BCRYPT_COST);

  return prisma.$transaction(
    async (tx) => {
      // Idempotente: apaga tudo e recria.
      await tx.$executeRawUnsafe(
        'TRUNCATE TABLE "Receipt", "Bid", "LedgerEntry", "Lot", "Wallet", "Artwork", "User" RESTART IDENTITY CASCADE',
      );

      for (const a of artworks) await tx.artwork.create({ data: a });

      const wallets = new Map<string, WalletState>();
      const mkUser = async (u: { name: string; email: string; roles: Role[] }, depositCents: number): Promise<SeedUser> => {
        const created = await tx.user.create({
          data: { name: u.name, email: u.email, roles: u.roles, passwordHash, createdAt: at(-30 * DAY), wallet: { create: {} } },
          include: { wallet: true },
        });
        const su = { id: created.id, walletId: created.wallet!.id };
        const w: WalletState = { walletId: su.walletId, balanceCents: depositCents, committedCents: 0, ops: [] };
        wallets.set(su.id, w);
        if (depositCents > 0) ledger(w, { type: 'DEPOSIT', amountCents: depositCents, description: 'Depósito simulado', createdAt: at(-10 * DAY) });
        return su;
      };
      const auctioneer = await mkUser(SEED_USERS.auctioneer, 0);
      const ana = await mkUser(SEED_USERS.ana, SEED_DEPOSIT_CENTS);
      const bruno = await mkUser(SEED_USERS.bruno, SEED_DEPOSIT_CENTS);

      const specs: LotSpec[] = [
        // 1) AO VIVO, lances alternados — Ana lidera. Termina em 14 dias.
        {
          key: 'liveAna',
          artworkId: 27992,
          description: 'Estudo pontilhista monumental de uma tarde de domingo às margens do Sena. Lote de demonstração com lances abertos.',
          startingPriceCents: BRL(5_000),
          minIncrementCents: BRL(500),
          startsAt: at(-2 * DAY),
          originalEndsAt: at(14 * DAY),
          createdAt: at(-2 * DAY - HOUR),
          bids: [
            [ana, BRL(5_000), at(-47 * HOUR)],
            [bruno, BRL(5_500), at(-30 * HOUR)],
            [ana, BRL(6_500), at(-20 * HOUR)],
            [bruno, BRL(7_000), at(-6 * HOUR)],
            [ana, BRL(8_000), at(-45 * MIN)],
          ],
        },
        // 2) AO VIVO, lances alternados — Bruno lidera. Termina em 14 dias (+3 h).
        {
          key: 'liveBruno',
          artworkId: 28560,
          description: 'O quarto do artista em Arles, em cores puras e perspectiva inclinada. Lote de demonstração com lances abertos.',
          startingPriceCents: BRL(8_000),
          minIncrementCents: BRL(1_000),
          startsAt: at(-1 * DAY),
          originalEndsAt: at(14 * DAY + 3 * HOUR),
          createdAt: at(-1 * DAY - HOUR),
          bids: [
            [bruno, BRL(8_000), at(-22 * HOUR)],
            [ana, BRL(9_000), at(-10 * HOUR)],
            [bruno, BRL(10_500), at(-2 * HOUR)],
          ],
        },
        // 3) AO VIVO terminando em ~10 min, SEM lances — para testar o anti-sniping.
        {
          key: 'liveEndingSoon',
          artworkId: 6565,
          description: 'Lote relâmpago: termina cerca de 10 minutos após o seed. Dê um lance nos últimos 2 minutos e veja o fim ser prorrogado.',
          startingPriceCents: BRL(2_500),
          minIncrementCents: BRL(250),
          startsAt: at(-1 * HOUR),
          originalEndsAt: at(10 * MIN),
          createdAt: at(-1 * HOUR - 5 * MIN),
        },
        // 4) AGENDADO: começa em 1 h.
        {
          key: 'scheduled1h',
          artworkId: 24645,
          description: 'Pregão agendado: abre 1 hora após o seed.',
          startingPriceCents: BRL(6_000),
          minIncrementCents: BRL(500),
          startsAt: at(1 * HOUR),
          originalEndsAt: at(3 * DAY),
          createdAt: at(-3 * HOUR),
        },
        // 5) AGENDADO: começa em 1 dia.
        {
          key: 'scheduled1d',
          artworkId: 20684,
          description: 'Pregão agendado: abre 1 dia após o seed.',
          startingPriceCents: BRL(7_500),
          minIncrementCents: BRL(500),
          startsAt: at(1 * DAY),
          originalEndsAt: at(8 * DAY),
          createdAt: at(-2 * HOUR),
        },
        // 6) ENCERRADO e LIQUIDADO: Ana arremata (último lance no fim → prorrogado pelo anti-sniping).
        {
          key: 'settled',
          artworkId: 16568,
          description: 'Uma das ninfeias pintadas em Giverny. Lote encerrado e arrematado — com comprovante emitido.',
          startingPriceCents: BRL(3_000),
          minIncrementCents: BRL(250),
          startsAt: at(-8 * DAY),
          originalEndsAt: at(-1 * DAY),
          createdAt: at(-8 * DAY - HOUR),
          bids: [
            [bruno, BRL(3_000), at(-7 * DAY)],
            [ana, BRL(3_250), at(-5 * DAY)],
            [bruno, BRL(3_750), at(-2 * DAY)],
            [ana, BRL(4_200), at(-1 * DAY - 1 * MIN)], // a 1 min do fim → fim vira +2 min
          ],
          settleAt: at(-1 * DAY + 1 * MIN + 1_500),
        },
        // 7) ENCERRADO sem lances: fechado sem vencedor.
        {
          key: 'unsold',
          artworkId: 64818,
          description: 'Lote encerrado sem lances — fechado sem vencedor.',
          startingPriceCents: BRL(9_000),
          minIncrementCents: BRL(500),
          startsAt: at(-5 * DAY),
          originalEndsAt: at(-2 * DAY),
          createdAt: at(-5 * DAY - HOUR),
          settleAt: at(-2 * DAY + 1_500),
        },
        // 8) CANCELADO com lances: estorno automático do líder (Bruno). Não aparece na vitrine.
        {
          key: 'cancelled',
          artworkId: 14655,
          description: 'Lote cancelado pelo leiloeiro durante o pregão (o líder foi estornado).',
          startingPriceCents: BRL(2_000),
          minIncrementCents: BRL(200),
          startsAt: at(-3 * DAY),
          originalEndsAt: at(10 * DAY),
          createdAt: at(-3 * DAY - HOUR),
          bids: [
            [ana, BRL(2_000), at(-60 * HOUR)],
            [bruno, BRL(2_400), at(-50 * HOUR)],
          ],
          cancelAt: at(-1 * DAY),
          cancelReason: 'Obra retirada pelo comitente para nova avaliação.',
        },
      ];

      const lots: Record<string, string> = {};
      let receiptCode = '';
      for (const spec of specs) {
        const r = await createLot(tx, auctioneer, art(spec.artworkId), spec, wallets);
        lots[spec.key] = r.id;
        if (r.receiptCode) receiptCode = r.receiptCode;
      }

      // Grava o extrato de cada carteira em ordem cronológica, pelo mesmo caminho do app
      // (encadeado + head assinado). O saldo final sai do próprio extrato.
      for (const [userId, w] of wallets) {
        if (w.committedCents < 0 || w.committedCents > w.balanceCents) throw new Error('Seed inválido: carteira incoerente');
        const ops = w.ops.map((op, i) => ({ op, i })).sort((a, b) => a.op.createdAt.getTime() - b.op.createdAt.getTime() || a.i - b.i);
        const current = await tx.wallet.findUniqueOrThrow({ where: { id: w.walletId } });
        const saved = await appendLedger(tx, current, ops.map((x) => x.op));
        if (Number(saved.balanceCents) !== w.balanceCents || Number(saved.committedCents) !== w.committedCents) {
          throw new Error(`Seed inválido: extrato e saldo divergem (${userId})`);
        }
      }

      return { lots, receiptCode, artworkSource };
    },
    { maxWait: 15_000, timeout: 60_000 },
  );
}

// ---------------------------------------------------------------- CLI

async function main() {
  const ifEmpty = process.argv.includes('--if-empty');
  // As contas de demonstração têm senha pública (leilao123): em produção, só com opt-in explícito.
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_SEED !== 'true') {
    console.log('Seed ignorado: NODE_ENV=production sem ALLOW_DEMO_SEED=true (contas de demonstração têm senha pública).');
    return;
  }
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL as string }) });
  try {
    if (ifEmpty && (await prisma.user.count()) > 0) {
      console.log('Seed ignorado: o banco já tem usuários (--if-empty).');
      return;
    }
    console.log('Semeando dados de demonstração (apaga os dados atuais)...');
    const r = await runSeed(prisma);
    const front = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
    console.log(`  Obras: ${r.artworkSource === 'live' ? 'API do Art Institute of Chicago' : 'snapshot embutido (API indisponível)'}`);
    console.log('');
    console.log('  Credenciais (senha de todos: leilao123)');
    console.log('    Leiloeiro  leiloeiro@leilao.dev');
    console.log('    Licitante  ana@leilao.dev    (saldo R$ 50.000,00; também tem o perfil de leiloeira)');
    console.log('    Licitante  bruno@leilao.dev  (saldo R$ 50.000,00)');
    console.log('');
    console.log(`  Lote ao vivo (Ana lidera):        ${front}/lotes/${r.lots.liveAna}`);
    console.log(`  Lote ao vivo (Bruno lidera):      ${front}/lotes/${r.lots.liveBruno}`);
    console.log(`  Lote que termina em ~10 min:      ${front}/lotes/${r.lots.liveEndingSoon}`);
    console.log(`  Auditoria do lote arrematado:     ${front}/auditoria/${r.lots.settled}`);
    console.log(`  Comprovante de arremate (Ana):    ${front}/comprovante/${r.receiptCode}`);
    console.log(`  Auditoria do lote cancelado:      ${front}/auditoria/${r.lots.cancelled}`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
