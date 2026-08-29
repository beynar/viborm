/**
 * The ONE field-aware decimal codec.
 *
 * Everything decimal-value-shaped lives here: the accepted literal grammar,
 * canonical private text, the Decimal snapshot/render boundary, descriptor
 * validation, the logical <-> unscaled-coefficient conversion, the two DDL
 * renderings, the widened-sum decode, and the JSON list container. Nothing
 * below this module knows what a decimal is; nothing above it owns a second
 * precision, scale, spelling, or conversion.
 *
 * Two facts make this module possible at all, and both were measured against
 * the pinned `decimal.js@10.6.0` rather than assumed:
 *
 * 1. Decimal.js's public static and prototype surfaces are mutable. VibORM
 *    identifies the family through the prototype captured at module load,
 *    snapshots its complete numeric representation, and renders that plain
 *    data with the local equivalent of decimal.js's `digitsToString` plus
 *    `finiteToString`. No live static identifier or prototype method defines a
 *    canonical ORM value.
 * 2. CONSTRUCTION is not configuration-independent: `Decimal.set({ minE: -3,
 *    maxE: 5 })` turns `new Decimal("0.0000001")` into `0` and
 *    `new Decimal("1e21")` into `Infinity`. VibORM must still return that one
 *    exported constructor's instances, so exact result construction briefly
 *    widens only its exponent range through the configuration function
 *    captured at module load, then restores the application's exact range.
 *
 * Construction is synchronous, exposes no supported callback, and cannot yield
 * between widening and restoration. Arbitrary monkeypatches of decimal.js's
 * mutable prototype are outside that guarantee. Later arithmetic therefore sees
 * every application setting on the exported constructor, including its restored
 * exponent range (plan 2.4).
 */

import Decimal from "decimal.js";
import { isNumber, isString } from "../value-guards";

// =============================================================================
// THE DOMAIN
// =============================================================================

/**
 * The one immutable fixed-decimal domain: values are multiples of `10^-scale`
 * whose unscaled coefficient has at most `precision` digits.
 *
 * Its trusted instances are frozen by the definition boundary
 * (`@schema/scalars/decimal/descriptor`) and carried by reference through every
 * modifier. Nothing copies it into a query scope, driver, or result shape.
 */
export interface DecimalDescriptor {
  readonly precision: number;
  readonly scale: number;
}

/** Whether two optional descriptor references declare the same value domain. */
export function sameDecimalDescriptor(
  left: DecimalDescriptor | undefined,
  right: DecimalDescriptor | undefined
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.precision === right.precision && left.scale === right.scale;
}

/**
 * The two exact physical vocabularies a decimal field can cross through.
 *
 * The active adapter selects one; this codec alone interprets it. The value
 * cannot select its own vocabulary because `"120"` is logical 120 as native
 * decimal text and logical 1.2 as a scale-2 coefficient.
 */
export type DecimalPhysicalRepresentation = "text" | "coefficient";

const DECIMAL_LIBRARY_MIN_EXPONENT = -9e15;
const DECIMAL_LIBRARY_MAX_EXPONENT = 9e15;
const decimalPrototype = Decimal.prototype;
const prototypeContains = Object.prototype.isPrototypeOf;
const applyIntrinsic = Reflect.apply;
const configureDecimal = Decimal.config;

// =============================================================================
// CANONICAL PRIVATE TEXT
// =============================================================================

/**
 * The accepted literal grammar: optional sign, decimal digits, at most one dot,
 * at least one digit overall. Deliberately NO exponent — `1e3` is a float
 * spelling, and admitting it would mean admitting `1e400` and the rounding
 * question that comes with it. Deliberately no whitespace, no `NaN`, no
 * `Infinity`: none of them name an exact decimal.
 */
const DECIMAL_LITERAL_REGEX = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

/**
 * The DECIMAL TEXT a provider hands back for a `NUMERIC(p,s)` / `DECIMAL(p,s)`
 * column: an optional minus, an integer part with no leading zero, and — when
 * the column has a scale — a fractional part padded to it.
 *
 * Narrower than {@link DECIMAL_LITERAL_REGEX} on purpose. That one is the
 * grammar an APPLICATION may write, where `+1.2`, `.5` and `1.` are forgiving
 * spellings of a value the caller meant. This one is a DECODE vocabulary: it
 * names the exact physical representation the active adapter promised, so a
 * spelling no adapter emits is a malformed row rather than a number to guess at.
 */

/**
 * The base of one decimal.js coefficient word: it packs seven digits per array
 * member, so a member outside `[0, 1e7)` is not a coefficient it ever wrote.
 */
const DIGIT_WORD_BASE = 1e7;

/**
 * The widest exponent this codec will RENDER.
 *
 * Plain rendering writes every digit between the point and the value, so an
 * exponent is a LENGTH: `new Decimal("1e9000000000")` carries a finite
 * representation whose rendering asks for a nine-gigabyte string. The ceiling
 * is stated against the widest domain any supported provider stores,
 * PostgreSQL's `precision <= 1000`: a million digits is a thousand times that
 * column, wide enough that no widened SUM of real rows reaches it and narrow
 * enough that rendering remains bounded.
 */
