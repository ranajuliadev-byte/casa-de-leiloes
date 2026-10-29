import { Injectable } from '@nestjs/common';
import { Bid, LedgerEntry, Lot, Prisma, Wallet } from '@prisma/client';
import { ANTI_SNIPING_WINDOW_MS, Clock } from '../common/clock';
import {
  auditKeys,
  bidderAlias,
  bidHash,
  bidPayload,
  cancelPayload,
  GenesisInput,
  genesisHash,
  genesisPayload,
  headPayload,
  verifyText,
} from '../common/crypto/audit-crypto';
import { AppError } from '../common/errors';
import { formatBRL } from '../common/money';
import { verifyWalletLedger, WALLET_AGGREGATE_SQL, WalletAggregate, walletHealthProblems } from '../common/ledger';
import { TX_OPTIONS } from '../common/tx-options';
import { LotPhase, lotPhase } from '../common/lot-phase';
import { toPublicBid } from '../common/lot-view';
import { PrismaService } from '../prisma/prisma.service';
import { BrokenWallet, LedgerIntegrityService } from './ledger-integrity.service';
import { PublicBid } from '../realtime/realtime.gateway';

export interface BidChecks {
  hashOk: boolean;
  linkOk: boolean;
  signatureOk: boolean;
  sequenceOk: boolean;
  aliasOk: boolean;
}

export type AuditBid = PublicBid & { prevHash: string; signature: string; payload: string; checks: BidChecks };

export interface AuditIssue {
  code: string;
  message: string;
  sequence?: number;
}

export interface AuditSummary {
  genesisOk: boolean;
  headOk: boolean;
  chainOk: boolean;
  signaturesOk: boolean;
  countOk: boolean;
  priceOk: boolean;
  /** horários dos lances dentro da janela + fim vigente = fim recalculado pela cadeia */
  timingOk: boolean;
  /** cancelamento (ou ausência dele) com assinatura válida */
  cancelOk: boolean;
  /** extrato das carteiras íntegro e 1:1 com a cadeia de lances */
  ledgerOk: boolean;
}

export interface AuditVerification {
  status: 'INTACT' | 'TAMPERED';
  checkedAt: string;
  issues: AuditIssue[];
  summary: AuditSummary;
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
    cancelledAt: string | null;
    cancelSignature: string | null;
    /** texto exato assinado no cancelamento (null se não cancelado) */
    cancelPayload: string | null;
  };
  genesisPayload: string;
  bids: AuditBid[];
  verification: AuditVerification;
  publicKey: { algorithm: 'Ed25519'; publicKeyRawBase64: string };
}

/** Extrato relevante para cruzar com a cadeia de um lote (ver `loadLotAuditData`). */
export interface LotLedger {
  /** lançamentos com lotId = lote */
  entries: LedgerEntry[];
  /** carteiras dos participantes (licitantes, leiloeiro) e de quem tem lançamentos do lote */
  wallets: Wallet[];
  /** TODOS os lançamentos dessas carteiras (para verificar a cadeia de cada extrato) */
  walletEntries: LedgerEntry[];
  /** carteiras da plataforma inteira com extrato inconsistente (checagem agregada) */
  brokenWallets: BrokenWallet[];
}

export function genesisInputOf(lot: Lot): GenesisInput {
  return {
    lotId: lot.id,
    auctioneerId: lot.auctioneerId,
    title: lot.title,
    description: lot.description,
    imageUrl: lot.imageUrl,
    attributes: lot.attributes,
    startingPriceCents: lot.startingPriceCents,
    minIncrementCents: lot.minIncrementCents,
    startsAt: lot.startsAt,
    originalEndsAt: lot.originalEndsAt,
  };
}

