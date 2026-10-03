import type { ScalarState } from "@schema/scalars/common";
import v, { type V } from "../primitives/v";
import {
  type ComparisonFilterSchema,
  comparableScalar,
  type ListFilterSchema,
  type ListUpdateSchema,
  type SetUpdateSchema,
} from "./family";

type IsoTimestampList = V.IsoTimestamp<{ array: true }>;

export interface DateTimeSchemas<
  F extends ScalarState<"datetime">,
  C extends V.Operand<any> = V.Operand<any>,
> {
  base: F["base"];
  create: V.IsoTimestamp<F>;
  update: F["array"] extends true
    ? ListUpdateSchema<F["base"], V.IsoTimestamp, IsoTimestampList>
    : SetUpdateSchema<F["base"]>;
  filter: F["array"] extends true
    ? ListFilterSchema<F["base"], V.IsoTimestamp, IsoTimestampList>
    : ComparisonFilterSchema<
        "datetime",
        F["base"],
        V.IsoTimestamp,
        IsoTimestampList,
        C
      >;
}

export const buildDateTimeSchema: <
  F extends ScalarState<"datetime">,
  C extends V.Operand<any> = V.Operand<any>,
>(
  state: F
) => DateTimeSchemas<F, C> = comparableScalar(
  "datetime",
  v.isoTimestamp,
  false
);
