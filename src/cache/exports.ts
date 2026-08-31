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
  type CacheEntry,
  type CacheSetOptions,
  type WaitUntilFn,
} from "./driver";
export { type CacheExtensionConfig, cache } from "./extension";
export type {
  CacheInvalidationOptions,
  WithCacheOptions,
} from "./schema";
