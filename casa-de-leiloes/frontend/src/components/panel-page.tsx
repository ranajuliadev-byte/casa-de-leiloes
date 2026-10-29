'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { Plus } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { useApiResource } from '@/lib/use-api-resource';
import { useShowcaseLive } from '@/lib/socket';
import { formatBRL, formatDateShort, plural } from '@/lib/format';
import { getGlobalOffset, offsetFrom } from '@/lib/time';
import type { AuctioneerLotView, AuctioneerLotsResponse } from '@/lib/types';
import { ArtworkImage, Button, buttonClass, Container, EmptyState, ErrorState, InlineError, PageLoading, PageTitle, inputClass } from './ui';
import { MiniClock, PhaseTag } from './lot-bits';
import { displayPrice } from './lot-card';
import { useToast } from './toast';

const RESULT: Record<AuctioneerLotView['result'], string> = {
  PENDING: 'Em andamento',
  SOLD: 'Vendido',
  UNSOLD: 'Não vendido',
  CANCELLED: 'Cancelado',
};

function CancelDialog({ lot, onClose, onCancelled }: { lot: AuctioneerLotView; onClose: () => void; onCancelled: (l: AuctioneerLotView) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);

  const confirm = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch<AuctioneerLotView>(`/api/lots/${encodeURIComponent(lot.id)}/cancel`, {
        method: 'POST',
        body: reason.trim() ? { reason: reason.trim() } : {},
      });
      onCancelled(res);
    } catch (e) {
      setError(e);
      setSubmitting(false);
    }
  };

  const hasBids = lot.bidCount > 0;
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-labelledby="cancelar-titulo"
      className="m-auto w-[min(32rem,calc(100vw-2rem))] border border-rule-strong bg-paper p-0 text-ink backdrop:bg-black/50"
    >
      <div className="p-6">
        <h2 id="cancelar-titulo" className="display text-2xl">
          Cancelar “{lot.title}”?
        </h2>
        <div className="mt-3 space-y-2 text-sm text-ink-soft">
          {hasBids ? (
            <p>
              Este lote tem {plural(lot.bidCount, 'lance', 'lances')}. Ao cancelar, o valor reservado do licitante que lidera ({formatBRL(lot.currentPriceCents)}) volta
              automaticamente para o disponível dele. Ninguém é cobrado.
            </p>
          ) : (
            <p>O lote ainda não recebeu lances e sai da vitrine imediatamente.</p>
          )}
          <p>O cancelamento não pode ser desfeito.</p>
        </div>
        <div className="mt-5 flex flex-col gap-1.5">
          <label htmlFor="motivo" className="text-sm font-semibold">
            Motivo (opcional)
          </label>
          <input id="motivo" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} className={inputClass} />
        </div>
        <div className="mt-4">
          <InlineError error={error} />
        </div>
        <div className="mt-6 flex flex-wrap justify-end gap-3">
          <Button variant="secondary" onClick={() => ref.current?.close()} disabled={submitting} autoFocus>
            Manter lote
          </Button>
          <Button variant="danger" onClick={confirm} loading={submitting}>
            Cancelar lote
          </Button>
        </div>
      </div>
    </dialog>
  );
}