const MAX_RENDER_EXPONENT = 1_000_000;

/**
 * Seven decimal digits fit in one decimal.js coefficient word. A value whose
 * exponent is renderable cannot need more words than this; bounding the array
 * before reading it also makes a corrupted instance's coefficient traversal
 * total.
 */
const MAX_COEFFICIENT_WORDS = Math.ceil((MAX_RENDER_EXPONENT + 1) / 7) + 1;

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
 * Expand `String(number)`'s exponent form (`1e+21`, `1e-7`) into plain decimal
 * digits. The mantissa digits are preserved exactly — this only moves the dot.
 */
function expandExponentForm(text: string): string {
  const [mantissa = "", exponentText = ""] = text.toLowerCase().split("e");
  const sign = mantissa.startsWith("-") ? "-" : "";
  const unsigned = mantissa.replace(LEADING_SIGN_REGEX, "");
  const [intDigits = "", fracDigits = ""] = unsigned.split(".");
  const exponent = Number(exponentText);
  const digits = intDigits + fracDigits;
  // Where the dot sits after shifting: digits before it, counted from the left.
  const pointIndex = intDigits.length + exponent;
  if (pointIndex <= 0) {
    return `${sign}0.${"0".repeat(-pointIndex)}${digits}`;
  }
  // `String(number)` uses exponent notation only when the shifted point is
  // outside the mantissa digits. Values in the middle range use plain notation.
  return `${sign}${digits}${"0".repeat(pointIndex - digits.length)}`;
}

/**
 * The complete observable numerical representation of one Decimal candidate.
 *
 * Decimal.js has no unforgeable construction witness: `isDecimal` is tagged,
 * clone constructors are intentionally accepted, and a complete
 * `Object.create(Decimal.prototype)` value is observationally identical to a
 * constructed instance. The honest boundary is therefore the representation,
 * not historical provenance. Every hostile datum is read once into this plain
 * snapshot before a Decimal is allocated or any caller method can run.
 */
interface DecimalSnapshot {
  readonly sign: 1 | -1;
  readonly exponent: number;
  readonly words: number[];
}

/** Whether a value belongs to the one Decimal.js prototype family. */
function hasDecimalPrototype(candidate: unknown): candidate is Decimal {
  if (
    (typeof candidate !== "object" && typeof candidate !== "function") ||
    candidate === null
  ) {
    return false;
  }
  return applyIntrinsic(prototypeContains, decimalPrototype, [candidate]);
}

function snapshotDecimalCandidate(
  candidate: unknown
): DecimalSnapshot | undefined {
  if (!hasDecimalPrototype(candidate)) return undefined;

  for (const property of ["s", "e", "d"] as const) {
    if (!Object.hasOwn(candidate, property)) return undefined;
  }

  const sign = Reflect.get(candidate, "s");
  const exponent = Reflect.get(candidate, "e");
  const coefficient = Reflect.get(candidate, "d");

  // The sign is a FACTOR of the rendered value, and decimal.js writes the minus
  // from `s < 0`: an `s` that is neither direction renders as a positive number
  // the candidate never carried.
  if (sign !== 1 && sign !== -1) return undefined;
  // The exponent is a COUNT of zeros in the rendering, and a fractional one
  // never terminates the loop that emits them.
  if (typeof exponent !== "number" || !Number.isInteger(exponent)) {
    return undefined;
  }
  // ...and the count is also the rendering's LENGTH, so it has a ceiling.
  if (Math.abs(exponent) > MAX_RENDER_EXPONENT) return undefined;
  // A missing coefficient renders the WORD `undefined`, which is text, not zero.
  if (!Array.isArray(coefficient)) return undefined;
  const wordCount = Reflect.get(coefficient, "length");
  if (
    typeof wordCount !== "number" ||
    !Number.isInteger(wordCount) ||
    wordCount > MAX_COEFFICIENT_WORDS
  ) {
    return undefined;
  }
  if (wordCount <= 0) return undefined;
  const snapshot = new Array<number>(wordCount);
  for (let index = 0; index < wordCount; index++) {
    if (!Object.hasOwn(coefficient, index)) return undefined;
    const word = Reflect.get(coefficient, index);
    // A member outside the digit-word base is written into the rendering
    // verbatim, and `null` spins the loop that strips a word's trailing zeros.
    if (
      typeof word !== "number" ||
      !Number.isInteger(word) ||
      word < 0 ||
      word >= DIGIT_WORD_BASE
    ) {
      return undefined;
    }
    snapshot[index] = word;
  }
  // decimal.js never leaves a zero in the LAST word — the same trailing-zero
  // loop divides it by ten forever — except for the single-word zero it
  // answers before reaching that loop at all.
  if (wordCount > 1 && snapshot[wordCount - 1] === 0) return undefined;
  return { sign, exponent, words: snapshot };
}

