export type ProbeStatus = 'pass' | 'fail' | 'skip';

export interface ProbeResult {
  name: string;
  status: ProbeStatus;
  durationMs: number;
  error?: string;
}

export interface VerifyReport {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  durationMs: number;
  probes: ProbeResult[];
}

export interface VerifyOptions {
  /** Database URL for tenant data pool. */
  databaseUrl?: string;
  /** Database URL for control plane. */
  controlUrl?: string;
  /** Number of concurrent tasks for the concurrency probe (default 2000). */
  concurrencyTasks?: number;
  /**
   * Factory for creating a Prisma client-like object for a tenant.
   * Called with the schema name, should return an object with query methods.
   */
  clientFactory?: (schemaName: string) => Promise<unknown>;
  /** Seed function: insert canary row for a tenant and return an identifier. */
  seed?: (tenantId: string, schemaName: string) => Promise<string>;
  /** Read function: return the canary value visible in the current context. */
  read?: (tenantId: string) => Promise<string | null>;
}
