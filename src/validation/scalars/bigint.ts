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

/**
 * The two schemas every bigint operand is made of: one member and one list.
 *
 * Neither carries nullability or arity of its own. The FIELD's schema is what
 * `equals`, `set` and the shorthand take, so only those arms accept a `null`;
 * `in`, the ordered comparisons and the list operators compare against a plain
 * value. Everything else in this module is the shared family — spelled once in
 * `family.ts` and named here with this kind's primitives.
 */
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
