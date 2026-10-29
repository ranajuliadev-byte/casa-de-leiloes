import { Logger } from '@nestjs/common';
import { Clock } from '../../src/common/clock';
import { AppError } from '../../src/common/errors';
import { AicArtwork, AicClient, AicError, AicSearchResult } from '../../src/artworks/aic.client';
import { ArtworksService, CACHE_TTL_MS } from '../../src/artworks/artworks.service';
import { CircuitBreaker } from '../../src/artworks/circuit-breaker';

const art = (id: number, extra: Partial<AicArtwork> = {}): AicArtwork => ({
  id,
  title: `Obra ${id}`,
  artist_display: 'Claude Monet',
  date_display: '1890',
  medium_display: 'Óleo sobre tela',
  dimensions: '65 × 100 cm',
  image_id: `img-${id}`,
  place_of_origin: 'França',
  ...extra,
});

const page = (data: AicArtwork[], totalPages = 3): AicSearchResult => ({
  data,
  pagination: { total: data.length * totalPages, total_pages: totalPages, current_page: 1, limit: 12 },
});

const cachedRow = {
  id: 'aic:999',
  externalId: 999,
  source: 'aic',
  title: 'Nenúfares (cache)',
  artist: 'Claude Monet',
  dateLabel: '1906',
  medium: 'Óleo',
  dimensions: null,
  origin: 'França',
  imageUrl: 'https://www.artic.edu/iiif/2/x/full/843,/0/default.jpg',
  thumbUrl: 'https://www.artic.edu/iiif/2/x/full/200,/0/default.jpg',
  raw: null,
  fetchedAt: new Date(),
};

beforeAll(() => Logger.overrideLogger(false));

