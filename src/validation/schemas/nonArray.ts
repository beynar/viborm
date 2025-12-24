import type { StandardSchemaV1 } from "@standard-schema/spec";
import { inferred } from "../inferred";
import type { VibSchema, ValidationResult } from "../types";
import { createSchema, fail, ok } from "../helpers";

// =============================================================================
// NonArray Schema (Element / Unwrap)
// =============================================================================

/**
 * Extract element type from array type.
 */
type ElementOf<T> = T extends readonly (infer E)[] ? E : T;

/**
 * Schema that validates a single element instead of an array.
 * Useful for unwrapping array schemas.
 */
export interface NonArraySchema<TInput, TOutput>
  extends VibSchema<TInput, TOutput> {
  readonly type: "nonArray";
}

/**
 * Unwrap an array schema to validate single elements.
 * If the wrapped schema expects an array, this validates a single element.
 *
 * @example
 * const tags = v.string({ array: true });
 * // tags validates: string[]
 *
 * const singleTag = v.nonArray(tags);
 * // singleTag validates: string
 *
 * @example
 * // Alias: element()
 * const oneItem = v.element(v.number({ array: true }));
 */
export function nonArray<I, O>(
  schema: StandardSchemaV1<I[], O[]>
): NonArraySchema<ElementOf<I>, ElementOf<O>>;
export function nonArray<I, O>(
  schema: StandardSchemaV1<I, O>
): NonArraySchema<ElementOf<I>, ElementOf<O>>;
export function nonArray<I, O>(
  schema: StandardSchemaV1<I, O>
): NonArraySchema<ElementOf<I>, ElementOf<O>> {
  return createSchema(
    "nonArray",
    (value): ValidationResult<ElementOf<O>> => {
      // If value is an array, validate first element
      // If not, validate directly
      const toValidate = Array.isArray(value) ? value[0] : value;

      // For array schemas, wrap in array for validation then unwrap
      const result = schema["~standard"].validate([toValidate] as unknown as I);
      if ("then" in result) {
        return fail("Async schemas are not supported");
      }
      if (result.issues) {
        const issue = result.issues[0];
        return fail(issue?.message ?? "Validation failed");
      }

      // Unwrap the array result
      const output = (result as { value: O }).value;
      const arrayResult = output as unknown as O[];
      if (Array.isArray(arrayResult) && arrayResult.length > 0) {
        return ok(arrayResult[0] as ElementOf<O>);
      }

      // Fallback: maybe the schema doesn't actually require array
      return ok(output as unknown as ElementOf<O>);
    }
  ) as NonArraySchema<ElementOf<I>, ElementOf<O>>;
}

/**
 * Alias for nonArray.
 * Extracts the element schema from an array schema.
 */
export const element = nonArray;

