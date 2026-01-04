import type { StringKeyOf } from "@schema/model/helper";
import v from "@validation";
import type { ModelState } from "../../model";

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

/**
 * Build orderBy schema - sort direction for each scalar field and nested relation ordering
 */
export const getOrderBySchema = <T extends ModelState>(state: T) => {
  const scalarKeys = Object.keys(state.scalars) as StringKeyOf<T["scalars"]>[];
  const scalarEntries = v.fromKeys<
    StringKeyOf<T["scalars"]>[],
    typeof sortOrderSchema
  >(scalarKeys, sortOrderSchema);

  const relationEntries = v.fromObject<T["relations"], "~.schemas.orderBy">(
    state.relations,
    "~.schemas.orderBy"
  );

  return v.object({
    ...scalarEntries.entries,
    ...relationEntries.entries,
  });
};
