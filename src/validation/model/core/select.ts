// Select and include schema factories

import type { AnyModel } from "@schema/model";
import type { StringKeyOf } from "@schema/model/helper";
import type { AnyRelation } from "@schema/relation";
import type { ScalarState } from "@schema/scalars";
import v, { type V } from "../../primitives/v";
import type { ScalarSchemas } from "../index";
import {
  type ProjectableScalarKeys,
  projectableScalarNames,
} from "./projection";

// =============================================================================
// SELECT SCHEMA
// =============================================================================

/**
 * Build select schema - boolean selection for each scalar field, nested select for relations
 */
type ModelStateOf<M extends AnyModel> = M["~"]["state"];
type ModelScalars<M extends AnyModel> = ModelStateOf<M>["scalars"];
type ModelScalarKey<M extends AnyModel> = StringKeyOf<ModelScalars<M>>;
type ScalarStateOf<F> = F extends { "~": { state: infer S } }
  ? S extends ScalarState
    ? S
    : never
  : never;
type AnyVectorScalarKeys<M extends AnyModel> = {
  [K in keyof ModelScalars<M>]: ScalarStateOf<
    ModelScalars<M>[K]
  >["type"] extends "vector"
    ? K extends string
      ? K
      : never
    : never;
}[keyof ModelScalars<M>];
/**
 * Both halves of the select schema are keyed on {@link ProjectableScalarKeys},
 * so a model-level `.omit()`-ed scalar has no `select` entry at all: naming it
 * is an "Unknown key" parse failure rather than a way around the schema's own
 * exclusion. See `projection.ts` for why that layer is hard and the other two
 * are not.
 */
type VectorScalarKeys<M extends AnyModel> = Extract<
  ProjectableScalarKeys<M>,
  AnyVectorScalarKeys<M>
>;
type NonVectorScalarKeys<M extends AnyModel> = Exclude<
  ProjectableScalarKeys<M>,
  AnyVectorScalarKeys<M>
>;

const scalarSelectSchema = v.boolean({ optional: true });
const vectorDistanceMetricSchema = v.enum(["l2", "cosine"]);

// =============================================================================
// _count SCHEMA (object form + Prisma's `_count: true` shorthand)
// =============================================================================

/** The desugared shorthand: one `true` entry per counted relation. */
type CountAllSelection = Record<string, true>;

/**
 * `_count` accepts either Prisma's shorthand `true` or the explicit
 * `{ select: { <relation>: true | { where } } }` object. The shorthand is
 * desugared here, so everything downstream (query engine, result parser) only
 * ever sees the object form.
 */
export type CountSchema<F extends { relations: Record<string, any> }> = V.Union<
  readonly [
    V.Coerce<V.Literal<true>, { select: CountAllSelection }>,
    V.Object<
      {
        select: V.FromObject<F["relations"], "countFilter", { optional: true }>;
      },
      { optional: true }
    >,
  ]
>;

/**
 * Prisma's `_count: true` means "count every LIST relation of this model": the
 * generated `<Model>CountOutputType` contains only to-many (`oneToMany` /
 * `manyToMany`) fields — a to-one relation never appears there. viborm's
 * explicit object form is a deliberate superset (name a to-one relation and it
 * will be counted), but the shorthand mirrors Prisma's rule exactly.
 *
 * A model with no to-many relations expands to `{ select: {} }` — exactly what
 * the explicit empty object form does today (no relation-count key in the
 * result). Prisma generates no `_count` at all for such a model, so there is no
 * Prisma behavior to mirror; the pinned contract is that equivalence.
 */
const toManyRelationNames = (model: AnyModel): string[] => {
  const relations: Record<string, AnyRelation> = model["~"].state.relations;
  const names: string[] = [];
  for (const name of Object.keys(relations)) {
    const type = relations[name]?.["~"].state.type;
    if (type === "oneToMany" || type === "manyToMany") {
      names.push(name);
    }
  }
  return names;
};

const getCountSchema = <F extends { relations: Record<string, any> }>(
  model: AnyModel,
  schemas: F
): CountSchema<F> => {
  const countAllNames = toManyRelationNames(model);

  return v.union([
    // A fresh object per parse — the desugared value is handed to the engine
    // and must never alias a schema-level singleton.
    v.coerce(v.literal(true), (): { select: CountAllSelection } => {
      const select: CountAllSelection = {};
      for (const name of countAllNames) {
        select[name] = true;
      }
      return { select };
    }),
    v.object(
      {
        select: v.fromObject<F["relations"], "countFilter", { optional: true }>(
          schemas.relations,
          "countFilter",
          { optional: true }
        ),
      },
      { optional: true }
    ),
  ]) as CountSchema<F>;
};

export const vectorDistanceSelectSchema = v.object(
  {
    _distance: v.object(
      {
        to: v.array(v.number()),
        metric: vectorDistanceMetricSchema,
      },
      { partial: false }
    ),
  },
  { partial: false }
);
export type VectorDistanceSelectSchema = typeof vectorDistanceSelectSchema;

const vectorScalarSelectSchema = v.union([
  scalarSelectSchema,
  vectorDistanceSelectSchema,
]);
type VectorScalarSelectSchema = typeof vectorScalarSelectSchema;

