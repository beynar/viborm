// Comparison Operand Schemas
//
// A comparison operand is the right-hand side of a scalar filter: the thing a
// column is compared AGAINST. Four kinds live here, and this file is the only
// place that decides which of them a given position accepts:
//
//   1. a plain value        `{ views: { gt: 10 } }`
//   2. a field reference    `{ views: { gt: <FieldRef> } }`      -> another column
//   3. an SQL fragment      `{ views: { gt: sql`…` } }`          -> escape hatch
//   4. a callback           `{ views: { gt: (ctx) => … } }`      -> sugar for 2 and 3
//
// The callback is RESOLVED HERE, during validation: it is invoked once and its
// return value substituted, so the query engine's operand invariant stays
// exactly "plain value | FieldRef | Sql" and no function ever reaches it. That
// is what keeps validation the single home for payload normalization — the
// engine does not learn a fourth operand kind, and neither does the cache key.

import {
  type AnyFieldRef,
  createModelFieldRefs,
  type FieldRef,
  fieldRefPayload,
  isFieldRef,
  type ModelFieldRefs,
} from "@schema/field-ref";
import type { AnyModel } from "@schema/model";
import type { ScalarType } from "@schema/scalars/common";
import { isSql, type Sql, sql } from "@sql";
import type { InferInput, InferOutput, VibSchema } from "../types";
import { isFunction, isRecord } from "../value-guards";
import { createSchema, fail, ok, validateSchema } from "./helpers";

// =============================================================================
// THE CALLBACK CONTEXT
// =============================================================================

/**
 * What a comparison-operand callback is handed.
 *
 * `fields` is the CURRENT model's reference table — the model whose filter the
 * operand sits in, which for a nested relation filter is the relation's TARGET,
 * not the root. Correlated references to an enclosing scope are deliberately
 * absent: a field reference compares two columns of the SAME row, and widening
 * that is a separate decision.
 *
 * `sql` is the ordinary tagged template; interpolations inside a fragment ride
 * along as bound parameters (see {@link file://../../sql/sql.ts}).
 */
export interface OperandCtx<TModel> {
  readonly fields: ModelFieldRefs<string, TModel>;
  readonly sql: typeof sql;
}

/** An operand context for an unknown model — the type-level default. */
export type AnyOperandCtx = OperandCtx<any>;

/**
 * A comparison-operand callback: invoked once during validation, and required
 * to return a field reference or an SQL fragment.
 *
 * PURITY IS THE CONTRACT. Validation may run a payload's callbacks more than
 * once — `upsert` re-parses its taken arm (the C2 residue), so a callback under
 * `upsert.update` can be invoked twice for one call. A callback that counts its
 * calls, mutates outer state, or returns a different fragment each time gets
 * exactly what it asks for; a pure one is indistinguishable from a literal
 * token, which is the whole point of the sugar.
 */
export type OperandCallback<TType extends ScalarType, TModel> = (
  ctx: OperandCtx<TModel>
) => FieldRef<string, TType> | Sql;

// =============================================================================
// THE PER-MODEL SCOPE
// =============================================================================

/**
 * The model whose filter is currently being validated.
 *
 * WHY AN AMBIENT SCOPE RATHER THAN A BAKED-IN CONTEXT: scalar filter schemas are
 * INTERNED across models on purpose (see `validation/scalars/intern.ts`) — two
 * `s.string()` fields on different models share one filter tree — so an operand
 * schema cannot carry a model. What IS per-model is the `where` schema that
 * contains it, and every re-scoping boundary is one of those (a nested relation
 * filter embeds the TARGET model's `where`). So the boundary pushes the model
 * and the operand reads it. Validation is synchronous and depth-first, which is
 * what makes a single slot with save/restore exact rather than merely likely.
 */
let activeModel: AnyModel | undefined;

/** Contexts are built on first use and memoized per model. */
const contexts = new WeakMap<AnyModel, AnyOperandCtx>();

/**
 * Run `validate` with `model` as the operand scope, restoring the previous one
 * afterwards. Re-entrant: a nested relation filter pushes its own target and
 * pops back to the parent.
 */
export function runInOperandScope<T>(model: AnyModel, validate: () => T): T {
  const previous = activeModel;
  activeModel = model;
  try {
    return validate();
  } finally {
    activeModel = previous;
  }
}

/**
 * Re-close a schema onto a model: everything validated through it resolves its
 * operand callbacks against `model`.
 *
 * The wrap is applied IN PLACE, and both reasons matter. The schema is a
 * freshly built, model-owned object whose `entries` / `extend` surface its own
 * factory and the factories above it still read, so returning a different object
 * would either lose that surface or force a copy of every entry. And a `where`
 * is SELF-REFERENTIAL — its `AND`/`OR`/`NOT` thunks close over the very const
 * being returned — so a copy would leave the recursion pointing at the
 * unwrapped original.
 */
