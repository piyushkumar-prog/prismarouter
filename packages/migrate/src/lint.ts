import type { MigrationFile } from './migrations-dir.js';
import type { LintIssue } from './types.js';

interface LintRule {
  code: string;
  severity: 'error' | 'warning';
  description: string;
  check: (sql: string) => boolean;
  message: (migration: string) => string;
}

const LINT_RULES: LintRule[] = [
  {
    code: 'PSR001',
    severity: 'error',
    description: 'DROP COLUMN detected',
    check: (sql) => /\bDROP\s+COLUMN\b/i.test(sql),
    message: (m) =>
      `${m}: DROP COLUMN detected. Use expand/contract: add the new column, migrate data, then drop in a later migration.`,
  },
  {
    code: 'PSR002',
    severity: 'error',
    description: 'DROP TABLE detected',
    check: (sql) => /\bDROP\s+TABLE\b/i.test(sql),
    message: (m) =>
      `${m}: DROP TABLE detected. Ensure all application code referencing this table is removed first.`,
  },
  {
    code: 'PSR003',
    severity: 'warning',
    description: 'NOT NULL without DEFAULT on ALTER TABLE',
    check: (sql) =>
      /\bALTER\s+TABLE\b.*\bADD\s+COLUMN\b.*\bNOT\s+NULL\b/is.test(sql) &&
      !/\bDEFAULT\b/i.test(sql),
    message: (m) =>
      `${m}: ADD COLUMN NOT NULL without DEFAULT will fail on non-empty tables. Add a DEFAULT or backfill first.`,
  },
  {
    code: 'PSR004',
    severity: 'warning',
    description: 'Non-concurrent index creation',
    check: (sql) =>
      /\bCREATE\s+INDEX\b/i.test(sql) && !/\bCREATE\s+INDEX\s+CONCURRENTLY\b/i.test(sql),
    message: (m) =>
      `${m}: CREATE INDEX without CONCURRENTLY will lock the table. Use CREATE INDEX CONCURRENTLY in a non-transactional migration.`,
  },
  {
    code: 'PSR005',
    severity: 'warning',
    description: 'Column type change that may rewrite the table',
    check: (sql) => /\bALTER\s+COLUMN\b.*\bTYPE\b/is.test(sql),
    message: (m) =>
      `${m}: Column TYPE change detected. This may rewrite the table and lock it. Verify it can be done online or use a shadow column.`,
  },
];

export function lintMigrations(migrations: MigrationFile[]): LintIssue[] {
  const issues: LintIssue[] = [];

  for (const migration of migrations) {
    for (const rule of LINT_RULES) {
      if (rule.check(migration.sql)) {
        issues.push({
          migration: migration.version,
          severity: rule.severity,
          code: rule.code,
          message: rule.message(migration.version),
        });
      }
    }
  }

  return issues;
}
