import { inferred } from "../inferred";
import type {
  VibSchema,
  InferOutputShape,
  InferInputShape,
  ThunkCast,
  InferOutput,
  InferInput,
  Prettify,
} from "../types";
import { fail, ok, createSchema, validateSchema } from "../helpers";

// =============================================================================
// Object Schema Types
// =============================================================================

/**
 * Object entries - a record of field names to schemas or thunks.
 */
export type ObjectEntries = Record<
  string,
  VibSchema<any, any> | ThunkCast<any, any>
>;

/**
 * Options for object schemas.
 */
export interface ObjectOptions<T = unknown> {
  /** Make all fields optional (default: true) */
  partial?: boolean;
  /** Reject unknown keys (default: true) */
  strict?: boolean;
  /** Make the object itself optional (undefined allowed) */
  optional?: boolean;
  /** Make the object itself nullable (null allowed) */
  nullable?: boolean;
  /** Validate as array of objects */
  array?: boolean;
  /** Default value when undefined/null */
  default?: T | (() => T);
  /** Transform output */
  transform?: (value: T) => T;
}

/**
 * Compute input type based on partial option.
 * Default is partial: true, so only non-partial when explicitly { partial: false }
 */
type ComputeObjectInput<TEntries, TOpts> = TOpts extends { partial: false }
  ? InferInputShape<TEntries>
  : Partial<InferInputShape<TEntries>>;

/**
 * Compute output type based on partial option.
 * Default is partial: true, so only non-partial when explicitly { partial: false }
 */
type ComputeObjectOutput<TEntries, TOpts> = TOpts extends { partial: false }
  ? InferOutputShape<TEntries>
  : Partial<InferOutputShape<TEntries>>;

/**
 * Apply wrapper options (optional, nullable, array) to object type.
 */
type ApplyObjectOptions<TBase, TOpts> = TOpts extends { array: true }
  ? TOpts extends { optional: true }
    ? TOpts extends { nullable: true }
      ? TBase[] | undefined | null
      : TBase[] | undefined
    : TOpts extends { nullable: true }
    ? TBase[] | null
    : TBase[]
  : TOpts extends { optional: true }
  ? TOpts extends { nullable: true }
    ? TBase | undefined | null
    : TBase | undefined
  : TOpts extends { nullable: true }
  ? TBase | null
  : TBase;

/**
 * Object schema interface.
 */
export interface ObjectSchema<
  TEntries,
  TOpts = undefined,
  TInput = ApplyObjectOptions<ComputeObjectInput<TEntries, TOpts>, TOpts>,
  TOutput = ApplyObjectOptions<ComputeObjectOutput<TEntries, TOpts>, TOpts>
> extends VibSchema<TInput, TOutput> {
  readonly type: "object";
  readonly entries: TEntries;
  readonly options: TOpts;
}

// =============================================================================
// Object Schema Implementation
// =============================================================================

// Pre-computed error for fast path
const OBJECT_TYPE_ERROR = Object.freeze({
  issues: Object.freeze([Object.freeze({ message: "Expected object" })]),
});

/**
 * Resolve a schema entry (handles thunks for circular references).
 */
function resolveEntry(
  entry: VibSchema<any, any> | ThunkCast<any, any>
): VibSchema<any, any> {
  return typeof entry === "function" ? (entry() as VibSchema<any, any>) : entry;
}

/**
 * Create an optimized validator for an object schema.
 * Pre-computes keys and caches resolved schemas for performance.
 */
function createObjectValidator(
  entries: ObjectEntries,
  options: ObjectOptions = {}
) {
  const { partial = true, strict = true } = options;
  const keys = Object.keys(entries);
  const keyCount = keys.length;

  // Cache for resolved schemas (lazy resolution for circular refs)
  let resolvedSchemas: VibSchema<any, any>[] | null = null;

  const getResolvedSchemas = () => {
    if (resolvedSchemas === null) {
      resolvedSchemas = new Array(keyCount);
      for (let i = 0; i < keyCount; i++) {
        resolvedSchemas[i] = resolveEntry(entries[keys[i]!]!);
      }
    }
    return resolvedSchemas;
  };

  // Pre-create key set for O(1) lookup
  const keySet = new Set(keys);

  return (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return OBJECT_TYPE_ERROR;
    }

    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = Object.create(null);
    const schemas = getResolvedSchemas();

    // Check for unknown keys first if strict (fail-fast)
    if (strict) {
      for (const key in input) {
        if (!keySet.has(key)) {
          return fail(`Unknown key: ${key}`, [key]);
        }
      }
    }

    // Validate each entry using indexed access (faster than for...in)
    for (let i = 0; i < keyCount; i++) {
      const key = keys[i]!;
      const entrySchema = schemas[i]!;

      // Check if field is present
      if (!(key in input)) {
        // Try validating undefined - if schema accepts it, use result
        const undefinedResult = validateSchema(entrySchema, undefined);
        if (!undefinedResult.issues) {
          output[key] = (undefinedResult as { value: unknown }).value;
          continue;
        }

        // If partial mode, allow undefined
        if (partial) {
          output[key] = undefined;
          continue;
        }

        return fail(`Missing required field: ${key}`, [key]);
      }

      const result = validateSchema(entrySchema, input[key]);
      if (result.issues) {
        const issue = result.issues[0]!;
        const newPath = issue.path
          ? ([key] as PropertyKey[]).concat(issue.path)
          : [key];
        return fail(issue.message, newPath);
      }
      output[key] = (result as { value: unknown }).value;
    }

    return ok(output);
  };
}

