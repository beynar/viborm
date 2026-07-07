// Select and include schema factories

import type { AnyModel } from "@schema/model";
import type { StringKeyOf } from "@schema/model/helper";
import type { ScalarState } from "@schema/scalars";
import v, { type V } from "../../primitives/v";
import type { ScalarSchemas } from "../index";

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
type VectorScalarKeys<M extends AnyModel> = {
  [K in keyof ModelScalars<M>]: ScalarStateOf<
    ModelScalars<M>[K]
  >["type"] extends "vector"
    ? K extends string
      ? K
      : never
    : never;
}[keyof ModelScalars<M>];
type NonVectorScalarKeys<M extends AnyModel> = Exclude<
  ModelScalarKey<M>,
  VectorScalarKeys<M>
>;

const scalarSelectSchema = v.boolean({ optional: true });
const vectorDistanceMetricSchema = v.enum(["l2", "cosine"]);

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
      _count: V.Object<
        {
          select: V.FromObject<
            F["relations"],
            "countFilter",
            { optional: true }
          >;
        },
        { optional: true }
      >;
    }
>;

export const getSelectSchema = <M extends AnyModel, F extends ScalarSchemas<M>>(
  model: M,
  fieldSchemas: F
): SelectSchema<M, F> => {
  // Scalar fields: boolean selection, plus vector-only computed distance select
  const vectorScalarKeys: VectorScalarKeys<M>[] = [];
  const nonVectorScalarKeys: NonVectorScalarKeys<M>[] = [];

  const scalarKeys = Object.keys(model["~"].state.scalars) as ModelScalarKey<M>[];
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

  // Relations: use relation's select schema (supports boolean or nested)
  const relationEntries = v.fromObject<F["relations"], "select">(
    fieldSchemas.relations,
    "select"
  );

  // _count entries: use a schema that accepts true or { where: ... }
  // This is different from the relation's select schema - we only need the filter capability
  const countSelectEntries = v.fromObject<
    F["relations"],
    "countFilter",
    { optional: true }
  >(fieldSchemas.relations, "countFilter", {
    optional: true,
  });

  return v.object({
    ...scalarEntries.entries,
    ...vectorEntries.entries,
    ...relationEntries.entries,
    _count: v.object(
      {
        select: countSelectEntries,
      },
      { optional: true }
    ),
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
    _count: V.Object<
      {
        select: V.FromObject<F["relations"], "countFilter", { optional: true }>;
      },
      { optional: true }
    >;
  }
>;

export const getIncludeSchema = <F extends RelationSchemaBundle>(
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

  // Prisma supports `_count` under include as well as select; mirror the
  // select-schema entry so `include: { _count: { select: { posts: true } } }`
  // validates (the query engine already builds _count in include position).
  const countSelectEntries = v.fromObject<
    F["relations"],
    "countFilter",
    { optional: true }
  >(schemas.relations, "countFilter", {
    optional: true,
  });

  return v.object({
    ...relationEntries.entries,
    _count: v.object(
      {
        select: countSelectEntries,
      },
      { optional: true }
    ),
  });
};