/** Render decimal.js's base-1e7 coefficient words as significant digits. */
function renderDecimalWords(words: readonly number[]): string {
  const lastIndex = words.length - 1;
  let lastWord = words[0]!;
  let digits = "";

  if (lastIndex > 0) {
    digits += lastWord;
    for (let index = 1; index < lastIndex; index++) {
      const word = String(words[index]!);
      digits += `${"0".repeat(7 - word.length)}${word}`;
    }

    lastWord = words[lastIndex]!;
    const word = String(lastWord);
    digits += "0".repeat(7 - word.length);
  } else if (lastWord === 0) {
    return "0";
  }

  while (lastWord % 10 === 0) lastWord /= 10;
  return digits + lastWord;
}

/**
 * Render one validated Decimal.js numerical snapshot in plain notation.
 *
 * This is decimal.js's `digitsToString` plus the non-exponential branch of
 * `finiteToString`, expressed over trusted plain data. It deliberately invokes
 * no exported constructor, static, prototype method, or caller-owned hook.
 */
function renderDecimalSnapshot(snapshot: DecimalSnapshot): string {
  let text = renderDecimalWords(snapshot.words);
  const length = text.length;

  if (snapshot.exponent < 0) {
    text = `0.${"0".repeat(-snapshot.exponent - 1)}${text}`;
  } else if (snapshot.exponent >= length) {
    text += "0".repeat(snapshot.exponent + 1 - length);
  } else {
    const point = snapshot.exponent + 1;
    text = `${text.slice(0, point)}.${text.slice(point)}`;
  }

  return snapshot.sign < 0 && text !== "0" ? `-${text}` : text;
}

/**
 * Identify, copy, check, and render a Decimal CANDIDATE once, or `undefined`
 * when it does not name a finite decimal.
 *
 * The captured Decimal.js prototype identifies the value family without
 * consulting mutable `Decimal.isDecimal` or `Symbol.hasInstance` hooks.
 * The candidate's complete observable numerical representation is snapshotted
 * once and rendered directly, so neither a decimal.js constructor nor a
 * caller-owned slice, iterator, constructor, or renderer participates.
 *
 * Finiteness is checked here rather than by the grammar because
 * `new Decimal(NaN)` and `new Decimal(Infinity)` are perfectly valid Decimals.
 */
function canonicalizeDecimalCandidate(candidate: unknown): string | undefined {
  try {
    const snapshot = snapshotDecimalCandidate(candidate);
    if (snapshot === undefined) return undefined;
    const text = renderDecimalSnapshot(snapshot);
    return canonicalizeLiteral(text);
  } catch {
    return undefined;
  }
}

/**
 * The canonical decimal spelling of a `Decimal | string | number`, or
 * `undefined` when the value does not name an exact finite decimal.
 *
 * A number is rendered through `String(n)`, the shortest decimal that
 * round-trips back to the same double — a faithful name for the double the
 * caller handed over. It does not invent precision the double never had, and it
 * does not launder float error the caller already committed: `0.1 + 0.2` names
 * `"0.30000000000000004"`, which a scale-2 field then refuses.
 *
 * This is the encode half of the cache/identity boundary too: a `Decimal` in,
 * canonical text out.
 */
export function canonicalizeDecimal(value: unknown): string | undefined {
  if (isString(value)) {
    return DECIMAL_LITERAL_REGEX.test(value)
      ? canonicalizeLiteral(value)
      : undefined;
  }
  if (isNumber(value)) {
    if (!Number.isFinite(value)) return undefined;
    // `String(number)` spells its exponent in lowercase for every double there
    // is — `1e+21`, `1e-7`, `Number.MAX_VALUE` — so there is one spelling to
    // look for, not two.
    const text = String(value);
    const expanded = text.includes("e") ? expandExponentForm(text) : text;
    return canonicalizeLiteral(expanded);
  }
  return canonicalizeDecimalCandidate(value);
}

/**
 * The canonical spelling of a value that must BE a Decimal, or `undefined`.
 *
 * The custom-schema return position (plan 2.3): a schema handed a `Decimal` may
 * refine it, brand it, or return another complete bounded finite Decimal.js
 * numerical representation. A string, a number, a tag-only or incomplete
 * decimal-like object, `NaN`, and infinity are a different value family and
 * fail there — so unlike
 * {@link canonicalizeDecimal}, this entry admits no other spelling.
 */
export function canonicalizeDecimalValue(value: unknown): string | undefined {
  return canonicalizeDecimalCandidate(value);
}

/**
 * Canonicalize one Decimal that the result parser just materialized, without
 * building a second Decimal for the cache snapshot.
 *
 * This is deliberately narrower than {@link canonicalizeDecimal}: callers may
 * use it only while they still exclusively own the fresh value produced by
 * {@link toDecimal}. The cache has that lexical guarantee before it publishes
 * the result. It deliberately delegates to the same family, snapshot, and
 * plain-render owner as every other Decimal candidate.
 */
