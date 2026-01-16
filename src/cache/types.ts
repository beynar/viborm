/**
 * Cache Types
 *
 * Type definitions for the caching system.
 */

// Re-export schema-derived types
export type { CacheInvalidationOptions } from "./schema";

/**
 * Callback to extend the lifetime of the request until the promise resolves.
 * Used in serverless environments (Cloudflare Workers, Vercel Edge) to keep
 * the runtime alive for background operations like SWR revalidation.
 */
export type WaitUntilFn = (promise: Promise<unknown>) => void;

/**
 * Options for $withCache method
 */
export interface WithCacheOptions {
  /**
   * Time to live for cache entries
   * Can be a number (milliseconds) or a string like "1 hour", "20 seconds"
   * @default 300000 (5 minutes)
   */
  ttl?: string | number;

  /**
   * Enable stale-while-revalidate pattern
   * When true, returns stale data immediately and revalidates in background
   * @default false
   */
  swr?: boolean;

  /**
   * Custom cache key override
   * If not provided, key is generated from model, operation, and args
   */
  key?: string;
}

/**
 * Internal cache options after parsing
 */
export interface ParsedCacheOptions {
  ttlMs: number;
  swr: boolean;
  key?: string;
  waitUntil?: WaitUntilFn;
}
