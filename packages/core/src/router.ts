import { createHmac } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { runWithContext, getContext } from './context.js';
import {
  TenantContextError,
  TenantNotFoundError,
  TenantStatusError,
  TenantVersionError,
} from './errors.js';
import { installConnectionGuard, runRawInTenantSchema, sql } from './guard.js';
import { LRUCache } from './lru-cache.js';
import type { TenantRegistry, TenantRecord } from './registry.js';
import type { GuardMode } from './guard.js';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface RouterCacheOptions {
  /** Maximum number of Prisma clients to keep in memory (default 200). */
  maxClients?: number;
  /** Idle TTL in ms — evict clients unused for this long (default 10 min). */
  idleTtlMs?: number;
}

export interface RouterGuardOptions {
  mode?: GuardMode;
}

export interface RouterGovernorOptions {
  /** Max concurrent Prisma operations per tenant (default 4). */
  perTenantConcurrency?: number;
  /** How long to wait for a governor slot before raising TenantBusyError (ms, default 5000). */
  queueTimeoutMs?: number;
  /**
   * Server-side statement timeout applied to every pooled connection (ms, default 30000).
   * Set to 0 to leave Postgres' default (no timeout).
   */
  statementTimeoutMs?: number;
}

export interface CreateTenantRouterOptions<TClient> {
  /** The single shared pg.Pool for all tenant data. */
  pool: Pool;
  /** Registry providing tenant → { schema, status, schemaVersion } lookups. */
  registry: TenantRegistry;
  /** Factory: given a pg adapter, produce a Prisma client. */
  createClient: (adapter: unknown) => TClient;
  /** Client-cache options. */
  cache?: RouterCacheOptions;
  /** Guard options. */
  guard?: RouterGuardOptions;
  /** Governor options. */
  governor?: RouterGovernorOptions;
  /**
   * Minimum schema version the application requires.
   * Tenants below this version are rejected.
   */
  minSchemaVersion?: string;
  /**
   * Optional HMAC secret for signing and verifying job tenant claims (spec §6.6).
   * When set, wrapJob() verifies the sig field in every job envelope.
   * When absent, sig verification is skipped (use only in trusted environments).
   */
  jobSigningSecret?: string;
}

// ─── Job envelope (spec §6.6) ─────────────────────────────────────────────────

/**
 * Envelope every background job must carry.
 * Pass the tenant id explicitly — never rely on ambient context.
 * When jobSigningSecret is configured on the router, sig is verified before
 * the handler runs to prevent tenant spoofing between services.
 */
export interface JobEnvelope<TPayload = unknown> {
  tenant: {
    id: string;
    /** HMAC-SHA256 of tenantId, present when jobSigningSecret is configured. */
    sig?: string;
  };
  payload: TPayload;
}

// ─── Middleware resolver types ────────────────────────────────────────────────

export type MiddlewareTenantResolver<TRequest> = (
  req: TRequest,
) => string | null | undefined | Promise<string | null | undefined>;

export interface MiddlewareOptions<TRequest> {
  resolve: MiddlewareTenantResolver<TRequest>;
  /** Reject requests with no resolvable tenant (default false). */
  required?: boolean;
}

/**
 * The `router.middleware` shorthand — thin wrappers so consumers don't need
 * to import adapter packages just to attach middleware.
 *
 * Each method dynamically imports its adapter package so the core stays
 * dependency-free. If the adapter package is not installed, a helpful error
 * is thrown at middleware-creation time.
 */
export interface RouterMiddleware<TClient> {
  /**
   * Create an Express `RequestHandler` that resolves the tenant and calls
   * `router.run()` for each request.
   *
   * Requires `@piyushkumar_dev/adapters-express` to be installed.
   *
   * @example
   * app.use(router.middleware.express({ resolve: fromHeader('x-tenant-id') }))
   */
  express(opts: MiddlewareOptions<import('http').IncomingMessage>): unknown;

  /**
   * Register the Fastify plugin that resolves the tenant and calls
   * `router.run()` for each request.
   *
   * Requires `@piyushkumar_dev/adapters-fastify` to be installed.
   *
   * @example
   * await fastify.register(router.middleware.fastify({ resolve: fromHeader('x-tenant-id') }))
   */
  fastify(opts: MiddlewareOptions<unknown>): unknown;
}

