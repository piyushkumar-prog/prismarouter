import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import type { TenantRouter } from '@piyushkumar_dev/core';
import { psrFastifyPlugin, fromHeader, fromSubdomain } from '../index.js';

/** Build a stub router whose run() simply invokes the callback. */
function stubRouter(): TenantRouter<unknown> {
  return {
    run: ((_tenantId: string, fn: () => Promise<unknown>) => fn()) as never,
  } as unknown as TenantRouter<unknown>;
}

describe('fastify resolver helpers', () => {
  it('fromSubdomain extracts the tenant label', () => {
    expect(fromSubdomain({ hostname: 'acme.app.example.com' } as never)).toBe('acme');
  });

  it('fromSubdomain returns null for a bare host', () => {
    expect(fromSubdomain({ hostname: 'example.com' } as never)).toBeNull();
  });

  it('fromHeader reads the named header', () => {
    expect(fromHeader('x-tenant-id')({ headers: { 'x-tenant-id': 'tenant-1' } } as never)).toBe(
      'tenant-1',
    );
  });
});

describe('psrFastifyPlugin', () => {
  it('attaches the resolved tenant id to the request', async () => {
    const app = Fastify();
    await app.register(psrFastifyPlugin, {
      router: stubRouter(),
      resolve: fromHeader('x-tenant-id'),
    });
    app.get('/whoami', async (req) => ({ tenant: req.psrTenantId ?? null }));

    const res = await app.inject({
      method: 'GET',
      url: '/whoami',
      headers: { 'x-tenant-id': 'tenant-1' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tenant: 'tenant-1' });
    await app.close();
  });

  it('returns 401 for a missing tenant when required', async () => {
    const app = Fastify();
    await app.register(psrFastifyPlugin, {
      router: stubRouter(),
      resolve: () => null,
      required: true,
    });
    app.get('/whoami', async () => ({ ok: true }));

    const res = await app.inject({ method: 'GET', url: '/whoami' });

    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('leaves the request untouched when no tenant resolves and required is false', async () => {
    const app = Fastify();
    await app.register(psrFastifyPlugin, { router: stubRouter(), resolve: () => null });
    app.get('/health', async (req) => ({ tenant: req.psrTenantId ?? null }));

    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tenant: null });
    await app.close();
  });
});
