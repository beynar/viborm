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
const numberBase = v.number();
const numberList = v.number({ array: true });

type NumberList = V.Number<{ array: true }>;

const buildNumberFilterSchema = comparisonFilterFamily(
  "number",
  numberBase,
  numberList
);
const buildNumberListFilterSchema = listFilterFamily(numberBase, numberList);
const buildNumberUpdateSchema = arithmeticUpdateFamily(numberBase);
const buildNumberListUpdateSchema = listUpdateFamily(numberBase, numberList);

export interface NumberSchemas<
  F extends ScalarState<"number">,
  C extends V.Operand<any> = V.Operand<any>,
> {
  base: F["base"];
  create: V.Number<F>;
  update: F["array"] extends true
    ? ListUpdateSchema<F["base"], V.Number, NumberList>
    : ArithmeticUpdateSchema<F["base"], V.Number>;
  filter: F["array"] extends true
    ? ListFilterSchema<F["base"], V.Number, NumberList>
    : ComparisonFilterSchema<"number", F["base"], V.Number, NumberList, C>;
}

const interners = createScalarInterners();

export const buildNumberSchema = <
  F extends ScalarState<"number">,
  C extends V.Operand<any> = V.Operand<any>,
>(
  state: F
): NumberSchemas<F, C> =>
  internedScalarSchemas<NumberSchemas<F, C>>(
    interners,
    scalarInternKey(state),
    {
      base: state.base,
      create: () => v.number(state),
      update: () =>
        state.array
          ? buildNumberListUpdateSchema(state.base)
          : buildNumberUpdateSchema(state.base),
      filter: () =>
        state.array
          ? buildNumberListFilterSchema(state.base)
          : buildNumberFilterSchema(state.base),
    }
  );
