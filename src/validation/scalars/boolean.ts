import type { ScalarState } from "@schema/scalars/common";
import v, { type V } from "../primitives/v";
import {
  buildSetUpdate,
  createScalarInterners,
  internedScalarSchemas,
  type ListFilterSchema,
  type ListUpdateSchema,
  listFilterFamily,
  listUpdateFamily,
  type SetUpdateSchema,
} from "./family";
import { scalarInternKey } from "./intern";
import {
  buildNegatableFilterSchema,
  type NegatableFilterSchema,
} from "./negatable-filter";

const booleanBase = v.boolean();
const booleanList = v.boolean({ array: true });

/**
 * Equality operand: a literal, a field reference to another boolean column, an
 * SQL fragment, or a callback returning one of the latter two.
 */
type BooleanOperand<
  S extends V.Schema,
  C extends V.Operand<any>,
> = V.ComparisonOperand<"boolean", S, C>;

/**
 * `equals` and nothing else.
 *
 * A boolean has no ORDER, so `lt`/`lte`/`gt`/`gte` have no meaning, and over
 * two values set membership says nothing equality does not: `in: [true, false]`
 * is every row and `in: [true]` is `equals: true`. That is the whole reason
 * this filter is spelled here rather than built by the comparison family — the
 * LIST arm below is the family's, unchanged.
 */
type BooleanFilterBase<S extends V.Schema, C extends V.Operand<any>> = {
  equals: BooleanOperand<S, C>;
};

type BooleanFilterSchema<
  S extends V.Schema,
  C extends V.Operand<any>,
> = NegatableFilterSchema<BooleanOperand<S, C>, BooleanFilterBase<S, C>>;

const buildBooleanFilterSchema = <S extends V.Schema, C extends V.Operand<any>>(
  schema: S
): BooleanFilterSchema<S, C> => {
  const operand = v.comparisonOperand("boolean", schema);
  const filter = v.object({
    equals: operand,
  });
  return buildNegatableFilterSchema<
    BooleanOperand<S, C>,
    BooleanFilterBase<S, C>
  >(filter, operand);
};

const buildBooleanListFilterSchema = listFilterFamily(booleanBase, booleanList);
const buildBooleanListUpdateSchema = listUpdateFamily(booleanBase, booleanList);

export interface BooleanSchemas<
  F extends ScalarState<"boolean">,
  C extends V.Operand<any> = V.Operand<any>,
> {
  base: F["base"];
  create: V.Boolean<F>;
  update: F["array"] extends true
    ? ListUpdateSchema<F["base"], V.Boolean, V.Boolean<{ array: true }>>
    : SetUpdateSchema<F["base"]>;
  filter: F["array"] extends true
    ? ListFilterSchema<F["base"], V.Boolean, V.Boolean<{ array: true }>>
    : BooleanFilterSchema<F["base"], C>;
}

const interners = createScalarInterners();

export const buildBooleanSchema = <
  F extends ScalarState<"boolean">,
  C extends V.Operand<any> = V.Operand<any>,
>(
  state: F
): BooleanSchemas<F, C> =>
  internedScalarSchemas<BooleanSchemas<F, C>>(
    interners,
    scalarInternKey(state),
    {
      base: state.base,
      create: () => v.boolean(state),
      update: () =>
        state.array
          ? buildBooleanListUpdateSchema(state.base)
          : buildSetUpdate(state.base),
      filter: () =>
        state.array
          ? buildBooleanListFilterSchema(state.base)
          : buildBooleanFilterSchema(state.base),
    }
  );
