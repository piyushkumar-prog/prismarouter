import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { TenantRouter } from '@psr/core';
import { TenantContextError, TenantStatusError, TenantNotFoundError } from '@psr/core';

export type TenantResolverFn = (
  req: Request,
) => string | null | undefined | Promise<string | null | undefined>;

export interface ExpressMiddlewareOptions {
  /**
   * Function that extracts a tenant id from the request.
   * Return null/undefined to skip (next() will be called without a tenant context).
   */
  resolve: TenantResolverFn;
  /**
   * If true, requests with no resolvable tenant are rejected with 401.
   * Default: false (allows unauthenticated routes to coexist).
   */
  required?: boolean;
}

/**
 * Creates an Express middleware that resolves the tenant from the request
 * and runs the rest of the handler chain inside router.run(tenantId, ...).
 *
 * Usage:
 *   app.use(createExpressMiddleware(router, { resolve: fromSubdomain }))
 */
export function createExpressMiddleware<TClient>(
  router: TenantRouter<TClient>,
  opts: ExpressMiddlewareOptions,
): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    let tenantId: string | null | undefined;
    try {
      tenantId = await opts.resolve(req);
    } catch (err) {
      next(err);
      return;
    }

    if (!tenantId) {
      if (opts.required) {
        res.status(401).json({ error: 'Tenant context required', code: 'TENANT_REQUIRED' });
        return;
      }
      next();
      return;
    }

    try {
      await router.run(tenantId, async () => {
        await new Promise<void>((resolve, reject) => {
          // Wrap next() so errors propagate correctly
          next();
          // We resolve immediately and let Express handle the rest within the context
          resolve();
        });
      });
    } catch (err) {
      if (err instanceof TenantNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
      } else if (err instanceof TenantStatusError) {
        res.status(503).json({ error: err.message, code: err.code });
      } else if (err instanceof TenantContextError) {
        res.status(500).json({ error: err.message, code: err.code });
      } else {
        next(err);
      }
    }
  };
}

/**
 * Resolve tenant from subdomain.
 * e.g.  acme.app.example.com  →  'acme'
 */
export function fromSubdomain(req: Request): string | null {
  const host = req.hostname;
  const parts = host.split('.');
  return parts.length > 2 ? (parts[0] ?? null) : null;
}

/**
 * Resolve tenant from a request header.
 */
export function fromHeader(headerName: string): TenantResolverFn {
  return (req: Request) => {
    const val = req.headers[headerName.toLowerCase()];
    return Array.isArray(val) ? (val[0] ?? null) : (val ?? null);
  };
}
