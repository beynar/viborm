// biome-ignore-all lint/suspicious/noBitwiseOperators: NanoID selects a
// character with `byte & 63`, the ULID counter carries a byte at a time, and
// CUID2's digest is read as one big-endian integer. All three are bit layouts.

/**
 * The six identifier generators a string scalar can declare.
 *
 * Each `default*` function is the DECLARATION: it validates what the modifier
 * was spelled with and returns the closure the scalar stores as its default.
 * The closure is what runs per row, synchronously, inside the field's own
 * create schema — so nothing here may be asynchronous, and nothing here may
 * draw entropy before it is called.
 *
 * The byte layouts, alphabets, widths and the one entropy source live in
 * `@validation/primitives/id-formats`, where the storage codec can read them
 * without pulling a scalar class. This module owns only what a GENERATOR adds
 * to a format: the clock it reads, the state it keeps between calls, and the
 * prefix it puts in front of the payload.
 */

import { sha3_512 } from "@noble/hashes/sha3.js";
import {
  applyIdPrefix,
  bytesToKsuid,
  bytesToUlid,
  bytesToUuid,
  KSUID_PAYLOAD_LENGTH,
  ksuidBytes,
  MAX_RANDOM_BYTES,
  NANOID_ALPHABET,
  NANOID_DEFAULT_LENGTH,
  randomBytes,
  refuseId,
  ULID_RANDOM_LENGTH,
  UUID_BYTE_LENGTH,
  UUIDV7_RANDOM_LENGTH,
  ulidBytes,
  uuidV4Bytes,
  uuidV7Bytes,
} from "@validation/primitives/id-formats";

const MILLISECONDS_PER_SECOND = 1000;

// =============================================================================
// UUID
// =============================================================================

/**
 * A UUIDv4.
 *
 * `crypto.randomUUID()` when the runtime has it — it is the platform's own
 * implementation of exactly this format, and it is measurably faster than
 * drawing bytes and tagging them. The manual path is not a fallback to a weaker
 * value: it is the same 122 random bits with the same version and variant, from
 * the same entropy source, for runtimes that expose `getRandomValues` without
 * `randomUUID`.
 */
function uuidV4(): string {
  const source = globalThis.crypto;
  if (typeof source?.randomUUID === "function") return source.randomUUID();
  return bytesToUuid(uuidV4Bytes(randomBytes(UUID_BYTE_LENGTH, "uuid")));
}

export const defaultUuid = (prefix?: string) => () =>
  applyIdPrefix(prefix, uuidV4());

export const defaultUuidV7 = (prefix?: string) => () =>
  applyIdPrefix(
    prefix,
    bytesToUuid(
      uuidV7Bytes(Date.now(), randomBytes(UUIDV7_RANDOM_LENGTH, "uuidv7"))
    )
  );

// =============================================================================
// ULID
// =============================================================================

/** The next 80-bit random block, or a refusal when the block is exhausted. */
function incrementUlidRandom(random: Uint8Array): Uint8Array {
  const next = Uint8Array.from(random);
  const view = new DataView(next.buffer);
  for (let index = next.length - 1; index >= 0; index--) {
    const incremented = view.getUint8(index) + 1;
    view.setUint8(index, incremented & 255);
    if (incremented <= 255) return next;
  }
  return refuseId(
    "s.string().ulid",
    "generate",
    "This process issued every ULID one millisecond can hold (2^80). Monotonicity cannot be preserved without emitting a smaller identifier"
  );
}

/**
 * One monotonic ULID sequence.
 *
 * Within a millisecond the timestamp repeats, so the 80-bit random block is
 * INCREMENTED instead of redrawn: two ULIDs minted in the same millisecond
 * still sort in the order they were issued. A clock that moves backwards keeps
 * emitting the last timestamp for the same reason — a smaller identifier would
 * break the ordering the format promises, and the ORM cannot fix the clock.
 *
 * The whole block is drawn at once from secure bytes, so every bit is uniform.
 *
 * `now` and `random` are injectable because monotonicity, rollback and
 * exhaustion are statements about a SEQUENCE, and a sequence cannot be observed
 * through a real clock. The process-wide generator below takes the defaults.
 */
export function createUlidGenerator(
  options: { now?: () => number; random?: (length: number) => Uint8Array } = {}
): () => string {
  const now = options.now ?? Date.now;
  const draw = options.random ?? ((length) => randomBytes(length, "ulid"));
  let last: { time: number; random: Uint8Array } | undefined;
  return () => {
    const time = now();
    last =
      last !== undefined && time <= last.time
        ? { time: last.time, random: incrementUlidRandom(last.random) }
        : { time, random: draw(ULID_RANDOM_LENGTH) };
    return bytesToUlid(ulidBytes(last.time, last.random));
  };
}

/**
 * ONE monotonic sequence per process, shared by every `.ulid()` and `.id()`
 * field. Monotonicity is a property of the issuing process, not of a field: two
 * models minting ULIDs in the same millisecond must not collide, and a
 * per-field sequence would let them.
 */
const nextUlid = createUlidGenerator();

export const defaultUlid = (prefix?: string) => () =>
  applyIdPrefix(prefix, nextUlid());

// =============================================================================
// KSUID
// =============================================================================

export const defaultKsuid = (prefix?: string) => () =>
  applyIdPrefix(
    prefix,
    bytesToKsuid(
      ksuidBytes(
        Math.floor(Date.now() / MILLISECONDS_PER_SECOND),
        randomBytes(KSUID_PAYLOAD_LENGTH, "ksuid")
      )
    )
  );

// =============================================================================
// NANOID
// =============================================================================

