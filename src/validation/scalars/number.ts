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
 * The two schemas every number operand is made of: one member and one list.
 *
 * Neither carries nullability or arity of its own. The FIELD's schema is what
 * `equals`, `set` and the shorthand take, so only those arms accept a `null`;
 * `in`, the ordered comparisons and the list operators compare against a plain
 * value. Everything else in this module is the shared family — spelled once in
 * `family.ts` and named here with this kind's primitives.
 */
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
