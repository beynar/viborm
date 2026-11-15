/**
 * Cache key spaces: the official namespace one cache scope partitions on,
 * and the hash that names an entry inside it. What a read is keyed on is the
 * prepared call itself (`key(run)`).
 */

/**
 * Prefix for all VibORM cache keys
 */
export const CACHE_PREFIX = "viborm";

/** Namespace root reserved for the official cache extension's scopes. */
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
// r5 entries are keyed by the prepared call (`key(run)`): the statement the
// engine sends, so a rule's filter, order and projection key an entry by
// what they do to that statement.
// r6 entries hold the rows the driver returned, not the decoded answer: an r5
// answer read as rows would be refused at best.
const OFFICIAL_CACHE_SNAPSHOT_REVISION = "r6";

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
  // `split("")` gives the code units, never a pair as one code point.
  return value
    .split("")
    .map((unit) => unit.charCodeAt(0).toString(16).padStart(4, "0"))
    .join("");
}

/** `u` unversioned, `n:<f64 hex>` numeric, `s:<hex>` string. */
function encodeVersion(version: string | number | undefined): string {
  if (version === undefined) return "u";
  if (typeof version === "number") {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, version, false);
    return `n:${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  return `s:${encodeText(version)}`;
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
    // `x` unknown, `k:<hex>` known. An unknown namespace is a bare `x` with
    // no body, so it cannot be reached by encoding any string whatsoever — a
    // database literally named `undefined` encodes as `k:0075...`. Absence is
    // a distinct value here, not a spelling.
    facts.namespace === undefined ? "x" : `k:${encodeText(facts.namespace)}`,
    encodeVersion(facts.version),
  ].join(":");
}

/**
 * Fast non-cryptographic hash (djb2 variant)
 * Produces a 16-character hex string
 */
export function fastHash(str: string): string {
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
