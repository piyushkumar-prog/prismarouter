#!/usr/bin/env node
/**
 * psr CLI — entry point
 * Commands: migrate plan | deploy | status | resume | lint | drift
 *           tenants provision | suspend
 *           verify
 */
import { Pool } from 'pg';
import { pgRegistry } from '@piyushkumar_dev/core';
import { FleetMigrationEngine } from './engine.js';
import { checkDrift } from './drift.js';
import { loadMigrations } from './migrations-dir.js';
import { lintMigrations } from './lint.js';

function getPool(url?: string): Pool {
  const connString = url ?? process.env['DATABASE_URL'];
  if (!connString) {
    console.error('ERROR: DATABASE_URL env var is required');
    process.exit(1);
  }
  return new Pool({ connectionString: connString });
}

function getControlPool(url?: string): Pool {
  const connString = url ?? process.env['PSR_CONTROL_URL'] ?? process.env['DATABASE_URL'];
  if (!connString) {
    console.error('ERROR: PSR_CONTROL_URL or DATABASE_URL env var is required');
    process.exit(1);
  }
  return new Pool({ connectionString: connString });
}

async function cmdMigratePlan(args: string[]): Promise<void> {
  const migrationsDir = args[0] ?? './prisma/migrations';
  const pool = getPool();
  const controlPool = getControlPool();
  const registry = pgRegistry(controlPool);
  const engine = new FleetMigrationEngine(pool, registry, controlPool);

  const plan = await engine.plan({ migrationsDir });
  if (plan.length === 0) {
    console.log('All tenants are up to date.');
  } else {
    console.log(`\n${plan.length} tenant(s) need migration:\n`);
    for (const entry of plan) {
      console.log(
        `  ${entry.slug} (${entry.tenantId}): ${entry.pendingMigrations.length} pending → ${entry.targetVersion}`,
      );
    }
  }
  await pool.end();
  await controlPool.end();
}

async function cmdMigrateDeploy(args: string[]): Promise<void> {
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, '') ?? '';
    opts[key] = args[i + 1] ?? '';
  }

  const pool = getPool();
  const controlPool = getControlPool();
  const registry = pgRegistry(controlPool);
  const engine = new FleetMigrationEngine(pool, registry, controlPool);

  console.log('[psr] Starting fleet migration deploy...');

  const deployOpts: import('./types.js').DeployOptions = {};
  if (opts['concurrency']) deployOpts.concurrency = parseInt(opts['concurrency'], 10);
  if (opts['canary']) deployOpts.canary = parseInt(opts['canary'], 10);
  if (opts['max-failures']) deployOpts.maxFailures = parseInt(opts['max-failures'], 10);
  if (opts['migrations-dir']) deployOpts.migrationsDir = opts['migrations-dir'];
  if (opts['lock-timeout']) deployOpts.lockTimeoutMs = parseInt(opts['lock-timeout'], 10);
  if (opts['statement-timeout'])
    deployOpts.statementTimeoutMs = parseInt(opts['statement-timeout'], 10);

  const result = await engine.deploy(deployOpts);

  console.log(`\nMigration run: ${result.runId}`);
  console.log(`  Total:   ${result.total}`);
  console.log(`  Applied: ${result.applied}`);
  console.log(`  Failed:  ${result.failed}`);
  console.log(`  Skipped: ${result.skipped}`);
  console.log(`  Status:  ${result.status}`);

  await pool.end();
  await controlPool.end();
  if (result.failed > 0) process.exit(1);
}

async function cmdMigrateStatus(): Promise<void> {
  const controlPool = getControlPool();
  const pool = getPool();
  const registry = pgRegistry(controlPool);
  const engine = new FleetMigrationEngine(pool, registry, controlPool);

  const { latestRun, summary } = await engine.status();
  if (!latestRun) {
    console.log('No active migration runs.');
  } else {
    console.log(`Run ${latestRun.id}: ${latestRun.status} → ${latestRun.targetVersion}`);
    if (summary) {
      console.log(
        `  Total: ${summary.total} | Applied: ${summary.applied} | Failed: ${summary.failed} | Pending: ${summary.pending}`,
      );
    }
  }
  await pool.end();
  await controlPool.end();
}

