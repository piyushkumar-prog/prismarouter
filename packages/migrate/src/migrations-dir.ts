import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export interface MigrationFile {
  version: string; // e.g. "20261001000000_add_invoices"
  name: string; // human readable part after the timestamp
  sqlPath: string; // absolute path to migration.sql
  sql: string; // contents of migration.sql
}

/**
 * Scan a prisma/migrations directory and return sorted migration files.
 * Each migration directory contains a migration.sql file.
 * Version is the directory name (timestamp prefix).
 */
export async function loadMigrations(migrationsDir: string): Promise<MigrationFile[]> {
  const dir = resolve(migrationsDir);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    throw new Error(`Migrations directory not found: ${dir}`);
  }

  // Only directories matching the prisma migration naming convention
  const migrationDirs = entries.filter((e) => /^\d{14}_/.test(e)).sort(); // lexicographic sort = chronological

  const migrations: MigrationFile[] = [];
  for (const dirName of migrationDirs) {
    const sqlPath = join(dir, dirName, 'migration.sql');
    let sqlContent: string;
    try {
      sqlContent = await readFile(sqlPath, 'utf8');
    } catch {
      // Skip directories without migration.sql (e.g. baseline placeholders)
      continue;
    }
    const underscoreIdx = dirName.indexOf('_');
    migrations.push({
      version: dirName,
      name: underscoreIdx >= 0 ? dirName.slice(underscoreIdx + 1) : dirName,
      sqlPath,
      sql: sqlContent,
    });
  }
  return migrations;
}

/**
 * Returns the latest migration version string, or null if none.
 */
export function latestVersion(migrations: MigrationFile[]): string | null {
  if (migrations.length === 0) return null;
  return migrations[migrations.length - 1]!.version;
}

/**
 * Returns migrations that come after the given version (exclusive).
 */
export function migrationsAfter(
  migrations: MigrationFile[],
  afterVersion: string | null,
): MigrationFile[] {
  if (!afterVersion) return migrations;
  const idx = migrations.findIndex((m) => m.version === afterVersion);
  if (idx === -1) return migrations; // unknown baseline: apply all
  return migrations.slice(idx + 1);
}
