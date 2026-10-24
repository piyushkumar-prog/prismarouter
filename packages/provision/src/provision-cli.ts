import { Pool } from 'pg';
import { pgRegistry } from '@piyushkumar_dev/core';
import { TenantProvisioner } from './provisioner.js';
import type { ProvisionStrategy } from './provisioner.js';

function getPool(): Pool {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('DATABASE_URL required');
    process.exit(1);
  }
  return new Pool({ connectionString: url });
}

function getControlPool(): Pool {
  const url = process.env['PSR_CONTROL_URL'] ?? process.env['DATABASE_URL'];
  if (!url) {
    console.error('PSR_CONTROL_URL or DATABASE_URL required');
    process.exit(1);
  }
  return new Pool({ connectionString: url });
}

export async function runProvisionCli(args: string[]): Promise<void> {
  const [sub, slug, ...rest] = args;
  const pool = getPool();
  const controlPool = getControlPool();
  const registry = pgRegistry(controlPool);
  const provisioner = new TenantProvisioner(pool, registry);

  const opts: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    opts[rest[i]?.replace(/^--/, '') ?? ''] = rest[i + 1] ?? '';
  }

  switch (sub) {
    case 'provision': {
      if (!slug) {
        console.error('Usage: psr tenants provision <slug> [--strategy replay]');
        process.exit(1);
      }
      console.log(`Provisioning tenant: ${slug}`);
      const provisionOpts: import('./provisioner.js').ProvisionOptions = {
        slug,
        strategy: (opts['strategy'] as ProvisionStrategy) ?? 'replay',
      };
      if (opts['source']) provisionOpts.source = opts['source'];
      const result = await provisioner.provision(provisionOpts);
      console.log(`Done. Tenant id: ${result.tenant.id}, schema: ${result.tenant.schemaName}`);
      break;
    }
    case 'suspend': {
      if (!slug) {
        console.error('Usage: psr tenants suspend <tenantId>');
        process.exit(1);
      }
      await provisioner.suspend(slug);
      console.log(`Tenant ${slug} suspended.`);
      break;
    }
    case 'restore': {
      if (!slug) {
        console.error('Usage: psr tenants restore <tenantId>');
        process.exit(1);
      }
      await provisioner.restore(slug);
      console.log(`Tenant ${slug} restored.`);
      break;
    }
    case 'archive': {
      if (!slug) {
        console.error('Usage: psr tenants archive <tenantId>');
        process.exit(1);
      }
      await provisioner.archive(slug);
      console.log(`Tenant ${slug} archived.`);
      break;
    }
    case 'delete': {
      if (!slug) {
        console.error('Usage: psr tenants delete <tenantId> --confirm <tenantId>');
        process.exit(1);
      }
      await provisioner.deleteTenant(slug, opts['confirm'] ?? '');
      console.log(`Tenant ${slug} deleted.`);
      break;
    }
    default:
      console.error(`Unknown tenants subcommand: ${sub ?? ''}`);
      console.error('Usage: psr tenants <provision|suspend|restore|archive|delete>');
      process.exit(1);
  }

  await pool.end();
  await controlPool.end();
}
