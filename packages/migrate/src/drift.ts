import type { Pool } from 'pg';
import type { DriftReport, DriftDifference } from './types.js';

interface SchemaFingerprint {
  tables: Set<string>;
  columns: Map<string, string>; // "table.column" -> data_type
  indexes: Set<string>;
  constraints: Set<string>;
}

async function getFingerprint(pool: Pool, schemaName: string): Promise<SchemaFingerprint> {
  const tables = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = $1 AND table_type = 'BASE TABLE'
      ORDER BY table_name`,
    [schemaName],
  );

  const columns = await pool.query<{ table_name: string; column_name: string; data_type: string }>(
    `SELECT table_name, column_name, data_type
       FROM information_schema.columns
      WHERE table_schema = $1
      ORDER BY table_name, ordinal_position`,
    [schemaName],
  );

  const indexes = await pool.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE schemaname = $1 ORDER BY indexname`,
    [schemaName],
  );

  const constraints = await pool.query<{ constraint_name: string; table_name: string }>(
    `SELECT constraint_name, table_name
       FROM information_schema.table_constraints
      WHERE constraint_schema = $1
      ORDER BY constraint_name`,
    [schemaName],
  );

  const tableSet = new Set(tables.rows.map((r) => r.table_name));
  const columnMap = new Map(
    columns.rows.map((r) => [`${r.table_name}.${r.column_name}`, r.data_type]),
  );
  const indexSet = new Set(indexes.rows.map((r) => r.indexname));
  const constraintSet = new Set(
    constraints.rows.map((r) => `${r.table_name}.${r.constraint_name}`),
  );

  return { tables: tableSet, columns: columnMap, indexes: indexSet, constraints: constraintSet };
}

function compareSets<T>(
  label: 'table' | 'index' | 'constraint',
  template: Set<T>,
  tenant: Set<T>,
): DriftDifference[] {
  const diffs: DriftDifference[] = [];
  for (const item of template) {
    if (!tenant.has(item)) {
      diffs.push({
        type: `missing_${label}`,
        object: String(item),
        detail: `${label} "${String(item)}" exists in template but not in tenant schema`,
      });
    }
  }
  for (const item of tenant) {
    if (!template.has(item)) {
      diffs.push({
        type: `extra_${label}`,
        object: String(item),
        detail: `${label} "${String(item)}" exists in tenant schema but not in template`,
      });
    }
  }
  return diffs;
}

/**
 * Compare a tenant schema fingerprint against the template schema.
 * The template schema is usually the public schema or a dedicated psr_template schema.
 */
export async function checkDrift(
  pool: Pool,
  templateSchema: string,
  tenantId: string,
  tenantSchema: string,
): Promise<DriftReport> {
  const [template, tenant] = await Promise.all([
    getFingerprint(pool, templateSchema),
    getFingerprint(pool, tenantSchema),
  ]);

  const differences: DriftDifference[] = [
    ...compareSets('table', template.tables, tenant.tables),
    ...compareSets('index', template.indexes, tenant.indexes),
    ...compareSets('constraint', template.constraints, tenant.constraints),
  ];

  // Column comparison
  for (const [key, type] of template.columns) {
    if (!tenant.columns.has(key)) {
      differences.push({
        type: 'missing_column',
        object: key,
        detail: `column "${key}" (${type}) exists in template but not in tenant schema`,
      });
    }
  }
  for (const [key] of tenant.columns) {
    if (!template.columns.has(key)) {
      differences.push({
        type: 'extra_column',
        object: key,
        detail: `column "${key}" exists in tenant schema but not in template`,
      });
    }
  }

  return {
    tenantId,
    schemaName: tenantSchema,
    drifted: differences.length > 0,
    differences,
  };
}
