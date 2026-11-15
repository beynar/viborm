/**
 * The unscoped storage of a cache driver, outside the official cache: what a
 * backend's own test or an application reads and writes under the bare
 * `viborm` root. Functions of the driver rather than its methods, so an
 * application that never calls them carries none of them; none of them
 * reaches the official namespace, which only an applied cache extension
 * writes.
 */
import { CacheInvalidKeyError } from "@errors";
import { marker } from "./cache-background";
import {
  BACKEND,
  type CacheDriver,
  type CacheEntry,
  type CacheSetOptions,
  CLEAR,
  DELETE,
  GET,
  INVALIDATE,
  SET,
} from "./driver";
import { CACHE_PREFIX, OFFICIAL_CACHE_NAMESPACE_ROOT } from "./key";
import type { CacheInvalidationOptions } from "./schema";

/**
 * A public storage key under the bare `viborm` root (a key that already
 * begins with `viborm:` is taken as it is), refused inside the official
 * namespace. There is only one such root, so no sibling exists for a clear
 * to cross into.
 */
function unscoped(key: string): string {
  const prefixedKey = key.startsWith(`${CACHE_PREFIX}:`)
    ? key
    : key
      ? `${CACHE_PREFIX}:${key}`
      : CACHE_PREFIX;
  if (
    prefixedKey === OFFICIAL_CACHE_NAMESPACE_ROOT ||
    prefixedKey.startsWith(`${OFFICIAL_CACHE_NAMESPACE_ROOT}:`)
  ) {
    throw new CacheInvalidKeyError(
      "The official cache namespace requires an authenticated cache extension."
    );
  }
  return prefixedKey;
}

/** The entry stored under `key`, or `null`. */
export async function getEntry<T>(
  driver: CacheDriver,
  key: string,
  origin?: object
): Promise<CacheEntry<T> | null> {
  return driver[GET]<T>(unscoped(key), origin);
}

/** Store `value` under `key` for `options.ttl` milliseconds. */
export async function setEntry<T>(
  driver: CacheDriver,
  key: string,
  value: T,
  options: CacheSetOptions,
  origin?: object
): Promise<void> {
  return driver[SET](unscoped(key), value, options, origin);
}

/** Delete the entry under `key` and its revalidation marker. */
export async function deleteEntry(
  driver: CacheDriver,
  key: string,
  origin?: object
): Promise<void> {
  return driver[DELETE](unscoped(key), origin);
}

/** Clear every entry under `prefix`; every unscoped entry without one. */
export async function clearEntries(
  driver: CacheDriver,
  prefix?: string,
  origin?: object
): Promise<void> {
  return driver[CLEAR](unscoped(prefix ?? ""), origin);
}

/**
 * Invalidate `model`'s entries (`autoInvalidate`, the default) and the keys
 * or `*` prefixes `options.invalidate` names, validated whole first.
 */
export async function invalidateEntries(
  driver: CacheDriver,
  model: string,
  options?: CacheInvalidationOptions,
  origin?: object
): Promise<void> {
  return driver[INVALIDATE](`${model}:`, options, origin, unscoped);
}

/** Claim the refresh of `key`: whether this caller performs it. */
export async function markRevalidating(
  driver: CacheDriver,
  key: string
): Promise<boolean> {
  return marker(driver[BACKEND](), unscoped(key), true);
}

/** Release the claim on the refresh of `key`. */
export async function clearRevalidating(
  driver: CacheDriver,
  key: string
): Promise<void> {
  await marker(driver[BACKEND](), unscoped(key), false);
}
