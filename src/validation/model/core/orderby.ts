import type { StringKeyOf } from "@schema/model/helper";
import v, { type V } from "@validation";
import type { ModelState } from "../../model";

const orderEnum = v.enum(["asc", "desc"]);

type OrderEnum = V.Enum<["asc", "desc"]>;

type SortOrderSchema = V.Union<
  readonly [
    OrderEnum,
    V.Object<
      {
        sort: OrderEnum;
        nulls: V.Enum<["first", "last"]>;
      },
      { partial: false }
    >,
  ]
>;
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
export type OrderBySchema<T extends ModelState> = V.Object<
  V.FromKeys<StringKeyOf<T["scalars"]>[], SortOrderSchema>["entries"] &
    V.FromObject<T["relations"], "~.schemas.orderBy">["entries"]
>;
export const getOrderBySchema = <T extends ModelState>(
  state: T
): OrderBySchema<T> => {
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
