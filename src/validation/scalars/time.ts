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

/** Comparison operand: a literal, or a field reference to another time column. */
type TimeOperand<S extends V.Schema> = V.FieldRefOr<"time", S>;

type TimeFilterBase<S extends V.Schema> = {
  equals: TimeOperand<S>;
  in: V.IsoTime<{ array: true }>;
  notIn: V.IsoTime<{ array: true }>;
  lt: TimeOperand<V.IsoTime>;
  lte: TimeOperand<V.IsoTime>;
  gt: TimeOperand<V.IsoTime>;
  gte: TimeOperand<V.IsoTime>;
};

type TimeFilterSchema<S extends V.Schema> = NegatableFilterSchema<
  TimeOperand<S>,
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
  lt: v.fieldRefOr("time", timeBase),
  lte: v.fieldRefOr("time", timeBase),
  gt: v.fieldRefOr("time", timeBase),
  gte: v.fieldRefOr("time", timeBase),
});

const buildTimeFilterSchema = <S extends V.Schema>(
  schema: S
): TimeFilterSchema<S> => {
  const operand = v.fieldRefOr("time", schema);
  const filter = timeFilterBase.extend({
    equals: operand,
  });
  return buildNegatableFilterSchema<TimeOperand<S>, TimeFilterBase<S>>(
    filter,
    operand
  );
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
