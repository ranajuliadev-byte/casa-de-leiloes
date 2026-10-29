'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { io, type Socket } from 'socket.io-client';
import { API_URL, apiFetch, getToken } from './api';
import { offsetFrom } from './time';
import type { LotDetail, LotLiveState, LotPhase, PublicBid } from './types';
import { recordWitness } from './witness';

let socket: Socket | null = null;

/** Singleton Socket.IO. O token é lido a cada (re)conexão, então login/logout só precisam de `resetSocketAuth()`. */
export function getSocket(): Socket {
  if (!socket) {
    socket = io(API_URL, {
      autoConnect: true,
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 800,
      reconnectionDelayMax: 8000,
      auth: (cb) => cb({ token: getToken() }),
    });
  }
  return socket;
}

/** Reconecta para o servidor associar (ou desassociar) a sala privada do usuário. */
export function resetSocketAuth() {
  if (!socket) return;
  socket.disconnect();
  socket.connect();
}

// ---- status de conexão ----
type Status = 'connecting' | 'online' | 'offline';
const statusListeners = new Set<() => void>();
let status: Status = 'connecting';
let statusBound = false;

function bindStatus() {
  if (statusBound) return;
  statusBound = true;
  const s = getSocket();
  const set = (v: Status) => {
    status = v;
    statusListeners.forEach((l) => l());
  };
  s.on('connect', () => set('online'));
  s.on('disconnect', () => set('offline'));
  s.on('connect_error', () => set('offline'));
  s.io.on('reconnect_attempt', () => set('connecting'));
  if (s.connected) set('online');
}

export function useSocketStatus(): Status {
  return useSyncExternalStore(
    (cb) => {
      bindStatus();
      statusListeners.add(cb);
      return () => statusListeners.delete(cb);
    },
    () => status,
    () => 'connecting',
  );
}

// ---- sala do lote ----

function mergeBids(current: PublicBid[], incoming: PublicBid[]): PublicBid[] {
  const map = new Map<string, PublicBid>();
  for (const b of current) map.set(b.id, b);
  for (const b of incoming) map.set(b.id, b);
  return Array.from(map.values()).sort((a, b) => b.sequence - a.sequence);
}

function applyState(detail: LotDetail, s: LotLiveState): LotDetail {
  const next: LotDetail = { ...detail, ...s };
  if (detail.viewer && detail.viewer.alias) {
    const isLeader = s.leaderAlias !== null && s.leaderAlias === detail.viewer.alias;
    next.viewer = {
      ...detail.viewer,
      isLeader,
      position: isLeader ? 1 : detail.viewer.position === 1 ? 2 : detail.viewer.position,
      canBid: detail.viewer.role === 'BIDDER' && s.phase === 'LIVE',
    };
  } else if (detail.viewer) {
    next.viewer = { ...detail.viewer, canBid: detail.viewer.role === 'BIDDER' && s.phase === 'LIVE' };
  }
  return next;
}

export interface LotRoom {
  lot: LotDetail | null;
  error: unknown;
  loading: boolean;
  offset: number;
  /** id do último lance recebido ao vivo (para destacar). */
  freshBidId: string | null;
  refetch: () => Promise<void>;
  /** Aplica a resposta do POST de lance imediatamente (sem esperar o socket). */
  applyLocal: (state: LotLiveState, bid?: PublicBid) => void;
}

/**
 * Sala ao vivo: busca o detalhe (estado autoritativo), entra na sala `lot:<id>`,
 * aplica `lot:state`/`lot:bid` e, ao reconectar, refaz o join e busca o detalhe de novo.
 */