/**
 * Create an object schema.
 *
 * IMPORTANT: No constraint on TEntries to allow circular reference resolution.
 * The identity conditional (R extends infer _ ? _ : never) defers type evaluation.
 *
 * @param entries - Object field definitions
 * @param options - Schema options
 *   - `strict` (default: true) - Reject unknown keys
 *   - `partial` (default: true) - Make all fields optional
 *   - `optional` - Allow undefined
 *   - `nullable` - Allow null
 *   - `array` - Validate as array of objects
 *   - `default` - Default value
 *   - `transform` - Transform output
 *
 * @example
 * // Basic object (strict by default)
 * const user = v.object({
 *   name: v.string(),
 *   age: v.number(),
 * });
 *
 * // Circular references
 * const node = v.object({
 *   value: v.string(),
 *   child: () => node,  // Thunk
 * });
 */
export function object<
  TEntries, // NO constraint - critical for circular references
  const TOpts extends ObjectOptions | undefined = undefined,
  R = ObjectSchema<TEntries, TOpts>
>(entries: TEntries, options?: TOpts): R extends infer _ ? _ : never {
  type BaseOutput = ComputeObjectOutput<TEntries, TOpts>;

  // Pre-create the optimized object validator (caches keys and schemas)
  const validateObj = createObjectValidator(entries as ObjectEntries, options);

  // Check if we have wrapper options (optional/nullable/array)
  const hasOptional = options?.optional === true;
  const hasNullable = options?.nullable === true;
  const hasArray = options?.array === true;
  const hasTransform = options?.transform !== undefined;
  const hasDefault = options?.default !== undefined;

  // Fast path: no wrapper options (most common case)
  const needsWrapper =
    hasOptional || hasNullable || hasArray || hasTransform || hasDefault;

  let validate: (value: unknown) => any;

  if (!needsWrapper) {
    // Fast path: direct object validation
    validate = validateObj;
  } else {
    // Slow path: handle wrapper options
    validate = (value: unknown) => {
      // Handle optional
      if (hasOptional && value === undefined) {
        if (hasDefault) {
          const defaultVal =
            typeof options!.default === "function"
              ? (options!.default as () => BaseOutput)()
              : options!.default;
          return ok(defaultVal);
        }
        return ok(undefined);
      }

      // Handle nullable
      if (hasNullable && value === null) {
        if (hasDefault) {
          const defaultVal =
            typeof options!.default === "function"
              ? (options!.default as () => BaseOutput)()
              : options!.default;
          return ok(defaultVal);
        }
        return ok(null);
      }

      // Handle array
      if (hasArray) {
        if (!Array.isArray(value)) {
          return fail(`Expected array of objects, received ${typeof value}`);
        }

        const len = value.length;
        const results = new Array<BaseOutput>(len);

        for (let i = 0; i < len; i++) {
          const itemResult = validateObj(value[i]);
          if (itemResult.issues) {
            const issue = itemResult.issues[0]!;
            const newPath = issue.path
              ? ([i] as PropertyKey[]).concat(issue.path)
              : [i];
            return fail(issue.message, newPath);
          }
          results[i] = hasTransform
            ? options!.transform!(itemResult.value)
            : itemResult.value;
        }
        return ok(results);
      }

      // Single object validation
      const result = validateObj(value);
      if (result.issues) {
        return result;
      }

      return hasTransform
        ? // @ts-expect-error - transform type is complex with options generics
          ok(options!.transform!(result.value))
        : result;
    };
  }

  const schema = createSchema("object", validate) as ObjectSchema<
    TEntries,
    TOpts
  >;

  (schema as any).entries = entries;
  (schema as any).options = options;

  return schema as R extends infer _ ? _ : never;
}
