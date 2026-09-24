// biome-ignore-all lint/suspicious/noBitwiseOperators: Keccak-f[1600] is a bit
// permutation. Every operator below is part of the published specification's
// arithmetic, carried on 32-bit halves because JavaScript has no 64-bit word.

/**
 * SHA3-512, the one hash VibORM computes.
 *
 * FIPS 202's Keccak-f[1600] over 25 lanes of 64 bits, rate 72 bytes, domain
 * padding `0x06 ... 0x80`. One exported function, no streaming, no options, no
 * configuration: the caller hands over the complete message and receives the
 * 64-byte digest.
 *
 * Each 64-bit lane is carried as TWO 32-bit halves rather than a `BigInt`.
 * JavaScript's bitwise operators are 32-bit, so a BigInt lane would allocate a
 * new arbitrary-precision value for every one of the roughly 1,200 operations a
 * single digest performs.
 *
 * Every read goes through a `DataView`, which is the one indexed read this
 * codebase has that is not `T | undefined`: a Keccak round has no in-range
 * check to make and no branch to take, so a fallback on a typed-array read
 * would be a guard whose coverage cannot be named. The halves are stored
 * little-endian at `lane * 8` and `lane * 8 + 4`, which is exactly the lane's
 * own little-endian byte layout — so absorbing a block is a word-wise XOR of
 * the message and squeezing is a copy of the first 64 bytes.
 *
 * The one caller is CUID2 (`@schema/scalars/string/autogenerate`). Nothing else
 * in VibORM may import this module without its own differential proof against a
 * reference implementation.
 */

/** SHA3-512's rate: 1600 - 2*512 bits, as bytes. */
const RATE_BYTES = 72;
/** 512 bits of output. */
const DIGEST_BYTES = 64;
const LANES = 25;
const STATE_BYTES = LANES * 8;
const ROUNDS = 24;
/** SHA-3's domain separation: `01` then the pad10*1 rule's leading bit. */
const DOMAIN_PAD = 0x06;
/** pad10*1's trailing bit, at the top of the block's last byte. */
const FINAL_PAD = 0x80;

/**
 * The iota round constants, low half then high half of each round.
 *
 * Filled through the same little-endian writes every other buffer in this
 * module is filled with. A typed array would lay its bytes out in the HOST's
 * order, which is not what the read at the iota step asks for: the two would
 * agree on a little-endian machine and disagree on every other one.
 */
const ROUND_CONSTANTS = new DataView(new ArrayBuffer(ROUNDS * 8));
for (const [half, constant] of [
  0x00_00_00_01, 0x00_00_00_00, 0x00_00_80_82, 0x00_00_00_00, 0x00_00_80_8a,
  0x80_00_00_00, 0x80_00_80_00, 0x80_00_00_00, 0x00_00_80_8b, 0x00_00_00_00,
  0x80_00_00_01, 0x00_00_00_00, 0x80_00_80_81, 0x80_00_00_00, 0x00_00_80_09,
  0x80_00_00_00, 0x00_00_00_8a, 0x00_00_00_00, 0x00_00_00_88, 0x00_00_00_00,
  0x80_00_80_09, 0x00_00_00_00, 0x80_00_00_0a, 0x00_00_00_00, 0x80_00_80_8b,
  0x00_00_00_00, 0x00_00_00_8b, 0x80_00_00_00, 0x00_00_80_89, 0x80_00_00_00,
  0x00_00_80_03, 0x80_00_00_00, 0x00_00_80_02, 0x80_00_00_00, 0x00_00_00_80,
  0x80_00_00_00, 0x00_00_80_0a, 0x00_00_00_00, 0x80_00_00_0a, 0x80_00_00_00,
  0x80_00_80_81, 0x80_00_00_00, 0x00_00_80_80, 0x80_00_00_00, 0x80_00_00_01,
  0x00_00_00_00, 0x80_00_80_08, 0x80_00_00_00,
].entries()) {
  ROUND_CONSTANTS.setInt32(half * 4, constant, true);
}

/** Rho: the rotation each lane receives, indexed by `x + 5y`. */
const ROTATIONS = new DataView(
  new Uint8Array([
    0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8,
    18, 2, 61, 56, 14,
  ]).buffer
);

/** Pi: where lane `x + 5y` lands, which is `y + 5*((2x + 3y) mod 5)`. */
const DESTINATIONS = new DataView(
  new Uint8Array([
    0, 10, 20, 5, 15, 16, 1, 11, 21, 6, 7, 17, 2, 12, 22, 23, 8, 18, 3, 13, 14,
    24, 9, 19, 4,
  ]).buffer
);

/**
 * The permutation state and its two scratch planes, allocated once.
 *
 * `sha3_512` is synchronous from entry to return and this module has no other
 * caller, so one set of buffers is reused rather than allocating a hundred
 * slots per identifier. Every entry begins by zeroing the state.
 */
const stateBytes = new Uint8Array(STATE_BYTES);
const state = new DataView(stateBytes.buffer);
const plane = new DataView(new ArrayBuffer(STATE_BYTES));
const column = new DataView(new ArrayBuffer(5 * 8));

/**
 * Keccak-f[1600]: 24 rounds of theta, rho + pi, chi and iota.
 *
 * A rotation by `n < 32` takes its missing bits from the other half at
 * `32 - n`; a rotation by `n > 32` is the same shape with the halves swapped
 * and `n - 32`. Neither case is reachable with `n = 0` or `n = 32`, which would
 * need a 32-bit shift JavaScript does not have: rho's only zero is lane 0,
 * which is skipped, and 32 is not one of its offsets.
 */
