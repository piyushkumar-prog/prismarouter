import type { IncomingMessage } from 'node:http';

/**
 * A resolver takes a request and returns a tenant id string,
 * or null/undefined if it cannot resolve.
 */
export type TenantResolver<TRequest = IncomingMessage> = (
  req: TRequest,
) => string | null | undefined | Promise<string | null | undefined>;

/**
 * Resolve the tenant id from a subdomain.
 * e.g. acme.app.example.com  →  'acme'
 *
 * @param hostHeader  The value of the Host header.
 * @param depth       How many labels from the left to use (default 1).
 */
export function fromSubdomain(hostHeader: string, depth = 1): string | null {
  const host = hostHeader.split(':')[0] ?? ''; // strip port
  const parts = host.split('.');
  // Need at least (depth subdomain labels) + (domain) + (TLD) = depth + 2 parts
  if (parts.length <= depth + 1) return null;
  return parts.slice(0, depth).join('.') || null;
}

/**
 * Resolve the tenant id from a request header.
 *
 * @param headerName  Header name (case-insensitive), e.g. 'x-tenant-id'.
 */
export function fromHeader(headerName: string): TenantResolver {
  const lower = headerName.toLowerCase();
  return (req) => {
    const val = (req as IncomingMessage).headers[lower];
    if (!val) return null;
    return Array.isArray(val) ? (val[0] ?? null) : val;
  };
}

/**
 * Resolve the tenant id from a JWT claim in the Authorization header.
 * NOTE: This does NOT verify the token signature — use only when the JWT has
 * already been verified by upstream middleware. Pass a verified-payload extractor
 * if you need full verification.
 *
 * @param claimName  The JWT payload claim to use as tenant id (default 'tenant_id').
 */
export function fromJwtClaim(claimName = 'tenant_id'): TenantResolver {
  return (req) => {
    const auth = (req as IncomingMessage).headers['authorization'];
    if (!auth?.startsWith('Bearer ')) return null;
    const token = auth.slice(7);
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    try {
      const payload = JSON.parse(
        Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'),
      ) as Record<string, unknown>;
      const val = payload[claimName];
      return typeof val === 'string' ? val : null;
    } catch {
      return null;
    }
  };
}
