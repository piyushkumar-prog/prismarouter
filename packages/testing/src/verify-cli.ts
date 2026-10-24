import { writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { MemoryTenantRegistry, pgRegistry, createTenantRouter } from '@psr/core';
import { verifyIsolation, formatMarkdownReport } from './verify.js';

export async function runVerifyCli(args: string[]): Promise<void> {
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    opts[args[i]?.replace(/^--/, '') ?? ''] = args[i + 1] ?? '';
  }

  const databaseUrl = opts['database-url'] ?? process.env['DATABASE_URL'];
  const controlUrl = opts['control-url'] ?? process.env['PSR_CONTROL_URL'] ?? databaseUrl;

  if (!databaseUrl) {
    console.error('ERROR: DATABASE_URL env var or --database-url required');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const controlPool = new Pool({ connectionString: controlUrl });

  // Use an in-memory registry for ephemeral verify tenants
  const registry = new MemoryTenantRegistry();

  const router = createTenantRouter({
    pool,
    registry,
    createClient: (adapter) => adapter,
    guard: { mode: (opts['guard'] as 'strict' | 'warn' | 'off') ?? 'strict' },
  });

  console.log('[psr verify] Running isolation conformance suite...\n');

  const report = await verifyIsolation(router, registry, pool);

  console.log(`Probes: ${report.total} | Passed: ${report.passed} | Failed: ${report.failed}`);
  console.log(`Duration: ${report.durationMs}ms\n`);

  for (const probe of report.probes) {
    const icon = probe.status === 'pass' ? '✅' : probe.status === 'fail' ? '❌' : '⏭️';
    console.log(
      `  ${icon} ${probe.name} (${probe.durationMs}ms)${probe.error ? ': ' + probe.error : ''}`,
    );
  }

  // Write reports
  const jsonPath = opts['output-json'] ?? 'psr-verify-report.json';
  const mdPath = opts['output-md'] ?? 'psr-verify-report.md';

  await writeFile(jsonPath, JSON.stringify(report, null, 2));
  await writeFile(mdPath, formatMarkdownReport(report));

  console.log(`\nReports written: ${jsonPath}, ${mdPath}`);

  await pool.end();
  await controlPool.end();

  if (report.failed > 0) process.exit(1);
}
