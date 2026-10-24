/**
 * Thrown when router.db() is called outside of a router.run() context.
 */
export class TenantContextError extends Error {
  readonly code = 'TENANT_CONTEXT_MISSING' as const;

  constructor(message = 'No tenant context active. Call router.run(tenantId, fn) first.') {
    super(message);
    this.name = 'TenantContextError';
    Object.setPrototypeOf(this, TenantContextError.prototype);
  }
}

/**
 * Thrown when a tenant's status disallows access (suspended, archived, mid-migration).
 */
export class TenantStatusError extends Error {
  readonly code = 'TENANT_STATUS_BLOCKED' as const;

  constructor(
    public readonly tenantId: string,
    public readonly status: string,
    message?: string,
  ) {
    super(message ?? `Tenant ${tenantId} is not accessible (status: ${status})`);
    this.name = 'TenantStatusError';
    Object.setPrototypeOf(this, TenantStatusError.prototype);
  }
}

/**
 * Thrown when a tenant's schema version is below the application minimum.
 */
export class TenantVersionError extends Error {
  readonly code = 'TENANT_VERSION_TOO_LOW' as const;

  constructor(
    public readonly tenantId: string,
    public readonly tenantVersion: string | null,
    public readonly minVersion: string,
  ) {
    super(
      `Tenant ${tenantId} schema version (${
        tenantVersion ?? 'none'
      }) is below minimum ${minVersion}`,
    );
    this.name = 'TenantVersionError';
    Object.setPrototypeOf(this, TenantVersionError.prototype);
  }
}

/**
 * Thrown when a schema name fails validation.
 */
export class InvalidSchemaNameError extends Error {
  readonly code = 'INVALID_SCHEMA_NAME' as const;

  constructor(name: string) {
    super(`Invalid schema name: "${name}". Must match ^t_[a-z0-9_]{3,40}$`);
    this.name = 'InvalidSchemaNameError';
    Object.setPrototypeOf(this, InvalidSchemaNameError.prototype);
  }
}

/**
 * Thrown when no registry record exists for a tenant id.
 */
export class TenantNotFoundError extends Error {
  readonly code = 'TENANT_NOT_FOUND' as const;

  constructor(public readonly tenantId: string) {
    super(`Tenant not found: ${tenantId}`);
    this.name = 'TenantNotFoundError';
    Object.setPrototypeOf(this, TenantNotFoundError.prototype);
  }
}
