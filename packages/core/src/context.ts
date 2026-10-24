import { AsyncLocalStorage } from 'node:async_hooks';
import { TenantContextError } from './errors.js';
import type { TenantRecord } from './registry.js';

export interface TenantContext {
  /** The resolved tenant record from the registry. */
  tenant: TenantRecord;
}

const storage = new AsyncLocalStorage<TenantContext>();

/**
 * Run a function within a tenant context.
 * The context is stored in AsyncLocalStorage and propagates through async calls.
 */
export function runWithContext<T>(ctx: TenantContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/**
 * Retrieve the current tenant context.
 * Throws TenantContextError if called outside of runWithContext.
 */
export function getContext(): TenantContext {
  const ctx = storage.getStore();
  if (!ctx) {
    throw new TenantContextError();
  }
  return ctx;
}

/**
 * Returns the current context or null — does not throw.
 * Useful for middleware that wants to check without asserting.
 */
export function tryGetContext(): TenantContext | null {
  return storage.getStore() ?? null;
}
