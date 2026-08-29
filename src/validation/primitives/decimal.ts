import type Decimal from "decimal.js";
import type {
  ComputeInput,
  ComputeOutput,
  ScalarOptions,
  ValidationFailure,
  ValidationResult,
  VibSchema,
} from "../types";
import {
  canonicalizeDecimal,
  canonicalizeDecimalValue,
  type DecimalDescriptor,
  describeDescriptorRefusal,
  toDecimal,
} from "./decimal-codec";
import { buildSchema, fail, ok, standardSchemaFailure } from "./helpers";

// =============================================================================
// Decimal Schema
// =============================================================================

/**
 * What a decimal accepts on the way IN.
 *
 * A `Decimal` is the public value type and the exact one. A `string` is its
 * lossless spelling. A `number` is a convenience: it is accepted, but a JS
 * number is a double, so whatever float error the caller already introduced
 * (`0.1 + 0.2`) travels in with it — we name the double's own shortest exact
 * spelling rather than pretend otherwise, and the field's scale then refuses it.
 */
export type DecimalInput = Decimal | string | number;

/**
 * What a VALIDATED decimal is inside the engine: the canonical private string.
 *
 * This is not a public result mode. It is the one logical representation SQL
 * binding, cursors, row keys, cache keys, race pins, and link folds all key on,
 * because two distinct `Decimal` instances naming the same number must be the
 * same identity. The public `Decimal` is constructed once per selected value at
 * the typed result boundary, never here.
 */
export type DecimalOutput = string;

/**
 * Decimal schema options: the ordinary scalar options plus the field's declared
 * fixed-decimal domain. The domain is optional at this level because the
 * primitive is also the unconstrained value grammar the codec is built on; the
 * PUBLIC surface, `s.decimal({ precision, scale })`, always declares one.
 */
export interface DecimalOptions<TSchemaOut = Decimal>
  extends ScalarOptions<Decimal, DecimalOutput, TSchemaOut> {
  decimal?: DecimalDescriptor | undefined;
}

/**
 * A custom `.schema()` REFINES the Decimal the base already built; it does not
 * redefine what the field accepts or what the pipeline emits. So neither
 * computed side may take its types from the schema the way every other scalar's
 * does: input stays `Decimal | string | number`, output stays canonical text.
 */
type DecimalValueOptions<Opts> =
  Opts extends ScalarOptions<any, any, any>
    ? Omit<Opts, "schema"> & { schema?: undefined }
    : undefined;

type ReadonlyDecimalList<T> = T extends DecimalInput[]
  ? readonly DecimalInput[]
  : T;

export type DecimalComputeInput<Opts> = ReadonlyDecimalList<
  ComputeInput<DecimalInput, DecimalValueOptions<Opts>>
>;

export type DecimalComputeOutput<Opts> = ComputeOutput<
  DecimalOutput,
  DecimalValueOptions<Opts>
>;

export interface DecimalSchema<TInput = DecimalInput, TOutput = DecimalOutput>
  extends VibSchema<TInput, TOutput> {
  readonly type: "decimal";
  readonly acceptsUndefined: boolean;
  readonly options:
    | { readonly decimal?: DecimalDescriptor | undefined }
    | undefined;
}

const DECIMAL_ERROR: ValidationFailure = Object.freeze({
  issues: Object.freeze([
    Object.freeze({
      message:
        "Expected an exact decimal: a Decimal, a string like '-12.345' (sign, digits, at most one dot, no exponent), or a finite number",
    }),
  ]),
});

const DECIMAL_VALUE_ERROR =
  "Expected a complete bounded finite Decimal.js numerical representation: a custom decimal schema may refine or brand the value it is given, but not return a string, number, tag-only or incomplete decimal-like object, NaN, or infinity";

/**
 * Validate a decimal and NORMALIZE it to its canonical string in one step, so
 * everything downstream — binding, SQL comparison, identity, storage — sees one
 * spelling.
 */
function validateDecimal(value: unknown): ValidationResult<string> {
  const canonical = canonicalizeDecimal(value);
  return canonical === undefined ? DECIMAL_ERROR : ok(canonical);
}

/**
 * The decimal's own validator chain, built HERE rather than composed by
 * `buildValidator`'s option handling, because the ORDER is the contract:
 *
 *   base (exact grammar, canonical text)
 *     -> the custom schema, which observes a real `Decimal` (plan 2.3)
 *     -> the DESCRIPTOR, last, on whatever that schema returned
 *
 * `buildValidator` runs a custom schema after the base and has no hook after
 * it, and validation Rule 4 forbids patching one on afterwards: every decimal
 * filter and update schema is a union, and a union captures each member's
 * `~standard.validate` at construction. So the whole value chain exists before
 * the schema object does, and `buildValidator` is handed only the
 * nullable/optional/array/default wrapping it uniquely owns.
 */
function buildDecimalValueValidator(
  options: DecimalOptions<any> | undefined
): (value: unknown) => ValidationResult<string> {
  const custom = options?.schema;
  const descriptor = options?.decimal;
  let validate = validateDecimal;

  if (custom !== undefined) {
    const refine = custom["~standard"].validate;
    const base = validate;
    validate = (value) => {
      const parsed = base(value);
      if (parsed.issues) return parsed;
      const refined = refine(toDecimal(parsed.value));
      if ("then" in refined) return fail("Async schemas are not supported");
      if (refined.issues) {
        return standardSchemaFailure(refined.issues);
      }
      const canonical = canonicalizeDecimalValue(refined.value);
      return canonical === undefined
        ? fail(DECIMAL_VALUE_ERROR)
        : ok(canonical);
    };
  }

  if (descriptor !== undefined) {
    const base = validate;
    validate = (value) => {
      const parsed = base(value);
      if (parsed.issues) return parsed;
      const refusal = describeDescriptorRefusal(parsed.value, descriptor);
      return refusal === undefined ? parsed : fail(refusal);
    };
  }

  return validate;
}

/**
 * Create a decimal schema: exact decimal in, canonical decimal string out.
 *
 * @example
 * const price = v.decimal({ decimal: { precision: 10, scale: 2 } });
 * const optionalPrice = v.decimal({ optional: true });
 */
export function decimal(): DecimalSchema<DecimalInput, DecimalOutput>;
export function decimal<const Opts extends DecimalOptions<any>>(
  options: Opts
): DecimalSchema<DecimalComputeInput<Opts>, DecimalComputeOutput<Opts>>;
export function decimal(options?: DecimalOptions<any>): VibSchema<any, any> {
  // The custom schema is already composed into the value validator above, so it
  // is withheld from the wrapping options — `buildValidator` running it again
  // would re-refine a canonical STRING with a schema that expects a Decimal.
  // Everything the wrappers do own — nullable, optional, array, default —
  // passes through untouched.
  const wrapping =
    options === undefined ? undefined : { ...options, schema: undefined };
  return buildSchema("decimal", buildDecimalValueValidator(options), wrapping);
}

export { validateDecimal };