/**
 * Verifica a cadeia de um lote a partir dos dados CRUS do banco — nada de flag
 * "válido" persistida. Função pura: recebe o lote, TODOS os seus lances e o extrato.
 *
 * O que é recalculado/verificado:
 *  - genesis: hash dos parâmetros imutáveis do lote (título, descrição, imagem,
 *    atributos, vendedor, preços, datas originais);
 *  - cada lance: sequência contígua 1..n, prevHash = hash anterior (ou genesis),
 *    hash recalculado = salvo, assinatura Ed25519 do hash, pseudônimo = HMAC(lote, autor),
 *    valores estritamente crescentes respeitando lance inicial e incremento;
 *  - tempo: cada lance em `startsAt ≤ createdAt < fim vigente naquele momento`, e o
 *    `endsAt` salvo = fim recalculado aplicando o anti-sniping lance a lance;
 *  - head assinado (bidCount, headHash): detecta remoção dos ÚLTIMOS lances;
 *  - cancelamento assinado (data + estado da cadeia no instante do cancelamento);
 *  - extrato: COMMIT/RELEASE/arremate/estorno 1:1 com os lances (mesmo valor, mesma
 *    carteira, mesmo hash de lance) e cadeia de cada extrato envolvido íntegra —
 *    detecta "voltar o lote para um head antigo" apagando lances;
 *  - estado desnormalizado do lote (contagem, preço atual, líder/vencedor).
 */
