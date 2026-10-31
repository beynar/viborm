// viborm/ordering keys: decimal fractional keys.
//
// A key is a string of the digits 0-9: an integer part that carries its own
// length, then an optional fraction with no trailing zero. Comparing two keys
// as strings compares their values, under any collation that orders digits
// as digits: digits are the one alphabet no locale tailors (base 36 breaks
// under Czech `ch` or Danish `aa`; measured on 89 ICU locales). The only
// exception is a collation with numeric ordering (ICU `kn-true`).
//
// Integer part, for a value v:
// - v >= 0: one digit L (1-9) giving the number of digits of v, then v
//   ("10" is 0, "15" is 5, "210" is 10). Appends increment it, so n appends
//   cost O(log n) digits.
// - v < 0, with j = -v of L digits: "0", then 9 - L, then 10^L - j on L
//   digits ("089" is -1, "081" is -9, "0790" is -10). Prepends decrement it.
// The head fixes the length of the integer part, so two integer parts never
// share a prefix, and a longer negative sorts first.
//
// The append computed by SQL inside an INSERT (`append.ts`) builds exactly
// `appendKey`'s integer: max(v, -1) + 1. A key never decides anything by
// randomness: the random fraction only spreads concurrent writers apart.

/** The longest key accepted, generated or given. */
export const MAX_KEY_LENGTH = 64;

/** Random positions a generated key is drawn from: two writers placing into
 * one gap at once collide (tie) with probability 1 / RANDOM_SPAN. */
const RANDOM_SPAN = 1_000_000n;
const RANDOM_DIGITS = 6;
const MAX_INTEGER_DIGITS = 9;

const DIGITS = /^\d+$/;
const TEN = 10n;

/** The integer part of a key, and its fraction; undefined if not a key. */
function split(key: string): { integer: string; fraction: string } | undefined {
  if (key.length < 2 || !DIGITS.test(key)) return undefined;
  let integer: string;
  if (key[0] === "0") {
    const length = 9 - Number(key[1]);
    if (length < 1) return undefined;
    integer = key.slice(0, 2 + length);
    if (integer.length !== 2 + length) return undefined;
    const body = BigInt(integer.slice(2));
    if (body < 1n || body > 9n * TEN ** BigInt(length - 1)) return undefined;
  } else {
    const length = Number(key[0]);
    integer = key.slice(0, 1 + length);
    if (integer.length !== 1 + length) return undefined;
    if (length > 1 && integer[1] === "0") return undefined;
  }
  const fraction = key.slice(integer.length);
  if (fraction.endsWith("0")) return undefined;
  return { integer, fraction };
}

/** Whether `value` is a key: the grammar above, at most MAX_KEY_LENGTH. */
export function isKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_KEY_LENGTH &&
    split(value) !== undefined
  );
}

function parse(key: string): { value: bigint; fraction: string } {
  const parts = split(key);
  if (parts === undefined) throw new RangeError(`"${key}" is not a key`);
  const { integer, fraction } = parts;
  const value =
    integer[0] === "0"
      ? BigInt(integer.slice(2)) - TEN ** BigInt(integer.length - 2)
      : BigInt(integer.slice(1));
  return { value, fraction };
}

/** The integer part encoding `value`. */
function encode(value: bigint): string {
  if (value >= 0n) {
    const digits = value.toString();
    if (digits.length > MAX_INTEGER_DIGITS) {
      throw new RangeError("a list holds at most 10^9 appends");
    }
    return `${digits.length}${digits}`;
  }
  const digits = (-value).toString();
  if (digits.length > MAX_INTEGER_DIGITS) {
    throw new RangeError("a list holds at most 10^9 prepends");
  }
  const body = (TEN ** BigInt(digits.length) + value).toString();
  return `0${9 - digits.length}${body.padStart(digits.length, "0")}`;
}

