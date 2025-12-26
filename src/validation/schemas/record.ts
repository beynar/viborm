import type { VibSchema, InferInput, InferOutput } from "../types";
import { fail, ok, createSchema, validateSchema } from "../helpers";

// =============================================================================
// Record Schema
// =============================================================================

export interface RecordSchema<
  TKey extends VibSchema<string, string>,
  TValue extends VibSchema<any, any>,
  TInput = Record<InferInput<TKey>, InferInput<TValue>>,
  TOutput = Record<InferOutput<TKey>, InferOutput<TValue>>
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
  TValue extends VibSchema<any, any>
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
