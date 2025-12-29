import type { ModelState } from "../../model";
import v from "../../../../validation";
import { StringKeyOf } from "@schema/model/helper";

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
  const scalarEntries = v.fromKeys(scalarKeys, sortOrderSchema);

  const relationEntries = v.fromObject(state.relations, "~.schemas.orderBy");

  return v.object({
    ...scalarEntries.entries,
    ...relationEntries.entries,
  });
};
