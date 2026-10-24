import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import type {
  MigrationRun,
  MigrationRunStatus,
  TenantMigrationRecord,
  TenantMigrationState,
} from './types.js';

/**
 * Persistence layer for migration runs and per-tenant migration state
 * stored in the psr_migration_runs and psr_tenant_migrations tables.
 */
export class MigrationRunStore {
  constructor(private readonly pool: Pool) {}

  async createRun(targetVersion: string): Promise<MigrationRun> {
    const id = randomUUID();
    const res = await this.pool.query<{
      id: string;
      started_at: string;
      target_version: string;
      status: string;
    }>(
      `INSERT INTO psr_migration_runs (id, target_version, status)
       VALUES ($1, $2, 'running')
       RETURNING id, started_at, target_version, status`,
      [id, targetVersion],
    );
    const row = res.rows[0]!;
    return {
      id: row.id,
      startedAt: new Date(row.started_at),
      targetVersion: row.target_version,
      status: row.status as MigrationRunStatus,
    };
  }

  async updateRunStatus(runId: string, status: MigrationRunStatus): Promise<void> {
    await this.pool.query(`UPDATE psr_migration_runs SET status = $1 WHERE id = $2`, [
      status,
      runId,
    ]);
  }

  async getLatestIncompleteRun(): Promise<MigrationRun | null> {
    const res = await this.pool.query<{
      id: string;
      started_at: string;
      target_version: string;
      status: string;
    }>(
      `SELECT id, started_at, target_version, status
         FROM psr_migration_runs
        WHERE status = 'running'
        ORDER BY started_at DESC
        LIMIT 1`,
    );
    if (res.rows.length === 0) return null;
    const row = res.rows[0]!;
    return {
      id: row.id,
      startedAt: new Date(row.started_at),
      targetVersion: row.target_version,
      status: row.status as MigrationRunStatus,
    };
  }

  async initTenantRecords(runId: string, tenantIds: string[]): Promise<void> {
    if (tenantIds.length === 0) return;
    const values = tenantIds.map((_, i) => `($1, $${i + 2}, 'pending')`).join(', ');
    await this.pool.query(
      `INSERT INTO psr_tenant_migrations (run_id, tenant_id, state)
       VALUES ${values}
       ON CONFLICT (run_id, tenant_id) DO NOTHING`,
      [runId, ...tenantIds],
    );
  }

  async updateTenantState(
    runId: string,
    tenantId: string,
    state: TenantMigrationState,
    error?: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE psr_tenant_migrations
          SET state = $1, error = $2, updated_at = now()
        WHERE run_id = $3 AND tenant_id = $4`,
      [state, error ?? null, runId, tenantId],
    );
  }

  async getPendingTenants(runId: string): Promise<string[]> {
    const res = await this.pool.query<{ tenant_id: string }>(
      `SELECT tenant_id
         FROM psr_tenant_migrations
        WHERE run_id = $1 AND state = 'pending'
        ORDER BY tenant_id`,
      [runId],
    );
    return res.rows.map((r) => r.tenant_id);
  }

  async getRunSummary(
    runId: string,
  ): Promise<{ total: number; applied: number; failed: number; pending: number }> {
    const res = await this.pool.query<{ state: string; cnt: string }>(
      `SELECT state, count(*) as cnt
         FROM psr_tenant_migrations
        WHERE run_id = $1
        GROUP BY state`,
      [runId],
    );
    const counts: Record<string, number> = {};
    for (const row of res.rows) {
      counts[row.state] = parseInt(row.cnt, 10);
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    return {
      total,
      applied: counts['applied'] ?? 0,
      failed: counts['failed'] ?? 0,
      pending: (counts['pending'] ?? 0) + (counts['running'] ?? 0),
    };
  }

  async getTenantRecord(runId: string, tenantId: string): Promise<TenantMigrationRecord | null> {
    const res = await this.pool.query<{
      run_id: string;
      tenant_id: string;
      state: string;
      error: string | null;
      updated_at: string;
    }>(
      `SELECT run_id, tenant_id, state, error, updated_at
         FROM psr_tenant_migrations
        WHERE run_id = $1 AND tenant_id = $2`,
      [runId, tenantId],
    );
    if (res.rows.length === 0) return null;
    const row = res.rows[0]!;
    return {
      runId: row.run_id,
      tenantId: row.tenant_id,
      state: row.state as TenantMigrationState,
      error: row.error,
      updatedAt: new Date(row.updated_at),
    };
  }
}
