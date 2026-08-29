import type { AnyModel } from "@schema/model";
import type { DecimalListScalarKeys, StringKeyOf } from "@schema/model/helper";
import type { ScalarState } from "@schema/scalars";
import v, { type V } from "../../primitives/v";
import type { VibSchema } from "../../types";
import type { ScalarSchemas } from "../index";

const orderEnum = v.enum(["asc", "desc"]);
const vectorDistanceMetricSchema = v.enum(["l2", "cosine"]);
const forbiddenOrderByKeySchema = (key: string): VibSchema<never, never> =>
  v.refused(`OrderBy key '${key}' is not valid here.`);

export const sortOrderSchema = v.union([
  orderEnum,
  v.object(
    {
      sort: orderEnum,
      nulls: v.enum(["first", "last"]),
      _distance: forbiddenOrderByKeySchema("_distance"),
    },
    { atLeast: ["sort"] }
  ),
]);
export type SortOrderSchema = typeof sortOrderSchema;

export const vectorDistanceOrderSchema = v.object(
  {
    _distance: v.object(
      {
        to: v.array(v.number()),
        metric: vectorDistanceMetricSchema,
        sort: orderEnum,
      },
      { atLeast: ["to", "metric"] }
    ),
    sort: forbiddenOrderByKeySchema("sort"),
    nulls: forbiddenOrderByKeySchema("nulls"),
  },
  { atLeast: ["_distance"] }
);
export type VectorDistanceOrderSchema = typeof vectorDistanceOrderSchema;

export const vectorSortOrderSchema = v.union([
  sortOrderSchema,
  vectorDistanceOrderSchema,
]);
export type VectorSortOrderSchema = typeof vectorSortOrderSchema;

/**
 * Build orderBy schema - sort direction for each scalar field and nested relation ordering
 */
type ModelStateOf<M extends AnyModel> = M["~"]["state"];
type ModelScalars<M extends AnyModel> = ModelStateOf<M>["scalars"];
type ModelScalarKey<M extends AnyModel> = StringKeyOf<ModelScalars<M>>;
type ScalarStateOf<F> = F extends { "~": { state: infer S } }
  ? S extends ScalarState
    ? S
    : never
  : never;
type ModelDecimalListScalarKeys<M extends AnyModel> = Extract<
  DecimalListScalarKeys<ModelScalars<M>>,
  ModelScalarKey<M>
>;
export type OrderableScalarKeys<M extends AnyModel> = Exclude<
  ModelScalarKey<M>,
  ModelDecimalListScalarKeys<M>
>;
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
  OrderableScalarKeys<M>,
  VectorScalarKeys<M>
>;

/** A decimal list has equality semantics, but no portable numeric ordering. */
export const isOrderableScalarState = (state: ScalarState): boolean =>
  state.type !== "decimal" || state.array !== true;

export const decimalListOrderByRefusalSchema = v.refused(
  "A decimal list cannot be used for numeric ordering."
);
export type DecimalListOrderByRefusalSchema =
  typeof decimalListOrderByRefusalSchema;

export function isDecimalListScalarKey<M extends AnyModel>(
  model: M,
  fieldName: ModelScalarKey<M>
): fieldName is ModelDecimalListScalarKeys<M> {
  const state = model["~"].state.scalars[fieldName]["~"].state;
  return state.type === "decimal" && state.array === true;
}

/**
 * A polymorphic slot is orderable exactly as far as its cardinality allows: a
 * COLLECTION offers `{ _count }` like any list relation, a to-one slot offers a
 * named refusal (there is no single column to sort by when the target model is
 * chosen per row). Both entries exist, because the family key set is identical
 * across cardinalities — see `relations/polymorphic/index.ts` for why.
 */
export type OrderBySchema<
  M extends AnyModel,
  F extends ScalarSchemas<M>,
> = V.Object<
  V.FromKeys<NonVectorScalarKeys<M>[], SortOrderSchema>["entries"] &
    V.FromKeys<VectorScalarKeys<M>[], VectorSortOrderSchema>["entries"] &
    V.FromKeys<
      ModelDecimalListScalarKeys<M>[],
      DecimalListOrderByRefusalSchema
    >["entries"] &
    V.FromObject<F["relations"], "orderBy">["entries"] &
    V.FromObject<F["polymorphic"], "orderBy">["entries"]
>;
export const getOrderBySchema = <
  M extends AnyModel,
  F extends ScalarSchemas<M>,
>(
  model: M,
  fieldSchemas: F
): OrderBySchema<M, F> => {
  const vectorScalarKeys: VectorScalarKeys<M>[] = [];
  const nonVectorScalarKeys: NonVectorScalarKeys<M>[] = [];
  const decimalListScalarKeys: ModelDecimalListScalarKeys<M>[] = [];

  const scalarKeys = Object.keys(
    model["~"].state.scalars
  ) as ModelScalarKey<M>[];

  for (const fieldName of scalarKeys) {
    if (isDecimalListScalarKey(model, fieldName)) {
      decimalListScalarKeys.push(fieldName);
      continue;
    }
    const scalar = model["~"].state.scalars[fieldName];
    const state = scalar["~"].state;
    if (state.type === "vector") {
      vectorScalarKeys.push(fieldName as VectorScalarKeys<M>);
      continue;
    }
    nonVectorScalarKeys.push(fieldName as NonVectorScalarKeys<M>);
  }

  const scalarEntries = v.fromKeys<
    NonVectorScalarKeys<M>[],
    typeof sortOrderSchema
  >(nonVectorScalarKeys, sortOrderSchema);
  const vectorEntries = v.fromKeys<
    VectorScalarKeys<M>[],
    typeof vectorSortOrderSchema
  >(vectorScalarKeys, vectorSortOrderSchema);
  const decimalListEntries = v.fromKeys<
    ModelDecimalListScalarKeys<M>[],
    DecimalListOrderByRefusalSchema
  >(decimalListScalarKeys, decimalListOrderByRefusalSchema);

  const relationEntries = v.fromObject<F["relations"], "orderBy">(
    fieldSchemas.relations,
    "orderBy"
  );
  const polymorphicEntries = v.fromObject<F["polymorphic"], "orderBy">(
    fieldSchemas.polymorphic,
    "orderBy"
  );

  return v.object({
    ...scalarEntries.entries,
    ...vectorEntries.entries,
    ...decimalListEntries.entries,
    ...relationEntries.entries,
    ...polymorphicEntries.entries,
  });
};
