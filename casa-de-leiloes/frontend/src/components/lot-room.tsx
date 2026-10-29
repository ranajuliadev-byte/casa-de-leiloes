'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { ArrowLeft, ShieldAlert, ShieldCheck, TrendingDown, Trophy } from 'lucide-react';
import { derivePhase, useLotRoom } from '@/lib/socket';
import { useCountdown, useServerDerived } from '@/lib/time';
import { compareWitness } from '@/lib/witness';
import { describeDuration, formatBRL, formatCountdown, formatDateLong, formatTime, plural, shortHash } from '@/lib/format';
import type { LotDetail } from '@/lib/types';
import { isApiError } from '@/lib/api';
import { useAuth } from './auth-provider';
import { BidForm } from './bid-form';
import { PhaseTag } from './lot-bits';
import { displayPrice } from './lot-card';
import { ArtworkImage, buttonClass, Container, ErrorState, PageLoading } from './ui';

// ---------- relógio grande ----------
function BigClock({ lot, offset }: { lot: LotDetail; offset: number }) {
  const target = lot.phase === 'SCHEDULED' ? lot.startsAt : lot.phase === 'LIVE' ? lot.endsAt : null;
  const cd = useCountdown(target, offset, 250);
  // Anúncio para leitor de tela só a cada mudança de minuto (não a cada 250 ms)
  const minuteKey = cd.ready ? Math.ceil(cd.remainingMs / 60000) : -1;

  if (lot.phase === 'ENDED' || lot.phase === 'CANCELLED') {
    return (
      <div>
        <p className="text-sm text-muted">{lot.phase === 'CANCELLED' ? 'Cancelado' : 'Encerrado em'}</p>
        <p className="num text-lg">{formatDateLong(lot.endsAt)}</p>
        {lot.phase === 'ENDED' && !lot.settled && <p className="mt-2 text-sm text-muted">Apurando o resultado…</p>}
      </div>
    );
  }

  const label = lot.phase === 'SCHEDULED' ? 'Abre em' : 'Termina em';
  return (
    <div>
      <p className="text-sm text-muted">{label}</p>
      <p
        className={clsx(
          'num display text-5xl leading-none tracking-tight',
          lot.phase === 'LIVE' && cd.critical && 'text-lacre',
        )}
        aria-hidden
      >
        {cd.ready ? (cd.done ? '00:00' : formatCountdown(cd.remainingMs)) : '--:--'}
      </p>
      <p className="sr-only" aria-live="polite">
        {minuteKey >= 0 && `${label} ${describeDuration(cd.remainingMs)}`}
      </p>
      {lot.phase === 'LIVE' && cd.done && <p className="mt-2 text-sm text-muted">Encerrando o pregão…</p>}
      {lot.phase === 'SCHEDULED' && cd.done && <p className="mt-2 text-sm text-muted">Abrindo o pregão…</p>}
      {lot.phase === 'LIVE' && !cd.done && (
        <p className={clsx('mt-3 text-sm', cd.critical ? 'font-semibold text-lacre' : 'text-muted')}>
          {cd.critical ? 'Reta final: ' : ''}lances nos últimos 2 min prorrogam o fim em 2 min.
        </p>
      )}
      {lot.extended && lot.phase === 'LIVE' && (
        <p className="mt-1 text-sm text-ink-soft">Fim prorrogado. Previsto originalmente para {formatTime(lot.originalEndsAt)}.</p>
      )}
      {lot.phase === 'SCHEDULED' && <p className="mt-2 text-sm text-muted">Início em {formatDateLong(lot.startsAt)}</p>}
    </div>
  );
}

