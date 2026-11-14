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
export { type CacheExtensionConfig, cache } from "./extension";
export type { CacheInvalidationOptions, WithCacheOptions } from "./schema";
