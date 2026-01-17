/**
 * Cache Key Generation
 *
 * Generates deterministic cache keys from operation parameters.
 */

import { CacheInvalidKeyError } from "@errors";

/**
 * Prefix for all VibORM cache keys
 */
export const CACHE_PREFIX = "viborm";

/**
 * Build the versioned prefix
 */
function buildPrefix(version?: string | number): string {
  return version !== undefined ? `${CACHE_PREFIX}:v${version}` : CACHE_PREFIX;
}

/**
 * Generate a deterministic cache key from operation parameters
 *
 * Key structure: viborm[:v<version>]:<model>:<operation>:<hash>
 *
 * @example
 * generateCacheKey("user", "findMany", { where: { active: true } })
 * // "viborm:user:findMany:abc123..."
 *
 * generateCacheKey("user", "findMany", { where: { active: true } }, 2)
 * // "viborm:v2:user:findMany:abc123..."
 */
export function generateCacheKey(
  modelName: string,
  operation: string,
  args: unknown,
  version?: string | number
): string {
  const prefix = buildPrefix(version);
  const argsHash = hashArgs(args);
  return `${prefix}:${modelName}:${operation}:${argsHash}`;
}

/**
 * Generate prefix for cache invalidation
 * Used to clear all cached queries for a model
 */
export function generateCachePrefix(
  modelName?: string,
  version?: string | number
): string {
  const prefix = buildPrefix(version);
  return modelName ? `${prefix}:${modelName}` : prefix;
}

/**
 * Generate a deterministic hash from query arguments
 */
function hashArgs(args: unknown): string {
  const serialized = stableStringify(args);
  return fastHash(serialized);
}

/**
 * Stable JSON stringify that handles:
 * - Sorted object keys (deterministic)
 * - Date objects (ISO string)
 * - BigInt (string with 'n' suffix)
 * - Uint8Array (base64)
 * - undefined values (omitted)
 * - Circular references (throws)
 */
function stableStringify(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null) return "null";
  if (value === undefined) return "";

  const type = typeof value;

  if (type === "boolean" || type === "number") {
    return String(value);
  }

  if (type === "string") {
    return JSON.stringify(value);
  }

  if (type === "bigint") {
    return `"${value}n"`;
  }

  if (value instanceof Date) {
    return `"${value.toISOString()}"`;
  }

  if (value instanceof Uint8Array) {
    return `"base64:${btoa(String.fromCharCode(...value))}"`;
  }

  if (Array.isArray(value)) {
    if (seen.has(value))
      throw new CacheInvalidKeyError("Circular reference in cache key args");
    seen.add(value);
    return `[${value.map((v) => stableStringify(v, seen)).join(",")}]`;
  }

  if (type === "object") {
    if (seen.has(value as object))
      throw new CacheInvalidKeyError("Circular reference in cache key args");
    seen.add(value as object);

    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const pairs = keys
      .filter((k) => obj[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k], seen)}`);
    return `{${pairs.join(",")}}`;
  }

  // Functions and symbols are not cacheable
  throw new CacheInvalidKeyError(`Uncacheable value type: ${type}`);
}

/**
 * Fast non-cryptographic hash (djb2 variant)
 * Produces a 16-character hex string
 */
function fastHash(str: string): string {
  let h1 = 0xde_ad_be_ef;
  let h2 = 0x41_c6_ce_57;

  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2_654_435_761);
    h2 = Math.imul(h2 ^ ch, 1_597_334_677);
  }

  h1 = Math.imul(h1 ^ (h1 >>> 16), 2_246_822_507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3_266_489_909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2_246_822_507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3_266_489_909);

  return (
    (h2 >>> 0).toString(16).padStart(8, "0") +
    (h1 >>> 0).toString(16).padStart(8, "0")
  );
}