export function canonicalizeMaterializedDecimal(
  value: unknown
): string | undefined {
  return canonicalizeDecimalCandidate(value);
}

/**
 * Construct one public Decimal value for a validated canonical string.
 *
 * The decode half of every result, cache, and default boundary. It builds one
 * direct instance of the `Decimal` exported from `viborm`. A narrow application
 * exponent range cannot turn a stored exact value into zero or infinity during
 * construction, and the exact application range is restored before return.
 */
export function toDecimal(canonical: string): Decimal {
  return constructExact(canonical);
}

/** The one constructor call for a validated exact spelling. */
function constructExact(spelling: string): Decimal {
  const minE = Decimal.minE;
  const maxE = Decimal.maxE;
  if (
    minE === DECIMAL_LIBRARY_MIN_EXPONENT &&
    maxE === DECIMAL_LIBRARY_MAX_EXPONENT
  ) {
    return new Decimal(spelling);
  }

  try {
    applyIntrinsic(configureDecimal, Decimal, [
      {
        minE: DECIMAL_LIBRARY_MIN_EXPONENT,
        maxE: DECIMAL_LIBRARY_MAX_EXPONENT,
      },
    ]);
    return new Decimal(spelling);
  } finally {
    applyIntrinsic(configureDecimal, Decimal, [{ minE, maxE }]);
  }
}

// =============================================================================
// DESCRIPTOR VALIDATION
// =============================================================================

/** The sign-free integer and fraction digits of a canonical decimal string. */
function splitCanonical(canonical: string): [string, string] {
  const unsigned = canonical.startsWith("-") ? canonical.slice(1) : canonical;
  const [integer = "", fraction = ""] = unsigned.split(".");
  return [integer, fraction];
}

/**
 * Why this canonical value does not fit the descriptor, or `undefined` when it
 * does. The one owner of both refusal sentences.
 *
 * Fitting is a DOMAIN question, not a spelling one: `"1.2"` at scale 5 fits and
 * stays `"1.2"`, because scale is a limit on the value's fractional digits and
 * not display formatting. Only non-zero digits past `scale`, or an unscaled
 * coefficient wider than `precision`, are outside the domain — and both are
 * refused rather than rounded, so database assignment is never asked to perform
 * implicit input rounding.
 */
export function describeDescriptorRefusal(
  canonical: string,
  descriptor: DecimalDescriptor
): string | undefined {
  const [integer, fraction] = splitCanonical(canonical);
  if (fraction.length > descriptor.scale) {
    return `Expected at most ${descriptor.scale} fractional digit${descriptor.scale === 1 ? "" : "s"}, but '${canonical}' has ${fraction.length}`;
  }
  const digitCount = coefficientDigitCount(integer, fraction, descriptor.scale);
  if (digitCount > descriptor.precision) {
    return `Expected an unscaled coefficient of at most ${descriptor.precision} digits, but '${canonical}' needs ${digitCount}`;
  }
  return undefined;
}

/**
 * The significant unscaled-coefficient digit COUNT of one canonical value.
 *
 * Descriptor validation runs before a provider binds the model and therefore
 * accepts a syntactically valid scale up to `Number.MAX_SAFE_INTEGER`. Counting
 * must stay O(the input spelling): padding a zero or fraction to that scale
 * would allocate the physical coefficient before a provider has applied its
 * much smaller domain limit.
 */
function coefficientDigitCount(
  integer: string,
  fraction: string,
  scale: number
): number {
  if (integer !== "0") return integer.length + scale;
  if (fraction === "") return 0;
  let firstNonZero = 0;
  while (fraction[firstNonZero] === "0") firstNonZero++;
  return scale - firstNonZero;
}

/**
 * The significant unscaled-coefficient DIGITS of one canonical value.
 *
 * This physical rendering is reached only after provider binding has admitted
 * the descriptor. Definition-time and input validation use
 * {@link coefficientDigitCount} and never allocate according to the declared
 * scale.
 */
function coefficientDigits(
  integer: string,
  fraction: string,
  scale: number
): string {
  const whole = integer === "0" ? "" : integer;
  return `${whole}${fraction.padEnd(scale, "0")}`.replace(
    LEADING_ZEROS_REGEX,
    ""
  );
}

// =============================================================================
// LOGICAL <-> UNSCALED COEFFICIENT
// =============================================================================

/**
 * The unscaled integer coefficient of a canonical value at this scale:
 * `logical x 10^scale`, spelled in the coefficient grammar.
 *
 * Digit strings only. A JavaScript multiplication would be exactly the loss
 * this whole representation exists to avoid, so the dot is moved rather than
 * the number scaled.
 */
export function logicalToCoefficient(canonical: string, scale: number): string {
  const negative = canonical.startsWith("-");
  const [integer, fraction] = splitCanonical(canonical);
  const digits = coefficientDigits(integer, fraction, scale);
  if (digits === "") return "0";
  return negative ? `-${digits}` : digits;
}