export function scopeOperands<S extends VibSchema<any, any>>(
  schema: S,
  model: AnyModel
): S {
  const standard = schema["~standard"] as {
    validate: (value: unknown) => unknown;
  };
  const inner = standard.validate;
  standard.validate = (value: unknown) =>
    runInOperandScope(model, () => inner(value));
  return schema;
}

/** The context for the model in scope, or `undefined` outside any filter. */
function currentContext(): AnyOperandCtx | undefined {
  const model = activeModel;
  if (!model) return undefined;
  const cached = contexts.get(model);
  if (cached) return cached;
  const context: AnyOperandCtx = {
    fields: createModelFieldRefs(model["~"].names.ts ?? "unknown", model),
    sql,
  };
  contexts.set(model, context);
  return context;
}

// =============================================================================
// THE OPERAND SCHEMA
// =============================================================================

/**
 * A comparison operand: the wrapped scalar schema, a field reference of
 * `TType`, an SQL fragment, or a callback returning one of the latter two.
 *
 * This is deliberately not `v.union([...])`: a union would rewrite every
 * existing operand's failure message into "Value did not match any union
 * member: …". Here each non-value kind is recognized by its own discriminator,
 * so an ordinary bad value is handed straight to the wrapped schema and keeps
 * its exact message.
 *
 * The reference's MODEL is not checked here — scalar filter schemas are interned
 * across models and carry no model identity (see `validation/scalars/intern.ts`);
 * the same-model rule is a query-scope property and is enforced by the
 * where-builder before any I/O. See {@link file://../../schema/field-ref.ts}.
 */
export interface ComparisonOperandSchema<
  TType extends ScalarType,
  TSchema extends VibSchema<any, any>,
  TCtx extends AnyOperandCtx = AnyOperandCtx,
> extends VibSchema<
    | InferInput<TSchema>
    | FieldRef<string, TType>
    | Sql
    | ((ctx: TCtx) => FieldRef<string, TType> | Sql),
    InferOutput<TSchema> | FieldRef<string, TType> | Sql
  > {
  readonly type: "comparison_operand";
  /** The scalar type a reference must carry to be accepted. */
  readonly fieldType: TType;
  /** The literal-operand schema this wraps. */
  readonly wrapped: TSchema;
  /** Mirrors the wrapped schema, for the object validator's absent-key path. */
  readonly acceptsUndefined: boolean;
}

const CALLBACK_OUT_OF_SCOPE =
  "A filter callback is only meaningful inside a model filter, where the model whose columns it names is known.";

