import type { InferInput, InferOutput, VibSchema } from "../types";
import { createSchema, fail } from "./helpers";

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
  const validators = options.map((option) => option["~standard"].validate);
  const schema = createSchema<
    InferInput<TOptions[number]>,
    InferOutput<TOptions[number]>
  >("union", (value) => {
    // Success returns the matching member's result as-is. Messages only start
    // accumulating once a SECOND member has failed, so the common
    // "first member misses, second matches" filter pattern (shorthand vs
    // object) stays allocation-free.
    let firstError: string | null = null;
    let restErrors: string[] | null = null;

    for (const validate of validators) {
      const result = validate(value);
      let message: string;
      if ("then" in result) {
        message = "Async schemas are not supported";
      } else if (!result.issues) {
        return result as { value: InferOutput<TOptions[number]> };
      } else {
        message = result.issues[0]!.message;
      }
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
