'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { apiFetch } from '@/lib/api';
import { useApiResource } from '@/lib/use-api-resource';
import { getSocket } from '@/lib/socket';
import { formatBRL, formatDateShort, plural } from '@/lib/format';
import { getGlobalOffset, offsetFrom } from '@/lib/time';
import type { LotLiveState, MyLotStatus, MyLotView } from '@/lib/types';
import { ArtworkImage, Container, EmptyState, ErrorState, PageLoading, PageTitle, buttonClass } from './ui';
import { MiniClock } from './lot-bits';
import { displayPrice, priceLabel } from './lot-card';
import { ShareButtons, receiptHref } from './share-buttons';

const STATUS: Record<MyLotStatus, { label: string; tone: 'ok' | 'lacre' | 'muted' | 'warn' }> = {
  WINNING: { label: 'Ganhando', tone: 'ok' },
  OUTBID: { label: 'Superado', tone: 'lacre' },
  AWAITING_SETTLEMENT: { label: 'Aguardando liquidação', tone: 'warn' },
  WON: { label: 'Arrematado', tone: 'ok' },
  LOST: { label: 'Não arrematado', tone: 'muted' },
  CANCELLED: { label: 'Lote cancelado', tone: 'muted' },
};

function StatusTag({ status }: { status: MyLotStatus }) {
  const s = STATUS[status];
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 text-sm font-semibold',
        s.tone === 'ok' && 'text-ok',
        s.tone === 'lacre' && 'text-lacre',
        s.tone === 'warn' && 'text-warn',
        s.tone === 'muted' && 'text-muted',
      )}
    >
      <span
        aria-hidden
        className={clsx(
          'h-2 w-2 rounded-full',
          s.tone === 'ok' && 'bg-ok',
          s.tone === 'lacre' && 'bg-lacre',
          s.tone === 'warn' && 'bg-warn',
          s.tone === 'muted' && 'bg-muted',
        )}
      />
      {s.label}
    </span>
  );
}

const PARTICIPATING: MyLotStatus[] = ['WINNING', 'OUTBID', 'AWAITING_SETTLEMENT'];

function Row({ item, offset }: { item: MyLotView; offset: number }) {
  const { lot } = item;
  return (
    <li className="grid grid-cols-[5rem_1fr] gap-4 py-6 sm:grid-cols-[7rem_1fr_auto] sm:gap-6">
      <Link href={`/lotes/${lot.id}`} tabIndex={-1} aria-hidden>
        <ArtworkImage src={lot.imageUrl} alt="" className="aspect-square w-full p-2" />
      </Link>
      <div className="min-w-0">
        <StatusTag status={item.status} />
        <h3 className="display mt-1 text-xl leading-snug">
          <Link href={`/lotes/${lot.id}`} className="hover:underline hover:underline-offset-4">
            {lot.title}
          </Link>
        </h3>
        <p className="truncate text-sm text-muted">
          {lot.attributes.artist ?? 'Autoria desconhecida'} · você é {item.alias}
        </p>
        <dl className="num mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:flex sm:flex-wrap">
          <div>
            <dt className="text-muted">Seu maior lance</dt>
            <dd className="font-semibold">{formatBRL(item.myHighestBidCents)}</dd>
          </div>
          <div>
            <dt className="text-muted">{priceLabel(lot)}</dt>
            <dd>{formatBRL(displayPrice(lot))}</dd>
          </div>
          <div>
            <dt className="text-muted">Seus lances</dt>
            <dd>{plural(item.myBidCount, 'lance', 'lances')}</dd>
          </div>
          <div>
            <dt className="text-muted">{lot.phase === 'LIVE' ? 'Prazo' : 'Encerramento'}</dt>
            <dd>{lot.phase === 'LIVE' ? <MiniClock phase={lot.phase} startsAt={lot.startsAt} endsAt={lot.endsAt} offset={offset} /> : formatDateShort(lot.endsAt)}</dd>
          </div>
        </dl>
      </div>
      <div className="col-span-2 flex flex-col items-start gap-3 sm:col-span-1 sm:items-end">
        {item.status === 'OUTBID' && lot.phase === 'LIVE' && (
          <Link href={`/lotes/${lot.id}`} className={buttonClass('primary', 'sm')}>
            Cobrir com {formatBRL(lot.minNextBidCents)}
          </Link>
        )}
        {item.status === 'WINNING' && (
          <Link href={`/lotes/${lot.id}`} className={buttonClass('secondary', 'sm')}>
            Acompanhar pregão
          </Link>
        )}
        {item.receipt && (
          <>
            <Link href={`/comprovante/${item.receipt.code}`} className={buttonClass('primary', 'sm')}>
              Ver comprovante
            </Link>
            <ShareButtons url={receiptHref(item.receipt.code, item.receipt.url)} title={`Arrematei ${lot.title}`} text={`Comprovante de arremate: ${lot.title}`} />
          </>
        )}
      </div>
    </li>
  );
}

