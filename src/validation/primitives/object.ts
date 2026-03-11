import type { StandardSchemaV1 } from "@standard-schema";
import { createJsonSchemaConverter } from "../json-schema/factory";
import type {
  InferInputShape,
  InferOutputShape,
  ThunkCast,
  ValidationResult,
  VibSchema,
} from "../types";
import { OK_NULL, OK_UNDEFINED, ok, validateArray } from "./helpers";

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
export interface ObjectOptions<T = unknown, TKeys extends string = string> {
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
  /** Require at least these specific keys (works with partial: true) */
  atLeast?: TKeys[];
  /** Omit these keys entirely from the type and validation */
  omit?: TKeys[];
  /** Require at least one key to be present (object cannot be empty) */
  nonEmpty?: boolean;
}

/**
 * Omit specific keys from a type entirely.
 * Preserves optionality of remaining keys.
 */
type VOmit<T, K extends string> = {
  [P in keyof T as P extends K ? never : P]: T[P];
};

/**
 * Compute input type based on partial option.
 * Default is partial: true, so only non-partial when explicitly { partial: false }
 * If atLeast is specified, those keys are required even when partial: true
 * If omit is specified, those keys are removed from the type entirely
 */
type ComputeObjectInput<TEntries, TOpts> = TOpts extends {
  omit: infer OmitKeys extends readonly string[];
}
  ? TOpts extends { partial: false }
    ? VOmit<InferInputShape<TEntries>, OmitKeys[number]>
    : TOpts extends { atLeast: infer Keys extends readonly string[] }
      ? VOmit<
          RequireKeys<Partial<InferInputShape<TEntries>>, Keys[number]>,
          OmitKeys[number]
        >
      : VOmit<Partial<InferInputShape<TEntries>>, OmitKeys[number]>
  : TOpts extends { partial: false }
    ? InferInputShape<TEntries>
    : TOpts extends { atLeast: infer Keys extends readonly string[] }
      ? RequireKeys<Partial<InferInputShape<TEntries>>, Keys[number]>
      : Partial<InferInputShape<TEntries>>;

/**
 * Compute output type based on entries.
 * Unlike input, output doesn't use Partial - each field's schema determines
 * whether its output includes undefined (based on whether it has a default).
 */
type ComputeObjectOutput<TEntries, _TOpts> = InferOutputShape<TEntries>;

/**
 * Make specific keys required in an otherwise partial object.
 * Uses a mapped type instead of Omit & Required<Pick> to reduce type depth.
 */
type RequireKeys<T, K extends string> = {
  [P in keyof T as P extends K ? never : P]?: T[P];
} & {
  [P in keyof T as P extends K ? P : never]-?: T[P];
};

/**
 * Apply wrapper options (optional, nullable, array) to input type.
 * Input accepts undefined when optional (even with default).
 */
type ApplyObjectOptionsInput<TBase, TOpts> = TOpts extends { array: true }
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
 * Apply wrapper options (optional, nullable, array) to output type.
 * When a default is provided, undefined is not included in output
 * (the default will always be applied).
 */
type ApplyObjectOptionsOutput<TBase, TOpts> = TOpts extends { array: true }
  ? TOpts extends { optional: true }
    ? TOpts extends { default: any }
      ? TOpts extends { nullable: true }
        ? TBase[] | null
        : TBase[]
      : TOpts extends { nullable: true }
        ? TBase[] | undefined | null
        : TBase[] | undefined
    : TOpts extends { nullable: true }
      ? TBase[] | null
      : TBase[]
  : TOpts extends { optional: true }
    ? TOpts extends { default: any }
      ? TOpts extends { nullable: true }
        ? TBase | null
        : TBase
      : TOpts extends { nullable: true }
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
  TOpts extends ObjectOptions | undefined = undefined,
  TInput = ApplyObjectOptionsInput<ComputeObjectInput<TEntries, TOpts>, TOpts>,
  TOutput = ApplyObjectOptionsOutput<
    ComputeObjectOutput<TEntries, TOpts>,
    TOpts
  >,