/** Whether one UTF-16 code unit is an ASCII decimal digit. */
function isDecimalDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

/**
 * Validate the one physical coefficient vocabulary and its optional precision
 * bound in one pass.
 *
 * Canonical rendering and direct public construction both consume this result,
 * so neither path has a second grammar or domain rule.
 */
function scanCoefficient(coefficient: string, precision?: number): boolean {
  const length = coefficient.length;
  if (length === 0) return false;

  const negative = coefficient.charCodeAt(0) === 45;
  const digitStart = negative ? 1 : 0;
  if (digitStart === length) return false;

  const first = coefficient.charCodeAt(digitStart);
  if (first === 48) {
    return !negative && length === 1;
  }
  if (first < 49 || first > 57) return false;
  for (let index = digitStart + 1; index < length; index++) {
    if (!isDecimalDigit(coefficient.charCodeAt(index))) return false;
  }

  return precision === undefined || length - digitStart <= precision;
}

/** Render one validated coefficient as canonical logical text. */
function renderCoefficientLogical(coefficient: string, scale: number): string {
  if (coefficient === "0") return "0";
  const length = coefficient.length;
  const digitStart = coefficient.charCodeAt(0) === 45 ? 1 : 0;
  const coefficientDigits = length - digitStart;
  let fractionalZeros = 0;
  while (
    fractionalZeros < scale &&
    coefficient.charCodeAt(length - fractionalZeros - 1) === 48
  ) {
    fractionalZeros++;
  }

  const canonicalDigitEnd = length - fractionalZeros;
  const integerDigits = coefficientDigits - scale;
  let logical: string;
  if (integerDigits > 0) {
    const point = digitStart + integerDigits;
    logical =
      canonicalDigitEnd === point
        ? coefficient.slice(digitStart, point)
        : `${coefficient.slice(digitStart, point)}.${coefficient.slice(point, canonicalDigitEnd)}`;
  } else {
    logical = `0.${"0".repeat(-integerDigits)}${coefficient.slice(digitStart, canonicalDigitEnd)}`;
  }

  return digitStart === 1 ? `-${logical}` : logical;
}

/**
 * The canonical logical value of an unscaled integer coefficient at this scale,
 * or `undefined` when the text is not a coefficient this codec ever wrote.
 *
 * Untrusted: it is the exact physical vocabulary the result parser and the
 * migration copy map read back, so a JSON number token, a leading zero, `+1`,
 * `-0`, or an empty string is a malformed provider value rather than a number.
 */
export function coefficientToLogical(
  coefficient: unknown,
  scale: number
): string | undefined {
  return isString(coefficient) && scanCoefficient(coefficient)
    ? renderCoefficientLogical(coefficient, scale)
    : undefined;
}

// =============================================================================
// PROVIDER TEXT DECODE
// =============================================================================

/**
 * Validate and locate canonical physical decimal TEXT in one scan.
 *
 * This is deliberately not {@link canonicalizeDecimal}: provider decode
 * accepts only the adapter vocabulary, never a number or caller Decimal. The
 * returned number is the canonical end offset, with zero reserved for
 * normalized zero. The scan also owns scale and optional precision admission,
 * so field and SUM decoders do not reinterpret the spelling afterward.
 */
function scanProviderText(
  value: string,
  scale: number,
  precision?: number
): number | undefined {
  const length = value.length;
  if (length === 0) return undefined;

  const negative = value.charCodeAt(0) === 45;
  const integerStart = negative ? 1 : 0;
  if (integerStart === length) return undefined;

  let index = integerStart;
  const first = value.charCodeAt(index);
  const integerIsZero = first === 48;
  if (integerIsZero) {
    index++;
    if (index < length && isDecimalDigit(value.charCodeAt(index))) {
      return undefined;
    }
  } else {
    if (first < 49 || first > 57) return undefined;
    index++;
    while (index < length && isDecimalDigit(value.charCodeAt(index))) index++;
  }
  const integerEnd = index;

  let fractionStart = length;
  let firstNonZeroFraction = -1;
  let lastNonZeroFractionEnd = -1;
  if (index < length) {
    if (value.charCodeAt(index) !== 46) return undefined;
    fractionStart = ++index;
    if (index === length) return undefined;
    for (; index < length; index++) {
      const code = value.charCodeAt(index);
      if (!isDecimalDigit(code)) return undefined;
      if (code !== 48) {
        if (firstNonZeroFraction < 0) {
          firstNonZeroFraction = index - fractionStart;
        }
        lastNonZeroFractionEnd = index + 1;
      }
    }
  }

  const isZero = integerIsZero && firstNonZeroFraction < 0;
  const fractionalDigits =
    lastNonZeroFractionEnd < 0 ? 0 : lastNonZeroFractionEnd - fractionStart;
  const coefficientDigits = integerIsZero
    ? firstNonZeroFraction < 0
      ? 0
      : scale - firstNonZeroFraction
    : integerEnd - integerStart + scale;
  if (
    fractionalDigits > scale ||
    (precision !== undefined && coefficientDigits > precision)
  ) {
    return undefined;
  }
  if (isZero) return 0;
  return fractionalDigits === 0 ? integerEnd : lastNonZeroFractionEnd;
}

