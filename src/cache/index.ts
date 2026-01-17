/**
 * Cache Module Exports
 */

export { createCachedClientProxy, type OperationSpanWrapper } from "./client";
export {
  type AnyCacheDriver,
  CacheDriver,
  type CacheEntry,
  type CacheSetOptions,
} from "./driver";
export { CloudflareKVCache } from "./drivers/cloudflare-kv";
export { MemoryCache } from "./drivers/memory";
export { CACHE_PREFIX, generateCacheKey, generateCachePrefix } from "./key";
export {
  type CacheInvalidationOptions,
  type CacheInvalidationSchema,
  cacheInvalidationSchema,
  DEFAULT_CACHE_TTL,
  type WithCacheSchema,
  withCacheSchema,
} from "./schema";
export { parseTTL } from "./ttl";
export type {
  ParsedCacheOptions,
  WaitUntilFn,
  WithCacheOptions,
} from "./types";
