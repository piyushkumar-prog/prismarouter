-- Control-plane schema for prisma-schema-router
-- Run this once against your control database (PSR_CONTROL_URL).

-- Tenant registry
CREATE TABLE IF NOT EXISTS psr_tenants (
  id            UUID        PRIMARY KEY,
  slug          TEXT        UNIQUE NOT NULL,
  schema_name   TEXT        UNIQUE NOT NULL
                CHECK (schema_name ~ '^t_[a-z0-9_]{3,40}$'),
  status        TEXT        NOT NULL
                CHECK (status IN (
                  'provisioning', 'ready', 'migrating',
                  'suspended',    'archived', 'deleted'
                )),
  schema_version TEXT,                        -- last applied migration version
  placement     TEXT        NOT NULL DEFAULT 'shared'
                CHECK (placement IN ('shared', 'dedicated')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS psr_tenants_status_idx
  ON psr_tenants (status);

CREATE INDEX IF NOT EXISTS psr_tenants_slug_idx
  ON psr_tenants (slug);

-- Migration runs (one row per fleet-wide migration run)
CREATE TABLE IF NOT EXISTS psr_migration_runs (
  id             UUID        PRIMARY KEY,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  target_version TEXT        NOT NULL,
  status         TEXT        NOT NULL
                 CHECK (status IN ('running', 'stopped', 'completed'))
);

CREATE INDEX IF NOT EXISTS psr_migration_runs_status_idx
  ON psr_migration_runs (status, started_at DESC);

-- Per-tenant migration state within a run
CREATE TABLE IF NOT EXISTS psr_tenant_migrations (
  run_id     UUID        NOT NULL REFERENCES psr_migration_runs(id) ON DELETE CASCADE,
  tenant_id  UUID        NOT NULL REFERENCES psr_tenants(id)        ON DELETE CASCADE,
  state      TEXT        NOT NULL
             CHECK (state IN ('pending', 'running', 'applied', 'failed')),
  error      TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, tenant_id)
);

CREATE INDEX IF NOT EXISTS psr_tenant_migrations_state_idx
  ON psr_tenant_migrations (run_id, state);

-- Guard schema: an empty schema so that unqualified SQL hits "table not found"
-- instead of accidentally reading from public.
CREATE SCHEMA IF NOT EXISTS psr_guard;