/**
 * The lengths a nanoid can have, refused where the length is spelled.
 *
 * One character costs one byte of entropy, so the upper bound is the entropy
 * source's own per-call quota: asking for more used to declare cleanly and then
 * throw a raw `QuotaExceededError` from inside the closure, at row-create time,
 * for every row.
 */
export const defaultNanoid = (length?: number, prefix?: string) => {
  const size = length ?? NANOID_DEFAULT_LENGTH;
  if (!Number.isInteger(size) || size < 1 || size > MAX_RANDOM_BYTES) {
    refuseId(
      "s.string().nanoid",
      "length",
      `A nanoid length must be a whole number of characters between 1 and ${MAX_RANDOM_BYTES}; received ${size}`
    );
  }
  return () => {
    let id = "";
    for (const byte of randomBytes(size, "nanoid")) {
      id += NANOID_ALPHABET.charAt(byte & 63);
    }
    return applyIdPrefix(prefix, id);
  };
};

// =============================================================================
// CUID2
// =============================================================================

/*
 * The CUID2 construction below is a port of @paralleldrive/cuid2 3.3.0, kept
 * byte-identical to it so that identifiers minted by VibORM and identifiers
 * minted by the upstream package belong to the same space. What changed is the
 * arithmetic (native `BigInt` in place of bignumber.js), the entropy source
 * (secure bytes only, never `Math.random()`), and the fingerprint's global
 * object (`globalThis`, which every supported runtime has). A differential test
 * pins the rest against the upstream package.
 *
 * MIT License
 *
 * Copyright (c) 2022 Eric Elliott
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

const CUID_DEFAULT_LENGTH = 24;
const CUID_BIG_LENGTH = 32;
const CUID_ALPHABET_SIZE = 26;
const BASE36 = 36;
/** ~22k hosts before a 50% chance of an initial counter collision (upstream). */
const CUID_INITIAL_COUNT_MAX = 476_782_367;

const TEXT_ENCODER = new TextEncoder();
const LOWERCASE_LETTERS = "abcdefghijklmnopqrstuvwxyz";

/** A float in `[0, 1)` from four secure bytes, read as one 32-bit word. */
function secureFloat(): number {
  const bytes = randomBytes(4, "cuid");
  const word = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return word.getUint32(0, true) / 0x1_00_00_00_00;
}

function createEntropy(length: number, random: () => number): string {
  let entropy = "";
  while (entropy.length < length) {
    entropy += Math.floor(random() * BASE36).toString(BASE36);
  }
  return entropy;
}

/**
 * SHA3-512 of `input`, rendered in base36 with the first digit dropped — that
 * digit is biased toward the low end of the alphabet because the digest is not
 * a whole number of base36 digits.
 */
function hashBase36(input: string): string {
  let value = 0n;
  for (const byte of sha3_512(TEXT_ENCODER.encode(input))) {
    value = (value << 8n) | BigInt(byte);
  }
  return value.toString(BASE36).slice(1);
}

/**
 * A fingerprint of the host environment, mixed into every id so that two
 * processes minting ids at the same millisecond with the same counter still
 * disagree.
 */
function createFingerprint(random: () => number): string {
  const globals = Object.keys(globalThis).toString();
  const entropy = createEntropy(CUID_BIG_LENGTH, random);
  // Upstream writes `globals.length > 0 ? globals + entropy : entropy`. The two
  // arms are the same string — concatenating an empty `globals` IS `entropy` —
  // so the condition names no case, and a branch whose unique coverage cannot
  // be stated is one this codebase does not keep. The digest is unchanged,
  // which the differential test against the pinned upstream package proves.
  return hashBase36(globals + entropy).substring(0, CUID_BIG_LENGTH);
}

/**
 * One CUID2 sequence.
 *
 * Everything upstream lets a caller replace is replaceable here for the same
 * reason: the fingerprint, counter and random source are the parts that make
 * two processes differ, and a test that cannot fix them cannot compare two
 * implementations at all. `length` is replaceable for the same reason — the
 * salt is as long as the id, so a differential test that only ever saw 24
 * characters would compare one input shape.
 *
 * No length is spellable in a schema: `.cuid(prefix?)` takes none and always
 * mints the published 24, and a schema document that declares one is refused by
 * the reader (J007). The construction therefore states no bound of its own.
 */
export function createCuid2(
  options: {
    random?: () => number;
    counter?: () => number;
    length?: number;
    fingerprint?: string;
  } = {}
): () => string {
  const random = options.random ?? secureFloat;
  const counter =
    options.counter ??
    createCounter(Math.floor(random() * CUID_INITIAL_COUNT_MAX));
  const length = options.length ?? CUID_DEFAULT_LENGTH;
  const fingerprint = options.fingerprint ?? createFingerprint(random);
  return () => {
    const firstLetter = LOWERCASE_LETTERS.charAt(
      Math.floor(random() * CUID_ALPHABET_SIZE)
    );
    const time = Date.now().toString(BASE36);
    const count = counter().toString(BASE36);
    const salt = createEntropy(length, random);
    return (
      firstLetter +
      hashBase36(time + salt + count + fingerprint).substring(1, length)
    );
  };
}

function createCounter(start: number): () => number {
  let count = start;
  return () => {
    const current = count;
    count++;
    return current;
  };
}

/**
 * The process-wide CUID2 sequence, built on first use.
 *
 * Lazily, because the fingerprint hashes 32 characters of entropy: building it
 * at import would draw randomness from every process that merely loads VibORM,
 * including ones that never mint an id.
 */
let processCuid: (() => string) | undefined;

export const defaultCuid = (prefix?: string) => () =>
  applyIdPrefix(prefix, (processCuid ??= createCuid2())());
