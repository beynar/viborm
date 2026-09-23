/**
 * The exact decimal VALUE type, its accepted spelling, and the text-level
 * arithmetic the field codec needs.
 *
 * A `Decimal` is an immutable signed `BigInt` coefficient and a non-negative
 * scale, `coefficient x 10^-scale`: no NaN, no infinity, no exponent, no
 * statics and no configuration. The constructor and every result strip
 * insignificant fraction zeros and zero is `(0n, 0)`, so `toString()` IS the
 * canonical private text every identity owner keys on.
 *
 * `admitDecimal` is the one admission rule (a string through the grammar,
 * anything else through the brand). The brand is the `#c` private field only
 * the constructor installs, so `canonicalDecimalText` answers `undefined` for
 * `Object.create(Decimal.prototype)`, a look-alike object or a `Proxy`, and no
 * boundary above has to snapshot a foreign representation.
 *
 * The published TYPE is an interface and the published VALUE a const holding
 * the class: result types map every leaf through `Prettify`, a mapped type
 * drops private fields, and a class type would stop being assignable to
 * `Decimal`. The const's declared type keeps the two in step.
 */

/**
 * The accepted literal grammar: optional sign, decimal digits, at most one dot,
 * at least one digit overall. Deliberately NO exponent — `1e3` is a float
 * spelling, and admitting it would mean admitting `1e400` and the rounding
 * question that comes with it. Deliberately no whitespace, no `NaN`, no
 * `Infinity`: none of them name an exact decimal.
 */
const DECIMAL_LITERAL_REGEX = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

const LEADING_ZEROS_REGEX = /^0+/;
const TRAILING_ZEROS_REGEX = /0+$/;
const LEADING_SIGN_REGEX = /^[+-]/;

/**
 * Reduce a valid decimal literal to its ONE canonical spelling: no leading `+`,
 * no insignificant leading or trailing zeros, no bare `-0`, no dangling dot.
 *
 * Canonicalization is not cosmetic. It is the private logical representation
 * every identity owner keys on — cursors, row keys, cache keys, race pins, link
 * folds — so two Decimal instances naming the same number are the same key, and
 * `"1.10"` and `"1.1"` are the same value on every dialect.
 */
function canonicalizeLiteral(literal: string): string {
  const negative = literal.startsWith("-");
  const unsigned = literal.replace(LEADING_SIGN_REGEX, "");
  const [rawInteger = "", rawFraction = ""] = unsigned.split(".");
  const integer = rawInteger.replace(LEADING_ZEROS_REGEX, "");
  const fraction = rawFraction.replace(TRAILING_ZEROS_REGEX, "");
  const whole = integer === "" ? "0" : integer;
  // Zero has no sign: '-0.000' and '0' are the same number, so they get the
  // same spelling — otherwise text equality would split them apart.
  if (whole === "0" && fraction === "") return "0";
  const sign = negative ? "-" : "";
  return fraction === "" ? `${sign}${whole}` : `${sign}${whole}.${fraction}`;
}

/**
 * The canonical text of a `Decimal | string`, or `undefined` when the value
 * names no exact decimal: THE admission rule.
 *
 * The constructor reads a string through it, and the field (`v.decimal()`),
 * the engine binders and the cache encoder read every value through it, so
 * what `s.decimal()` accepts and what `new Decimal()` accepts cannot drift
 * apart. A `Decimal` answers through the brand, never through its shape.
 */
export function admitDecimal(value: unknown): string | undefined {
  if (typeof value !== "string") return canonicalDecimalText(value);
  return DECIMAL_LITERAL_REGEX.test(value)
    ? canonicalizeLiteral(value)
    : undefined;
}

/**
 * The two PRIMITIVE forms of an exact decimal a caller may hand the value type:
 * a spelling, or a whole coefficient. Both name an exact decimal; a JavaScript
 * number names a double, so it is not one of them.
 */
export type DecimalPrimitive = string | bigint;

/**
 * How a quotient resolves a value exactly between two representable ones.
 *
 * Two modes, each with a caller: `"half-up"` is what an application reading a
 * money column expects and what every VibORM release so far has produced;
 * `"half-even"` is what the SQL engines do, so a caller reconciling against a
 * server-side division can ask for the server's answer. There is no third mode
 * because there is no third caller.
 */
export type DecimalRounding = "half-up" | "half-even";

const TEN = 10n;

