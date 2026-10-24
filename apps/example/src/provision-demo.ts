/**
 * Standalone script: provision a demo tenant and run a quick sanity check.
 * Run: node --loader ts-node/esm src/provision-demo.ts
 */

import { Pool } from 'pg';
import { pgRegistry } from '@piyushkumar_dev/core';
import { TenantProvisioner } from '@piyushkumar_dev/provision';

const DATABASE_URL = process.env['DATABASE_URL'];
const PSR_CONTROL_URL = process.env['PSR_CONTROL_URL'] ?? DATABASE_URL;

if (!DATABASE_URL) {
  console.error('DATABASE_URL required');
  process.exit(1);
}

const dataPool = new Pool({ connectionString: DATABASE_URL, max: 5 });
const controlPool = new Pool({ connectionString: PSR_CONTROL_URL, max: 3 });
const registry = pgRegistry(controlPool);
const provisioner = new TenantProvisioner(dataPool, registry);

async function main(): Promise<void> {
  console.log('Provisioning demo tenant...');
  const { tenant } = await provisioner.provision({
    slug: 'demo',
    strategy: 'replay',
    source: './prisma/migrations',
    onReady: async (id) => {
      console.log(`Tenant ${id} is ready — seeding demo data`);
    },
  });

  console.log(`\nTenant provisioned:`);
  console.log(`  id:     ${tenant.id}`);
  console.log(`  slug:   ${tenant.slug}`);
  console.log(`  schema: ${tenant.schemaName}`);
  console.log(`  status: ${tenant.status}`);
  console.log(`\nUse this id in X-Tenant-Id header: ${tenant.id}`);

  await dataPool.end();
  await controlPool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
