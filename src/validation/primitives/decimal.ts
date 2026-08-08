import type {
  ComputeInput,
  ComputeOutput,
  ScalarOptions,
  ValidationResult,
  VibSchema,
} from "../types";
import { isBigInt, isNumber, isString } from "../value-guards";
import { buildSchema, ok } from "./helpers";

// =============================================================================
// Decimal Schema
// =============================================================================

/**
 * What a decimal accepts on the way IN.
 *
 * A `string` is the exact spelling and the only lossless option. A `number` is
 * a convenience: it is accepted, but a JS number is a double, so whatever float
 * error the caller already introduced (`0.1 + 0.2`) travels in with it — we
 * bind the double's own shortest exact spelling rather than pretend otherwise.
 */
export type DecimalInput = string | number;

/** What a decimal reads back as: the canonical spelling, exact at any precision. */
export type DecimalOutput = string;

export interface DecimalSchema<TInput = DecimalInput, TOutput = DecimalOutput>
  extends VibSchema<TInput, TOutput> {
  readonly type: "decimal";
}

/**
 * The accepted literal grammar: optional sign, decimal digits, at most one dot,
 * at least one digit overall. Deliberately NO exponent — `1e3` is a float
 * spelling, and admitting it would mean admitting `1e400` and the rounding
 * question that comes with it. Deliberately no whitespace, no `NaN`, no
 * `Infinity`: none of them name an exact decimal.
 */
const DECIMAL_LITERAL_REGEX = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

const DECIMAL_ERROR = Object.freeze({
  issues: Object.freeze([
    Object.freeze({
      message:
        "Expected an exact decimal: a string like '-12.345' (sign, digits, at most one dot, no exponent) or a finite number",
    }),
  ]),
});

const LEADING_ZEROS_REGEX = /^0+/;
const TRAILING_ZEROS_REGEX = /0+$/;
const LEADING_SIGN_REGEX = /^[+-]/;

/**
 * Reduce a valid decimal literal to its ONE canonical spelling: no leading `+`,
 * no insignificant leading or trailing zeros, no bare `-0`, no dangling dot.
 *
 * Canonicalization is not cosmetic. It is what lets SQLite — which has no exact
 * decimal type and must store the value as text — answer `equals`/`in` exactly:
 * once every value has a single spelling, text equality IS numeric equality.
 * It also makes `"1.10"` and `"1.1"` the same value on every dialect.
 */
function canonicalizeLiteral(literal: string): string {
  const negative = literal.startsWith("-");
  const unsigned = literal.replace(LEADING_SIGN_REGEX, "");
  const [rawInteger = "", rawFraction = ""] = unsigned.split(".");
  const integer = rawInteger.replace(LEADING_ZEROS_REGEX, "");
  const fraction = rawFraction.replace(TRAILING_ZEROS_REGEX, "");
  const whole = integer === "" ? "0" : integer;
  // Zero has no sign: '-0.000' and '0' are the same number, so they get the
  // same spelling — otherwise SQLite's text equality would split them apart.
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
 * The canonical decimal spelling of a `string | number | bigint`, or `undefined`
 * when the value does not name an exact decimal.
 *
 * A number is rendered through `String(n)`, the shortest decimal that round-trips
 * back to the same double — the same spelling JS itself shows and the same one
 * `decimal.js` derives from a number. It is a faithful name for the double the
 * caller handed over; it does not invent precision the double never had, and it
 * does not launder float error the caller already committed.
 */
export function canonicalizeDecimal(value: unknown): string | undefined {
  if (isString(value)) {
    return DECIMAL_LITERAL_REGEX.test(value)
      ? canonicalizeLiteral(value)
      : undefined;
  }
  if (isNumber(value)) {
    if (!Number.isFinite(value)) return undefined;
    const text = String(value);
    const expanded =
      text.includes("e") || text.includes("E")
        ? expandExponentForm(text)
        : text;
    return canonicalizeLiteral(expanded);
  }
  if (isBigInt(value)) {
    return canonicalizeLiteral(String(value));
  }
  return undefined;
}

/**
 * Validate a decimal and NORMALIZE it to its canonical string in one step, so
 * everything downstream — binding, SQL comparison, storage — sees one spelling.
 */
function validateDecimal(value: unknown): ValidationResult<string> {
  const canonical = canonicalizeDecimal(value);
  return canonical === undefined
    ? (DECIMAL_ERROR as ValidationResult<string>)
    : ok(canonical);
}

/**
 * Create a decimal schema: exact decimal in, canonical decimal string out.
 *
 * @example
 * const price = v.decimal();
 * const optionalPrice = v.decimal({ optional: true });
 */
export function decimal(): DecimalSchema<DecimalInput, DecimalOutput>;
export function decimal<const Opts extends ScalarOptions<DecimalInput, any>>(
  options: Opts
): DecimalSchema<
  ComputeInput<DecimalInput, Opts>,
  ComputeOutput<DecimalOutput, Opts>
>;
export function decimal<
  const Opts extends ScalarOptions<DecimalInput, any> | undefined,
>(
  options?: Opts
): DecimalSchema<
  ComputeInput<DecimalInput, Opts>,
  ComputeOutput<DecimalOutput, Opts>
> {
  // The input and output types differ (string | number in, string out), which
  // buildSchema's single-T signature cannot express — it threads ONE type
  // through both the options and the result. The runtime is exactly
  // buildSchema's; only the two computed sides are named separately here.
  return buildSchema(
    "decimal",
    validateDecimal,
    options as ScalarOptions<string, any> | undefined
  ) as unknown as DecimalSchema<
    ComputeInput<DecimalInput, Opts>,
    ComputeOutput<DecimalOutput, Opts>
  >;
}

export { validateDecimal };