export function verifyChain(
  lot: Lot,
  bidsRaw: Bid[],
  checkedAt: Date,
  ledger: LotLedger,
): { bids: AuditBid[]; verification: AuditVerification } {
  const issues: AuditIssue[] = [];
  const bids = [...bidsRaw].sort((a, b) => a.sequence - b.sequence);

  // ----- genesis -----
  const computedGenesis = genesisHash(genesisInputOf(lot));
  const genesisOk = computedGenesis === lot.genesisHash;
  if (!genesisOk) {
    issues.push({
      code: 'GENESIS_MISMATCH',
      message:
        'Os parâmetros do lote (título, descrição, imagem, atributos da obra, vendedor, preços ou datas originais) não correspondem ao bloco gênese.',
    });
  }

  // ----- elos -----
  let chainOk = true;
  let signaturesOk = true;
  let prevHash = computedGenesis;
  let prevAmount: number | null = null;
  const auditBids: AuditBid[] = bids.map((b, i) => {
    const expectedSeq = i + 1;
    const link = {
      lotId: b.lotId,
      sequence: b.sequence,
      bidderAlias: b.bidderAlias,
      amountCents: b.amountCents,
      createdAt: b.createdAt,
      prevHash: b.prevHash,
    };
    const checks: BidChecks = {
      sequenceOk: b.sequence === expectedSeq,
      linkOk: b.prevHash === prevHash,
      hashOk: bidHash(link) === b.hash,
      signatureOk: verifyText(b.hash, b.signature),
      aliasOk: b.bidderAlias === bidderAlias(lot.id, b.bidderId),
    };

    if (!checks.sequenceOk) {
      issues.push({
        code: 'SEQUENCE_GAP',
        message: `Sequência quebrada: esperado o lance nº ${expectedSeq}, encontrado nº ${b.sequence} (lance removido ou inserido).`,
        sequence: b.sequence,
      });
    }
    if (!checks.linkOk) {
      issues.push({
        code: 'LINK_BROKEN',
        message: `O lance nº ${b.sequence} não aponta para o hash do elo anterior.`,
        sequence: b.sequence,
      });
    }
    if (!checks.hashOk) {
      issues.push({
        code: 'HASH_MISMATCH',
        message: `Os dados do lance nº ${b.sequence} (valor, autor ou horário) não correspondem ao hash registrado.`,
        sequence: b.sequence,
      });
    }
    if (!checks.signatureOk) {
      issues.push({
        code: 'BAD_SIGNATURE',
        message: `A assinatura digital do lance nº ${b.sequence} é inválida.`,
        sequence: b.sequence,
      });
    }
    if (!checks.aliasOk) {
      issues.push({
        code: 'ALIAS_MISMATCH',
        message: `O pseudônimo do lance nº ${b.sequence} não corresponde ao licitante registrado.`,
        sequence: b.sequence,
      });
    }

    // Regras de valor: 1º lance ≥ inicial; seguintes ≥ anterior + incremento (logo, estritamente crescentes).
    const minimum = prevAmount == null ? lot.startingPriceCents : prevAmount + lot.minIncrementCents;
    let amountOk = true;
    if (prevAmount != null && b.amountCents <= prevAmount) {
      amountOk = false;
      issues.push({
        code: 'AMOUNT_NOT_INCREASING',
        message: `O lance nº ${b.sequence} (${formatBRL(b.amountCents)}) não é maior que o anterior (${formatBRL(prevAmount)}).`,
        sequence: b.sequence,
      });
    } else if (b.amountCents < minimum) {
      amountOk = false;
      issues.push({
        code: 'AMOUNT_BELOW_MINIMUM',
        message: `O lance nº ${b.sequence} (${formatBRL(b.amountCents)}) está abaixo do mínimo permitido (${formatBRL(minimum)}).`,
        sequence: b.sequence,
      });
    }

    if (!checks.sequenceOk || !checks.linkOk || !checks.hashOk || !checks.aliasOk || !amountOk) chainOk = false;
    if (!checks.signatureOk) signaturesOk = false;

    prevHash = b.hash;
    prevAmount = b.amountCents;

    return {
      ...toPublicBid(b),
      prevHash: b.prevHash,
      signature: b.signature,
      payload: bidPayload(link),
      checks,
    };
  });

  // ----- tempo: janela de cada lance + fim recalculado (anti-sniping) -----
  // O horário de cada lance está no hash assinado; o fim original, no gênese. Logo o
  // fim vigente é DERIVÁVEL da cadeia — `endsAt` salvo é só um cache e precisa bater.
  let timingOk = true;
  let expectedEnd = lot.originalEndsAt.getTime();
  let prevCreated: number | null = null;
  for (const b of bids) {
    const t = b.createdAt.getTime();
    const reasons: string[] = [];
    if (t < lot.startsAt.getTime()) reasons.push('antes do início do pregão');
    if (t >= expectedEnd) reasons.push(`depois do fim vigente naquele momento (${new Date(expectedEnd).toISOString()})`);
    if (prevCreated != null && t < prevCreated) reasons.push('antes do lance anterior');
    if (lot.cancelledAt && t > lot.cancelledAt.getTime()) reasons.push('depois do cancelamento');
    if (reasons.length) {
      timingOk = false;
      issues.push({
        code: 'BID_OUTSIDE_WINDOW',
        message: `O lance nº ${b.sequence} foi registrado fora da janela do pregão: ${reasons.join('; ')}.`,
        sequence: b.sequence,
      });
    }
    if (expectedEnd - t <= ANTI_SNIPING_WINDOW_MS) expectedEnd = t + ANTI_SNIPING_WINDOW_MS;
    prevCreated = t;
  }
  if (lot.endsAt.getTime() !== expectedEnd) {
    timingOk = false;
    issues.push({
      code: 'END_MISMATCH',
      message: `O fim registrado do lote (${lot.endsAt.toISOString()}) difere do fim calculado a partir do fim original e dos lances (${new Date(expectedEnd).toISOString()}).`,
    });
  }

  // ----- head assinado -----
  const last = bids.length ? bids[bids.length - 1] : null;
  const expectedHead = last ? last.hash : computedGenesis;
  const headSigOk = verifyText(headPayload(lot.id, lot.bidCount, lot.headHash), lot.headSignature);
  const headMatches = lot.headHash === expectedHead;
  if (!headSigOk) {
    issues.push({
      code: 'HEAD_SIGNATURE_INVALID',
      message: 'A assinatura do topo da cadeia (quantidade de lances + último hash) é inválida.',
    });
  }
  if (!headMatches) {
    issues.push({
      code: 'HEAD_MISMATCH',
      message: last
        ? `O topo assinado da cadeia não corresponde ao último lance registrado (nº ${last.sequence}): lances foram removidos ou adicionados no fim.`
        : 'O topo assinado da cadeia indica lances, mas nenhum lance foi encontrado.',
      sequence: last?.sequence,
    });
  }
  const headOk = headSigOk && headMatches;

  // ----- contagem -----
  const countOk = lot.bidCount === bids.length;
  if (!countOk) {
    issues.push({
      code: 'COUNT_MISMATCH',
      message: `O lote registra ${lot.bidCount} lance(s), mas a cadeia contém ${bids.length}.`,
    });
  }

  // ----- cancelamento assinado -----
  let cancelOk = true;
  if (lot.cancelledAt) {
    const ok =
      !!lot.cancelSignature &&
      verifyText(cancelPayload(lot.id, lot.cancelledAt, lot.bidCount, lot.headHash), lot.cancelSignature);
    if (!ok) {
      cancelOk = false;
      issues.push({
        code: 'CANCEL_SIGNATURE_INVALID',
        message: lot.cancelSignature
          ? 'A assinatura do cancelamento não confere com a data do cancelamento e o estado da cadeia.'
          : 'O lote está marcado como cancelado, mas não há assinatura de cancelamento (cancelamento inserido direto no banco?).',
      });
    }
  } else if (lot.cancelSignature) {
    cancelOk = false;
    issues.push({
      code: 'CANCEL_SIGNATURE_INVALID',
      message: 'Há uma assinatura de cancelamento, mas o lote não está marcado como cancelado (cancelamento removido?).',
    });
  }

  // ----- preço / líder / vencedor -----
  let priceOk = true;
  const expectedPrice = last ? last.amountCents : null;
  if (lot.currentPriceCents !== expectedPrice) {
    priceOk = false;
    issues.push({
      code: 'PRICE_MISMATCH',
      message:
        expectedPrice == null
          ? `O lote exibe preço atual ${formatBRL(lot.currentPriceCents ?? 0)}, mas não há lances.`
          : `O preço atual do lote (${lot.currentPriceCents == null ? 'vazio' : formatBRL(lot.currentPriceCents)}) difere do último lance (${formatBRL(expectedPrice)}).`,
    });
  }
  // Lote cancelado: o cancelamento estorna e limpa o líder. Nos demais, líder = autor do último lance.
  const expectedLeader = lot.cancelledAt ? null : last?.bidderId ?? null;
  if (lot.leaderId !== expectedLeader) {
    priceOk = false;
    issues.push({
      code: 'LEADER_MISMATCH',
      message: lot.cancelledAt
        ? 'O lote cancelado ainda registra um líder (o cancelamento estorna e limpa o líder).'
        : 'O líder registrado no lote não é o autor do último lance.',
    });
  }
  if (lot.settledAt) {
    const winnerOk = last
      ? lot.winnerId === last.bidderId && lot.finalPriceCents === last.amountCents
      : lot.winnerId == null && lot.finalPriceCents == null;
    if (!winnerOk) {
      priceOk = false;
      issues.push({
        code: 'RESULT_MISMATCH',
        message: 'O vencedor ou o valor final do lote não correspondem ao último lance da cadeia.',
      });
    }
    if (lot.settledAt.getTime() < expectedEnd) {
      priceOk = false;
      issues.push({ code: 'RESULT_MISMATCH', message: 'O lote consta como liquidado antes do fim do pregão.' });
    }
  } else if (lot.winnerId != null || lot.finalPriceCents != null) {
    priceOk = false;
    issues.push({ code: 'RESULT_MISMATCH', message: 'O lote registra vencedor ou valor final sem ter sido liquidado.' });
  }

  // ----- extrato × cadeia -----
  const ledgerIssues = verifyLedger(lot, bids, ledger);
  issues.push(...ledgerIssues);
  const ledgerOk = ledgerIssues.length === 0;

  const summary: AuditSummary = { genesisOk, headOk, chainOk, signaturesOk, countOk, priceOk, timingOk, cancelOk, ledgerOk };
  const intact = Object.values(summary).every(Boolean) && issues.length === 0;
  return {
    bids: auditBids,
    verification: { status: intact ? 'INTACT' : 'TAMPERED', checkedAt: checkedAt.toISOString(), issues, summary },
  };
}

