import type {
  ComputeInput,
  ComputeOutput,
  ScalarOptions,
  VibSchema,
} from "../types";
import { buildSchema, ok } from "./helpers";

// =============================================================================
// Blob Schema (Uint8Array, including Node Buffer subclasses)
// =============================================================================

export interface BaseBlobSchema<
  Opts extends ScalarOptions<Uint8Array, any> | undefined = undefined,
> extends VibSchema<
    ComputeInput<Uint8Array, Opts>,
    ComputeOutput<Uint8Array, Opts>
  > {}

export interface BlobSchema<TInput = Uint8Array, TOutput = Uint8Array>
  extends VibSchema<TInput, TOutput> {
  readonly type: "blob";
}

// Pre-computed error for fast path
const BLOB_ERROR = Object.freeze({
  issues: Object.freeze([Object.freeze({ message: "Expected Uint8Array" })]),
});

/**
 * Validate binary data without requiring a Node Buffer global. Node Buffers
 * inherit from Uint8Array and therefore pass this same runtime check.
 */
export function validateBlob(value: unknown) {
  return value instanceof Uint8Array ? ok(value) : BLOB_ERROR;
}

/**
 * Create a blob schema for binary data.
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
): BlobSchema<ComputeInput<Uint8Array, Opts>, ComputeOutput<Uint8Array, Opts>> {
  return buildSchema("blob", validateBlob, options) as BlobSchema<
    ComputeInput<Uint8Array, Opts>,
    ComputeOutput<Uint8Array, Opts>
  >;
}
