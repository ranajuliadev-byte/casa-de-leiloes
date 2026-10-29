'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import clsx from 'clsx';
import { Search } from 'lucide-react';
import { apiFetch, qs } from '@/lib/api';
import { useShowcaseLive } from '@/lib/socket';
import { offsetFrom, serverNow } from '@/lib/time';
import type { LotListResponse, LotLiveState, LotPhase, LotSort, LotSummary } from '@/lib/types';
import { LotCard, LotCardSkeleton } from './lot-card';
import { Button, Container, EmptyState, ErrorState, inputClass } from './ui';

type Tab = Exclude<LotPhase, 'CANCELLED'>;

const TABS: { phase: Tab; label: string; empty: string }[] = [
  { phase: 'LIVE', label: 'Ao vivo', empty: 'Nenhum pregão aberto agora. Veja os agendados para saber quando o próximo começa.' },
  { phase: 'SCHEDULED', label: 'Agendados', empty: 'Nenhum lote agendado no momento.' },
  { phase: 'ENDED', label: 'Encerrados', empty: 'Nenhum lote encerrado ainda.' },
];

const SORTS: { value: LotSort; label: string }[] = [
  { value: 'ending', label: 'Termina antes' },
  { value: 'newest', label: 'Mais recentes' },
  { value: 'price_asc', label: 'Menor preço' },
  { value: 'price_desc', label: 'Maior preço' },
];

const PAGE_SIZE = 24;

function isTab(v: string | null): v is Tab {
  return v === 'LIVE' || v === 'SCHEDULED' || v === 'ENDED';
}
function isSort(v: string | null): v is LotSort {
  return v === 'ending' || v === 'newest' || v === 'price_asc' || v === 'price_desc';
}

