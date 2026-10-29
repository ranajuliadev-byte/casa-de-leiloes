import { Injectable, Logger } from '@nestjs/common';
import { Artwork, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Clock } from '../common/clock';
import { AppError } from '../common/errors';
import { AicArtwork, AicClient, AicError, AIC_PAGE_SIZE, AicSearchResult } from './aic.client';
import { CircuitBreaker } from './circuit-breaker';
import { artworkKey, fromAic } from './aic.mapper';

/** Ver docs/CONTRATO.md → ArtworkView */
export interface ArtworkView {
  id: string;
  externalId: number;
  title: string;
  artist: string | null;
  dateLabel: string | null;
  medium: string | null;
  dimensions: string | null;
  origin: string | null;
  imageUrl: string | null;
  thumbUrl: string | null;
}

export interface ArtworkSearchResponse {
  items: ArtworkView[];
  page: number;
  totalPages: number;
  source: 'live' | 'cache';
  degraded: boolean;
}

export const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;
const RETRY_BACKOFF_MS = 300;
// A busca do AIC (Elasticsearch) não pagina além de 1000 resultados.
const AIC_MAX_RESULTS = 1000;
const MAX_LIVE_PAGE = Math.floor(AIC_MAX_RESULTS / AIC_PAGE_SIZE);

export function toArtworkView(a: Pick<Artwork, keyof ArtworkView>): ArtworkView {
  return {
    id: a.id,
    externalId: a.externalId,
    title: a.title,
    artist: a.artist,
    dateLabel: a.dateLabel,
    medium: a.medium,
    dimensions: a.dimensions,
    origin: a.origin,
    imageUrl: a.imageUrl,
    thumbUrl: a.thumbUrl,
  };
}

/**
 * Integração resiliente com a API pública do Art Institute of Chicago:
 * timeout (no AicClient) → 1 retry → circuit breaker → cache em memória → cache no banco.
 * A busca NUNCA devolve 500: no pior caso responde do banco com `degraded: true`.
 */
@Injectable()
export class ArtworksService {
  private readonly logger = new Logger('Artworks');
  private readonly memory = new Map<string, { at: number; value: ArtworkSearchResponse }>();
  readonly breaker: CircuitBreaker;
  /** Exposto para os testes zerarem a espera do retry. */
  retryBackoffMs = RETRY_BACKOFF_MS;

  constructor(
    private readonly prisma: PrismaService,
    private readonly aic: AicClient,
    private readonly clock: Clock,
  ) {
    this.breaker = new CircuitBreaker(() => this.clock.now().getTime(), 3, 30_000);
  }

  async search(qRaw: string | undefined, pageRaw: number | undefined): Promise<ArtworkSearchResponse> {
    const q = (qRaw ?? '').trim();
    const page = Math.max(1, Math.floor(pageRaw ?? 1));
    const key = `${q.toLowerCase()}|${page}`;

    const hit = this.memory.get(key);
    if (hit && this.clock.now().getTime() - hit.at < CACHE_TTL_MS) return hit.value;

    if (page > MAX_LIVE_PAGE) {
      return { items: [], page, totalPages: MAX_LIVE_PAGE, source: 'live', degraded: false };
    }

    let result: AicSearchResult | null = null;
    try {
      result = await this.callAic(() => this.aic.search(q, page, AIC_PAGE_SIZE));
    } catch (e) {
      this.logger.warn(`Busca na API externa falhou (${(e as Error).message}); usando cache local.`);
    }
    if (!result) return this.searchCache(q, page);

    // Obras sem imagem não servem para leilão.
    const rows = result.data.filter((a) => a && typeof a.id === 'number' && a.image_id).map(fromAic);
    await this.upsertMany(rows);

    const value: ArtworkSearchResponse = {
      items: rows.map((r) => toArtworkView(r as Artwork)),
      page,
      totalPages: Math.min(result.pagination?.total_pages ?? 1, MAX_LIVE_PAGE),
      source: 'live',
      degraded: false,
    };
    this.remember(key, value);
    return value;
  }

