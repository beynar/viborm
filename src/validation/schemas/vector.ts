import type {
  VibSchema,
  ScalarOptions,
  ComputeInput,
  ComputeOutput,
} from "../types";
import { buildSchema, fail, ok } from "../helpers";

// =============================================================================
// Vector Schema (array of numbers for embeddings/ML)
// =============================================================================

export interface VectorSchema<TInput = number[], TOutput = number[]>
  extends VibSchema<TInput, TOutput> {
  readonly type: "vector";
}

// Pre-computed error for fast path
const NOT_ARRAY_ERROR = Object.freeze({
  issues: Object.freeze([
    Object.freeze({ message: "Expected array of numbers" }),
  ]),
});

/**
 * Validate that a value is a vector (array of numbers).
 * Optionally check for specific dimensions.
 */
function createVectorValidator(dimensions?: number) {
  // Pre-compute dimension error if applicable
  const dimensionError =
    dimensions !== undefined
      ? Object.freeze({
          issues: Object.freeze([
            Object.freeze({
              message: `Expected vector of ${dimensions} dimensions`,
            }),
          ]),
        })
      : null;

  return (value: unknown) => {
    if (!Array.isArray(value)) return NOT_ARRAY_ERROR;

    const len = value.length;
    for (let i = 0; i < len; i++) {
      if (typeof value[i] !== "number" || Number.isNaN(value[i])) {
        return fail(`Expected number at index ${i}`);
      }
    }

    if (dimensionError && len !== dimensions) return dimensionError;

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
  const Opts extends ScalarOptions<number[], any> | undefined = undefined
>(
  dimensions?: number,
  options?: Opts
): VectorSchema<ComputeInput<number[], Opts>, ComputeOutput<number[], Opts>> & {
  dimensions?: number;
} {
  const baseValidate = createVectorValidator(dimensions);
  return buildSchema("vector", baseValidate, options, {
    dimensions,
  }) as VectorSchema<
    ComputeInput<number[], Opts>,
    ComputeOutput<number[], Opts>
  > & { dimensions?: number };
}

// Export validator for reuse
export { createVectorValidator as validateVector };
