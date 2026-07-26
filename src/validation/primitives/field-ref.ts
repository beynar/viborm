// Field Reference Operand Schemas
// Accepts a Prisma-style FieldRef token wherever a scalar comparison operand
// goes, without disturbing the operand's own error surface.

import { type AnyFieldRef, type FieldRef, isFieldRef } from "@schema/field-ref";
import type { ScalarType } from "@schema/scalars/common";
import type { InferInput, InferOutput, VibSchema } from "../types";
import { createSchema, fail, ok, validateSchema } from "./helpers";

/**
 * A comparison operand that accepts EITHER a field reference of `TType` or the
 * wrapped scalar schema.
 *
 * This is deliberately not `v.union([fieldRef, schema])`: a union would rewrite
 * every existing operand's failure message into "Value did not match any union
 * member: …". Here the brand check is the discriminator, so a non-reference
 * value is handed straight to the wrapped schema and keeps its exact message,
 * and a reference gets a reference-specific one.
 *
 * The reference's MODEL is not checked here — scalar filter schemas are interned
 * across models and carry no model identity (see `validation/scalars/intern.ts`);
 * the same-model rule is a query-scope property and is enforced by the
 * where-builder before any I/O. See {@link file://../../schema/field-ref.ts}.
 */
export interface FieldRefOrSchema<
  TType extends ScalarType,
  TSchema extends VibSchema<any, any>,
> extends VibSchema<
    InferInput<TSchema> | FieldRef<string, TType>,
    InferOutput<TSchema> | FieldRef<string, TType>
  > {
  readonly type: "field_ref_or";
  /** The scalar type a reference must carry to be accepted. */
  readonly fieldType: TType;
  /** The literal-operand schema this wraps. */
  readonly wrapped: TSchema;
  /** Mirrors the wrapped schema, for the object validator's absent-key path. */
  readonly acceptsUndefined: boolean;
}

export function fieldRefOr<
  TType extends ScalarType,
  TSchema extends VibSchema<any, any>,
>(fieldType: TType, wrapped: TSchema): FieldRefOrSchema<TType, TSchema> {
  const schema = createSchema<
    InferInput<TSchema> | FieldRef<string, TType>,
    InferOutput<TSchema> | FieldRef<string, TType>
  >("field_ref_or", (value) => {
    if (isFieldRef(value)) {
      return checkRef(value, fieldType);
    }
    return validateSchema(wrapped, value) as never;
  }) as FieldRefOrSchema<TType, TSchema>;

  (schema as { fieldType: TType }).fieldType = fieldType;
  (schema as { wrapped: TSchema }).wrapped = wrapped;
  // A reference is never a default; optionality is entirely the wrapped
  // schema's business, so mirror it for the object validator's fast path.
  (schema as { acceptsUndefined: boolean }).acceptsUndefined =
    (wrapped as { acceptsUndefined?: boolean }).acceptsUndefined ?? false;

  return schema;
}

/**
 * Re-closes a schema that transitively opened a field-reference operand.
 *
 * Scalar filter schemas are shared: `having` reuses the very same interned
 * filter a `where` uses. Prisma does not allow field references in
 * `having`/`groupBy` (a HAVING operand is an aggregate over a group, not a
 * column of one row), and neither do we — so the reuse site wraps itself and
 * fails closed instead of inheriting the operand by accident.
 */
export interface NoFieldRefSchema<TSchema extends VibSchema<any, any>>
  extends VibSchema<InferInput<TSchema>, InferOutput<TSchema>> {
  readonly type: "no_field_ref";
  readonly wrapped: TSchema;
  readonly acceptsUndefined: boolean;
}

export function noFieldRef<TSchema extends VibSchema<any, any>>(
  wrapped: TSchema,
  where: string
): NoFieldRefSchema<TSchema> {
  const schema = createSchema<InferInput<TSchema>, InferOutput<TSchema>>(
    "no_field_ref",
    (value) => {
      const result = validateSchema(wrapped, value);
      if (result.issues) return result as never;
      const found = findFieldRef((result as { value: unknown }).value);
      if (found) {
        return fail(
          `Field reference '${found.model}.${found.field}' is not supported in ${where}.`
        );
      }
      return result as never;
    }
  ) as NoFieldRefSchema<TSchema>;

  (schema as { wrapped: TSchema }).wrapped = wrapped;
  (schema as { acceptsUndefined: boolean }).acceptsUndefined =
    (wrapped as { acceptsUndefined?: boolean }).acceptsUndefined ?? false;

  return schema;
}

/**
 * Exhaustive, cycle-safe search for a field-reference token inside an
 * already-validated value.
 *
 * There is deliberately NO depth cap. An earlier version stopped at four levels
 * on the premise that "filter values nest at most a couple of levels" — false
 * on this branch, where scalar `not` nests arbitrarily
 * (`{ not: { not: { … { gt: ref } } } }`, see `buildNegatableFilterSchema`). A
 * five-deep chain therefore walked straight past the guard and emitted the
 * referenced column into HAVING: Postgres rejected the ungrouped column,
 * SQLite/LibSQL accepted it and returned a silently wrong row. A guard that
 * stops looking is accept-and-ignore, which is precisely what this wrapper
 * exists to prevent.
 *
 * Termination comes from structure, not from a budget: every object and array
 * is visited at most once (`seen`), so the walk is linear in the number of
 * distinct nodes the caller already materialized — the same order the
 * `validateSchema` call directly above just spent walking the very same value.
 * The worklist is explicit rather than recursive so a pathologically deep
 * payload cannot overflow the stack here. Binary payloads are skipped whole:
 * bytes cannot be a reference, and `Object.keys` on a typed array would
 * enumerate every index.
 */
function findFieldRef(root: unknown): AnyFieldRef | undefined {
  const seen = new WeakSet<object>();
  const pending: unknown[] = [root];

  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value !== "object" || value === null) continue;
    if (isFieldRef(value)) return value;
    if (seen.has(value)) continue;
    seen.add(value);

    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) continue;

    if (Array.isArray(value)) {
      for (const item of value) pending.push(item);
      continue;
    }

    for (const key of Object.keys(value)) {
      pending.push((value as Record<string, unknown>)[key]);
    }
  }

  return undefined;
}

function checkRef(ref: AnyFieldRef, fieldType: ScalarType) {
  if (ref.list) {
    return fail(
      `Field reference '${ref.model}.${ref.field}' is a list field; list fields cannot be used as a comparison operand.`
    );
  }
  if (ref.type !== fieldType) {
    return fail(
      `Field reference '${ref.model}.${ref.field}' is of type '${ref.type}', but a '${fieldType}' operand is required here.`
    );
  }
  return ok(ref) as never;
}