/** Render one validated provider TEXT value as canonical private text. */
function renderProviderText(text: string, end: number): string {
  if (end === 0) return "0";
  return end === text.length ? text : text.slice(0, end);
}

/**
 * Decode one scalar field value read back as native decimal text, or
 * `undefined` when the provider returned something outside the field's declared
 * domain or outside the physical vocabulary the adapter promised.
 *
 * The PostgreSQL/MySQL scalar-read half of the codec: a column declared
 * `NUMERIC(p,s)` cannot answer with more than `s` fractional digits or more
 * than `p` coefficient digits, so a value that does is a column the schema no
 * longer describes rather than a number to widen the field for.
 */
export function decodeFieldScalar(
  text: unknown,
  descriptor: DecimalDescriptor
): string | undefined {
  if (!isString(text)) return undefined;
  const canonicalEnd = scanProviderText(
    text,
    descriptor.scale,
    descriptor.precision
  );
  return canonicalEnd === undefined
    ? undefined
    : renderProviderText(text, canonicalEnd);
}

/**
 * Decode an aggregate SUM, which keeps the field's SCALE but is deliberately
 * NOT held to its precision: adding a million `precision: 10` rows produces a
 * legitimate answer wider than any single column. `undefined` means the
 * provider returned something that is not an exact decimal at this scale.
 */
export function decodeWidenedSum(
  value: unknown,
  scale: number
): string | undefined {
  if (!isString(value)) return undefined;
  const canonicalEnd = scanProviderText(value, scale);
  return canonicalEnd === undefined
    ? undefined
    : renderProviderText(value, canonicalEnd);
}

// =============================================================================
// PROVIDER PHYSICAL REPRESENTATION
// =============================================================================

function encodePhysicalDecimalAtScale(
  canonical: string,
  scale: number,
  representation: DecimalPhysicalRepresentation
): string {
  return representation === "coefficient"
    ? logicalToCoefficient(canonical, scale)
    : canonical;
}

/**
 * Encode one trusted canonical logical value in the vocabulary selected by the
 * active adapter. SQL construction remains with that adapter.
 */
export function encodePhysicalDecimal(
  canonical: string,
  descriptor: DecimalDescriptor,
  representation: DecimalPhysicalRepresentation
): string {
  return encodePhysicalDecimalAtScale(
    canonical,
    descriptor.scale,
    representation
  );
}

/** Decode one coefficient after the shared grammar and domain scan. */
function decodeCoefficientAtPrecision(
  value: unknown,
  scale: number,
  precision?: number
): string | undefined {
  return isString(value) && scanCoefficient(value, precision)
    ? renderCoefficientLogical(value, scale)
    : undefined;
}

/** Construct one coefficient after the shared grammar and domain scan. */
function materializeCoefficientAtPrecision(
  value: unknown,
  scale: number,
  precision?: number
): Decimal | undefined {
  if (!(isString(value) && scanCoefficient(value, precision))) return undefined;
  if (value === "0") return constructExact("0");
  const spelling = scale === 0 ? value : `${value}e-${scale}`;
  return constructExact(spelling);
}

/** Construct one provider TEXT value after the shared grammar and domain scan. */
function materializeProviderText(
  value: unknown,
  scale: number,
  precision?: number
): Decimal | undefined {
  if (!isString(value)) return undefined;
  const canonicalEnd = scanProviderText(value, scale, precision);
  if (canonicalEnd === undefined) return undefined;
  return constructExact(canonicalEnd === 0 ? "0" : value);
}

/**
 * Decode one untrusted provider scalar into canonical private logical text.
 */
export function decodePhysicalDecimal(
  value: unknown,
  descriptor: DecimalDescriptor,
  representation: DecimalPhysicalRepresentation
): string | undefined {
  return representation === "text"
    ? decodeFieldScalar(value, descriptor)
    : decodeCoefficientAtPrecision(
        value,
        descriptor.scale,
        descriptor.precision
      );
}

/**
 * Decode one ordinary scalar directly into its one fresh public Decimal.
 *
 * TEXT uses the already validated provider spelling. A coefficient uses one
 * exact exponent spelling. Neither path renders canonical private text or
 * constructs an intermediate Decimal.
 */
export function materializePhysicalDecimal(
  value: unknown,
  descriptor: DecimalDescriptor,
  representation: DecimalPhysicalRepresentation
): Decimal | undefined {
  return representation === "text"
    ? materializeProviderText(value, descriptor.scale, descriptor.precision)
    : materializeCoefficientAtPrecision(
        value,
        descriptor.scale,
        descriptor.precision
      );
}

