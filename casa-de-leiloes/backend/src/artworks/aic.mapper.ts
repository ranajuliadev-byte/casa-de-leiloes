import { Prisma } from '@prisma/client';
import type { AicArtwork } from './aic.client';
import { storableText } from '../common/text';

/**
 * Mapeamento puro AIC → cache de obras (sem Nest nem banco). Usado pelo
 * ArtworksService e pelo seed.
 */

const iiif = (imageId: string, width: number) => `https://www.artic.edu/iiif/2/${imageId}/full/${width},/0/default.jpg`;

/** Miniatura do Commons na largura pedida (o Special:FilePath redireciona para o CDN). */
export function commonsThumb(fileUrl: string, width: number): string {
  return `${fileUrl.replace(/^http:\/\//, 'https://')}?width=${width}`;
}

export function artworkKey(externalId: number) {
  return `aic:${externalId}`;
}

/**
 * Converte o registro do AIC para o formato salvo no cache do banco.
 * `commonsFile`: imagem da obra no Wikimedia Commons (ver wikimedia.client.ts); quando
 * existe, substitui o IIIF do AIC, que hoje bloqueia <img> com desafio anti-bot.
 */
export function fromAic(a: AicArtwork, commonsFile?: string): Prisma.ArtworkCreateInput {
  const clean = (s: string | null | undefined) => (s && s.trim() ? storableText(s.trim()) : null);
  const image = (width: number) => (commonsFile ? commonsThumb(commonsFile, width) : a.image_id ? iiif(a.image_id, width) : null);
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
    imageUrl: image(843),
    thumbUrl: image(200),
    raw: a as unknown as Prisma.InputJsonValue,
  };
}

/** Imagem servida pelo Wikimedia Commons (as do IIIF do AIC estão bloqueadas para <img>). */
export function isCommonsUrl(url: string | null | undefined): boolean {
  return !!url && url.startsWith('https://commons.wikimedia.org/');
}