export type SelectSchema<
  M extends AnyModel,
  F extends ScalarSchemas<M>,
> = V.Object<
  V.FromKeys<NonVectorScalarKeys<M>[], typeof scalarSelectSchema>["entries"] &
    V.FromKeys<VectorScalarKeys<M>[], VectorScalarSelectSchema>["entries"] &
    V.FromObject<F["relations"], "select">["entries"] & {
      _count: CountSchema<F>;
    }
>;

/** The scalar half of a select schema, shared by both factories below. */
const getScalarSelectEntries = <M extends AnyModel>(model: M) => {
  // Scalar fields: boolean selection, plus vector-only computed distance select
  const vectorScalarKeys: VectorScalarKeys<M>[] = [];
  const nonVectorScalarKeys: NonVectorScalarKeys<M>[] = [];

  const scalarKeys = projectableScalarNames(model) as ModelScalarKey<M>[];
  for (const fieldName of scalarKeys) {
    const scalar = model["~"].state.scalars[fieldName];
    if (scalar["~"].state.type === "vector") {
      vectorScalarKeys.push(fieldName as VectorScalarKeys<M>);
      continue;
    }
    nonVectorScalarKeys.push(fieldName as NonVectorScalarKeys<M>);
  }

  const scalarEntries = v.fromKeys<
    NonVectorScalarKeys<M>[],
    typeof scalarSelectSchema
  >(nonVectorScalarKeys, scalarSelectSchema);
  const vectorEntries = v.fromKeys<
    VectorScalarKeys<M>[],
    typeof vectorScalarSelectSchema
  >(vectorScalarKeys, vectorScalarSelectSchema);

  return { ...scalarEntries.entries, ...vectorEntries.entries };
};

/**
 * The SCALAR-ONLY projection: {@link SelectSchema} without relation keys and
 * without `_count`.
 *
 * This is the projection of a bulk write (`createMany` / `updateMany` /
 * `deleteMany` with a `select`). Those rows come out of the write statement's
 * `RETURNING` clause — an expression list with no table alias to correlate
 * against — so a relation subquery embedded there binds its outer column
 * reference by NAME and is silently captured by the inner table whenever the two
 * share a column name. The observable result was wrong data, not an error: a
 * to-many relation always came back `[]`, and a self-referencing to-one came
 * back `null`, while the identical projection through `findMany` returned the
 * real rows. Refusing the key is the fail-closed answer; read relations in a
 * separate query, which is what the underlying implementation would have to do
 * anyway.
 *
 * Prisma divergence, deliberate: Prisma's `createManyAndReturn` /
 * `updateManyAndReturn` DO accept relations here — its generator emits dedicated
 * `<Model>SelectCreateManyAndReturn` / `<Model>IncludeCreateManyAndReturn` types
 * (prisma 6.8.2, `prisma-client/generator-build`, `Model.argsTypes`).
 */
export type ScalarSelectSchema<M extends AnyModel> = V.Object<
  V.FromKeys<NonVectorScalarKeys<M>[], typeof scalarSelectSchema>["entries"] &
    V.FromKeys<VectorScalarKeys<M>[], VectorScalarSelectSchema>["entries"]
>;

export const getScalarSelectSchema = <M extends AnyModel>(
  model: M
): ScalarSelectSchema<M> => v.object(getScalarSelectEntries(model));

export const getSelectSchema = <M extends AnyModel, F extends ScalarSchemas<M>>(
  model: M,
  fieldSchemas: F
): SelectSchema<M, F> => {
  const scalarEntries = getScalarSelectEntries(model);

  // Relations: use relation's select schema (supports boolean or nested)
  const relationEntries = v.fromObject<F["relations"], "select">(
    fieldSchemas.relations,
    "select"
  );

  return v.object({
    ...scalarEntries,
    ...relationEntries.entries,
    // Accepts `true` (count every to-many relation) or the explicit
    // { select: { <relation>: true | { where } } } object.
    _count: getCountSchema(model, fieldSchemas),
  });
};

// =============================================================================
// INCLUDE SCHEMA
// =============================================================================

/**
 * Build include schema - nested include for each relation
 */

type RelationSchemaBundle = { relations: Record<string, any> };

export type IncludeSchema<F extends RelationSchemaBundle> = V.Object<
  V.FromObject<F["relations"], "include", { optional: true }>["entries"] & {
    _count: CountSchema<F>;
  }
>;

export const getIncludeSchema = <F extends RelationSchemaBundle>(
  model: AnyModel,
  schemas: F
): IncludeSchema<F> => {
  // Relations: use relation's include schema (supports boolean or nested with where/orderBy/etc.)
  const relationEntries = v.fromObject<
    F["relations"],
    "include",
    { optional: true }
  >(schemas.relations, "include", {
    optional: true,
  });

  return v.object({
    ...relationEntries.entries,
    // Prisma supports `_count` under include as well as select — both the
    // `true` shorthand and the explicit object; mirror the select-schema entry
    // (the query engine already builds _count in include position).
    _count: getCountSchema(model, schemas),
  });
};