async function cmdMigrateResume(args: string[]): Promise<void> {
  const pool = getPool();
  const controlPool = getControlPool();
  const registry = pgRegistry(controlPool);
  const engine = new FleetMigrationEngine(pool, registry, controlPool);

  console.log('[psr] Resuming fleet migration...');
  const resumeOpts: import('./types.js').DeployOptions = { resume: true };
  if (args[0]) resumeOpts.migrationsDir = args[0];
  const result = await engine.resume(resumeOpts);
  console.log(`Status: ${result.status} | Applied: ${result.applied} | Failed: ${result.failed}`);
  await pool.end();
  await controlPool.end();
}

async function cmdMigrateLint(args: string[]): Promise<void> {
  const migrationsDir = args[0] ?? './prisma/migrations';
  const migrations = await loadMigrations(migrationsDir);
  const issues = lintMigrations(migrations);

  if (issues.length === 0) {
    console.log('No lint issues found.');
    return;
  }

  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');

  if (warnings.length > 0) {
    console.warn('\nWarnings:');
    for (const w of warnings) console.warn(`  [${w.code}] ${w.message}`);
  }
  if (errors.length > 0) {
    console.error('\nErrors:');
    for (const e of errors) console.error(`  [${e.code}] ${e.message}`);
    process.exit(1);
  }
}

async function cmdMigrateDrift(args: string[]): Promise<void> {
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, '') ?? '';
    opts[key] = args[i + 1] ?? '';
  }

  const tenantId = opts['tenant'] ?? args[0];
  const template = opts['template'] ?? 'public';

  if (!tenantId) {
    console.error('Usage: psr migrate drift --tenant <tenantId> [--template <schema>]');
    process.exit(1);
  }

  const pool = getPool();
  const controlPool = getControlPool();
  const registry = pgRegistry(controlPool);

  const tenant = await registry.findById(tenantId);
  if (!tenant) {
    console.error(`ERROR: tenant not found: ${tenantId}`);
    await pool.end();
    await controlPool.end();
    process.exit(1);
  }

  const report = await checkDrift(pool, template, tenant.id, tenant.schemaName);

  if (!report.drifted) {
    console.log(`No drift: ${tenant.slug} (${tenant.schemaName}) matches template "${template}"`);
  } else {
    console.error(`Drift detected for ${tenant.slug} (${tenant.schemaName}) vs "${template}":`);
    for (const diff of report.differences) {
      console.error(`  [${diff.type}] ${diff.object} — ${diff.detail}`);
    }
  }

  await pool.end();
  await controlPool.end();
  if (report.drifted) process.exit(1);
}

// ─── Entry ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const [, , cmd, sub, ...rest] = process.argv;

  if (cmd === 'migrate') {
    switch (sub) {
      case 'plan':
        return cmdMigratePlan(rest);
      case 'deploy':
        return cmdMigrateDeploy(rest);
      case 'status':
        return cmdMigrateStatus();
      case 'resume':
        return cmdMigrateResume(rest);
      case 'lint':
        return cmdMigrateLint(rest);
      case 'drift':
        return cmdMigrateDrift(rest);
      default:
        console.error(`Unknown migrate subcommand: ${sub ?? ''}`);
        console.error('Usage: psr migrate <plan|deploy|status|resume|lint|drift>');
        process.exit(1);
    }
  }

  if (cmd === 'tenants') {
    // Forward to @piyushkumar_dev/provision CLI if installed
    let runProvisionCli: (args: string[]) => Promise<void>;
    try {
      ({ runProvisionCli } = (await import('@piyushkumar_dev/provision/cli' as string)) as {
        runProvisionCli: (args: string[]) => Promise<void>;
      });
    } catch {
      console.error('[psr] `psr tenants` requires @piyushkumar_dev/provision.');
      console.error('Install it with: npm install @piyushkumar_dev/provision');
      process.exit(1);
    }
    await runProvisionCli([sub ?? '', ...rest]);
    return;
  }

  if (cmd === 'verify') {
    let runVerifyCli: (args: string[]) => Promise<void>;
    try {
      ({ runVerifyCli } = (await import('@piyushkumar_dev/testing/cli' as string)) as {
        runVerifyCli: (args: string[]) => Promise<void>;
      });
    } catch {
      console.error('[psr] `psr verify` requires @piyushkumar_dev/testing.');
      console.error('Install it with: npm install @piyushkumar_dev/testing');
      process.exit(1);
    }
    await runVerifyCli(rest);
    return;
  }

  console.error(`Unknown command: ${cmd ?? ''}`);
  console.error('Usage: psr <migrate|tenants|verify>');
  process.exit(1);
}

main().catch((err) => {
  console.error('[psr]', err);
  process.exit(1);
});
