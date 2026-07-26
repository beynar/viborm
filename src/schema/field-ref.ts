/**
 * Field references (Prisma `FieldRef` parity)
 *
 * A field reference is an opaque, symbol-branded token that stands for a COLUMN
 * instead of a bound parameter in a filter operand position:
 *
 * ```ts
 * client.post.findMany({ where: { views: { gt: client.$fields.post.likes } } });
 * // -> ... WHERE "t0"."views" > "t0"."likes"
 * ```
 *
 * The token carries only what both the validation layer and the SQL builders
 * need — the owning model's schema key, the field's schema key, and the field's
 * scalar type — so it can be created without touching the model graph and
 * compared without any registry lookup.
 *
 * Two rules govern it, and each is enforced where it is actually decidable:
 *
 *  - TYPE. A reference's scalar type must match the filter operand's scalar
 *    type. Decided by the validation layer ({@link file://../validation/primitives/field-ref.ts}),
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
// TYPE-LEVEL PROJECTION: schema -> `$fields`
// =============================================================================

type ScalarsOf<M> = M extends { "~": { state: { scalars: infer S } } }
  ? S
  : never;

type ScalarTypeOf<S> = S extends {
  "~": { state: { type: infer T extends ScalarType } };
}
  ? T
  : ScalarType;

/** The `$fields.<model>` object: one reference per scalar field. */
export type ModelFieldRefs<TModelName extends string, M> = {
  readonly [K in keyof ScalarsOf<M> & string]: FieldRef<
    TModelName,
    ScalarTypeOf<ScalarsOf<M>[K]>
  >;
};

/** The whole `client.$fields` surface. */
export type SchemaFieldRefs<S> = {
  readonly [M in keyof S & string]: ModelFieldRefs<M, S[M]>;
};

// =============================================================================
// RUNTIME PROJECTION
// =============================================================================

const UNKNOWN_MODEL = (schema: Record<string, unknown>, key: string) =>
  new Error(
    `Unknown model "${key}" in $fields. Known models: ${Object.keys(schema).join(", ")}.`
  );

const UNKNOWN_FIELD = (modelName: string, key: string, known: string[]) =>
  new Error(
    `Unknown scalar field "${key}" on $fields.${modelName}. Known fields: ${known.join(", ")}.`
  );

function createModelFieldRefs(
  modelName: string,
  model: Model<any>
): Record<string, AnyFieldRef> {
  const cache = new Map<string, AnyFieldRef>();
  const scalars = model["~"].state.scalars;
  return new Proxy(Object.create(null) as Record<string, AnyFieldRef>, {
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
}

/**
 * Build the lazy `$fields` surface for a schema.
 *
 * Nothing is walked here: the returned proxy materializes a model's reference
 * table on first access and a single reference on first read, so a client that
 * never touches `$fields` pays exactly one object allocation for it.
 */
export function createSchemaFieldRefs<S extends Record<string, Model<any>>>(
  schema: S
): SchemaFieldRefs<S> {
  const cache = new Map<string, Record<string, AnyFieldRef>>();
  return new Proxy(Object.create(null) as SchemaFieldRefs<S>, {
    get(_target, key) {
      if (typeof key !== "string") return undefined;
      const cached = cache.get(key);
      if (cached) return cached;
      const model = Object.hasOwn(schema, key) ? schema[key] : undefined;
      if (!model) {
        throw UNKNOWN_MODEL(schema, key);
      }
      const refs = createModelFieldRefs(key, model);
      cache.set(key, refs);
      return refs;
    },
    has: (_target, key) =>
      typeof key === "string" && Object.hasOwn(schema, key),
    ownKeys: () => Object.keys(schema),
    getOwnPropertyDescriptor: () => ({
      enumerable: true,
      configurable: true,
    }),
  }) as SchemaFieldRefs<S>;
}
