// biome-ignore-all lint/suspicious/noBitwiseOperators: SHA-256 is 32-bit word
// arithmetic. Every operator below is part of FIPS 180-4's definition.

/**
 * SHA-256, the hash Migration V1 identity is defined over.
 *
 * FIPS 180-4: 64-byte blocks, a 64-word message schedule, 64 rounds, a 64-bit
 * big-endian bit length after the `0x80` pad. One exported function, no
 * streaming, no options: the caller hands over the complete message and
 * receives the 32-byte digest.
 *
 * It is synchronous on purpose. WebCrypto's `digest` is the platform hash on
 * every runtime, but it returns a promise, and every content-addressed parser
 * in the migration engine hashes inline; `node:crypto` is synchronous but is
 * not on an edge runtime without a compatibility flag.
 *
 * Every word is read and written through a `DataView` that names big-endian,
 * the byte order the standard is written in, so the host's byte order never
 * enters a digest; it is also the one indexed read in this codebase that is not
 * `T | undefined`, as in the SHA3-512 precedent (`./sha3`).
 *
 * The one caller is `migrations/identity`. Nothing else in VibORM may import
 * this module without its own differential proof against a reference.
 */

const BLOCK_BYTES = 64;
const DIGEST_BYTES = 32;
const ROUNDS = 64;
/** A tail of more than this many bytes leaves no room for the pad and length. */
const LAST_BLOCK_ROOM = BLOCK_BYTES - 9;
const WORD_SPAN = 2 ** 32;

const words = (values: readonly number[]): DataView => {
  const view = new DataView(new ArrayBuffer(values.length * 4));
  for (const [index, value] of values.entries()) {
    view.setUint32(index * 4, value);
  }
  return view;
};

/** The first 32 bits of the fractional parts of the first 64 primes' cube roots. */
const ROUND_CONSTANTS = words([
  0x42_8a_2f_98, 0x71_37_44_91, 0xb5_c0_fb_cf, 0xe9_b5_db_a5, 0x39_56_c2_5b,
  0x59_f1_11_f1, 0x92_3f_82_a4, 0xab_1c_5e_d5, 0xd8_07_aa_98, 0x12_83_5b_01,
  0x24_31_85_be, 0x55_0c_7d_c3, 0x72_be_5d_74, 0x80_de_b1_fe, 0x9b_dc_06_a7,
  0xc1_9b_f1_74, 0xe4_9b_69_c1, 0xef_be_47_86, 0x0f_c1_9d_c6, 0x24_0c_a1_cc,
  0x2d_e9_2c_6f, 0x4a_74_84_aa, 0x5c_b0_a9_dc, 0x76_f9_88_da, 0x98_3e_51_52,
  0xa8_31_c6_6d, 0xb0_03_27_c8, 0xbf_59_7f_c7, 0xc6_e0_0b_f3, 0xd5_a7_91_47,
  0x06_ca_63_51, 0x14_29_29_67, 0x27_b7_0a_85, 0x2e_1b_21_38, 0x4d_2c_6d_fc,
  0x53_38_0d_13, 0x65_0a_73_54, 0x76_6a_0a_bb, 0x81_c2_c9_2e, 0x92_72_2c_85,
  0xa2_bf_e8_a1, 0xa8_1a_66_4b, 0xc2_4b_8b_70, 0xc7_6c_51_a3, 0xd1_92_e8_19,
  0xd6_99_06_24, 0xf4_0e_35_85, 0x10_6a_a0_70, 0x19_a4_c1_16, 0x1e_37_6c_08,
  0x27_48_77_4c, 0x34_b0_bc_b5, 0x39_1c_0c_b3, 0x4e_d8_aa_4a, 0x5b_9c_ca_4f,
  0x68_2e_6f_f3, 0x74_8f_82_ee, 0x78_a5_63_6f, 0x84_c8_78_14, 0x8c_c7_02_08,
  0x90_be_ff_fa, 0xa4_50_6c_eb, 0xbe_f9_a3_f7, 0xc6_71_78_f2,
]);

/** The first 32 bits of the fractional parts of the first 8 primes' square roots. */
const INITIAL_HASH = new Uint8Array(
  words([
    0x6a_09_e6_67, 0xbb_67_ae_85, 0x3c_6e_f3_72, 0xa5_4f_f5_3a, 0x51_0e_52_7f,
    0x9b_05_68_8c, 0x1f_83_d9_ab, 0x5b_e0_cd_19,
  ]).buffer
);

