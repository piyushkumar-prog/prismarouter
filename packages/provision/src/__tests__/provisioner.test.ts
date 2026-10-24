import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import type { TenantRegistry, TenantRecord } from '@psr/core';
import { TenantProvisioner } from '../provisioner.js';

function tenantRecord(overrides: Partial<TenantRecord> = {}): TenantRecord {
  return {
    id: 't-1',
    slug: 'acme',
    schemaName: 't_acme',
    status: 'ready',
    schemaVersion: null,
    placement: 'shared',
    createdAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

/** Registry stub recording status transitions. */
function fakeRegistry(tenant?: TenantRecord | null): {
  registry: TenantRegistry;
  updateStatus: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
} {
  const updateStatus = vi.fn(async () => {});
  const findById = vi.fn(async () => tenant ?? null);
  const upsert = vi.fn(async () => tenant ?? tenantRecord());
  return {
    registry: { updateStatus, findById, upsert } as unknown as TenantRegistry,
    updateStatus,
    upsert,
  };
}

/** Pool stub returning a single fake client. */
function fakePool(): {
  pool: Pool;
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query, release }));
  return { pool: { connect } as unknown as Pool, query, release };
}

describe('TenantProvisioner lifecycle', () => {
  it('suspend sets the tenant status to suspended', async () => {
    const { registry, updateStatus } = fakeRegistry();
    await new TenantProvisioner(fakePool().pool, registry).suspend('t-1');
    expect(updateStatus).toHaveBeenCalledWith('t-1', 'suspended');
  });

  it('restore sets the tenant status back to ready', async () => {
    const { registry, updateStatus } = fakeRegistry();
    await new TenantProvisioner(fakePool().pool, registry).restore('t-1');
    expect(updateStatus).toHaveBeenCalledWith('t-1', 'ready');
  });

  it('archive sets the tenant status to archived', async () => {
    const { registry, updateStatus } = fakeRegistry();
    await new TenantProvisioner(fakePool().pool, registry).archive('t-1');
    expect(updateStatus).toHaveBeenCalledWith('t-1', 'archived');
  });
});

describe('TenantProvisioner.deleteTenant safety', () => {
  it('rejects a confirmation token that does not equal the tenant id', async () => {
    const { registry } = fakeRegistry(tenantRecord({ status: 'archived' }));
    await expect(
      new TenantProvisioner(fakePool().pool, registry).deleteTenant('t-1', 't-2'),
    ).rejects.toThrow(/Confirmation token must equal tenantId/);
  });

  it('refuses to delete a tenant that has not been archived', async () => {
    const { registry } = fakeRegistry(tenantRecord({ status: 'ready' }));
    await expect(
      new TenantProvisioner(fakePool().pool, registry).deleteTenant('t-1', 't-1'),
    ).rejects.toThrow(/Can only delete archived tenants/);
  });

  it('drops the schema and marks an archived tenant deleted', async () => {
    const { registry, updateStatus } = fakeRegistry(tenantRecord({ status: 'archived' }));
    const { pool, query } = fakePool();

    await new TenantProvisioner(pool, registry).deleteTenant('t-1', 't-1');

    expect(query).toHaveBeenCalledWith('DROP SCHEMA IF EXISTS "t_acme" CASCADE');
    expect(updateStatus).toHaveBeenCalledWith('t-1', 'deleted');
  });
});

describe('TenantProvisioner.provision', () => {
  it('records the tenant as provisioning before applying migrations', async () => {
    const { registry, upsert } = fakeRegistry();
    const { pool } = fakePool();

    // An unknown strategy source path will fail during replay; we only assert
    // that the tenant was registered as 'provisioning' first.
    await expect(
      new TenantProvisioner(pool, registry).provision({
        slug: 'acme',
        strategy: 'replay',
        source: './does-not-exist-psr-test-migrations',
      }),
    ).rejects.toBeTruthy();

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: 'acme',
        schemaName: expect.stringMatching(/^t_acme_[0-9a-f]{8}$/) as unknown as string,
        status: 'provisioning',
      }),
    );
  });
});
