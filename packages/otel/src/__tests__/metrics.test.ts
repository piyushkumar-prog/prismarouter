import { describe, it, expect, vi } from 'vitest';
import type { MeterProvider } from '@opentelemetry/api';
import { createMetrics, createMetricsSync, NoopMetrics, OtelMetrics } from '../metrics.js';

describe('NoopMetrics', () => {
  it('accepts every recording call without side effects', () => {
    const m = new NoopMetrics();
    expect(m.recordPoolWait('t1', 12)).toBeUndefined();
    expect(m.recordPoolConnections(1, 2)).toBeUndefined();
    expect(m.recordCacheSize(3)).toBeUndefined();
    expect(m.recordCacheHit('t1')).toBeUndefined();
    expect(m.recordCacheEviction('t1')).toBeUndefined();
    expect(m.recordGovernorQueueDepth('t1', 4)).toBeUndefined();
    expect(m.recordMigrationLag('t1', 5)).toBeUndefined();
    expect(m.recordContextError()).toBeUndefined();
  });
});

/** Minimal MeterProvider stub that records which instruments OtelMetrics creates. */
function fakeMeterProvider(): {
  provider: MeterProvider;
  histogram: { record: ReturnType<typeof vi.fn> };
  counters: Array<{ add: ReturnType<typeof vi.fn> }>;
  instrumentNames: string[];
} {
  const instrumentNames: string[] = [];
  const histogram = { record: vi.fn() };
  const counters = [{ add: vi.fn() }, { add: vi.fn() }, { add: vi.fn() }];
  let counterIndex = 0;

  const meter = {
    createHistogram(name: string) {
      instrumentNames.push(name);
      return histogram;
    },
    createCounter(name: string) {
      instrumentNames.push(name);
      return counters[counterIndex++]!;
    },
  };

  return {
    provider: { getMeter: () => meter } as unknown as MeterProvider,
    histogram,
    counters,
    instrumentNames,
  };
}

describe('OtelMetrics', () => {
  it('creates the documented instruments', () => {
    const { provider, instrumentNames } = fakeMeterProvider();
    new OtelMetrics(provider);
    expect(instrumentNames).toEqual([
      'psr.pool.wait_time_ms',
      'psr.cache.hits',
      'psr.cache.evictions',
      'psr.context.errors',
    ]);
  });

  it('records pool wait time with the tenant attribute', () => {
    const { provider, histogram } = fakeMeterProvider();
    new OtelMetrics(provider).recordPoolWait('tenant-1', 42);
    expect(histogram.record).toHaveBeenCalledWith(42, { 'psr.tenant.id': 'tenant-1' });
  });

  it('increments the cache-hit and context-error counters', () => {
    const { provider, counters } = fakeMeterProvider();
    const m = new OtelMetrics(provider);
    m.recordCacheHit('tenant-1');
    m.recordContextError();
    expect(counters[0]!.add).toHaveBeenCalledWith(1, { 'psr.tenant.id': 'tenant-1' });
    expect(counters[2]!.add).toHaveBeenCalledWith(1);
  });
});

describe('metrics factories', () => {
  it('createMetricsSync returns a NoopMetrics instance', () => {
    expect(createMetricsSync()).toBeInstanceOf(NoopMetrics);
  });

  it('createMetrics returns an OTel-backed instance when @opentelemetry/api is installed', async () => {
    await expect(createMetrics()).resolves.toBeInstanceOf(OtelMetrics);
  });
});
