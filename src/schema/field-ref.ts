/**
 * Field references (Prisma `FieldRef` parity)
 *
 * A field reference is an opaque, symbol-branded token that stands for a COLUMN
 * instead of a bound parameter in a filter operand position:
 *
 * ```ts
 * client.post.findMany({ where: { views: { gt: (ctx) => ctx.fields.likes } } });
 * // -> ... WHERE "t0"."views" > "t0"."likes"
 * ```
 *
 * The token is the MECHANISM; the callback is the surface that hands one out —
 * `ctx.fields` is this file's per-model table, built for the model whose filter
 * the operand sits in (see `validation/primitives/operand.ts`). A token held
 * directly is just as valid: it is what the callback returns.
 *
 * The token carries only what both the validation layer and the SQL builders
 * need — the owning model's schema key, the field's schema key, and the field's
 * scalar type — so it can be created without touching the model graph and
 * compared without any registry lookup.
 *
 * Two rules govern it, and each is enforced where it is actually decidable:
 *
 *  - TYPE. A reference's scalar type must match the filter operand's scalar
 *    type. Decided by the validation layer ({@link file://../validation/primitives/operand.ts}),
 *    which knows the operand's type and nothing about models — scalar filter
 *    schemas are interned across models by design (see `validation/scalars/intern.ts`).
 *
 *  - SAME MODEL. A reference may only be used in a filter on its own model
 *    (Prisma's rule: a field reference compares two columns of the SAME row).
 *    Decided by the where-builder ({@link file://../query-engine/builders/where-builder.ts}),
 *    because "the model being filtered" is a property of the QUERY SCOPE, not of
 *    the schema: a nested relation `where` re-scopes to the relation's target
 *    model while reusing that model's own (interned, model-blind) filter schemas.
 *    The builder must resolve the referenced column against the current scope to
 *    emit it at all, so the check is intrinsic there, not a duplicated guard. It
 *    runs at SQL-build time — before any I/O.
 */

import type { Model } from "./model/model";
import type { ScalarType } from "./scalars/common";

/**
 * Brand carried by every field reference. `Symbol.for` (not a fresh symbol) so
 * a reference stays recognizable across duplicated module instances.
 */
export const FIELD_REF_BRAND: unique symbol = Symbol.for("viborm.field-ref");

/**
 * An opaque reference to a scalar column of `TModel`.
 *
 * `TType` is the field's scalar type; it is what makes an `Int` reference
 * unassignable to a `String` filter operand at the type level.
 */
export interface FieldRef<
  TModel extends string = string,
  TType extends ScalarType = ScalarType,
> {
  readonly [FIELD_REF_BRAND]: true;
  /** Schema key of the model owning the field (e.g. `"post"`). */
  readonly model: TModel;
  /** Schema key of the field (e.g. `"likes"`), NOT the mapped column name. */
  readonly field: string;
  /** Scalar type of the field (e.g. `"int"`). */
  readonly type: TType;
  /** Whether the field is a list scalar. List references are not supported. */
  readonly list: boolean;
}

/** Any field reference, regardless of model or scalar type. */
export type AnyFieldRef = FieldRef<string, ScalarType>;

/**
 * Runtime brand check. Deliberately a plain property probe: it runs once per
 * filter operand, so it must be a single `typeof` plus one symbol lookup.
 */
export function isFieldRef(value: unknown): value is AnyFieldRef {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { [FIELD_REF_BRAND]?: unknown })[FIELD_REF_BRAND] === true
  );
}

/** Human-readable spelling of a reference, for error messages. */
export function formatFieldRef(ref: AnyFieldRef): string {
  return `${ref.model}.${ref.field}`;
}

function createFieldRef(
  model: string,
  field: string,
  type: ScalarType,
  list: boolean
): AnyFieldRef {
  return Object.freeze({
    [FIELD_REF_BRAND]: true as const,
    model,
    field,
    type,
    list,
  });
}

// =============================================================================
// TYPE-LEVEL PROJECTION: model -> its reference table
// =============================================================================

type ScalarsOf<M> = M extends { "~": { state: { scalars: infer S } } }
  ? S
  : never;

type ScalarTypeOf<S> = S extends {
  "~": { state: { type: infer T extends ScalarType } };
}
  ? T
  : ScalarType;

/**
 * One model's reference table — the type of `ctx.fields` inside an operand
 * callback: one reference per scalar field, and nothing else on it, so a
 * mistyped field name is a compile error before it is a runtime one.
 */
export type ModelFieldRefs<TModelName extends string, M> = {
  readonly [K in keyof ScalarsOf<M> & string]: FieldRef<
    TModelName,
    ScalarTypeOf<ScalarsOf<M>[K]>
  >;
};

// =============================================================================
// RUNTIME PROJECTION
// =============================================================================

const UNKNOWN_FIELD = (modelName: string, key: string, known: string[]) =>
  new Error(
    `Unknown scalar field "${key}" on model '${modelName}'. Known fields: ${known.join(", ")}.`
  );

/**
 * The reference table for ONE model: `{ likes, views, … }`, each entry built on
 * first read and memoized.
 *
 * This is what an operand callback receives as `ctx.fields`, built once per
 * model and cached there — a query that never compares columns never builds
 * one, and a model's table costs a single object until a field is read. The
 * model name is passed in because the token carries the model's SCHEMA KEY,
 * which is what the where-builder compares the query scope against (hydration
 * sets `names.ts` to that key — see `hydration.ts`).
 */
export function createModelFieldRefs<
  TName extends string,
  M extends Model<any>,
>(modelName: TName, model: M): ModelFieldRefs<TName, M> {
  const cache = new Map<string, AnyFieldRef>();
  const scalars = model["~"].state.scalars;
  const table = new Proxy(Object.create(null) as Record<string, AnyFieldRef>, {
    get(_target, key) {
      if (typeof key !== "string") return undefined;
      const cached = cache.get(key);
      if (cached) return cached;
      const scalar = Object.hasOwn(scalars, key) ? scalars[key] : undefined;
      if (!scalar) {
        throw UNKNOWN_FIELD(modelName, key, Object.keys(scalars));
      }
      const state = scalar["~"].state;
      const ref = createFieldRef(modelName, key, state.type, state.array);
      cache.set(key, ref);
      return ref;
    },
    has: (_target, key) =>
      typeof key === "string" && Object.hasOwn(scalars, key),
    ownKeys: () => Object.keys(scalars),
    getOwnPropertyDescriptor: () => ({
      enumerable: true,
      configurable: true,
    }),
  });
  // The one projection this file owes its callers: the proxy answers exactly
  // the model's scalar keys (`has`/`ownKeys` above enforce it, and any other key
  // throws), which is what `ModelFieldRefs` describes and no proxy signature can.
  return table as ModelFieldRefs<TName, M>;
}
