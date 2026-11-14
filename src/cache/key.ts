/**
 * Cache Key Generation
 *
 * Generates deterministic cache keys from operation parameters.
 */

import { stableStringify } from "@extensions/key";
import { isPlainRecord } from "@schema/relation/terminal";

/**
 * Prefix for all VibORM cache keys
 */
export const CACHE_PREFIX = "viborm";

/** Namespace root reserved for authenticated official cache extensions. */
export const OFFICIAL_CACHE_NAMESPACE_ROOT = `${CACHE_PREFIX}:cache`;

/**
 * Private storage-format revision. It moved r1 → r2 when the SQL namespace and
 * dialect entered the derivation below: every r1 entry keyed a scope that made
 * no claim about which schema or database produced the rows, so no r1 entry may
 * ever be served to an r2 reader. The bump is the invalidation.
 *
 * It moved r2 → r3 when a decimal became a value object. An r2 entry stored a
 * decimal's canonical text and MATERIALIZED it as that same string, which is
 * what an r2 reader's caller was handed; an r3 reader rebuilds a `Decimal` from
 * the identical bytes. The stored bytes did not change — their MEANING did, and
 * a reader that served the old bytes under the new contract would hand one
 * client a string where every other read gives it a value object. Same rule as
 * before: the bump is the invalidation.
 */
// r4 entries carry their full canonical identity, checked before materialization.
const OFFICIAL_CACHE_SNAPSHOT_REVISION = "r4";

/**
 * The facts one official cache scope partitions on.
 *
 * `dialect` is load-bearing on its own: a PostgreSQL schema `billing` and a
 * MySQL database `billing` are different stores that spell their qualifier the
 * same way. `namespace` is `undefined` for exactly the families the feature
 * leaves unqualified — SQLite and unbound MySQL/PlanetScale — and that absence
 * is encoded as its own token, never as text that a real namespace could spell.
 */
export interface OfficialCacheScopeFacts {
  readonly version: string | number | undefined;
  readonly dialect: string;
  readonly namespace: string | undefined;
}

/**
 * Encode text as fixed-width hex per UTF-16 code unit.
 *
 * Fixed width is what makes the joined namespace INJECTIVE: every component
 * below is either a bare discriminator letter or `<letter>:<hex>`, hex never
 * contains the `:` separator, and no variable-length body can absorb the
 * component after it. Two different fact tuples therefore cannot produce one
 * namespace, which is the whole isolation guarantee.
 */
function encodeText(value: string): string {
  let encoded = "";
  for (let index = 0; index < value.length; index += 1) {
    encoded += value.charCodeAt(index).toString(16).padStart(4, "0");
  }
  return encoded;
}

/** `u` unversioned, `n:<f64 hex>` numeric, `s:<hex>` string. */
function encodeVersion(version: string | number | undefined): string {
  if (version === undefined) return "u";
  if (typeof version === "number") {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, version, false);
    let encoded = "";
    for (const byte of bytes) encoded += byte.toString(16).padStart(2, "0");
    return `n:${encoded}`;
  }
  return `s:${encodeText(version)}`;
}

/**
 * `x` unknown, `k:<hex>` known.
 *
 * An unknown namespace is a bare `x` with no body, so it cannot be reached by
 * encoding any string whatsoever — a database literally named `undefined`
 * encodes as `k:0075...`. Absence is a distinct value here, not a spelling.
 */
function encodeNamespace(namespace: string | undefined): string {
  return namespace === undefined ? "x" : `k:${encodeText(namespace)}`;
}

/**
 * Build the private namespace for one client-bound official cache extension.
 *
 * Pure: the same facts always give the same string, which is why re-binding the
 * chain after another extension is appended retains the scope by value instead
 * of needing a registry to hand the old one back.
 */
export function createOfficialCacheNamespace(
  facts: OfficialCacheScopeFacts
): string {
  return [
    OFFICIAL_CACHE_NAMESPACE_ROOT,
    OFFICIAL_CACHE_SNAPSHOT_REVISION,
    `d:${encodeText(facts.dialect)}`,
    encodeNamespace(facts.namespace),
    encodeVersion(facts.version),
  ].join(":");
}

/** Hash for storage lookup, exact identity for collision verification. */
export function cacheLookupOf(
  model: string,
  operation: string,
  args: unknown
): {
  readonly key: string;
  readonly identity: string;
} {
  const serialized = stableStringify(args);
  return {
    key: `${model}:${operation}:${fastHash(serialized)}`,
    identity: JSON.stringify([model, operation, serialized]),
  };
}

/**
 * Whether {@link stableStringify} keys this value by its content: plain
 * records and arrays of JSON scalars, bigints, valid `Date`s and
 * `Uint8Array`s. A class instance would key as its own enumerable fields (a
 * `Map` as `{}`), a function or symbol throws, and a cycle throws; the caller
 * bypasses the cache for any of those rather than alias or fail. A value it
 * cannot inspect is not canonical either.
 */
export function isCanonicalKeyData(value: unknown): boolean {
  try {
    return hasCanonicalForm(value, new Set());
  } catch {
    return false;
  }
}

function hasCanonicalForm(value: unknown, seen: Set<object>): boolean {
  if (value === null) return true;
  switch (typeof value) {
    case "string":
    case "boolean":
    case "bigint":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object":
      break;
    default:
      return false;
  }
  // The two instance kinds `stableStringify` brands, tested as it tests them.
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  if (value instanceof Uint8Array) return true;
  if (seen.has(value)) return false;
  if (!(Array.isArray(value) || isPlainRecord(value))) return false;
  seen.add(value);
  const canonical = Object.values(value).every((entry) =>
    hasCanonicalForm(entry, seen)
  );
  seen.delete(value);
  return canonical;
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
    // biome-ignore lint/suspicious/noBitwiseOperators: Hash mixing requires 32-bit XOR.
    h1 = Math.imul(h1 ^ ch, 2_654_435_761);
    // biome-ignore lint/suspicious/noBitwiseOperators: Hash mixing requires 32-bit XOR.
    h2 = Math.imul(h2 ^ ch, 1_597_334_677);
  }

  // biome-ignore lint/suspicious/noBitwiseOperators: Hash finalization requires 32-bit mixing.
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2_246_822_507);
  // biome-ignore lint/suspicious/noBitwiseOperators: Hash finalization requires 32-bit mixing.
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3_266_489_909);
  // biome-ignore lint/suspicious/noBitwiseOperators: Hash finalization requires 32-bit mixing.
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2_246_822_507);
  // biome-ignore lint/suspicious/noBitwiseOperators: Hash finalization requires 32-bit mixing.
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3_266_489_909);

  return (
    // biome-ignore lint/suspicious/noBitwiseOperators: Hex output requires unsigned 32-bit values.
    (h2 >>> 0).toString(16).padStart(8, "0") +
    // biome-ignore lint/suspicious/noBitwiseOperators: Hex output requires unsigned 32-bit values.
    (h1 >>> 0)
      .toString(16)
      .padStart(8, "0")
  );
}