/** `10^power`, the scale shift both alignment and rounding are spelled with. */
function shift(power: number): bigint {
  return TEN ** BigInt(power);
}

/**
 * Round `numerator / denominator` to an integer, both taken as non-negative.
 *
 * `"half-up"` sends a tie away from zero, which is the sign the caller's
 * coefficient carries separately; `"half-even"` sends it to the even neighbour.
 */
function roundQuotient(
  numerator: bigint,
  denominator: bigint,
  rounding: DecimalRounding
): bigint {
  const quotient = numerator / denominator;
  const doubled = (numerator % denominator) * 2n;
  if (doubled > denominator) return quotient + 1n;
  if (doubled < denominator) return quotient;
  return rounding === "half-up" || quotient % 2n !== 0n
    ? quotient + 1n
    : quotient;
}

/** The accepted spelling, named once for both refusal sentences below. */
const DECIMAL_SPELLING =
  "a string like '-12.345' (sign, digits, at most one dot, no exponent); a JavaScript number is a double and is not accepted";

/**
 * The FIELD boundary's refusal: `v.decimal()` returns it as its issue message
 * wherever `admitDecimal` answers `undefined`.
 */
export const DECIMAL_INPUT_REFUSAL = `Expected an exact decimal: a Decimal or ${DECIMAL_SPELLING}`;

/**
 * The constructor's refusal. It names one more member than the field's,
 * because the value type also takes a whole `bigint` coefficient, and it shares
 * the grammar and the spelling clause with it.
 */
export const DECIMAL_CONSTRUCTOR_REFUSAL = `Expected an exact decimal: a Decimal, a bigint, or ${DECIMAL_SPELLING}`;

/**
 * Write one normalized coefficient and scale as canonical text: the integer
 * digits, a point only when there are fraction digits, and a sign only on a
 * value below zero. The one canonical rendering — `toString` and the seam the
 * codec reads both come here, so no caller can be shown a second spelling;
 * `toFixed` shares its point placement.
 */
function renderParts(coefficient: bigint, scale: number): string {
  const negative = coefficient < 0n;
  return placePoint(
    negative,
    (negative ? -coefficient : coefficient).toString(),
    scale
  );
}

/** Unsigned digits with the point `fractionDigits` from the right, and a sign. */
function placePoint(
  negative: boolean,
  digits: string,
  fractionDigits: number
): string {
  const sign = negative ? "-" : "";
  if (fractionDigits === 0) return `${sign}${digits}`;
  const padded = digits.padStart(fractionDigits + 1, "0");
  const point = padded.length - fractionDigits;
  return `${sign}${padded.slice(0, point)}.${padded.slice(point)}`;
}

/**
 * Write a coefficient and scale with exactly `fractionDigits` fraction digits,
 * rounding half away from zero: `toFixed`.
 */
function renderFixed(
  coefficient: bigint,
  scale: number,
  fractionDigits: number
): string {
  const negative = coefficient < 0n;
  const rounded = roundQuotient(
    (negative ? -coefficient : coefficient) * shift(fractionDigits),
    shift(scale),
    "half-up"
  ).toString();
  // A negative value keeps its sign even when every digit it rounded to is a
  // zero: `-0.004` to two places is `-0.00`, which says the value was below
  // zero and too small to show. Zero itself is never negative, so there is no
  // second rule to apply.
  return placePoint(negative, rounded, fractionDigits);
}

/**
 * Read already-canonical text straight into a coefficient and a scale.
 *
 * Canonical text carries no `+`, no insignificant zero and no bare `-0`, so
 * what comes out needs no normalization — which is what lets the codec hand
 * over a spelling it has already validated without paying for the grammar a
 * second time.
 */
function partsOfCanonical(canonical: string): [bigint, number] {
  const point = canonical.indexOf(".");
  if (point === -1) return [BigInt(canonical), 0];
  const scale = canonical.length - point - 1;
  return [
    BigInt(canonical.slice(0, point) + canonical.slice(point + 1)),
    scale,
  ];
}

/**
 * The exact decimal VALUE.
 *
 * Immutable: every operation returns a new instance and none of them mutates
 * the receiver. Every binary operation accepts the same
 * `Decimal | DecimalPrimitive` the constructor does, so there is one admission
 * grammar for the whole type.
 *
 * This is an INTERFACE, and {@link Decimal} below is the const that holds the
 * class implementing it. They carry the same name on purpose — a caller writes
 * `Decimal` for both — and the const's declared type is what keeps them in
 * step: a method added to one side and not the other stops compiling.
 *
 * @example
 * new Decimal("19.99").times("3").toString(); // "59.97"
 * new Decimal("1").div("3", 5).toString(); // "0.33333"
 */
