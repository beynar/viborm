import type { ScalarState } from "@schema/scalars/common";
import v, { type V } from "../primitives/v";
import { createScalarInterner, scalarInternKey } from "./intern";

// =============================================================================
// BASE TYPES
// =============================================================================

const datetimeBase = v.isoTimestamp();
const datetimeList = v.isoTimestamp({ array: true });

// =============================================================================
// FILTER TYPES
// =============================================================================

type DateTimeFilterBase<S extends V.Schema> = {
  equals: S;
  in: V.IsoTimestamp<{ array: true }>;
  notIn: V.IsoTimestamp<{ array: true }>;
  lt: V.IsoTimestamp;
  lte: V.IsoTimestamp;
  gt: V.IsoTimestamp;
  gte: V.IsoTimestamp;
};

type DateTimeFilterSchema<S extends V.Schema> = V.Union<
  readonly [
    V.ShorthandFilter<S>,
    V.Object<
      DateTimeFilterBase<S> & {
        not: V.Union<
          readonly [V.ShorthandFilter<S>, V.Object<DateTimeFilterBase<S>>]
        >;
      }
    >,
  ]
>;

type DateTimeListFilterBase<S extends V.Schema> = {
  equals: S;
  has: V.IsoTimestamp;
  hasEvery: V.IsoTimestamp<{ array: true }>;
  hasSome: V.IsoTimestamp<{ array: true }>;
  isEmpty: V.Boolean;
};

type DateTimeListFilterSchema<S extends V.Schema> = V.Union<
  readonly [
    V.ShorthandFilter<S>,
    V.Object<
      DateTimeListFilterBase<S> & {
        not: V.Union<
          readonly [V.ShorthandFilter<S>, V.Object<DateTimeListFilterBase<S>>]
        >;
      }
    >,
  ]
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
  lt: datetimeBase,
  lte: datetimeBase,
  gt: datetimeBase,
  gte: datetimeBase,
});

const buildDateTimeFilterSchema = <S extends V.Schema>(
  schema: S
): DateTimeFilterSchema<S> => {
  const filter = datetimeFilterBase.extend({
    equals: schema,
  });
  return v.union([
    v.shorthandFilter(schema),
    filter.extend({
      not: v.union([v.shorthandFilter(schema), filter]),
    }),
  ]);
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
  return v.union([
    v.shorthandFilter(schema),
    filter.extend({ not: v.union([v.shorthandFilter(schema), filter]) }),
  ]);
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

export interface DateTimeSchemas<F extends ScalarState<"datetime">> {
  base: F["base"];
  create: V.IsoTimestamp<F>;
  update: F["array"] extends true
    ? DateTimeListUpdateSchema<F["base"]>
    : DateTimeUpdateSchema<F["base"]>;
  filter: F["array"] extends true
    ? DateTimeListFilterSchema<F["base"]>
    : DateTimeFilterSchema<F["base"]>;
}

const internFilter = createScalarInterner<unknown>();
const internUpdate = createScalarInterner<unknown>();

export const buildDateTimeSchema = <F extends ScalarState<"datetime">>(
  state: F
): DateTimeSchemas<F> => {
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
  } as DateTimeSchemas<F>;
};
