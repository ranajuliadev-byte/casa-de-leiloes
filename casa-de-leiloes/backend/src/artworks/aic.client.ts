import { Injectable } from '@nestjs/common';

/** Campos que pedimos à API do Art Institute of Chicago. */
export const AIC_FIELDS = 'id,title,artist_display,date_display,medium_display,dimensions,image_id,place_of_origin';
export const AIC_USER_AGENT = 'casa-de-leiloes (contato@exemplo.com)';
export const AIC_PAGE_SIZE = 12;

export interface AicArtwork {
  id: number;
  title: string | null;
  artist_display: string | null;
  date_display: string | null;
  medium_display: string | null;
  dimensions: string | null;
  image_id: string | null;
  place_of_origin: string | null;
}

export interface AicSearchResult {
  data: AicArtwork[];
  pagination: { total: number; total_pages: number; current_page: number; limit: number };
}

/** Falha ao falar com a API externa (timeout, rede, HTTP != 2xx, JSON inválido). */
export class AicError extends Error {
  constructor(
    public readonly kind: 'timeout' | 'network' | 'http' | 'parse',
    public readonly status?: number,
    message?: string,
  ) {
    super(message ?? `AIC ${kind}${status ? ` ${status}` : ''}`);
    this.name = 'AicError';
  }

  /** Vale a pena tentar de novo? (4xx que não seja 429 não muda com retry) */
  get retryable(): boolean {
    if (this.kind !== 'http') return true;
    return this.status === 429 || (this.status ?? 0) >= 500;
  }
}

/**
 * Cliente HTTP fino da API pública do AIC. Só faz a requisição com timeout;
 * retry, circuit breaker e cache ficam no ArtworksService.
 * Isolado numa classe injetável para ser mockado nos testes.
 */
@Injectable()
export class AicClient {
  baseUrl = (process.env.ARTWORKS_API_URL || 'https://api.artic.edu/api/v1').replace(/\/+$/, '');
  timeoutMs = 5000;

  async search(q: string, page: number, limit = AIC_PAGE_SIZE): Promise<AicSearchResult> {
    const params = new URLSearchParams({ page: String(page), limit: String(limit), fields: AIC_FIELDS });
    if (q) params.set('q', q);
    const body = await this.request(`/artworks/search?${params.toString()}`);
    if (!body || !Array.isArray(body.data) || !body.pagination) throw new AicError('parse');
    return body as AicSearchResult;
  }

  /** Obra pelo id externo; `null` se a API responder 404. */
  async getById(externalId: number): Promise<AicArtwork | null> {
    try {
      const body = await this.request(`/artworks/${externalId}?fields=${AIC_FIELDS}`);
      if (!body?.data || typeof body.data.id !== 'number') throw new AicError('parse');
      return body.data as AicArtwork;
    } catch (e) {
      if (e instanceof AicError && e.kind === 'http' && e.status === 404) return null;
      throw e;
    }
  }

  /** Várias obras pelos ids externos (ids inexistentes simplesmente não vêm). */
  async getMany(externalIds: number[]): Promise<AicArtwork[]> {
    const params = new URLSearchParams({ ids: externalIds.join(','), fields: AIC_FIELDS, limit: String(externalIds.length) });
    const body = await this.request(`/artworks?${params.toString()}`);
    if (!body || !Array.isArray(body.data)) throw new AicError('parse');
    return body.data as AicArtwork[];
  }

  private async request(path: string): Promise<any> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        headers: { 'AIC-User-Agent': AIC_USER_AGENT, Accept: 'application/json' },
        signal: ctrl.signal,
      });
    } catch (e) {
      throw ctrl.signal.aborted ? new AicError('timeout') : new AicError('network', undefined, (e as Error)?.message);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new AicError('http', res.status);
    try {
      return await res.json();
    } catch {
      throw new AicError('parse');
    }
  }
}
