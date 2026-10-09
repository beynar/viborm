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

type BigIntList = V.BigInt<{ array: true }>;

export interface BigIntSchemas<
  F extends ScalarState<"bigint">,
  C extends V.Operand<any> = V.Operand<any>,
> {
  base: F["base"];
  create: V.BigInt<F>;
  update: F["array"] extends true
    ? ListUpdateSchema<F["base"], V.BigInt, BigIntList>
    : F["schema"] extends undefined
      ? ArithmeticUpdateSchema<F["base"], V.BigInt>
      : SetUpdateSchema<F["base"]>;
  filter: F["array"] extends true
    ? ListFilterSchema<F["base"], V.BigInt, BigIntList>
    : ComparisonFilterSchema<"bigint", F["base"], V.BigInt, BigIntList, C>;
}

export const buildBigIntSchema: <
  F extends ScalarState<"bigint">,
  C extends V.Operand<any> = V.Operand<any>,
>(
  state: F
) => BigIntSchemas<F, C> = comparableScalar("bigint", v.bigint, true);
