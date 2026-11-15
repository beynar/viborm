import { CacheConfigurationError } from "@errors";
import { parse } from "@validation";
import v, { type V } from "@validation/primitives/v";
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

const cacheInvalidationSchema = v.object(
  {
    /**
     * Specific keys to clear from cache
     * Can end with a * to invalidate all keys starting with the given prefix
     */
    invalidate: v.string({ array: true, optional: true }),
    /**
     * Automatically invalidate all entries in the bound cache scope after a durable mutation
     * @default true
     */
    autoInvalidate: v.boolean({ optional: true, default: true }),
  },
  { optional: true, default: { autoInvalidate: true } }
);

/**
 * Input type for cache invalidation options (inferred from schema)
 */
export type CacheInvalidationOptions =
  CacheInvalidationSchema[" vibInferred"]["0"];

/** Whether normalized mutation options request any invalidation work. */
export function hasCacheInvalidationWork(
  options: CacheInvalidationOptions | undefined
): boolean {
  return (
    options === undefined ||
    options.autoInvalidate === true ||
    (options.invalidate !== undefined && options.invalidate.length > 0)
  );
}

// =============================================================================
// WITH CACHE OPTIONS SCHEMA (for $withCache method)
// =============================================================================

/**
 * Default TTL: 5 minutes (in milliseconds)
 */
const DEFAULT_CACHE_TTL = 5 * 60 * 1000;

export type WithCacheSchemaEntries = {
  ttl: V.Optional<V.Union<[V.String, V.Number]>>;
  swr: V.Optional<V.Union<[V.Boolean, V.String, V.Number]>>;
  key: V.String<{ optional: true }>;
  bypass: V.Boolean<{ optional: true }>;
};

export type WithCacheSchema = V.Object<
  WithCacheSchemaEntries,
  { optional: true }
>;

const withCacheSchema = v.object(
  {
    /**
     * Time to live for cache entries
     * Can be a number (milliseconds) or a string like "1 hour", "20 seconds"
     * @default 300000 (5 minutes)
     */
    ttl: v.coerce(
      v.optional(v.union([v.string(), v.number()]), DEFAULT_CACHE_TTL),
      parseTTL
    ),
    /**
     * Enable stale-while-revalidate pattern
     * When true, returns stale data immediately and revalidates in background
     *
     * The value represents the "stale window" - how long data can be served stale.
     * Storage TTL is automatically calculated as `ttl + staleWindow`.
     *
     * Can be a boolean or a duration value (number in ms or string like "1 hour")
     * - true: stale window = ttl (storage TTL = 2x ttl)
     * - false/undefined: SWR disabled
     * - number/string: custom stale window duration (storage TTL = ttl + swr)
     * @default false
     */
    swr: v.coerce(
      v.optional(v.union([v.boolean(), v.string(), v.number()])),
      (value: boolean | string | number | undefined) =>
        value === undefined || typeof value === "boolean"
          ? value
          : parseTTL(value)
    ),
    /**
     * The official cache extension retains the canonical model/operation/args
     * key and appends this value as a suffix contribution.
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

// =============================================================================
// THE CACHE'S TWO ARGUMENTS, AND THE READS IT SERVES
// =============================================================================

/**
 * The reads a cached view serves, as its refusal of anything else lists
 * them.
 */
export const CACHEABLE: readonly string[] = Object.freeze([
  "findFirst",
  "findMany",
  "findUnique",
  "findUniqueOrThrow",
  "findFirstOrThrow",
  "count",
  "aggregate",
  "groupBy",
  "exist",
]);

/** One read's options, as the cache applies them. */
export interface CacheReadOptions {
  readonly ttlMs: number;
  readonly swr: number | false;
  readonly bypass: boolean;
  readonly key?: string;
}

function refused(what: string, issues: readonly { message: string }[]): never {
  throw new CacheConfigurationError(
    `Invalid ${what}: ${issues.map((issue) => issue.message).join(", ")}`
  );
}

/**
 * A write's `cache` argument: what it invalidates once durable. Frozen, as
 * the argument a call admitted and nothing else holds.
 */
export function admitMutationOptions(value: unknown): CacheInvalidationOptions {
  const parsed = parse(cacheInvalidationSchema, value);
  if (parsed.issues) refused("mutation cache options", parsed.issues);
  const { autoInvalidate, invalidate } = parsed.value;
  if (invalidate === undefined) return Object.freeze({ autoInvalidate });
  const keys = [...invalidate];
  Object.freeze(keys);
  return Object.freeze({ autoInvalidate, invalidate: keys });
}

/** `$withCache(options)`: the options of every read through the view. */
export function admitReadOptions(value: unknown): CacheReadOptions {
  const parsed = parse(withCacheSchema, value);
  if (parsed.issues) refused("cache options", parsed.issues);
  const { bypass, key, ttl, swr } = parsed.value;
  return Object.freeze({
    ttlMs: ttl,
    // The SWR window: the stale window added to the TTL, `true` the TTL again.
    swr:
      swr === undefined || swr === false
        ? false
        : ttl + (swr === true ? ttl : swr),
    bypass,
    ...(key === undefined ? {} : { key }),
  });
}
