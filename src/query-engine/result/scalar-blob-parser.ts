import { normalizeBinaryValue } from "@validation/primitives/binary-shapes";
import type { Operation } from "../types";
import { QueryEngineError } from "../types";

function unsupportedBlobValue(
  provider: string,
  operation: Operation,
  representation: string
): never {
  throw new QueryEngineError(
    `Driver "${provider}" returned an unsupported ${representation} blob representation.`,
    {
      meta: {
        driver: provider,
        operation,
        scalarType: "blob",
        representation,
      },
    }
  );
}

/**
 * Normalize every driver's binary representation to a plain Uint8Array —
 * the one public blob type.
 *
 * WHICH shapes exist and how each is read is
 * {@link file://../../validation/primitives/binary-shapes.ts}'s answer, shared
 * with the identifier storage codec so a `BLOB`-stored ULID and a blob column
 * cannot disagree about what a driver returned. What is left here is the
 * REFUSAL: the blob boundary is the one that knows the driver and the
 * operation, and it is the only thing the message can usefully name.
 */
export function parseBlobValue(
  value: unknown,
  provider: string,
  operation: Operation
): Uint8Array {
  const shape = normalizeBinaryValue(value);
  if (shape.bytes === undefined) {
    return unsupportedBlobValue(provider, operation, shape.unsupported);
  }
  return shape.bytes;
}
