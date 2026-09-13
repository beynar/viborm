// biome-ignore-all lint/suspicious/noBitwiseOperators: a version nibble, a
// variant pair and a base32 digit are DEFINED as bit fields; expressing them
// arithmetically would restate the same masks less legibly.

/**
 * The ONE reversible representation of every fixed-width identifier format.
 *
 * UUID, ULID and KSUID each name the same value twice: as the TEXT a caller
 * writes and reads, and as the BYTES that text stands for. This module owns
 * both spellings and the conversion between them, plus the byte layout each
 * format's generator assembles. Nothing above it re-derives a width, an
 * alphabet, a padding rule, or a version bit.
 *
 * It is a LEAF on purpose. It imports no scalar class, no schema state and no
 * dialect, so the storage codec that will encode and decode these values at the
 * database boundary can consume the same conversions the generators use. Two
 * implementations of "what a ULID is" is exactly what this file exists to
 * prevent.
 *
 * Two asymmetries are deliberate:
 *
 * 1. TEXT -> BYTES returns `undefined` for anything outside the format. Text is
 *    what a caller types, so a spelling the format does not have is a value to
 *    refuse, and the boundary that asked owns the message.
 * 2. BYTES -> TEXT REFUSES a wrong width. A byte array is never typed by a
 *    caller; it is produced by a generator or read out of a column, so a width
 *    that is not the format's names a broken physical value rather than a
 *    spelling question, and no caller above can say anything truer about it.
 *
 * Randomness is drawn HERE and only here, from `crypto.getRandomValues`. There
 * is no `Math.random()` path: an identifier that is not unpredictable is not an
 * identifier, so a runtime without secure randomness gets a refusal instead of
 * a weaker value.
 */

import { ValidationError } from "@errors";

// =============================================================================
// WIDTHS AND DOMAINS
// =============================================================================

/** Bytes in a UUID (RFC 9562 §4) and characters in its canonical text. */
export const UUID_BYTE_LENGTH = 16;
export const UUID_TEXT_LENGTH = 36;

/** Bytes in a ULID and characters in its Crockford base32 text. */
export const ULID_BYTE_LENGTH = 16;
export const ULID_TEXT_LENGTH = 26;

/** Bytes in a KSUID and characters in its base62 text. */
export const KSUID_BYTE_LENGTH = 20;
export const KSUID_TEXT_LENGTH = 27;

/** Random bytes a ULID carries after its 48-bit timestamp. */
export const ULID_RANDOM_LENGTH = 10;

/** Random bytes a UUIDv7 carries after its 48-bit timestamp. */
export const UUIDV7_RANDOM_LENGTH = 10;

/** Payload bytes a KSUID carries after its 32-bit timestamp. */
export const KSUID_PAYLOAD_LENGTH = 16;

/**
 * The widest instant a 48-bit millisecond timestamp names: 2^48-1 ms after the
 * Unix epoch, which is in the year 10889. Shared by ULID and UUIDv7.
 */
export const MAX_MILLISECOND_TIMESTAMP = 281_474_976_710_655;

/** KSUID counts seconds from 2014-05-13T16:53:20Z, not from the Unix epoch. */
export const KSUID_EPOCH_SECONDS = 1_400_000_000;

/** The widest second a 32-bit KSUID timestamp names, as a Unix second. */
export const MAX_KSUID_UNIX_SECONDS = KSUID_EPOCH_SECONDS + 4_294_967_295;

/**
 * Crockford's base32 alphabet: no `I`, `L`, `O` or `U`. VibORM does NOT map the
 * excluded letters onto digits — a ULID with an `I` in it was not produced by
 * this format, and silently reading it as `1` would make two different texts
 * the same identifier.
 */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * The accepted spellings of one Crockford digit: canonical uppercase first,
 * its lowercase alias second, so `indexOf(char) % 32` is the digit's value and
 * anything else is not a digit at all.
 *
 * The lookup is by exact character rather than by case folding: `"ſ"`
 * upper-cases to `"S"`, and a ULID is an identity, not a piece of prose.
 */
const CROCKFORD_ALIASED = CROCKFORD + CROCKFORD.toLowerCase();

/**
 * NanoID's URL-safe alphabet: 64 characters, so one random byte selects one
 * character through `byte & 63` with no bias and no rejection sampling.
 *
 * It lives HERE, beside the fixed-width alphabets, because a declared nanoid
 * field has to ADMIT the values it generates: the storage codec spells the
 * grammar from the same 64 characters the generator draws from, and two copies
 * of an alphabet is exactly how a generated value comes to be refused by its
 * own field.
 */
export const NANOID_ALPHABET =
  "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";

