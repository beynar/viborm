// biome-ignore-all lint/suspicious/noBitwiseOperators: the seeded xorshift and
// the byte fill below are bit layouts, the same reason the module under test
// carries the suppression.

import { createHash } from "node:crypto";
import { sha256 } from "@validation/primitives/sha256";
import { describe, expect, test } from "vitest";

/**
 * The in-house SHA-256 against `node:crypto`.
 *
 * Migration V1 identity was `node:crypto`'s SHA-256 until `viborm/migrations`
 * had to load on an edge runtime without Node builtins. Every published estate
 * is addressed by those digests, so the replacement is admissible only while
 * the reference and the published known-answer vectors agree with it byte for
 * byte.
 *
 *   A. The FIPS 180-4 / NIST known-answer vectors, which depend on no other
 *      implementation.
 *   B. 10,000 pseudorandom messages of 0 to 2,000 bytes plus every block and
 *      padding boundary, against `node:crypto`. A tail of 55 bytes is the
 *      last that fits the pad and length in one block; 56 needs a second.
 */

const encoder = new TextEncoder();
const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const reference = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const KNOWN_ANSWERS: ReadonlyArray<readonly [string, string]> = [
  ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
  [
    "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  ],
  [
    "abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmn" +
      "hijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu",
    "cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1",
  ],
];

const MILLION_A_DIGEST =
  "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0";

/** A seeded xorshift: a failing sample must be reproducible from the seed. */
const pseudorandom = (seed: number): (() => number) => {
  let state = seed | 0;
  return () => {
    state ^= state << 13;
    state |= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state |= 0;
    return (state >>> 0) / 0x1_00_00_00_00;
  };
};

describe("sha-256", () => {
  test("matches every published known-answer vector", () => {
    for (const [message, digest] of KNOWN_ANSWERS) {
      expect(hex(sha256(encoder.encode(message)))).toBe(digest);
    }
  });

  test("matches the million-character known-answer vector", () => {
    const message = new Uint8Array(1_000_000).fill(0x61);
    expect(hex(sha256(message))).toBe(MILLION_A_DIGEST);
  });

  test("matches node:crypto on 10,000 random messages", () => {
    const random = pseudorandom(0x6a_09_e6_67);
    for (let sample = 0; sample < 10_000; sample++) {
      const length = Math.floor(random() * 2001);
      const message = new Uint8Array(length);
      for (let index = 0; index < length; index++) {
        message[index] = Math.floor(random() * 256);
      }
      if (hex(sha256(message)) !== reference(message)) {
        // Named rather than asserted per sample: the length is what makes a
        // failure reproducible, and 10,000 expectations are reporter noise.
        throw new Error(
          `sha256 disagrees with node:crypto at sample ${sample}, length ${length}`
        );
      }
    }
  }, 120_000);

  test("matches node:crypto at every block and padding boundary", () => {
    for (const length of [
      0, 1, 54, 55, 56, 57, 63, 64, 65, 118, 119, 120, 121, 127, 128, 129, 192,
    ]) {
      const message = new Uint8Array(length);
      for (let index = 0; index < length; index++) {
        message[index] = (index * 31 + 7) & 0xff;
      }
      expect(hex(sha256(message))).toBe(reference(message));
    }
  });

  test("hashes a view at its own offset and a multi-megabyte message", () => {
    // A subarray shares its parent's buffer: the digest must read from the
    // view's offset, never from the buffer's start.
    const parent = new Uint8Array(6_000_003);
    for (let index = 0; index < parent.length; index++) {
      parent[index] = (index * 131 + 17) & 0xff;
    }
    const view = parent.subarray(3);
    expect(hex(sha256(view))).toBe(reference(view));
  });

  test("keeps no state between digests and does not touch its input", () => {
    const first = hex(sha256(encoder.encode("abc")));
    sha256(new Uint8Array(500).fill(0xff));
    expect(hex(sha256(encoder.encode("abc")))).toBe(first);

    const message = encoder.encode("abc");
    const copy = Uint8Array.from(message);
    sha256(message);
    expect(Array.from(message)).toEqual(Array.from(copy));
  });

  test("returns 32 fresh bytes", () => {
    const digest = sha256(encoder.encode("abc"));
    expect(digest).toBeInstanceOf(Uint8Array);
    expect(digest.length).toBe(32);
    expect(sha256(encoder.encode("abc"))).not.toBe(digest);
  });
});
