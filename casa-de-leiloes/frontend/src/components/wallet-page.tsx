'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import { apiFetch } from '@/lib/api';
import { useApiResource } from '@/lib/use-api-resource';
import { formatBRL, formatDateShort, parseBRLToCents } from '@/lib/format';
import type { LedgerEntryType, LedgerEntryView, WalletResponse, WalletView } from '@/lib/types';
import { useAuth } from './auth-provider';
import { useToast } from './toast';
import { Button, Container, EmptyState, ErrorState, InlineError, PageLoading, PageTitle } from './ui';

const QUICK = [50_000, 100_000, 500_000, 1_000_000]; // R$ 500, 1.000, 5.000, 10.000
const MAX_DEPOSIT = 100_000_000;

const ENTRY_LABEL: Record<LedgerEntryType, string> = {
  DEPOSIT: 'Depósito',
  COMMIT: 'Reserva de lance',
  RELEASE: 'Reserva devolvida',
  SETTLEMENT_DEBIT: 'Pagamento de arremate',
  SETTLEMENT_CREDIT: 'Recebimento de arremate',
};

/** Efeito no disponível: + entra, − sai. */
const ENTRY_SIGN: Record<LedgerEntryType, 1 | -1> = {
  DEPOSIT: 1,
  COMMIT: -1,
  RELEASE: 1,
  SETTLEMENT_DEBIT: -1,
  SETTLEMENT_CREDIT: 1,
};

function Balance({ wallet }: { wallet: WalletView }) {
  return (
    <div className="grid gap-px bg-rule sm:grid-cols-3">
      <div className="bg-paper py-5 sm:pr-6">
        <p className="text-sm text-muted">Disponível para lances</p>
        <p className="num display mt-1 text-5xl font-medium leading-none">{formatBRL(wallet.availableCents)}</p>
      </div>
      <div className="bg-paper py-5 sm:px-6">
        <p className="text-sm text-muted">Reservado em lances que você lidera</p>
        <p className="num mt-1 text-2xl">{formatBRL(wallet.committedCents)}</p>
      </div>
      <div className="bg-paper py-5 sm:pl-6">
        <p className="text-sm text-muted">Saldo total</p>
        <p className="num mt-1 text-2xl">{formatBRL(wallet.balanceCents)}</p>
      </div>
    </div>
  );
}

function DepositForm({ onDone }: { onDone: (w: WalletView) => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const { push } = useToast();
  const cents = parseBRLToCents(value);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (cents === null || cents < 1) return setLocalError('Digite um valor em reais, por exemplo 1.000,00.');
    if (cents > MAX_DEPOSIT) return setLocalError(`O máximo por depósito é ${formatBRL(MAX_DEPOSIT)}.`);
    setLocalError(null);
    setSubmitting(true);
    try {
      const res = await apiFetch<{ wallet: WalletView }>('/api/wallet/deposit', { method: 'POST', body: { amountCents: cents } });
      onDone(res.wallet);
      push({ tone: 'success', title: `Depósito de ${formatBRL(cents)} feito`, message: `Disponível agora: ${formatBRL(res.wallet.availableCents)}.` });
      setValue('');
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Valores rápidos">
        {QUICK.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => {
              setValue(String(c / 100));
              setLocalError(null);
            }}
            aria-pressed={cents === c}
            className={clsx('num border px-4 py-2 text-sm font-semibold', cents === c ? 'border-ink bg-ink text-paper' : 'border-rule-strong hover:border-ink')}
          >
            {formatBRL(c, { compact: true })}
          </button>
        ))}
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="deposito" className="text-sm font-semibold">
          Valor do depósito
        </label>
        <div className={clsx('flex h-12 items-center border bg-surface focus-within:border-ink', localError ? 'border-lacre' : 'border-rule-strong')}>
          <span className="pl-3 pr-1 text-muted" aria-hidden>
            R$
          </span>
          <input
            id="deposito"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0,00"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setLocalError(null);
            }}
            aria-invalid={Boolean(localError) || undefined}
            aria-describedby="deposito-ajuda"
            className="num h-full w-full bg-transparent pr-3 text-lg outline-none"
          />
        </div>
        <p id="deposito-ajuda" className={clsx('text-sm', localError ? 'text-lacre' : 'text-muted')} role={localError ? 'alert' : undefined}>
          {localError ?? 'Depósito simulado: o valor entra na hora, sem cobrança real.'}
        </p>
      </div>
      <InlineError error={error} />
      <Button type="submit" loading={submitting} disabled={!value}>
        {cents ? `Depositar ${formatBRL(cents)}` : 'Depositar'}
      </Button>
    </form>
  );
}

