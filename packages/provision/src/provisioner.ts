import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  generateSchemaName,
  quoteIdentifier,
  validateSchemaName,
  type TenantRegistry,
  type TenantRecord,
} from '@piyushkumar_dev/core';
import type { DriftReport } from '@piyushkumar_dev/migrate';
import { checkDrift, loadMigrations } from '@piyushkumar_dev/migrate';

export type ProvisionStrategy = 'replay' | 'baseline' | 'clone-template';

export interface ProvisionOptions {
  /** Human-readable slug for this tenant (e.g. "acme"). */
  slug: string;
  /** Optional explicit tenant id (UUID). Generated if omitted. */
  tenantId?: string;
  /** Provisioning strategy (default: replay). */
  strategy?: ProvisionStrategy;
  /**
   * For strategy=replay: path to prisma/migrations directory.
   * For strategy=clone-template: the template schema name to clone from.
   * For strategy=baseline: path to a baseline migration.sql file.
   */
  source?: string;
  /** Seed hook called after the schema is ready. */
  onReady?: (tenantId: string) => Promise<void>;
  /** Schema to compare against for drift check after clone. */
  templateSchemaForDriftCheck?: string;
}

export interface ProvisionResult {
  tenant: TenantRecord;
  driftReport?: DriftReport;
}

export class TenantProvisioner {
  constructor(
    private readonly pool: Pool,
    private readonly registry: TenantRegistry,
  ) {}

  /**
   * Provision a new tenant. Idempotent: retrying with the same tenantId is safe.
   * State machine: provisioning → ready
   */
  async provision(opts: ProvisionOptions): Promise<ProvisionResult> {
    const {
      slug,
      tenantId = randomUUID(),
      strategy = 'replay',
      source,
      onReady,
      templateSchemaForDriftCheck,
    } = opts;

    const schemaName = generateSchemaName(slug);

    // Persist as provisioning (idempotent on id conflict)
    await this.registry.upsert({
      id: tenantId,
      slug,
      schemaName,
      status: 'provisioning',
      schemaVersion: null,
      placement: 'shared',
    });

    let driftReport: DriftReport | undefined;

    try {
      switch (strategy) {
        case 'replay':
          await this.replayProvision(schemaName, source ?? './prisma/migrations');
          break;

        case 'clone-template':
          await this.cloneTemplateProvision(schemaName, source ?? 'psr_template');
          if (templateSchemaForDriftCheck ?? source) {
            driftReport = await checkDrift(
              this.pool,
              templateSchemaForDriftCheck ?? source ?? 'psr_template',
              tenantId,
              schemaName,
            );
            if (driftReport.drifted) {
              await this.dropSchemaUnsafe(schemaName);
              throw new Error(
                `Schema drift detected after clone: ${driftReport.differences
                  .map((d) => d.object)
                  .join(', ')}`,
              );
            }
          }
          break;

        case 'baseline':
          await this.baselineProvision(schemaName, source ?? './prisma/migrations/baseline.sql');
          break;
      }

      await this.registry.updateStatus(tenantId, 'ready');
      const tenant = (await this.registry.findById(tenantId))!;

      if (onReady) await onReady(tenantId);

      const result: ProvisionResult = { tenant };
      if (driftReport !== undefined) result.driftReport = driftReport;
      return result;
    } catch (err) {
      // Leave status as 'provisioning' so the operator can retry or clean up
      throw err;
    }
  }

  async suspend(tenantId: string): Promise<void> {
    await this.registry.updateStatus(tenantId, 'suspended');
  }

  async restore(tenantId: string): Promise<void> {
    await this.registry.updateStatus(tenantId, 'ready');
  }

  async archive(tenantId: string): Promise<void> {
    await this.registry.updateStatus(tenantId, 'archived');
  }

  /**
   * Permanently delete a tenant schema.
   * SAFETY: Only allowed when status is 'archived' AND confirmationToken === tenantId.
   */
  async deleteTenant(tenantId: string, confirmationToken: string): Promise<void> {
    if (confirmationToken !== tenantId) {
      throw new Error(
        `Confirmation token must equal tenantId. Got "${confirmationToken}", expected "${tenantId}"`,
      );
    }
    const tenant = await this.registry.findById(tenantId);
    if (!tenant) throw new Error(`Tenant not found: ${tenantId}`);
    if (tenant.status !== 'archived') {
      throw new Error(
        `Can only delete archived tenants. Current status: ${tenant.status}. ` +
          `Call provisioner.archive(tenantId) first.`,
      );
    }

    await this.dropSchemaUnsafe(tenant.schemaName);
    await this.registry.updateStatus(tenantId, 'deleted');
  }

  // ─── Private provisioning strategies ──────────────────────────────────────

