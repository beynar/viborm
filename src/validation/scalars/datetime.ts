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
 * The two schemas every datetime operand is made of: one member and one list.
 *
 * Neither carries nullability or arity of its own. The FIELD's schema is what
 * `equals`, `set` and the shorthand take, so only those arms accept a `null`;
 * `in`, the ordered comparisons and the list operators compare against a plain
 * value. Everything else in this module is the shared family — spelled once in
 * `family.ts` and named here with this kind's primitives.
 */
const datetimeBase = v.isoTimestamp();
const datetimeList = v.isoTimestamp({ array: true });

type IsoTimestampList = V.IsoTimestamp<{ array: true }>;

const buildDateTimeFilterSchema = comparisonFilterFamily(
  "datetime",
  datetimeBase,
  datetimeList
);
const buildDateTimeListFilterSchema = listFilterFamily(
  datetimeBase,
  datetimeList
);
const buildDateTimeUpdateSchema = buildSetUpdate;
const buildDateTimeListUpdateSchema = listUpdateFamily(
  datetimeBase,
  datetimeList
);

export interface DateTimeSchemas<
  F extends ScalarState<"datetime">,
  C extends V.Operand<any> = V.Operand<any>,
> {
  base: F["base"];
  create: V.IsoTimestamp<F>;
  update: F["array"] extends true
    ? ListUpdateSchema<F["base"], V.IsoTimestamp, IsoTimestampList>
    : SetUpdateSchema<F["base"]>;
  filter: F["array"] extends true
    ? ListFilterSchema<F["base"], V.IsoTimestamp, IsoTimestampList>
    : ComparisonFilterSchema<
        "datetime",
        F["base"],
        V.IsoTimestamp,
        IsoTimestampList,
        C
      >;
}

const interners = createScalarInterners();

export const buildDateTimeSchema = <
  F extends ScalarState<"datetime">,
  C extends V.Operand<any> = V.Operand<any>,
>(
  state: F
): DateTimeSchemas<F, C> =>
  internedScalarSchemas<DateTimeSchemas<F, C>>(
    interners,
    scalarInternKey(state),
    {
      base: state.base,
      create: () => v.isoTimestamp(state),
      update: () =>
        state.array
          ? buildDateTimeListUpdateSchema(state.base)
          : buildDateTimeUpdateSchema(state.base),
      filter: () =>
        state.array
          ? buildDateTimeListFilterSchema(state.base)
          : buildDateTimeFilterSchema(state.base),
    }
  );
