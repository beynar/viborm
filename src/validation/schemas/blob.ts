import { inferred } from "../inferred";
import type {
  VibSchema,
  ScalarOptions,
  ComputeInput,
  ComputeOutput,
} from "../types";
import { applyOptions, fail, ok, createSchema } from "../helpers";

// =============================================================================
// Blob Schema (Uint8Array / Buffer)
// =============================================================================

export interface BlobSchema<TInput = Uint8Array, TOutput = Uint8Array>
  extends VibSchema<TInput, TOutput> {
  readonly type: "blob";
}

/**
 * Validate that a value is a Uint8Array or Buffer.
 */
export function validateBlob(value: unknown) {
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    return ok(value as Uint8Array);
  }
  return fail(`Expected Uint8Array or Buffer, received ${typeof value}`);
}

/**
 * Create a blob schema for binary data (Uint8Array/Buffer).
 *
 * @example
 * const avatar = v.blob();
 * const optionalBlob = v.blob({ optional: true });
 * const nullableBlob = v.blob({ nullable: true });
 */
export function blob<
  const Opts extends ScalarOptions<Uint8Array, any> | undefined = undefined,
>(
  options?: Opts
): BlobSchema<
  ComputeInput<Uint8Array, Opts>,
  ComputeOutput<Uint8Array, Opts>
> {
  return createSchema("blob", (value) =>
    applyOptions(value, validateBlob, options, "blob")
  ) as BlobSchema<
    ComputeInput<Uint8Array, Opts>,
    ComputeOutput<Uint8Array, Opts>
  >;
}

