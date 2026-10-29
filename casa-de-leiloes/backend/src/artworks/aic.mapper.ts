import { Prisma } from '@prisma/client';
import type { AicArtwork } from './aic.client';
import { storableText } from '../common/text';

/**
 * Mapeamento puro AIC → cache de obras (sem Nest nem banco). Usado pelo
 * ArtworksService e pelo seed.
 */

const iiif = (imageId: string, width: number) => `https://www.artic.edu/iiif/2/${imageId}/full/${width},/0/default.jpg`;

export function artworkKey(externalId: number) {
  return `aic:${externalId}`;
}

/** Converte o registro do AIC para o formato salvo no cache do banco. */
export function fromAic(a: AicArtwork): Prisma.ArtworkCreateInput {
  const clean = (s: string | null | undefined) => (s && s.trim() ? storableText(s.trim()) : null);
  return {
    id: artworkKey(a.id),
    externalId: a.id,
    source: 'aic',
    title: clean(a.title) ?? 'Sem título',
    artist: clean(a.artist_display),
    dateLabel: clean(a.date_display),
    medium: clean(a.medium_display),
    dimensions: clean(a.dimensions),
    origin: clean(a.place_of_origin),
    imageUrl: a.image_id ? iiif(a.image_id, 843) : null,
    thumbUrl: a.image_id ? iiif(a.image_id, 200) : null,
    raw: a as unknown as Prisma.InputJsonValue,
  };
}