/**
 * Cruza o extrato com a cadeia. Para um lote com lances b1..bn o extrato tem de conter
 * EXATAMENTE (nem mais, nem menos), com `lotId` = lote:
 *  - COMMIT  bi.valor, carteira de bi.autor, bidHash = bi.hash, em bi.createdAt   (i = 1..n)
 *  - RELEASE "Lance superado" b(i−1).valor, carteira de b(i−1).autor, bidHash = bi.hash (i = 2..n)
 *  - liquidado: SETTLEMENT_DEBIT bn.valor (vencedor) e SETTLEMENT_CREDIT bn.valor (leiloeiro)
 *  - cancelado: RELEASE "Estorno: lote cancelado" bn.valor (carteira do último licitante)
 * E a cadeia do extrato de cada carteira envolvida precisa estar íntegra (ver common/ledger.ts).
 */
function verifyLedger(lot: Lot, bids: Bid[], ledger: LotLedger): AuditIssue[] {
  const issues: AuditIssue[] = [];
  const walletByUser = new Map(ledger.wallets.map((w) => [w.userId, w]));
  const walletById = new Map(ledger.wallets.map((w) => [w.id, w]));
  const walletOf = (userId: string) => walletByUser.get(userId)?.id ?? `sem-carteira:${userId}`;

  interface Expected {
    key: string;
    message: string;
    sequence?: number;
  }
  const keyOf = (type: string, walletId: string, amount: number, bidHash: string | null, at: Date, description: string | null) =>
    [type, walletId, amount, bidHash ?? '', at.toISOString(), description ?? ''].join('|');

  const expected: Expected[] = [];
  bids.forEach((b, i) => {
    expected.push({
      key: keyOf('COMMIT', walletOf(b.bidderId), b.amountCents, b.hash, b.createdAt, 'Lance comprometido'),
      message: `O extrato não registra o valor comprometido pelo lance nº ${b.sequence} (${formatBRL(b.amountCents)}).`,
      sequence: b.sequence,
    });
    if (i > 0) {
      const prev = bids[i - 1];
      expected.push({
        key: keyOf('RELEASE', walletOf(prev.bidderId), prev.amountCents, b.hash, b.createdAt, 'Lance superado'),
        message: `O extrato não registra a devolução do lance nº ${prev.sequence} (${formatBRL(prev.amountCents)}) quando foi superado pelo nº ${b.sequence}.`,
        sequence: b.sequence,
      });
    }
  });
  const last = bids.length ? bids[bids.length - 1] : null;
  if (last && lot.settledAt && !lot.cancelledAt) {
    expected.push({
      key: keyOf('SETTLEMENT_DEBIT', walletOf(last.bidderId), last.amountCents, last.hash, lot.settledAt, `Arremate: ${lot.title}`),
      message: `O extrato não registra o débito do arremate (${formatBRL(last.amountCents)}) na carteira do vencedor.`,
      sequence: last.sequence,
    });
    expected.push({
      key: keyOf('SETTLEMENT_CREDIT', walletOf(lot.auctioneerId), last.amountCents, last.hash, lot.settledAt, `Venda: ${lot.title}`),
      message: `O extrato não registra o crédito da venda (${formatBRL(last.amountCents)}) na carteira do leiloeiro.`,
      sequence: last.sequence,
    });
  }
  if (last && lot.cancelledAt) {
    expected.push({
      key: keyOf('RELEASE', walletOf(last.bidderId), last.amountCents, last.hash, lot.cancelledAt, 'Estorno: lote cancelado'),
      message: `O extrato não registra o estorno do lance nº ${last.sequence} (${formatBRL(last.amountCents)}) no cancelamento.`,
      sequence: last.sequence,
    });
  }

  // Casamento como multiconjunto (cada lançamento real consome um esperado).
  const pending = new Map<string, Expected[]>();
  for (const e of expected) {
    const list = pending.get(e.key);
    if (list) list.push(e);
    else pending.set(e.key, [e]);
  }
  const seqByHash = new Map(bids.map((b) => [b.hash, b.sequence]));
  const unexpected: LedgerEntry[] = [];
  for (const entry of ledger.entries) {
    const k = keyOf(entry.type, entry.walletId, entry.amountCents, entry.bidHash, entry.createdAt, entry.description);
    const list = pending.get(k);
    if (list?.length) list.shift();
    else unexpected.push(entry);
  }
  for (const list of pending.values()) {
    for (const e of list) issues.push({ code: 'LEDGER_MISMATCH', message: e.message, sequence: e.sequence });
  }
  for (const entry of unexpected) {
    const seq = entry.bidHash ? seqByHash.get(entry.bidHash) : undefined;
    const what =
      entry.type === 'COMMIT'
        ? `um lance comprometido de ${formatBRL(entry.amountCents)}`
        : entry.type === 'RELEASE'
          ? `uma devolução de ${formatBRL(entry.amountCents)}`
          : entry.type === 'SETTLEMENT_DEBIT'
            ? `um débito de arremate de ${formatBRL(entry.amountCents)}`
            : entry.type === 'SETTLEMENT_CREDIT'
              ? `um crédito de venda de ${formatBRL(entry.amountCents)}`
              : `um lançamento de ${formatBRL(entry.amountCents)}`;
    issues.push({
      code: 'LEDGER_MISMATCH',
      message:
        seq == null
          ? `O extrato registra ${what} neste lote que não corresponde a nenhum lance da cadeia (lances removidos ou estado do lote revertido?).`
          : `O extrato registra ${what} ligado ao lance nº ${seq} que não confere com a cadeia (valor, carteira ou horário divergentes).`,
      sequence: seq,
    });
  }

  // Integridade do extrato de cada carteira envolvida (encadeamento + head assinado).
  const entriesByWallet = new Map<string, LedgerEntry[]>();
  for (const e of ledger.walletEntries) {
    const list = entriesByWallet.get(e.walletId);
    if (list) list.push(e);
    else entriesByWallet.set(e.walletId, [e]);
  }
  const aliasOf = (w: Wallet) =>
    w.userId === lot.auctioneerId
      ? 'do leiloeiro'
      : bids.some((b) => b.bidderId === w.userId)
        ? `de ${bidderAlias(lot.id, w.userId)}`
        : 'de uma carteira sem lances neste lote';
  const involved = new Set<string>([
    ...bids.map((b) => walletOf(b.bidderId)),
    walletOf(lot.auctioneerId),
    ...ledger.entries.map((e) => e.walletId),
  ]);
  for (const wid of involved) {
    const w = walletById.get(wid);
    if (!w) {
      issues.push({ code: 'LEDGER_MISMATCH', message: 'Um participante deste lote não tem carteira registrada.' });
      continue;
    }
    for (const p of verifyWalletLedger(w, entriesByWallet.get(wid) ?? [])) {
      issues.push({ code: 'LEDGER_CHAIN_BROKEN', message: `Extrato da carteira ${aliasOf(w)}: ${p}.` });
    }
  }

  // Carteiras de FORA do lote com extrato inconsistente. Se lances E os lançamentos
  // correspondentes forem apagados juntos, os licitantes somem deste lote — mas as
  // carteiras deles ficam com o extrato quebrado. Sem saber de onde vieram os
  // lançamentos apagados, não dá para garantir que não eram deste lote.
  const outside = ledger.brokenWallets.filter((b) => !involved.has(b.walletId));
  if (outside.length) {
    issues.push({
      code: 'LEDGER_CHAIN_BROKEN',
      message:
        `O extrato de ${outside.length} carteira(s) da plataforma está inconsistente (lançamentos removidos ou saldos alterados direto no banco). ` +
        'Não é possível garantir que lances deste lote não foram removidos junto com esses lançamentos.',
    });
  }
  return issues;
}

