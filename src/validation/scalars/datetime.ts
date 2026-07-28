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

const datetimeBase = v.isoTimestamp();
const datetimeList = v.isoTimestamp({ array: true });

// =============================================================================
// FILTER TYPES
// =============================================================================

/**
 * Comparison operand: a literal, a field reference to another datetime column, an
 * SQL fragment, or a callback returning one of the latter two.
 */
type DateTimeOperand<
  S extends V.Schema,
  C extends V.Operand<any>,
> = V.ComparisonOperand<"datetime", S, C>;

type DateTimeFilterBase<S extends V.Schema, C extends V.Operand<any>> = {
  equals: DateTimeOperand<S, C>;
  in: V.IsoTimestamp<{ array: true }>;
  notIn: V.IsoTimestamp<{ array: true }>;
  lt: DateTimeOperand<V.IsoTimestamp, C>;
  lte: DateTimeOperand<V.IsoTimestamp, C>;
  gt: DateTimeOperand<V.IsoTimestamp, C>;
  gte: DateTimeOperand<V.IsoTimestamp, C>;
};

type DateTimeFilterSchema<
  S extends V.Schema,
  C extends V.Operand<any>,
> = NegatableFilterSchema<DateTimeOperand<S, C>, DateTimeFilterBase<S, C>>;

type DateTimeListFilterBase<S extends V.Schema> = {
  equals: S;
  has: V.IsoTimestamp;
  hasEvery: V.IsoTimestamp<{ array: true }>;
  hasSome: V.IsoTimestamp<{ array: true }>;
  isEmpty: V.Boolean;
};

type DateTimeListFilterSchema<S extends V.Schema> = NegatableFilterSchema<
  S,
  DateTimeListFilterBase<S>
>;

// =============================================================================
// UPDATE TYPES
// =============================================================================

type DateTimeUpdateSchema<S extends V.Schema> = V.Union<
  readonly [V.ShorthandUpdate<S>, V.Object<{ set: S }, { partial: false }>]
>;

type DateTimeListUpdateSchema<S extends V.Schema> = V.Union<
  readonly [
    V.ShorthandUpdate<S>,
    V.Object<{
      set: S;
      push: V.Union<
        readonly [
          V.ShorthandArray<V.IsoTimestamp>,
          V.IsoTimestamp<{ array: true }>,
        ]
      >;
      unshift: V.Union<
        readonly [
          V.ShorthandArray<V.IsoTimestamp>,
          V.IsoTimestamp<{ array: true }>,
        ]
      >;
    }>,
  ]
>;

// =============================================================================
// SCHEMA BUILDERS
// =============================================================================

const datetimeFilterBase = v.object({
  in: datetimeList,
  notIn: datetimeList,
  lt: v.comparisonOperand("datetime", datetimeBase),
  lte: v.comparisonOperand("datetime", datetimeBase),
  gt: v.comparisonOperand("datetime", datetimeBase),
  gte: v.comparisonOperand("datetime", datetimeBase),
});

const buildDateTimeFilterSchema = <
  S extends V.Schema,
  C extends V.Operand<any>,
>(
  schema: S
): DateTimeFilterSchema<S, C> => {
  const operand = v.comparisonOperand("datetime", schema);
  const filter = datetimeFilterBase.extend({
    equals: operand,
  });
  return buildNegatableFilterSchema<
    DateTimeOperand<S, C>,
    DateTimeFilterBase<S, C>
  >(filter, operand);
};

const datetimeListFilterBase = v.object({
  has: datetimeBase,
  hasEvery: datetimeList,
  hasSome: datetimeList,
  isEmpty: v.boolean(),
});

const buildDateTimeListFilterSchema = <S extends V.Schema>(
  schema: S
): DateTimeListFilterSchema<S> => {
  const filter = datetimeListFilterBase.extend({
    equals: schema,
  });
  return buildNegatableFilterSchema<S, DateTimeListFilterBase<S>>(
    filter,
    schema
  );
};

const buildDateTimeUpdateSchema = <S extends V.Schema>(
  schema: S
): DateTimeUpdateSchema<S> =>
  v.union([
    v.shorthandUpdate(schema),
    v.object(
      {
        set: schema,
      },
      { partial: false }
    ),
  ]);

const buildDateTimeListUpdateSchema = <S extends V.Schema>(
  schema: S
): DateTimeListUpdateSchema<S> =>
  v.union([
    v.shorthandUpdate(schema),
    v.object({
      set: schema,
      push: v.union([v.shorthandArray(datetimeBase), datetimeList]),
      unshift: v.union([v.shorthandArray(datetimeBase), datetimeList]),
    }),
  ]);

export interface DateTimeSchemas<
  F extends ScalarState<"datetime">,
  C extends V.Operand<any> = V.Operand<any>,
> {
  base: F["base"];
  create: V.IsoTimestamp<F>;
  update: F["array"] extends true
    ? DateTimeListUpdateSchema<F["base"]>
    : DateTimeUpdateSchema<F["base"]>;
  filter: F["array"] extends true
    ? DateTimeListFilterSchema<F["base"]>
    : DateTimeFilterSchema<F["base"], C>;
}

const internFilter = createScalarInterner<unknown>();
const internUpdate = createScalarInterner<unknown>();

export const buildDateTimeSchema = <
  F extends ScalarState<"datetime">,
  C extends V.Operand<any> = V.Operand<any>,
>(
  state: F
): DateTimeSchemas<F, C> => {
  const key = scalarInternKey(state);
  return {
    base: state.base as F["base"],
    create: v.isoTimestamp(state),
    update: internUpdate(key, () =>
      state.array
        ? buildDateTimeListUpdateSchema(state.base)
        : buildDateTimeUpdateSchema(state.base)
    ) as never,
    filter: internFilter(key, () =>
      state.array
        ? buildDateTimeListFilterSchema(state.base)
        : buildDateTimeFilterSchema(state.base)
    ) as never,
  } as DateTimeSchemas<F, C>;
};
