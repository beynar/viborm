import type {
  VibSchema,
  ScalarOptions,
  ComputeInput,
  ComputeOutput,
} from "../types";
import { buildSchema, ok } from "../helpers";

// =============================================================================
// Blob Schema (Uint8Array / Buffer)
// =============================================================================

export interface BaseBlobSchema<
  Opts extends ScalarOptions<Uint8Array, any> | undefined = undefined
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
  issues: Object.freeze([
    Object.freeze({ message: "Expected Uint8Array or Buffer" }),
  ]),
});

/**
 * Validate that a value is a Uint8Array or Buffer.
 */
export function validateBlob(value: unknown) {
  return value instanceof Uint8Array || Buffer.isBuffer(value)
    ? ok(value as Uint8Array)
    : BLOB_ERROR;
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
  const Opts extends ScalarOptions<Uint8Array, any> | undefined = undefined
>(
  options?: Opts
): BlobSchema<ComputeInput<Uint8Array, Opts>, ComputeOutput<Uint8Array, Opts>> {
  return buildSchema("blob", validateBlob, options) as BlobSchema<
    ComputeInput<Uint8Array, Opts>,
    ComputeOutput<Uint8Array, Opts>
  >;
}