type AuditReader = Pick<Prisma.TransactionClient, 'lot' | 'bid' | 'ledgerEntry' | 'wallet' | '$queryRaw'>;

/**
 * Lê tudo o que a auditoria de um lote precisa. Chame dentro de um snapshot consistente.
 * `fullCheckBroken`: resultado da verificação completa periódica (LedgerIntegrityService),
 * somado à checagem agregada desta leitura.
 */
export async function loadLotAuditData(
  db: AuditReader,
  lotId: string,
  fullCheckBroken: readonly BrokenWallet[] = [],
): Promise<{ lot: Lot; bids: Bid[]; ledger: LotLedger } | null> {
  const lot = await db.lot.findUnique({ where: { id: lotId } });
  if (!lot) return null;
  const bids = await db.bid.findMany({ where: { lotId }, orderBy: { sequence: 'asc' } });
  const entries = await db.ledgerEntry.findMany({ where: { lotId }, orderBy: [{ walletId: 'asc' }, { seq: 'asc' }] });
  const userIds = Array.from(new Set([lot.auctioneerId, ...bids.map((b) => b.bidderId)]));
  const wallets = await db.wallet.findMany({
    where: { OR: [{ userId: { in: userIds } }, { id: { in: Array.from(new Set(entries.map((e) => e.walletId))) } }] },
  });
  const walletEntries = await db.ledgerEntry.findMany({
    where: { walletId: { in: wallets.map((w) => w.id) } },
    orderBy: [{ walletId: 'asc' }, { seq: 'asc' }],
  });
  // Checagem agregada de todas as carteiras: 1 varredura do extrato + 1 verificação
  // Ed25519 por carteira (sem recalcular hashes; isso fica com a verificação completa).
  const aggregates = await db.$queryRaw<WalletAggregate[]>(WALLET_AGGREGATE_SQL);
  const brokenWallets = aggregates
    .map((a) => ({ walletId: a.id, userId: a.userId, problems: walletHealthProblems(a) }))
    .filter((b) => b.problems.length > 0);
  // Só carteiras que ainda existem: um id antigo no cache não pode acusar todos os lotes.
  const existing = new Set(aggregates.map((a) => a.id));
  const listed = new Set(brokenWallets.map((b) => b.walletId));
  for (const b of fullCheckBroken) {
    if (existing.has(b.walletId) && !listed.has(b.walletId)) brokenWallets.push({ ...b, problems: [...b.problems] });
  }
  return { lot, bids, ledger: { entries, wallets, walletEntries, brokenWallets } };
}

