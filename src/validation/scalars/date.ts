import type { ScalarState } from "@schema/scalars/common";
import v, { type V } from "../primitives/v";
import {
  type ComparisonFilterSchema,
  comparableScalar,
  type ListFilterSchema,
  type ListUpdateSchema,
  type SetUpdateSchema,
} from "./family";

type IsoDateList = V.IsoDate<{ array: true }>;

export interface DateSchemas<
  F extends ScalarState<"date">,
  C extends V.Operand<any> = V.Operand<any>,
> {
  base: F["base"];
  create: V.IsoDate<F>;
  update: F["array"] extends true
    ? ListUpdateSchema<F["base"], V.IsoDate, IsoDateList>
    : SetUpdateSchema<F["base"]>;
  filter: F["array"] extends true
    ? ListFilterSchema<F["base"], V.IsoDate, IsoDateList>
    : ComparisonFilterSchema<"date", F["base"], V.IsoDate, IsoDateList, C>;
}

export const buildDateSchema: <
  F extends ScalarState<"date">,
  C extends V.Operand<any> = V.Operand<any>,
>(
  state: F
) => DateSchemas<F, C> = comparableScalar("date", v.isoDate, false);
