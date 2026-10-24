export type MigrationRunStatus = 'running' | 'stopped' | 'completed';
export type TenantMigrationState = 'pending' | 'running' | 'applied' | 'failed';

export interface MigrationRun {
  id: string;
  startedAt: Date;
  targetVersion: string;
  status: MigrationRunStatus;
}

export interface TenantMigrationRecord {
  runId: string;
  tenantId: string;
  state: TenantMigrationState;
  error: string | null;
  updatedAt: Date;
}

export interface MigrationPlanEntry {
  tenantId: string;
  slug: string;
  schemaName: string;
  currentVersion: string | null;
  targetVersion: string;
  pendingMigrations: string[];
}

export interface DeployOptions {
  /** Target migration version. Defaults to latest in the migrations folder. */
  targetVersion?: string;
  /** Max concurrent tenant migrations (default: min(8, poolMax - reserve)). */
  concurrency?: number;
  /** Number of canary tenants to migrate first before proceeding (default 1). */
  canary?: number;
  /** Stop the run after this many tenant failures (default 5). */
  maxFailures?: number;
  /** Health-check function called after canary batch; return false to abort. */
  healthCheck?: () => Promise<boolean>;
  /** Path to the prisma migrations folder (default ./prisma/migrations). */
  migrationsDir?: string;
  /** Whether to resume an existing incomplete run (default false). */
  resume?: boolean;
  /**
   * Per-tenant lock_timeout in ms (spec §6.3).
   * Prevents a migration from waiting forever for a lock held by app traffic.
   * Default: 10 000 ms (10 s). On timeout the tenant is marked failed and the
   * run continues with the next tenant.
   */
  lockTimeoutMs?: number;
  /**
   * Per-tenant statement_timeout in ms (spec §6.3).
   * Prevents a runaway DDL statement from hanging the whole fleet run.
   * Default: 300 000 ms (5 min).
   */
  statementTimeoutMs?: number;
}

export interface DeployResult {
  runId: string;
  total: number;
  applied: number;
  failed: number;
  skipped: number;
  status: MigrationRunStatus;
}

export interface LintIssue {
  migration: string;
  severity: 'error' | 'warning';
  code: string;
  message: string;
}

export interface DriftReport {
  tenantId: string;
  schemaName: string;
  drifted: boolean;
  differences: DriftDifference[];
}

export interface DriftDifference {
  type:
    | 'missing_table'
    | 'extra_table'
    | 'missing_column'
    | 'extra_column'
    | 'missing_index'
    | 'extra_index'
    | 'missing_constraint'
    | 'extra_constraint';
  object: string;
  detail: string;
}
