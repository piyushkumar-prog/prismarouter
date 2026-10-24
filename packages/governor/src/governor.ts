import { Semaphore } from './semaphore.js';
import { TenantBusyError } from './errors.js';

export interface GovernorOptions {
  /** Max concurrent operations per tenant (default 4). */
  perTenantConcurrency?: number;
  /** How long to wait for a slot before throwing TenantBusyError (ms, default 5000). */
  queueTimeoutMs?: number;
  /**
   * Server-side statement timeout applied to every pooled connection (ms, default 30000).
   * Set to 0 to leave Postgres' default (no timeout).
   */
  statementTimeoutMs?: number;
}

/** Minimal shape of a pg client — just enough to issue the SET. */
interface TimeoutClient {
  query(sql: string): Promise<unknown>;
}

/** Minimal shape of a pg.Pool — just the connect hook we attach. */
interface ConnectablePool {
  on(event: 'connect', listener: (client: TimeoutClient) => void): unknown;
}

export interface TenantStats {
  tenantId: string;
  activeCount: number;
  queueDepth: number;
  totalAcquired: number;
  totalTimedOut: number;
  avgWaitMs: number;
}

/**
 * Pool governor: wraps any async operation in per-tenant concurrency control.
 *
 * Usage:
 *   const release = await governor.acquire(tenantId);
 *   try { await doWork(); } finally { release(); }
 *
 * Or use the helper:
 *   await governor.run(tenantId, () => doWork());
 */
export class PoolGovernor {
  private readonly semaphores = new Map<string, Semaphore>();
  private readonly stats = new Map<
    string,
    { acquired: number; timedOut: number; totalWaitMs: number }
  >();

  private readonly concurrency: number;
  private readonly timeoutMs: number;
  private readonly statementTimeoutMs: number;

  constructor(opts: GovernorOptions = {}) {
    this.concurrency = opts.perTenantConcurrency ?? 4;
    this.timeoutMs = opts.queueTimeoutMs ?? 5_000;
    this.statementTimeoutMs = opts.statementTimeoutMs ?? 30_000;
  }

  /**
   * Install the configured statement timeout on every new connection from `pool`.
   *
   * Attaches a single pool-level 'connect' handler (never one per tenant), so
   * listener count stays flat as tenant count grows. Postgres then aborts any
   * statement that runs longer than `statementTimeoutMs`, so one runaway query
   * cannot pin a pooled connection and stall its tenant.
   *
   * `@psr/core` calls this with the shared pool whenever the `governor` option
   * is supplied. A value of 0 (or less) disables the timeout.
   */
  applyStatementTimeout(pool: ConnectablePool): void {
    const ms = Math.floor(this.statementTimeoutMs);
    if (!Number.isFinite(ms) || ms <= 0) return;
    pool.on('connect', (client) => {
      // Fire-and-forget. `ms` is a validated integer, so interpolation is safe.
      void client.query(`SET statement_timeout = ${ms}`).catch(() => {
        // A connection that rejects the SET keeps Postgres' default timeout.
      });
    });
  }

  private getSemaphore(tenantId: string): Semaphore {
    let sem = this.semaphores.get(tenantId);
    if (!sem) {
      sem = new Semaphore(this.concurrency);
      this.semaphores.set(tenantId, sem);
    }
    return sem;
  }

  private getStats(tenantId: string): { acquired: number; timedOut: number; totalWaitMs: number } {
    let s = this.stats.get(tenantId);
    if (!s) {
      s = { acquired: 0, timedOut: 0, totalWaitMs: 0 };
      this.stats.set(tenantId, s);
    }
    return s;
  }

  /**
   * Acquire a governor slot for tenantId.
   * Throws TenantBusyError if the timeout elapses.
   * Returns a release function — MUST be called in a finally block.
   */
  async acquire(tenantId: string): Promise<() => void> {
    const sem = this.getSemaphore(tenantId);
    const stat = this.getStats(tenantId);
    const start = Date.now();

    const acquirePromise = sem.acquire();
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new TenantBusyError(tenantId, sem.queueDepth, this.timeoutMs)),
        this.timeoutMs,
      ),
    );

    try {
      const release = await Promise.race([acquirePromise, timeoutPromise]);
      stat.acquired++;
      stat.totalWaitMs += Date.now() - start;
      return release;
    } catch (err) {
      stat.timedOut++;
      throw err;
    }
  }

  /**
   * Run a function within a governor slot.
   */
  async run<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire(tenantId);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Current stats for a tenant.
   */
  tenantStats(tenantId: string): TenantStats {
    const sem = this.semaphores.get(tenantId);
    const stat = this.stats.get(tenantId) ?? { acquired: 0, timedOut: 0, totalWaitMs: 0 };
    return {
      tenantId,
      activeCount: sem?.activeCount ?? 0,
      queueDepth: sem?.queueDepth ?? 0,
      totalAcquired: stat.acquired,
      totalTimedOut: stat.timedOut,
      avgWaitMs: stat.acquired > 0 ? stat.totalWaitMs / stat.acquired : 0,
    };
  }

  /**
   * All tenants that have ever been governed.
   */
  allStats(): TenantStats[] {
    return [...this.semaphores.keys()].map((id) => this.tenantStats(id));
  }
}

/**
 * Create a Prisma $extends query hook that wraps every operation through the governor.
 * Attach to your PrismaClient via client.$extends(createGovernorExtension(governor, tenantId)).
 */
export function createGovernorExtension(governor: PoolGovernor, tenantId: string) {
  return {
    query: {
      $allOperations({
        operation,
        model,
        args,
        query,
      }: {
        operation: string;
        model?: string;
        args: unknown;
        query: (args: unknown) => Promise<unknown>;
      }) {
        return governor.run(tenantId, () => query(args));
      },
    },
  };
}
