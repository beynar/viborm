import type { ScalarState } from "@schema/scalars/common";
import v, { type V } from "../primitives/v";
import {
  type ArithmeticUpdateSchema,
  type ComparisonFilterSchema,
  comparableScalar,
  type ListFilterSchema,
  type ListUpdateSchema,
  type SetUpdateSchema,
} from "./family";

type NumberList = V.Number<{ array: true }>;

export interface NumberSchemas<
  F extends ScalarState<"number">,
  C extends V.Operand<any> = V.Operand<any>,
> {
  base: F["base"];
  create: V.Number<F>;
  update: F["array"] extends true
    ? ListUpdateSchema<F["base"], V.Number, NumberList>
    : F["schema"] extends undefined
      ? ArithmeticUpdateSchema<F["base"], V.Number>
      : SetUpdateSchema<F["base"]>;
  filter: F["array"] extends true
    ? ListFilterSchema<F["base"], V.Number, NumberList>
    : ComparisonFilterSchema<"number", F["base"], V.Number, NumberList, C>;
}

export const buildNumberSchema: <
  F extends ScalarState<"number">,
  C extends V.Operand<any> = V.Operand<any>,
>(
  state: F
) => NumberSchemas<F, C> = comparableScalar("number", v.number, true);
