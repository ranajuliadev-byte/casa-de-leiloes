'use client';

import Link from 'next/link';
import { useCallback } from 'react';
import clsx from 'clsx';
import { BadgeCheck, ShieldAlert } from 'lucide-react';
import { apiFetch, isApiError } from '@/lib/api';
import { useApiResource } from '@/lib/use-api-resource';
import { formatBRL, formatDateLong, plural, shortHash } from '@/lib/format';
import type { ReceiptView } from '@/lib/types';
import { ArtworkImage, Container, ErrorState, PageLoading } from './ui';
import { ShareButtons, receiptHref } from './share-buttons';

/** auditUrl vem absoluto (FRONTEND_URL). Se for do mesmo site, navega internamente. */
function auditHref(r: ReceiptView) {
  try {
    const u = new URL(r.auditUrl);
    if (typeof window !== 'undefined' && u.origin === window.location.origin) return u.pathname;
    return r.auditUrl;
  } catch {
    return `/auditoria/${r.lot.id}`;
  }
}

export function ReceiptPage({ code }: { code: string }) {
  const fetchReceipt = useCallback(
    () => apiFetch<ReceiptView>(`/api/receipts/${encodeURIComponent(code)}`, { auth: false }),
    [code],
  );
  const { data: r, error, loading, reload: load } = useApiResource(fetchReceipt);

  if (!r && error) {
    const nf = isApiError(error) && error.status === 404;
    return (
      <Container className="py-16">
        <ErrorState error={error} title={nf ? 'Comprovante não encontrado' : undefined} onRetry={nf ? undefined : () => void load()} retrying={loading} />
      </Container>
    );
  }
  if (!r) return <PageLoading label="Carregando comprovante…" />;

  const a = r.lot.attributes;
  const url = receiptHref(r.code, r.url);

  return (
    <Container className="pt-8 sm:pt-12">
      <div className="no-print mb-6 flex flex-wrap items-center justify-between gap-3">
        <Link href={`/lotes/${r.lot.id}`} className="text-sm text-ink-soft hover:text-ink">
          Ver sala do lote
        </Link>
        <ShareButtons url={url} title={`Comprovante de arremate: ${r.lot.title}`} text={`${r.lot.title} arrematado por ${formatBRL(r.amountCents)}`} print />
      </div>

      <article className="mx-auto max-w-3xl border border-rule-strong bg-surface shadow-[0_24px_60px_-32px_rgb(0_0_0/0.35)] print:border-black print:shadow-none" aria-labelledby="rec-titulo">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b border-rule px-6 py-5 sm:px-10">
          <div className="flex items-baseline gap-2">
            <span className="red-dot" aria-hidden />
            <span className="display text-lg">Casa de Leilões</span>
          </div>
          <div className="text-right">
            <p className="text-xs text-muted">Comprovante nº</p>
            <p className="num font-semibold tracking-wide">{r.code}</p>
          </div>
        </header>

        <div className="grid gap-8 px-6 py-8 sm:grid-cols-[12rem_1fr] sm:px-10 sm:py-10">
          <ArtworkImage src={r.lot.imageUrl} alt={r.lot.title} className="aspect-[4/5] w-full p-4" />
          <div>
            <p className="text-sm text-muted">Comprovante de arremate</p>
            <h1 id="rec-titulo" className="display mt-1 text-3xl leading-tight sm:text-4xl">
              {r.lot.title}
            </h1>
            <p className="mt-1 text-ink-soft">{[a.artist, a.date].filter(Boolean).join(', ') || 'Autoria desconhecida'}</p>

            <div className="mt-6 border-y border-rule py-5">
              <p className="text-sm text-muted">Valor de arremate</p>
              <p className="num display text-5xl font-medium leading-none">{formatBRL(r.amountCents)}</p>
            </div>

            <dl className="num mt-5 grid grid-cols-[9rem_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted">Arrematante</dt>
              <dd className="font-semibold">{r.winnerAlias}</dd>
              <dt className="text-muted">Emitido em</dt>
              <dd>{formatDateLong(r.issuedAt)}</dd>
              <dt className="text-muted">Pregão</dt>
              <dd>{plural(r.bidCount, 'lance', 'lances')}</dd>
              <dt className="text-muted">Leiloeiro</dt>
              <dd>{r.lot.auctioneerName}</dd>
              {a.medium && (
                <>
                  <dt className="text-muted">Técnica</dt>
                  <dd>{a.medium}</dd>
                </>
              )}
            </dl>
          </div>
        </div>

        <footer className="grid gap-6 border-t border-rule px-6 py-6 sm:grid-cols-[1fr_auto] sm:items-center sm:px-10">
          <dl className="num space-y-1 text-xs">
            <div className="flex flex-wrap gap-x-2">
              <dt className="text-muted">Hash final da cadeia</dt>
              <dd className="break-all">
                <code title={r.chainHead}>{shortHash(r.chainHead, 20)}</code>
              </dd>
            </div>
            <div className="flex flex-wrap gap-x-2">
              <dt className="text-muted">Assinatura Ed25519</dt>
              <dd className="break-all">
                <code title={r.signature}>{shortHash(r.signature, 20)}</code>
              </dd>
            </div>
            <div className="no-print pt-2">
              <a href={auditHref(r)} className="text-sm font-semibold underline underline-offset-4">
                Auditar o histórico deste lote
              </a>
            </div>
          </dl>
          <div
            className={clsx(
              'flex items-center gap-3 border-2 px-4 py-3',
              r.valid ? 'border-ok text-ok' : 'border-lacre text-lacre',
            )}
            role="status"
          >
            {r.valid ? <BadgeCheck className="h-8 w-8" aria-hidden strokeWidth={1.5} /> : <ShieldAlert className="h-8 w-8" aria-hidden strokeWidth={1.5} />}
            <div>
              <p className="display text-xl font-semibold leading-none">{r.valid ? 'Válido' : 'Inválido'}</p>
              <p className="mt-1 text-xs text-ink-soft">{r.valid ? 'Assinatura e cadeia íntegras' : 'Assinatura ou cadeia não conferem'}</p>
            </div>
          </div>
        </footer>
      </article>
      <p className="no-print mx-auto mt-4 max-w-3xl text-xs text-muted">
        O comprovante identifica o arrematante só pelo pseudônimo usado neste lote. Nenhum dado pessoal é exibido.
      </p>
    </Container>
  );
}