@Injectable()
export class AuditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly integrity: LedgerIntegrityService,
  ) {}

  publicKey() {
    const k = auditKeys();
    return { algorithm: 'Ed25519' as const, publicKeyPem: k.publicKeyPem, publicKeyRawBase64: k.publicKeyRawB64 };
  }

  /** Relatório completo (público). Funciona também para lote cancelado. */
  async lotReport(lotId: string): Promise<AuditReport> {
    // Lote e lances lidos num snapshot consistente (REPEATABLE READ): um lance
    // commitado no meio da leitura não gera falso "TAMPERED".
    const data = await this.loadSnapshot(lotId);
    if (!data) throw new AppError('LOT_NOT_FOUND');
    const { lot, bids, ledger } = data;
    const now = this.clock.now();
    const { bids: auditBids, verification } = verifyChain(lot, bids, now, ledger);
    return {
      lot: {
        id: lot.id,
        title: lot.title,
        imageUrl: lot.imageUrl,
        startingPriceCents: lot.startingPriceCents,
        minIncrementCents: lot.minIncrementCents,
        startsAt: lot.startsAt.toISOString(),
        originalEndsAt: lot.originalEndsAt.toISOString(),
        endsAt: lot.endsAt.toISOString(),
        phase: lotPhase(lot, now),
        cancelled: !!lot.cancelledAt,
        settled: !!lot.settledAt,
        bidCount: lot.bidCount,
        headHash: lot.headHash,
        headSignature: lot.headSignature,
        genesisHash: lot.genesisHash,
        cancelledAt: lot.cancelledAt?.toISOString() ?? null,
        cancelSignature: lot.cancelSignature,
        cancelPayload: lot.cancelledAt ? cancelPayload(lot.id, lot.cancelledAt, lot.bidCount, lot.headHash) : null,
      },
      genesisPayload: genesisPayload(genesisInputOf(lot)),
      bids: auditBids,
      verification,
      publicKey: { algorithm: 'Ed25519', publicKeyRawBase64: auditKeys().publicKeyRawB64 },
    };
  }

  /** Só o veredito (usado pelo comprovante). */
  async verifyLot(lotId: string): Promise<AuditVerification | null> {
    const data = await this.loadSnapshot(lotId);
    if (!data) return null;
    return verifyChain(data.lot, data.bids, this.clock.now(), data.ledger).verification;
  }

  private async loadSnapshot(lotId: string) {
    // Lote, lances e extratos no MESMO snapshot: um lance commitado no meio da leitura
    // não pode aparecer na cadeia sem o lançamento correspondente (falso "TAMPERED").
    return this.prisma.$transaction(
      (tx) => loadLotAuditData(tx, lotId, this.integrity.knownBroken()),
      { ...TX_OPTIONS, isolationLevel: 'RepeatableRead' },
    );
  }
}
