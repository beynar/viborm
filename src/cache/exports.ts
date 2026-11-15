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

// Named so the declaration of an exported client with the cache can write
// its `cache` argument (the options, and the operations it is placed on).
export type { MutationOperations } from "../client/exports";
// Cache driver base
export {
  CacheDriver,
  type CacheEntry,
  type CacheSetOptions,
  type WaitUntilFn,
} from "./driver";
export {
  type CacheExtensionConfig,
  type CacheMethods,
  cache,
} from "./extension";
export { staleWhileRevalidate } from "./revalidate";
export type { CacheInvalidationOptions, WithCacheOptions } from "./schema";
export {
  clearEntries,
  clearRevalidating,
  deleteEntry,
  getEntry,
  invalidateEntries,
  markRevalidating,
  setEntry,
} from "./storage";