export interface Decimal {
  /** This value plus `other`, exactly. */
  plus(other: Decimal | DecimalPrimitive): Decimal;
  /** This value minus `other`, exactly. */
  minus(other: Decimal | DecimalPrimitive): Decimal;
  /** This value times `other`, exactly: coefficients multiply, scales add. */
  times(other: Decimal | DecimalPrimitive): Decimal;
  /**
   * This value divided by `other`, to `fractionDigits` fraction digits.
   *
   * A quotient is the one operation with no exact answer, so it is the one that
   * asks: how many digits, and what happens to a tie.
   *
   * @throws {RangeError} when `other` is zero.
   */
  div(
    other: Decimal | DecimalPrimitive,
    fractionDigits?: number,
    rounding?: DecimalRounding
  ): Decimal;
  /** `-1`, `0` or `1` as this value is below, equal to, or above `other`. */
  cmp(other: Decimal | DecimalPrimitive): -1 | 0 | 1;
  /** Whether this value and `other` are the same number. */
  eq(other: Decimal | DecimalPrimitive): boolean;
  /** Whether this value is below `other`. */
  lt(other: Decimal | DecimalPrimitive): boolean;
  /** Whether this value is below `other` or the same number. */
  lte(other: Decimal | DecimalPrimitive): boolean;
  /** Whether this value is above `other`. */
  gt(other: Decimal | DecimalPrimitive): boolean;
  /** Whether this value is above `other` or the same number. */
  gte(other: Decimal | DecimalPrimitive): boolean;
  /** This value without its sign. */
  abs(): Decimal;
  /** This value with its sign flipped. Zero has no sign to flip. */
  neg(): Decimal;
  /**
   * The canonical text of this value: no exponent, ever, and no insignificant
   * zero, so two instances naming the same number spell it the same way.
   */
  toString(): string;
  /**
   * This value with exactly `fractionDigits` fraction digits, rounding half
   * away from zero. With no argument it is {@link Decimal.toString}: the whole
   * value, in normal notation, rounded nowhere.
   */
  toFixed(fractionDigits?: number): string;
  /**
   * This value as a JavaScript number, which is a double: the conversion is
   * exact only for values a double can hold, and is the caller's decision.
   */
  toNumber(): number;
  /** The canonical text, so `` `${value}` `` and `+value` read the number. */
  valueOf(): string;
  /** The canonical text, so `JSON.stringify` writes the number, not `{}`. */
  toJSON(): string;
}

/**
 * The two module-private readers of a Decimal's private fields, captured from
 * inside the class body.
 *
 * Captured rather than declared `static` so the published constructor carries
 * no static property at all: `Object.getOwnPropertyNames(Decimal)` is
 * `length`, `name`, `prototype` and nothing else, which is the "no
 * configuration, in either direction" promise made literal.
 */
let owns: (value: unknown) => value is ExactDecimal;
let textOf: (value: ExactDecimal) => string;

/**
 * The class, and the only place a `#c` is installed.
 *
 * Named for what it is rather than `Decimal`, which the interface above already
 * takes: it is not a wrapper AROUND a decimal, it IS the exact decimal, and a
 * class named `DecimalValue`/`DecimalWrapper` beside a `Decimal` is exactly the
 * second-owner shape the language census refuses.
 *
 * Module-private: what the package exports is {@link Decimal} below, whose
 * declared type carries ONE construct signature — the public grammar. The
 * two-argument form here is the internal seam a coefficient at a non-zero
 * scale arrives through; TypeScript outside this module cannot spell it, but
 * untyped JavaScript reaches it (`new Decimal(123n, 2)` is 1.23) and the
 * scale is not checked there.
 */
class ExactDecimal implements Decimal {
  readonly #c: bigint;
  readonly #scale: number;

