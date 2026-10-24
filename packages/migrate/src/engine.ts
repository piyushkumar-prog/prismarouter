import type { Pool, PoolClient } from 'pg';
import { quoteIdentifier } from '@psr/core';
import type { TenantRegistry } from '@psr/core';
import { MigrationRunStore } from './run-store.js';
import { loadMigrations, latestVersion, migrationsAfter } from './migrations-dir.js';
import type {
  DeployOptions,
  DeployResult,
  MigrationPlanEntry,
  MigrationRun,
  MigrationRunStatus,
} from './types.js';

const DEFAULT_CONCURRENCY = 8;
const DEFAULT_MAX_FAILURES = 5;
const DEFAULT_CANARY = 1;
const DEFAULT_MIGRATIONS_DIR = './prisma/migrations';
const DEFAULT_LOCK_TIMEOUT_MS = 10_000; // 10 s — fail fast rather than block
const DEFAULT_STATEMENT_TIMEOUT_MS = 300_000; // 5 min — prevent runaway DDL

// ─── Advisory locks ───────────────────────────────────────────────────────────

async function tryAdvisoryLock(client: PoolClient, schemaName: string): Promise<boolean> {
  const res = await client.query<{ acquired: boolean }>(
    `SELECT pg_try_advisory_lock(hashtext($1)::bigint) as acquired`,
    [schemaName],
  );
  return res.rows[0]?.acquired ?? false;
}

async function releaseAdvisoryLock(client: PoolClient, schemaName: string): Promise<void> {
  await client.query(`SELECT pg_advisory_unlock(hashtext($1)::bigint)`, [schemaName]);
}

// ─── Native migration applier ─────────────────────────────────────────────────

/**
 * Apply an ordered list of SQL strings to a tenant schema.
 *
 * Each statement runs in its own transaction with:
 *   SET LOCAL search_path      — scope all unqualified names to this schema
 *   SET LOCAL lock_timeout     — fail fast rather than block on a contested lock
 *   SET LOCAL statement_timeout — prevent runaway DDL from hanging the fleet run
 *
 * Statements containing CREATE INDEX CONCURRENTLY run outside a transaction
 * (Postgres forbids CONCURRENTLY inside a transaction block). Timeouts are set
 * at the session level for those statements and reset afterward.
 */
