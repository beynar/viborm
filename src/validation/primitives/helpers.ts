import type { StandardSchemaV1 } from "@standard-schema/spec";
import { createJsonSchemaConverter } from "../json-schema/factory";
import { discardAsyncValidationResult } from "../parse-failure";
import type {
  ComputeInput,
  ComputeOutput,
  ScalarOptions,
  ValidationFailure,
  ValidationIssue,
  ValidationResult,
  VibSchema,
} from "../types";
import { isFunction } from "../value-guards";
import { canonicalizeId, describeIdDomain, type IdDomain } from "./id-codec";

// =============================================================================
// Core Validation Primitives
// =============================================================================

/**
 * Create a failure result with a single issue.
 */
export function fail(
  message: string,
  path?: PropertyKey[]
): ValidationResult<never> {
  const issue: ValidationIssue =
    path && path.length > 0 ? { message, path } : { message };
  return { issues: [issue] };
}

/**
 * Whether the parse in progress reports EVERY issue instead of the first. Set
 * by {@link reportingAllIssues} for one synchronous parse and restored in its
 * `finally`, like `parseProviding`'s context. Read only on a failure path, so
 * a parse that succeeds never pays for the mode.
 */
let allIssues = false;

/** Does the parse in progress collect every issue? */
export const collectingAllIssues = (): boolean => allIssues;

/** Run `parse` with the all-issues mode set to `collect`, then restore it. */
export function reportingAllIssues<T>(collect: boolean, parse: () => T): T {
  const outer = allIssues;
  allIssues = collect;
  try {
    return parse();
  } finally {
    allIssues = outer;
  }
}

/** A member's issues, re-rooted under `key`: only the first unless collecting. */
export function issuesUnder(
  key: PropertyKey,
  issues: readonly ValidationIssue[]
): ValidationIssue[] {
  const reported = allIssues ? issues : issues.slice(0, 1);
  return reported.map((issue) => ({
    message: issue.message,
    path: issue.path ? [key, ...issue.path] : [key],
  }));
}

/**
 * Create a success result.
 */
export function ok<T>(value: T): ValidationResult<T> {
  return { value };
}

/** Copy Standard Schema issues into VibORM's property-key path representation. */
export function standardSchemaFailure(
  issues: readonly StandardSchemaV1.Issue[]
): ValidationFailure {
  return {
    issues: issues.map((issue) => {
      if (issue.path === undefined) return { message: issue.message };
      return {
        message: issue.message,
        path: issue.path.map((segment) =>
          typeof segment === "object" ? segment.key : segment
        ),
      };
    }),
  };
}

// =============================================================================
// Set Theory Optimized Validators
// =============================================================================

// Pre-allocated error objects (avoid allocation in hot path)
const ARRAY_TYPE_ERROR = Object.freeze({
  issues: Object.freeze([Object.freeze({ message: "Expected array" })]),
});

// Pre-allocated null/undefined results for fast paths
export const OK_NULL = Object.freeze({ value: null });
export const OK_UNDEFINED = Object.freeze({ value: undefined });

/**
 * Validate array items with the provided validator.
 * Shared by the array() wrapper, options.array and every other list walk.
 */
export function validateArray<T>(
  value: unknown,
  validate: (v: unknown) => StandardSchemaV1.Result<T>
): ValidationResult<T[]> {
  try {
    if (!Array.isArray(value)) {
      return ARRAY_TYPE_ERROR;
    }
  } catch {
    return fail("Could not inspect array");
  }

  let len: number;
  try {
    len = value.length;
  } catch {
    return fail("Could not read array length");
  }
  if (!Number.isInteger(len) || len < 0) {
    return ARRAY_TYPE_ERROR;
  }
  if (len === 0) return ok([]);

  const results = new Array<T>(len);
  let issues: ValidationIssue[] | undefined;
  for (let i = 0; i < len; i++) {
    let member: unknown;
    try {
      member = value[i];
    } catch {
      return fail("Could not read array member", [i]);
    }
    const r = validate(member);
    if (r.issues) {
      const rooted = issuesUnder(i, r.issues as readonly ValidationIssue[]);
      if (!allIssues) return { issues: rooted };
      (issues ??= []).push(...rooted);
      continue;
    }
    results[i] = (r as { value: T }).value;
  }
  return issues ? { issues } : ok(results);
}

type ValidatorFn<T> = (value: unknown) => ValidationResult<T>;

// =============================================================================
// Factories with Default (for optional + default cases)
// =============================================================================

/**
 * Resolve a default when undefined, contain a throwing factory, and pass the
 * resolved value through the already-composed field validator.
 */
