import type { ScalarState } from "@schema/scalars/common";
import v, { type V } from "../primitives/v";
import {
  type ArithmeticUpdateSchema,
  arithmeticUpdateFamily,
  type ComparisonFilterSchema,
  comparisonFilterFamily,
  createScalarInterners,
  internedScalarSchemas,
  type ListFilterSchema,
  type ListUpdateSchema,
  listFilterFamily,
  listUpdateFamily,
} from "./family";
import { scalarInternKey } from "./intern";

/** This kind's member and list schemas; `family.ts` explains what they are for. */
const bigIntBase = v.bigint();
const bigIntList = v.bigint({ array: true });

type BigIntList = V.BigInt<{ array: true }>;

const buildBigIntFilterSchema = comparisonFilterFamily(
  "bigint",
  bigIntBase,
  bigIntList
);
const buildBigIntListFilterSchema = listFilterFamily(bigIntBase, bigIntList);
const buildBigIntUpdateSchema = arithmeticUpdateFamily(bigIntBase);
const buildBigIntListUpdateSchema = listUpdateFamily(bigIntBase, bigIntList);

export interface BigIntSchemas<
  F extends ScalarState<"bigint">,
  C extends V.Operand<any> = V.Operand<any>,
> {
  base: F["base"];
  create: V.BigInt<F>;
  update: F["array"] extends true
    ? ListUpdateSchema<F["base"], V.BigInt, BigIntList>
    : ArithmeticUpdateSchema<F["base"], V.BigInt>;
  filter: F["array"] extends true
    ? ListFilterSchema<F["base"], V.BigInt, BigIntList>
    : ComparisonFilterSchema<"bigint", F["base"], V.BigInt, BigIntList, C>;
}

const interners = createScalarInterners();

export const buildBigIntSchema = <
  F extends ScalarState<"bigint">,
  C extends V.Operand<any> = V.Operand<any>,
>(
  state: F
): BigIntSchemas<F, C> =>
  internedScalarSchemas<BigIntSchemas<F, C>>(
    interners,
    scalarInternKey(state),
    {
      base: state.base,
      create: () => v.bigint(state),
      update: () =>
        state.array
          ? buildBigIntListUpdateSchema(state.base)
          : buildBigIntUpdateSchema(state.base),
      filter: () =>
        state.array
          ? buildBigIntListFilterSchema(state.base)
          : buildBigIntFilterSchema(state.base),
    }
  );
