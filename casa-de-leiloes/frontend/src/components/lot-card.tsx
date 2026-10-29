'use client';

import Link from 'next/link';
import { ArtworkImage } from './ui';
import { MiniClock, PhaseTag } from './lot-bits';
import { formatBRL, plural } from '@/lib/format';
import type { LotSummary } from '@/lib/types';

export function priceLabel(lot: Pick<LotSummary, 'phase' | 'bidCount' | 'finalPriceCents' | 'settled'>) {
  if (lot.phase === 'CANCELLED') return lot.bidCount > 0 ? 'Último lance' : 'Lance inicial';
  if (lot.phase === 'ENDED') return lot.bidCount > 0 ? 'Arrematado por' : 'Sem lances';
  return lot.bidCount > 0 ? 'Lance atual' : 'Lance inicial';
}

export function displayPrice(lot: Pick<LotSummary, 'phase' | 'currentPriceCents' | 'startingPriceCents' | 'finalPriceCents' | 'bidCount'>) {
  if (lot.phase === 'ENDED' && lot.bidCount > 0) return lot.finalPriceCents ?? lot.currentPriceCents;
  return lot.currentPriceCents ?? lot.startingPriceCents;
}

export function LotCard({ lot, offset, priority }: { lot: LotSummary; offset: number; priority?: boolean }) {
  const price = displayPrice(lot);
  const ended = lot.phase === 'ENDED';
  return (
    <article className="group relative flex flex-col">
      <ArtworkImage
        src={lot.imageUrl}
        alt={lot.title}
        eager={priority}
        className="aspect-[4/5] w-full p-6 sm:p-8"
        imgClassName="drop-shadow-[0_6px_14px_rgb(0_0_0/0.18)] transition-transform duration-500 group-hover:scale-[1.015]"
      />
      <div className="flex flex-1 flex-col gap-3 pt-4">
        <div className="flex items-center justify-between gap-3">
          <PhaseTag phase={lot.phase} extended={lot.extended} />
          <span className="num text-sm text-muted">{plural(lot.bidCount, 'lance', 'lances')}</span>
        </div>
        <div>
          <h3 className="display text-xl leading-snug">
            <Link href={`/lotes/${lot.id}`} className="after:absolute after:inset-0 hover:underline hover:decoration-1 hover:underline-offset-4">
              {lot.title}
            </Link>
          </h3>
          <p className="mt-0.5 truncate text-sm text-ink-soft">{lot.attributes.artist ?? 'Autoria desconhecida'}</p>
        </div>
        <div className="mt-auto flex items-end justify-between gap-3 border-t border-rule pt-3">
          <div>
            <p className="text-xs text-muted">{priceLabel(lot)}</p>
            <p className={ended && lot.bidCount === 0 ? 'num text-base text-muted line-through decoration-1' : 'num text-lg font-semibold'}>
              {formatBRL(price)}
            </p>
          </div>
          <div className="text-right">
            <MiniClock phase={lot.phase} startsAt={lot.startsAt} endsAt={lot.endsAt} offset={offset} />
          </div>
        </div>
      </div>
    </article>
  );
}

export function LotCardSkeleton() {
  return (
    <div aria-hidden className="flex animate-pulse flex-col">
      <div className="mat aspect-[4/5] w-full" />
      <div className="mt-4 h-4 w-20 bg-mat" />
      <div className="mt-3 h-6 w-3/4 bg-mat" />
      <div className="mt-2 h-4 w-1/2 bg-mat" />
      <div className="mt-4 h-10 w-full bg-mat" />
    </div>
  );
}
