import { inferred } from "../inferred";
import type {
  VibSchema,
  ScalarOptions,
  ComputeInput,
  ComputeOutput,
} from "../types";
import { applyOptions, fail, ok, createSchema } from "../helpers";

// =============================================================================
// Vector Schema (array of numbers for embeddings/ML)
// =============================================================================

export interface VectorSchema<TInput = number[], TOutput = number[]>
  extends VibSchema<TInput, TOutput> {
  readonly type: "vector";
  readonly dimensions?: number;
}

/**
 * Validate that a value is a vector (array of numbers).
 * Optionally check for specific dimensions.
 */
function createVectorValidator(dimensions?: number) {
  return (value: unknown) => {
    if (!Array.isArray(value)) {
      return fail(`Expected array of numbers, received ${typeof value}`);
    }

    for (let i = 0; i < value.length; i++) {
      if (typeof value[i] !== "number" || Number.isNaN(value[i])) {
        return fail(`Expected number at index ${i}, received ${typeof value[i]}`);
      }
    }

    if (dimensions !== undefined && value.length !== dimensions) {
      return fail(
        `Expected vector of ${dimensions} dimensions, received ${value.length}`
      );
    }

    return ok(value as number[]);
  };
}

/**
 * Create a vector schema for arrays of numbers (embeddings, coordinates, etc.)
 *
 * @param dimensions - Optional fixed number of dimensions
 * @param options - Schema options
 *
 * @example
 * const embedding = v.vector();                    // Any length
 * const embedding3d = v.vector(3);                 // Exactly 3 dimensions
 * const optionalVector = v.vector(undefined, { optional: true });
 */
export function vector<
  const Opts extends ScalarOptions<number[], any> | undefined = undefined,
>(
  dimensions?: number,
  options?: Opts
): VectorSchema<ComputeInput<number[], Opts>, ComputeOutput<number[], Opts>> {
  const validateVector = createVectorValidator(dimensions);

  const schema = createSchema("vector", (value) =>
    applyOptions(value, validateVector, options, "vector")
  ) as VectorSchema<
    ComputeInput<number[], Opts>,
    ComputeOutput<number[], Opts>
  >;

  // Store dimensions on schema for introspection
  (schema as any).dimensions = dimensions;

  return schema;
}

// Export validator for reuse
export { createVectorValidator as validateVector };

