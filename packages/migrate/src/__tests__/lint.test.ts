import { describe, it, expect } from 'vitest';
import { lintMigrations } from '../lint.js';
import type { MigrationFile } from '../migrations-dir.js';

function migration(version: string, sql: string): MigrationFile {
  return { version, name: version, sqlPath: `/fake/${version}/migration.sql`, sql };
}

describe('lintMigrations', () => {
  it('returns no issues for safe migrations', () => {
    const issues = lintMigrations([
      migration('001', 'CREATE TABLE foo (id uuid primary key);'),
      migration('002', 'ALTER TABLE foo ADD COLUMN bar text DEFAULT NULL;'),
    ]);
    expect(issues).toHaveLength(0);
  });

  it('flags DROP COLUMN as error', () => {
    const issues = lintMigrations([migration('001', 'ALTER TABLE foo DROP COLUMN bar;')]);
    expect(issues.some((i) => i.code === 'PSR001' && i.severity === 'error')).toBe(true);
  });

  it('flags DROP TABLE as error', () => {
    const issues = lintMigrations([migration('001', 'DROP TABLE foo;')]);
    expect(issues.some((i) => i.code === 'PSR002')).toBe(true);
  });

  it('flags non-concurrent index creation as warning', () => {
    const issues = lintMigrations([migration('001', 'CREATE INDEX idx_foo ON foo (bar);')]);
    expect(issues.some((i) => i.code === 'PSR004' && i.severity === 'warning')).toBe(true);
  });

  it('does not flag CREATE INDEX CONCURRENTLY', () => {
    const issues = lintMigrations([
      migration('001', 'CREATE INDEX CONCURRENTLY idx_foo ON foo (bar);'),
    ]);
    expect(issues.every((i) => i.code !== 'PSR004')).toBe(true);
  });

  it('flags ALTER COLUMN TYPE', () => {
    const issues = lintMigrations([
      migration('001', 'ALTER TABLE foo ALTER COLUMN bar TYPE bigint;'),
    ]);
    expect(issues.some((i) => i.code === 'PSR005')).toBe(true);
  });

  it('reports the correct migration version', () => {
    const issues = lintMigrations([
      migration('20261001_drop_col', 'ALTER TABLE foo DROP COLUMN bar;'),
    ]);
    expect(issues[0]?.migration).toBe('20261001_drop_col');
  });
});
