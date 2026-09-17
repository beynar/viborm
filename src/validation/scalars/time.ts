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
 * The two schemas every time operand is made of: one member and one list.
 *
 * Neither carries nullability or arity of its own. The FIELD's schema is what
 * `equals`, `set` and the shorthand take, so only those arms accept a `null`;
 * `in`, the ordered comparisons and the list operators compare against a plain
 * value. Everything else in this module is the shared family — spelled once in
 * `family.ts` and named here with this kind's primitives.
 */
const timeBase = v.isoTime();
const timeList = v.isoTime({ array: true });

type IsoTimeList = V.IsoTime<{ array: true }>;

const buildTimeFilterSchema = comparisonFilterFamily(
  "time",
  timeBase,
  timeList
);
const buildTimeListFilterSchema = listFilterFamily(timeBase, timeList);
const buildTimeUpdateSchema = buildSetUpdate;
const buildTimeListUpdateSchema = listUpdateFamily(timeBase, timeList);

export interface TimeSchemas<
  F extends ScalarState<"time">,
  C extends V.Operand<any> = V.Operand<any>,
> {
  base: F["base"];
  create: V.IsoTime<F>;
  update: F["array"] extends true
    ? ListUpdateSchema<F["base"], V.IsoTime, IsoTimeList>
    : SetUpdateSchema<F["base"]>;
  filter: F["array"] extends true
    ? ListFilterSchema<F["base"], V.IsoTime, IsoTimeList>
    : ComparisonFilterSchema<"time", F["base"], V.IsoTime, IsoTimeList, C>;
}

const interners = createScalarInterners();

export const buildTimeSchema = <
  F extends ScalarState<"time">,
  C extends V.Operand<any> = V.Operand<any>,
>(
  state: F
): TimeSchemas<F, C> =>
  internedScalarSchemas<TimeSchemas<F, C>>(interners, scalarInternKey(state), {
    base: state.base,
    create: () => v.isoTime(state),
    update: () =>
      state.array
        ? buildTimeListUpdateSchema(state.base)
        : buildTimeUpdateSchema(state.base),
    filter: () =>
      state.array
        ? buildTimeListFilterSchema(state.base)
        : buildTimeFilterSchema(state.base),
  });
