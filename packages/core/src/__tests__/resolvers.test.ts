import { describe, it, expect } from 'vitest';
import { fromSubdomain, fromHeader, fromJwtClaim } from '../resolvers.js';
import type { IncomingMessage } from 'node:http';

function mockReq(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe('fromSubdomain', () => {
  it('extracts the first label', () => {
    expect(fromSubdomain('acme.app.example.com')).toBe('acme');
  });

  it('returns null for bare domain', () => {
    expect(fromSubdomain('example.com')).toBeNull();
  });

  it('strips port before parsing', () => {
    expect(fromSubdomain('acme.example.com:3000')).toBe('acme');
  });
});

describe('fromHeader', () => {
  it('returns header value', () => {
    const resolver = fromHeader('x-tenant-id');
    const val = resolver(mockReq({ 'x-tenant-id': 'acme' }));
    expect(val).toBe('acme');
  });

  it('returns null when header is absent', () => {
    const resolver = fromHeader('x-tenant-id');
    expect(resolver(mockReq({}))).toBeNull();
  });
});

describe('fromJwtClaim', () => {
  it('extracts a claim from a Bearer token', () => {
    const payload = Buffer.from(JSON.stringify({ tenant_id: 'acme-corp' })).toString('base64url');
    const token = `header.${payload}.sig`;
    const resolver = fromJwtClaim('tenant_id');
    const req = mockReq({ authorization: `Bearer ${token}` });
    expect(resolver(req)).toBe('acme-corp');
  });

  it('returns null for missing authorization header', () => {
    const resolver = fromJwtClaim();
    expect(resolver(mockReq({}))).toBeNull();
  });

  it('returns null for non-Bearer scheme', () => {
    const resolver = fromJwtClaim();
    expect(resolver(mockReq({ authorization: 'Basic abc' }))).toBeNull();
  });
});
