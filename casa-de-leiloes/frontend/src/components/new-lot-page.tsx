'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { Check, Search, TriangleAlert } from 'lucide-react';
import { apiFetch, qs } from '@/lib/api';
import { centsToInput, formatBRL, parseBRLToCents, toDateTimeLocal } from '@/lib/format';
import { isClockSynced, offsetFrom, serverNow } from '@/lib/time';
import type { ArtworkSearchResponse, ArtworkView, LotDetail, LotSummary } from '@/lib/types';
import { ArtworkImage, Button, Container, ErrorState, Field, InlineError, PageTitle, Spinner, inputClass } from './ui';
import { LotCard } from './lot-card';
import { useToast } from './toast';

// ---------- busca de obras ----------
function ArtworkSearch({ selected, onSelect }: { selected: ArtworkView | null; onSelect: (a: ArtworkView) => void }) {
  const [q, setQ] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ArtworkSearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const req = useRef(0);

  const search = useCallback(async (term: string, p: number) => {
    const id = ++req.current;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<ArtworkSearchResponse>(`/api/artworks/search${qs({ q: term, page: p })}`);
      if (id !== req.current) return;
      setData(res);
    } catch (e) {
      if (id !== req.current) return;
      setError(e);
    } finally {
      if (id === req.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void search(submitted, page);
  }, [submitted, page, search]);

  return (
    <section aria-labelledby="busca-titulo">
      <h2 id="busca-titulo" className="display text-2xl">
        Escolha a obra
      </h2>
      <p className="mt-1 text-sm text-muted">Acervo público do Art Institute of Chicago. O lote guarda uma cópia dos dados da obra.</p>
      <form
        role="search"
        className="mt-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          setSubmitted(q.trim());
        }}
      >
        <label htmlFor="busca-obra" className="sr-only">
          Buscar obra por título, artista ou tema
        </label>
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
          <input id="busca-obra" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Monet, retrato, paisagem…" className={clsx(inputClass, 'pl-9')} />
        </div>
        <Button type="submit" variant="secondary">
          Buscar
        </Button>
      </form>

      {data?.degraded && (
        <div role="status" className="mt-4 flex gap-3 border border-warn/60 bg-warn-soft p-3 text-sm">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden />
          <p>
            <span className="font-semibold">API externa instável — exibindo obras do cache.</span> Você pode criar o lote normalmente com uma delas.
          </p>
        </div>
      )}

      <div className="mt-5" aria-busy={loading}>
        {error && !data ? (
          <ErrorState error={error} onRetry={() => void search(submitted, page)} title="Não foi possível buscar obras" />
        ) : loading && !data ? (
          <Spinner label="Buscando no acervo…" />
        ) : data && data.items.length === 0 ? (
          <p className="py-6 text-muted">Nenhuma obra encontrada{submitted ? ` para “${submitted}”` : ''}. Tente outro termo.</p>
        ) : data ? (
          <>
            <ul className={clsx('grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4', loading && 'opacity-60')}>
              {data.items.map((a) => {
                const isSel = selected?.id === a.id;
                return (
                  <li key={a.id}>
                    <button
                      type="button"
                      onClick={() => onSelect(a)}
                      aria-pressed={isSel}
                      className={clsx('group flex w-full flex-col text-left outline-offset-2', isSel ? 'ring-2 ring-lacre ring-offset-2 ring-offset-paper' : '')}
                    >
                      <div className="relative w-full">
                        <ArtworkImage src={a.thumbUrl ?? a.imageUrl} alt="" className="aspect-square w-full p-3" />
                        {isSel && (
                          <span className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-lacre text-lacre-ink">
                            <Check className="h-4 w-4" aria-hidden />
                          </span>
                        )}
                      </div>
                      <span className="mt-2 line-clamp-2 text-sm font-semibold leading-snug group-hover:underline">{a.title}</span>
                      <span className="truncate text-xs text-muted">{[a.artist, a.dateLabel].filter(Boolean).join(', ') || 'Autoria desconhecida'}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {data.totalPages > 1 && (
              <div className="mt-5 flex items-center justify-between gap-3 text-sm">
                <Button variant="secondary" size="sm" disabled={page <= 1 || loading} onClick={() => setPage((p) => p - 1)}>
                  Anterior
                </Button>
                <span className="num text-muted">
                  Página {data.page} de {data.totalPages}
                </span>
                <Button variant="secondary" size="sm" disabled={page >= data.totalPages || loading} onClick={() => setPage((p) => p + 1)}>
                  Próxima
                </Button>
              </div>
            )}
          </>
        ) : null}
      </div>
    </section>
  );
}

// ---------- formulário ----------
interface Errors {
  artwork?: string;
  starting?: string;
  increment?: string;
  startsAt?: string;
  endsAt?: string;
}

export function NewLotPage() {
  const router = useRouter();
  const { push } = useToast();
  const [artwork, setArtwork] = useState<ArtworkView | null>(null);
  const [starting, setStarting] = useState('1.000,00');
  const [increment, setIncrement] = useState('100,00');
  const [startNow, setStartNow] = useState(true);
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [description, setDescription] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // Valores padrão só no cliente (evita divergência de hidratação), a partir do relógio do
  // servidor. Aberta direto (sem outra tela ter trazido `serverTime`), sincroniza antes:
  // com offset 0, um relógio adiantado criaria o lote "Abrir agora" AGENDADO e um atrasado
  // daria um término padrão já no passado.
  useEffect(() => {
    let alive = true;
    const applyDefaults = () => {
      if (!alive) return;
      const now = serverNow();
      // Só preenche se a pessoa ainda não escolheu as datas.
      setStartsAt((v) => v || toDateTimeLocal(new Date(now + 10 * 60 * 1000)));
      setEndsAt((v) => v || toDateTimeLocal(new Date(now + 60 * 60 * 1000)));
    };
    if (isClockSynced()) applyDefaults();
    else
      apiFetch<{ serverTime: string }>('/api/health', { auth: false })
        .then((r) => offsetFrom(r.serverTime))
        .catch(() => {}) // sem sincronizar, segue com o relógio local (o servidor ainda valida as datas)
        .finally(applyDefaults);
    return () => {
      alive = false;
    };
  }, []);

  const startingCents = parseBRLToCents(starting);
  const incrementCents = parseBRLToCents(increment);

  const validate = (): Errors => {
    const e: Errors = {};
    if (!artwork) e.artwork = 'Escolha uma obra na busca acima.';
    if (startingCents === null) e.starting = 'Digite um valor, por exemplo 1.000,00.';
    else if (startingCents < 100) e.starting = 'O lance inicial mínimo é R$ 1,00.';
    if (incrementCents === null) e.increment = 'Digite um valor, por exemplo 100,00.';
    else if (incrementCents < 100) e.increment = 'O incremento mínimo é R$ 1,00.';
    const now = serverNow();
    const start = startNow ? now : Date.parse(startsAt);
    const end = Date.parse(endsAt);
    if (!startNow && Number.isNaN(start)) e.startsAt = 'Escolha a data e hora de início.';
    if (Number.isNaN(end)) e.endsAt = 'Escolha a data e hora de término.';
    else if (end <= now) e.endsAt = 'O término precisa estar no futuro.';
    else if (!Number.isNaN(start) && end <= start) e.endsAt = 'O término precisa ser depois do início.';
    return e;
  };

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setError(null);
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length) {
      const first = document.querySelector<HTMLElement>('[aria-invalid="true"], #busca-obra');
      if (e.artwork) document.getElementById('busca-obra')?.focus();
      else first?.focus();
      return;
    }
    setSubmitting(true);
    try {
      const startIso = startNow ? new Date(serverNow()).toISOString() : new Date(startsAt).toISOString();
      const lot = await apiFetch<LotDetail>('/api/lots', {
        method: 'POST',
        body: {
          artworkId: artwork!.id,
          startingPriceCents: startingCents,
          minIncrementCents: incrementCents,
          startsAt: startIso,
          endsAt: new Date(endsAt).toISOString(),
          ...(description.trim() ? { description: description.trim() } : {}),
        },
      });
      push({ tone: 'success', title: 'Lote criado', message: lot.phase === 'LIVE' ? 'O pregão já está aberto.' : 'O pregão abre no horário marcado.' });
      router.push(`/lotes/${lot.id}`);
    } catch (err) {
      setError(err);
      setSubmitting(false);
    }
  };

  // Preview do card
  const preview: LotSummary | null = useMemo(() => {
    if (!artwork) return null;
    const now = new Date(serverNow()).toISOString();
    const s = startNow ? now : startsAt ? new Date(startsAt).toISOString() : now;
    const end = endsAt ? new Date(endsAt).toISOString() : now;
    const sc = startingCents ?? 0;
    return {
      id: 'preview',
      lotId: 'preview',
      title: artwork.title,
      imageUrl: artwork.imageUrl,
      attributes: {
        artist: artwork.artist,
        date: artwork.dateLabel,
        medium: artwork.medium,
        dimensions: artwork.dimensions,
        origin: artwork.origin,
        source: 'aic',
        externalId: artwork.externalId,
      },
      startingPriceCents: sc,
      minIncrementCents: incrementCents ?? 0,
      originalEndsAt: end,
      auctioneerName: '',
      phase: startNow || Date.parse(s) <= Date.parse(now) ? 'LIVE' : 'SCHEDULED',
      currentPriceCents: null,
      bidCount: 0,
      leaderAlias: null,
      minNextBidCents: sc,
      startsAt: s,
      endsAt: end,
      extended: false,
      settled: false,
      winnerAlias: null,
      finalPriceCents: null,
      serverTime: now,
    };
  }, [artwork, startNow, startsAt, endsAt, startingCents, incrementCents]);

  const blurMoney = (setter: (v: string) => void, v: string) => {
    const c = parseBRLToCents(v);
    if (c !== null) setter(centsToInput(c));
  };

  return (
    <Container className="pt-10">
      <PageTitle
        sub={
          <>
            Escolha uma obra, defina valores e prazo. Lances nos últimos 2 minutos prorrogam o fim em 2 minutos.{' '}
            <Link href="/painel" className="underline underline-offset-4">
              Voltar ao painel
            </Link>
          </>
        }
      >
        Novo lote
      </PageTitle>

      <ArtworkSearch
        selected={artwork}
        onSelect={(a) => {
          setArtwork(a);
          setErrors((e) => ({ ...e, artwork: undefined }));
        }}
      />
      {errors.artwork && (
        <p role="alert" className="mt-3 text-sm text-lacre">
          {errors.artwork}
        </p>
      )}

      <div className="mt-14 grid gap-12 border-t border-ink pt-10 lg:grid-cols-[1fr_20rem]">
        <form onSubmit={submit} noValidate className="flex flex-col gap-6">
          <h2 className="display text-2xl">Condições do pregão</h2>
          {artwork ? (
            <p className="text-sm">
              Obra escolhida: <span className="font-semibold">{artwork.title}</span>
              {artwork.artist ? `, ${artwork.artist}` : ''}
            </p>
          ) : (
            <p className="text-sm text-muted">Nenhuma obra escolhida ainda.</p>
          )}

          <div className="grid gap-6 sm:grid-cols-2">
            <Field label="Lance inicial" htmlFor="inicial" error={errors.starting} hint="Valor do primeiro lance aceito.">
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden>
                  R$
                </span>
                <input
                  id="inicial"
                  inputMode="decimal"
                  value={starting}
                  onChange={(e) => setStarting(e.target.value)}
                  onBlur={(e) => blurMoney(setStarting, e.target.value)}
                  aria-invalid={Boolean(errors.starting) || undefined}
                  aria-describedby={errors.starting ? 'inicial-error' : 'inicial-hint'}
                  className={clsx(inputClass, 'num pl-10')}
                />
              </div>
            </Field>
            <Field label="Incremento mínimo" htmlFor="incremento" error={errors.increment} hint="Cada novo lance supera o atual em pelo menos este valor.">
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden>
                  R$
                </span>
                <input
                  id="incremento"
                  inputMode="decimal"
                  value={increment}
                  onChange={(e) => setIncrement(e.target.value)}
                  onBlur={(e) => blurMoney(setIncrement, e.target.value)}
                  aria-invalid={Boolean(errors.increment) || undefined}
                  aria-describedby={errors.increment ? 'incremento-error' : 'incremento-hint'}
                  className={clsx(inputClass, 'num pl-10')}
                />
              </div>
            </Field>
          </div>

          <fieldset className="flex flex-col gap-3">
            <legend className="mb-2 text-sm font-semibold">Início</legend>
            <label className="flex items-center gap-3 text-sm">
              <input type="radio" name="inicio" checked={startNow} onChange={() => setStartNow(true)} className="h-4 w-4 accent-[var(--lacre)]" />
              Abrir agora (o lote entra ao vivo assim que for criado)
            </label>
            <label className="flex items-center gap-3 text-sm">
              <input type="radio" name="inicio" checked={!startNow} onChange={() => setStartNow(false)} className="h-4 w-4 accent-[var(--lacre)]" />
              Agendar para depois
            </label>
            {!startNow && (
              <Field label="Data e hora de início" htmlFor="inicio-em" error={errors.startsAt}>
                <input
                  id="inicio-em"
                  type="datetime-local"
                  value={startsAt}
                  onChange={(e) => setStartsAt(e.target.value)}
                  aria-invalid={Boolean(errors.startsAt) || undefined}
                  className={clsx(inputClass, 'num sm:max-w-xs')}
                />
              </Field>
            )}
          </fieldset>

          <Field label="Data e hora de término" htmlFor="fim" error={errors.endsAt} hint="Horário do seu dispositivo.">
            <input
              id="fim"
              type="datetime-local"
              value={endsAt}
              onChange={(e) => setEndsAt(e.target.value)}
              aria-invalid={Boolean(errors.endsAt) || undefined}
              aria-describedby={errors.endsAt ? 'fim-error' : 'fim-hint'}
              className={clsx(inputClass, 'num sm:max-w-xs')}
            />
          </Field>

          <Field label="Descrição (opcional)" htmlFor="descricao" hint="Aparece na sala do lote, abaixo dos dados da obra.">
            <textarea
              id="descricao"
              rows={4}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={2000}
              className={clsx(inputClass, 'h-auto py-2')}
            />
          </Field>

          <InlineError error={error} />
          <div>
            <Button type="submit" size="lg" loading={submitting}>
              {startNow ? 'Criar lote e abrir pregão' : 'Criar lote agendado'}
            </Button>
          </div>
        </form>

        <aside aria-label="Prévia do card na vitrine" className="lg:sticky lg:top-24 lg:self-start">
          <p className="mb-3 text-sm text-muted">Como aparece na vitrine</p>
          {preview ? (
            <div className="pointer-events-none">
              <LotCard lot={preview} offset={0} />
            </div>
          ) : (
            <div className="mat flex aspect-[4/5] items-center justify-center p-6 text-center text-sm text-muted">A prévia aparece quando você escolher uma obra.</div>
          )}
          {startingCents !== null && incrementCents !== null && startingCents >= 100 && incrementCents >= 100 && (
            <p className="num mt-4 text-sm text-muted">
              Lances: {formatBRL(startingCents)}, depois {formatBRL(startingCents + incrementCents)}, {formatBRL(startingCents + incrementCents * 2)}…
            </p>
          )}
        </aside>
      </div>
    </Container>
  );
}
