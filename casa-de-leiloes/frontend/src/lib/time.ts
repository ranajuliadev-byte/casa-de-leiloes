'use client';

import { useSyncExternalStore } from 'react';

/**
 * Relógio sincronizado com o servidor.
 *
 * offset = serverTime − Date.now(). Somado ao Date.now() local dá o "agora" do servidor,
 * então a contagem regressiva não depende do relógio do usuário. O último offset conhecido
 * fica global para telas que ainda não receberam `serverTime`.
 */
let globalOffset = 0;
/** false até a primeira resposta com `serverTime`: antes disso o offset 0 é só um palpite. */
let synced = false;

export function offsetFrom(serverTime: string | null | undefined): number {
  if (!serverTime) return globalOffset;
  const t = Date.parse(serverTime);
  if (Number.isNaN(t)) return globalOffset;
  globalOffset = t - Date.now();
  synced = true;
  return globalOffset;
}

export function getGlobalOffset() {
  return globalOffset;
}

export function isClockSynced() {
  return synced;
}

export function serverNow(offset = globalOffset): number {
  return Date.now() + offset;
}

// ---- ticker compartilhado: um único setInterval por intervalo, para todos os componentes ----
type Ticker = { listeners: Set<() => void>; id: number | null; value: number };
const tickers = new Map<number, Ticker>();

function getTicker(ms: number): Ticker {
  let t = tickers.get(ms);
  if (!t) {
    t = { listeners: new Set(), id: null, value: Date.now() };
    tickers.set(ms, t);
  }
  return t;
}

function subscribeTick(ms: number, cb: () => void) {
  const t = getTicker(ms);
  t.listeners.add(cb);
  if (t.id === null) {
    t.value = Date.now();
    t.id = window.setInterval(() => {
      t.value = Date.now();
      t.listeners.forEach((l) => l());
    }, ms);
  }
  return () => {
    t.listeners.delete(cb);
    if (t.listeners.size === 0 && t.id !== null) {
      window.clearInterval(t.id);
      t.id = null;
    }
  };
}

/** Date.now() local, atualizado a cada `ms`. Durante SSR devolve 0 (o cliente corrige ao hidratar). */
export function useTick(ms = 1000): number {
  return useSyncExternalStore(
    (cb) => subscribeTick(ms, cb),
    () => getTicker(ms).value,
    () => 0,
  );
}

/** "Agora" do servidor, atualizado a cada `ms`. 0 durante SSR. */
export function useServerNow(offset: number, ms = 1000): number {
  const local = useTick(ms);
  return local === 0 ? 0 : local + offset;
}

/**
 * Valor derivado do "agora" do servidor (ex.: a fase do lote). Só re-renderiza quando o
 * valor selecionado muda, não a cada tique. `select` deve devolver um primitivo.
 */
export function useServerDerived<T extends string | number | boolean | null>(
  offset: number,
  select: (serverNowMs: number) => T,
  fallback: T,
  ms = 250,
): T {
  return useSyncExternalStore(
    (cb) => subscribeTick(ms, cb),
    () => select(getTicker(ms).value + offset),
    () => fallback,
  );
}

export interface Countdown {
  remainingMs: number;
  done: boolean;
  /** Menos de 2 minutos (janela de prorrogação anti-sniping). */
  critical: boolean;
  /** false durante SSR/hidratação — não renderize números ainda. */
  ready: boolean;
}

/** Contagem regressiva até `target`, atualizada a cada 250 ms (padrão). */
export function useCountdown(target: string | null | undefined, offset: number, ms = 250): Countdown {
  const now = useServerNow(offset, ms);
  if (!now) return { remainingMs: 0, done: false, critical: false, ready: false };
  if (!target) return { remainingMs: 0, done: true, critical: false, ready: true };
  const remainingMs = Math.max(0, Date.parse(target) - now);
  return {
    remainingMs,
    done: remainingMs <= 0,
    critical: remainingMs > 0 && remainingMs <= 2 * 60 * 1000,
    ready: true,
  };
}
