'use client';

import clsx from 'clsx';
import { describeDuration, formatCountdown, formatDateShort } from '@/lib/format';
import { useCountdown } from '@/lib/time';
import type { LotPhase } from '@/lib/types';

export function PhaseTag({ phase, extended, className }: { phase: LotPhase; extended?: boolean; className?: string }) {
  return (
    <span className={clsx('inline-flex items-center gap-2 text-sm', className)}>
      {phase === 'LIVE' && (
        <>
          <span className="red-dot live" aria-hidden />
          <span className="font-semibold">Ao vivo</span>
        </>
      )}
      {phase === 'SCHEDULED' && <span className="font-semibold text-ink-soft">Agendado</span>}
      {phase === 'ENDED' && <span className="font-semibold text-muted">Encerrado</span>}
      {phase === 'CANCELLED' && <span className="font-semibold text-lacre">Cancelado</span>}
      {extended && phase === 'LIVE' && (
        <span className="border border-lacre px-1.5 py-px text-xs font-semibold text-lacre" title="Recebeu lance nos últimos 2 minutos e o fim foi adiado">
          Prorrogado
        </span>
      )}
    </span>
  );
}

/**
 * Relógio compacto para cards: conta até o fim (ao vivo) ou até o início (agendado).
 * Quando zera, mostra o estado aguardando o servidor confirmar a mudança de fase.
 */
export function MiniClock({
  phase,
  startsAt,
  endsAt,
  offset,
}: {
  phase: LotPhase;
  startsAt: string;
  endsAt: string;
  offset: number;
}) {
  const target = phase === 'SCHEDULED' ? startsAt : endsAt;
  const cd = useCountdown(phase === 'ENDED' || phase === 'CANCELLED' ? null : target, offset, 1000);

  if (phase === 'ENDED') return <span className="text-sm text-muted">Encerrou em {formatDateShort(endsAt)}</span>;
  if (phase === 'CANCELLED') return null;
  if (!cd.ready) return <span className="num text-sm text-muted">&nbsp;</span>;

  if (phase === 'SCHEDULED') {
    if (cd.done) return <span className="text-sm text-muted">Abrindo…</span>;
    // Mais de 1 dia: data fica mais legível que contador
    if (cd.remainingMs > 24 * 3600 * 1000) return <span className="text-sm text-muted">Abre {formatDateShort(startsAt)}</span>;
    return (
      <span className="num text-sm text-muted">
        Abre em <span className="text-ink">{formatCountdown(cd.remainingMs)}</span>
      </span>
    );
  }

  if (cd.done) return <span className="text-sm text-muted">Encerrando…</span>;
  return (
    <span className={clsx('num text-sm', cd.critical ? 'font-semibold text-lacre' : 'text-muted')} aria-label={`Termina em ${describeDuration(cd.remainingMs)}`}>
      Termina em <span className={cd.critical ? '' : 'text-ink'}>{formatCountdown(cd.remainingMs)}</span>
    </span>
  );
}
