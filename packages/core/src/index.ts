// Core router
export { createTenantRouter, sql, signJobTenant } from './router.js';
export type {
  TenantRouter,
  CreateTenantRouterOptions,
  RouterCacheOptions,
  RouterGuardOptions,
  RouterGovernorOptions,
  RouterMiddleware,
  JobEnvelope,
  MiddlewareOptions,
  MiddlewareTenantResolver,
} from './router.js';

// Context
export { runWithContext, getContext, tryGetContext } from './context.js';
export type { TenantContext } from './context.js';

// Registry
export { pgRegistry, PgTenantRegistry, MemoryTenantRegistry } from './registry.js';
export type { TenantRegistry, TenantRecord, TenantStatus, TenantPlacement } from './registry.js';

// Guard
export { installConnectionGuard, runRawInTenantSchema } from './guard.js';
export type { GuardMode } from './guard.js';

// Schema naming
export { validateSchemaName, generateSchemaName, quoteIdentifier } from './schema-name.js';

// Resolvers
export { fromSubdomain, fromHeader, fromJwtClaim } from './resolvers.js';
export type { TenantResolver } from './resolvers.js';

// LRU Cache (exported for @psr/testing and @psr/governor)
export { LRUCache } from './lru-cache.js';
export type { LRUCacheOptions } from './lru-cache.js';

// Errors
export {
  TenantContextError,
  TenantStatusError,
  TenantVersionError,
  InvalidSchemaNameError,
  TenantNotFoundError,
} from './errors.js';
