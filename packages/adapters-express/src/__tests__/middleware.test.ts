import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import type { TenantRouter } from '@piyushkumar_dev/core';
import { TenantNotFoundError } from '@piyushkumar_dev/core';
import { createExpressMiddleware, fromHeader, fromSubdomain } from '../index.js';

type RouterRun = (tenantId: string, fn: () => Promise<unknown>) => Promise<unknown>;

/** Build a stub router whose run() simply invokes the callback. */
function stubRouter(run?: RouterRun): TenantRouter<unknown> {
  const impl = run ?? ((_tenantId, fn) => fn());
  return { run: impl } as unknown as TenantRouter<unknown>;
}

function fakeRes(): {
  res: Response;
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
} {
  const json = vi.fn();
  const status = vi.fn();
  const res = { status, json } as unknown as Response;
  status.mockReturnValue(res);
  return { res, status, json };
}

describe('resolver helpers', () => {
  it('fromSubdomain extracts the first label of a 3+ label host', () => {
    expect(fromSubdomain({ hostname: 'acme.app.example.com' } as Request)).toBe('acme');
  });

  it('fromSubdomain returns null for a bare host', () => {
    expect(fromSubdomain({ hostname: 'example.com' } as Request)).toBeNull();
  });

  it('fromHeader reads the named header case-insensitively', () => {
    const req = { headers: { 'x-tenant-id': 'tenant-1' } } as unknown as Request;
    expect(fromHeader('X-Tenant-Id')(req)).toBe('tenant-1');
  });

  it('fromHeader takes the first value of an array header', () => {
    const req = { headers: { 'x-tenant-id': ['a', 'b'] } } as unknown as Request;
    expect(fromHeader('x-tenant-id')(req)).toBe('a');
  });
});

describe('createExpressMiddleware', () => {
  it('runs the downstream handler inside router.run for a resolved tenant', async () => {
    const run = vi.fn(async (_tenantId: string, fn: () => Promise<unknown>) => fn());
    const mw = createExpressMiddleware(stubRouter(run), { resolve: () => 'tenant-1' });
    const next = vi.fn();
    const { res } = fakeRes();

    await mw({ headers: {} } as Request, res, next as unknown as NextFunction);

    expect(run).toHaveBeenCalledWith('tenant-1', expect.any(Function));
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('calls next() without a tenant context when none resolves and required is false', async () => {
    const run = vi.fn(async (_tenantId: string, fn: () => Promise<unknown>) => fn());
    const mw = createExpressMiddleware(stubRouter(run), { resolve: () => null });
    const next = vi.fn();
    const { res } = fakeRes();

    await mw({ headers: {} } as Request, res, next as unknown as NextFunction);

    expect(run).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('returns 401 when no tenant resolves and required is true', async () => {
    const mw = createExpressMiddleware(stubRouter(), { resolve: () => undefined, required: true });
    const next = vi.fn();
    const { res, status, json } = fakeRes();

    await mw({ headers: {} } as Request, res, next as unknown as NextFunction);

    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({
      error: 'Tenant context required',
      code: 'TENANT_REQUIRED',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('maps TenantNotFoundError to a 404 response', async () => {
    const run = vi.fn(async () => {
      throw new TenantNotFoundError('ghost');
    });
    const mw = createExpressMiddleware(stubRouter(run), { resolve: () => 'ghost' });
    const next = vi.fn();
    const { res, status, json } = fakeRes();

    await mw({ headers: {} } as Request, res, next as unknown as NextFunction);

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({
      error: 'Tenant not found: ghost',
      code: 'TENANT_NOT_FOUND',
    });
    expect(next).not.toHaveBeenCalled();
  });
});
