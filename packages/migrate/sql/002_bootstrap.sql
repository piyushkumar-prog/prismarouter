-- Optional: create roles for DDL (migrations) and runtime (DML only).
-- Adjust role names to match your environment.

-- Migration role (DDL access to all tenant schemas)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'psr_migrator') THEN
    CREATE ROLE psr_migrator NOLOGIN;
  END IF;
END
$$;

-- Runtime role (SELECT, INSERT, UPDATE, DELETE — no CREATE, no DROP)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'psr_runtime') THEN
    CREATE ROLE psr_runtime NOLOGIN;
  END IF;
END
$$;

-- Grant runtime role on the control tables
GRANT SELECT, INSERT, UPDATE ON psr_tenants          TO psr_runtime;
GRANT SELECT, INSERT, UPDATE ON psr_migration_runs   TO psr_runtime;
GRANT SELECT, INSERT, UPDATE ON psr_tenant_migrations TO psr_runtime;

-- Grant migrator role ALL on the control tables
GRANT ALL ON psr_tenants           TO psr_migrator;
GRANT ALL ON psr_migration_runs    TO psr_migrator;
GRANT ALL ON psr_tenant_migrations TO psr_migrator;

COMMENT ON SCHEMA psr_guard IS
  'Empty guard schema. search_path defaults here so unqualified SQL fails safely.';
