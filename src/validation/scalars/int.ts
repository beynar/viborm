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
const intBase = v.integer();
const intList = v.integer({ array: true });

type IntegerList = V.Integer<{ array: true }>;

const buildIntFilterSchema = comparisonFilterFamily("int", intBase, intList);
const buildIntListFilterSchema = listFilterFamily(intBase, intList);
const buildIntUpdateSchema = arithmeticUpdateFamily(intBase);
const buildIntListUpdateSchema = listUpdateFamily(intBase, intList);

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

const interners = createScalarInterners();

export const buildIntSchema = <
  F extends ScalarState<"int">,
  C extends V.Operand<any> = V.Operand<any>,
>(
  state: F
): IntSchemas<F, C> =>
  internedScalarSchemas<IntSchemas<F, C>>(interners, scalarInternKey(state), {
    base: state.base,
    create: () => v.integer(state),
    update: () =>
      state.array
        ? buildIntListUpdateSchema(state.base)
        : buildIntUpdateSchema(state.base),
    filter: () =>
      state.array
        ? buildIntListFilterSchema(state.base)
        : buildIntFilterSchema(state.base),
  });