/** The length `.nanoid()` takes when the declaration names none. */
export const NANOID_DEFAULT_LENGTH = 21;

/**
 * The one spelling a CUID2 has: a lowercase letter then 23 lowercase
 * alphanumerics, which is what this port's generator emits at its fixed length
 * of 24 and what upstream's own validator accepts.
 */
export const CUID_TEXT = /^[a-z][0-9a-z]{23}$/;

/**
 * KSUID's base62 alphabet, in ASCII order. The order is load-bearing: it makes
 * the text sort exactly as the bytes sort, which is what makes a KSUID
 * time-sortable as a string.
 */
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** The first value 20 bytes cannot hold; some 27-character base62 texts exceed it. */
const KSUID_EXCLUSIVE_MAX = 2n ** 160n;

const UUID_TEXT =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const HEX_RADIX = 16;
const BASE62_RADIX = 62n;
const BYTE_RADIX = 256n;
const BYTE_MASK = 255n;

// =============================================================================
// THE ONE REFUSAL
// =============================================================================

/**
 * The one refusal an identifier declaration or generation raises.
 *
 * Every failure here is a DECLARATION failure in the end — a length the format
 * has no value for, an instant it cannot name, a prefix that contradicts one
 * already declared, or a runtime that cannot produce the entropy the declared
 * format requires — so they all name the builder that was spelled and the part
 * of the declaration at fault.
 */
export function refuseId(
  builder: string,
  path: string,
  message: string
): never {
  throw new ValidationError({ kind: "schema-builder", builder, path }, [
    { path, message },
  ]);
}

// =============================================================================
// SECURE RANDOMNESS
// =============================================================================

/**
 * The most bytes one call to the entropy source will serve.
 *
 * `crypto.getRandomValues` refuses a request larger than this with a
 * `QuotaExceededError` (Web Cryptography API §10.1), so it is the ceiling on
 * every length a caller can choose. It is published because a DECLARATION that
 * asks for more has to be refused where it is spelled, not at row-create time
 * inside a closure.
 */
export const MAX_RANDOM_BYTES = 65_536;

/**
 * `length` unpredictable bytes, or a refusal.
 *
 * The ONE entropy source in the identifier language. It is read at GENERATION
 * time, never at import or declaration time, so loading VibORM and describing a
 * schema draw nothing.
 *
 * `format` names the generator that asked, because the message a developer sees
 * has to say what stopped working. It cannot name the FIELD: a generator is a
 * closure held in scalar state, and field keys belong to the model that later
 * mounts that scalar, so no field name exists at this point in the program.
 */
export function randomBytes(length: number, format: string): Uint8Array {
  const source = globalThis.crypto;
  if (typeof source?.getRandomValues !== "function") {
    refuseId(
      `s.string().${format}`,
      "generate",
      `Cannot generate a ${format} value: this runtime exposes no \`crypto.getRandomValues\`. VibORM never falls back to \`Math.random()\` for an identifier`
    );
  }
  return source.getRandomValues(new Uint8Array(length));
}

// =============================================================================
// PREFIX
// =============================================================================

/**
 * Whether a declaration carries a prefix. An empty string is NOT a prefix: it
 * is how a caller spells "no prefix", and `${""}-${value}` would otherwise make
 * a bare hyphen part of every value.
 */
export function hasIdPrefix(prefix: string | undefined): boolean {
  return prefix !== undefined && prefix !== "";
}

/**
 * The public value of a generated identifier: `prefix-payload`, or the bare
 * payload when no prefix was declared. The hyphen is part of the contract, and
 * a prefix is matched whole at admission — nothing splits generically on `-`.
 */
export function applyIdPrefix(
  prefix: string | undefined,
  payload: string
): string {
  return hasIdPrefix(prefix) ? `${prefix}-${payload}` : payload;
}

// =============================================================================
// EXACT-WIDTH INTEGERS
// =============================================================================

/**
 * Write `value` big-endian across exactly `byteLength` bytes.
 *
 * Callers have already proved the value fits — each format refuses its own
 * out-of-range instant with a message naming that format — so this writes
 * rather than checks. Arithmetic, not shifts: a 48-bit timestamp is wider than
 * the 32 bits JavaScript's bitwise operators work in.
 */
function writeUintBE(
  view: DataView,
  offset: number,
  byteLength: number,
  value: number
): void {
  let remaining = value;
  for (let index = byteLength - 1; index >= 0; index--) {
    view.setUint8(offset + index, remaining % 256);
    remaining = Math.floor(remaining / 256);
  }
}

