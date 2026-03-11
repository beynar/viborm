// =============================================================================
// VibORM Validation Library
// =============================================================================
//
// A minimal, StandardSchema-compliant validation library with:
// - Recursive type support (thunks for circular references)
// - Fail-fast validation (throws on first error)
// - Options-based API (optional, nullable, array, transform, default)
// - Strict objects by default
//
// =============================================================================
export type { inferred as inferredType } from "./inferred";

// Branded type symbol
export { inferred } from "./inferred";
// JSON Schema conversion (StandardJSONSchemaV1)
export type { JsonSchema } from "./json-schema";
export { createJsonSchemaConverter, toJsonSchema } from "./json-schema";
// V Namespace - Type-level schema mirrors for explicit type annotations
// Convenience namespace (v.string(), v.number(), etc.)
export { type V, v, v as default } from "./primitives/v";

import type { VibSchema } from "./types";

export const parse = <const S extends VibSchema>(schema: S, value: unknown) => {
  return schema["~standard"].validate(value) as Awaited<
    ReturnType<(typeof schema)["~standard"]["validate"]>
  >;
};
