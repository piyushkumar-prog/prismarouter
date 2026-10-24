/**
 * PSR Example App
 *
 * Demonstrates:
 *   - createTenantRouter with all options
 *   - Express middleware (tenant resolved from X-Tenant-Id header)
 *   - router.db() usage in route handlers
 *   - router.run() for background jobs
 *   - Health endpoint using debugSnapshot()
 *   - Graceful shutdown
 */

import express from 'express';
import { Pool } from 'pg';
import { PrismaClient } from '@prisma/client';
import { createTenantRouter, pgRegistry } from '@psr/core';
import { createExpressMiddleware, fromHeader } from '@psr/adapters-express';

// ─── Setup pools ─────────────────────────────────────────────────────────────

const DATABASE_URL = process.env['DATABASE_URL'];
const PSR_CONTROL_URL = process.env['PSR_CONTROL_URL'] ?? DATABASE_URL;

if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL env var is required');
  process.exit(1);
}

// One shared pool for all tenant data
const dataPool = new Pool({
  connectionString: DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

// Separate pool for control-plane queries
const controlPool = new Pool({
  connectionString: PSR_CONTROL_URL,
  max: 5,
});

// ─── Router setup ─────────────────────────────────────────────────────────────

const registry = pgRegistry(controlPool);

const router = createTenantRouter({
  pool: dataPool,
  registry,
  createClient: (adapter) =>
    new PrismaClient({ adapter } as ConstructorParameters<typeof PrismaClient>[0]),
  cache: {
    maxClients: 200,
    idleTtlMs: 10 * 60_000, // 10 minutes
  },
  guard: {
    mode: 'strict', // L2: connection-level search_path guard
  },
  governor: {
    perTenantConcurrency: 4,
    queueTimeoutMs: 5_000,
  },
  minSchemaVersion: '20261001000000_initial',
});

// ─── Express app ──────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// Tenant middleware — resolves from X-Tenant-Id header
// In production use subdomain or JWT claim instead
app.use(
  createExpressMiddleware(router, {
    resolve: fromHeader('x-tenant-id'),
    required: false, // allow unauthenticated routes like /health
  }),
);

// ─── Routes ───────────────────────────────────────────────────────────────────

// Health check — no tenant required
app.get('/health', (_req, res) => {
  const snapshot = router.debugSnapshot();
  res.json({ status: 'ok', ...snapshot });
});

// List invoices for the current tenant
app.get('/invoices', async (_req, res, next) => {
  try {
    const db = router.db() as PrismaClient;
    const invoices = await db.invoice.findMany({ orderBy: { createdAt: 'desc' } });
    res.json(invoices);
  } catch (err) {
    next(err);
  }
});

// Create an invoice
app.post('/invoices', async (req, res, next) => {
  try {
    const { number, amountCents } = req.body as { number: string; amountCents: number };
    const db = router.db() as PrismaClient;
    const invoice = await db.invoice.create({
      data: { number, amountCents, updatedAt: new Date() },
    });
    res.status(201).json(invoice);
  } catch (err) {
    next(err);
  }
});

// List customers
app.get('/customers', async (_req, res, next) => {
  try {
    const db = router.db() as PrismaClient;
    const customers = await db.customer.findMany({ orderBy: { createdAt: 'desc' } });
    res.json(customers);
  } catch (err) {
    next(err);
  }
});

// Raw SQL example — runs inside tenant schema via SET LOCAL search_path
app.get('/invoices/count', async (_req, res, next) => {
  try {
    const result = await router.raw<{ count: string }>({
      text: 'SELECT count(*) as count FROM "Invoice"',
      values: [],
    });
    res.json({ count: parseInt(result.rows[0]?.count ?? '0', 10) });
  } catch (err) {
    next(err);
  }
});

// Error handler
app.use(
  (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = err instanceof Error ? err.message : 'Internal server error';
    const code = (err as { code?: string }).code ?? 'INTERNAL_ERROR';
    const status =
      code === 'TENANT_NOT_FOUND'
        ? 404
        : code === 'TENANT_STATUS_BLOCKED'
          ? 503
          : code === 'TENANT_CONTEXT_MISSING'
            ? 400
            : 500;
    res.status(status).json({ error: message, code });
  },
);

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env['PORT'] ?? '3000', 10);
const server = app.listen(PORT, () => {
  console.log(`[psr-example] Listening on http://localhost:${PORT}`);
  console.log(`[psr-example] Add header X-Tenant-Id: <tenantId> to route requests`);
});

// Graceful shutdown
const shutdown = async (signal: string): Promise<void> => {
  console.log(`[psr-example] ${signal} received. Shutting down...`);
  server.close(async () => {
    await router.dispose();
    await controlPool.end();
    console.log('[psr-example] Shutdown complete.');
    process.exit(0);
  });
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
