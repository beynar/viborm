import v, { type V } from "@validation";
import { parseTTL } from "./ttl";

// =============================================================================
// CACHE INVALIDATION SCHEMA (for mutations)
// =============================================================================

export type CacheInvalidationSchemaEntries = {
  invalidate: V.String<{ array: true; optional: true }>;
  autoInvalidate: V.Boolean<{ optional: true }>;
};

export type CacheInvalidationSchema = V.Object<
  CacheInvalidationSchemaEntries,
  { optional: true }
>;

export const cacheInvalidationSchema = v.object(
  {
    /**
     * Specific keys to clear from cache
     * Can end with a * to invalidate all keys starting with the given prefix
     */
    invalidate: v.string({ array: true, optional: true }),
    /**
     * Automatically invalidate all cache entries for this model after mutation
     * @default false
     */
    autoInvalidate: v.boolean({ optional: true, default:false }),
  },
  { optional: true, default: { autoInvalidate: false } }
);

/**
 * Input type for cache invalidation options (inferred from schema)
 */
export type CacheInvalidationOptions =
  CacheInvalidationSchema[" vibInferred"]["0"];

// =============================================================================
// WITH CACHE OPTIONS SCHEMA (for $withCache method)
// =============================================================================

/**
 * Default TTL: 5 minutes (in milliseconds)
 */
export const DEFAULT_CACHE_TTL = 5 * 60 * 1000;

export type WithCacheSchemaEntries = {
  ttl: V.Optional<V.Union<[V.String, V.Number]>>;
  swr: V.Boolean<{ optional: true }>;
  key: V.String<{ optional: true }>;
  bypass: V.Boolean<{ optional: true }>;
};

export type WithCacheSchema = V.Object<
  WithCacheSchemaEntries,
  { optional: true }
>;

export const withCacheSchema = v.object(
  {
    /**
     * Time to live for cache entries
     * Can be a number (milliseconds) or a string like "1 hour", "20 seconds"
     * @default 300000 (5 minutes)
     */
    ttl: v.coerce(v.optional(v.union([v.string(), v.number()]), DEFAULT_CACHE_TTL), (value: string | number) => {
      return parseTTL(value);
    }),
    /**
     * Enable stale-while-revalidate pattern
     * When true, returns stale data immediately and revalidates in background
     * @default false
     */
    swr: v.boolean({ optional: true }),
    /**
     * Custom cache key override
     * If not provided, key is generated from model, operation, and args
     */
    key: v.string({ optional: true }),
    /**
     * Bypass cache read and force fresh data
     * Still writes result to cache for subsequent requests
     * @default false
     */
    bypass: v.boolean({ optional: true }),
  },
  {
    optional: true,
    default: {
      ttl: DEFAULT_CACHE_TTL,
      swr: false,
      bypass: false,
    },
  }
);

/**
 * Input type for $withCache options (inferred from schema)
 */
export type WithCacheOptions = WithCacheSchema[" vibInferred"]["0"];

type T = WithCacheSchema[" vibInferred"]["0"]
