import type { ScalarState } from "@schema/scalars/common";
import v, { type V } from "../primitives/v";
import {
  buildSetUpdate,
  type ComparisonFilterSchema,
  comparisonFilterFamily,
  createScalarInterners,
  internedScalarSchemas,
  type ListFilterSchema,
  type ListUpdateSchema,
  listFilterFamily,
  listUpdateFamily,
  type SetUpdateSchema,
} from "./family";
import { scalarInternKey } from "./intern";

/**
 * The two schemas every date operand is made of: one member and one list.
 *
 * Neither carries nullability or arity of its own. The FIELD's schema is what
 * `equals`, `set` and the shorthand take, so only those arms accept a `null`;
 * `in`, the ordered comparisons and the list operators compare against a plain
 * value. Everything else in this module is the shared family — spelled once in
 * `family.ts` and named here with this kind's primitives.
 */
const dateBase = v.isoDate();
const dateList = v.isoDate({ array: true });

type IsoDateList = V.IsoDate<{ array: true }>;

const buildDateFilterSchema = comparisonFilterFamily(
  "date",
  dateBase,
  dateList
);
const buildDateListFilterSchema = listFilterFamily(dateBase, dateList);
const buildDateUpdateSchema = buildSetUpdate;
const buildDateListUpdateSchema = listUpdateFamily(dateBase, dateList);

export interface DateSchemas<
  F extends ScalarState<"date">,
  C extends V.Operand<any> = V.Operand<any>,
> {
  base: F["base"];
  create: V.IsoDate<F>;
  update: F["array"] extends true
    ? ListUpdateSchema<F["base"], V.IsoDate, IsoDateList>
    : SetUpdateSchema<F["base"]>;
  filter: F["array"] extends true
    ? ListFilterSchema<F["base"], V.IsoDate, IsoDateList>
    : ComparisonFilterSchema<"date", F["base"], V.IsoDate, IsoDateList, C>;
}

const interners = createScalarInterners();

export const buildDateSchema = <
  F extends ScalarState<"date">,
  C extends V.Operand<any> = V.Operand<any>,
>(
  state: F
): DateSchemas<F, C> =>
  internedScalarSchemas<DateSchemas<F, C>>(interners, scalarInternKey(state), {
    base: state.base,
    create: () => v.isoDate(state),
    update: () =>
      state.array
        ? buildDateListUpdateSchema(state.base)
        : buildDateUpdateSchema(state.base),
    filter: () =>
      state.array
        ? buildDateListFilterSchema(state.base)
        : buildDateFilterSchema(state.base),
  });
