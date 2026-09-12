/**
 * The ONE codec of a declared identifier DOMAIN.
 *
 * A domain is `{ format, prefix?, length? }` — exactly the facts a generator
 * modifier already recorded on the scalar, never a second declaration. This
 * module answers the three questions every boundary asks about a value in one:
 *
 *  1. Is this string IN the domain, and what is its canonical spelling?
 *     (`canonicalizeId`: the uppercase UUID and the lowercase ULID are aliases,
 *     and an identity-sensitive consumer — a cache key, a captured row key, an
 *     `fkEquals` — must see one spelling for one identifier.)
 *  2. What does the column physically hold for it? (`encodePhysicalId`)
 *  3. Which public value did a physical one come back as? (`decodePhysicalId`)
 *
 * It is PURE and dialect-blind on purpose. It takes an
 * {@link IdRepresentation}, never a provider: choosing the representation is a
 * storage question, owned one layer up in
 * {@link file://../../schema/scalars/string/id-domain.ts}, and a codec that
 * knew about `bytea` could not be read by the validation schemas that run
 * before any adapter exists.
 *
 * Two things it deliberately does NOT do. It never splits a value on `-`: a
 * prefix is matched WHOLE, because `usr-01H…` and a UUID both contain hyphens
 * and a generic split would silently reinterpret one as the other. And it
 * never widens a format: a text that is not a spelling of the declared format
 * is `undefined` here, so the boundary that asked owns the message.
 */

import { normalizeBinaryValue } from "./binary-shapes";
import {
  applyIdPrefix,
  bytesToKsuid,
  bytesToUlid,
  bytesToUuid,
  CUID_TEXT,
  hasIdPrefix,
  KSUID_BYTE_LENGTH,
  ksuidToBytes,
  NANOID_ALPHABET,
  NANOID_DEFAULT_LENGTH,
  ULID_BYTE_LENGTH,
  UUID_BYTE_LENGTH,
  ulidToBytes,
  uuidToBytes,
} from "./id-formats";

// =============================================================================
// THE DOMAIN
// =============================================================================

/** The six string generators that name an identifier domain. */
export type IdFormat = "uuid" | "uuidv7" | "ulid" | "ksuid" | "nanoid" | "cuid";

const ID_FORMATS: ReadonlySet<string> = new Set<IdFormat>([
  "uuid",
  "uuidv7",
  "ulid",
  "ksuid",
  "nanoid",
  "cuid",
]);

/** Whether a generator kind names an identifier domain. */
export function isIdFormat(kind: string | undefined): kind is IdFormat {
  return kind !== undefined && ID_FORMATS.has(kind);
}

/**
 * A declared or derived identifier domain.
 *
 * `prefix` is absent rather than empty when none was declared — `""` is how a
 * caller spells "no prefix", and carrying it would make a bare `-` part of
 * every value. `length` belongs to `nanoid` alone; every other format's width
 * is the format's own.
 */
export interface IdDomain {
  readonly format: IdFormat;
  readonly prefix?: string | undefined;
  readonly length?: number | undefined;
}

/**
 * The four formats whose values are stored COMPACT — as bytes, or as a
 * PostgreSQL `uuid`.
 *
 * Compactness is what costs them `contains`/`startsWith`/`endsWith`/`mode`: a
 * substring of a 16-byte column is not a substring of the text a caller wrote.
 * `nanoid` and `cuid` stay text and keep every string operator.
 */
export function isCompactIdFormat(format: IdFormat): boolean {
  return (
    format === "uuid" ||
    format === "uuidv7" ||
    format === "ulid" ||
    format === "ksuid"
  );
}

/** Whether two domains admit exactly the same values and store them alike. */
export function sameIdDomain(
  left: IdDomain | undefined,
  right: IdDomain | undefined
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.format === right.format &&
    idPrefixOf(left) === idPrefixOf(right) &&
    nanoidLengthOf(left) === nanoidLengthOf(right)
  );
}