  constructor(value: Decimal | DecimalPrimitive, scale?: number) {
    // A `bigint` is a coefficient: a public one is a whole number (scale 0),
    // and the internal seam passes its scale. Normalized here so every result
    // in this file is normalized in one place.
    if (typeof value === "bigint") {
      let coefficient = value;
      let places = scale ?? 0;
      while (places > 0 && coefficient % TEN === 0n) {
        coefficient /= TEN;
        places--;
      }
      this.#c = coefficient;
      this.#scale = coefficient === 0n ? 0 : places;
      return;
    }
    // The BRAND, not `instanceof`: a prototype is forgeable and a private field
    // is not, so a value that only wears the prototype falls through to the
    // refusal below instead of failing on a field it does not have.
    if (owns(value)) {
      this.#c = value.#c;
      this.#scale = value.#scale;
      return;
    }
    const canonical = admitDecimal(value);
    if (canonical === undefined) {
      throw new TypeError(DECIMAL_CONSTRUCTOR_REFUSAL);
    }
    const [coefficient, places] = partsOfCanonical(canonical);
    this.#c = coefficient;
    this.#scale = places;
  }

  static {
    owns = (value: unknown): value is ExactDecimal =>
      typeof value === "object" && value !== null && #c in value;
    textOf = (value) => renderParts(value.#c, value.#scale);
  }

  /** The coefficient this value would carry at `scale`, which is never less. */
  #at(scale: number): bigint {
    return this.#c * shift(scale - this.#scale);
  }

