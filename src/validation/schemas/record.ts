import { createSchema, fail, ok, validateSchema } from "../helpers";
import type {
  Cast,
  InferInput,
  InferOutput,
  ThunkCast,
  VibSchema,
} from "../types";
import { type ObjectOptions, type ObjectSchema, object } from "./object";

// =============================================================================
// Record Schema (dynamic keys)
// =============================================================================

export interface RecordSchema<
  TKey extends VibSchema<string, string>,
  TValue extends VibSchema<any, any>,
  TInput = Record<InferInput<TKey>, InferInput<TValue>>,
  TOutput = Record<InferOutput<TKey>, InferOutput<TValue>>,
> extends VibSchema<TInput, TOutput> {
  readonly type: "record";
  readonly key: TKey;
  readonly value: TValue;
}

/**
 * Create a record schema that validates keys and values.
 *
 * @example
 * const stringRecord = v.record(v.string(), v.number());
 * // Validates: { foo: 1, bar: 2 }
 */
export function record<
  TKey extends VibSchema<string, string>,
  TValue extends VibSchema<any, any>,
>(key: TKey, value: TValue): RecordSchema<TKey, TValue> {
  const schema = createSchema<
    Record<InferInput<TKey>, InferInput<TValue>>,
    Record<InferOutput<TKey>, InferOutput<TValue>>
  >("record", (input) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return fail(
        `Expected object, received ${
          Array.isArray(input) ? "array" : typeof input
        }`
      );
    }

    const output: Record<string, unknown> = {};

    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      const keyResult = validateSchema(key, k);
      if (keyResult.issues) {
        return fail(`Invalid key "${k}": ${keyResult.issues[0]!.message}`, [k]);
      }

      const valueResult = validateSchema(value, v);
      if (valueResult.issues) {
        const issue = valueResult.issues[0]!;
        // Use concat instead of spread for better performance
        const newPath = issue.path
          ? ([k] as PropertyKey[]).concat(issue.path)
          : [k];
        return fail(issue.message, newPath);
      }

      output[(keyResult as { value: string }).value] = (
        valueResult as { value: unknown }
      ).value;
    }

    return ok(output as Record<InferOutput<TKey>, InferOutput<TValue>>);
  }) as RecordSchema<TKey, TValue>;

  (schema as any).key = key;
  (schema as any).value = value;

  return schema;
}

// =============================================================================
// FromKeys Schema (static keys with same value schema)
// =============================================================================

/**
 * Schema entry type - VibSchema or ThunkCast for circular references.
 */
type SchemaEntry =
  | VibSchema<any, any>
  | ThunkCast<any, any>
  | (() => Cast<any, any>);

/**
 * Normalize a schema entry to VibSchema for type extraction.
 */
type NormalizeEntry<T> =
  T extends VibSchema<infer I, infer O>
    ? VibSchema<I, O>
    : T extends ThunkCast<infer I, infer O>
      ? VibSchema<I, O>
      : T extends () => Cast<infer I, infer O>
        ? VibSchema<I, O>
        : never;

/**
 * Compute entries from a tuple of keys and a schema.
 */
type ComputeEntriesFromKeys<
  TKeys extends readonly string[],
  TSchema extends SchemaEntry,
> = {
  [K in TKeys[number]]: NormalizeEntry<TSchema>;
};

/**
 * Options for fromKeys (same as ObjectOptions).
 */
export type FromKeysOptions<T = unknown> = ObjectOptions<T>;

/**
 * Creates an object schema from an array of keys, all mapping to the same schema.
 * This is a convenient wrapper around `object()` for creating uniform schemas.
 *
 * @param keys - Array of key names (use `as const` for type inference)
 * @param schema - Schema to use for all keys (can be a thunk for circular refs)
 * @param options - Schema options (same as object schema)
 *
 * @example
 * // All keys have the same string schema
 * const schema = v.fromKeys(["name", "email", "bio"] as const, v.string());
 * // → ObjectSchema<{ name: string, email: string, bio: string }>
 *
 * @example
 * // With options
 * const optionalSchema = v.fromKeys(
 *   ["user", "post"] as const,
 *   v.number(),
 *   { partial: false }
 * );
 * // → ObjectSchema<{ user: number, post: number }> (all required)
 *
 * @example
 * // With thunks for circular references
 * const nodeSchema: VibSchema<any, any> = v.object({ value: v.string() });
 * const schema = v.fromKeys(
 *   ["left", "right"] as const,
 *   () => nodeSchema,
 *   { optional: true }
 * );
 */
export function fromKeys<
  const TKeys extends readonly string[],
  TSchema extends SchemaEntry,
  const TOpts extends FromKeysOptions | undefined = undefined,
>(
  keys: TKeys,
  schema: TSchema,
  options?: TOpts
): ObjectSchema<ComputeEntriesFromKeys<TKeys, TSchema>, TOpts> {
  // Build entries object from keys
  const entries: Record<string, SchemaEntry> = {};
  for (const key of keys) {
    entries[key] = schema;
  }

  // Delegate to the existing object schema builder
  return object(entries, options) as ObjectSchema<
    ComputeEntriesFromKeys<TKeys, TSchema>,
    TOpts
  >;
}