/** The declared prefix, with `""` read as the absence it spells. */
function idPrefixOf(domain: IdDomain): string | undefined {
  return hasIdPrefix(domain.prefix) ? domain.prefix : undefined;
}

/** The width a nanoid domain admits; every other format has a fixed one. */
function nanoidLengthOf(domain: IdDomain): number | undefined {
  if (domain.format !== "nanoid") return undefined;
  return domain.length ?? NANOID_DEFAULT_LENGTH;
}

/** One phrase naming a domain, for a refusal that has to say what was expected. */
export function describeIdDomain(domain: IdDomain): string {
  const prefix = idPrefixOf(domain);
  const width =
    domain.format === "nanoid" ? ` of length ${nanoidLengthOf(domain)}` : "";
  return prefix === undefined
    ? `a ${domain.format} value${width}`
    : `a ${domain.format} value${width} prefixed '${prefix}-'`;
}

// =============================================================================
// ADMISSION
// =============================================================================

/**
 * The PAYLOAD of a public value: everything after an exactly-matched
 * `prefix-`, or the whole value when the domain declares no prefix.
 *
 * `undefined` means the prefix the domain declares is not the one this value
 * carries, which is a refusal and never a reason to try the bare payload.
 */
function payloadOf(value: string, domain: IdDomain): string | undefined {
  const prefix = idPrefixOf(domain);
  if (prefix === undefined) return value;
  const marker = `${prefix}-`;
  return value.startsWith(marker) ? value.slice(marker.length) : undefined;
}

/** Whether every character of `text` is one this nanoid alphabet has. */
function isNanoidPayload(text: string, length: number): boolean {
  if (text.length !== length) return false;
  for (const char of text) {
    if (!NANOID_ALPHABET.includes(char)) return false;
  }
  return true;
}

/**
 * The canonical spelling of one payload, or `undefined`.
 *
 * The compact formats normalize through their own byte conversion — the leaf
 * already owns which spellings are aliases and which are not values at all —
 * so a ULID whose first character exceeds `7` and a UUID with braces are
 * refused here for the same reason they are refused there. The text formats
 * are case-sensitive with no aliases, so their canonical form is themselves.
 */
function canonicalizePayload(
  payload: string,
  domain: IdDomain
): string | undefined {
  switch (domain.format) {
    case "uuid":
    case "uuidv7": {
      const bytes = uuidToBytes(payload);
      return bytes === undefined ? undefined : bytesToUuid(bytes);
    }
    case "ulid": {
      const bytes = ulidToBytes(payload);
      return bytes === undefined ? undefined : bytesToUlid(bytes);
    }
    case "ksuid":
      return ksuidToBytes(payload) === undefined ? undefined : payload;
    case "nanoid":
      return isNanoidPayload(payload, nanoidLengthOf(domain)!)
        ? payload
        : undefined;
    default:
      return CUID_TEXT.test(payload) ? payload : undefined;
  }
}

/**
 * The canonical PUBLIC value this domain names, or `undefined` when the input
 * is not one of its values.
 *
 * This is the admission every boundary shares: create and update values, unique
 * selectors, `equals`/`not`/`in`/`notIn`/`lt`/`lte`/`gt`/`gte` operands,
 * cursors, and every `connect`/`connectOrCreate`/`upsert` key. Normalizing HERE
 * — once, before anything identity-sensitive — is what keeps one identifier
 * from hashing to two cache keys.
 */
export function canonicalizeId(
  value: unknown,
  domain: IdDomain
): string | undefined {
  if (typeof value !== "string") return undefined;
  const payload = payloadOf(value, domain);
  if (payload === undefined) return undefined;
  const canonical = canonicalizePayload(payload, domain);
  return canonical === undefined
    ? undefined
    : applyIdPrefix(idPrefixOf(domain), canonical);
}

// =============================================================================
// PHYSICAL REPRESENTATION
// =============================================================================