export function useLotRoom(lotId: string): LotRoom {
  const [lot, setLot] = useState<LotDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [offset, setOffset] = useState(0);
  const [freshBidId, setFreshBidId] = useState<string | null>(null);
  /** Incrementa a cada refetch concluído (ok ou erro): reagenda os timers de fronteira mesmo se nada mudou. */
  const [fetchVersion, setFetchVersion] = useState(0);
  const lastServerTime = useRef(0);
  const refetchTimer = useRef<number | null>(null);
  const hasLotRef = useRef(false);
  useEffect(() => {
    hasLotRef.current = lot !== null;
  }, [lot]);

  const refetch = useCallback(async () => {
    try {
      const d = await apiFetch<LotDetail>(`/api/lots/${encodeURIComponent(lotId)}`);
      const t = Date.parse(d.serverTime) || 0;
      // Resposta respondida antes de um lance/estado já aplicado (corrida com o socket): descarta,
      // senão a lista "perderia" o lance recém-chegado (e a testemunha veria um falso recuo).
      if (t && t < lastServerTime.current && hasLotRef.current) {
        setError(null);
        return;
      }
      lastServerTime.current = t;
      setOffset(offsetFrom(d.serverTime));
      setLot({ ...d, bids: mergeBids([], d.bids) });
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
      setFetchVersion((v) => v + 1);
    }
  }, [lotId]);

  /** Posição entre licitantes não vem por socket: buscamos de novo, com debounce. */
  const scheduleRefetch = useCallback(() => {
    if (refetchTimer.current) window.clearTimeout(refetchTimer.current);
    refetchTimer.current = window.setTimeout(() => void refetch(), 600);
  }, [refetch]);

  const applyIncomingState = useCallback((s: LotLiveState) => {
    const t = Date.parse(s.serverTime) || 0;
    if (t && t < lastServerTime.current) return; // evento atrasado
    if (t) lastServerTime.current = t;
    setOffset(offsetFrom(s.serverTime));
    setLot((prev) => (prev ? applyState(prev, s) : prev));
  }, []);

  const applyLocal = useCallback(
    (s: LotLiveState, bid?: PublicBid) => {
      if (bid) {
        // O lance é meu: já sabemos meu pseudônimo e que estou na frente.
        setLot((prev) =>
          prev
            ? {
                ...prev,
                bids: mergeBids(prev.bids, [bid]),
                viewer: prev.viewer
                  ? { ...prev.viewer, alias: bid.bidderAlias, myHighestBidCents: bid.amountCents, isLeader: true, position: 1 }
                  : prev.viewer,
              }
            : prev,
        );
      }
      applyIncomingState(s);
      if (bid) {
        setFreshBidId(bid.id);
        recordWitness(lotId, [bid]);
      }
      scheduleRefetch();
    },
    [applyIncomingState, scheduleRefetch, lotId],
  );

  useEffect(() => {
    setLoading(true);
    setLot(null);
    hasLotRef.current = false;
    lastServerTime.current = 0;
    void refetch();

    const s = getSocket();
    const join = () => s.emit('lot:join', { lotId });
    let firstConnect = !s.connected;
    const onConnect = () => {
      join();
      // Reconexão: o estado pode ter mudado enquanto estávamos fora.
      if (!firstConnect) void refetch();
      firstConnect = false;
    };
    const onState = (st: LotLiveState) => {
      if (st.lotId !== lotId) return;
      applyIncomingState(st);
    };
    const onBid = (b: PublicBid) => {
      if (b.lotId !== lotId) return;
      // Quem acompanhou o pregão vira testemunha: guarda o hash de cada lance visto ao vivo.
      recordWitness(lotId, [b]);
      setLot((prev) => (prev ? { ...prev, bids: mergeBids(prev.bids, [b]) } : prev));
      setFreshBidId(b.id);
      scheduleRefetch();
    };

    s.on('connect', onConnect);
    s.on('lot:state', onState);
    s.on('lot:bid', onBid);
    if (s.connected) join();

    // Volta para a aba depois de um tempo: busca o estado autoritativo.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refetch();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      s.emit('lot:leave', { lotId });
      s.off('connect', onConnect);
      s.off('lot:state', onState);
      s.off('lot:bid', onBid);
      document.removeEventListener('visibilitychange', onVisible);
      if (refetchTimer.current) window.clearTimeout(refetchTimer.current);
    };
  }, [lotId, refetch, applyIncomingState, scheduleRefetch]);

  // ---- Fronteiras de tempo ----
  // O servidor só emite `lot:state` em lance/criação/cancelamento/liquidação, não quando o
  // relógio cruza startsAt/endsAt. Agendamos o refetch do detalhe para essas fronteiras
  // (no relógio do servidor) e, depois do fim, repetimos até a liquidação (`settled`).
  const phase = lot?.phase;
  const startsAt = lot?.startsAt;
  const endsAt = lot?.endsAt;
  const settled = lot?.settled;
  const hasLot = lot !== null;
  useEffect(() => {
    if (!hasLot || !phase || !startsAt || !endsAt) return;
    const wait = boundaryDelay({ phase, startsAt, endsAt, settled: Boolean(settled) }, Date.now() + offset);
    if (wait === null) return;
    const t = window.setTimeout(() => void refetch(), Math.min(wait, 2 ** 31 - 1));
    return () => window.clearTimeout(t);
    // fetchVersion: reagenda mesmo quando o refetch devolve exatamente o mesmo estado.
  }, [hasLot, phase, startsAt, endsAt, settled, offset, fetchVersion, refetch]);

  // Testemunha: registra a janela de lances (até 50) e o total vistos no detalhe.
  // Indexada pelo id da URL, nunca pelo que o servidor devolve (ver lib/verify.ts).
  useEffect(() => {
    if (lot) recordWitness(lotId, lot.bids, lot.bidCount);
  }, [lot, lotId]);

  return { lot, error, loading, offset, freshBidId, refetch, applyLocal };
}

