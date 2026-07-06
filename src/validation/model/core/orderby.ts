import type { AnyModel } from "@schema/model";
import type { StringKeyOf } from "@schema/model/helper";
import v, { type V } from "../../primitives/v";
import type { ScalarSchemas } from "../index";

const orderEnum = v.enum(["asc", "desc"]);

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

/**
 * Build orderBy schema - sort direction for each scalar field and nested relation ordering
 */
type ModelStateOf<M extends AnyModel> = M["~"]["state"];

export type OrderBySchema<
  M extends AnyModel,
  F extends ScalarSchemas<M>,
> = V.Object<
  V.FromKeys<
    StringKeyOf<ModelStateOf<M>["scalars"]>[],
    SortOrderSchema
  >["entries"] &
    V.FromObject<F["relations"], "orderBy">["entries"]
>;
export const getOrderBySchema = <
  M extends AnyModel,
  F extends ScalarSchemas<M>,
>(
  fieldSchemas: F
): OrderBySchema<M, F> => {
  const scalarKeys = Object.keys(fieldSchemas.scalars) as StringKeyOf<
    ModelStateOf<M>["scalars"]
  >[];
  const scalarEntries = v.fromKeys<
    StringKeyOf<ModelStateOf<M>["scalars"]>[],
    typeof sortOrderSchema
  >(scalarKeys, sortOrderSchema);

  const relationEntries = v.fromObject<F["relations"], "orderBy">(
    fieldSchemas.relations,
    "orderBy"
  );

  return v.object({
    ...scalarEntries.entries,
    ...relationEntries.entries,
  });
};
