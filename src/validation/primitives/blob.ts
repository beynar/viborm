import type {
  ComputeInput,
  ComputeOutput,
  ScalarOptions,
  VibSchema,
} from "../types";
import { isUint8Array } from "../value-guards";
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

// %TypedArray%.prototype owns the metadata accessors. Start lookup there so a
// genuine foreign view cannot redirect normalization through hostile own
// properties.
const typedArrayPrototype: object = Object.getPrototypeOf(Uint8Array.prototype);

function localBufferPrototype(): object | undefined {
  try {
    const bufferConstructor: unknown = Reflect.get(globalThis, "Buffer");
    if (typeof bufferConstructor !== "function") return;
    const prototype: unknown = Reflect.get(bufferConstructor, "prototype");
    if (
      prototype !== null &&
      typeof prototype === "object" &&
      Object.getPrototypeOf(prototype) === Uint8Array.prototype
    ) {
      return prototype;
    }
  } catch {
    return;
  }
}

const trustedBufferPrototype = localBufferPrototype();

function hasOwnViewMetadata(value: Uint8Array): boolean {
  return (
    Object.getOwnPropertyDescriptor(value, "buffer") !== undefined ||
    Object.getOwnPropertyDescriptor(value, "byteOffset") !== undefined ||
    Object.getOwnPropertyDescriptor(value, "byteLength") !== undefined
  );
}

function hasTrustedLocalPrototype(value: Uint8Array): boolean {
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Uint8Array.prototype ||
      prototype === trustedBufferPrototype) &&
    !hasOwnViewMetadata(value)
  );
}

/**
 * Validate binary data without requiring a Node Buffer global. Node Buffers
 * inherit from Uint8Array and therefore pass this same runtime check.
 */
export function validateBlob(value: unknown) {
  try {
    if (!isUint8Array(value)) return BLOB_ERROR;

    // Read the internal view through %TypedArray%.prototype. This proves the
    // slots without `instanceof` or caller-visible metadata and bypasses
    // hostile own properties on a genuine local or foreign Uint8Array.
    const buffer: ArrayBufferLike = Reflect.get(
      typedArrayPrototype,
      "buffer",
      value
    );
    const byteOffset: number = Reflect.get(
      typedArrayPrototype,
      "byteOffset",
      value
    );
    const byteLength: number = Reflect.get(
      typedArrayPrototype,
      "byteLength",
      value
    );
    // Only the two exact local prototype paths may retain identity. An
    // intermediate/custom prototype can be a stateful Proxy that agrees with
    // one metadata read and lies to the driver later, so it is never treated as
    // proof. Construct after classification so a detached backing buffer is a
    // refusal rather than a successful detached value.
    const keepsIdentity = hasTrustedLocalPrototype(value);
    const normalized = new Uint8Array(buffer, byteOffset, byteLength);
    // Keep the established plain-local/Node-Buffer identity contract only on
    // the exact trusted path. Every other admitted view normalizes locally.
    if (keepsIdentity) {
      return ok(value);
    }
    return ok(normalized);
  } catch {
    return BLOB_ERROR;
  }
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
