// biome-ignore-all lint/suspicious/noBitwiseOperators: the seeded
// xorshift and the byte fill below are bit layouts, the same reason the
// module under test carries the suppression.

import { sha3_512 as referenceSha3_512 } from "@noble/hashes/sha3.js";
import { sha3_512 } from "@validation/primitives/sha3";
import { describe, expect, test } from "vitest";

/**
 * The in-house SHA3-512 against the reference implementation.
 *
 * VibORM computes its own Keccak so that the published package carries no hash
 * dependency. `@noble/hashes` stays installed as a DEVELOPMENT dependency for
 * exactly this file: a hash VibORM writes itself is admissible only while a
 * reference implementation and the published known-answer vectors both agree
 * with it byte for byte.
 *
 * Two arms, and neither is a sample of the other:
 *
 *   A. The NIST SHA3-512 known-answer vectors, which are the published
 *      definition of the function and depend on no other implementation.
 *   B. 10,000 pseudorandom messages of 0 to 2,000 bytes plus every rate
 *      boundary, against `@noble/hashes`. The lengths cross 72, 144 and 216
 *      bytes, where the absorb loop changes shape and pad10*1 collapses into a
 *      single byte.
 */

const encoder = new TextEncoder();
const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * NIST's published SHA3-512 known-answer vectors: the empty message, `abc`,
 * the 448-bit message, the 896-bit message, and the million-`a` message.
 */
const KNOWN_ANSWERS: ReadonlyArray<readonly [string, string]> = [
  [
    "",
    "a69f73cca23a9ac5c8b567dc185a756e97c982164fe25859e0d1dcc1475c80a6" +
      "15b2123af1f5f94c11e3e9402c3ac558f500199d95b6d3e301758586281dcd26",
  ],
  [
    "abc",
    "b751850b1a57168a5693cd924b6b096e08f621827444f70d884f5d0240d2712e" +
      "10e116e9192af3c91a7ec57647e3934057340b4cf408d5a56592f8274eec53f0",
  ],
  [
    "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
    "04a371e84ecfb5b8b77cb48610fca8182dd457ce6f326a0fd3d7ec2f1e91636d" +
      "ee691fbe0c985302ba1b0d8dc78c086346b533b49c030d99a27daf1139d6e75e",
  ],
  [
    "abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmn" +
      "hijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu",
    "afebb2ef542e6579c50cad06d2e578f9f8dd6881d7dc824d26360feebf18a4fa" +
      "73e3261122948efcfd492e74e82e2189ed0fb440d187f382270cb455f21dd185",
  ],
];

const MILLION_A_DIGEST =
  "3c3a876da14034ab60627c077bb98f7e120a2a5370212dffb3385a18d4f38859" +
  "ed311d0a9d5141ce9cc5c66ee689b266a8aa18ace8282a0e0db596c90b0a7b87";

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

describe("sha3-512", () => {
  test("matches every published known-answer vector", () => {
    for (const [message, digest] of KNOWN_ANSWERS) {
      expect(hex(sha3_512(encoder.encode(message)))).toBe(digest);
    }
  });

  test("matches the million-character known-answer vector", () => {
    // 1,000,000 bytes is 13,888 whole blocks and a partial one: the only
    // vector that exercises the absorb loop at length.
    const message = new Uint8Array(1_000_000).fill(0x61);
    expect(hex(sha3_512(message))).toBe(MILLION_A_DIGEST);
  });

  test("matches the reference implementation on 10,000 random messages", () => {
    const random = pseudorandom(0x9e_37_79_b9);
    for (let sample = 0; sample < 10_000; sample++) {
      const length = Math.floor(random() * 2001);
      const message = new Uint8Array(length);
      for (let index = 0; index < length; index++) {
        message[index] = Math.floor(random() * 256);
      }
      const produced = hex(sha3_512(message));
      if (produced !== hex(referenceSha3_512(message))) {
        // Named rather than asserted per sample: 10,000 passing expectations
        // would be 10,000 lines of reporter output, and the length is what
        // makes a failure reproducible.
        throw new Error(
          `sha3_512 disagrees with the reference at sample ${sample}, length ${length}`
        );
      }
    }
  });

  test("matches the reference implementation at every rate boundary", () => {
    // 72 bytes is the rate. A message of exactly `rate - 1` puts both pad10*1
    // bits in one byte; a multiple of the rate appends a whole padding block.
    for (const length of [
      0, 1, 2, 71, 72, 73, 143, 144, 145, 215, 216, 217, 287, 288, 289,
    ]) {
      const message = new Uint8Array(length);
      for (let index = 0; index < length; index++) {
        message[index] = (index * 31 + 7) & 0xff;
      }
      expect(hex(sha3_512(message))).toBe(hex(referenceSha3_512(message)));
    }
  });

  test("keeps no state between digests and does not touch its input", () => {
    // The permutation state is one reused buffer, so a digest that did not
    // zero it would depend on whatever was hashed before it.
    const first = hex(sha3_512(encoder.encode("abc")));
    sha3_512(new Uint8Array(500).fill(0xff));
    expect(hex(sha3_512(encoder.encode("abc")))).toBe(first);

    const message = encoder.encode("abc");
    const copy = Uint8Array.from(message);
    sha3_512(message);
    expect(Array.from(message)).toEqual(Array.from(copy));
  });

  test("returns 64 fresh bytes", () => {
    const digest = sha3_512(encoder.encode("abc"));
    expect(digest).toBeInstanceOf(Uint8Array);
    expect(digest.length).toBe(64);
    expect(sha3_512(encoder.encode("abc"))).not.toBe(digest);
  });
});