// ---------- "Você está ganhando" / "Você foi superado" ----------
function StandingBanner({ lot }: { lot: LotDetail }) {
  const v = lot.viewer;
  if (!v || v.role !== 'BIDDER' || v.myHighestBidCents === null) return null;
  const ended = lot.phase === 'ENDED';

  if (v.isLeader) {
    return (
      <div role="status" aria-live="polite" className="flex items-start gap-4 border-l-4 border-ok bg-ok-soft p-5">
        <Trophy className="mt-1 h-7 w-7 shrink-0 text-ok" aria-hidden />
        <div>
          <p className="display text-2xl font-medium leading-tight text-ok sm:text-3xl">{ended ? 'Você arrematou' : 'Você está ganhando'}</p>
          <p className="num mt-1 text-sm text-ink-soft">
            Seu lance de {formatBRL(v.myHighestBidCents)} lidera{v.alias ? `, como ${v.alias}` : ''}.
            {!ended && ' O valor está reservado na sua carteira.'}
          </p>
        </div>
      </div>
    );
  }
  return (
    <div role="status" aria-live="polite" className="flex items-start gap-4 border-l-4 border-lacre bg-lacre-soft p-5">
      <TrendingDown className="mt-1 h-7 w-7 shrink-0 text-lacre" aria-hidden />
      <div>
        <p className="display text-2xl font-medium leading-tight text-lacre sm:text-3xl">{ended ? 'Não arrematado' : 'Você foi superado'}</p>
        <p className="num mt-1 text-sm text-ink-soft">
          Seu maior lance foi {formatBRL(v.myHighestBidCents)}
          {v.position ? `, ${v.position}º lugar entre os licitantes` : ''}.
          {!ended && ` Para voltar à frente: ${formatBRL(lot.minNextBidCents)}.`}
        </p>
      </div>
    </div>
  );
}

// ---------- histórico ----------
function BidHistory({ lot, freshBidId }: { lot: LotDetail; freshBidId: string | null }) {
  const myAlias = lot.viewer?.alias ?? null;
  return (
    <section aria-labelledby="hist-titulo" className="mt-12">
      <div className="flex items-baseline justify-between gap-4 border-b border-ink pb-3">
        <h2 id="hist-titulo" className="display text-2xl">
          Lances
        </h2>
        <Link href={`/auditoria/${lot.id}`} className="inline-flex items-center gap-1.5 text-sm font-semibold underline-offset-4 hover:underline">
          <ShieldCheck className="h-4 w-4" aria-hidden />
          Auditar histórico
        </Link>
      </div>
      {lot.bids.length === 0 ? (
        <p className="py-8 text-muted">
          {lot.phase === 'ENDED' ? 'Este lote encerrou sem lances.' : `Nenhum lance ainda. O primeiro precisa ser de pelo menos ${formatBRL(lot.startingPriceCents)}.`}
        </p>
      ) : (
        <ol className="divide-y divide-rule" aria-live="polite" aria-relevant="additions" aria-label="Histórico de lances, mais recente primeiro">
          {lot.bids.map((b, i) => {
            const mine = myAlias !== null && b.bidderAlias === myAlias;
            const leading = i === 0;
            return (
              <li key={b.id} className={clsx('grid grid-cols-[auto_1fr_auto] items-baseline gap-x-4 py-3', b.id === freshBidId && 'arrive')}>
                <span className="num w-8 text-sm text-muted">{b.sequence}</span>
                <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
                  <span className="whitespace-nowrap">
                    <span className={clsx(mine && 'font-semibold')}>{b.bidderAlias}</span>
                    {mine && <span className="ml-2 bg-ink px-1.5 py-px text-xs font-semibold text-paper">você</span>}
                  </span>
                  <span className="num text-sm text-muted">{formatTime(b.createdAt)}</span>
                </span>
                <span className={clsx('num text-right', leading ? 'font-semibold' : 'text-ink-soft')}>{formatBRL(b.amountCents)}</span>
              </li>
            );
          })}
        </ol>
      )}
      {lot.bidCount > lot.bids.length && (
        <p className="mt-3 text-sm text-muted">
          Mostrando os {lot.bids.length} lances mais recentes de {lot.bidCount}. A lista completa está na{' '}
          <Link href={`/auditoria/${lot.id}`} className="underline underline-offset-4">
            auditoria
          </Link>
          .
        </p>
      )}
    </section>
  );
}