function Totals({ t }: { t: AuctioneerLotsResponse['totals'] }) {
  const items: [string, string][] = [
    ['Ao vivo', String(t.liveCount)],
    ['Agendados', String(t.scheduledCount)],
    ['Vendidos', String(t.soldCount)],
    ['Não vendidos', String(t.unsoldCount)],
  ];
  return (
    <div className="grid gap-8 border-b border-rule pb-8 lg:grid-cols-[1fr_auto] lg:items-end">
      <div>
        <p className="text-sm text-muted">Total recebido em arremates</p>
        <p className="num display mt-1 text-5xl font-medium leading-none sm:text-6xl">{formatBRL(t.totalReceivedCents)}</p>
      </div>
      <dl className="num grid grid-cols-2 gap-6 sm:grid-cols-4 sm:gap-10">
        {items.map(([k, v]) => (
          <div key={k}>
            <dt className="text-sm text-muted">{k}</dt>
            <dd className="text-2xl font-semibold">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function LotRow({ lot, offset, onCancel }: { lot: AuctioneerLotView; offset: number; onCancel: () => void }) {
  const value = lot.result === 'SOLD' ? lot.receivedCents : displayPrice(lot);
  return (
    <li className="grid grid-cols-[4.5rem_1fr] gap-4 py-5 sm:grid-cols-[5.5rem_1fr_auto] sm:gap-6">
      <ArtworkImage src={lot.imageUrl} alt="" className="aspect-square w-full p-1.5" />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {lot.result === 'PENDING' ? (
            <PhaseTag phase={lot.phase} extended={lot.extended} />
          ) : (
            <span className={clsx('text-sm font-semibold', lot.result === 'SOLD' ? 'text-ok' : lot.result === 'CANCELLED' ? 'text-lacre' : 'text-muted')}>
              {RESULT[lot.result]}
            </span>
          )}
          <span className="num text-sm text-muted">{plural(lot.bidCount, 'lance', 'lances')}</span>
        </div>
        <h3 className="display mt-1 truncate text-xl">
          {lot.result === 'CANCELLED' ? (
            lot.title
          ) : (
            <Link href={`/lotes/${lot.id}`} className="hover:underline hover:underline-offset-4">
              {lot.title}
            </Link>
          )}
        </h3>
        <p className="num mt-1 text-sm text-muted">
          {lot.result === 'PENDING' ? (
            <MiniClock phase={lot.phase} startsAt={lot.startsAt} endsAt={lot.endsAt} offset={offset} />
          ) : lot.result === 'CANCELLED' ? (
            <>Cancelado em {formatDateShort(lot.cancelledAt ?? lot.endsAt)}{lot.cancelReason ? `. Motivo: ${lot.cancelReason}` : ''}</>
          ) : (
            <>Encerrou em {formatDateShort(lot.endsAt)}</>
          )}
        </p>
      </div>
      <div className="col-span-2 flex items-center justify-between gap-4 sm:col-span-1 sm:flex-col sm:items-end sm:justify-start">
        <div className="text-left sm:text-right">
          <p className="text-xs text-muted">
            {lot.result === 'SOLD' ? 'Recebido' : lot.result === 'PENDING' ? (lot.bidCount ? 'Lance atual' : 'Lance inicial') : 'Valor'}
          </p>
          <p className={clsx('num text-lg font-semibold', lot.result !== 'SOLD' && lot.result !== 'PENDING' && 'text-muted')}>
            {lot.result === 'UNSOLD' || lot.result === 'CANCELLED' ? '—' : formatBRL(value)}
          </p>
        </div>
        <div className="flex gap-2">
          {lot.result !== 'CANCELLED' && lot.bidCount > 0 && (
            <Link href={`/auditoria/${lot.id}`} className={buttonClass('ghost', 'sm')}>
              Auditoria
            </Link>
          )}
          {lot.canCancel && (
            <Button variant="secondary" size="sm" onClick={onCancel}>
              Cancelar
            </Button>
          )}
        </div>
      </div>
    </li>
  );
}

type Filter = 'all' | 'PENDING' | 'SOLD' | 'UNSOLD' | 'CANCELLED';

export function PanelPage() {
  const [cancelling, setCancelling] = useState<AuctioneerLotView | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const { push } = useToast();
  // Relógio do servidor (não o do dispositivo): vem do `serverTime` dos próprios itens.
  const [offset, setOffset] = useState(getGlobalOffset);

  const fetchLots = useCallback(() => apiFetch<AuctioneerLotsResponse>('/api/auctioneer/lots'), []);
  const { data, error, loading, reload: load } = useApiResource(fetchLots, (res) => setOffset(offsetFrom(res.items[0]?.serverTime)));

  // Atualiza quando um lote meu muda (lance, prorrogação, liquidação)
  const ids = useRef<Set<string>>(new Set());
  useEffect(() => {
    ids.current = new Set((data?.items ?? []).map((i) => i.id));
  }, [data]);
  const timer = useRef<number | null>(null);
  useShowcaseLive(
    (s) => {
      if (!ids.current.has(s.lotId)) return;
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void load(), 600);
    },
    () => void load(),
  );
  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );

  if (!data && error) {
    return (
      <Container className="py-16">
        <ErrorState error={error} onRetry={() => void load()} retrying={loading} />
      </Container>
    );
  }
  if (!data) return <PageLoading />;

  const list = filter === 'all' ? data.items : data.items.filter((i) => i.result === filter);
  const FILTERS: [Filter, string][] = [
    ['all', 'Todos'],
    ['PENDING', 'Em andamento'],
    ['SOLD', 'Vendidos'],
    ['UNSOLD', 'Não vendidos'],
    ['CANCELLED', 'Cancelados'],
  ];

  return (
    <Container className="pt-10">
      <PageTitle
        actions={
          <Link href="/painel/novo" className={buttonClass('primary')}>
            <Plus className="h-4 w-4" aria-hidden /> Novo lote
          </Link>
        }
      >
        Painel do leiloeiro
      </PageTitle>
      <Totals t={data.totals} />

      <div className="mt-8 flex flex-wrap gap-2" role="group" aria-label="Filtrar lotes">
        {FILTERS.map(([k, label]) => (
          <button
            key={k}
            type="button"
            aria-pressed={filter === k}
            onClick={() => setFilter(k)}
            className={clsx('border px-3 py-1.5 text-sm', filter === k ? 'border-ink bg-ink text-paper' : 'border-rule-strong text-ink-soft hover:border-ink')}
          >
            {label}
          </button>
        ))}
      </div>

      {data.items.length === 0 ? (
        <EmptyState title="Você ainda não criou lotes">
          <Link href="/painel/novo" className="font-semibold text-ink underline underline-offset-4">
            Escolher uma obra e abrir o primeiro pregão
          </Link>
        </EmptyState>
      ) : list.length === 0 ? (
        <EmptyState title="Nenhum lote neste filtro" />
      ) : (
        <ul className="mt-4 divide-y divide-rule">
          {list.map((l) => (
            <LotRow key={l.id} lot={l} offset={offset} onCancel={() => setCancelling(l)} />
          ))}
        </ul>
      )}

      {cancelling && (
        <CancelDialog
          lot={cancelling}
          onClose={() => setCancelling(null)}
          onCancelled={(l) => {
            setCancelling(null);
            push({
              tone: 'info',
              title: `Lote cancelado: ${l.title}`,
              message: cancelling.bidCount > 0 ? 'O valor reservado do licitante líder foi devolvido.' : undefined,
            });
            void load();
          }}
        />
      )}
    </Container>
  );
}
