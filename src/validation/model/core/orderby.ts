import type { AnyModel } from "@schema/model";
import type { StringKeyOf } from "@schema/model/helper";
import type { ScalarState } from "@schema/scalars";
import v, { type V } from "../../primitives/v";
import type { ScalarSchemas } from "../index";

const orderEnum = v.enum(["asc", "desc"]);
const vectorDistanceMetricSchema = v.enum(["l2", "cosine"]);

export const sortOrderSchema = v.union([
  orderEnum,
  v.object(
    {
      sort: orderEnum,
      nulls: v.enum(["first", "last"], { optional: true }),
    },
    { partial: false }
  ),
]);
export type SortOrderSchema = typeof sortOrderSchema;

export const vectorDistanceOrderSchema = v.object(
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

export type OrderBySchema<
  M extends AnyModel,
  F extends ScalarSchemas<M>,
> = V.Object<
  V.FromKeys<NonVectorScalarKeys<M>[], SortOrderSchema>["entries"] &
    V.FromKeys<VectorScalarKeys<M>[], VectorSortOrderSchema>["entries"] &
    V.FromObject<F["relations"], "orderBy">["entries"]
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

  const scalarKeys = Object.keys(
    model["~"].state.scalars
  ) as ModelScalarKey<M>[];

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
    typeof sortOrderSchema
  >(nonVectorScalarKeys, sortOrderSchema);
  const vectorEntries = v.fromKeys<
    VectorScalarKeys<M>[],
    typeof vectorSortOrderSchema
  >(vectorScalarKeys, vectorSortOrderSchema);

  const relationEntries = v.fromObject<F["relations"], "orderBy">(
    fieldSchemas.relations,
    "orderBy"
  );

  return v.object({
    ...scalarEntries.entries,
    ...vectorEntries.entries,
    ...relationEntries.entries,
  });
};
