/**
 * TTL Parser
 *
 * Converts human-readable TTL strings to milliseconds.
 */

import { CacheInvalidTTLError } from "@errors";

/** `<number> <unit>`, each unit's spellings one group, in the order of `UNIT_MS`. */
const TTL_PATTERN =
  /^(\d+(?:\.\d+)?)\s*(?:(ms|milliseconds?)|(s|sec|seconds?)|(m|min|minutes?)|(h|hr|hours?)|(d|days?)|(w|weeks?)|(months?))$/;

/** Milliseconds per unit, a month being thirty days. */
const UNIT_MS = [1, 1e3, 6e4, 36e5, 864e5, 6048e5, 2592e6];

export function parseTTL(ttl: string | number): number {
  if (typeof ttl === "number") {
    if (!Number.isFinite(ttl) || ttl <= 0 || ttl > Number.MAX_SAFE_INTEGER) {
      throw new CacheInvalidTTLError(`TTL must be positive, got: ${ttl}`);
    }
    return ttl;
  }

  const match = TTL_PATTERN.exec(ttl.trim().toLowerCase());

  if (!match) {
    throw new CacheInvalidTTLError(
      `Invalid TTL format: "${ttl}". Expected format: "<number> <unit>" (e.g., "1 hour", "20 seconds"), the unit one of ms, s, sec, m, min, h, hr, d, w, month, or a word for it.`
    );
  }

  const result = Math.floor(
    Number.parseFloat(match[1]!) *
      UNIT_MS[match.slice(2).findIndex((unit) => unit !== undefined)]!
  );

  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new CacheInvalidTTLError(
      `TTL must be positive, got: ${result}ms from "${ttl}"`
    );
  }

  return result;
}