/** Refuse an instant no 48-bit millisecond timestamp can name. */
function assertMillisecondTimestamp(format: string, timeMillis: number): void {
  if (
    !Number.isInteger(timeMillis) ||
    timeMillis < 0 ||
    timeMillis > MAX_MILLISECOND_TIMESTAMP
  ) {
    refuseId(
      `s.string().${format}`,
      "generate",
      `A ${format} timestamp must be a whole number of milliseconds between 0 and ${MAX_MILLISECOND_TIMESTAMP}; received ${timeMillis}`
    );
  }
}

// =============================================================================
// UUID
// =============================================================================

/**
 * Tag 16 random bytes as a UUIDv4 (RFC 9562 §5.4): version `0100` in the high
 * nibble of byte 6, variant `10` in the top two bits of byte 8. The 122 other
 * bits stay exactly as drawn.
 *
 * The argument is consumed: it is the generator's own fresh entropy, and
 * copying it would only make a second array to forget to clear.
 */
export function uuidV4Bytes(random: Uint8Array): Uint8Array {
  const view = new DataView(
    random.buffer,
    random.byteOffset,
    random.byteLength
  );
  view.setUint8(6, (view.getUint8(6) & 0x0f) | 0x40);
  view.setUint8(8, (view.getUint8(8) & 0x3f) | 0x80);
  return random;
}

/**
 * Assemble a UUIDv7 (RFC 9562 §5.7): a 48-bit big-endian Unix millisecond
 * timestamp, version `0111`, 12 random bits, variant `10`, 62 random bits.
 *
 * Time-sortable by construction. There is deliberately no same-millisecond
 * monotonic promise: RFC 9562 makes that optional, and the counter it would
 * take is ULID's job here.
 */
export function uuidV7Bytes(
  timeMillis: number,
  random: Uint8Array
): Uint8Array {
  assertMillisecondTimestamp("uuidv7", timeMillis);
  const bytes = new Uint8Array(UUID_BYTE_LENGTH);
  bytes.set(random, UUID_BYTE_LENGTH - UUIDV7_RANDOM_LENGTH);
  const view = new DataView(bytes.buffer);
  writeUintBE(view, 0, 6, timeMillis);
  view.setUint8(6, (view.getUint8(6) & 0x0f) | 0x70);
  view.setUint8(8, (view.getUint8(8) & 0x3f) | 0x80);
  return bytes;
}

/** The canonical text of 16 UUID bytes: lowercase hex, hyphenated 8-4-4-4-12. */
export function bytesToUuid(bytes: Uint8Array): string {
  if (bytes.length !== UUID_BYTE_LENGTH) {
    refuseId(
      "s.string().uuid",
      "generate",
      `A UUID is exactly ${UUID_BYTE_LENGTH} bytes; received ${bytes.length}`
    );
  }
  let hex = "";
  for (const byte of bytes) hex += byte.toString(HEX_RADIX).padStart(2, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The 16 bytes a canonical UUID text names, or `undefined`.
 *
 * Uppercase is an accepted ALIAS (RFC 9562 §4 requires readers to accept it),
 * so `A1B2…` and `a1b2…` are the same identifier and produce the same bytes.
 * Braces, URNs and unhyphenated forms are not spellings this format has.
 */
export function uuidToBytes(text: string): Uint8Array | undefined {
  if (!UUID_TEXT.test(text)) return;
  const hex = text.replaceAll("-", "");
  const bytes = new Uint8Array(UUID_BYTE_LENGTH);
  for (let index = 0; index < UUID_BYTE_LENGTH; index++) {
    bytes[index] = Number.parseInt(
      hex.slice(index * 2, index * 2 + 2),
      HEX_RADIX
    );
  }
  return bytes;
}

// =============================================================================
// ULID
// =============================================================================

/**
 * Assemble a ULID: a 48-bit big-endian millisecond timestamp followed by 80
 * bits of randomness.
 */
export function ulidBytes(timeMillis: number, random: Uint8Array): Uint8Array {
  assertMillisecondTimestamp("ulid", timeMillis);
  const bytes = new Uint8Array(ULID_BYTE_LENGTH);
  bytes.set(random, ULID_BYTE_LENGTH - ULID_RANDOM_LENGTH);
  writeUintBE(new DataView(bytes.buffer), 0, 6, timeMillis);
  return bytes;
}

/**
 * The canonical text of 16 ULID bytes: 26 uppercase Crockford characters.
 *
 * 26 characters hold 130 bits and a ULID is 128, so the text is the value
 * left-padded with two zero bits. That padding is why a canonical ULID's first
 * character is always `0` through `7`.
 */
export function bytesToUlid(bytes: Uint8Array): string {
  if (bytes.length !== ULID_BYTE_LENGTH) {
    refuseId(
      "s.string().ulid",
      "generate",
      `A ULID is exactly ${ULID_BYTE_LENGTH} bytes; received ${bytes.length}`
    );
  }
  let text = "";
  let accumulator = 0;
  let bits = 2;
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      text += CROCKFORD.charAt((accumulator >>> bits) & 31);
    }
    accumulator &= (1 << bits) - 1;
  }
  return text;
}