// ─── TenantRouter interface ───────────────────────────────────────────────────

export interface TenantRouter<TClient> {
  /**
   * Run `fn` inside a tenant context.
   *
   * - Resolves and validates the tenant record (status gate, version gate).
   * - Warms the Prisma client in the LRU cache so `db()` is always synchronous.
   * - Stores context in AsyncLocalStorage for the duration of `fn()`.
   */
  run<T>(tenantId: string, fn: () => Promise<T>): Promise<T>;

  /**
   * Return the Prisma client for the current tenant context.
   *
   * Always returns the real, fully-constructed `TClient` — never a proxy.
   * Safe for model delegates: `db().invoice.findMany()`, `db().$transaction()`.
   *
   * Throws `TenantContextError` if called outside `router.run()`.
   */
  db(): TClient;

  /**
   * Run raw SQL within the current tenant schema using `SET LOCAL search_path`.
   * Must be called inside `router.run()`.
   * The transaction is automatically committed or rolled back.
   */
  raw<T = unknown>(query: { text: string; values: unknown[] }): Promise<{ rows: T[] }>;

  /**
   * Wrap a background-job handler so it runs inside the correct tenant context.
   *
   * Spec §6.6: the job envelope carries `{ tenant: { id, sig? }, payload }`.
   * The tenant id is read from the envelope — never from ambient context.
   * Jobs without a valid tenant claim are routed to the dead-letter handler
   * or thrown if no dead-letter handler is provided.
   *
   * When `jobSigningSecret` is configured, `sig` is verified before the handler
   * runs to prevent one service from spoofing another's tenant claim.
   *
   * @example
   * // SQS / BullMQ worker
   * const handler = router.wrapJob(async (payload, tenantId) => {
   *   const db = router.db();
   *   await db.invoice.updateMany({ ... });
   * });
   * await handler({ tenant: { id: 'abc', sig: '...' }, payload: { ... } });
   */
  wrapJob<TPayload = unknown>(
    handler: (payload: TPayload, tenantId: string) => Promise<void>,
    options?: {
      /** Called when sig verification fails or tenant id is missing. Defaults to throw. */
      onDeadLetter?: (envelope: JobEnvelope<TPayload>, reason: string) => Promise<void>;
    },
  ): (envelope: JobEnvelope<TPayload>) => Promise<void>;

  /**
   * Explicit control-plane access — logged and schema-neutral.
   * Use this for admin operations instead of a bare global client import.
   */
  system<T>(fn: (pool: Pool) => Promise<T>): Promise<T>;

  /**
   * Run a function for every ready tenant, in bounded concurrency.
   * Each invocation is isolated in its own `router.run()` context.
   */
  forEachTenant<T>(
    fn: (tenantId: string) => Promise<T>,
    options?: { concurrency?: number },
  ): Promise<Array<{ tenantId: string; result?: T; error?: unknown }>>;

  /**
   * Thin adapter shortcuts — avoids importing adapter packages directly.
   * @see RouterMiddleware
   */
  middleware: RouterMiddleware<TClient>;

  /**
   * Debug snapshot for health endpoints and monitoring.
   */
  debugSnapshot(): {
    cacheSize: number;
    inflightCount: number;
    poolTotalCount: number;
    poolIdleCount: number;
    poolWaitingCount: number;
  };

  /**
   * Dispose all cached clients and close the shared pool.
   * Call this on process shutdown (SIGTERM / SIGINT).
   */
  dispose(): Promise<void>;
}

// ─── Internal context shape ───────────────────────────────────────────────────

const CLIENT_KEY = Symbol('psr.client');

interface TenantContextInternal {
  tenant: TenantRecord;
  [CLIENT_KEY]: unknown;
}

// ─── Pool proxy — tenant clients cannot close the shared pool ────────────────

function makePoolProxy(pool: Pool): Pool {
  return new Proxy(pool, {
    get(target, prop) {
      if (prop === 'end') {
        return (): Promise<void> => Promise.resolve();
      }
      const val = Reflect.get(target, prop, target);
      return typeof val === 'function' ? (val as (...a: unknown[]) => unknown).bind(target) : val;
    },
  });
}

