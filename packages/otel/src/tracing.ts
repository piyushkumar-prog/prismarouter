/**
 * Tracing utilities for prisma-schema-router.
 * Adds tenant context as an OTel span attribute.
 * Uses dynamic import() so @opentelemetry/api is truly optional.
 */

export interface SpanContext {
  tenantId: string;
  schemaName?: string;
}

/**
 * Adds tenant attributes to the active span (if OTel is installed).
 * This function is async because it must dynamically import the OTel API.
 * Hash the tenant id for PII compliance when hashTenantId=true.
 */
export async function setTenantSpanAttributes(
  ctx: SpanContext,
  opts: { hashTenantId?: boolean } = {},
): Promise<void> {
  try {
    const api = await import('@opentelemetry/api');
    const span = api.trace.getActiveSpan();
    if (!span) return;

    const tenantId = opts.hashTenantId ? hashId(ctx.tenantId) : ctx.tenantId;
    span.setAttribute('psr.tenant.id', tenantId);
    if (ctx.schemaName) {
      span.setAttribute('psr.tenant.schema', ctx.schemaName);
    }
  } catch {
    // OTel not installed — silently ignore
  }
}

/**
 * Wrap an async function in an OTel span with tenant attributes.
 * If @opentelemetry/api is not installed, the function runs unwrapped.
 */
export async function withTenantSpan<T>(
  name: string,
  ctx: SpanContext,
  fn: () => Promise<T>,
  opts: { hashTenantId?: boolean } = {},
): Promise<T> {
  let api: typeof import('@opentelemetry/api') | null = null;
  try {
    api = await import('@opentelemetry/api');
  } catch {
    // OTel not installed — run fn directly
    return fn();
  }

  const tracer = api.trace.getTracer('@psr/otel', '0.1.0');

  return tracer.startActiveSpan(name, async (span) => {
    const tenantId = opts.hashTenantId ? hashId(ctx.tenantId) : ctx.tenantId;
    span.setAttribute('psr.tenant.id', tenantId);
    if (ctx.schemaName) span.setAttribute('psr.tenant.schema', ctx.schemaName);

    try {
      const result = await fn();
      span.setStatus({ code: api!.SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.setStatus({
        code: api!.SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      span.end();
    }
  });
}

function hashId(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (Math.imul(31, h) + id.charCodeAt(i)) | 0;
  }
  return `t_${(h >>> 0).toString(16)}`;
}
