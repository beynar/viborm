/**
 * Cache Key Generation
 *
 * Generates deterministic cache keys from operation parameters.
 */

import { CacheInvalidKeyError } from "@errors";
import { fieldRefPayload, isFieldRef } from "@schema/field-ref";
import { isJsonNullSentinel } from "@schema/json-null";
import { isSql } from "@sql";

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
 * Generate an unprefixed cache key (internal use)
 * Key structure: <model>:<operation>:<hash>
 */
export function generateUnprefixedCacheKey(
  modelName: string,
  operation: string,
  args: unknown
): string {
  const argsHash = hashArgs(args);
  return `${modelName}:${operation}:${argsHash}`;
}

/**
 * Generate a deterministic cache key from operation parameters
 *
 * Returns a FULLY PREFIXED key for external use (manual invalidation, etc.)
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
 *
 * Returns a FULLY PREFIXED prefix for external use.
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
 * The two bytes that open and close a NON-JSON value's serialization: U+001F
 * (unit separator) and U+001E (record separator).
 *
 * They are what makes the token below UNFORGEABLE, and the reason is
 * mechanical: every string this serializer emits — operand values AND object
 * keys — goes through `JSON.stringify`, and JSON escapes every code point below
 * U+0020 into a printable six-character escape. A raw separator byte can
 * therefore never appear in the output by any route except the one deliberately
 * taken here, so a user document may spell the LETTERS of a token but never the
 * token. (Verified across the whole C0/C1 range, and for lone surrogates, by
 * the "no JSON value can forge a brand token" test.)
 */
const BRAND_OPEN = "\u001F";
const BRAND_CLOSE = "\u001E";

/**
 * Serialize a value that is not a JSON value — one of the branded operand
 * tokens, or a scalar JSON cannot carry — into the reserved namespace.
 *
 * `namespace` names the KIND and `body` distinguishes two values of that kind;
 * the delimiters are balanced, so a token nested inside another token's body
 * (an `Sql` whose bound values hold a `Date`) stays unambiguous.
 */
function brandToken(namespace: string, body: string): string {
  return `${BRAND_OPEN}viborm.${namespace}:${body}${BRAND_CLOSE}`;
}

/**
 * Stable JSON stringify that handles:
 * - Sorted object keys (deterministic)
 * - Date objects (ISO string)
 * - BigInt
 * - Uint8Array (base64)
 * - SQL fragments (statement text + bound values)
 * - Field references (the model and field they name)
 * - JSON null sentinels (`DbNull` / `JsonNull` / `AnyNull`)
 * - undefined values (omitted)
 * - Circular references (throws)
 *
 * It is only ever handed a VALIDATED payload (see
 * `PendingOperation.cacheKeyArgs`), so the non-JSON values it can meet are the
 * ones validation deliberately admits: a field reference, an SQL fragment, and
 * a JSON null sentinel.
 *
 * EVERY ONE OF THEM KEYS IN THE RESERVED NAMESPACE, because a user document is
 * allowed to look exactly like any of them. A JSON column takes an arbitrary
 * object, so `{ kind: "DbNull" }` is ordinary user data — and while the sentinel
 * carries `kind` as an own enumerable key precisely so a structural serializer
 * could tell the three apart, that only moved the collision one shape over:
 * walking `Object.keys` made `equals: DbNull` and `equals: { kind: "DbNull" }`
 * the same cache entry, and a cached client served one query's rows for the
 * other, in both directions, for the whole TTL.
 *
 * The sentinel is the one that collided in production spelling — a JSON filter
 * operand admits both a sentinel and an arbitrary document. The other two
 * cannot meet their look-alike at one position TODAY, and only because
 * validation holds those doors shut (`v.noFieldRef` refuses a reference
 * wherever arbitrary data is legal; `v.json` refuses a real `Sql` as
 * non-JSON-compatible) — while the fragment's look-alike still reached the
 * fragment branch and crashed there, see the note on it below. A key builder
 * that is correct only because a schema elsewhere is holding a door is one
 * refactor from being wrong again, so the rule here is structural instead:
 * what is not a JSON value does not serialize like one.
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
    return brandToken("bigint", String(value));
  }

  if (type !== "object") {
    // Functions and symbols are not cacheable
    throw new CacheInvalidKeyError(`Uncacheable value type: ${type}`);
  }

  // A fragment is identified by what it will EMIT, not by its instance fields:
  // an `Sql` memoizes its flattened text on first read, so enumerating its own
  // properties would key the same fragment differently depending on whether
  // anything had compiled it yet.
  //
  // THE METHOD IS PART OF THE TEST because `isSql` is a duck-type probe
  // (`strings` and `values`, both arrays), and a JSON column may legally hold
  // `{ strings: [], values: [] }` — validation says so in as many words
  // (`v.noFieldRef`: such a document "is honest user data and must stay
  // accepted"). That document reached here as a fragment and threw a bare
  // `TypeError: value.toStatement is not a function` out of cache key
  // generation. A real fragment carries the method that flattens it and a
  // document cannot, because `v.json` refuses a function; so the look-alike
  // falls through to the object branch below and keys as the data it is.
  if (isSql(value) && typeof value.toStatement === "function") {
    return brandToken(
      "sql",
      `${JSON.stringify(value.toStatement("?"))}:${stableStringify(value.values, seen)}`
    );
  }

  // A reference names a COLUMN: the model and field are its identity, and its
  // `type`/`list` are derived from them by `createModelFieldRefs`.
  if (isFieldRef(value)) {
    const payload = fieldRefPayload(value);
    return brandToken(
      "field-ref",
      `${JSON.stringify(payload.model)}:${JSON.stringify(payload.field)}`
    );
  }

  if (isJsonNullSentinel(value)) {
    return brandToken("json-null", value.kind);
  }

  if (value instanceof Date) {
    return brandToken("date", value.toISOString());
  }

  if (value instanceof Uint8Array) {
    // Use Buffer in Node.js, btoa in browser/edge
    let base64: string;
    if (typeof Buffer !== "undefined") {
      base64 = Buffer.from(value).toString("base64");
    } else {
      let binary = "";
      for (const byte of value) {
        binary += String.fromCharCode(byte);
      }
      base64 = btoa(binary);
    }
    return brandToken("bytes", base64);
  }

  if (Array.isArray(value)) {
    if (seen.has(value))
      throw new CacheInvalidKeyError("Circular reference in cache key args");
    seen.add(value);
    return `[${value.map((v) => stableStringify(v, seen)).join(",")}]`;
  }

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
