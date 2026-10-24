import type { Pool, PoolClient } from 'pg';
import { quoteIdentifier } from './schema-name.js';

export type GuardMode = 'strict' | 'warn' | 'off';

/**
 * L2: On each new connection from the pool, set search_path to psr_guard
 * (an empty schema that doesn't resolve any tables).
 * This means unqualified raw SQL will error rather than silently hit public.
 *
 * Prisma model queries are schema-qualified by the adapter, so they are unaffected.
 */
export function installConnectionGuard(pool: Pool, mode: GuardMode): void {
  if (mode === 'off') return;

  // Attach a single pool-level handler rather than per-client, to avoid listener growth.
  pool.on('connect', (client: PoolClient) => {
    // Fire-and-forget: set search_path on every new physical connection.
    client.query(`SET search_path = psr_guard`).catch((err: unknown) => {
      if (mode === 'strict') {
        // The guard schema might not exist yet during bootstrapping — log but don't crash.
        console.error('[psr/guard] Failed to set search_path on new connection:', err);
      }
    });
  });
}

/**
 * L3: Run a raw SQL template literal inside a transaction with SET LOCAL search_path
 * scoped to the tenant schema. SET LOCAL ends with the transaction, keeping it safe
 * under transaction-mode poolers.
 */
export async function runRawInTenantSchema<T>(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
  schemaName: string,
  fn: () => Promise<T>,
): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL search_path = ${quoteIdentifier(schemaName)}`);
    const result = await fn();
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

/**
 * A tagged template literal helper for raw SQL queries.
 * Returns a {text, values} object compatible with pg's query interface.
 */
export function sql(
  strings: TemplateStringsArray,
  ...values: unknown[]
): { text: string; values: unknown[] } {
  let text = '';
  const params: unknown[] = [];
  strings.forEach((str, i) => {
    text += str;
    if (i < values.length) {
      params.push(values[i]);
      text += `$${params.length}`;
    }
  });
  return { text, values: params };
}
