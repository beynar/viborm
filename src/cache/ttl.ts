/**
 * TTL Parser
 *
 * Converts human-readable TTL strings to milliseconds.
 */

import { CacheInvalidTTLError } from "@errors";

/**
 * Time unit multipliers in milliseconds
 */
const TIME_UNITS: Record<string, number> = {
  ms: 1,
  millisecond: 1,
  milliseconds: 1,
  s: 1000,
  sec: 1000,
  second: 1000,
  seconds: 1000,
  m: 60 * 1000,
  min: 60 * 1000,
  minute: 60 * 1000,
  minutes: 60 * 1000,
  h: 60 * 60 * 1000,
  hr: 60 * 60 * 1000,
  hour: 60 * 60 * 1000,
  hours: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  days: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  weeks: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
  months: 30 * 24 * 60 * 60 * 1000,
};

const VALID_UNITS = Object.keys(TIME_UNITS).join(", ");

/**
 * Parse a TTL string into milliseconds
 *
 * @example
 * parseTTL("1 hour")      // 3600000
 * parseTTL("20 seconds")  // 20000
 * parseTTL("5m")          // 300000
 * parseTTL("2.5 hours")   // 9000000
 * parseTTL(3000)          // 3000 (passthrough)
 *
 * @throws CacheInvalidTTLError if format is invalid
 */
const TTL_PATTERN = /^(\d+(?:\.\d+)?)\s*([a-z]+)$/;

export function parseTTL(ttl: string | number): number {
  if (typeof ttl === "number") {
    if (ttl <= 0) {
      throw new CacheInvalidTTLError(`TTL must be positive, got: ${ttl}`);
    }
    return ttl;
  }

  const normalized = ttl.trim().toLowerCase();

  // Match patterns like "1 hour", "20seconds", "2.5 h"
  const match = normalized.match(TTL_PATTERN);

  if (!match) {
    throw new CacheInvalidTTLError(
      `Invalid TTL format: "${ttl}". Expected format: "<number> <unit>" (e.g., "1 hour", "20 seconds")`
    );
  }

  const valueStr = match[1] as string;
  const unit = match[2] as string;
  const value = Number.parseFloat(valueStr);
  const multiplier = TIME_UNITS[unit];

  if (multiplier === undefined) {
    throw new CacheInvalidTTLError(
      `Unknown time unit: "${unit}". Valid units: ${VALID_UNITS}`
    );
  }

  const result = Math.floor(value * multiplier);

  if (result <= 0) {
    throw new CacheInvalidTTLError(
      `TTL must be positive, got: ${result}ms from "${ttl}"`
    );
  }

  return result;
}
