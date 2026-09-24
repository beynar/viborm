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
