import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryTenantRegistry } from '../registry.js';
import type { TenantRecord } from '../registry.js';

const record: Omit<TenantRecord, 'createdAt'> = {
  id: 'tenant-1',
  slug: 'acme',
  schemaName: 't_acme_12345678',
  status: 'ready',
  schemaVersion: null,
  placement: 'shared',
};

describe('MemoryTenantRegistry', () => {
  let registry: MemoryTenantRegistry;

  beforeEach(() => {
    registry = new MemoryTenantRegistry();
  });

  it('returns null for missing tenant', async () => {
    expect(await registry.findById('unknown')).toBeNull();
  });

  it('upserts and retrieves a tenant', async () => {
    await registry.upsert(record);
    const found = await registry.findById('tenant-1');
    expect(found?.slug).toBe('acme');
    expect(found?.status).toBe('ready');
  });

  it('updateStatus changes the status', async () => {
    await registry.upsert(record);
    await registry.updateStatus('tenant-1', 'suspended');
    const found = await registry.findById('tenant-1');
    expect(found?.status).toBe('suspended');
  });

  it('updateSchemaVersion sets the version', async () => {
    await registry.upsert(record);
    await registry.updateSchemaVersion('tenant-1', '20261001000000_add_invoices');
    const found = await registry.findById('tenant-1');
    expect(found?.schemaVersion).toBe('20261001000000_add_invoices');
  });

  it('listTenants filters by status', async () => {
    await registry.upsert(record);
    await registry.upsert({
      ...record,
      id: 't2',
      slug: 'beta',
      schemaName: 't_beta_00000001',
      status: 'suspended',
    });
    const ready = await registry.listTenants({ status: 'ready' });
    expect(ready.length).toBe(1);
    expect(ready[0]?.id).toBe('tenant-1');
  });

  it('upsert is idempotent on same id', async () => {
    await registry.upsert(record);
    await registry.upsert({ ...record, slug: 'acme-updated' });
    const all = await registry.listTenants();
    expect(all.length).toBe(1);
    expect(all[0]?.slug).toBe('acme-updated');
  });
});