const RETURN_REFUSAL =
  "A filter callback must return a field reference (ctx.fields.<field>) or an SQL fragment (ctx.sql`…`)";

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a value of type '${typeof value}'`;
}

function resolveCallback(
  callback: (ctx: AnyOperandCtx) => unknown,
  fieldType: ScalarType
) {
  const context = currentContext();
  if (!context) {
    return fail(CALLBACK_OUT_OF_SCOPE);
  }

  let returned: unknown;
  try {
    returned = callback(context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(`Filter callback threw: ${message}`);
  }

  if (isFieldRef(returned)) {
    return checkRef(returned, fieldType);
  }
  if (isSql(returned)) {
    return ok(returned);
  }
  if (isRecord(returned) && isFunction(returned.then)) {
    return fail(
      `${RETURN_REFUSAL}; it returned a promise. Validation is synchronous, so a filter callback cannot be async.`
    );
  }
  return fail(`${RETURN_REFUSAL}; it returned ${describe(returned)}.`);
}

/**
 * Build a comparison operand around a scalar schema.
 *
 * ATTACH IT ONLY WHERE THE ENGINE CAN COMPILE THE RESULT. Acceptance that
 * outruns the builder is accept-and-ignore with extra steps: today that means
 * `equals` / `not` / `lt` / `lte` / `gt` / `gte` on non-list scalar filters, and
 * nothing else. `in` / `notIn` and the list operators take VALUES, `having` is
 * an aggregate over a group rather than a column of one row, and the string
 * predicates keep the narrower {@link fieldRefOr} (a reference, no fragment).
 */
export function comparisonOperand<
  TType extends ScalarType,
  TSchema extends VibSchema<any, any>,
  TCtx extends AnyOperandCtx = AnyOperandCtx,
>(
  fieldType: TType,
  wrapped: TSchema
): ComparisonOperandSchema<TType, TSchema, TCtx> {
  const schema = createSchema<
    | InferInput<TSchema>
    | FieldRef<string, TType>
    | Sql
    | ((ctx: TCtx) => FieldRef<string, TType> | Sql),
    InferOutput<TSchema> | FieldRef<string, TType> | Sql
  >("comparison_operand", (value) => {
    if (isFunction(value)) {
      return resolveCallback(
        value as (ctx: AnyOperandCtx) => unknown,
        fieldType
      ) as never;
    }
    if (isFieldRef(value)) {
      return checkRef(value, fieldType) as never;
    }
    if (isSql(value)) {
      return ok(value) as never;
    }
    return validateSchema(wrapped, value) as never;
  }) as ComparisonOperandSchema<TType, TSchema, TCtx>;

  (schema as { fieldType: TType }).fieldType = fieldType;
  (schema as { wrapped: TSchema }).wrapped = wrapped;
  // Neither a reference, a fragment, nor a callback is ever a default;
  // optionality is entirely the wrapped schema's business, so mirror it for the
  // object validator's fast path.
  (schema as { acceptsUndefined: boolean }).acceptsUndefined =
    (wrapped as { acceptsUndefined?: boolean }).acceptsUndefined === true;

  return schema;
}

// =============================================================================
// FIELD-REFERENCE-ONLY OPERAND
// =============================================================================

/**
 * A comparison operand that accepts EITHER a field reference of `TType` or the
 * wrapped scalar schema — no fragment, no callback.
 *
 * This is what the string predicates (`contains` / `startsWith` / `endsWith`)
 * take: the builder compiles a referenced column there, so the reference stays,
 * while the fragment and its callback sugar are drawn at the comparison
 * operators only.
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
    (wrapped as { acceptsUndefined?: boolean }).acceptsUndefined === true;

  return schema;
}

// =============================================================================
// RE-CLOSING WRAPPER
// =============================================================================

/**
 * Re-closes a schema that transitively opened a non-value operand.
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

function closeOperands<TSchema extends VibSchema<any, any>>(
  wrapped: TSchema,
  where: string,
  fragments: boolean
): NoFieldRefSchema<TSchema> {
  const schema = createSchema<InferInput<TSchema>, InferOutput<TSchema>>(
    "no_field_ref",
    (value) => {
      const result = validateSchema(wrapped, value);
      if (result.issues) return result as never;
      const found = findOpaqueOperand(
        (result as { value: unknown }).value,
        fragments
      );
      if (found) {
        return fail(`${found} is not supported in ${where}.`);
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
 * Close a schema to field references only.
 *
 * For the sites whose wrapped schema legitimately holds ARBITRARY DATA — the
 * JSON operand and JSON write data. Only the branded token is looked for there,
 * because it is the only non-value an ordinary document cannot also be: a real
 * `Sql` is a class instance and `v.json` already rejects it as
 * non-JSON-compatible, while a plain `{ strings: […], values: […] }` document
 * that merely LOOKS like a fragment is honest user data and must stay accepted.
 */
export function noFieldRef<TSchema extends VibSchema<any, any>>(
  wrapped: TSchema,
  where: string
): NoFieldRefSchema<TSchema> {
  return closeOperands(wrapped, where, false);
}

/**
 * Close a schema to field references AND SQL fragments.
 *
 * For the sites whose wrapped schema is a SCALAR FILTER — `having`, where a
 * fragment is refused for the same reason a reference is: whatever it names, it
 * is not the aggregate the group is keyed by. A plain object cannot be a legal
 * scalar operand in the first place, so there is no honest value here for the
 * structural fragment check to misread.
 */
export function noOperandExpression<TSchema extends VibSchema<any, any>>(
  wrapped: TSchema,
  where: string
): NoFieldRefSchema<TSchema> {
  return closeOperands(wrapped, where, true);
}

/**
 * Exhaustive, cycle-safe search for a field-reference token or an SQL fragment
 * inside an already-validated value; returns how to name the one it found.
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
function findOpaqueOperand(
  root: unknown,
  fragments: boolean
): string | undefined {
  const seen = new WeakSet<object>();
  const pending: unknown[] = [root];

  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value !== "object" || value === null) continue;
    if (isFieldRef(value)) {
      const payload = fieldRefPayload(value);
      return `Field reference '${payload.model}.${payload.field}'`;
    }
    if (fragments && isSql(value)) return "An SQL fragment";
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
  const payload = fieldRefPayload(ref);
  if (payload.list) {
    return fail(
      `Field reference '${payload.model}.${payload.field}' is a list field; list fields cannot be used as a comparison operand.`
    );
  }
  if (payload.type !== fieldType) {
    return fail(
      `Field reference '${payload.model}.${payload.field}' is of type '${payload.type}', but a '${fieldType}' operand is required here.`
    );
  }
  return ok(ref) as never;
}
