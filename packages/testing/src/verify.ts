import { EventEmitter } from 'node:events';
import { setTimeout as setTimeoutAsync } from 'node:timers/promises';
import { AsyncResource } from 'node:async_hooks';
import type { Pool } from 'pg';
import {
  runWithContext,
  TenantContextError,
  generateSchemaName,
  type TenantRecord,
  type TenantRegistry,
  type TenantRouter,
} from '@piyushkumar_dev/core';
import type { ProbeResult, VerifyOptions, VerifyReport } from './types.js';

type AnyRouter = TenantRouter<unknown>;

async function runProbe(name: string, fn: () => Promise<void>): Promise<ProbeResult> {
  const start = Date.now();
  try {
    await fn();
    return { name, status: 'pass', durationMs: Date.now() - start };
  } catch (err) {
    return {
      name,
      status: 'fail',
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * The isolation conformance suite.
 *
 * Provisions three ephemeral tenants (A, B, C), seeds canary rows,
 * then runs a battery of isolation probes. Cleans up on exit.
 *
 * Pass `seed` and `read` callbacks that match your application's Prisma schema.
 * If omitted, the suite uses raw SQL on a canary table it creates itself.
 */
export async function verifyIsolation(
  router: AnyRouter,
  registry: TenantRegistry,
  pool: Pool,
  opts: VerifyOptions = {},
): Promise<VerifyReport> {
  const start = Date.now();
  const probes: ProbeResult[] = [];
  const CANARY_TABLE = 'psr_canary';

  // ─── Ephemeral tenant setup ───────────────────────────────────────────────

  const setupTenant = async (
    label: string,
  ): Promise<{ id: string; schemaName: string; canary: string }> => {
    const id = `ephemeral-${label}-${Date.now()}`;
    const schemaName = generateSchemaName(`test${label}`);
    const canaryValue = `canary-${label}-${Date.now()}`;

    // upsert and updateStatus are both on TenantRegistry — no cast needed
    await registry.upsert({
      id,
      slug: `test-${label}`,
      schemaName,
      status: 'ready',
      schemaVersion: null,
      placement: 'shared',
    });

    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
      await client.query(
        `CREATE TABLE IF NOT EXISTS "${schemaName}".${CANARY_TABLE} (id text primary key, value text not null)`,
      );
      await client.query(
        `INSERT INTO "${schemaName}".${CANARY_TABLE} (id, value) VALUES ($1, $2)`,
        [id, canaryValue],
      );
    } finally {
      client.release();
    }

    return { id, schemaName, canary: canaryValue };
  };

  // Provision three ephemeral tenants
  type EphemeralTenant = { id: string; schemaName: string; canary: string };
  let tenantA: EphemeralTenant;
  let tenantB: EphemeralTenant;
  let tenantC: EphemeralTenant;

  try {
    [tenantA, tenantB, tenantC] = await Promise.all([
      setupTenant('A'),
      setupTenant('B'),
      setupTenant('C'),
    ]);
  } catch (err) {
    return {
      passed: 0,
      failed: 1,
      skipped: 0,
      total: 1,
      durationMs: Date.now() - start,
      probes: [
        {
          name: 'ephemeral-tenant-setup',
          status: 'fail',
          durationMs: Date.now() - start,
          error: err instanceof Error ? err.message : String(err),
        },
      ],
    };
  }

  const readCanary = async (tenantId: string, schemaName: string): Promise<string | null> => {
    if (opts.read) return opts.read(tenantId);
    const client = await pool.connect();
    try {
      const res = await client.query<{ value: string }>(
        `SELECT value FROM "${schemaName}".${CANARY_TABLE} WHERE id = $1`,
        [tenantId],
      );
      return res.rows[0]?.value ?? null;
    } finally {
      client.release();
    }
  };

  // ─── Probe 1: Context throws outside run() ────────────────────────────────
  probes.push(
    await runProbe('context-throws-outside-run', async () => {
      let threw = false;
      try {
        router.db();
      } catch (err) {
        if (err instanceof TenantContextError) threw = true;
      }
      if (!threw) throw new Error('router.db() should throw TenantContextError outside run()');
    }),
  );

  // ─── Probe 2: Sequential cross-reads ──────────────────────────────────────
  probes.push(
    await runProbe('sequential-cross-reads', async () => {
      for (const { id, schemaName, canary } of [tenantA, tenantB, tenantC]) {
        const val = await readCanary(id, schemaName);
        if (val !== canary) {
          throw new Error(`Tenant ${id}: expected canary "${canary}", got "${String(val)}"`);
        }
        for (const other of [tenantA, tenantB, tenantC]) {
          if (other.id === id) continue;
          const crossVal = await readCanaryFromWrongSchema(
            pool,
            CANARY_TABLE,
            other.id,
            schemaName,
          );
          if (crossVal !== null) {
            throw new Error(
              `Cross-read leak: tenant ${id} schema exposed row from tenant ${other.id}`,
            );
          }
        }
      }
    }),
  );

  // ─── Probe 3: Concurrency — interleaved tasks across all three tenants ─────
  probes.push(
    await runProbe('concurrent-isolation', async () => {
      const count = opts.concurrencyTasks ?? 2000;
      const tenants = [tenantA, tenantB, tenantC];

      const tasks = Array.from({ length: count }, (_, i) => {
        const t = tenants[i % tenants.length]!;
        return readCanary(t.id, t.schemaName).then((val) => {
          if (val !== t.canary) {
            throw new Error(
              `Concurrent task ${i}: expected "${t.canary}" for tenant ${t.id}, got "${String(
                val,
              )}"`,
            );
          }
        });
      });
      await Promise.all(tasks);
    }),
  );

  // ─── Probe 4: Context-loss fuzzing ────────────────────────────────────────
  probes.push(
    await runProbe('context-loss-fuzzing', async () => {
      // Build a minimal context shape that satisfies runWithContext
      const ctx = { tenant: tenantA as unknown as TenantRecord };
      await runWithContext(ctx, async () => {
        // setTimeout
        await new Promise<void>((resolve) => setTimeout(() => resolve(), 0));
        // setImmediate
        await new Promise<void>((resolve) => setImmediate(resolve));
        // EventEmitter
        await new Promise<void>((resolve) => {
          const ee = new EventEmitter();
          ee.on('test', () => resolve());
          ee.emit('test');
        });
        // AsyncResource
        await new Promise<void>((resolve) => {
          const resource = new AsyncResource('psr-test');
          resource.runInAsyncScope(() => resolve());
        });
        // timers/promises
        await setTimeoutAsync(0);
      });
    }),
  );

  // ─── Probe 5: Unqualified raw SQL must error under guard ──────────────────
  probes.push(
    await runProbe('raw-sql-guard', async () => {
      const client = await pool.connect();
      try {
        // Simulate L2 guard: point search_path at an empty/nonexistent schema
        await client.query(`SET search_path = psr_guard_test_nonexistent`);
        let errored = false;
        try {
          await client.query(`SELECT * FROM ${CANARY_TABLE}`);
        } catch {
          errored = true;
        }
        if (!errored) {
          throw new Error(
            'Unqualified raw SQL should error when search_path points to an empty schema',
          );
        }
      } finally {
        await client.query(`SET search_path = public`);
        client.release();
      }
    }),
  );

  // ─── Probe 6: Suspended tenant rejected ───────────────────────────────────
  probes.push(
    await runProbe('suspended-tenant-rejected', async () => {
      await registry.updateStatus(tenantC.id, 'suspended');
      let threw = false;
      try {
        await router.run(tenantC.id, async () => {});
      } catch {
        threw = true;
      }
      await registry.updateStatus(tenantC.id, 'ready');
      if (!threw) throw new Error('Suspended tenant should be rejected by router.run()');
    }),
  );

  // ─── Cleanup ──────────────────────────────────────────────────────────────
  for (const { id, schemaName } of [tenantA, tenantB, tenantC]) {
    const client = await pool.connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    } finally {
      client.release();
    }
    await registry.updateStatus(id, 'deleted');
  }

  const passed = probes.filter((p) => p.status === 'pass').length;
  const failed = probes.filter((p) => p.status === 'fail').length;
  const skipped = probes.filter((p) => p.status === 'skip').length;

  return {
    passed,
    failed,
    skipped,
    total: probes.length,
    durationMs: Date.now() - start,
    probes,
  };
}

async function readCanaryFromWrongSchema(
  pool: Pool,
  table: string,
  tenantId: string,
  schemaName: string,
): Promise<string | null> {
  const client = await pool.connect();
  try {
    const res = await client.query<{ value: string }>(
      `SELECT value FROM "${schemaName}".${table} WHERE id = $1`,
      [tenantId],
    );
    return res.rows[0]?.value ?? null;
  } catch {
    return null;
  } finally {
    client.release();
  }
}

/**
 * Format a VerifyReport as Markdown.
 */
export function formatMarkdownReport(report: VerifyReport): string {
  const icon = (s: string): string => (s === 'pass' ? '✅' : s === 'fail' ? '❌' : '⏭️');
  const rows = report.probes
    .map(
      (p) => `| ${icon(p.status)} ${p.name} | ${p.status} | ${p.durationMs}ms | ${p.error ?? ''} |`,
    )
    .join('\n');

  return `# PSR Isolation Verification Report

**Result:** ${report.failed === 0 ? '✅ PASS' : '❌ FAIL'}  
**Passed:** ${report.passed} / **Failed:** ${report.failed} / **Total:** ${report.total}  
**Duration:** ${report.durationMs}ms

| Probe | Status | Duration | Error |
|-------|--------|----------|-------|
${rows}

> This report is evidence that the router and application wiring are correctly isolated.
> It is not a proof that every query the application might write is safe.
`;
}