// ---------- coluna de ação ----------
function ActionPanel({ lot, onPlaced }: { lot: LotDetail; onPlaced: Parameters<typeof BidForm>[0]['onPlaced'] }) {
  const { user, wallet, loading } = useAuth();
  const v = lot.viewer;
  const isBidder = Boolean(user && user.role === 'BIDDER' && v?.role !== 'AUCTIONEER');

  if (lot.phase === 'ENDED') {
    return (
      <div className="flex flex-col gap-6">
        <div className="border-t border-rule pt-5">
          {lot.winnerAlias || lot.bidCount > 0 ? (
            <p className="text-ink-soft">
              Arrematado por <span className="font-semibold text-ink">{lot.winnerAlias ?? lot.leaderAlias}</span>
              {lot.settled ? '.' : '. Liquidação em andamento.'}
            </p>
          ) : (
            <p className="text-ink-soft">Encerrado sem lances. A obra não foi vendida.</p>
          )}
        </div>
        {/* Discreto: o pregão acabou, mas quem tentar recebe a recusa do servidor com o motivo. */}
        {!loading && isBidder && (
          <div className="opacity-90">
            <BidForm
              key="ENDED"
              lot={lot}
              onPlaced={onPlaced}
              compact
              notice={<>Pregão encerrado. Lances enviados agora são recusados pelo servidor.</>}
            />
          </div>
        )}
      </div>
    );
  }
  if (lot.phase === 'CANCELLED') {
    return <p className="border-t border-rule pt-5 text-ink-soft">O leiloeiro cancelou este lote. Lances reservados foram devolvidos às carteiras.</p>;
  }

  if (loading) return null;

  if (!user) {
    return (
      <div className="border border-rule-strong p-5">
        <p className="display text-xl">Quer participar deste pregão?</p>
        <p className="mt-1 text-sm text-muted">Crie uma conta de licitante, deposite saldo na carteira e dê seu lance.</p>
        <div className="mt-4 flex flex-wrap gap-3">
          <Link href={`/entrar?voltar=/lotes/${lot.id}`} className={buttonClass('primary')}>
            Entrar para dar lance
          </Link>
          <Link href={`/cadastro?voltar=/lotes/${lot.id}`} className={buttonClass('secondary')}>
            Criar conta
          </Link>
        </div>
      </div>
    );
  }

  if (user.role === 'AUCTIONEER' || v?.role === 'AUCTIONEER') {
    return (
      <div className="border border-rule-strong p-5 text-sm text-ink-soft">
        {v?.isOwner ? (
          <>
            Este lote é seu. Você acompanha o pregão em tempo real, mas leiloeiros não dão lances.{' '}
            <Link href="/painel" className="font-semibold text-ink underline underline-offset-4">
              Ir ao painel
            </Link>
          </>
        ) : (
          'Você entrou como leiloeiro. Leiloeiros acompanham os pregões, mas não dão lances.'
        )}
      </div>
    );
  }

  // O formulário fica disponível em todas as fases: o servidor decide e a recusa aparece inline com o motivo.
  const notice =
    lot.phase === 'SCHEDULED' ? (
      <>
        Os lances abrem em <span className="num font-semibold text-ink">{formatDateLong(lot.startsAt)}</span>. Antes disso, o servidor recusa o lance. O
        primeiro precisa ser de pelo menos {formatBRL(lot.startingPriceCents)}.
      </>
    ) : v?.isLeader ? (
      <>
        <span className="font-semibold text-ink">Você já está ganhando</span> — cobrir o próprio lance não é permitido. Se alguém cobrir, você poderá dar
        outro.
      </>
    ) : undefined;

  return (
    <div className="flex flex-col gap-5">
      <BidForm key={lot.phase} lot={lot} onPlaced={onPlaced} notice={notice} />
      {wallet && (
        <dl className="num grid grid-cols-2 gap-4 border-t border-rule pt-4 text-sm">
          <div>
            <dt className="text-muted">Disponível</dt>
            <dd className="text-lg font-semibold">{formatBRL(wallet.availableCents)}</dd>
          </div>
          <div>
            <dt className="text-muted">Reservado em lances</dt>
            <dd className="text-lg">{formatBRL(wallet.committedCents)}</dd>
          </div>
          <div className="col-span-2">
            <Link href="/carteira" className="text-sm font-semibold underline underline-offset-4">
              Depositar na carteira
            </Link>
          </div>
        </dl>
      )}
    </div>
  );
}