/**
 * The 16 bytes a canonical ULID text names, or `undefined`.
 *
 * Lowercase is an accepted alias and normalizes to the same bytes. A first
 * character above `7` sets one of the two padding bits, which names a value
 * wider than 128 bits: that text is not a ULID and is refused rather than
 * truncated.
 */
export function ulidToBytes(text: string): Uint8Array | undefined {
  if (text.length !== ULID_TEXT_LENGTH) return;
  const first = CROCKFORD_ALIASED.indexOf(text.charAt(0));
  if (first < 0) return;
  const leading = first % 32;
  if (leading > 7) return;
  const bytes = new Uint8Array(ULID_BYTE_LENGTH);
  let accumulator = leading;
  let bits = 3;
  let index = 0;
  for (const char of text.slice(1)) {
    const digit = CROCKFORD_ALIASED.indexOf(char);
    if (digit < 0) return;
    accumulator = (accumulator << 5) | (digit % 32);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes[index] = (accumulator >>> bits) & 255;
      index++;
      accumulator &= (1 << bits) - 1;
    }
  }
  return bytes;
}

// =============================================================================
// KSUID
// =============================================================================

/**
 * Assemble a KSUID: a 32-bit big-endian count of seconds since
 * 2014-05-13T16:53:20Z followed by a 128-bit payload.
 *
 * The timestamp is given as a UNIX second — the offset epoch is this format's
 * private business, and a caller that had to subtract it would be a second
 * owner of the same constant.
 */
export function ksuidBytes(
  unixSeconds: number,
  payload: Uint8Array
): Uint8Array {
  if (
    !Number.isInteger(unixSeconds) ||
    unixSeconds < KSUID_EPOCH_SECONDS ||
    unixSeconds > MAX_KSUID_UNIX_SECONDS
  ) {
    refuseId(
      "s.string().ksuid",
      "generate",
      `A KSUID timestamp must be a whole Unix second between ${KSUID_EPOCH_SECONDS} and ${MAX_KSUID_UNIX_SECONDS}; received ${unixSeconds}`
    );
  }
  const bytes = new Uint8Array(KSUID_BYTE_LENGTH);
  bytes.set(payload, KSUID_BYTE_LENGTH - KSUID_PAYLOAD_LENGTH);
  writeUintBE(
    new DataView(bytes.buffer),
    0,
    4,
    unixSeconds - KSUID_EPOCH_SECONDS
  );
  return bytes;
}

/**
 * The canonical text of 20 KSUID bytes: exactly 27 base62 characters, padded
 * with leading `0`s. The width is fixed rather than minimal, because a KSUID
 * that shortened itself for a small timestamp would stop sorting.
 */
export function bytesToKsuid(bytes: Uint8Array): string {
  if (bytes.length !== KSUID_BYTE_LENGTH) {
    refuseId(
      "s.string().ksuid",
      "generate",
      `A KSUID is exactly ${KSUID_BYTE_LENGTH} bytes; received ${bytes.length}`
    );
  }
  let value = 0n;
  for (const byte of bytes) value = value * BYTE_RADIX + BigInt(byte);
  const digits: string[] = [];
  for (let index = 0; index < KSUID_TEXT_LENGTH; index++) {
    digits.push(BASE62.charAt(Number(value % BASE62_RADIX)));
    value /= BASE62_RADIX;
  }
  return digits.reverse().join("");
}

/**
 * The 20 bytes a canonical KSUID text names, or `undefined`.
 *
 * Base62 is case-SENSITIVE — `A` and `a` are different digits — so there is no
 * alias to normalize. 27 base62 characters can express more than 2^160 values;
 * one that does names no 20-byte identifier and is refused.
 */
export function ksuidToBytes(text: string): Uint8Array | undefined {
  if (text.length !== KSUID_TEXT_LENGTH) return;
  let value = 0n;
  for (const char of text) {
    const digit = BASE62.indexOf(char);
    if (digit < 0) return;
    value = value * BASE62_RADIX + BigInt(digit);
  }
  if (value >= KSUID_EXCLUSIVE_MAX) return;
  const bytes = new Uint8Array(KSUID_BYTE_LENGTH);
  for (let index = KSUID_BYTE_LENGTH - 1; index >= 0; index--) {
    bytes[index] = Number(value & BYTE_MASK);
    value >>= 8n;
  }
  return bytes;
}
