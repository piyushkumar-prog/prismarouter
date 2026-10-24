# prisma-schema-router

[![npm version](https://img.shields.io/npm/v/@piyushkumar_dev/core?label=%40psr%2Fcore&color=blue)](https://www.npmjs.com/package/@piyushkumar_dev/core)
[![CI](https://github.com/piyushkumar-prog/prisma-schema-router/actions/workflows/ci.yml/badge.svg)](https://github.com/piyushkumar-prog/prisma-schema-router/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node ≥18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](package.json)

**The operations layer for schema-per-tenant PostgreSQL on Prisma: route, guard, migrate, govern, verify.**

---

## The problem

Routing a Prisma client to a tenant's schema is the easy 10%.
What hurts once you have hundreds of tenants:

- Applying migrations to every schema safely without downtime
- Proving no query can ever land in the wrong schema
- Stopping one slow tenant from starving all the others
- Keeping memory and connections bounded at any tenant count

No maintained package we found ships all of these together, and none offers the piece
that builds the most trust: an isolation verification suite you can run in CI.

## Use cases

Reach for this when schema-per-tenant is a requirement rather than a preference:

- **Compliance-grade isolation.** Regulated tenants (health, finance, public sector)
  that contractually or legally need their data in its own schema, not merely its own rows.
- **Per-tenant schema shape.** Customers with genuinely different tables or custom columns,
  where one shared schema would decay into a sprawl of nullable columns.
- **Fleet migrations.** Hundreds or thousands of tenant schemas that must be migrated in
  order, canary-gated, with bounded concurrency and crash-safe resume.
- **Noisy-neighbour control.** A small shared pool where one busy tenant must not starve
  the rest — per-tenant concurrency caps and a fair queue.
- **Audit evidence.** A runnable isolation conformance suite that emits a report you can
  attach to a compliance review or gate in CI.
- **Per-tenant background work.** Cron sweeps and maintenance jobs across every tenant,
  each in its own context, with signed job envelopes so a spoofed tenant id is rejected.
- **A path to dedicated databases.** Start shared; move your largest tenant to its own
  pool or database later, behind the same API.

If you only need logical separation, prefer a shared schema with a `tenant_id` column and
RLS — see the next section.

## When NOT to use this

A shared schema with a `tenant_id` column and PostgreSQL Row Level Security is the better default for most SaaS products — lower ops overhead, simpler migrations, no connection pressure. Use schema-per-tenant when:

- You need hard data isolation for compliance or contractual reasons
- Tenants have genuinely different schema shapes or custom columns
- You need to move a tenant to a dedicated database behind the same API

---

## Quick start

```bash
npm install @piyushkumar_dev/core @piyushkumar_dev/migrate @piyushkumar_dev/provision @piyushkumar_dev/testing @piyushkumar_dev/governor @piyushkumar_dev/adapters-express
npm install --save-peer @prisma/client @prisma/adapter-pg pg
```

> `@piyushkumar_dev/migrate` owns the `psr` CLI. It loads companion packages on demand, so install the
> ones whose commands you run: `psr tenants …` needs `@piyushkumar_dev/provision`, `psr verify` needs
> `@piyushkumar_dev/testing`.

```ts
import { Pool } from 'pg';
import { PrismaClient } from '@prisma/client';
import { createTenantRouter, pgRegistry, fromHeader } from '@piyushkumar_dev/core';

// One shared pool for all tenant data; one pool for the control plane.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 20 });
const controlPool = new Pool({ connectionString: process.env.PSR_CONTROL_URL });

const router = createTenantRouter({
  pool,
  registry: pgRegistry(controlPool),
  createClient: (adapter) => new PrismaClient({ adapter }),
  cache: { maxClients: 200, idleTtlMs: 10 * 60_000 },
  guard: { mode: 'strict' },
  governor: { perTenantConcurrency: 4, queueTimeoutMs: 5_000 },
  minSchemaVersion: '20261001000000_initial',
  jobSigningSecret: process.env.JOB_SIGNING_SECRET,
});

// Express — tenant resolved from the X-Tenant-Id header
app.use(router.middleware.express({ resolve: fromHeader('x-tenant-id') }));

// Inside any route handler:
const db = router.db(); // throws if no tenant context
const invoices = await db.invoice.findMany();
```

Bootstrap the control schema once:

```bash
psql $DATABASE_URL -f node_modules/@piyushkumar_dev/migrate/sql/001_create_control_tables.sql
```

Provision your first tenant:

```bash
pnpm psr tenants provision acme --strategy replay
```

---

## Architecture

Two planes:

```
request / job
  │  resolve tenant (header | subdomain | JWT | signed job claim)
  ▼
registry lookup (control DB, cached, status check)
  ▼
router.run(tenantId, fn) ── AsyncLocalStorage ──► router.db()
  │                                                     │
  ▼                                                     ▼
governor (per-tenant concurrency)          client cache (LRU) → adapter(schema)
                                                                │
                                                      shared pg.Pool (bounded)
```

**Control plane** — a small Postgres database holding `psr_tenants`, `psr_migration_runs`, `psr_tenant_migrations`.

**Data plane** — the single shared `pg.Pool` serving all tenant schemas. Connection count is a property of the pool (`max`), not of the tenant count.

---

## Packages

| Package                                                          | Responsibility                                           |
| ---------------------------------------------------------------- | -------------------------------------------------------- |
| [`@piyushkumar_dev/core`](packages/core)                         | Router, context, LRU client cache, guard L1–L5, registry |
| [`@piyushkumar_dev/migrate`](packages/migrate)                   | Fleet migration engine + `psr` CLI                       |
| [`@piyushkumar_dev/provision`](packages/provision)               | Tenant lifecycle: create, suspend, archive, delete       |
| [`@piyushkumar_dev/governor`](packages/governor)                 | Per-tenant concurrency cap and fair queue                |
| [`@piyushkumar_dev/testing`](packages/testing)                   | Isolation conformance suite (`psr verify`)               |
| [`@piyushkumar_dev/otel`](packages/otel)                         | OpenTelemetry metrics and tracing                        |
| [`@piyushkumar_dev/adapters-express`](packages/adapters-express) | Express `RequestHandler` middleware                      |
| [`@piyushkumar_dev/adapters-fastify`](packages/adapters-fastify) | Fastify plugin                                           |

---

## End-to-End Guide: How the 8 Packages Work Together

The packages are designed as modular layers of a complete multi-tenant platform. Here is the step-by-step workflow showing how all 8 packages connect in a real-world application:

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│ 1. Bootstrap Control Plane (@piyushkumar_dev/migrate)                          │
│    Track tenant metadata, schemas & migration runs in control DB               │
└──────────────────────────────────────┬──────────────────────────────────────────┘
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│ 2. Configure Core Router (@piyushkumar_dev/core)                                │
│    ├── Enforce Noisy-Neighbor Concurrency (@piyushkumar_dev/governor)            │
│    └── Export Tenant Metrics & Traces (@piyushkumar_dev/otel)                   │
└──────────────────────────────────────┬──────────────────────────────────────────┘
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│ 3. Resolve & Route HTTP Requests                                                │
│    ├── Express: @piyushkumar_dev/adapters-express                               │
│    └── Fastify: @piyushkumar_dev/adapters-fastify                               │
└──────────────────────────────────────┬──────────────────────────────────────────┘
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│ 4. Provision & Onboard Tenants (@piyushkumar_dev/provision)                     │
│    Create tenant schemas via Replay, Baseline, or Template Clone                │
└──────────────────────────────────────┬──────────────────────────────────────────┘
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│ 5. Safe Fleet Migrations (@piyushkumar_dev/migrate)                             │
│    Lint DDL, run canary schemas, and batch-deploy across all tenants             │
└──────────────────────────────────────┬──────────────────────────────────────────┘
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│ 6. Isolation Conformance & Audit Evidence (@piyushkumar_dev/testing)            │
│    Run 'psr verify' in CI to prove zero cross-tenant context leaks               │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Step 1: Bootstrap the Control Plane (`@piyushkumar_dev/migrate`)

The control plane database holds tenant metadata, active statuses, and migration run states. Run the bootstrap SQL once against your control DB:

```bash
psql $PSR_CONTROL_URL -f node_modules/@piyushkumar_dev/migrate/sql/001_create_control_tables.sql
```

### Step 2: Initialize Router with Governor & Telemetry (`@piyushkumar_dev/core`, `@piyushkumar_dev/governor`, `@piyushkumar_dev/otel`)

Initialize `createTenantRouter`. The router integrates concurrency management and observability directly:

- **`@piyushkumar_dev/core`**: Provides the `AsyncLocalStorage` execution boundary, LRU client cache, and fail-closed search path guards.
- **`@piyushkumar_dev/governor`**: Prevents one high-traffic tenant from exhausting the shared PostgreSQL pool by enforcing per-tenant concurrency limits and a fair queue.
- **`@piyushkumar_dev/otel`**: Automatically instruments tenant-scoped metrics (`psr.pool.wait_time_ms`, `psr.cache.hits`) and distributed tracing (`psr.tenant.id`).

```ts
import { Pool } from 'pg';
import { PrismaClient } from '@prisma/client';
import { createTenantRouter, pgRegistry } from '@piyushkumar_dev/core';
import { createMetrics } from '@piyushkumar_dev/otel';

const dataPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 20 });
const controlPool = new Pool({ connectionString: process.env.PSR_CONTROL_URL, max: 5 });

// Initialize OpenTelemetry metrics
await createMetrics();

export const router = createTenantRouter({
  pool: dataPool,
  registry: pgRegistry(controlPool),
  createClient: (adapter) => new PrismaClient({ adapter }),
  cache: { maxClients: 200, idleTtlMs: 10 * 60_000 },
  guard: { mode: 'strict' },
  // Concurrency governor integration
  governor: { perTenantConcurrency: 4, queueTimeoutMs: 5_000 },
  minSchemaVersion: '20261001000000_initial',
  jobSigningSecret: process.env.JOB_SIGNING_SECRET,
});
```

### Step 3: Attach Web Framework Middleware (`@piyushkumar_dev/adapters-express` or `@piyushkumar_dev/adapters-fastify`)

Resolve tenants from headers, subdomains, or JWT tokens on incoming HTTP requests:

**Option A: Express (`@piyushkumar_dev/adapters-express`)**

```ts
import express from 'express';
import { createExpressMiddleware, fromHeader } from '@piyushkumar_dev/adapters-express';

const app = express();
app.use(createExpressMiddleware(router, { resolve: fromHeader('x-tenant-id') }));

app.get('/invoices', async (_req, res) => {
  const db = router.db(); // Throws if outside tenant context
  const invoices = await db.invoice.findMany();
  res.json(invoices);
});
```

**Option B: Fastify (`@piyushkumar_dev/adapters-fastify`)**

```ts
import Fastify from 'fastify';
import { psrFastifyPlugin } from '@piyushkumar_dev/adapters-fastify';

const fastify = Fastify();
await fastify.register(psrFastifyPlugin, {
  router,
  resolve: (req) => req.headers['x-tenant-id'] as string,
});

fastify.get('/invoices', async (request) => {
  return request.tenantDb.invoice.findMany();
});
```

### Step 4: Provision & Onboard Tenants (`@piyushkumar_dev/provision`)

Create and manage the lifecycle of tenant schemas (`provisioning → ready → suspended → archived → deleted`):

**Via CLI:**

```bash
psr tenants provision acme_corp --strategy replay
```

**Programmatically in your signup flow:**

```ts
import { TenantProvisioner } from '@piyushkumar_dev/provision';

const provisioner = new TenantProvisioner(dataPool, pgRegistry(controlPool));
const { tenant } = await provisioner.provision({
  slug: 'acme_corp',
  strategy: 'replay',
  source: './prisma/migrations',
});
```

### Step 5: Run Fleet Migrations (`@piyushkumar_dev/migrate`)

Roll out new Prisma schema changes safely across your entire tenant fleet:

```bash
# 1. Lint migration SQL for unsafe statements (e.g. non-concurrent indexes)
psr migrate lint

# 2. Plan and view pending migrations across all registered tenants
psr migrate plan

# 3. Deploy in waves with automated canary gating
psr migrate deploy --canary 2 --concurrency 8
```

### Step 6: Background Jobs & Maintenance Sweeps (`@piyushkumar_dev/core`)

Safely process asynchronous jobs with HMAC-verified tenant envelopes, or run cron sweeps:

```ts
// 1. Process asynchronous jobs (e.g., BullMQ / SQS) with verified tenant context
const processJob = router.wrapJob(async (payload, tenantId) => {
  const db = router.db();
  await db.report.create({ data: payload });
});

// 2. Perform nightly maintenance across all ready tenants with bounded concurrency
await router.forEachTenant(
  async (tenantId) => {
    const db = router.db();
    await db.session.deleteMany({ where: { expiredAt: { lt: new Date() } } });
  },
  { concurrency: 4 },
);
```

### Step 7: Isolation Conformance Suite & CI Auditing (`@piyushkumar_dev/testing`)

Prove in CI and SOC2 / ISO compliance reviews that tenant data cannot leak across schemas:

**Via CLI:**

```bash
psr verify --output-json psr-verify-report.json --output-md psr-verify-report.md
```

**In Vitest / Jest:**

```ts
import { verifyIsolation } from '@piyushkumar_dev/testing';

const report = await verifyIsolation(router, pgRegistry(controlPool), dataPool);
if (report.failed > 0) {
  throw new Error(`Isolation verification failed: ${report.failed} probe(s) failed`);
}
```

---

## Guard layers (fail-closed isolation)

| Layer                 | Mechanism                                                                                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1 Context            | `router.db()` throws `TenantContextError` outside `router.run()`                                                                                               |
| L2 Connection default | Every new pooled connection: `SET search_path = psr_guard` (empty schema). Unqualified raw SQL errors instead of silently hitting `public`.                    |
| L3 Raw SQL            | `router.raw()` runs inside `BEGIN … SET LOCAL search_path … COMMIT`. Safe under transaction-mode poolers.                                                      |
| L4 Roles              | Separate migration role (DDL) and runtime role (no CREATE, no access to unrelated schemas). Optional hardening — see `packages/migrate/sql/002_bootstrap.sql`. |
| L5 Status gate        | Suspended, archived, or mid-migration tenants are rejected at resolve time.                                                                                    |

Guard modes: `strict` (default — throws), `warn` (logs only, for gradual adoption), `off`.

L1, L2/L3 and L5 are exercised directly by the isolation conformance suite — see
[Isolation conformance suite](#isolation-conformance-suite) for the report it emits. L4 is
operational hardening and is not covered by the suite.

---

## API reference

### `createTenantRouter(options)`

```ts
const router = createTenantRouter({
  pool, // shared pg.Pool for tenant data
  registry, // pgRegistry(controlPool) or custom TenantRegistry
  createClient, // (adapter) => new PrismaClient({ adapter })
  cache: {
    maxClients: 200, // LRU size
    idleTtlMs: 600_000, // evict after 10 min idle
  },
  guard: {
    mode: 'strict', // 'strict' | 'warn' | 'off'
  },
  governor: {
    perTenantConcurrency: 4,
    queueTimeoutMs: 5_000,
    statementTimeoutMs: 30_000,
  },
  minSchemaVersion: '...', // reject tenants below this migration version
  jobSigningSecret: '...', // HMAC secret for wrapJob() sig verification
});
```

### `router.run(tenantId, fn)`

Resolves and validates the tenant, warms the client, then runs `fn` inside an AsyncLocalStorage context. All `db()` calls inside `fn` return the correct tenant-scoped client.

### `router.db()`

Returns the `PrismaClient` for the current tenant. Throws `TenantContextError` outside `router.run()`.

### `router.raw(sql\`...\`)`

Runs raw SQL inside a `BEGIN … SET LOCAL search_path = <tenant_schema> … COMMIT`. The `sql` tagged template literal from `@piyushkumar_dev/core` handles parameterisation.

```ts
const result = await router.raw(sql`SELECT count(*) FROM invoices`);
```

### `router.wrapJob(handler, options?)`

Wraps a background-job handler so it runs in the correct tenant context. Extracts the tenant id from the job envelope and verifies the HMAC sig when `jobSigningSecret` is configured.

```ts
// Enqueue (service A)
import { signJobTenant } from '@piyushkumar_dev/core';
const envelope = {
  tenant: { id: tenantId, sig: signJobTenant(tenantId, process.env.JOB_SECRET!) },
  payload: { invoiceId: 'inv_123' },
};

// Process (service B / worker)
const processInvoice = router.wrapJob(
  async (payload, tenantId) => {
    const db = router.db();
    await db.invoice.update({ where: { id: payload.invoiceId }, data: { status: 'sent' } });
  },
  {
    onDeadLetter: async (envelope, reason) => {
      console.error('[dead-letter]', reason, envelope);
      // route to DLQ
    },
  },
);

// SQS / BullMQ processor:
await processInvoice(envelope);
```

### `router.forEachTenant(fn, { concurrency })`

Runs `fn` for every `ready` tenant, each isolated in its own `router.run()` context, with bounded concurrency. Ideal for cron jobs and background maintenance.

```ts
await router.forEachTenant(
  async (tenantId) => {
    const db = router.db();
    await db.invoice.deleteMany({ where: { status: 'draft', createdAt: { lt: cutoff } } });
  },
  { concurrency: 4 },
);
```

### `router.system(fn)`

Explicit control-plane access — logged, schema-neutral, passes the raw pool. Use this instead of a global Prisma import.

### `router.middleware`

Thin shorthands that lazy-load the adapter packages so `@piyushkumar_dev/core` stays dependency-free.

```ts
// Express
app.use(router.middleware.express({ resolve: fromHeader('x-tenant-id') }));

// Fastify
await fastify.register(router.middleware.fastify({ resolve: fromHeader('x-tenant-id') }));
```

### `router.debugSnapshot()`

Returns pool stats and cache metrics for health endpoints.

### `router.dispose()`

Disconnects all cached clients and closes the shared pool. Call this on `SIGTERM` / `SIGINT`.

---

## Fleet migrations

```bash
psr migrate plan                                  # list pending migrations per tenant
psr migrate deploy --concurrency 8 --canary 2     # canary first, then waves
psr migrate deploy --lock-timeout 5000 \
                   --statement-timeout 120000      # custom timeouts
psr migrate status                                # check active run
psr migrate resume                                # resume a stopped run
psr migrate lint                                  # flag destructive patterns
psr migrate drift --tenant acme                   # compare tenant schema to the template
```

Migrations use your normal `prisma/migrations` folder — keep writing migrations the usual Prisma way.

Each tenant migration applies `SET LOCAL lock_timeout` and `SET LOCAL statement_timeout` so a contested lock or runaway DDL statement fails fast rather than stalling the whole fleet.

**Lint rules** (run automatically in CI):

| Code   | Severity | Pattern                                 |
| ------ | -------- | --------------------------------------- |
| PSR001 | error    | `DROP COLUMN`                           |
| PSR002 | error    | `DROP TABLE`                            |
| PSR003 | warning  | `ADD COLUMN NOT NULL` without `DEFAULT` |
| PSR004 | warning  | `CREATE INDEX` without `CONCURRENTLY`   |
| PSR005 | warning  | `ALTER COLUMN … TYPE`                   |

**Rollback:** Postgres DDL is transactional, so each tenant's migration is atomic. Fleet-level rollback means forward-fixing. Document this clearly in your runbooks.

---

## Tenant lifecycle

```bash
psr tenants provision acme --strategy replay
psr tenants suspend  <tenantId>
psr tenants restore  <tenantId>
psr tenants archive  <tenantId>
psr tenants delete   <tenantId> --confirm <tenantId>
```

State machine: `provisioning → ready → suspended → archived → deleted`

Provisioning strategies:

| Strategy           | Description                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------- |
| `replay` (default) | Create schema and apply all migrations in order. Most correct.                              |
| `baseline`         | Apply a squashed baseline SQL file, then later migrations.                                  |
| `clone-template`   | Copy structure from a template schema. Fast for large histories. Drift-checked after clone. |

Deprovisioning is gated: suspend → archive → delete with a confirmation token. `DROP SCHEMA … CASCADE` never runs unless status is `archived` and the token equals the tenant id.

---

## Isolation conformance suite

```bash
psr verify
# Writes psr-verify-report.json and psr-verify-report.md
```

Probes (implemented in [verify.ts](packages/testing/src/verify.ts)):

| #   | Name                         | What it checks                                                                                           |
| --- | ---------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1   | `context-throws-outside-run` | `router.db()` throws `TenantContextError` outside `router.run()`                                         |
| 2   | `sequential-cross-reads`     | Every model in tenant A's schema contains only tenant A's canary rows                                    |
| 3   | `concurrent-isolation`       | 2 000 interleaved tasks (configurable via `concurrencyTasks`) each assert only their own data is visible |
| 4   | `context-loss-fuzzing`       | AsyncLocalStorage context survives `setTimeout`, `setImmediate`, `EventEmitter`, `AsyncResource`         |
| 5   | `raw-sql-guard`              | Unqualified SQL errors under the L2 guard                                                                |
| 6   | `suspended-tenant-rejected`  | Suspended tenants are blocked at `router.run()`                                                          |

Programmatic API for your own test suite:

```ts
import { verifyIsolation } from '@piyushkumar_dev/testing';
const report = await verifyIsolation(router, registry, pool);
if (report.failed > 0) throw new Error('Isolation check failed');
```

> This suite is strong evidence that the router and application wiring are correctly isolated. It is not a proof that every query the application might write is safe.

---

## Observability

```ts
import { createMetrics } from '@piyushkumar_dev/otel';
import { withTenantSpan } from '@piyushkumar_dev/otel';

const metrics = await createMetrics(); // falls back to no-ops if OTel not installed
```

Metrics emitted: `psr.pool.wait_time_ms`, `psr.cache.hits`, `psr.cache.evictions`, `psr.governor.queue_depth`, `psr.context.errors`.

Every OTel span gets a `psr.tenant.id` attribute. Pass `{ hashTenantId: true }` to hash it for PII compliance.

---

## Control-plane schema

Bootstrap once against your control database:

```bash
psql $PSR_CONTROL_URL -f node_modules/@piyushkumar_dev/migrate/sql/001_create_control_tables.sql
# Optional: create migration and runtime roles
psql $PSR_CONTROL_URL -f node_modules/@piyushkumar_dev/migrate/sql/002_bootstrap.sql
```

Tables created:

```
psr_tenants           — tenant registry (id, slug, schema_name, status, schema_version)
psr_migration_runs    — one row per fleet migration run
psr_tenant_migrations — per-tenant state within a run (pending|running|applied|failed)
psr_guard             — empty schema; search_path guard points here (L2)
```

---

## Threat model

### What the guard covers

- Missing tenant context → `TenantContextError` (never a silent fallback to `public`)
- Unqualified raw SQL → error (`psr_guard` has no tables)
- Suspended / archived tenants → rejected before any query runs
- Cross-tenant data in client cache → prevented by schema-scoped clients + LRU eviction with `$disconnect`
- Job tenant spoofing → rejected when `jobSigningSecret` is configured and sig is missing or invalid

### What remains the application's job

- Using `router.db()` instead of a bare global `new PrismaClient()` import
- Using `router.wrapJob()` or `router.forEachTenant()` for background work — never relying on ambient context in workers
- Ensuring third-party libraries don't hold long-lived references to the wrong client
- Validating all data inputs before passing them to Prisma queries

### Out of scope

Schema-per-tenant reduces the attack surface but does not guarantee zero cross-tenant data exposure. An application-level bug (e.g. writing a raw query that hard-codes another tenant's schema name) is outside what this library can prevent. Use the conformance suite (`psr verify`) as evidence in audits, not as a proof.

---

## Non-goals (v1)

- Replacing Prisma or wrapping its query API
- Row Level Security — RLS with a shared schema is the better default for most products; the docs say so
- MySQL or other databases (`schema` means something different there)
- Cross-region sharding
- Guaranteeing application code is bug-free — this library reduces risk, it does not eliminate it

---

## Roadmap

All packages are currently published as **v0.1.0**. The phase labels below are
internal feature milestones rather than released version numbers: phases 0–2 are
complete, phases 3–4 are partially shipped, and everything lands together in the
next published minor.

| Phase         | Scope                                                                                                                       | Exit criteria                                         |
| ------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| ✅ 0. Extract | Framework-free core, fix listener root cause                                                                                | Core passes tests with no SaaS app dependency         |
| ✅ 1. v0.1    | Router, LRU, guard L1–L3, `wrapJob`, replay provisioning, `psr verify` v1, Express + Fastify                                | New user reaches a verified tenant in ~10 min         |
| ✅ 2. v0.2    | Fleet migrations, state tables, lint, drift check, CLI, lock/statement timeouts                                             | 1 000-schema migration completes, resumes after crash |
| 🚧 3. v0.3    | Shipped: governor, OTel, signed job claims, `forEachTenant`. Remaining: SQS and BullMQ adapters                             | Noisy-neighbor benchmark shows governor benefit       |
| 🚧 4. v0.4    | Shipped: baseline + clone-template provisioning. Remaining: lazy migration, NestJS + Next.js adapters, published benchmarks | Benchmarks reproducible from the repo                 |
| 🔲 5. v1.0    | API freeze, native migration applier, tiered placement (dedicated pool), threat model review, Prisma version matrix         | Two external projects running it in production        |

---

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## Security

To report a security vulnerability, see [SECURITY.md](SECURITY.md). Do not open a public issue.

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By participating you agree to abide by its terms.

## License

[MIT](LICENSE) © prisma-schema-router contributors