function setup() {
  const prisma = {
    artwork: {
      upsert: jest.fn(async (args: any) => ({ ...args.create })),
      findUnique: jest.fn(async (): Promise<any> => null),
      findMany: jest.fn(async () => [cachedRow]),
      count: jest.fn(async () => 1),
    },
    $transaction: jest.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  const aic = { search: jest.fn(), getById: jest.fn() } as unknown as jest.Mocked<AicClient>;
  const clock = new Clock();
  const service = new ArtworksService(prisma as any, aic, clock);
  service.retryBackoffMs = 0;
  return { prisma, aic, clock, service };
}

describe('ArtworksService.search (API externa + fallback)', () => {
  it('modo live: mapeia campos, ignora obras sem imagem e grava cache no banco', async () => {
    const { service, aic, prisma } = setup();
    aic.search.mockResolvedValue(page([art(1), art(2, { image_id: null }), art(3)]));

    const r = await service.search('monet', 1);

    expect(aic.search).toHaveBeenCalledWith('monet', 1, 12);
    expect(r.source).toBe('live');
    expect(r.degraded).toBe(false);
    expect(r.totalPages).toBe(3);
    expect(r.items.map((i) => i.id)).toEqual(['aic:1', 'aic:3']);
    expect(r.items[0]).toEqual({
      id: 'aic:1',
      externalId: 1,
      title: 'Obra 1',
      artist: 'Claude Monet',
      dateLabel: '1890',
      medium: 'Óleo sobre tela',
      dimensions: '65 × 100 cm',
      origin: 'França',
      imageUrl: 'https://www.artic.edu/iiif/2/img-1/full/843,/0/default.jpg',
      thumbUrl: 'https://www.artic.edu/iiif/2/img-1/full/200,/0/default.jpg',
    });
    expect(prisma.artwork.upsert).toHaveBeenCalledTimes(2);
  });

  it('cache em memória por consulta (TTL 10 min)', async () => {
    const { service, aic, clock } = setup();
    aic.search.mockResolvedValue(page([art(1)]));

    await service.search('Monet ', 1);
    await service.search('monet', 1); // mesma chave (trim + minúsculas)
    expect(aic.search).toHaveBeenCalledTimes(1);

    clock.advance(CACHE_TTL_MS + 1);
    await service.search('monet', 1);
    expect(aic.search).toHaveBeenCalledTimes(2);
  });

  it('1 retry: falha transitória seguida de sucesso responde live', async () => {
    const { service, aic } = setup();
    aic.search.mockRejectedValueOnce(new AicError('timeout')).mockResolvedValueOnce(page([art(1)]));

    const r = await service.search('x', 1);
    expect(aic.search).toHaveBeenCalledTimes(2);
    expect(r.source).toBe('live');
    expect(service.breaker.state).toBe('CLOSED');
  });

  it('API fora do ar: responde do cache do banco com degraded=true (nunca lança)', async () => {
    const { service, aic, prisma } = setup();
    aic.search.mockRejectedValue(new AicError('network'));

    const r = await service.search('nenú', 1);
    expect(aic.search).toHaveBeenCalledTimes(2); // tentativa + retry
    expect(r).toMatchObject({ source: 'cache', degraded: true, page: 1, totalPages: 1 });
    expect(r.items[0].id).toBe('aic:999');
    const where = (prisma.artwork.findMany.mock.calls[0] as any)[0].where;
    expect(where.OR).toEqual([
      { title: { contains: 'nenú', mode: 'insensitive' } },
      { artist: { contains: 'nenú', mode: 'insensitive' } },
    ]);
  });

  it('rate limit (429) também cai no fallback', async () => {
    const { service, aic } = setup();
    aic.search.mockRejectedValue(new AicError('http', 429));
    const r = await service.search('a', 1);
    expect(r.degraded).toBe(true);
  });

  it('banco também indisponível: ainda responde 200 com lista vazia', async () => {
    const { service, aic, prisma } = setup();
    aic.search.mockRejectedValue(new AicError('network'));
    prisma.artwork.findMany.mockRejectedValue(new Error('db down'));
    await expect(service.search('a', 1)).resolves.toMatchObject({ items: [], degraded: true, source: 'cache' });
  });

  it('falha ao gravar o cache não derruba a busca live', async () => {
    const { service, aic, prisma } = setup();
    aic.search.mockResolvedValue(page([art(1)]));
    prisma.$transaction.mockRejectedValue(new Error('db down'));
    const r = await service.search('a', 1);
    expect(r).toMatchObject({ source: 'live', degraded: false });
  });

  it('circuit breaker: abre após 3 falhas seguidas, vai direto ao cache por 30 s e fecha após sucesso', async () => {
    const { service, aic, clock } = setup();
    aic.search.mockRejectedValue(new AicError('timeout'));

    // 3 buscas falhas (cada uma com tentativa + retry) — termos diferentes para não usar o cache em memória
    for (const q of ['a', 'b', 'c']) await service.search(q, 1);
    expect(aic.search).toHaveBeenCalledTimes(6);
    expect(service.breaker.state).toBe('OPEN');

    // Aberto: nem chama a API
    const r = await service.search('d', 1);
    expect(aic.search).toHaveBeenCalledTimes(6);
    expect(r).toMatchObject({ source: 'cache', degraded: true });

    // 30 s depois: meio-aberto, deixa uma chamada de teste passar
    clock.advance(30_001);
    expect(service.breaker.state).toBe('HALF_OPEN');
    aic.search.mockReset();
    aic.search.mockResolvedValue(page([art(7)]));
    const ok = await service.search('e', 1);
    expect(ok.source).toBe('live');
    expect(service.breaker.state).toBe('CLOSED');
  });

  it('circuit breaker: falha no meio-aberto reabre por mais 30 s', async () => {
    const { service, aic, clock } = setup();
    aic.search.mockRejectedValue(new AicError('timeout'));
    for (const q of ['a', 'b', 'c']) await service.search(q, 1);
    clock.advance(30_001);
    await service.search('z', 1);
    expect(service.breaker.state).toBe('OPEN');
    const calls = aic.search.mock.calls.length;
    await service.search('y', 1);
    expect(aic.search.mock.calls.length).toBe(calls);
  });
});

describe('ArtworksService.getForLot', () => {
  it('usa o cache do banco sem chamar a API', async () => {
    const { service, aic, prisma } = setup();
    prisma.artwork.findUnique.mockResolvedValue(cachedRow);
    await expect(service.getForLot('aic:999')).resolves.toBe(cachedRow);
    expect(aic.getById).not.toHaveBeenCalled();
  });

  it('sem cache: busca na API e grava', async () => {
    const { service, aic, prisma } = setup();
    aic.getById.mockResolvedValue(art(42));
    const a = await service.getForLot('42');
    expect(aic.getById).toHaveBeenCalledWith(42);
    expect(prisma.artwork.upsert).toHaveBeenCalled();
    expect(a.id).toBe('aic:42');
  });

  it('não encontrada → ARTWORK_NOT_FOUND', async () => {
    const { service, aic } = setup();
    aic.getById.mockResolvedValue(null);
    await expect(service.getForLot('aic:1')).rejects.toMatchObject({ code: 'ARTWORK_NOT_FOUND' });
    await expect(service.getForLot('abc')).rejects.toBeInstanceOf(AppError);
    expect(service.breaker.state).toBe('CLOSED');
  });

  it('API fora e sem cache → EXTERNAL_API_UNAVAILABLE (503)', async () => {
    const { service, aic } = setup();
    aic.getById.mockRejectedValue(new AicError('network'));
    await expect(service.getForLot('aic:5')).rejects.toMatchObject({ code: 'EXTERNAL_API_UNAVAILABLE' });
  });
});

describe('CircuitBreaker', () => {
  it('sucesso zera o contador de falhas', () => {
    let t = 0;
    const b = new CircuitBreaker(() => t, 3, 30_000);
    b.onFailure();
    b.onFailure();
    b.onSuccess();
    b.onFailure();
    b.onFailure();
    expect(b.state).toBe('CLOSED');
    b.onFailure();
    expect(b.state).toBe('OPEN');
    t = 30_000;
    expect(b.tryAcquire()).toBe(true);
    expect(b.tryAcquire()).toBe(false); // só uma chamada de teste por vez
  });
});
