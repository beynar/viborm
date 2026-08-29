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

export type { WaitUntilFn } from "./cache-contract";
// Cache driver base
export {
  CacheDriver,
  type CacheEntry,
  type CacheSetOptions,
} from "./driver";
export { type CacheExtensionConfig, cache } from "./extension";
export type {
  CacheInvalidationOptions,
  WithCacheOptions,
} from "./schema";