function createOptionalWithDefault<T>(
  validate: ValidatorFn<T>,
  getDefault: () => unknown
): ValidatorFn<T> {
  return (val) => {
    if (val !== undefined) return validate(val);
    let resolved: unknown;
    try {
      resolved = getDefault();
    } catch (error) {
      return fail(`Default failed: ${describeDefaultFailure(error)}`);
    }
    return validate(resolved);
  };
}

/** Render hostile thrown values without letting their coercion escape. */
function describeDefaultFailure(error: unknown): string {
  try {
    return String(error instanceof Error ? error.message : error);
  } catch {
    return "unrenderable thrown value";
  }
}

// =============================================================================
// Optimized Validator Builder (Set Theory + Composition)
// =============================================================================

/** `next` on the value `prev` admitted; `prev`'s issues otherwise. */
function thenValidate(
  prev: ValidatorFn<unknown>,
  next: ValidatorFn<unknown>
): ValidatorFn<unknown> {
  return (value) => {
    const result = prev(value);
    return result.issues ? result : next(result.value);
  };
}

/** The canonical member of `domain`, or its "Expected <domain>" refusal. */
function idDomainAdmission(domain: IdDomain): ValidatorFn<string> {
  const expected = `Expected ${describeIdDomain(domain)}`;
  return (value) => {
    const canonical = canonicalizeId(value, domain);
    return canonical === undefined ? fail(expected) : ok(canonical);
  };
}

/**
 * Build an optimized validator at schema creation time.
 * Uses set theory approach for nullable/optional/array/default combinations.
 *
 * @param baseValidate - The base type validator
 * @param options - Schema options
 * @param typeName - The scalar representation that must survive transforms
 */
export function buildValidator<T, TOut, TSchemaOut = T>(
  baseValidate: ValidatorFn<T>,
  options: ScalarOptions<T, TOut, TSchemaOut> | undefined,
  typeName: string
): ValidatorFn<TOut> {
  // Fast path: no options at all
  if (!options) {
    return baseValidate as unknown as ValidatorFn<TOut>;
  }

  const {
    nullable,
    optional,
    array,
    default: defaultVal,
    transform,
    schema,
    disallowZero,
    idDomain,
  } = options;

  // Check what we have
  const hasDefault = defaultVal !== undefined;
  const hasTransform = transform !== undefined;

  // Build the core validator (base + schema + transform chain)
  let validate: ValidatorFn<any> = baseValidate;

  if (disallowZero) validate = refusingZero(validate);

  // The identifier domain is the first AND the last word on the value.
  // First, before the custom schema and the transform: a `.schema()` a caller
  // attached to a `.uuid()` field reads the canonical spelling. Last, after
  // that schema: its output is the caller's code — a Standard Schema may
  // return any string — so it crosses the domain again, where an alias it
  // returns folds and a value outside the domain is refused with the same
  // "Expected <domain>" an input gets, at admission rather than at the
  // binding. Every identity-sensitive consumer downstream — cache key,
  // captured row key, `fkEquals` — reads the one spelling that leaves, and
  // `canonicalizeId` is the only place an alias is folded. A transform never
  // meets a domain: `scalars/string.ts` is the one caller that passes
  // `idDomain`, and a field state carries no transform.
  const admitIdDomain =
    idDomain === undefined ? undefined : idDomainAdmission(idDomain);
  if (admitIdDomain) validate = thenValidate(validate, admitIdDomain);

  // Chain custom schema validation (if any)

  if (schema !== undefined)
    validate = withCustomSchema(validate, schema, admitIdDomain);

  // Chain transform (if any)
  if (hasTransform) validate = withTransform(validate, transform!);
  // A custom JSON schema may transform its input, but the persisted result
  // must still be JSON. Validate the new representation before any write.
  if (typeName === "json" && (hasTransform || schema !== undefined))
    validate = thenValidate(validate, baseValidate);

  // Compose the complete field validator before the default trigger. A
  // resolved literal or factory value is an ordinary untrusted field value:
  // it crosses scalar/custom/transform, member-array, and nullability rules in
  // exactly the same order as an explicit input.

  if (array) {
    const itemValidator = validate;
    validate = (val) => validateArray(val, itemValidator);
  }

  if (nullable) {
    const nonNullValidate = validate;
    validate = (val) => (val === null ? OK_NULL : nonNullValidate(val));
  }

  if (hasDefault) {
    // Compute default getter once
    const getDefault = isFunction(defaultVal)
      ? (defaultVal as () => any)
      : () => defaultVal;

    return createOptionalWithDefault(validate, getDefault) as ValidatorFn<TOut>;
  }

  // Nullability is already part of the composed validator. Only optionality
  // remains when no default consumes undefined.
  if (optional) {
    const requiredValidate = validate;
    validate = (val) =>
      val === undefined ? OK_UNDEFINED : requiredValidate(val);
  }

  return validate as ValidatorFn<TOut>;
}