// ---------- valor atual com animação ao mudar ----------
function CurrentPrice({ lot }: { lot: LotDetail }) {
  const price = displayPrice(lot);
  const prev = useRef(price);
  const [bumpKey, setBumpKey] = useState(0);
  useEffect(() => {
    if (prev.current !== price) {
      prev.current = price;
      setBumpKey((k) => k + 1);
    }
  }, [price]);

  const label = lot.phase === 'ENDED' ? (lot.bidCount ? 'Valor de arremate' : 'Lance inicial') : lot.bidCount ? 'Lance atual' : 'Lance inicial';
  return (
    <div>
      <p className="text-sm text-muted">{label}</p>
      <p aria-live="polite" aria-atomic className="num display text-5xl font-medium leading-none tracking-tight sm:text-[4rem]">
        <span key={bumpKey} className={clsx('inline-block', bumpKey > 0 && 'bump')}>
          {formatBRL(price)}
        </span>
      </p>
      <p className="num mt-2 text-sm text-muted">
        {plural(lot.bidCount, 'lance', 'lances')}
        {lot.leaderAlias && lot.phase === 'LIVE' ? `, liderando: ${lot.leaderAlias}` : ''}
      </p>
      {lot.phase === 'LIVE' && (
        <p className="num mt-1 text-sm">
          Próximo lance mínimo: <span className="font-semibold">{formatBRL(lot.minNextBidCents)}</span>
        </p>
      )}
    </div>
  );
}

// ---------- página ----------
// ---------- testemunha: o histórico atual contradiz o que este navegador já viu? ----------
function WitnessAlert({ lot, lotId }: { lot: LotDetail; lotId: string }) {
  // Lido no render, antes do efeito que registra o estado atual (hashes já vistos nunca são
  // sobrescritos). Memoizado: lê o localStorage só quando o histórico muda, não a cada tique.
  const cmp = useMemo(() => {
    const maxSeq = lot.bids.reduce((m, b) => Math.max(m, b.sequence), 0);
    return compareWitness(lotId, lot.bids, Math.max(lot.bidCount, maxSeq), false);
  }, [lotId, lot.bids, lot.bidCount]);
  if (!cmp?.alert) return null;
  return (
    <div role="alert" className="flex items-start gap-3 border-2 border-lacre bg-lacre-soft p-4 text-sm">
      <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-lacre" aria-hidden />
      <p>
        <span className="font-semibold text-lacre">
          Este navegador já viu {cmp.seenCount} {cmp.seenCount === 1 ? 'lance' : 'lances'} neste lote
          {cmp.lastSeenHash ? ` (último hash ${shortHash(cmp.lastSeenHash, 12)})` : ''}.
        </span>{' '}
        {cmp.fewer ? 'O histórico atual tem menos lances' : 'O histórico atual diverge'} — possível remoção ou reescrita.{' '}
        <Link href={`/auditoria/${lot.id}`} className="font-semibold underline underline-offset-4">
          Ver auditoria
        </Link>
      </p>
    </div>
  );
}

const PHASE_CODE: Record<LotDetail['phase'], number> = { SCHEDULED: 0, LIVE: 1, ENDED: 2, CANCELLED: 3 };
const CODE_PHASE: LotDetail['phase'][] = ['SCHEDULED', 'LIVE', 'ENDED', 'CANCELLED'];

