import { Injectable, Logger, Optional } from '@nestjs/common';
import { Clock } from '../common/clock';
import { CircuitBreaker } from './circuit-breaker';

/**
 * Imagens das obras pelo Wikimedia Commons, via Wikidata.
 *
 * O servidor IIIF do Art Institute (www.artic.edu/iiif) passou a responder com um
 * desafio anti-bot do Cloudflare, que uma <img> não resolve (403). O Wikidata liga cada
 * obra do AIC (propriedade P4610, "Art Institute of Chicago artwork ID") à sua imagem no
 * Commons (P18). Melhoria best-effort: obra sem correspondência (ou Wikidata fora do ar)
 * fica sem arquivo do Commons e o chamador decide o que usar.
 *
 * Cache em memória (positivo 24 h, negativo 1 h) e circuit breaker próprio: com o
 * Wikidata lento, as buscas de obras não pagam o timeout a cada chamada.
 */

const SPARQL_URL = 'https://query.wikidata.org/sparql';
/** A política do Wikimedia pede User-Agent descritivo com contato. */
const USER_AGENT = 'casa-de-leiloes/1.0 (contato@exemplo.com)';
const TIMEOUT_MS = 3000;
const HIT_TTL_MS = 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX = 5000;

/** Só arquivos do Commons (a URL vai para o navegador como src de imagem). */
const COMMONS_FILE = /^https?:\/\/commons\.wikimedia\.org\/wiki\/Special:FilePath\//;

@Injectable()
export class WikimediaImages {
  private readonly logger = new Logger('Wikimedia');
  private readonly cache = new Map<number, { file: string | null; at: number }>();
  private readonly breaker: CircuitBreaker;

  /** Clock opcional: o seed usa o cliente fora do Nest. */
  constructor(@Optional() private readonly clock?: Clock) {
    this.breaker = new CircuitBreaker(() => this.now(), 3, 60_000);
  }

  private now(): number {
    return (this.clock?.now() ?? new Date()).getTime();
  }

  /** id externo do AIC → URL do arquivo no Commons (Special:FilePath). Ids sem imagem não entram. */
  async filesFor(externalIds: number[]): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    const now = this.now();
    const missing: number[] = [];
    for (const id of new Set(externalIds.filter((n) => Number.isSafeInteger(n) && n > 0))) {
      const hit = this.cache.get(id);
      if (hit && now - hit.at < (hit.file ? HIT_TTL_MS : MISS_TTL_MS)) {
        if (hit.file) out.set(id, hit.file);
      } else {
        missing.push(id);
      }
    }
    if (!missing.length || !this.breaker.tryAcquire()) return out;

    // Ids validados como inteiros: seguros para entrar no VALUES. ORDER BY: obra com
    // vários P18 sempre resolve para a mesma imagem.
    const query = `SELECT ?id ?image WHERE { VALUES ?id { ${missing.map((n) => `"${n}"`).join(' ')} } ?item wdt:P4610 ?id; wdt:P18 ?image } ORDER BY ?id ?image`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${SPARQL_URL}?${new URLSearchParams({ query }).toString()}`, {
        headers: { Accept: 'application/sparql-results+json', 'User-Agent': USER_AGENT },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { results?: { bindings?: Array<{ id?: { value?: string }; image?: { value?: string } }> } };
      const found = new Map<number, string>();
      for (const b of body.results?.bindings ?? []) {
        const id = Number(b.id?.value);
        const file = b.image?.value;
        if (Number.isSafeInteger(id) && file && COMMONS_FILE.test(file) && !found.has(id)) found.set(id, file);
      }
      this.breaker.onSuccess();
      if (this.cache.size > CACHE_MAX) this.cache.clear();
      for (const id of missing) {
        const file = found.get(id) ?? null;
        this.cache.set(id, { file, at: now });
        if (file) out.set(id, file);
      }
    } catch (e) {
      // Falha não entra no cache (nem como "sem imagem"): tenta de novo depois.
      this.breaker.onFailure();
      this.logger.warn(`Imagens do Wikimedia indisponíveis (${(e as Error).message}).`);
    } finally {
      clearTimeout(timer);
    }
    return out;
  }
}
