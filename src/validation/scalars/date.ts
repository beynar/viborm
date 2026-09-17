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

/** This kind's member and list schemas; `family.ts` explains what they are for. */
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
