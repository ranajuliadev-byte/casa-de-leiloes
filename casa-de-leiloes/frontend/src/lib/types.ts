// Tipos espelhados de docs/CONTRATO.md — não adicione campos que não estão no contrato.

export type Role = 'AUCTIONEER' | 'BIDDER';
export type LotPhase = 'SCHEDULED' | 'LIVE' | 'ENDED' | 'CANCELLED';

export interface UserView {
  id: string;
  name: string;
  email: string;
  role: Role;
}

export interface WalletView {
  balanceCents: number;
  committedCents: number;
  availableCents: number;
}

export type LedgerEntryType = 'DEPOSIT' | 'COMMIT' | 'RELEASE' | 'SETTLEMENT_DEBIT' | 'SETTLEMENT_CREDIT';

export interface LedgerEntryView {
  id: string;
  type: LedgerEntryType;
  amountCents: number;
  lotId: string | null;
  lotTitle: string | null;
  description: string | null;
  createdAt: string;
}

export interface ArtworkView {
  id: string;
  externalId: number;
  title: string;
  artist: string | null;
  dateLabel: string | null;
  medium: string | null;
  dimensions: string | null;
  origin: string | null;
  imageUrl: string | null;
  thumbUrl: string | null;
}

export interface LotAttributes {
  artist: string | null;
  date: string | null;
  medium: string | null;
  dimensions: string | null;
  origin: string | null;
  source: 'aic';
  externalId: number | null;
}

export interface LotLiveState {
  lotId: string;
  phase: LotPhase;
  currentPriceCents: number | null;
  bidCount: number;
  leaderAlias: string | null;
  minNextBidCents: number;
  startsAt: string;
  endsAt: string;
  extended: boolean;
  settled: boolean;
  winnerAlias: string | null;
  finalPriceCents: number | null;
  serverTime: string;
}

export interface LotSummary extends LotLiveState {
  id: string;
  title: string;
  imageUrl: string | null;
  attributes: LotAttributes;
  startingPriceCents: number;
  minIncrementCents: number;
  originalEndsAt: string;
  auctioneerName: string;
}

export interface PublicBid {
  id: string;
  lotId: string;
  sequence: number;
  amountCents: number;
  bidderAlias: string;
  createdAt: string;
  hash: string;
}

export interface LotViewer {
  role: Role;
  alias: string | null;
  isLeader: boolean;
  myHighestBidCents: number | null;
  position: number | null;
  canBid: boolean;
  isOwner: boolean;
}

export interface LotDetail extends LotSummary {
  description: string | null;
  bids: PublicBid[];
  viewer: LotViewer | null;
}

export interface AuctioneerLotView extends LotSummary {
  cancelledAt: string | null;
  cancelReason: string | null;
  result: 'PENDING' | 'SOLD' | 'UNSOLD' | 'CANCELLED';
  receivedCents: number;
  canCancel: boolean;
}

export interface AuctioneerTotals {
  soldCount: number;
  unsoldCount: number;
  liveCount: number;
  scheduledCount: number;
  totalReceivedCents: number;
}

export type MyLotStatus = 'WINNING' | 'OUTBID' | 'WON' | 'LOST' | 'CANCELLED' | 'AWAITING_SETTLEMENT';

export interface MyLotView {
  lot: LotSummary;
  myHighestBidCents: number;
  myBidCount: number;
  alias: string;
  status: MyLotStatus;
  receipt: null | { code: string; url: string; amountCents: number; issuedAt: string };
}

export interface AuditBid extends PublicBid {
  prevHash: string;
  signature: string;
  payload: string;
  checks: { hashOk: boolean; linkOk: boolean; signatureOk: boolean; sequenceOk: boolean; aliasOk: boolean };
}

export interface AuditReport {
  lot: {
    id: string;
    title: string;
    imageUrl: string | null;
    startingPriceCents: number;
    minIncrementCents: number;
    startsAt: string;
    originalEndsAt: string;
    endsAt: string;
    phase: LotPhase;
    cancelled: boolean;
    settled: boolean;
    bidCount: number;
    headHash: string;
    headSignature: string;
    genesisHash: string;
    /** Assinatura Ed25519 do cancelamento (null se o lote não foi cancelado). Opcional até o back publicar o campo. */
    cancelSignature?: string | null;
  };
  genesisPayload: string;
  bids: AuditBid[];
  verification: {
    status: 'INTACT' | 'TAMPERED';
    checkedAt: string;
    /**
     * Códigos conhecidos: GENESIS_*, HASH_MISMATCH, LINK_BROKEN, SIGNATURE_INVALID, HEAD_*, LEDGER_MISMATCH,
     * END_MISMATCH, BID_OUTSIDE_WINDOW, CANCEL_SIGNATURE_INVALID… A UI exibe qualquer código pela `message`.
     */
    issues: Array<{ code: string; message: string; sequence?: number }>;
    summary: {
      genesisOk: boolean;
      headOk: boolean;
      chainOk: boolean;
      signaturesOk: boolean;
      countOk: boolean;
      priceOk: boolean;
      timingOk?: boolean; // horários dos lances e fim (anti-sniping) coerentes
      cancelOk?: boolean; // cancelamento assinado (ou ausência dele) coerente
      ledgerOk?: boolean; // extrato das carteiras bate com a cadeia
    };
  };
  publicKey: { algorithm: 'Ed25519'; publicKeyRawBase64: string };
}

export interface ReceiptView {
  code: string;
  url: string;
  lot: { id: string; title: string; imageUrl: string | null; attributes: LotAttributes; auctioneerName: string };
  winnerAlias: string;
  amountCents: number;
  bidCount: number;
  chainHead: string;
  issuedAt: string;
  signature: string;
  valid: boolean;
  auditUrl: string;
}

// ---- Respostas REST ----
export interface AuthResponse {
  accessToken: string;
  user: UserView;
}
export interface MeResponse {
  user: UserView;
  wallet: WalletView | null;
}
export interface WalletResponse {
  wallet: WalletView;
  entries: LedgerEntryView[];
}
export interface LotListResponse {
  items: LotSummary[];
  total: number;
  page: number;
  pageSize: number;
  serverTime: string;
}
export interface ArtworkSearchResponse {
  items: ArtworkView[];
  page: number;
  totalPages: number;
  source: 'live' | 'cache';
  degraded: boolean;
}
export interface PlaceBidResponse {
  bid: PublicBid;
  state: LotLiveState;
  wallet: WalletView;
}
export interface AuctioneerLotsResponse {
  items: AuctioneerLotView[];
  totals: AuctioneerTotals;
}

// ---- Eventos WebSocket ----
export interface OutbidEvent {
  lotId: string;
  title: string;
  newPriceCents: number;
  yourAmountCents: number;
}
export interface WonEvent {
  lotId: string;
  title: string;
  amountCents: number;
  receiptCode: string;
}

export type LotSort = 'ending' | 'newest' | 'price_asc' | 'price_desc';
