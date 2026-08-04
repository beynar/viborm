import type { VibSchema } from "../types";
import { createSchema, fail, ok } from "./helpers";

// =============================================================================
// Raw Record Schema (identity-preserving object leaf)
// =============================================================================

export interface RawRecordSchema
  extends VibSchema<Record<string, unknown>, Record<string, unknown>> {
  readonly type: "rawRecord";
}

/**
 * An object leaf that asserts OBJECT-NESS and NOTHING ELSE, and hands the SAME
 * object back — `output === input`, by reference.
 *
 * Every other object leaf in this layer is a transform: {@link object} materializes a
 * new record from its per-key validators, {@link record} rebuilds one from validated
 * entries. That is right wherever the schema owns the value's shape. It is wrong
 * wherever a schema must assert the shape of a payload some OTHER parse still owns —
 * and `upsert` is that case: its `create` / `update` arms are handed to
 * `CreateOperation` / `UpdateOperation` sub-ops which parse the RAW payload FRESH, so
 * the envelope must not have transformed it on the way past. Re-parsing a transformed
 * payload regresses on any non-idempotent transform (measured: a nested `createMany`
 * whose second parse answers `Expected string`).
 *
 * Reference equality is the property, not an implementation detail: it is what makes
 * "validate the envelope" and "leave the arms alone" the same sentence. It is asserted
 * directly, and a copy — however faithful — fails that assertion.
 *
 * The rejected shapes carry the SAME NAMED FACT as {@link record}'s own type check,
 * word for word, so the two object leaves cannot describe the same wrong input two
 * ways: `Expected object, received array` for an array, and the `typeof` for anything
 * else (`null` reads as `object`, exactly as `record` reports it — the two leaves are
 * wrong together or right together, never split).
 *
 * `undefined` is rejected here, and the enclosing {@link object} never asks: an
 * explicitly-`undefined` key is treated as ABSENT on every path (the Prisma-parity
 * dense-path rule), so a required key spelled `undefined` answers `Missing required
 * field: <key>` from the object schema and an optional one is simply skipped. This
 * leaf therefore sees a value only when the payload really carries one.
 */
export function rawRecord(): RawRecordSchema {
  return createSchema<Record<string, unknown>, Record<string, unknown>>(
    "rawRecord",
    (input) => {
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        return fail(
          `Expected object, received ${
            Array.isArray(input) ? "array" : typeof input
          }`
        );
      }
      return ok(input as Record<string, unknown>);
    }
  ) as RawRecordSchema;
}
