import type { ScalarState } from "@schema/scalars/common";
import v, { type V } from "../primitives/v";
import {
  type ComparisonFilterSchema,
  comparableScalar,
  type ListFilterSchema,
  type ListUpdateSchema,
  type SetUpdateSchema,
} from "./family";

type IsoTimeList = V.IsoTime<{ array: true }>;

export interface TimeSchemas<
  F extends ScalarState<"time">,
  C extends V.Operand<any> = V.Operand<any>,
> {
  base: F["base"];
  create: V.IsoTime<F>;
  update: F["array"] extends true
    ? ListUpdateSchema<F["base"], V.IsoTime, IsoTimeList>
    : SetUpdateSchema<F["base"]>;
  filter: F["array"] extends true
    ? ListFilterSchema<F["base"], V.IsoTime, IsoTimeList>
    : ComparisonFilterSchema<"time", F["base"], V.IsoTime, IsoTimeList, C>;
}

export const buildTimeSchema: <
  F extends ScalarState<"time">,
  C extends V.Operand<any> = V.Operand<any>,
>(
  state: F
) => TimeSchemas<F, C> = comparableScalar("time", v.isoTime, false);