/** Folga depois do fim: a liquidação roda a cada 2 s. */
const SETTLE_GRACE_MS = 2500;
/** Intervalo entre tentativas enquanto o servidor ainda não confirmou a virada/liquidação. */
const RETRY_MS = 3000;

/**
 * Quanto esperar (ms) até o próximo refetch automático, ou null se não precisa.
 * - SCHEDULED: em startsAt (+300 ms); se já passou e o servidor ainda diz agendado, tenta de novo em 1,5 s.
 * - LIVE: em endsAt + 2,5 s (já com a liquidação); se já passou, tenta a cada 3 s.
 * - ENDED sem liquidação: a cada 3 s até `settled`.
 */
export function boundaryDelay(
  s: { phase: LotPhase; startsAt: string; endsAt: string; settled: boolean },
  serverNowMs: number,
): number | null {
  const start = Date.parse(s.startsAt);
  const end = Date.parse(s.endsAt);
  if (s.phase === 'SCHEDULED' && Number.isFinite(start)) {
    const d = start - serverNowMs + 300;
    return d > 0 ? d : 1500;
  }
  if (s.phase === 'LIVE' && Number.isFinite(end)) {
    const d = end - serverNowMs + SETTLE_GRACE_MS;
    return d > 0 ? d : RETRY_MS;
  }
  if (s.phase === 'ENDED' && !s.settled) return RETRY_MS;
  return null;
}

const PHASE_RANK: Record<Exclude<LotPhase, 'CANCELLED'>, number> = { SCHEDULED: 0, LIVE: 1, ENDED: 2 };
const RANK_PHASE: Exclude<LotPhase, 'CANCELLED'>[] = ['SCHEDULED', 'LIVE', 'ENDED'];

/**
 * Fase exibida: a do servidor, adiantada pelo relógio (sincronizado) quando cruzamos
 * startsAt/endsAt, para a UI virar na hora. Nunca volta atrás em relação ao servidor;
 * o estado autoritativo chega logo depois pelo refetch agendado.
 */
export function derivePhase(s: { phase: LotPhase; startsAt: string; endsAt: string }, serverNowMs: number): LotPhase {
  if (s.phase === 'CANCELLED') return 'CANCELLED';
  const start = Date.parse(s.startsAt);
  const end = Date.parse(s.endsAt);
  const clientRank = Number.isFinite(end) && serverNowMs >= end ? 2 : Number.isFinite(start) && serverNowMs >= start ? 1 : 0;
  return RANK_PHASE[Math.max(PHASE_RANK[s.phase], clientRank)];
}

/** Vitrine: entra na sala `showcase` e repassa cada `lot:state`. */
export function useShowcaseLive(onState: (s: LotLiveState) => void, onReconnect?: () => void) {
  const cb = useRef(onState);
  const rc = useRef(onReconnect);
  useEffect(() => {
    cb.current = onState;
    rc.current = onReconnect;
  });

  useEffect(() => {
    const s = getSocket();
    let firstConnect = !s.connected;
    const onConnect = () => {
      s.emit('showcase:join', {});
      if (!firstConnect) rc.current?.();
      firstConnect = false;
    };
    const handler = (st: LotLiveState) => cb.current(st);
    s.on('connect', onConnect);
    s.on('lot:state', handler);
    if (s.connected) s.emit('showcase:join', {});
    return () => {
      s.off('connect', onConnect);
      s.off('lot:state', handler);
    };
  }, []);
}