> extends VibSchema<TInput, TOutput> {
  readonly type: "object";
  readonly entries: TEntries;
  readonly options: TOpts;
  readonly parse: VibSchema<TInput, TOutput>["~standard"]["validate"];
  /** Extend this schema with additional entries */
  extend<
    TNewEntries extends ObjectEntries,
    TNewTOpts extends ObjectOptions | undefined = undefined,
  >(
    newEntries: TNewEntries,
    options?: TNewTOpts,
  ): ObjectSchema<TEntries & TNewEntries, TOpts & TNewTOpts>;
}

// =============================================================================
// Object Schema Implementation
// =============================================================================

// Pre-computed error for fast path
const OBJECT_TYPE_ERROR = { issues: [{ message: "Expected object" }] };

/**
 * Create an optimized validator for an object schema.
 * Minimal overhead, Valibot-style simplicity.
 */
function createObjectValidator(
  entries: ObjectEntries,
  options: ObjectOptions = {},
): (value: unknown) => ValidationResult<Record<string, unknown>> {
  const { partial = true, strict = true, atLeast, omit, nonEmpty } = options;
  // Filter out omitted keys
  const omitSet = omit ? new Set(omit) : null;
  const keys = Object.keys(entries).filter((k) => !omitSet?.has(k));
  const keyCount = keys.length;
  const keySet = new Set(keys);

  // Pre-compute which keys are required via atLeast
  const atLeastSet = atLeast ? new Set(atLeast) : null;

  // Lazy resolution flag - for circular refs
  let resolved = false;
  // Direct arrays for maximum access speed (no object property lookup)
  const validates: ((v: unknown) => any)[] = new Array(keyCount);
  const acceptsUndefined: boolean[] = new Array(keyCount);
  const isRequired: boolean[] = new Array(keyCount);
  const keyPaths: PropertyKey[][] = new Array(keyCount);
  const missingErrors: {
    issues: { message: string; path: PropertyKey[] }[];
  }[] = new Array(keyCount);

  // Pre-compute key paths, error messages, and required flags
  for (let i = 0; i < keyCount; i++) {
    const key = keys[i]!;
    keyPaths[i] = [key];
    missingErrors[i] = {
      issues: [{ message: `Missing required field: ${key}`, path: [key] }],
    };
    // Key is required if: not partial, OR key is in atLeast list
    isRequired[i] = !partial || (atLeastSet?.has(key) ?? false);
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
          ? (entry as () => VibSchema<any, any> | undefined)()
          : entry;

      // Defensive null check: if schema is undefined or invalid, create a failing validator
      if (!schema?.["~standard"]) {
        console.warn(
          `[VibORM] Schema for key "${key}" is undefined or invalid`,
        );
        validates[i] = () => ({
          issues: [{ message: `Schema error: "${key}" schema is undefined` }],
        });
        acceptsUndefined[i] = true;
        continue;
      }

      const validate = schema["~standard"].validate;
      validates[i] = validate;

      // Use the pre-computed acceptsUndefined property if available
      // Falls back to checking type/options for backwards compatibility
      const schemaAny = schema as {
        acceptsUndefined?: boolean;
        type?: string;
        options?: { optional?: boolean; default?: unknown };
        default?: unknown;
      };

      // Prefer explicit property, fall back to duck-typing for older schemas
      if (schemaAny.acceptsUndefined !== undefined) {
        acceptsUndefined[i] = schemaAny.acceptsUndefined;
      } else {
        acceptsUndefined[i] =
          schemaAny.type === "optional" ||
          schemaAny.options?.optional === true ||
          schemaAny.options?.default !== undefined ||
          schemaAny.default !== undefined;
      }
    }
  };

  return (value: unknown): ValidationResult<Record<string, unknown>> => {
    // Type check
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return OBJECT_TYPE_ERROR as ValidationResult<Record<string, unknown>>;
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

    // Check for nonEmpty constraint
    if (nonEmpty === true) {
      // Check if object has any keys at all (including unknown keys when strict: false)
      let hasAnyKey = false;
      for (const key in input) {
        hasAnyKey = true;
        break;
      }
      if (!hasAnyKey) {
        return {
          issues: [{ message: "Object cannot be empty" }],
        };
      }
    }

    // Validate each field - direct array access, no object property lookup
    for (let i = 0; i < keyCount; i++) {
      const key = keys[i]!;

      // Handle missing key
      if (!(key in input)) {
        // Key is required (partial: false OR in atLeast) and schema doesn't accept undefined
        if (isRequired[i] && !acceptsUndefined[i]) {
          return missingErrors[i]!;
        }

        // If schema accepts undefined, run validator to apply defaults
        if (acceptsUndefined[i]) {
          const result = validates[i]!(undefined);
          if (result.issues) {
            // Should not happen if acceptsUndefined is correct, but handle it
            return missingErrors[i]!;
          }
          if ("then" in result) {
            return {
              issues: [{ message: "Async not supported", path: keyPaths[i] }],
            };
          }
          output[key] = result.value;
        } else {
          // Field is optional (partial: true, not in atLeast) but schema doesn't have defaults
          // Just set to undefined without running validator
          output[key] = undefined;
        }
        continue;
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
  R = ObjectSchema<TEntries, TOpts>,
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

  if (needsWrapper) {
    // Pre-compute default getter once (avoid repeated typeof checks)
    const getDefault = hasDefault
      ? typeof options!.default === "function"
        ? (options!.default as () => BaseOutput)
        : () => options!.default as BaseOutput
      : null;

    // Create the base validator (with optional transform)
    const validateItem = hasTransform
      ? (value: unknown): ValidationResult<any> => {
          const result = validateObj(value);
          if (result.issues) return result;
          return ok(options!.transform!((result as { value: any }).value));
        }
      : validateObj;

    // Build wrapper based on options
    if (hasArray) {
      // Array mode: use shared validateArray utility
      const arrayValidate = (value: unknown) =>
        validateArray(value, validateItem);

      if (hasOptional && hasNullable) {
        validate = (value: unknown) => {
          if (value === undefined)
            return getDefault ? ok(getDefault()) : OK_UNDEFINED;
          if (value === null) return OK_NULL;
          return arrayValidate(value);
        };
      } else if (hasOptional) {
        validate = (value: unknown) => {
          if (value === undefined)
            return getDefault ? ok(getDefault()) : OK_UNDEFINED;
          return arrayValidate(value);
        };
      } else if (hasNullable) {
        validate = (value: unknown) => {
          if (value === null) return OK_NULL;
          return arrayValidate(value);
        };
      } else {
        validate = arrayValidate;
      }
    } else {
      // Single object mode
      if (hasOptional && hasNullable) {
        validate = (value: unknown) => {
          if (value === undefined)
            return getDefault ? ok(getDefault()) : OK_UNDEFINED;
          if (value === null) return OK_NULL;
          return validateItem(value);
        };
      } else if (hasOptional) {
        validate = (value: unknown) => {
          if (value === undefined)
            return getDefault ? ok(getDefault()) : OK_UNDEFINED;
          return validateItem(value);
        };
      } else if (hasNullable) {
        validate = (value: unknown) => {
          if (value === null) return OK_NULL;
          return validateItem(value);
        };
      } else {
        // Only transform, no optional/nullable
        validate = validateItem;
      }
    }
  } else {
    // Fast path: direct object validation
    validate = validateObj;
  }

  const schema = {
    type: "object" as const,
    entries,
    options,
    "~standard": {
      version: 1 as const,
      vendor: "viborm" as const,
      validate,
      // Lazy jsonSchema - converter is created when first accessed
      get jsonSchema() {
        const converter = createJsonSchemaConverter(
          schema as unknown as VibSchema<unknown, unknown>,
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
