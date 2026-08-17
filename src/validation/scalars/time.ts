import type { ScalarState } from "@schema/scalars/common";
import { lazyScalarSchemas } from "../lazy";
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

/**
 * Comparison operand: a literal, a field reference to another time column, an
 * SQL fragment, or a callback returning one of the latter two.
 */
type TimeOperand<
  S extends V.Schema,
  C extends V.Operand<any>,
> = V.ComparisonOperand<"time", S, C>;

type TimeFilterBase<S extends V.Schema, C extends V.Operand<any>> = {
  equals: TimeOperand<S, C>;
  in: V.IsoTime<{ array: true }>;
  notIn: V.IsoTime<{ array: true }>;
  lt: TimeOperand<V.IsoTime, C>;
  lte: TimeOperand<V.IsoTime, C>;
  gt: TimeOperand<V.IsoTime, C>;
  gte: TimeOperand<V.IsoTime, C>;
};

type TimeFilterSchema<
  S extends V.Schema,
  C extends V.Operand<any>,
> = NegatableFilterSchema<TimeOperand<S, C>, TimeFilterBase<S, C>>;

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
  lt: v.comparisonOperand("time", timeBase),
  lte: v.comparisonOperand("time", timeBase),
  gt: v.comparisonOperand("time", timeBase),
  gte: v.comparisonOperand("time", timeBase),
});

const buildTimeFilterSchema = <S extends V.Schema, C extends V.Operand<any>>(
  schema: S
): TimeFilterSchema<S, C> => {
  const operand = v.comparisonOperand("time", schema);
  const filter = timeFilterBase.extend({
    equals: operand,
  });
  return buildNegatableFilterSchema<TimeOperand<S, C>, TimeFilterBase<S, C>>(
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

export interface TimeSchemas<
  F extends ScalarState<"time">,
  C extends V.Operand<any> = V.Operand<any>,
> {
  base: F["base"];
  create: V.IsoTime<F>;
  update: F["array"] extends true
    ? TimeListUpdateSchema<F["base"]>
    : TimeUpdateSchema<F["base"]>;
  filter: F["array"] extends true
    ? TimeListFilterSchema<F["base"]>
    : TimeFilterSchema<F["base"], C>;
}

const internFilter = createScalarInterner<unknown>();
const internUpdate = createScalarInterner<unknown>();

export const buildTimeSchema = <
  F extends ScalarState<"time">,
  C extends V.Operand<any> = V.Operand<any>,
>(
  state: F
): TimeSchemas<F, C> => {
  const key = scalarInternKey(state);
  return lazyScalarSchemas<TimeSchemas<F, C>>({
    base: state.base,
    create: () => v.isoTime(state),
    update: () =>
      internUpdate(key, () =>
        state.array
          ? buildTimeListUpdateSchema(state.base)
          : buildTimeUpdateSchema(state.base)
      ) as never,
    filter: () =>
      internFilter(key, () =>
        state.array
          ? buildTimeListFilterSchema(state.base)
          : buildTimeFilterSchema(state.base)
      ) as never,
  });
};
