import type { InferInput, InferOutput, VibSchema } from "../types";
import { createSchema, fail, validateSchema } from "./helpers";

// =============================================================================
// Union Schema
// =============================================================================

export type UnionOptions<T extends readonly VibSchema<any, any>[]> = T;

export interface UnionSchema<
  TOptions extends readonly VibSchema<any, any>[],
  TInput = TOptions[number][" vibInferred"]["0"],
  TOutput = InferOutput<TOptions[number]>,
> extends VibSchema<TInput, TOutput> {
  readonly type: "union";
  readonly options: TOptions;
}

/**
 * Create a union schema that validates against multiple options.
 * Returns the result of the first matching schema.
 *
 * @example
 * const stringOrNumber = v.union([v.string(), v.number()]);
 */
export function union<const TOptions extends readonly VibSchema<any, any>[]>(
  options: TOptions
): UnionSchema<TOptions> {
  const schema = createSchema<
    InferInput<TOptions[number]>,
    InferOutput<TOptions[number]>
  >("union", (value) => {
    // Success path allocates nothing extra: the matching member's result is
    // returned as-is (no ok() re-wrap), and error messages only start
    // accumulating into an array once a SECOND member has failed — the common
    // "first member misses, second matches" filter pattern (shorthand vs
    // object) stays allocation-free.
    let firstError: string | null = null;
    let restErrors: string[] | null = null;

    for (const option of options) {
      const result = validateSchema(option, value);
      if (!result.issues) {
        return result as { value: InferOutput<TOptions[number]> };
      }
      const message = result.issues[0]!.message;
      if (firstError === null) {
        firstError = message;
      } else {
        (restErrors ??= []).push(message);
      }
    }

    const detail = restErrors
      ? `${firstError}, ${restErrors.join(", ")}`
      : firstError;
    return fail(`Value did not match any union member: ${detail}`);
  }) as UnionSchema<TOptions>;

  (schema as any).options = options;

  return schema;
}