export function LotRoom({ lotId }: { lotId: string }) {
  const { lot: serverLot, error, loading, offset, freshBidId, refetch, applyLocal } = useLotRoom(lotId);

  // Fase exibida: derivada do relógio do servidor para a sala virar na hora exata;
  // o estado autoritativo chega em seguida pelo refetch agendado em useLotRoom.
  const phaseCode = useServerDerived(
    offset,
    (now) => (serverLot ? PHASE_CODE[derivePhase(serverLot, now)] : -1),
    serverLot ? PHASE_CODE[serverLot.phase] : -1,
  );
  const lot: LotDetail | null =
    serverLot && phaseCode >= 0 && CODE_PHASE[phaseCode] !== serverLot.phase ? { ...serverLot, phase: CODE_PHASE[phaseCode] } : serverLot;

  if (loading && !lot) return <PageLoading label="Entrando na sala…" />;
  if (!lot) {
    const notFound = isApiError(error) && error.status === 404;
    return (
      <Container className="py-20">
        <ErrorState
          error={error}
          title={notFound ? 'Lote não encontrado' : undefined}
          onRetry={notFound ? undefined : () => void refetch()}
        />
        <Link href="/" className="mt-8 inline-flex items-center gap-2 text-sm font-semibold underline-offset-4 hover:underline">
          <ArrowLeft className="h-4 w-4" aria-hidden /> Voltar à vitrine
        </Link>
      </Container>
    );
  }

  const a = lot.attributes;
  const facts: [string, string | null][] = [
    ['Artista', a.artist],
    ['Data', a.date],
    ['Técnica', a.medium],
    ['Dimensões', a.dimensions],
    ['Origem', a.origin],
  ];

  return (
    <Container className="pt-6 sm:pt-10">
      <Link href="/" className="no-print inline-flex items-center gap-2 text-sm text-ink-soft hover:text-ink">
        <ArrowLeft className="h-4 w-4" aria-hidden /> Vitrine
      </Link>

      <div className="mt-6 grid gap-10 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:gap-14">
        {/* Obra */}
        <div>
          <ArtworkImage src={lot.imageUrl} alt={lot.title} eager className="aspect-[4/5] w-full p-8 sm:p-14 lg:sticky lg:top-24" imgClassName="drop-shadow-[0_10px_24px_rgb(0_0_0/0.22)]" />
        </div>

        {/* Pregão */}
        <div className="flex flex-col gap-8">
          <header>
            <PhaseTag phase={lot.phase} extended={lot.extended} />
            <h1 className="display mt-3 text-4xl leading-[1.05] sm:text-5xl">{lot.title}</h1>
            <p className="mt-2 text-lg text-ink-soft">{a.artist ?? 'Autoria desconhecida'}</p>
          </header>

          <WitnessAlert lot={lot} lotId={lotId} />
          <StandingBanner lot={lot} />

          <div className="grid gap-6 border-y border-rule py-6 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start lg:grid-cols-1">
            <CurrentPrice lot={lot} />
            <BigClock lot={lot} offset={offset} />
          </div>

          <ActionPanel lot={lot} onPlaced={(state, bid) => applyLocal(state, bid)} />

          <section aria-labelledby="obra-titulo">
            <h2 id="obra-titulo" className="display text-2xl">
              Sobre a obra
            </h2>
            <dl className="mt-4 grid grid-cols-[8rem_1fr] gap-x-4 gap-y-2 text-sm">
              {facts
                .filter(([, v]) => v)
                .map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-muted">{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              <dt className="text-muted">Leiloeiro</dt>
              <dd>{lot.auctioneerName}</dd>
              <dt className="text-muted">Lance inicial</dt>
              <dd className="num">{formatBRL(lot.startingPriceCents)}</dd>
              <dt className="text-muted">Incremento</dt>
              <dd className="num">{formatBRL(lot.minIncrementCents)}</dd>
            </dl>
            {lot.description && <p className="display mt-6 max-w-[62ch] text-lg leading-relaxed text-ink-soft">{lot.description}</p>}
            <p className="mt-4 text-xs text-muted">
              Imagem e dados: Art Institute of Chicago{a.externalId ? `, obra nº ${a.externalId}` : ''}.
            </p>
          </section>
        </div>
      </div>

      <BidHistory lot={lot} freshBidId={freshBidId} />
      {lot.bids[0] && (
        <p className="num mt-4 text-xs text-muted">
          Hash do último lance: <code>{shortHash(lot.bids[0].hash, 16)}</code>
        </p>
      )}
    </Container>
  );
}
