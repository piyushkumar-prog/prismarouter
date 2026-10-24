import type { Pool } from 'pg';

export type TenantStatus =
  'provisioning' | 'ready' | 'migrating' | 'suspended' | 'archived' | 'deleted';

export type TenantPlacement = 'shared' | 'dedicated';

export interface TenantRecord {
  id: string;
  slug: string;
  schemaName: string;
  status: TenantStatus;
  schemaVersion: string | null;
  placement: TenantPlacement;
  createdAt: Date;
}

/**
 * Registry interface — swap implementations for different storage backends.
 */
export interface TenantRegistry {
  /**
   * Look up a tenant by id.
   * Returns null if not found (caller decides whether to throw).
   */
  findById(tenantId: string): Promise<TenantRecord | null>;

  /**
   * List all tenants, optionally filtered by status.
   */
  listTenants(filter?: { status?: TenantStatus }): Promise<TenantRecord[]>;

  /**
   * Upsert a tenant record.
   */
  upsert(record: Omit<TenantRecord, 'createdAt'> & { createdAt?: Date }): Promise<TenantRecord>;

  /**
   * Update a tenant's status.
   */
  updateStatus(tenantId: string, status: TenantStatus): Promise<void>;

  /**
   * Update a tenant's schema version after a successful migration.
   */
  updateSchemaVersion(tenantId: string, version: string): Promise<void>;
}

// ─── Postgres implementation ────────────────────────────────────────────────

function rowToRecord(row: Record<string, unknown>): TenantRecord {
  return {
    id: row['id'] as string,
    slug: row['slug'] as string,
    schemaName: row['schema_name'] as string,
    status: row['status'] as TenantStatus,
    schemaVersion: (row['schema_version'] as string | null) ?? null,
    placement: (row['placement'] as TenantPlacement) ?? 'shared',
    createdAt: new Date(row['created_at'] as string),
  };
}

export class PgTenantRegistry implements TenantRegistry {
  constructor(private readonly pool: Pool) {}

  async findById(tenantId: string): Promise<TenantRecord | null> {
    const res = await this.pool.query(
      `SELECT id, slug, schema_name, status, schema_version, placement, created_at
         FROM psr_tenants
        WHERE id = $1
        LIMIT 1`,
      [tenantId],
    );
    if (res.rows.length === 0) return null;
    return rowToRecord(res.rows[0] as Record<string, unknown>);
  }

  async listTenants(filter?: { status?: TenantStatus }): Promise<TenantRecord[]> {
    if (filter?.status) {
      const res = await this.pool.query(
        `SELECT id, slug, schema_name, status, schema_version, placement, created_at
           FROM psr_tenants
          WHERE status = $1
          ORDER BY created_at`,
        [filter.status],
      );
      return res.rows.map((r) => rowToRecord(r as Record<string, unknown>));
    }
    const res = await this.pool.query(
      `SELECT id, slug, schema_name, status, schema_version, placement, created_at
         FROM psr_tenants
        ORDER BY created_at`,
    );
    return res.rows.map((r) => rowToRecord(r as Record<string, unknown>));
  }

  async upsert(
    record: Omit<TenantRecord, 'createdAt'> & { createdAt?: Date },
  ): Promise<TenantRecord> {
    const res = await this.pool.query(
      `INSERT INTO psr_tenants (id, slug, schema_name, status, schema_version, placement, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         slug           = EXCLUDED.slug,
         schema_name    = EXCLUDED.schema_name,
         status         = EXCLUDED.status,
         schema_version = EXCLUDED.schema_version,
         placement      = EXCLUDED.placement
       RETURNING id, slug, schema_name, status, schema_version, placement, created_at`,
      [
        record.id,
        record.slug,
        record.schemaName,
        record.status,
        record.schemaVersion,
        record.placement,
        record.createdAt ?? new Date(),
      ],
    );
    return rowToRecord(res.rows[0] as Record<string, unknown>);
  }

  async updateStatus(tenantId: string, status: TenantStatus): Promise<void> {
    await this.pool.query(`UPDATE psr_tenants SET status = $1 WHERE id = $2`, [status, tenantId]);
  }

  async updateSchemaVersion(tenantId: string, version: string): Promise<void> {
    await this.pool.query(`UPDATE psr_tenants SET schema_version = $1 WHERE id = $2`, [
      version,
      tenantId,
    ]);
  }
}

/**
 * Factory function — preferred public API.
 */
export function pgRegistry(controlPool: Pool): TenantRegistry {
  return new PgTenantRegistry(controlPool);
}

// ─── In-memory registry for tests ───────────────────────────────────────────

export class MemoryTenantRegistry implements TenantRegistry {
  private readonly store = new Map<string, TenantRecord>();

  async findById(tenantId: string): Promise<TenantRecord | null> {
    return this.store.get(tenantId) ?? null;
  }

  async listTenants(filter?: { status?: TenantStatus }): Promise<TenantRecord[]> {
    const all = [...this.store.values()];
    if (filter?.status) return all.filter((r) => r.status === filter.status);
    return all;
  }

  async upsert(
    record: Omit<TenantRecord, 'createdAt'> & { createdAt?: Date },
  ): Promise<TenantRecord> {
    const full: TenantRecord = { ...record, createdAt: record.createdAt ?? new Date() };
    this.store.set(record.id, full);
    return full;
  }

  async updateStatus(tenantId: string, status: TenantStatus): Promise<void> {
    const rec = this.store.get(tenantId);
    if (rec) this.store.set(tenantId, { ...rec, status });
  }

  async updateSchemaVersion(tenantId: string, version: string): Promise<void> {
    const rec = this.store.get(tenantId);
    if (rec) this.store.set(tenantId, { ...rec, schemaVersion: version });
  }
}
