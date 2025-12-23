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
  /** Make all fields optional (default: false) */
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
 */
type ComputeObjectInput<TEntries, TOpts> = TOpts extends { partial: true }
  ? Partial<InferInputShape<TEntries>>
  : InferInputShape<TEntries>;

/**
 * Compute output type based on partial option.
 */
type ComputeObjectOutput<TEntries, TOpts> = TOpts extends { partial: true }
  ? Partial<InferOutputShape<TEntries>>
  : InferOutputShape<TEntries>;

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

/**
 * Resolve a schema entry (handles thunks for circular references).
 */
function resolveEntry(
  entry: VibSchema<any, any> | ThunkCast<any, any>
): VibSchema<any, any> {
  if (typeof entry === "function") {
    return entry() as VibSchema<any, any>;
  }
  return entry;
}

/**
 * Core object validation logic.
 */
function validateObject(
  entries: ObjectEntries,
  value: unknown,
  options: ObjectOptions = {}
) {
  const { partial = false, strict = true } = options;

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail(
      `Expected object, received ${
        Array.isArray(value) ? "array" : typeof value
      }`
    );
  }

  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};

  // Check for unknown keys first if strict (fail-fast)
  if (strict) {
    for (const key in input) {
      if (!(key in entries)) {
        return fail(`Unknown key: ${key}`, [key]);
      }
    }
  }

  // Validate each entry
  for (const key in entries) {
    const entrySchema = resolveEntry(entries[key]!);
    const entryValue = input[key];

    // Check if field is present
    if (!(key in input)) {
      // If partial mode or schema accepts undefined (optional)
      if (partial || entrySchema.type === "optional") {
        const defaultVal = (entrySchema as any).default;
        if (defaultVal !== undefined) {
          output[key] =
            typeof defaultVal === "function" ? defaultVal() : defaultVal;
        } else {
          output[key] = undefined;
        }
        continue;
      }
      return fail(`Missing required field: ${key}`, [key]);
    }

    const result = validateSchema(entrySchema, entryValue);
    if (result.issues) {
      const issue = result.issues[0]!;
      const newPath: PropertyKey[] = [key, ...(issue.path || [])];
      return fail(issue.message, newPath);
    }
    output[key] = (result as { value: unknown }).value;
  }

  return ok(output);
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
 *   - `partial` (default: false) - Make all fields optional
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

  const validate = (value: unknown) => {
    // Handle optional
    if (options?.optional && value === undefined) {
      if (options.default !== undefined) {
        const defaultVal =
          typeof options.default === "function"
            ? (options.default as () => BaseOutput)()
            : options.default;
        return ok(defaultVal);
      }
      return ok(undefined);
    }

    // Handle nullable
    if (options?.nullable && value === null) {
      if (options.default !== undefined) {
        const defaultVal =
          typeof options.default === "function"
            ? (options.default as () => BaseOutput)()
            : options.default;
        return ok(defaultVal);
      }
      return ok(null);
    }

    // Handle array
    if (options?.array) {
      if (!Array.isArray(value)) {
        return fail(`Expected array of objects, received ${typeof value}`);
      }

      const results: BaseOutput[] = [];
      for (let i = 0; i < value.length; i++) {
        const itemResult = validateObject(
          entries as ObjectEntries,
          value[i],
          options
        );
        if (itemResult.issues) {
          const issue = itemResult.issues[0]!;
          const newPath: PropertyKey[] = [i, ...(issue.path || [])];
          return fail(issue.message, newPath);
        }
        results.push((itemResult as { value: BaseOutput }).value);
      }

      let output: any = results;
      if (options.transform) {
        output = output.map(options.transform);
      }
      return ok(output);
    }

    // Single object validation
    const result = validateObject(entries as ObjectEntries, value, options);
    if (result.issues) {
      return result;
    }

    let output = result.value as BaseOutput;
    if (options?.transform) {
      // @ts-expect-error - transform type is complex with options generics
      output = options.transform(output);
    }
    return ok(output);
  };

  const schema = createSchema("object", validate) as ObjectSchema<
    TEntries,
    TOpts
  >;

  (schema as any).entries = entries;
  (schema as any).options = options;

  return schema as R extends infer _ ? _ : never;
}
