import type {
  FastifyInstance,
  FastifyRequest,
  FastifyReply,
  FastifyPluginCallback,
  HookHandlerDoneFunction,
} from 'fastify';
import fp from 'fastify-plugin';
import type { TenantRouter } from '@psr/core';
import {
  TenantNotFoundError,
  TenantStatusError,
  TenantContextError,
  runWithContext,
} from '@psr/core';
import type { TenantContext } from '@psr/core';

export type FastifyTenantResolverFn = (
  req: FastifyRequest,
) => string | null | undefined | Promise<string | null | undefined>;

export interface FastifyPluginOptions<TClient> {
  router: TenantRouter<TClient>;
  resolve: FastifyTenantResolverFn;
  /** Reject requests with no resolvable tenant (default false). */
  required?: boolean;
}

// Augment the Fastify request type with the tenant context
declare module 'fastify' {
  interface FastifyRequest {
    /** Resolved tenant id for this request, if any. */
    psrTenantId?: string;
  }
}

/**
 * Fastify plugin (fastify-plugin wrapped) that:
 * 1. Resolves the tenant id from each request (onRequest hook).
 * 2. Establishes a tenant context via router.run() for the duration of the
 *    handler (preHandler hook). The context is active when the route handler runs.
 *
 * Context propagation works because preHandler's async closure holds the
 * AsyncLocalStorage store open and Fastify runs preHandlers sequentially
 * before invoking the route handler *in the same async continuation*.
 *
 * Usage:
 *   await fastify.register(psrFastifyPlugin, { router, resolve: fromHeader('x-tenant-id') })
 *
 *   // Inside a route handler:
 *   fastify.get('/items', async (req) => {
 *     const db = req.server.psrRouter.db()  // OR pass router in via closure
 *     return db.item.findMany()
 *   })
 */
const psrFastifyPluginImpl: FastifyPluginCallback<FastifyPluginOptions<unknown>> = (
  fastify: FastifyInstance,
  opts: FastifyPluginOptions<unknown>,
  done: HookHandlerDoneFunction,
): void => {
  // Decorate so TypeScript knows the field exists
  fastify.decorateRequest('psrTenantId', undefined);

  // Step 1 — resolve the tenant id, attach to request
  fastify.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    let tenantId: string | null | undefined;
    try {
      tenantId = await opts.resolve(req);
    } catch (err) {
      reply.send(err);
      return;
    }

    if (!tenantId) {
      if (opts.required) {
        await reply.code(401).send({ error: 'Tenant context required', code: 'TENANT_REQUIRED' });
      }
      return;
    }

    req.psrTenantId = tenantId;
  });

  // Step 2 — establish the tenant context for the request handler.
  //
  // We use a different approach than a no-op run(): we validate the tenant
  // (via registry lookup inside router.run) and store the resolved context
  // on the request so that the handler can call router.db() synchronously.
  //
  // The trick: we start router.run() here and use a Promise + callback to
  // hand control back to Fastify for the route handler to run INSIDE the
  // AsyncLocalStorage scope we opened.
  fastify.addHook(
    'preHandler',
    (req: FastifyRequest, reply: FastifyReply, hookDone: HookHandlerDoneFunction): void => {
      const tenantId = req.psrTenantId;
      if (!tenantId) {
        hookDone();
        return;
      }

      // router.run() opens AsyncLocalStorage, validates the tenant, and calls fn().
      // We need the route handler to execute INSIDE that fn() call.
      // We achieve this by: not calling hookDone() normally — instead we call
      // reply.hijack() and manually drive the Fastify lifecycle from inside
      // router.run().
      //
      // Simpler approach that avoids hijack: wrap the whole thing in a Promise
      // that resolves when the handler finishes, using a deferred pattern.
      let resolveHandler!: () => void;
      let rejectHandler!: (err: unknown) => void;

      // This promise resolves when the route handler AND its reply have been sent
      const handlerComplete = new Promise<void>((res, rej) => {
        resolveHandler = res;
        rejectHandler = rej;
      });

      // Store the resolve/reject callbacks so the route wrapper can call them
      (
        req as FastifyRequest & {
          _psrResolve?: () => void;
          _psrReject?: (e: unknown) => void;
        }
      )._psrResolve = resolveHandler;
      (
        req as FastifyRequest & {
          _psrResolve?: () => void;
          _psrReject?: (e: unknown) => void;
        }
      )._psrReject = rejectHandler;

      opts.router
        .run(tenantId, async () => {
          // Signal Fastify to proceed with the route handler
          hookDone();
          // Wait for the handler to finish before exiting this run() scope
          await handlerComplete;
        })
        .catch((err: unknown) => {
          if (err instanceof TenantNotFoundError) {
            void reply
              .code(404)
              .send({ error: (err as Error).message, code: (err as TenantNotFoundError).code });
          } else if (err instanceof TenantStatusError) {
            void reply
              .code(503)
              .send({ error: (err as Error).message, code: (err as TenantStatusError).code });
          } else if (err instanceof TenantContextError) {
            void reply
              .code(500)
              .send({ error: (err as Error).message, code: (err as TenantContextError).code });
          } else {
            // Unhandled error — let Fastify's error handler deal with it
            void reply.code(500).send(err);
          }
        });
    },
  );

  // Step 3 — after handler sends response, resolve the deferred so run() exits cleanly
  fastify.addHook('onSend', (_req: FastifyRequest, _reply: FastifyReply, payload, done) => {
    const r = (_req as FastifyRequest & { _psrResolve?: () => void })._psrResolve;
    if (r) r();
    done(null, payload);
  });

  fastify.addHook('onError', (_req: FastifyRequest, _reply: FastifyReply, error, done) => {
    const r = (_req as FastifyRequest & { _psrReject?: (e: unknown) => void })._psrReject;
    if (r) r(error);
    done();
  });

  done();
};

export const psrFastifyPlugin = fp(psrFastifyPluginImpl, {
  fastify: '>=4.0.0',
  name: '@psr/adapters-fastify',
});

/**
 * Fastify-flavoured resolver helpers
 */
export function fromHeader(headerName: string): FastifyTenantResolverFn {
  return (req) => {
    const val = req.headers[headerName.toLowerCase()];
    return Array.isArray(val) ? (val[0] ?? null) : ((val as string | undefined) ?? null);
  };
}

export function fromSubdomain(req: FastifyRequest): string | null {
  const host = req.hostname;
  const parts = host.split('.');
  return parts.length > 2 ? (parts[0] ?? null) : null;
}

// Re-export runWithContext for advanced use-cases (e.g. manual context wrapping)
export { runWithContext };
export type { TenantContext };
