import type { StandardSchemaV1 } from "@standard-schema/spec";
import { inferred } from "../inferred";
import type { VibSchema, ValidationResult } from "../types";
import { createSchema, fail, ok } from "../helpers";

// =============================================================================
// NonOptional Schema (Required)
// =============================================================================

/**
 * Schema that wraps another schema and ensures the value is defined.
 * Rejects undefined values.
 */
export interface NonOptionalSchema<TInput, TOutput>
  extends VibSchema<TInput, TOutput> {
  readonly type: "nonOptional";
}

/**
 * Wrap a schema to ensure its input/output is not undefined.
 * Fails validation if the value is undefined.
 *
 * @example
 * const maybeUndefined = v.string({ optional: true });
 * const required = v.nonOptional(maybeUndefined);
 * // Input: string, Output: string (undefined rejected)
 *
 * @example
 * // Alias: required()
 * const requiredName = v.required(v.string({ optional: true }));
 */
export function nonOptional<I, O>(
  schema:
    | StandardSchemaV1<I | undefined, O | undefined>
    | StandardSchemaV1<I, O | undefined>
    | StandardSchemaV1<I | undefined, O>
    | StandardSchemaV1<I, O>
): NonOptionalSchema<Exclude<I, undefined>, Exclude<O, undefined>> {
  return createSchema(
    "nonOptional",
    (value): ValidationResult<Exclude<O, undefined>> => {
      if (value === undefined) {
        return fail("Value is required, received undefined");
      }
      const result = schema["~standard"].validate(value);
      if ("then" in result) {
        return fail("Async schemas are not supported");
      }
      if (result.issues) {
        const issue = result.issues[0];
        return fail(issue?.message ?? "Validation failed");
      }
      const output = (result as { value: O | undefined }).value;
      if (output === undefined) {
        return fail("Value is required, received undefined");
      }
      return ok(output as Exclude<O, undefined>);
    }
  ) as NonOptionalSchema<Exclude<I, undefined>, Exclude<O, undefined>>;
}

/**
 * Alias for nonOptional.
 * Makes a schema required (rejects undefined).
 */
export const required = nonOptional;
