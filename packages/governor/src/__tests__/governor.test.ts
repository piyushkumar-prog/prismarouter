import { describe, it, expect } from 'vitest';
import { PoolGovernor } from '../governor.js';
import { TenantBusyError } from '../errors.js';

interface FakeClient {
  query(sql: string): Promise<unknown>;
}

interface FakePool {
  on(event: 'connect', listener: (client: FakeClient) => void): unknown;
}

/** A pool stub that records the statements issued on each new connection. */
function fakePool(): { pool: FakePool; connect(): string[] } {
  const listeners: Array<(client: FakeClient) => void> = [];
  const queries: string[] = [];
  const pool: FakePool = {
    on(_event, listener) {
      listeners.push(listener);
      return pool;
    },
  };
  return {
    pool,
    // Simulate a new physical connection being established.
    connect() {
      for (const listener of listeners) {
        listener({
          query(sql) {
            queries.push(sql);
            return Promise.resolve();
          },
        });
      }
      return queries;
    },
  };
}

describe('PoolGovernor', () => {
  it('runs a function and returns its result', async () => {
    const gov = new PoolGovernor({ perTenantConcurrency: 2 });
    const result = await gov.run('tenant-a', async () => 42);
    expect(result).toBe(42);
  });

  it('limits concurrency per tenant', async () => {
    const gov = new PoolGovernor({ perTenantConcurrency: 2, queueTimeoutMs: 100 });
    let active = 0;
    let maxActive = 0;

    const task = () =>
      gov.run('t1', async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
      });

    await Promise.all([task(), task(), task(), task()]);
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it('throws TenantBusyError on timeout', async () => {
    const gov = new PoolGovernor({ perTenantConcurrency: 1, queueTimeoutMs: 10 });

    // Fill the slot
    const block = gov.run('t1', () => new Promise((r) => setTimeout(r, 200)));

    // This should time out
    await expect(gov.run('t1', async () => {})).rejects.toThrow(TenantBusyError);

    // Cleanup
    await block.catch(() => {});
  });

  it('tenant stats track acquisitions', async () => {
    const gov = new PoolGovernor({ perTenantConcurrency: 4 });
    await gov.run('t-stats', async () => {});
    await gov.run('t-stats', async () => {});
    const stats = gov.tenantStats('t-stats');
    expect(stats.totalAcquired).toBe(2);
    expect(stats.totalTimedOut).toBe(0);
  });

  it('different tenants do not share concurrency limits', async () => {
    const gov = new PoolGovernor({ perTenantConcurrency: 1, queueTimeoutMs: 50 });
    // Both tenants can run concurrently
    await Promise.all([
      gov.run('tenantX', () => new Promise((r) => setTimeout(r, 20))),
      gov.run('tenantY', () => new Promise((r) => setTimeout(r, 20))),
    ]);
  });

  it('applies the default statement_timeout to every new connection', () => {
    const gov = new PoolGovernor({});
    const { pool, connect } = fakePool();
    gov.applyStatementTimeout(pool);
    expect(connect()).toEqual(['SET statement_timeout = 30000']);
    // Every connection, not just the first.
    expect(connect()).toEqual(['SET statement_timeout = 30000', 'SET statement_timeout = 30000']);
  });

  it('applies a configured statement_timeout, flooring fractional values', () => {
    const gov = new PoolGovernor({ statementTimeoutMs: 12_500.9 });
    const { pool, connect } = fakePool();
    gov.applyStatementTimeout(pool);
    expect(connect()).toEqual(['SET statement_timeout = 12500']);
  });

  it('does not attach a handler when the statement timeout is disabled', () => {
    const gov = new PoolGovernor({ statementTimeoutMs: 0 });
    const { pool, connect } = fakePool();
    gov.applyStatementTimeout(pool);
    expect(connect()).toEqual([]);
  });
});