  /**
   * Create the schema then apply each migration in its own transaction.
   *
   * Each migration runs in a separate BEGIN/COMMIT so that:
   * - Prisma-generated migrations with CREATE INDEX CONCURRENTLY work
   *   (CONCURRENTLY is illegal inside a transaction).
   * - A failure in migration N is isolated; prior migrations remain applied.
   */
  private async replayProvision(schemaName: string, migrationsDir: string): Promise<void> {
    const migrations = await loadMigrations(migrationsDir);

    // Create the schema first, outside of any migration transaction
    const setupClient: PoolClient = await this.pool.connect();
    try {
      await setupClient.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schemaName)}`);
    } finally {
      setupClient.release();
    }

    // Apply each migration in its own transaction with SET LOCAL search_path
    for (const migration of migrations) {
      const client: PoolClient = await this.pool.connect();
      try {
        // Check if this migration already applied (idempotency for retries)
        const applied = await this.isMigrationApplied(client, schemaName, migration.version);
        if (applied) continue;

        // Detect CONCURRENTLY — must run outside a transaction
        const hasConcurrent = /CREATE\s+INDEX\s+CONCURRENTLY/i.test(migration.sql);

        if (hasConcurrent) {
          // Run without BEGIN/COMMIT; SET search_path for the session
          await client.query(`SET search_path = ${quoteIdentifier(schemaName)}`);
          await client.query(migration.sql);
          await client.query(`SET search_path = DEFAULT`);
          await this.recordMigrationApplied(client, schemaName, migration.version);
        } else {
          await client.query('BEGIN');
          try {
            await client.query(`SET LOCAL search_path = ${quoteIdentifier(schemaName)}`);
            await client.query(migration.sql);
            await this.recordMigrationApplied(client, schemaName, migration.version);
            await client.query('COMMIT');
          } catch (err) {
            await client.query('ROLLBACK');
            throw new Error(
              `Migration ${migration.version} failed on schema ${schemaName}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }
      } finally {
        client.release();
      }
    }
  }

  /**
   * Apply a single squashed baseline SQL file, then any later migrations.
   */
  private async baselineProvision(schemaName: string, baselineSqlPath: string): Promise<void> {
    const { readFile } = await import('node:fs/promises');
    const sql = await readFile(baselineSqlPath, 'utf8');

    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schemaName)}`);
      await client.query(`SET LOCAL search_path = ${quoteIdentifier(schemaName)}`);
      await client.query(sql);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Copy structure from a template schema using LIKE … INCLUDING ALL.
   * Covers tables, indexes, constraints, defaults, sequences, and comments.
   * Does NOT copy data.
   *
   * Note: foreign keys referencing OTHER tables are not copied by LIKE —
   * they must be added manually via a post-clone hook if needed.
   */
  private async cloneTemplateProvision(schemaName: string, templateSchema: string): Promise<void> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schemaName)}`);

      const tables = await client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = $1 AND table_type = 'BASE TABLE'
          ORDER BY table_name`,
        [templateSchema],
      );

      for (const { table_name } of tables.rows) {
        await client.query(
          `CREATE TABLE ${quoteIdentifier(schemaName)}.${quoteIdentifier(table_name)}
           (LIKE ${quoteIdentifier(templateSchema)}.${quoteIdentifier(table_name)} INCLUDING ALL)`,
        );
      }

      // Copy sequences (for SERIAL / BIGSERIAL columns not covered by LIKE)
      const seqs = await client.query<{ sequence_name: string }>(
        `SELECT sequence_name FROM information_schema.sequences WHERE sequence_schema = $1`,
        [templateSchema],
      );
      for (const { sequence_name } of seqs.rows) {
        await client.query(
          `CREATE SEQUENCE IF NOT EXISTS ${quoteIdentifier(schemaName)}.${quoteIdentifier(
            sequence_name,
          )}`,
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  private async dropSchemaUnsafe(schemaName: string): Promise<void> {
    validateSchemaName(schemaName);
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
    } finally {
      client.release();
    }
  }

  // ─── Migration tracking helpers ────────────────────────────────────────────
  // We write a lightweight _psr_migrations table into each tenant schema so
  // replayProvision is idempotent (safe to retry).

  private async isMigrationApplied(
    client: PoolClient,
    schemaName: string,
    version: string,
  ): Promise<boolean> {
    try {
      const res = await client.query<{ count: string }>(
        `SELECT count(*)::text as count
           FROM ${quoteIdentifier(schemaName)}._psr_migrations
          WHERE version = $1`,
        [version],
      );
      return parseInt(res.rows[0]?.count ?? '0', 10) > 0;
    } catch {
      // Table doesn't exist yet — first run
      return false;
    }
  }

  private async recordMigrationApplied(
    client: PoolClient,
    schemaName: string,
    version: string,
  ): Promise<void> {
    // Ensure tracking table exists
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(schemaName)}._psr_migrations (
         version    TEXT        PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );
    await client.query(
      `INSERT INTO ${quoteIdentifier(schemaName)}._psr_migrations (version)
       VALUES ($1)
       ON CONFLICT (version) DO NOTHING`,
      [version],
    );
  }
}