export function MyLotsPage() {
  const [tab, setTab] = useState<'part' | 'won'>('part');
  // Relógio do servidor (não o do dispositivo): vem do `serverTime` dos próprios itens.
  const [offset, setOffset] = useState(getGlobalOffset);

  const fetchItems = useCallback(async () => (await apiFetch<{ items: MyLotView[] }>('/api/me/bids')).items, []);
  const { data: items, error, loading, reload: load } = useApiResource(fetchItems, (list) => setOffset(offsetFrom(list[0]?.lot.serverTime)));

  // Atualiza ao vivo: entra nas salas dos lotes em andamento e recarrega a lista quando algo muda.
  const liveIds = useMemo(() => (items ?? []).filter((i) => i.lot.phase === 'LIVE' || PARTICIPATING.includes(i.status)).map((i) => i.lot.id), [items]);
  const liveKey = liveIds.join(',');
  useEffect(() => {
    if (!liveKey) return;
    const ids = liveKey.split(',');
    const s = getSocket();
    let t: number | null = null;
    const debounced = () => {
      if (t) window.clearTimeout(t);
      t = window.setTimeout(() => void load(), 500);
    };
    const join = () => ids.forEach((lotId) => s.emit('lot:join', { lotId }));
    const onState = (st: LotLiveState) => {
      if (ids.includes(st.lotId)) debounced();
    };
    const onConnect = () => {
      join();
      debounced();
    };
    s.on('lot:state', onState);
    s.on('user:outbid', debounced);
    s.on('user:won', debounced);
    s.on('connect', onConnect);
    if (s.connected) join();
    return () => {
      ids.forEach((lotId) => s.emit('lot:leave', { lotId }));
      s.off('lot:state', onState);
      s.off('user:outbid', debounced);
      s.off('user:won', debounced);
      s.off('connect', onConnect);
      if (t) window.clearTimeout(t);
    };
  }, [liveKey, load]);

  if (!items && error) {
    return (
      <Container className="py-16">
        <ErrorState error={error} onRetry={() => void load()} retrying={loading} />
      </Container>
    );
  }
  if (!items) return <PageLoading />;

  const participating = items.filter((i) => PARTICIPATING.includes(i.status));
  const finished = items.filter((i) => !PARTICIPATING.includes(i.status));
  const won = finished.filter((i) => i.status === 'WON');
  const others = finished.filter((i) => i.status !== 'WON');
  const list = tab === 'part' ? participating : [...won, ...others];

  return (
    <Container className="pt-10">
      <PageTitle sub="Acompanhe seus pregões e guarde os comprovantes dos lotes que você arrematou.">Meus arremates</PageTitle>
      <div role="tablist" aria-label="Situação" className="flex gap-6 border-b border-rule">
        {(
          [
            ['part', 'Participando', participating.length],
            ['won', 'Arrematados e encerrados', finished.length],
          ] as const
        ).map(([key, label, count]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            aria-controls="lista-meus"
            onClick={() => setTab(key)}
            className={clsx('-mb-px border-b-2 pb-3 text-base', tab === key ? 'border-lacre font-semibold text-ink' : 'border-transparent text-muted hover:text-ink')}
          >
            {label} <span className="num text-sm">({count})</span>
          </button>
        ))}
      </div>
      <div id="lista-meus" role="tabpanel">
        {list.length === 0 ? (
          <EmptyState title={tab === 'part' ? 'Você não está em nenhum pregão' : 'Nenhum lote encerrado ainda'}>
            {tab === 'part' ? (
              <Link href="/" className="font-semibold text-ink underline underline-offset-4">
                Ver lotes ao vivo
              </Link>
            ) : (
              'Quando um pregão de que você participou terminar, ele aparece aqui.'
            )}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-rule">
            {list.map((i) => (
              <Row key={i.lot.id} item={i} offset={offset} />
            ))}
          </ul>
        )}
      </div>
    </Container>
  );
}
