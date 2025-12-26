import type {
  VibSchema,
  InferOutputShape,
  InferInputShape,
  ThunkCast,
  InferOutput,
  InferInput,
  Prettify,
} from "../types";
import { fail, ok } from "../helpers";
import { createJsonSchemaConverter } from "../json-schema/factory";
import { StandardSchemaV1 } from "@standard-schema";
import { string } from "./string";

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
  /** Object name for circular references in json schema*/
  name?: string;
  /** Object description for json schema*/
  description?: string;
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
  readonly parse: (
    value: unknown
  ) => StandardSchemaV1.SuccessResult<TOutput> | StandardSchemaV1.FailureResult;
  /** Extend this schema with additional entries */
  extend<TNewEntries extends ObjectEntries>(
    newEntries: TNewEntries
  ): ObjectSchema<
    Prettify<TEntries & TNewEntries>,
    TOpts,
    ApplyObjectOptions<
      ComputeObjectInput<Prettify<TEntries & TNewEntries>, TOpts>,
      TOpts
    >,
    ApplyObjectOptions<
      ComputeObjectOutput<Prettify<TEntries & TNewEntries>, TOpts>,
      TOpts
    >
  >;
}

// =============================================================================
// Object Schema Implementation
// =============================================================================

// Pre-computed error for fast path
const OBJECT_TYPE_ERROR = { issues: [{ message: "Expected object" }] };

/**
 * Field descriptor - pre-computed at schema creation time.
 */
interface FieldDescriptor {
  readonly key: string;
  readonly keyPath: PropertyKey[];
  readonly validate: (value: unknown) => any;
  readonly acceptsUndefined: boolean;
  readonly missingError: { issues: { message: string; path: PropertyKey[] }[] };
}

/**
 * Create an optimized validator for an object schema.
 * Minimal overhead, Valibot-style simplicity.
 */
function createObjectValidator(
  entries: ObjectEntries,
  options: ObjectOptions = {}
) {
  const { partial = true, strict = true } = options;
  const keys = Object.keys(entries);
  const keyCount = keys.length;
  const keySet = new Set(keys);

  // Lazy resolution flag - for circular refs
  let resolved = false;
  // Direct arrays for maximum access speed (no object property lookup)
  const validates: ((v: unknown) => any)[] = new Array(keyCount);
  const acceptsUndefined: boolean[] = new Array(keyCount);
  const keyPaths: PropertyKey[][] = new Array(keyCount);
  const missingErrors: {
    issues: { message: string; path: PropertyKey[] }[];
  }[] = new Array(keyCount);

  // Pre-compute key paths and error messages (these don't need lazy resolution)
  for (let i = 0; i < keyCount; i++) {
    const key = keys[i]!;
    keyPaths[i] = [key];
    missingErrors[i] = {
      issues: [{ message: `Missing required field: ${key}`, path: [key] }],
    };
  }

  // Resolve validators lazily (for circular refs)
  const resolve = () => {
    if (resolved) return;
    resolved = true;
    for (let i = 0; i < keyCount; i++) {
      const key = keys[i]!;
      const entry = entries[key]!;
      const schema =
        typeof entry === "function"
          ? (entry as () => VibSchema<any, any>)()
          : entry;
      const validate = schema["~standard"].validate;
      validates[i] = validate;
      const undefinedResult = validate(undefined);
      acceptsUndefined[i] =
        !("then" in undefinedResult) && !undefinedResult.issues;
    }
  };

  return (value: unknown) => {
    // Type check
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return OBJECT_TYPE_ERROR;
    }

    const input = value as Record<string, unknown>;
    resolve(); // Inline the resolution check
    const output: Record<string, unknown> = {};

    // Strict mode: check for extra keys first (fail-fast)
    if (strict) {
      for (const key in input) {
        if (!keySet.has(key)) {
          return { issues: [{ message: `Unknown key: ${key}`, path: [key] }] };
        }
      }
    }

    // Validate each field - direct array access, no object property lookup
    for (let i = 0; i < keyCount; i++) {
      const key = keys[i]!;

      // Handle missing key
      if (!(key in input)) {
        if (partial || acceptsUndefined[i]) {
          output[key] = undefined;
          continue;
        }
        return missingErrors[i];
      }

      // Validate field - direct function call
      const result = validates[i]!(input[key]);

      // Handle validation error (most common unhappy path)
      if (result.issues) {
        const issue = result.issues[0]!;
        return {
          issues: [
            {
              message: issue.message,
              path: issue.path ? keyPaths[i]!.concat(issue.path) : keyPaths[i],
            },
          ],
        };
      }

      // Handle async (rare)
      if ("then" in result) {
        return {
          issues: [{ message: "Async not supported", path: keyPaths[i] }],
        };
      }

      output[key] = result.value;
    }

    return { value: output };
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
          const itemResult = validateObj(value[i])!;
          if (itemResult.issues) {
            const issue = itemResult.issues[0] as {
              message: string;
              path?: PropertyKey[];
            };
            const newPath = issue.path
              ? ([i] as PropertyKey[]).concat(issue.path)
              : [i];
            return fail(issue.message, newPath);
          }
          results[i] = hasTransform
            ? (options!.transform!(
                (itemResult as { value: any }).value
              ) as BaseOutput)
            : ((itemResult as { value: any }).value as BaseOutput);
        }
        return ok(results);
      }

      // Single object validation
      const result = validateObj(value)!;
      if (result.issues) {
        return result;
      }

      return hasTransform
        ? ok(
            options!.transform!((result as { value: any }).value as BaseOutput)
          )
        : result;
    };
  }

  const schema = {
    type: "object" as const,
    entries,
    options,
    parse: (value: unknown) => {
      return validate(value) as
        | StandardSchemaV1.SuccessResult<BaseOutput>
        | StandardSchemaV1.FailureResult;
    },

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
    extend: (newEntries: ObjectEntries) =>
      object({ ...entries, ...newEntries } as any, options),
  };

  return schema as R extends infer _ ? _ : never;
}