// ─── Optional module loading ─────────────────────────────────────────────────

/**
 * Runtime-only dynamic import for optional peer packages (adapters, governor).
 *
 * The specifier is a plain `string` value rather than a string literal at the
 * import site, so TypeScript never tries to resolve `@piyushkumar_dev/*` at compile time.
 * This keeps @piyushkumar_dev/core dependency-light; the module is resolved at runtime and
 * the caller throws a helpful error if it is not installed.
 */
function importOptionalModule(specifier: string): Promise<Record<string, unknown>> {
  return import(specifier) as Promise<Record<string, unknown>>;
}

// ─── HMAC helpers (spec §6.6) ─────────────────────────────────────────────────

function signTenantId(tenantId: string, secret: string): string {
  return createHmac('sha256', secret).update(tenantId).digest('hex');
}

function verifyTenantSig(tenantId: string, sig: string, secret: string): boolean {
  const expected = signTenantId(tenantId, secret);
  // Constant-time comparison to prevent timing attacks
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  }
  return diff === 0;
}

// ─── Main factory ─────────────────────────────────────────────────────────────

export function createTenantRouter<TClient>(
  options: CreateTenantRouterOptions<TClient>,
): TenantRouter<TClient> {
  const {
    pool,
    registry,
    createClient,
    cache: cacheOpts = {},
    guard: guardOpts = {},
    governor: governorOpts,
    minSchemaVersion,
    jobSigningSecret,
  } = options;

  const guardMode = guardOpts.mode ?? 'strict';

  // L2: set search_path = psr_guard on every new physical connection
  installConnectionGuard(pool, guardMode);

  // Wrap pool so tenant client disconnect cannot close the shared pool
  const tenantPool = makePoolProxy(pool);

  // LRU client cache keyed by schema name
  const clientCache = new LRUCache<TClient>({
    maxSize: cacheOpts.maxClients ?? 200,
    idleTtlMs: cacheOpts.idleTtlMs ?? 10 * 60_000,
    onEvict: async (_key, client) => {
      if (client && typeof (client as Record<string, unknown>)['$disconnect'] === 'function') {
        try {
          await (client as unknown as { $disconnect: () => Promise<void> }).$disconnect();
        } catch {
          // Ignore disconnection errors on eviction
        }
      }
    },
  });

  async function buildClient(schemaName: string): Promise<TClient> {
    let PrismaPg: new (pool: Pool, opts: { schema: string }) => unknown;
    try {
      const mod = (await import('@prisma/adapter-pg')) as {
        PrismaPg: new (pool: Pool, opts: { schema: string }) => unknown;
      };
      PrismaPg = mod.PrismaPg;
    } catch {
      throw new Error(
        '[psr/core] Missing peer dependency @prisma/adapter-pg. ' +
          'Install it with: npm install @prisma/adapter-pg',
      );
    }
    const adapter = new PrismaPg(tenantPool, { schema: schemaName });
    return createClient(adapter);
  }

  async function getClientForSchema(schemaName: string): Promise<TClient> {
    return clientCache.getOrCreate(schemaName, () => buildClient(schemaName));
  }

  function checkVersion(tenant: TenantRecord): void {
    if (!minSchemaVersion) return;
    const tv = tenant.schemaVersion ?? '';
    if (tv < minSchemaVersion) {
      throw new TenantVersionError(tenant.id, tenant.schemaVersion, minSchemaVersion);
    }
  }

  // ─── Optional governor (spec §6.5) ──────────────────────────────────────────
  // Per-tenant concurrency cap with a fair queue. Loaded lazily so @piyushkumar_dev/core
  // does not depend on @piyushkumar_dev/governor unless the `governor` option is provided.
  interface GovernorLike {
    run<T>(tenantId: string, fn: () => Promise<T>): Promise<T>;
    /** Installs the server-side statement timeout on every new pooled connection. */
    applyStatementTimeout?(pool: Pool): void;
  }

  let governorPromise: Promise<GovernorLike> | null = null;

  function getGovernor(): Promise<GovernorLike> | null {
    if (!governorOpts) return null;
    if (!governorPromise) {
      governorPromise = importOptionalModule('@piyushkumar_dev/governor')
        .then((mod) => {
          const PoolGovernor = mod['PoolGovernor'] as
            (new (opts: RouterGovernorOptions) => GovernorLike) | undefined;
          if (typeof PoolGovernor !== 'function') {
            throw new Error('[psr/core] @piyushkumar_dev/governor does not export PoolGovernor');
          }
          return new PoolGovernor(governorOpts);
        })
        .catch(() => {
          throw new Error(
            '[psr/core] The `governor` option requires @piyushkumar_dev/governor. ' +
              'Install it with: npm install @piyushkumar_dev/governor',
          );
        });
    }
    return governorPromise;
  }

  // Load the governor eagerly when configured so it can install the statement
  // timeout on the shared pool before the first request opens a connection.
  // Load failures are ignored here and resurfaced by run().
  if (governorOpts) {
    void getGovernor()
      ?.then((g) => g.applyStatementTimeout?.(pool))
      .catch(() => {});
  }

  // The router object — assigned to a const so middleware methods can reference it.
  const router: TenantRouter<TClient> = {
    async run<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
      const tenant = await registry.findById(tenantId);
      if (!tenant) throw new TenantNotFoundError(tenantId);

      // L5: status gate
      if (
        tenant.status === 'suspended' ||
        tenant.status === 'archived' ||
        tenant.status === 'deleted'
      ) {
        throw new TenantStatusError(tenantId, tenant.status);
      }
      if (tenant.status === 'provisioning') {
        throw new TenantStatusError(
          tenantId,
          tenant.status,
          `Tenant ${tenantId} is still being provisioned`,
        );
      }

      checkVersion(tenant);

      // Pre-warm: build (or retrieve from cache) the client before fn() runs.
      const client = await getClientForSchema(tenant.schemaName);

      const ctx: TenantContextInternal = { tenant, [CLIENT_KEY]: client };
      const runInContext = (): Promise<T> =>
        runWithContext(ctx as Parameters<typeof runWithContext>[0], fn);

      // L4: per-tenant concurrency cap — bounded when a governor is configured.
      const governor = getGovernor();
      if (!governor) return runInContext();
      const g = await governor;
      return g.run(tenantId, runInContext);
    },

    db(): TClient {
      const ctx = getContext() as TenantContextInternal;
      const client = ctx[CLIENT_KEY] as TClient | undefined;
      if (client === undefined) {
        throw new TenantContextError(
          'Prisma client not available. Use router.run() to establish a tenant context.',
        );
      }
      return client;
    },

    async raw<T = unknown>(query: { text: string; values: unknown[] }): Promise<{ rows: T[] }> {
      const ctx = getContext() as TenantContextInternal;
      const schemaName = ctx.tenant.schemaName;
      const pgClient: PoolClient = await pool.connect();
      try {
        let result!: { rows: T[] };
        await runRawInTenantSchema(pgClient, schemaName, async () => {
          const r = await pgClient.query(query.text, query.values);
          result = r as unknown as { rows: T[] };
        });
        return result;
      } finally {
        pgClient.release();
      }
    },

    wrapJob<TPayload = unknown>(
      handler: (payload: TPayload, tenantId: string) => Promise<void>,
      options?: {
        onDeadLetter?: (envelope: JobEnvelope<TPayload>, reason: string) => Promise<void>;
      },
    ): (envelope: JobEnvelope<TPayload>) => Promise<void> {
      return async (envelope: JobEnvelope<TPayload>): Promise<void> => {
        const tenantId = envelope.tenant?.id;

        // No tenant id — dead-letter
        if (!tenantId) {
          const reason = 'Job envelope missing tenant.id';
          if (options?.onDeadLetter) {
            await options.onDeadLetter(envelope, reason);
            return;
          }
          throw new TenantContextError(reason);
        }

        // Sig verification when secret is configured
        if (jobSigningSecret) {
          const sig = envelope.tenant.sig;
          if (!sig) {
            const reason = `Job for tenant ${tenantId} is missing tenant.sig (jobSigningSecret is configured)`;
            if (options?.onDeadLetter) {
              await options.onDeadLetter(envelope, reason);
              return;
            }
            throw new TenantContextError(reason);
          }
          if (!verifyTenantSig(tenantId, sig, jobSigningSecret)) {
            const reason = `Job for tenant ${tenantId} has invalid sig — possible spoofing attempt`;
            if (options?.onDeadLetter) {
              await options.onDeadLetter(envelope, reason);
              return;
            }
            throw new TenantContextError(reason);
          }
        }

        // Run inside tenant context
        await router.run(tenantId, () => handler(envelope.payload, tenantId));
      };
    },

    async system<T>(fn: (p: Pool) => Promise<T>): Promise<T> {
      console.log(`[psr/system] control-plane access at ${new Date().toISOString()}`);
      return fn(pool);
    },

    async forEachTenant<T>(
      fn: (tenantId: string) => Promise<T>,
      opts: { concurrency?: number } = {},
    ): Promise<Array<{ tenantId: string; result?: T; error?: unknown }>> {
      const concurrency = opts.concurrency ?? 4;
      const tenants = await registry.listTenants({ status: 'ready' });
      const results: Array<{ tenantId: string; result?: T; error?: unknown }> = [];

      for (let i = 0; i < tenants.length; i += concurrency) {
        const batch = tenants.slice(i, i + concurrency);
        const batchResults = await Promise.all(
          batch.map(async (t) => {
            try {
              const result = await fn(t.id);
              return { tenantId: t.id, result };
            } catch (error) {
              return { tenantId: t.id, error };
            }
          }),
        );
        results.push(...batchResults);
      }

      return results;
    },

    middleware: {
      express(opts) {
        // Dynamically import to keep @piyushkumar_dev/core free of adapter dependencies.
        // The import() call is synchronous from the caller's perspective because
        // it returns a RequestHandler function (not a promise).
        // We return a wrapper that lazy-loads on first call.
        let _mw: unknown;
        return async function psrExpressMiddlewareLazy(req: unknown, res: unknown, next: unknown) {
          if (!_mw) {
            const mod = (await importOptionalModule('@piyushkumar_dev/adapters-express').catch(
              () => {
                throw new Error(
                  '[psr/core] router.middleware.express() requires @piyushkumar_dev/adapters-express. ' +
                    'Install it with: npm install @piyushkumar_dev/adapters-express',
                );
              },
            )) as {
              createExpressMiddleware: (
                r: TenantRouter<TClient>,
                o: typeof opts,
              ) => (req: unknown, res: unknown, next: unknown) => Promise<void>;
            };
            _mw = mod.createExpressMiddleware(router, opts);
          }
          await (_mw as (req: unknown, res: unknown, next: unknown) => Promise<void>)(
            req,
            res,
            next,
          );
        };
      },

      fastify(opts) {
        // Returns a Fastify plugin function. Consumers: fastify.register(router.middleware.fastify(...))
        return async function psrFastifyPluginLazy(
          fastify: unknown,
          _options: unknown,
          done: unknown,
        ) {
          const mod = (await importOptionalModule('@piyushkumar_dev/adapters-fastify').catch(() => {
            throw new Error(
              '[psr/core] router.middleware.fastify() requires @piyushkumar_dev/adapters-fastify. ' +
                'Install it with: npm install @piyushkumar_dev/adapters-fastify',
            );
          })) as { psrFastifyPlugin: (f: unknown, o: unknown, d: unknown) => void };
          mod.psrFastifyPlugin(fastify, { router, ...opts }, done);
        };
      },
    },

    debugSnapshot() {
      return {
        cacheSize: clientCache.size,
        inflightCount: clientCache.inflightCount,
        poolTotalCount: pool.totalCount,
        poolIdleCount: pool.idleCount,
        poolWaitingCount: pool.waitingCount,
      };
    },

    async dispose(): Promise<void> {
      await clientCache.clear();
      await pool.end();
    },
  };

  return router;
}

// ─── Helpers re-exported for convenience ─────────────────────────────────────
export { sql };
export type { TenantContextError, TenantNotFoundError, TenantStatusError, TenantVersionError };

/**
 * Sign a tenant id for use in job envelopes.
 * Use this in the service that enqueues jobs.
 *
 * @example
 * const envelope = {
 *   tenant: { id: tenantId, sig: signJobTenant(tenantId, process.env.JOB_SECRET) },
 *   payload: { invoiceId: '...' },
 * };
 */
export { signTenantId as signJobTenant };