/**
 * What a column physically holds for one identifier.
 *
 * - `"text"` — the whole PUBLIC string, prefix included. Every `nanoid` and
 *   `cuid` field, and any domain field whose native type override keeps a text
 *   column.
 * - `"uuid"` — the payload as canonical UUID text, which is what a PostgreSQL
 *   `uuid` column takes and returns on the wire.
 * - `"bytes"` — the payload's own bytes: 16 for a UUID or ULID, 20 for a KSUID.
 *
 * A declared PREFIX is never stored. It is a fact of the declaration, identical
 * in every row, and re-applied on read — which is also why `"uuid"` and
 * `"bytes"` are not identity paths for a prefixed field.
 */
export type IdRepresentation = "text" | "uuid" | "bytes";

/** The bytes a canonical payload names, for a domain that has a byte form. */
function payloadBytes(
  payload: string,
  format: IdFormat
): Uint8Array | undefined {
  switch (format) {
    case "uuid":
    case "uuidv7":
      return uuidToBytes(payload);
    case "ulid":
      return ulidToBytes(payload);
    case "ksuid":
      return ksuidToBytes(payload);
    default:
      return undefined;
  }
}

/** The byte width a compact format's column holds, or `undefined` for text. */
export function idByteLength(format: IdFormat): number | undefined {
  switch (format) {
    case "uuid":
    case "uuidv7":
      return UUID_BYTE_LENGTH;
    case "ulid":
      return ULID_BYTE_LENGTH;
    case "ksuid":
      return KSUID_BYTE_LENGTH;
    default:
      return undefined;
  }
}

/** The public text a compact format's bytes name, or `undefined` on a bad width. */
function textOfBytes(bytes: Uint8Array, format: IdFormat): string | undefined {
  if (bytes.length !== idByteLength(format)) return undefined;
  switch (format) {
    case "uuid":
    case "uuidv7":
      return bytesToUuid(bytes);
    case "ulid":
      return bytesToUlid(bytes);
    case "ksuid":
      return bytesToKsuid(bytes);
    default:
      return undefined;
  }
}

/**
 * The physical value to bind for one CANONICAL public string, or `undefined`
 * when the string is not in the domain.
 *
 * The caller has normally canonicalized already — the field's validation schema
 * did it on the way in — and passing a non-canonical alias here still works,
 * because the encoding goes through the same admission. What it will not do is
 * invent a value: a string outside the domain has no bytes, and binding one
 * would write a row no read could ever return.
 */
export function encodePhysicalId(
  value: string,
  domain: IdDomain,
  representation: IdRepresentation
): string | Uint8Array | undefined {
  const canonical = canonicalizeId(value, domain);
  if (canonical === undefined) return undefined;
  if (representation === "text") return canonical;
  const payload = payloadOf(canonical, domain)!;
  if (representation === "uuid") return payload;
  return payloadBytes(payload, domain.format);
}

/**
 * The public string a physical value stands for, or `undefined` when the
 * column holds something this domain cannot name.
 *
 * The `"bytes"` arm accepts every shape a driver spells binary in — `Buffer`,
 * `Uint8Array`, `ArrayBuffer`, a byte array, PostgreSQL's `\x…`, MySQL's
 * `base64:typeNNN:…`, and the lowercase hex a JSON carrier travels as —
 * through the one shared normalization, so a nested `include` and a flat select
 * decode the same row to the same string.
 */
export function decodePhysicalId(
  physical: unknown,
  domain: IdDomain,
  representation: IdRepresentation
): string | undefined {
  if (representation === "text") {
    return canonicalizeId(physical, domain);
  }
  if (representation === "uuid") {
    if (typeof physical !== "string") return undefined;
    const bytes = uuidToBytes(physical);
    return bytes === undefined
      ? undefined
      : applyIdPrefix(idPrefixOf(domain), bytesToUuid(bytes));
  }
  const shape = normalizeBinaryValue(physical);
  if (shape.bytes === undefined) return undefined;
  const text = textOfBytes(shape.bytes, domain.format);
  return text === undefined
    ? undefined
    : applyIdPrefix(idPrefixOf(domain), text);
}
