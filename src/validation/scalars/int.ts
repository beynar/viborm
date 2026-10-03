import type { ScalarState } from "@schema/scalars/common";
import v, { type V } from "../primitives/v";
import {
  type ArithmeticUpdateSchema,
  type ComparisonFilterSchema,
  comparableScalar,
  type ListFilterSchema,
  type ListUpdateSchema,
} from "./family";

type IntegerList = V.Integer<{ array: true }>;

export interface IntSchemas<
  F extends ScalarState<"int">,
  C extends V.Operand<any> = V.Operand<any>,
> {
  base: F["base"];
  create: V.Integer<F>;
  update: F["array"] extends true
    ? ListUpdateSchema<F["base"], V.Integer, IntegerList>
    : ArithmeticUpdateSchema<F["base"], V.Integer>;
  filter: F["array"] extends true
    ? ListFilterSchema<F["base"], V.Integer, IntegerList>
    : ComparisonFilterSchema<"int", F["base"], V.Integer, IntegerList, C>;
}

export const buildIntSchema: <
  F extends ScalarState<"int">,
  C extends V.Operand<any> = V.Operand<any>,
>(
  state: F
) => IntSchemas<F, C> = comparableScalar("int", v.integer, true);