  plus(other: Decimal | DecimalPrimitive): Decimal {
    const addend = new ExactDecimal(other);
    const scale = Math.max(this.#scale, addend.#scale);
    return new ExactDecimal(this.#at(scale) + addend.#at(scale), scale);
  }

  minus(other: Decimal | DecimalPrimitive): Decimal {
    const subtrahend = new ExactDecimal(other);
    const scale = Math.max(this.#scale, subtrahend.#scale);
    return new ExactDecimal(this.#at(scale) - subtrahend.#at(scale), scale);
  }

  times(other: Decimal | DecimalPrimitive): Decimal {
    const factor = new ExactDecimal(other);
    return new ExactDecimal(this.#c * factor.#c, this.#scale + factor.#scale);
  }

  div(
    other: Decimal | DecimalPrimitive,
    fractionDigits = 20,
    rounding: DecimalRounding = "half-up"
  ): Decimal {
    const divisor = new ExactDecimal(other);
    if (divisor.#c === 0n) throw new RangeError("Division by zero");
    const numerator = this.#c * shift(divisor.#scale + fractionDigits);
    const denominator = divisor.#c * shift(this.#scale);
    const negative = numerator < 0n !== denominator < 0n;
    const magnitude = roundQuotient(
      numerator < 0n ? -numerator : numerator,
      denominator < 0n ? -denominator : denominator,
      rounding
    );
    return new ExactDecimal(negative ? -magnitude : magnitude, fractionDigits);
  }

  cmp(other: Decimal | DecimalPrimitive): -1 | 0 | 1 {
    const against = new ExactDecimal(other);
    const scale = Math.max(this.#scale, against.#scale);
    const left = this.#at(scale);
    const right = against.#at(scale);
    if (left < right) return -1;
    return left > right ? 1 : 0;
  }

  eq(other: Decimal | DecimalPrimitive): boolean {
    return this.cmp(other) === 0;
  }

  lt(other: Decimal | DecimalPrimitive): boolean {
    return this.cmp(other) === -1;
  }

  lte(other: Decimal | DecimalPrimitive): boolean {
    return this.cmp(other) !== 1;
  }

  gt(other: Decimal | DecimalPrimitive): boolean {
    return this.cmp(other) === 1;
  }

  gte(other: Decimal | DecimalPrimitive): boolean {
    return this.cmp(other) !== -1;
  }

  abs(): Decimal {
    return new ExactDecimal(this.#c < 0n ? -this.#c : this.#c, this.#scale);
  }

  neg(): Decimal {
    return new ExactDecimal(-this.#c, this.#scale);
  }

  toString(): string {
    return renderParts(this.#c, this.#scale);
  }

  toFixed(fractionDigits?: number): string {
    return fractionDigits === undefined
      ? this.toString()
      : renderFixed(this.#c, this.#scale, fractionDigits);
  }

  toNumber(): number {
    return Number(this.toString());
  }

  valueOf(): string {
    return this.toString();
  }

  toJSON(): string {
    return this.toString();
  }
}

/**
 * The public constructor, carrying the one grammar a caller may spell.
 *
 * The same object as the class, so `instanceof` and `Object.create(
 * Decimal.prototype)` behave exactly as they would for a plain class
 * declaration — only the internal two-argument construction is hidden, and the
 * instance TYPE stays free of private fields so a mapped result type keeps it.
 */
export const Decimal: {
  /**
   * @param value a `Decimal` to copy, an exact decimal string, or a whole
   * `bigint`.
   * @throws {TypeError} for every other value, including every JavaScript
   * number, a string outside the accepted grammar, and a value of any other
   * type.
   */
  new (value: Decimal | DecimalPrimitive): Decimal;
  readonly prototype: Decimal;
} = ExactDecimal;

/**
 * Construct one Decimal from text this module's own grammar already admitted.
 *
 * The decode half of every result, cache and default boundary. The codec has
 * established the spelling before calling, so re-testing it here would make the
 * grammar two owners deep; a caller that has NOT established it uses the
 * ordinary constructor, which is the only other way in.
 */
export function fromCanonical(canonical: string): Decimal {
  const [coefficient, scale] = partsOfCanonical(canonical);
  return new ExactDecimal(coefficient, scale);
}

/**
 * The canonical text of a value that IS one of ours, or `undefined`.
 *
 * The whole value boundary, in one function: the private field is installed by
 * the constructor and by nothing else, so answering at all is a witness of
 * CONSTRUCTION rather than a reading of a shape — `undefined` for
 * `Object.create(Decimal.prototype)`, for a plain object carrying the same
 * keys, for a `Proxy` around a real one, and for every other value there is.
 *
 * The text is read from the fields, deliberately NOT through `value.toString()`:
 * the prototype is an object an application can write to, and a codec that
 * rendered through it would be rendering whatever the application put there.
 * The fields are reachable from inside the class body and from nowhere else, so
 * this is the only rendering no caller can move — and it shares `renderParts`
 * with the prototype method, so there is still one spelling.
 */
export function canonicalDecimalText(value: unknown): string | undefined {
  return owns(value) ? textOf(value) : undefined;
}

/**
 * The Decimal `coefficient x 10^-scale`: the decode seam for an unscaled
 * integer a provider stored, normalized by the constructor like every result.
 */
export function fromCoefficient(coefficient: bigint, scale: number): Decimal {
  return new ExactDecimal(coefficient, scale);
}

/**
 * The unscaled integer coefficient of canonical text at `scale`, which is never
 * less than the text's own: `logical x 10^scale`, exact because it is the
 * value's own `BigInt` shifted, never a JavaScript multiplication.
 */
export function toCoefficient(canonical: string, scale: number): string {
  const [coefficient, own] = partsOfCanonical(canonical);
  return (coefficient * shift(scale - own)).toString();
}

/**
 * Why canonical text is outside the domain `{ precision, scale }`, or
 * `undefined` when it fits: the one owner of both refusal sentences.
 *
 * Fitting is a DOMAIN question, not a spelling one: `"1.2"` at scale 5 fits and
 * stays `"1.2"`. Only digits past `scale`, or an unscaled coefficient wider
 * than `precision`, are outside, and both are refused rather than rounded.
 *
 * Read from the TEXT, in one pass and with no allocation: a declared scale may
 * be as large as `Number.MAX_SAFE_INTEGER` before a provider bounds it, and a
 * field refuses an over-long literal before any `BigInt` is built.
 */
export function domainRefusal(
  canonical: string,
  precision: number,
  scale: number
): string | undefined {
  const point = canonical.indexOf(".");
  const fractionDigits = point === -1 ? 0 : canonical.length - point - 1;
  if (fractionDigits > scale) {
    return `Expected at most ${scale} fractional digit${scale === 1 ? "" : "s"}, but '${canonical}' has ${fractionDigits}`;
  }
  const start = canonical.startsWith("-") ? 1 : 0;
  let digits: number;
  if (canonical[start] !== "0") {
    // Canonical text has no leading zero, so every integer digit counts.
    digits = (point === -1 ? canonical.length : point) - start + scale;
  } else {
    // A zero integer part: the coefficient starts at the first non-zero
    // fraction digit, and zero itself has none.
    let first = point + 1;
    while (canonical[first] === "0") first++;
    digits = point === -1 ? 0 : scale - (first - point - 1);
  }
  if (digits > precision) {
    return `Expected an unscaled coefficient of at most ${precision} digits, but '${canonical}' needs ${digits}`;
  }
  return undefined;
}
