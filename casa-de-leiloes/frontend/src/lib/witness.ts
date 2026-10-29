/**
 * Testemunha anti-rollback no navegador.
 *
 * Cada navegador que abre a auditoria ou acompanha a sala ao vivo guarda, por lote,
 * o maior número de lances já visto e o hash de cada sequência (últimas 200).
 * Se o servidor depois mostrar MENOS lances, ou um hash diferente para uma sequência
 * já vista, o histórico foi encurtado ou reescrito — mesmo que a nova cadeia esteja
 * internamente coerente (por exemplo, re-assinada por quem tem a chave).
 *
 * Tudo em localStorage com try/catch: modo privado ou armazenamento bloqueado só
 * desativam a testemunha, nunca quebram a página. Hashes já registrados nunca são
 * sobrescritos — a primeira versão vista é a evidência.
 */

const PREFIX = 'cl_witness:';
const INDEX_KEY = 'cl_witness_index';
const MAX_HASHES = 200;
const MAX_LOTS = 100;

export interface WitnessRecord {
  /** Maior quantidade de lances já vista neste lote. */
  maxBidCount: number;
  /** sequence → hash (no máximo MAX_HASHES, as sequências mais altas). */
  hashes: Record<string, string>;
  updatedAt: string;
}

export interface WitnessBid {
  sequence: number;
  hash: string;
}

export interface WitnessComparison {
  /** Quantos lances este navegador já viu. */
  seenCount: number;
  /** Hash da maior sequência já vista (se conhecida). */
  lastSeenHash: string | null;
  lastSeenSequence: number | null;
  /** O histórico atual tem menos lances do que o já visto. */
  fewer: boolean;
  /** Sequências já vistas cujo hash agora é outro. */
  mismatches: Array<{ sequence: number; seen: string; now: string }>;
  alert: boolean;
}

function storage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readWitness(lotId: string): WitnessRecord | null {
  const ls = storage();
  if (!ls) return null;
  try {
    const raw = ls.getItem(PREFIX + lotId);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<WitnessRecord>;
    if (!v || typeof v.maxBidCount !== 'number' || typeof v.hashes !== 'object' || v.hashes === null) return null;
    return { maxBidCount: v.maxBidCount, hashes: v.hashes as Record<string, string>, updatedAt: String(v.updatedAt ?? '') };
  } catch {
    return null;
  }
}

function touchIndex(ls: Storage, lotId: string) {
  try {
    const raw = ls.getItem(INDEX_KEY);
    let ids: string[] = raw ? (JSON.parse(raw) as string[]) : [];
    if (!Array.isArray(ids)) ids = [];
    ids = [lotId, ...ids.filter((x) => x !== lotId)];
    for (const old of ids.slice(MAX_LOTS)) ls.removeItem(PREFIX + old);
    ls.setItem(INDEX_KEY, JSON.stringify(ids.slice(0, MAX_LOTS)));
  } catch {
    /* índice é só para limpeza */
  }
}

/**
 * Registra o que o servidor mostrou. Nunca sobrescreve um hash já visto
 * (para que a divergência continue detectável em visitas futuras).
 */
export function recordWitness(lotId: string, bids: WitnessBid[], bidCount?: number) {
  const ls = storage();
  if (!ls) return;
  try {
    const prev = readWitness(lotId) ?? { maxBidCount: 0, hashes: {}, updatedAt: '' };
    const hashes: Record<string, string> = { ...prev.hashes };
    let maxSeq = 0;
    let changed = false;
    for (const b of bids) {
      if (!b || typeof b.sequence !== 'number' || typeof b.hash !== 'string' || !b.hash) continue;
      maxSeq = Math.max(maxSeq, b.sequence);
      const k = String(b.sequence);
      if (!(k in hashes)) {
        hashes[k] = b.hash;
        changed = true;
      }
    }
    const maxBidCount = Math.max(prev.maxBidCount, maxSeq, typeof bidCount === 'number' ? bidCount : 0);
    if (!changed && maxBidCount === prev.maxBidCount) return;

    // Mantém só as MAX_HASHES sequências mais altas.
    const keys = Object.keys(hashes)
      .map(Number)
      .filter(Number.isFinite)
      .sort((a, b) => b - a);
    const trimmed: Record<string, string> = {};
    for (const s of keys.slice(0, MAX_HASHES)) trimmed[String(s)] = hashes[String(s)];

    const rec: WitnessRecord = { maxBidCount, hashes: trimmed, updatedAt: new Date().toISOString() };
    ls.setItem(PREFIX + lotId, JSON.stringify(rec));
    touchIndex(ls, lotId);
  } catch {
    /* cota cheia / bloqueado: a testemunha fica desativada */
  }
}

/**
 * Compara o histórico atual com o que este navegador já viu.
 * `currentCount` é a quantidade de lances que o servidor diz ter agora.
 * `complete` indica que `bids` é a cadeia inteira (auditoria); na sala só vêm os 50 últimos.
 */
export function compareWitness(lotId: string, bids: WitnessBid[], currentCount: number, complete: boolean): WitnessComparison | null {
  const rec = readWitness(lotId);
  if (!rec) return null;
  const seqs = Object.keys(rec.hashes)
    .map(Number)
    .filter(Number.isFinite);
  const lastSeenSequence = seqs.length ? Math.max(...seqs) : null;
  const lastSeenHash = lastSeenSequence !== null ? rec.hashes[String(lastSeenSequence)] : null;

  const now = new Map<number, string>();
  for (const b of bids) now.set(b.sequence, b.hash);
  const count = complete ? Math.min(currentCount, bids.length) : currentCount;
  // Também pelo maior lance ENVIADO: na sala `currentCount` vem do servidor e poderia ser
  // inflado para esconder lances apagados do fim.
  const maxNow = bids.reduce((m, b) => Math.max(m, b.sequence), 0);
  const fewer = count < rec.maxBidCount || (lastSeenSequence !== null && maxNow < lastSeenSequence);

  const mismatches: WitnessComparison['mismatches'] = [];
  for (const s of seqs) {
    const cur = now.get(s);
    if (cur !== undefined && cur !== rec.hashes[String(s)]) mismatches.push({ sequence: s, seen: rec.hashes[String(s)], now: cur });
  }
  mismatches.sort((a, b) => a.sequence - b.sequence);

  return {
    seenCount: rec.maxBidCount,
    lastSeenHash,
    lastSeenSequence,
    fewer,
    mismatches,
    alert: fewer || mismatches.length > 0,
  };
}
