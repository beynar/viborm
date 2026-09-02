/**
 * A tiny seeded PRNG for the payload generator (unit B).
 *
 * mulberry32: 32-bit state, one multiply-xorshift round per draw, no
 * dependency. The same seed always yields the same draw sequence, which is what
 * makes a generated corpus reproducible and a shrunk counter-example
 * re-runnable from its seed alone.
 */
export interface Rng {
  /** Uniform float in [0, 1). */
  readonly next: () => number;
  /** Uniform integer in [0, maxExclusive). `maxExclusive <= 0` yields 0. */
  readonly int: (maxExclusive: number) => number;
  /** One element, uniformly. Throws on an empty list. */
  readonly pick: <T>(items: readonly T[]) => T;
  /** `true` with the given probability. */
  readonly chance: (probability: number) => boolean;
  /** A shuffled copy (Fisher–Yates), leaving the input untouched. */
  readonly shuffle: <T>(items: readonly T[]) => T[];
}

const TWO_POW_32 = 4_294_967_296;

export function mulberry32(seed: number): Rng {
  // biome-ignore lint/suspicious/noBitwiseOperators: 32-bit PRNG arithmetic
  let state = seed >>> 0;
  const next = (): number => {
    // biome-ignore lint/suspicious/noBitwiseOperators: 32-bit PRNG arithmetic
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let t = state;
    // biome-ignore lint/suspicious/noBitwiseOperators: 32-bit PRNG arithmetic
    t = Math.imul(t ^ (t >>> 15), t | 1);
    // biome-ignore lint/suspicious/noBitwiseOperators: 32-bit PRNG arithmetic
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    // biome-ignore lint/suspicious/noBitwiseOperators: 32-bit PRNG arithmetic
    return ((t ^ (t >>> 14)) >>> 0) / TWO_POW_32;
  };
  const int = (maxExclusive: number): number =>
    maxExclusive <= 0 ? 0 : Math.floor(next() * maxExclusive);
  const pick = <T>(items: readonly T[]): T => {
    if (items.length === 0) {
      throw new Error("Rng.pick: cannot pick from an empty list");
    }
    return items[int(items.length)]!;
  };
  const chance = (probability: number): boolean => next() < probability;
  const shuffle = <T>(items: readonly T[]): T[] => {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = int(i + 1);
      const swap = copy[i]!;
      copy[i] = copy[j]!;
      copy[j] = swap;
    }
    return copy;
  };
  return { next, int, pick, chance, shuffle };
}

/**
 * Derive the seed of corpus member `index` from the corpus seed. A hash rather
 * than `seed + index`, so neighbouring members do not share a draw prefix.
 */
export function deriveSeed(seed: number, index: number): number {
  // biome-ignore lint/suspicious/noBitwiseOperators: integer hash mixing
  let h = (seed ^ Math.imul(index + 1, 0x9e_37_79_b9)) >>> 0;
  // biome-ignore lint/suspicious/noBitwiseOperators: integer hash mixing
  h = Math.imul(h ^ (h >>> 16), 0x85_eb_ca_6b) >>> 0;
  // biome-ignore lint/suspicious/noBitwiseOperators: integer hash mixing
  h = Math.imul(h ^ (h >>> 13), 0xc2_b2_ae_35) >>> 0;
  // biome-ignore lint/suspicious/noBitwiseOperators: integer hash mixing
  return (h ^ (h >>> 16)) >>> 0;
}