function Statement({ entries }: { entries: LedgerEntryView[] }) {
  if (!entries.length) return <EmptyState title="Nenhuma movimentação">Faça um depósito para começar a dar lances.</EmptyState>;
  return (
    <ol className="divide-y divide-rule">
      {entries.map((e) => {
        const sign = ENTRY_SIGN[e.type];
        return (
          <li key={e.id} className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 py-3">
            <span className="font-semibold">{ENTRY_LABEL[e.type]}</span>
            <span className={clsx('num text-right font-semibold', sign > 0 ? 'text-ok' : 'text-ink')}>
              {sign > 0 ? '+' : '−'} {formatBRL(Math.abs(e.amountCents))}
            </span>
            <span className="min-w-0 truncate text-sm text-muted">
              {e.lotId && e.lotTitle ? (
                <Link href={`/lotes/${e.lotId}`} className="underline-offset-4 hover:underline">
                  {e.lotTitle}
                </Link>
              ) : (
                (e.description ?? '')
              )}
            </span>
            <span className="num text-right text-sm text-muted">{formatDateShort(e.createdAt)}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function WalletPage() {
  const { wallet: liveWallet, setWallet } = useAuth();
  const fetchWallet = useCallback(() => apiFetch<WalletResponse>('/api/wallet'), []);
  const { data, error, loading, reload: load } = useApiResource(fetchWallet, (res) => setWallet(res.wallet));

  // Carteira mudou por evento (lance coberto, liquidação): recarrega o extrato.
  const liveKey = liveWallet ? `${liveWallet.balanceCents}:${liveWallet.committedCents}` : '';
  useEffect(() => {
    if (!data || !liveKey) return;
    const cur = `${data.wallet.balanceCents}:${data.wallet.committedCents}`;
    if (cur !== liveKey) void load();
  }, [liveKey, data, load]);

  if (!data && error) {
    return (
      <Container className="py-16">
        <ErrorState error={error} onRetry={() => void load()} retrying={loading} />
      </Container>
    );
  }
  if (!data) return <PageLoading />;

  const w = liveWallet ?? data.wallet;

  return (
    <Container className="pt-10">
      <PageTitle sub="Lances que você lidera ficam reservados. Se alguém cobrir, o valor volta na hora para o disponível.">Carteira</PageTitle>
      <Balance wallet={w} />
      <div className="mt-12 grid gap-12 lg:grid-cols-[minmax(0,22rem)_1fr]">
        <section aria-labelledby="dep-titulo">
          <h2 id="dep-titulo" className="display mb-4 text-2xl">
            Depositar
          </h2>
          {/* O extrato recarrega pelo efeito acima (a carteira global muda e diverge de `data`). */}
          <DepositForm onDone={setWallet} />
        </section>
        <section aria-labelledby="ext-titulo">
          <h2 id="ext-titulo" className="display mb-2 border-b border-ink pb-3 text-2xl">
            Extrato
          </h2>
          <Statement entries={data.entries} />
          {data.entries.length >= 50 && <p className="mt-3 text-sm text-muted">Mostrando as 50 movimentações mais recentes.</p>}
        </section>
      </div>
    </Container>
  );
}
