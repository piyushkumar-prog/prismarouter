import { describe, it, expect } from 'vitest';
import { runWithContext, getContext, tryGetContext } from '../context.js';
import { TenantContextError } from '../errors.js';
import type { TenantRecord } from '../registry.js';

const fakeTenant: TenantRecord = {
  id: 'tenant-1',
  slug: 'acme',
  schemaName: 't_acme_12345678',
  status: 'ready',
  schemaVersion: null,
  placement: 'shared',
  createdAt: new Date(),
};

describe('Context', () => {
  it('getContext throws outside runWithContext', () => {
    expect(() => getContext()).toThrow(TenantContextError);
  });

  it('tryGetContext returns null outside runWithContext', () => {
    expect(tryGetContext()).toBeNull();
  });

  it('getContext returns the active context inside runWithContext', () => {
    const ctx = { tenant: fakeTenant };
    runWithContext(ctx, () => {
      expect(getContext()).toBe(ctx);
      expect(getContext().tenant.id).toBe('tenant-1');
    });
  });

  it('context propagates through async boundaries', async () => {
    const ctx = { tenant: fakeTenant };
    await runWithContext(ctx, async () => {
      await Promise.resolve();
      expect(getContext().tenant.id).toBe('tenant-1');
    });
  });

  it('context does not leak between concurrent runs', async () => {
    const ctxA = { tenant: { ...fakeTenant, id: 'a' } };
    const ctxB = { tenant: { ...fakeTenant, id: 'b' } };

    await Promise.all([
      runWithContext(ctxA, async () => {
        await new Promise((r) => setTimeout(r, 5));
        expect(getContext().tenant.id).toBe('a');
      }),
      runWithContext(ctxB, async () => {
        await new Promise((r) => setTimeout(r, 1));
        expect(getContext().tenant.id).toBe('b');
      }),
    ]);
  });

  it('context is cleared after runWithContext completes', async () => {
    await runWithContext({ tenant: fakeTenant }, async () => {
      expect(getContext().tenant.id).toBe('tenant-1');
    });
    expect(tryGetContext()).toBeNull();
  });
});