/**
 * Encode the ordered input members that the adapter will place in its native
 * array or JSON-backed coefficient container. Canonicalization stays inside
 * the codec so the caller does not need a second list pass or conversion owner.
 */
export function encodePhysicalDecimalListMembers(
  values: readonly unknown[],
  descriptor: DecimalDescriptor,
  representation: DecimalPhysicalRepresentation
): string[] | undefined {
  const members = new Array<string>(values.length);
  for (const [index, value] of values.entries()) {
    const canonical = canonicalizeDecimal(value);
    if (canonical === undefined) return undefined;
    members[index] = encodePhysicalDecimalAtScale(
      canonical,
      descriptor.scale,
      representation
    );
  }
  return members;
}

/**
 * Decode one provider list into canonical private logical members. Text means
 * a native array of exact decimal strings; coefficient means one JSON text
 * container of coefficient strings.
 */
export function decodePhysicalDecimalList(
  value: unknown,
  descriptor: DecimalDescriptor,
  representation: DecimalPhysicalRepresentation
): string[] | undefined {
  let members: string[];
  if (representation === "coefficient") {
    const decoded = decodeDecimalListContainerAtPrecision(
      value,
      descriptor.scale,
      descriptor.precision
    );
    if (decoded === undefined) return undefined;
    members = decoded;
  } else {
    // A supplied driver or result middleware can return a proxy rather than a
    // provider's ordinary native array. Reflection over that value is the
    // untrusted provider boundary: a revoked proxy, a hostile length getter, or
    // an indexed trap is a malformed list, never an exception that escapes the
    // result parser without its typed operation context.
    try {
      if (!Array.isArray(value)) return undefined;
      const length = value.length;
      if (!Number.isSafeInteger(length) || length < 0) return undefined;
      members = new Array<string>(length);
      for (let index = 0; index < length; index++) {
        if (!Object.hasOwn(value, index)) return undefined;
        const canonical = decodeFieldScalar(value[index], descriptor);
        if (canonical === undefined) return undefined;
        members[index] = canonical;
      }
    } catch {
      return undefined;
    }
    return members;
  }

  return members;
}

/**
 * Decode an exact SUM while retaining only the declared scale. The field
 * precision is deliberately not applied because sums widen.
 */
export function decodePhysicalWidenedSum(
  value: unknown,
  descriptor: DecimalDescriptor,
  representation: DecimalPhysicalRepresentation
): string | undefined {
  return representation === "text"
    ? decodeWidenedSum(value, descriptor.scale)
    : decodeCoefficientAtPrecision(value, descriptor.scale);
}

/** Decode one widened SUM directly into its one fresh public Decimal. */
export function materializePhysicalWidenedSum(
  value: unknown,
  descriptor: DecimalDescriptor,
  representation: DecimalPhysicalRepresentation
): Decimal | undefined {
  return representation === "text"
    ? materializeProviderText(value, descriptor.scale)
    : materializeCoefficientAtPrecision(value, descriptor.scale);
}

// =============================================================================
// THE TWO DDL RENDERINGS
// =============================================================================

/** The dialects that spell a fixed decimal, in `NativeType["db"]` vocabulary. */
export type DecimalDialect = "pg" | "mysql" | "sqlite";

// =============================================================================
// PROVIDER PHYSICAL LIMITS
// =============================================================================

/**
 * What each provider can physically store, as one table (plan 3.1).
 *
 * PostgreSQL's `NUMERIC(p,s)` tops out at 1000 digits. MySQL's `DECIMAL(p,s)`
 * tops out at 65 digits with at most 30 after the point, and exact coefficient
 * arithmetic additionally needs `precision + scale <= 65`. SQLite's bound is not
 * a storage limit at all — it stores the unscaled coefficient in an int64 — but
 * the requirement of the one-statement multiply/divide: `precision + scale <=
 * 18` is what makes every in-range rounded result computable without
 * overflowing the intermediate, and 18 digits is also the widest literal
 * SQLite's own parser reads as an integer rather than as a REAL, which is what
 * the descriptor's range CHECK is written in.
 *
 * A descriptor is syntactically valid at model construction regardless: a
 * schema valid for PostgreSQL stays a valid model graph, and only BINDING it to
 * a provider that cannot store it fails.
 */
const PROVIDER_LIMITS: Record<
  DecimalDialect,
  { readonly precision: number; readonly scale: number; readonly sum?: number }
> = {
  pg: { precision: 1000, scale: 1000 },
  mysql: { precision: 65, scale: 30, sum: 65 },
  sqlite: { precision: 18, scale: 18, sum: 18 },
};

/**
 * Why this provider cannot store this descriptor, or `undefined` when it can.
 *
 * One sentence per failing bound, naming the descriptor, the provider and the
 * limit — the caller adds the field. It is a lookup, not a policy: the numbers
 * live here beside every other decimal fact, and the ONE caller is the schema
 * bind boundary, which asks once per decimal field before any provider I/O.
 */
