import { AppError } from '../src/common/errors';
import { isRetryableTxError, withTxRetry } from '../src/common/tx-utils';
import { createTestApp, createUser, resetDb, TestCtx } from './helpers';

describe('tx-utils — retry defensivo', () => {
  let ctx: TestCtx;
  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(async () => {
    await ctx.app.close();
  });
  beforeEach(async () => {
    await resetDb(ctx.prisma);
  });

  it('reconhece deadlock real do Postgres (via driver adapter) como repetível', async () => {
    const a = await createUser(ctx, 'BIDDER', 100);
    const b = await createUser(ctx, 'BIDDER', 100);
    // Força deadlock: T1 trava A depois B; T2 trava B depois A.
    let step!: () => void;
    const both = new Promise<void>((r) => {
      let n = 0;
      step = () => ++n === 2 && r();
    });
    const tx = (first: string, second: string) =>
      ctx.prisma.$transaction(async (t) => {
        await t.$queryRaw`SELECT id FROM "Wallet" WHERE id = ${first} FOR UPDATE`;
        step();
        await both;
        await t.$queryRaw`SELECT id FROM "Wallet" WHERE id = ${second} FOR UPDATE`;
      });
    const results = await Promise.allSettled([tx(a.walletId, b.walletId), tx(b.walletId, a.walletId)]);
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
    expect(failed).toBeDefined();
    expect(isRetryableTxError(failed!.reason)).toBe(true);
  });

  it('reconhece violação de unicidade (P2002) como repetível', async () => {
    const a = await createUser(ctx, 'BIDDER', 0);
    const err = await ctx.prisma.user
      .create({ data: { name: 'x', email: a.email, passwordHash: 'x', roles: ['BIDDER'] } })
      .catch((e) => e);
    expect(isRetryableTxError(err)).toBe(true);
  });

  it('não repete erro de domínio (AppError)', async () => {
    let calls = 0;
    await expect(
      withTxRetry(async () => {
        calls++;
        throw new AppError('BELOW_MINIMUM', { minimumCents: 1 });
      }),
    ).rejects.toBeInstanceOf(AppError);
    expect(calls).toBe(1);
  });

  it('repete até 3x em erro transitório', async () => {
    let calls = 0;
    const r = await withTxRetry(async () => {
      calls++;
      if (calls < 3) throw Object.assign(new Error('deadlock detected'), { code: 'P2034' });
      return 'ok';
    });
    expect(r).toBe('ok');
    expect(calls).toBe(3);
    calls = 0;
    await expect(
      withTxRetry(async () => {
        calls++;
        throw Object.assign(new Error('x'), { code: 'P2034' });
      }),
    ).rejects.toThrow();
    expect(calls).toBe(3);
  });
});
