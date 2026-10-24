/**
 * Metrics definitions for prisma-schema-router.
 * Uses OpenTelemetry API — if @opentelemetry/api is not installed, falls back to no-ops.
 *
 * Metrics emitted:
 *   psr.pool.wait_time_ms        - histogram: time waiting for a pool connection
 *   psr.pool.connections.active  - gauge: current active connections
 *   psr.pool.connections.idle    - gauge: current idle connections
 *   psr.cache.size               - gauge: number of cached clients
 *   psr.cache.hits               - counter: cache hits
 *   psr.cache.evictions          - counter: cache evictions
 *   psr.governor.queue_depth     - gauge: per-tenant governor queue depth
 *   psr.migration.lag            - gauge: number of pending migrations per tenant
 *   psr.context.errors           - counter: TenantContextError occurrences
 */

import type { Meter, MeterProvider, Histogram, Counter } from '@opentelemetry/api';

export interface PsrMetrics {
  recordPoolWait(tenantId: string, waitMs: number): void;
  recordPoolConnections(active: number, idle: number): void;
  recordCacheSize(size: number): void;
  recordCacheHit(tenantId: string): void;
  recordCacheEviction(tenantId: string): void;
  recordGovernorQueueDepth(tenantId: string, depth: number): void;
  recordMigrationLag(tenantId: string, pendingCount: number): void;
  recordContextError(): void;
}

// ─── No-op implementation ─────────────────────────────────────────────────────

export class NoopMetrics implements PsrMetrics {
  recordPoolWait(_tenantId: string, _waitMs: number): void {}
  recordPoolConnections(_active: number, _idle: number): void {}
  recordCacheSize(_size: number): void {}
  recordCacheHit(_tenantId: string): void {}
  recordCacheEviction(_tenantId: string): void {}
  recordGovernorQueueDepth(_tenantId: string, _depth: number): void {}
  recordMigrationLag(_tenantId: string, _pendingCount: number): void {}
  recordContextError(): void {}
}

// ─── OpenTelemetry implementation ─────────────────────────────────────────────

export class OtelMetrics implements PsrMetrics {
  private readonly meter: Meter;
  private readonly poolWaitHistogram: Histogram;
  private readonly cacheHitsCounter: Counter;
  private readonly cacheEvictionsCounter: Counter;
  private readonly contextErrorsCounter: Counter;

  constructor(meterProvider: MeterProvider) {
    this.meter = meterProvider.getMeter('@psr/otel', '0.1.0');

    this.poolWaitHistogram = this.meter.createHistogram('psr.pool.wait_time_ms', {
      description: 'Time spent waiting for a pg pool connection (ms)',
      unit: 'ms',
    });
    this.cacheHitsCounter = this.meter.createCounter('psr.cache.hits', {
      description: 'Prisma client cache hits',
    });
    this.cacheEvictionsCounter = this.meter.createCounter('psr.cache.evictions', {
      description: 'Prisma client cache evictions',
    });
    this.contextErrorsCounter = this.meter.createCounter('psr.context.errors', {
      description: 'TenantContextError occurrences (router.db() called outside run())',
    });
  }

  recordPoolWait(tenantId: string, waitMs: number): void {
    this.poolWaitHistogram.record(waitMs, { 'psr.tenant.id': tenantId });
  }

  recordPoolConnections(active: number, idle: number): void {
    this.poolWaitHistogram.record(0, {
      'psr.pool.active': active,
      'psr.pool.idle': idle,
    });
  }

  recordCacheSize(_size: number): void {
    // Polled via router.debugSnapshot() at scrape time
  }

  recordCacheHit(tenantId: string): void {
    this.cacheHitsCounter.add(1, { 'psr.tenant.id': tenantId });
  }

  recordCacheEviction(tenantId: string): void {
    this.cacheEvictionsCounter.add(1, { 'psr.tenant.id': tenantId });
  }

  recordGovernorQueueDepth(_tenantId: string, _depth: number): void {
    // Polled via governor.allStats() at scrape time
  }

  recordMigrationLag(_tenantId: string, _pendingCount: number): void {
    // Tracked via migration status endpoint
  }

  recordContextError(): void {
    this.contextErrorsCounter.add(1);
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a metrics instance backed by OpenTelemetry.
 * Uses a dynamic import() so the OTel peer is truly optional.
 * Falls back to NoopMetrics if @opentelemetry/api is not installed.
 */
export async function createMetrics(meterProvider?: MeterProvider): Promise<PsrMetrics> {
  try {
    const api = await import('@opentelemetry/api');
    const mp = meterProvider ?? api.metrics.getMeterProvider();
    return new OtelMetrics(mp);
  } catch {
    // @opentelemetry/api not installed — use no-ops
    return new NoopMetrics();
  }
}

/**
 * Synchronous factory — returns NoopMetrics immediately; upgrades asynchronously.
 * Useful for module-level initialisation where async isn't possible.
 */
export function createMetricsSync(): PsrMetrics {
  // Start with no-ops; caller can await createMetrics() and swap if needed.
  return new NoopMetrics();
}