async function applyNative(
  pool: Pool,
  schemaName: string,
  pendingSql: string[],
  lockTimeoutMs: number,
  statementTimeoutMs: number,
): Promise<void> {
  for (const sqlText of pendingSql) {
    const hasConcurrent = /CREATE\s+INDEX\s+CONCURRENTLY/i.test(sqlText);
    const client = await pool.connect();

    try {
      if (hasConcurrent) {
        // Must run outside a transaction block — set session-level timeouts
        await client.query(`SET lock_timeout = ${lockTimeoutMs}`);
        await client.query(`SET statement_timeout = ${statementTimeoutMs}`);
        await client.query(`SET search_path = ${quoteIdentifier(schemaName)}`);
        await client.query(sqlText);
        // Reset to defaults so the connection is clean when returned to the pool
        await client.query(`SET lock_timeout = 0`);
        await client.query(`SET statement_timeout = 0`);
        await client.query(`SET search_path = DEFAULT`);
      } else {
        await client.query('BEGIN');
        try {
          await client.query(`SET LOCAL lock_timeout = ${lockTimeoutMs}`);
          await client.query(`SET LOCAL statement_timeout = ${statementTimeoutMs}`);
          await client.query(`SET LOCAL search_path = ${quoteIdentifier(schemaName)}`);
          await client.query(sqlText);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      }
    } finally {
      client.release();
    }
  }
}

// ─── Fleet Migration Engine ───────────────────────────────────────────────────

export class FleetMigrationEngine {
  private readonly store: MigrationRunStore;

  constructor(
    private readonly pool: Pool,
    private readonly registry: TenantRegistry,
    private readonly controlPool: Pool,
  ) {
    this.store = new MigrationRunStore(controlPool);
  }

  async plan(opts: { migrationsDir?: string } = {}): Promise<MigrationPlanEntry[]> {
    const migrationsDir = opts.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
    const migrations = await loadMigrations(migrationsDir);
    const target = latestVersion(migrations);
    if (!target) return [];

    const tenants = await this.registry.listTenants({ status: 'ready' });
    const entries: MigrationPlanEntry[] = [];

    for (const tenant of tenants) {
      const pending = migrationsAfter(migrations, tenant.schemaVersion);
      if (pending.length > 0) {
        entries.push({
          tenantId: tenant.id,
          slug: tenant.slug,
          schemaName: tenant.schemaName,
          currentVersion: tenant.schemaVersion,
          targetVersion: target,
          pendingMigrations: pending.map((m) => m.version),
        });
      }
    }

    return entries;
  }

  async deploy(opts: DeployOptions = {}): Promise<DeployResult> {
    const {
      migrationsDir = DEFAULT_MIGRATIONS_DIR,
      concurrency = DEFAULT_CONCURRENCY,
      canary = DEFAULT_CANARY,
      maxFailures = DEFAULT_MAX_FAILURES,
      healthCheck,
      resume = false,
      lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
      statementTimeoutMs = DEFAULT_STATEMENT_TIMEOUT_MS,
    } = opts;

    const migrations = await loadMigrations(migrationsDir);
    const targetVersion = opts.targetVersion ?? latestVersion(migrations);
    if (!targetVersion) {
      return { runId: '', total: 0, applied: 0, failed: 0, skipped: 0, status: 'completed' };
    }

    // Resume existing run or start a new one
    let run = resume ? await this.store.getLatestIncompleteRun() : null;
    if (!run) {
      run = await this.store.createRun(targetVersion);
      const plan = await this.plan({ migrationsDir });
      await this.store.initTenantRecords(
        run.id,
        plan.map((e) => e.tenantId),
      );
    }

    const runId = run.id;
    let failureCount = 0;

    const migrateTenant = async (tenantId: string): Promise<void> => {
      const tenant = await this.registry.findById(tenantId);
      if (!tenant) return;

      const lockClient: PoolClient = await this.pool.connect();
      const acquired = await tryAdvisoryLock(lockClient, tenant.schemaName);
      if (!acquired) {
        lockClient.release();
        throw new Error(`Could not acquire advisory lock for schema ${tenant.schemaName}`);
      }

      try {
        await this.store.updateTenantState(runId, tenantId, 'running');
        await this.registry.updateStatus(tenantId, 'migrating');

        const pending = migrationsAfter(migrations, tenant.schemaVersion);
        await applyNative(
          this.pool,
          tenant.schemaName,
          pending.map((m) => m.sql),
          lockTimeoutMs,
          statementTimeoutMs,
        );

        await this.registry.updateSchemaVersion(tenantId, targetVersion);
        await this.registry.updateStatus(tenantId, 'ready');
        await this.store.updateTenantState(runId, tenantId, 'applied');
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await this.store.updateTenantState(runId, tenantId, 'failed', errMsg);
        await this.registry.updateStatus(tenantId, 'ready');
        throw err;
      } finally {
        await releaseAdvisoryLock(lockClient, tenant.schemaName);
        lockClient.release();
      }
    };

    // Fetch pending tenants (supports resume)
    let pending = await this.store.getPendingTenants(runId);
    let applied = 0;

    // Canary batch — migrate first K tenants, then optionally health-check
    if (canary > 0 && pending.length > 0) {
      const canaryBatch = pending.slice(0, canary);
      for (const tenantId of canaryBatch) {
        try {
          await migrateTenant(tenantId);
          applied++;
        } catch {
          failureCount++;
        }
      }
      pending = pending.slice(canary);

      if (healthCheck) {
        const healthy = await healthCheck();
        if (!healthy) {
          await this.store.updateRunStatus(runId, 'stopped');
          const summary = await this.store.getRunSummary(runId);
          return {
            runId,
            total: summary.total,
            applied: summary.applied,
            failed: summary.failed,
            skipped: summary.pending,
            status: 'stopped',
          };
        }
      }
    }

    // Wave processing with bounded concurrency
    for (let i = 0; i < pending.length; i += concurrency) {
      if (failureCount >= maxFailures) {
        console.error(`[psr/migrate] Stopping run: reached maxFailures (${maxFailures})`);
        break;
      }
      const wave = pending.slice(i, i + concurrency);
      const results = await Promise.allSettled(wave.map(migrateTenant));
      for (const r of results) {
        if (r.status === 'fulfilled') applied++;
        else failureCount++;
      }
    }

    const finalStatus: MigrationRunStatus = failureCount >= maxFailures ? 'stopped' : 'completed';
    await this.store.updateRunStatus(runId, finalStatus);

    const summary = await this.store.getRunSummary(runId);
    return {
      runId,
      total: summary.total,
      applied: summary.applied,
      failed: summary.failed,
      skipped: summary.pending,
      status: finalStatus,
    };
  }

  async status(): Promise<{
    latestRun: MigrationRun | null;
    summary: { total: number; applied: number; failed: number; pending: number } | null;
  }> {
    const run = await this.store.getLatestIncompleteRun();
    if (!run) return { latestRun: null, summary: null };
    const summary = await this.store.getRunSummary(run.id);
    return { latestRun: run, summary };
  }

  async resume(opts: DeployOptions = {}): Promise<DeployResult> {
    return this.deploy({ ...opts, resume: true });
  }
}
