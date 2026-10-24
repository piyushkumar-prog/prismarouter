export class TenantBusyError extends Error {
  readonly code = 'TENANT_BUSY' as const;

  constructor(
    public readonly tenantId: string,
    public readonly queueDepth: number,
    public readonly timeoutMs: number,
  ) {
    super(
      `Tenant ${tenantId} governor queue timed out after ${timeoutMs}ms (queue depth: ${queueDepth})`,
    );
    this.name = 'TenantBusyError';
    Object.setPrototypeOf(this, TenantBusyError.prototype);
  }
}
