/**
 * Cache Exports
 *
 * Cache driver base and utilities.
 * Import from "viborm/cache"
 *
 * For specific cache drivers:
 * - Memory: "viborm/cache/memory"
 * - Cloudflare KV: "viborm/cache/cloudflare-kv"
 */

// Cache driver base
export {
  CacheDriver,
  type AnyCacheDriver,
  type CacheEntry,
  type CacheExecutionOptions,
  type CacheSetOptions,
} from "./driver";

// Cache utilities
export { CACHE_PREFIX, generateCacheKey, generateCachePrefix } from "./key";
export { parseTTL } from "./ttl";

// Cache schemas
export type {
  CacheInvalidationOptions,
  CacheInvalidationSchema,
  WithCacheOptions,
  WithCacheSchema,
} from "./schema";
export {
  cacheInvalidationSchema,
  DEFAULT_CACHE_TTL,
  withCacheSchema,
} from "./schema";