// The rarely declared field options, each composed by its own function so a
// field without them never compiles their setup.

function refusingZero(prev: ValidatorFn<any>): ValidatorFn<any> {
  return (value): ValidationResult<any> => {
    const result = prev(value);
    if (result.issues) return result;
    const validated = (result as { value: unknown }).value;
    if (validated === 0 || validated === 0n) {
      return fail("Explicit zero is not portable for an auto-increment field");
    }
    return result;
  };
}

function withCustomSchema(
  prev: ValidatorFn<any>,
  schema: NonNullable<ScalarOptions<any, any>["schema"]>,
  admitIdDomain: ValidatorFn<any> | undefined
): ValidatorFn<any> {
  const schemaValidate = schema["~standard"].validate;
  const validate: ValidatorFn<any> = (v): ValidationResult<any> => {
    const r = prev(v);
    if (r.issues) return r;
    const sr = schemaValidate(r.value);
    if ("then" in sr) {
      discardAsyncValidationResult(sr);
      return fail("Async schemas are not supported");
    }
    if (sr.issues) return standardSchemaFailure(sr.issues);
    return ok(sr.value);
  };
  return admitIdDomain ? thenValidate(validate, admitIdDomain) : validate;
}

function withTransform(
  prev: ValidatorFn<any>,
  fn: (value: any) => any
): ValidatorFn<any> {
  return (v) => {
    const r = prev(v);
    if (r.issues) return r;
    try {
      return ok(fn((r as { value: any }).value));
    } catch (error) {
      return fail(
        `Transform failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };
}

// =============================================================================
// Schema Builder (Returns complete schema object)
// =============================================================================

/**
 * Build a complete schema object with optimized validator.
 * This is the main entry point for creating scalar schemas.
 *
 * @param type - Schema type name
 * @param baseValidate - The base type validator
 * @param options - Schema options
 * @param extras - Additional properties to add to the schema (e.g., `value` for literal)
 */
export function buildSchema<
  T,
  const Opts extends ScalarOptions<T, any> | undefined,
  TExtras extends Record<string, unknown> = Record<never, never>,
>(
  type: string,
  baseValidate: ValidatorFn<T>,
  options: Opts,
  extras?: TExtras
): VibSchema<ComputeInput<T, Opts>, ComputeOutput<T, Opts>> &
  TExtras & { type: string; options: Opts; acceptsUndefined: boolean } {
  // Pre-compute whether this schema accepts undefined
  // True if: optional, or has a default value
  const acceptsUndefined =
    options?.optional === true || options?.default !== undefined;

  // `createSchema` owns the Standard Schema carrier and its lazy JSON Schema
  // converter; a scalar adds only its options and wrapper metadata.
  return Object.assign(
    createSchema<ComputeInput<T, Opts>, ComputeOutput<T, Opts>>(
      type,
      buildValidator(baseValidate, options, type)
    ),
    { options, acceptsUndefined, ...extras }
  ) as VibSchema<ComputeInput<T, Opts>, ComputeOutput<T, Opts>> &
    TExtras & { options: Opts; type: string; acceptsUndefined: boolean };
}

/**
 * Create a StandardSchema-compatible schema object.
 */
export function createSchema<TInput, TOutput>(
  type: string,
  validate: (value: unknown) => ValidationResult<TOutput>
): VibSchema<TInput, TOutput> {
  const schema = {
    type,
    "~standard": {
      version: 1 as const,
      vendor: "viborm" as const,
      validate,
      // Lazy jsonSchema - converter is created when first accessed
      get jsonSchema() {
        const converter = createJsonSchemaConverter(
          schema as unknown as VibSchema<unknown, unknown>
        );
        // Replace getter with static value for subsequent access
        Object.defineProperty(this, "jsonSchema", {
          value: converter,
          writable: false,
          enumerable: true,
        });
        return converter;
      },
    },
  };

  // Add the inferred property for type branding
  Object.defineProperty(schema, " vibInferred", {
    value: undefined,
    enumerable: false,
  });

  return schema as VibSchema<TInput, TOutput>;
}

/**
 * Validate a value against a StandardSchema.
 */
export function validateSchema<const S extends StandardSchemaV1>(
  schema: S,
  value: unknown
): ValidationResult<StandardSchemaV1.InferOutput<S>> {
  const result = schema["~standard"].validate(value);
  if ("then" in result) {
    discardAsyncValidationResult(result);
    return fail("Async schemas are not supported");
  }
  if (result.issues) {
    return standardSchemaFailure(result.issues);
  }
  return ok((result as { value: StandardSchemaV1.InferOutput<S> }).value);
}
