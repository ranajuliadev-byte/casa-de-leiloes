/**
 * Limites de requisições HTTP por IP (ThrottlerGuard, throttler `default`).
 * Os específicos são lidos do env a cada requisição, para os testes poderem ajustá-los.
 */
const MINUTE = 60_000;

/** Global, generoso: só barra abuso (rajadas de script), não uso normal. */
export const RATE_LIMIT = { ttl: MINUTE, limit: 600 };

/** Login e cadastro: bcrypt é caro; o global deixaria um único IP saturar a CPU e fazer força bruta. */
export const AUTH_RATE_LIMIT = { ttl: MINUTE, limit: () => Number(process.env.AUTH_RATE_LIMIT) || 10 };

/**
 * Busca de obras: cada chamada vai à API externa (que limita por IP do servidor). Sem
 * isto, um leiloeiro esgota a cota e mantém o circuit breaker aberto para todos.
 */
export const ARTWORK_SEARCH_RATE_LIMIT = { ttl: MINUTE, limit: () => Number(process.env.ARTWORK_SEARCH_RATE_LIMIT) || 30 };

/** Auditoria e comprovante: públicos e reverificam a cadeia e os extratos a cada chamada. */
export const AUDIT_RATE_LIMIT = { ttl: MINUTE, limit: () => Number(process.env.AUDIT_RATE_LIMIT) || 60 };
