'use client';

import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import clsx from 'clsx';
import { apiFetch } from '@/lib/api';
import { friendlyError } from '@/lib/errors';
import { centsToInput, formatBRL, parseBRLToCents } from '@/lib/format';
import type { LotDetail, LotLiveState, PlaceBidResponse, PublicBid, WalletView } from '@/lib/types';
import { Button, InlineError } from './ui';
import { useAuth } from './auth-provider';

/**
 * Formulário de lance. Recusa do servidor aparece inline, com o motivo vindo de `code`/`details`.
 * O valor só é sugerido (não sobrescrito) quando o mínimo muda e o campo ainda não foi editado.
 *
 * O formulário continua disponível em lote agendado, encerrado ou quando você já lidera:
 * o servidor é quem decide, e a recusa (lote não iniciado, encerrado, você já está ganhando,
 * abaixo do mínimo, saldo insuficiente) aparece aqui, com o motivo. Avisos locais nunca bloqueiam o envio.
 */
export function BidForm({
  lot,
  onPlaced,
  notice,
  compact = false,
}: {
  lot: LotDetail;
  onPlaced: (state: LotLiveState, bid: PublicBid, wallet: WalletView) => void;
  /** Aviso contextual acima do campo (ex.: "Os lances abrem em …"). */
  notice?: React.ReactNode;
  /** Versão discreta (lote encerrado): sem valores rápidos nem rodapé. */
  compact?: boolean;
}) {
  const { wallet, setWallet } = useAuth();
  const fieldId = useId();
  const [value, setValue] = useState(() => centsToInput(lot.minNextBidCents));
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const min = lot.minNextBidCents;
  const inc = lot.minIncrementCents;

  // Mínimo subiu (outro lance): atualiza sugestão se a pessoa não digitou nada.
  useEffect(() => {
    if (!touched) setValue(centsToInput(min));
  }, [min, touched]);

  const cents = parseBRLToCents(value);
  const available = wallet?.availableCents ?? null;
  // Se eu já tenho valor comprometido neste lote (fui superado, então já voltou), o disponível é o que vale.
  const belowMin = cents !== null && cents < min;
  const overBalance = cents !== null && available !== null && cents > available;

  const quick = [
    { label: 'Mínimo', cents: min },
    { label: `+${formatBRL(inc, { compact: true })}`, cents: min + inc },
    { label: `+${formatBRL(inc * 5, { compact: true })}`, cents: min + inc * 5 },
  ];

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    if (cents === null || cents <= 0) {
      setLocalError('Digite um valor em reais, por exemplo 1.250,00.');
      inputRef.current?.focus();
      return;
    }
    // Abaixo do mínimo ou acima do saldo: só avisamos; quem recusa (com o motivo) é o servidor.
    setLocalError(null);
    setSubmitting(true);
    try {
      const res = await apiFetch<PlaceBidResponse>(`/api/lots/${encodeURIComponent(lot.id)}/bids`, {
        method: 'POST',
        body: { amountCents: cents },
      });
      setWallet(res.wallet);
      onPlaced(res.state, res.bid, res.wallet);
      setSuccess(`Lance de ${formatBRL(res.bid.amountCents)} aceito. Você está na frente.`);
      setTouched(false);
    } catch (err) {
      setError(err);
      const fe = friendlyError(err);
      if (fe.suggestedCents) {
        setValue(centsToInput(fe.suggestedCents));
        setTouched(true);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const describedBy = [localError || error ? `${fieldId}-erro` : null, `${fieldId}-ajuda`].filter(Boolean).join(' ');

  return (
    <form onSubmit={submit} noValidate className={clsx('flex flex-col', compact ? 'gap-3' : 'gap-4')} aria-label="Dar lance">
      {notice && (
        <div role="note" className="border-l-4 border-warn bg-warn-soft px-4 py-3 text-sm text-ink-soft">
          {notice}
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        <label htmlFor={fieldId} className="text-sm font-semibold">
          Seu lance
        </label>
        <div className={clsx('flex items-center border', compact ? 'h-11' : 'h-14', 'bg-surface focus-within:border-ink', localError || error ? 'border-lacre' : 'border-rule-strong')}>
          <span className="pl-4 pr-1 text-lg text-muted" aria-hidden>
            R$
          </span>
          <input
            ref={inputRef}
            id={fieldId}
            inputMode="decimal"
            autoComplete="off"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setTouched(true);
              setLocalError(null);
              setError(null);
              setSuccess(null);
            }}
            aria-invalid={Boolean(localError || error) || undefined}
            aria-describedby={describedBy}
            className={clsx('num h-full w-full bg-transparent pr-4 font-semibold outline-none', compact ? 'text-lg' : 'text-2xl')}
          />
        </div>
        <p id={`${fieldId}-ajuda`} className="num text-sm text-muted">
          Mínimo {formatBRL(min)} · incremento {formatBRL(inc)}
        </p>
      </div>

      {!compact && (
      <div className="grid grid-cols-3 gap-2" role="group" aria-label="Valores rápidos">
        {quick.map((q) => {
          const active = cents === q.cents;
          return (
            <button
              key={q.label}
              type="button"
              onClick={() => {
                setValue(centsToInput(q.cents));
                setTouched(q.label !== 'Mínimo');
                setLocalError(null);
                setError(null);
                setSuccess(null);
              }}
              className={clsx(
                'num flex flex-col items-center border px-2 py-2 text-center transition-colors',
                active ? 'border-ink bg-ink text-paper' : 'border-rule-strong hover:border-ink',
              )}
              aria-pressed={active}
            >
              <span className="text-xs opacity-75">{q.label}</span>
              <span className="text-sm font-semibold">{formatBRL(q.cents, { compact: true })}</span>
            </button>
          );
        })}
      </div>
      )}

      {belowMin && !error && lot.phase === 'LIVE' && (
        <p className="num text-sm text-warn">Este valor está abaixo do mínimo atual ({formatBRL(min)}). O servidor vai recusar.</p>
      )}
      {overBalance && !error && (
        <p className="text-sm text-warn">
          Este valor passa do seu disponível ({formatBRL(available)}).{' '}
          <Link href="/carteira" className="font-semibold underline underline-offset-4">
            Depositar
          </Link>
        </p>
      )}

      <div aria-live="assertive" className="empty:hidden">
        {localError && (
          <p id={`${fieldId}-erro`} role="alert" className="text-sm text-lacre">
            {localError}
          </p>
        )}
        {!localError && error ? <InlineError error={error} id={`${fieldId}-erro`} context={{ startsAt: lot.startsAt }} /> : null}
      </div>
      <div aria-live="polite" className="empty:hidden">
        {success && <p className="border border-ok/50 bg-ok-soft p-3 text-sm font-semibold text-ok">{success}</p>}
      </div>

      <Button type="submit" size={compact ? 'md' : 'lg'} variant={compact ? 'secondary' : 'primary'} loading={submitting} className="w-full">
        {submitting ? 'Enviando lance…' : cents ? `Dar lance de ${formatBRL(cents)}` : 'Dar lance'}
      </Button>
      {!compact && (
        <p className="text-xs leading-relaxed text-muted">
          Ao liderar, o valor fica reservado na sua carteira. Se alguém cobrir, ele volta na hora para o seu disponível.
        </p>
      )}
    </form>
  );
}