export function describeProviderLimitRefusal(
  dialect: DecimalDialect,
  descriptor: DecimalDescriptor
): string | undefined {
  const limit = PROVIDER_LIMITS[dialect];
  const { precision, scale } = descriptor;
  const named = `precision ${precision}, scale ${scale}`;
  if (precision > limit.precision) {
    return `${named} exceeds this provider's maximum precision of ${limit.precision}`;
  }
  if (scale > limit.scale) {
    return `${named} exceeds this provider's maximum scale of ${limit.scale}`;
  }
  if (limit.sum !== undefined && precision + scale > limit.sum) {
    return `${named} needs precision + scale <= ${limit.sum} on this provider, which is what makes its one-statement exact multiply and divide representable`;
  }
  return undefined;
}

/**
 * The physical column type for this descriptor.
 *
 * SQLite has no exact decimal type — `DECIMAL(10,5)` is only a NUMERIC-affinity
 * spelling whose numbers it ignores — so it stores the signed integer
 * coefficient and the migration driver adds the range check that makes the
 * declared precision real.
 *
 * No space after the comma, on every dialect: the emitted text is compared by
 * the differ, so one descriptor has one spelling.
 */
export function decimalColumnType(
  dialect: DecimalDialect,
  descriptor: DecimalDescriptor
): string {
  const { precision, scale } = descriptor;
  if (dialect === "pg") return `NUMERIC(${precision},${scale})`;
  if (dialect === "mysql") return `DECIMAL(${precision},${scale})`;
  return "INTEGER";
}

/**
 * The DDL literal for a default, which is a DIFFERENT rendering from canonical
 * text and the reason both belong to one owner.
 *
 * PostgreSQL and MySQL take the logical value at EXACTLY `scale` fractional
 * digits, because that is what MySQL reads back from `information_schema` for a
 * `DECIMAL(p,s)` column default: emitting canonical `1.2` for a scale-5 column
 * and then reading `1.20000` would make the differ see a change on every push.
 * SQLite takes the coefficient, the same integer the column stores.
 */
export function decimalDefaultText(
  dialect: DecimalDialect,
  canonical: string,
  descriptor: DecimalDescriptor
): string {
  if (dialect === "sqlite") {
    return logicalToCoefficient(canonical, descriptor.scale);
  }
  const negative = canonical.startsWith("-");
  const [integer, fraction] = splitCanonical(canonical);
  const scaled =
    descriptor.scale === 0
      ? integer
      : `${integer}.${fraction.padEnd(descriptor.scale, "0")}`;
  return negative ? `-${scaled}` : scaled;
}

/**
 * The physical value of one trusted literal decimal-list default.
 *
 * PostgreSQL owns a native numeric array, so every logical member is padded to
 * the declared scale just like a scalar DDL default. MySQL and the SQLite
 * family own coefficient-string JSON containers, exactly like their runtime
 * list writes. This codec renders the VALUE only; migration drivers still own
 * string quoting and provider expression syntax.
 */
export function decimalListDefaultText(
  dialect: DecimalDialect,
  canonicals: readonly string[],
  descriptor: DecimalDescriptor
): string {
  if (dialect !== "pg") {
    return encodeDecimalListContainer(canonicals, descriptor.scale);
  }
  const members = new Array<string>(canonicals.length);
  for (const [index, canonical] of canonicals.entries()) {
    members[index] = decimalDefaultText("pg", canonical, descriptor);
  }
  return `{${members.join(",")}}`;
}

// =============================================================================
// THE JSON LIST CONTAINER
// =============================================================================

/**
 * The physical container for a decimal list on the JSON-backed providers:
 * a JSON array of unscaled coefficient STRINGS.
 *
 * Strings, never JSON numeric tokens — JavaScript and D1 both round integers
 * above 2^53, so a numeric token is a silently wrong member rather than a
 * bigger one.
 */
export function encodeDecimalListContainer(
  canonicals: readonly string[],
  scale: number
): string {
  const members = new Array<string>(canonicals.length);
  for (const [index, canonical] of canonicals.entries()) {
    members[index] = encodePhysicalDecimalAtScale(
      canonical,
      scale,
      "coefficient"
    );
  }
  return JSON.stringify(members);
}

/**
 * The canonical logical members of a physical list container, or `undefined`
 * when the container is not one this codec wrote: malformed JSON, a non-array
 * top level, a numeric token, `null`, or a member outside the coefficient
 * grammar. Order and multiplicity are preserved exactly.
 */
export function decodeDecimalListContainer(
  container: unknown,
  scale: number
): string[] | undefined {
  return decodeDecimalListContainerAtPrecision(container, scale);
}

function decodeDecimalListContainerAtPrecision(
  container: unknown,
  scale: number,
  precision?: number
): string[] | undefined {
  if (!isString(container)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(container);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const members = new Array<string>(parsed.length);
  for (const [index, member] of parsed.entries()) {
    if (!(isString(member) && scanCoefficient(member, precision))) {
      return undefined;
    }
    members[index] = renderCoefficientLogical(member, scale);
  }
  return members;
}