export function Showcase() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const tab: Tab = isTab(params.get('fase')) ? (params.get('fase') as Tab) : 'LIVE';
  const sort: LotSort = isSort(params.get('ordem')) ? (params.get('ordem') as LotSort) : 'ending';
  const q = params.get('q') ?? '';

  const [query, setQuery] = useState(q);
  const [items, setItems] = useState<LotSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [counts, setCounts] = useState<Partial<Record<Tab, number>>>({});
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [offset, setOffset] = useState(0);
  const reqId = useRef(0);
  const itemsRef = useRef<LotSummary[]>([]);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const setParam = useCallback(
    (patch: Record<string, string | null>) => {
      const sp = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === '') sp.delete(k);
        else sp.set(k, v);
      }
      const s = sp.toString();
      router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
    },
    [params, pathname, router],
  );

  // Debounce da busca
  useEffect(() => setQuery(q), [q]);
  useEffect(() => {
    if (query === q) return;
    const t = window.setTimeout(() => setParam({ q: query.trim() || null }), 350);
    return () => window.clearTimeout(t);
  }, [query, q, setParam]);

  const loadCounts = useCallback(async () => {
    const res = await Promise.allSettled(
      TABS.map((t) => apiFetch<LotListResponse>(`/api/lots${qs({ phase: t.phase, q, page: 1, pageSize: 1 })}`)),
    );
    const next: Partial<Record<Tab, number>> = {};
    res.forEach((r, i) => {
      if (r.status === 'fulfilled') next[TABS[i].phase] = r.value.total;
    });
    setCounts(next);
  }, [q]);

  const load = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      const id = ++reqId.current;
      if (!opts.silent) setLoading(true);
      try {
        // Refresh silencioso: rebusca cada página já carregada com o mesmo pageSize (a API limita
        // pageSize a 100, então não dá para pedir 24 × página de uma vez). Falha em qualquer
        // página → mantém a lista atual (é só uma ressincronização).
        const pages = opts.silent ? Math.max(1, page) : 1;
        const results = await Promise.all(
          Array.from({ length: pages }, (_, i) =>
            apiFetch<LotListResponse>(`/api/lots${qs({ phase: tab, q, sort, page: i + 1, pageSize: PAGE_SIZE })}`),
          ),
        );
        if (id !== reqId.current) return;
        const last = results[results.length - 1];
        const seen = new Set<string>();
        const merged: LotSummary[] = [];
        for (const r of results) {
          for (const x of r.items) {
            if (seen.has(x.id)) continue;
            seen.add(x.id);
            merged.push(x);
          }
        }
        setOffset(offsetFrom(last.serverTime));
        setItems(merged);
        setTotal(last.total);
        if (!opts.silent) setPage(1);
        setError(null);
      } catch (e) {
        if (id !== reqId.current) return;
        if (!opts.silent) setError(e);
      } finally {
        if (id === reqId.current) setLoading(false);
      }
      void loadCounts();
    },
    [tab, q, sort, page, loadCounts],
  );

  // Recarrega ao trocar aba/busca/ordem (não ao paginar)
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });
  useEffect(() => {
    void loadRef.current();
  }, [tab, q, sort]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const next = page + 1;
      const res = await apiFetch<LotListResponse>(`/api/lots${qs({ phase: tab, q, sort, page: next, pageSize: PAGE_SIZE })}`);
      setOffset(offsetFrom(res.serverTime));
      setItems((xs) => {
        const seen = new Set(xs.map((x) => x.id));
        return [...xs, ...res.items.filter((x) => !seen.has(x.id))];
      });
      setTotal(res.total);
      setPage(next);
    } catch (e) {
      setError(e);
    } finally {
      setLoadingMore(false);
    }
  };

  // Atualização silenciosa (debounce) quando algo muda de fase
  const silentTimer = useRef<number | null>(null);
  const silentRefresh = useCallback(() => {
    if (silentTimer.current) window.clearTimeout(silentTimer.current);
    silentTimer.current = window.setTimeout(() => void loadRef.current({ silent: true }), 700);
  }, []);

  useShowcaseLive(
    (s: LotLiveState) => {
      setOffset(offsetFrom(s.serverTime));
      const known = itemsRef.current.find((x) => x.id === s.lotId);
      setItems((xs) =>
        xs.flatMap((x) => {
          if (x.id !== s.lotId) return [x];
          if (s.phase === 'CANCELLED') return [];
          return [{ ...x, ...s }];
        }),
      );
      // Lote mudou de fase, foi cancelado ou não está nesta lista: ressincroniza lista e contadores.
      if (s.phase === 'CANCELLED' || s.phase !== tab || !known || known.phase !== s.phase) silentRefresh();
    },
    () => silentRefresh(),
  );

  // Fronteiras de tempo (abertura/fechamento) sem evento: agenda refresh para logo após a mais próxima.
  useEffect(() => {
    const now = serverNow(offset);
    const boundaries = items
      .map((x) => Date.parse(x.phase === 'SCHEDULED' ? x.startsAt : x.endsAt))
      .filter((t) => isFuture(t, now));
    if (!boundaries.length || tab === 'ENDED') return;
    const wait = Math.min(...boundaries) - now + 2500; // liquidação roda a cada 2 s
    if (wait > 2 ** 31 - 1) return;
    const t = window.setTimeout(() => silentRefresh(), Math.max(1000, wait));
    return () => window.clearTimeout(t);
  }, [items, offset, tab, silentRefresh]);

  // Rede de segurança: lotes novos não têm evento — atualiza a cada 30 s com a aba visível.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') silentRefresh();
    }, 30000);
    return () => window.clearInterval(id);
  }, [silentRefresh]);

  const activeTab = useMemo(() => TABS.find((t) => t.phase === tab)!, [tab]);

  return (
    <Container className="pt-10 sm:pt-14">
      <h1 className="sr-only">Vitrine de lotes</h1>
      <div role="tablist" aria-label="Fase dos lotes" className="flex flex-wrap items-baseline gap-x-8 gap-y-2 sm:gap-x-12">
        {TABS.map((t) => {
          const selected = t.phase === tab;
          return (
            <button
              key={t.phase}
              role="tab"
              id={`tab-${t.phase}`}
              aria-selected={selected}
              aria-controls="painel-lotes"
              onClick={() => setParam({ fase: t.phase === 'LIVE' ? null : t.phase })}
              className={clsx(
                'display group relative text-4xl leading-none transition-colors sm:text-6xl',
                selected ? 'text-ink' : 'text-muted/70 hover:text-ink-soft',
              )}
            >
              <span className={clsx(selected && t.phase === 'LIVE' && 'italic')}>{t.label}</span>
              <sup className="num ml-1 align-super font-sans text-sm font-semibold sm:text-base">
                {counts[t.phase] ?? ''}
                <span className="sr-only">{counts[t.phase] !== undefined ? ' lotes' : ''}</span>
              </sup>
              {selected && <span aria-hidden className="absolute -bottom-3 left-0 h-[3px] w-10 bg-lacre" />}
            </button>
          );
        })}
      </div>

      <div className="mt-10 flex flex-col gap-3 border-y border-rule py-4 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <label htmlFor="busca" className="sr-only">
            Buscar por título ou artista
          </label>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
          <input
            id="busca"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar por título ou artista"
            className={clsx(inputClass, 'pl-9 sm:max-w-md')}
          />
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="ordem" className="text-sm text-muted">
            Ordenar
          </label>
          <select id="ordem" value={sort} onChange={(e) => setParam({ ordem: e.target.value === 'ending' ? null : e.target.value })} className={clsx(inputClass, 'w-auto pr-8')}>
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <section id="painel-lotes" role="tabpanel" aria-labelledby={`tab-${tab}`} className="mt-10">
        {loading ? (
          <div className="grid grid-cols-1 gap-x-8 gap-y-14 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <LotCardSkeleton key={i} />
            ))}
          </div>
        ) : error && !items.length ? (
          <ErrorState error={error} onRetry={() => void load()} title="Não foi possível carregar a vitrine" />
        ) : !items.length ? (
          <EmptyState title={q ? 'Nada encontrado' : 'Sem lotes aqui'}>
            {q ? <>Nenhum lote corresponde a “{q}”. Tente outro título ou artista.</> : activeTab.empty}
          </EmptyState>
        ) : (
          <>
            <ul className="grid grid-cols-1 gap-x-8 gap-y-14 sm:grid-cols-2 lg:grid-cols-3">
              {items.map((lot, i) => (
                <li key={lot.id} className="flex">
                  <div className="w-full">
                    <LotCard lot={lot} offset={offset} priority={i < 3} />
                  </div>
                </li>
              ))}
            </ul>
            {items.length < total && (
              <div className="mt-14 flex justify-center">
                <Button variant="secondary" onClick={loadMore} loading={loadingMore}>
                  Mostrar mais lotes
                </Button>
              </div>
            )}
          </>
        )}
      </section>
    </Container>
  );
}

function isFuture(t: number, now: number) {
  return Number.isFinite(t) && t > now;
}