/** A uniform random bigint in [0, span). */
function random(span: bigint): bigint {
  const digits = span.toString().length + 6;
  const bytes = new Uint8Array(digits);
  crypto.getRandomValues(bytes);
  let drawn = 0n;
  for (const byte of bytes) drawn = drawn * TEN + BigInt(byte % 10);
  return drawn % span;
}

/** A random fraction of RANDOM_DIGITS digits, trailing zeros removed: what
 * the SQL append adds after its integer. */
function randomFraction(): string {
  return random(RANDOM_SPAN)
    .toString()
    .padStart(RANDOM_DIGITS, "0")
    .replace(/0+$/, "");
}

/**
 * `count` fractions strictly between `lower` and `upper` (digit strings read
 * as 0.lower and 0.upper; `upper` undefined is 1), in order. The gap is cut
 * into count + 1 equal slots; key i is drawn from the middle third of the
 * boundary between slots i and i + 1, at a precision where that third holds
 * RANDOM_SPAN positions. Keys are increasing, inside the gap, and a gap
 * shrinks by at most 2.4x per key placed in it.
 */
function fractionsBetween(
  lower: string,
  upper: string | undefined,
  count: number
): string[] {
  let precision = Math.max(lower.length, upper?.length ?? 0);
  const scaled = (digits: string) =>
    BigInt(digits.padEnd(precision, "0") || "0");
  const slots = BigInt(count + 1);
  let low = scaled(lower);
  let high = upper === undefined ? TEN ** BigInt(precision) : scaled(upper);
  while ((high - low) / slots < 3n * RANDOM_SPAN) {
    precision += 1;
    low *= TEN;
    high *= TEN;
  }
  const slot = (high - low) / slots;
  const keys: string[] = [];
  for (let index = 1n; index <= BigInt(count); index += 1n) {
    const at = low + slot * index - slot / 6n + random(slot / 3n);
    keys.push(at.toString().padStart(precision, "0").replace(/0+$/, ""));
  }
  return keys;
}

/**
 * `count` keys strictly between `lower` and `upper` (`null`: an open end),
 * in increasing order.
 *
 * - After the last key (`upper` null): the next integers, as the SQL append
 *   computes them, each with a random fraction.
 * - Before the first key (`lower` null): the integers just below `upper`'s.
 * - Between two keys: free integers between theirs when there are enough,
 *   else fractions under `lower`'s integer.
 *
 * A result may exceed MAX_KEY_LENGTH once a gap has been split many times;
 * the caller checks `isKey` and respaces the neighbourhood when it does not.
 * Throws a RangeError when `lower` is not strictly below `upper`.
 */
export function keysBetween(
  lower: string | null,
  upper: string | null,
  count: number
): string[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError("count must be a positive integer");
  }
  if (lower !== null && upper !== null && !(lower < upper)) {
    throw new RangeError(`"${lower}" is not below "${upper}"`);
  }
  const keys: string[] = [];
  if (upper === null) {
    const base = lower === null ? -1n : parse(lower).value;
    const from = base < 0n ? -1n : base;
    for (let step = 1n; step <= BigInt(count); step += 1n) {
      keys.push(encode(from + step) + randomFraction());
    }
    return keys;
  }
  const high = parse(upper);
  if (lower === null) {
    for (let step = BigInt(count); step >= 1n; step -= 1n) {
      keys.push(encode(high.value - step) + randomFraction());
    }
    return keys;
  }
  const low = parse(lower);
  if (high.value - low.value > BigInt(count)) {
    for (let step = 1n; step <= BigInt(count); step += 1n) {
      keys.push(encode(low.value + step) + randomFraction());
    }
    return keys;
  }
  const integer = encode(low.value);
  const ceiling = high.value === low.value ? high.fraction : undefined;
  for (const fraction of fractionsBetween(low.fraction, ceiling, count)) {
    keys.push(integer + fraction);
  }
  return keys;
}

/** One key strictly between `lower` and `upper` (`null`: an open end). */
export function keyBetween(lower: string | null, upper: string | null): string {
  return keysBetween(lower, upper, 1)[0] as string;
}