function permute(): void {
  for (let round = 0; round < ROUNDS; round++) {
    // Theta: each column's parity, folded back into every lane of the column.
    for (let x = 0; x < 5; x++) {
      let low = 0;
      let high = 0;
      for (let y = 0; y < LANES; y += 5) {
        low ^= state.getInt32((x + y) * 8, true);
        high ^= state.getInt32((x + y) * 8 + 4, true);
      }
      column.setInt32(x * 8, low, true);
      column.setInt32(x * 8 + 4, high, true);
    }
    for (let x = 0; x < 5; x++) {
      const nextLow = column.getInt32(((x + 1) % 5) * 8, true);
      const nextHigh = column.getInt32(((x + 1) % 5) * 8 + 4, true);
      const deltaLow =
        column.getInt32(((x + 4) % 5) * 8, true) ^
        ((nextLow << 1) | (nextHigh >>> 31));
      const deltaHigh =
        column.getInt32(((x + 4) % 5) * 8 + 4, true) ^
        ((nextHigh << 1) | (nextLow >>> 31));
      for (let y = 0; y < LANES; y += 5) {
        const at = (x + y) * 8;
        state.setInt32(at, state.getInt32(at, true) ^ deltaLow, true);
        state.setInt32(at + 4, state.getInt32(at + 4, true) ^ deltaHigh, true);
      }
    }

    // Rho and pi: rotate every lane, then move it to its permuted position.
    plane.setInt32(0, state.getInt32(0, true), true);
    plane.setInt32(4, state.getInt32(4, true), true);
    for (let lane = 1; lane < LANES; lane++) {
      const shift = ROTATIONS.getUint8(lane);
      const low = state.getInt32(lane * 8, true);
      const high = state.getInt32(lane * 8 + 4, true);
      const target = DESTINATIONS.getUint8(lane) * 8;
      if (shift < 32) {
        plane.setInt32(target, (low << shift) | (high >>> (32 - shift)), true);
        plane.setInt32(
          target + 4,
          (high << shift) | (low >>> (32 - shift)),
          true
        );
      } else {
        const rest = shift - 32;
        plane.setInt32(target, (high << rest) | (low >>> (32 - rest)), true);
        plane.setInt32(
          target + 4,
          (low << rest) | (high >>> (32 - rest)),
          true
        );
      }
    }

    // Chi: each lane against the next two in its row.
    for (let y = 0; y < LANES; y += 5) {
      for (let x = 0; x < 5; x++) {
        const at = (y + x) * 8;
        const next = (y + ((x + 1) % 5)) * 8;
        const after = (y + ((x + 2) % 5)) * 8;
        state.setInt32(
          at,
          plane.getInt32(at, true) ^
            (~plane.getInt32(next, true) & plane.getInt32(after, true)),
          true
        );
        state.setInt32(
          at + 4,
          plane.getInt32(at + 4, true) ^
            (~plane.getInt32(next + 4, true) & plane.getInt32(after + 4, true)),
          true
        );
      }
    }

    // Iota: the round constant, on the first lane only.
    state.setInt32(
      0,
      state.getInt32(0, true) ^ ROUND_CONSTANTS.getInt32(round * 8, true),
      true
    );
    state.setInt32(
      4,
      state.getInt32(4, true) ^ ROUND_CONSTANTS.getInt32(round * 8 + 4, true),
      true
    );
  }
}

/** Absorb one complete rate-sized block and run the permutation. */
function absorb(block: DataView, offset: number): void {
  for (let at = 0; at < RATE_BYTES; at += 4) {
    state.setInt32(
      at,
      state.getInt32(at, true) ^ block.getInt32(offset + at, true),
      true
    );
  }
  permute();
}

/**
 * The SHA3-512 digest of one complete message.
 *
 * Byte-identical to the reference implementation for every input, which a
 * differential test pins against the NIST known-answer vectors and 10,000
 * random messages crossing every rate boundary.
 */
export function sha3_512(bytes: Uint8Array): Uint8Array {
  stateBytes.fill(0);

  const length = bytes.length;
  const message = new DataView(bytes.buffer, bytes.byteOffset, length);
  const wholeBlocks = Math.floor(length / RATE_BYTES);
  for (let block = 0; block < wholeBlocks; block++) {
    absorb(message, block * RATE_BYTES);
  }

  // The final block is the message tail plus pad10*1. A tail of exactly
  // `RATE_BYTES - 1` puts both pad bits in the same byte, which is the rule
  // rather than a special case.
  const tail = new Uint8Array(RATE_BYTES);
  const tailLength = length - wholeBlocks * RATE_BYTES;
  tail.set(bytes.subarray(wholeBlocks * RATE_BYTES));
  tail[tailLength] = DOMAIN_PAD;
  tail[RATE_BYTES - 1] =
    tailLength === RATE_BYTES - 1 ? DOMAIN_PAD | FINAL_PAD : FINAL_PAD;
  absorb(new DataView(tail.buffer), 0);

  // 512 bits is narrower than the rate, so one squeeze with no further
  // permutation is the whole digest — and the halves are already stored in the
  // little-endian order the digest is written in.
  return Uint8Array.from(stateBytes.subarray(0, DIGEST_BYTES));
}