  /**
   * Obra para criar um lote: primeiro o cache do banco; se não houver, a API.
   * Aceita "aic:123" ou "123".
   */
  async getForLot(artworkId: string): Promise<Artwork> {
    const m = /^(?:aic:)?(\d{1,10})$/.exec(String(artworkId ?? '').trim());
    if (!m) throw new AppError('ARTWORK_NOT_FOUND', { artworkId });
    const externalId = Number(m[1]);
    const id = artworkKey(externalId);

    const cached = await this.prisma.artwork.findUnique({ where: { id } });
    if (cached) return cached;

    let found: AicArtwork | null;
    try {
      found = await this.callAic(() => this.aic.getById(externalId));
    } catch (e) {
      this.logger.warn(`Consulta da obra ${id} falhou (${(e as Error).message}).`);
      throw new AppError('EXTERNAL_API_UNAVAILABLE', { artworkId: id });
    }
    if (!found || !found.image_id) throw new AppError('ARTWORK_NOT_FOUND', { artworkId: id });
    const data = fromAic(found);
    return this.prisma.artwork.upsert({ where: { id }, create: data, update: { ...data, fetchedAt: this.clock.now() } });
  }

  /** Chamada à API com circuit breaker + 1 retry com backoff curto. */
  private async callAic<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.breaker.tryAcquire()) throw new AicError('network', undefined, 'circuit breaker aberto');
    try {
      let value: T;
      try {
        value = await fn();
      } catch (e) {
        if (e instanceof AicError && !e.retryable) throw e;
        await new Promise((r) => setTimeout(r, this.retryBackoffMs));
        value = await fn();
      }
      this.breaker.onSuccess();
      return value;
    } catch (e) {
      // 404 de uma obra específica não é "API fora do ar"
      if (e instanceof AicError && e.kind === 'http' && e.status === 404) this.breaker.onSuccess();
      else this.breaker.onFailure();
      throw e;
    }
  }

  /** Modo degradado: busca no cache do banco (ILIKE em título/artista). */
  private async searchCache(q: string, page: number): Promise<ArtworkSearchResponse> {
    try {
      const where: Prisma.ArtworkWhereInput = {
        imageUrl: { not: null },
        ...(q
          ? { OR: [{ title: { contains: q, mode: 'insensitive' } }, { artist: { contains: q, mode: 'insensitive' } }] }
          : {}),
      };
      const [total, rows] = await Promise.all([
        this.prisma.artwork.count({ where }),
        this.prisma.artwork.findMany({
          where,
          orderBy: [{ title: 'asc' }, { id: 'asc' }],
          skip: (page - 1) * AIC_PAGE_SIZE,
          take: AIC_PAGE_SIZE,
        }),
      ]);
      return {
        items: rows.map(toArtworkView),
        page,
        totalPages: Math.max(1, Math.ceil(total / AIC_PAGE_SIZE)),
        source: 'cache',
        degraded: true,
      };
    } catch (e) {
      this.logger.error(`Cache local de obras indisponível: ${(e as Error).message}`);
      return { items: [], page, totalPages: 1, source: 'cache', degraded: true };
    }
  }

  private async upsertMany(rows: Prisma.ArtworkCreateInput[]) {
    if (!rows.length) return;
    const fetchedAt = this.clock.now();
    try {
      // Transação em lote (array): não usa maxWait/timeout de transação interativa.
      await this.prisma.$transaction(
        rows.map((r) =>
          this.prisma.artwork.upsert({ where: { id: r.id }, create: { ...r, fetchedAt }, update: { ...r, fetchedAt } }),
        ),
      );
    } catch (e) {
      // Falha ao gravar o cache não pode derrubar a busca.
      this.logger.warn(`Falha ao gravar cache de obras: ${(e as Error).message}`);
    }
  }

  private remember(key: string, value: ArtworkSearchResponse) {
    if (this.memory.size >= CACHE_MAX_ENTRIES) {
      const oldest = this.memory.keys().next().value;
      if (oldest !== undefined) this.memory.delete(oldest);
    }
    this.memory.set(key, { at: this.clock.now().getTime(), value });
  }
}
