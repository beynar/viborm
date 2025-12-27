import { inferred } from "../inferred";
import type { VibSchema, InferInput, InferOutput } from "../types";
import { fail, ok, createSchema, validateSchema } from "../helpers";

// =============================================================================
// Union Schema
// =============================================================================

export type UnionOptions<T extends readonly VibSchema<any, any>[]> = T;

export interface UnionSchema<
  TOptions extends readonly VibSchema<any, any>[],
  TInput = TOptions[number][" vibInferred"]["0"],
  TOutput = InferOutput<TOptions[number]>
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
    const errors: string[] = [];

    for (const option of options) {
      const result = validateSchema(option, value);
      if (!result.issues) {
        return ok(
          (result as { value: unknown }).value as InferOutput<TOptions[number]>
        );
      }
      errors.push(result.issues[0]!.message);
    }

    return fail(`Value did not match any union member: ${errors.join(", ")}`);
  }) as UnionSchema<TOptions>;

  (schema as any).options = options;

  return schema;
}