/**
 * The running hash and the message schedule, allocated once: `sha256` is
 * synchronous from entry to return, and every entry begins by resetting the
 * hash to its initial value.
 */
const hashBytes = new Uint8Array(DIGEST_BYTES);
const hash = new DataView(hashBytes.buffer);
const schedule = new DataView(new ArrayBuffer(ROUNDS * 4));

const rotate = (word: number, bits: number): number =>
  (word >>> bits) | (word << (32 - bits));

/** Folds one working variable back into the running hash. */
const fold = (at: number, word: number): void => {
  hash.setInt32(at, (hash.getInt32(at) + word) | 0);
};

/** The compression function over the 64 bytes of `block` at `offset`. */
function compress(block: DataView, offset: number): void {
  for (let t = 0; t < 16; t++) {
    schedule.setInt32(t * 4, block.getInt32(offset + t * 4));
  }
  for (let t = 16; t < ROUNDS; t++) {
    const early = schedule.getInt32((t - 15) * 4);
    const late = schedule.getInt32((t - 2) * 4);
    const sigma0 = rotate(early, 7) ^ rotate(early, 18) ^ (early >>> 3);
    const sigma1 = rotate(late, 17) ^ rotate(late, 19) ^ (late >>> 10);
    schedule.setInt32(
      t * 4,
      (sigma1 +
        schedule.getInt32((t - 7) * 4) +
        sigma0 +
        schedule.getInt32((t - 16) * 4)) |
        0
    );
  }

  let a = hash.getInt32(0);
  let b = hash.getInt32(4);
  let c = hash.getInt32(8);
  let d = hash.getInt32(12);
  let e = hash.getInt32(16);
  let f = hash.getInt32(20);
  let g = hash.getInt32(24);
  let h = hash.getInt32(28);
  for (let t = 0; t < ROUNDS; t++) {
    const sum1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
    const choose = (e & f) ^ (~e & g);
    const first =
      (h +
        sum1 +
        choose +
        ROUND_CONSTANTS.getInt32(t * 4) +
        schedule.getInt32(t * 4)) |
      0;
    const sum0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
    const majority = (a & b) ^ (a & c) ^ (b & c);
    h = g;
    g = f;
    f = e;
    e = (d + first) | 0;
    d = c;
    c = b;
    b = a;
    a = (first + sum0 + majority) | 0;
  }
  fold(0, a);
  fold(4, b);
  fold(8, c);
  fold(12, d);
  fold(16, e);
  fold(20, f);
  fold(24, g);
  fold(28, h);
}

/**
 * The SHA-256 digest of one complete message.
 *
 * Byte-identical to `node:crypto` for every input, which a differential test
 * pins against the FIPS 180-4 known-answer vectors and 10,000 random messages
 * crossing every block and padding boundary.
 */
export function sha256(bytes: Uint8Array): Uint8Array {
  hashBytes.set(INITIAL_HASH);

  const length = bytes.length;
  const message = new DataView(bytes.buffer, bytes.byteOffset, length);
  const wholeBlocks = Math.floor(length / BLOCK_BYTES);
  for (let block = 0; block < wholeBlocks; block++) {
    compress(message, block * BLOCK_BYTES);
  }

  // The tail, `0x80`, zeros, then the bit length as a 64-bit big-endian word:
  // one block, or two when the tail leaves fewer than nine bytes free.
  const tailLength = length - wholeBlocks * BLOCK_BYTES;
  const tail = new Uint8Array(
    tailLength > LAST_BLOCK_ROOM ? 2 * BLOCK_BYTES : BLOCK_BYTES
  );
  tail.set(bytes.subarray(wholeBlocks * BLOCK_BYTES));
  tail[tailLength] = 0x80;
  const padded = new DataView(tail.buffer);
  const bits = length * 8;
  padded.setUint32(tail.length - 8, Math.floor(bits / WORD_SPAN));
  padded.setUint32(tail.length - 4, bits % WORD_SPAN);
  for (let at = 0; at < tail.length; at += BLOCK_BYTES) {
    compress(padded, at);
  }

  return Uint8Array.from(hashBytes);
}
