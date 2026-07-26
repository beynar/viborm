import type { ScalarState } from "@schema/scalars/common";
import v, { type V } from "../primitives/v";
import { createScalarInterner, scalarInternKey } from "./intern";
import {
  buildNegatableFilterSchema,
  type NegatableFilterSchema,
} from "./negatable-filter";

// =============================================================================
// BASE TYPES
// =============================================================================

const timeBase = v.isoTime();
const timeList = v.isoTime({ array: true });

// =============================================================================
// FILTER TYPES
// =============================================================================

type TimeFilterBase<S extends V.Schema> = {
  equals: S;
  in: V.IsoTime<{ array: true }>;
  notIn: V.IsoTime<{ array: true }>;
  lt: V.IsoTime;
  lte: V.IsoTime;
  gt: V.IsoTime;
  gte: V.IsoTime;
};

type TimeFilterSchema<S extends V.Schema> = NegatableFilterSchema<
  S,
  TimeFilterBase<S>
>;

type TimeListFilterBase<S extends V.Schema> = {
  equals: S;
  has: V.IsoTime;
  hasEvery: V.IsoTime<{ array: true }>;
  hasSome: V.IsoTime<{ array: true }>;
  isEmpty: V.Boolean;
};

type TimeListFilterSchema<S extends V.Schema> = NegatableFilterSchema<
  S,
  TimeListFilterBase<S>
>;

// =============================================================================
// UPDATE TYPES
// =============================================================================

type TimeUpdateSchema<S extends V.Schema> = V.Union<
  readonly [V.ShorthandUpdate<S>, V.Object<{ set: S }, { partial: false }>]
>;

type TimeListUpdateSchema<S extends V.Schema> = V.Union<
  readonly [
    V.ShorthandUpdate<S>,
    V.Object<{
      set: S;
      push: V.Union<
        readonly [V.ShorthandArray<V.IsoTime>, V.IsoTime<{ array: true }>]
      >;
      unshift: V.Union<
        readonly [V.ShorthandArray<V.IsoTime>, V.IsoTime<{ array: true }>]
      >;
    }>,
  ]
>;

// =============================================================================
// SCHEMA BUILDERS
// =============================================================================

const timeFilterBase = v.object({
  in: timeList,
  notIn: timeList,
  lt: timeBase,
  lte: timeBase,
  gt: timeBase,
  gte: timeBase,
});

const buildTimeFilterSchema = <S extends V.Schema>(
  schema: S
): TimeFilterSchema<S> => {
  const filter = timeFilterBase.extend({
    equals: schema,
  });
  return buildNegatableFilterSchema<S, TimeFilterBase<S>>(filter, schema);
};

const timeListFilterBase = v.object({
  has: timeBase,
  hasEvery: timeList,
  hasSome: timeList,
  isEmpty: v.boolean(),
});

const buildTimeListFilterSchema = <S extends V.Schema>(
  schema: S
): TimeListFilterSchema<S> => {
  const filter = timeListFilterBase.extend({
    equals: schema,
  });
  return buildNegatableFilterSchema<S, TimeListFilterBase<S>>(filter, schema);
};

const buildTimeUpdateSchema = <S extends V.Schema>(
  schema: S
): TimeUpdateSchema<S> =>
  v.union([
    v.shorthandUpdate(schema),
    v.object(
      {
        set: schema,
      },
      { partial: false }
    ),
  ]);

const buildTimeListUpdateSchema = <S extends V.Schema>(
  schema: S
): TimeListUpdateSchema<S> =>
  v.union([
    v.shorthandUpdate(schema),
    v.object({
      set: schema,
      push: v.union([v.shorthandArray(timeBase), timeList]),
      unshift: v.union([v.shorthandArray(timeBase), timeList]),
    }),
  ]);

export interface TimeSchemas<F extends ScalarState<"time">> {
  base: F["base"];
  create: V.IsoTime<F>;
  update: F["array"] extends true
    ? TimeListUpdateSchema<F["base"]>
    : TimeUpdateSchema<F["base"]>;
  filter: F["array"] extends true
    ? TimeListFilterSchema<F["base"]>
    : TimeFilterSchema<F["base"]>;
}

const internFilter = createScalarInterner<unknown>();
const internUpdate = createScalarInterner<unknown>();

export const buildTimeSchema = <F extends ScalarState<"time">>(
  state: F
): TimeSchemas<F> => {
  const key = scalarInternKey(state);
  return {
    base: state.base as F["base"],
    create: v.isoTime(state),
    update: internUpdate(key, () =>
      state.array
        ? buildTimeListUpdateSchema(state.base)
        : buildTimeUpdateSchema(state.base)
    ) as never,
    filter: internFilter(key, () =>
      state.array
        ? buildTimeListFilterSchema(state.base)
        : buildTimeFilterSchema(state.base)
    ) as never,
  } as TimeSchemas<F>;
};
