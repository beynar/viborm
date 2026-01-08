import v, {
  type BaseIsoDateSchema,
  type BaseIsoTimeSchema,
  type BaseIsoTimestampSchema,
  type InferInput,
  type InferOutput,
} from "@validation";
import type { V } from "@validation/V";
import {
  type FieldState,
  shorthandArray,
  shorthandFilter,
  shorthandUpdate,
} from "../common";

// =============================================================================
// BASE TYPES
// =============================================================================

// DateTime uses ISO timestamp format
export const datetimeBase = v.isoTimestamp();
export const datetimeNullable = v.isoTimestamp({ nullable: true });
export const datetimeList = v.isoTimestamp({ array: true });
export const datetimeListNullable = v.isoTimestamp({
  array: true,
  nullable: true,
});

// Date uses ISO date format
export const dateBase = v.isoDate();
export const dateNullable = v.isoDate({ nullable: true });
export const dateList = v.isoDate({ array: true });
export const dateListNullable = v.isoDate({ array: true, nullable: true });

// Time uses ISO time format
export const timeBase = v.isoTime();
export const timeNullable = v.isoTime({ nullable: true });
export const timeList = v.isoTime({ array: true });
export const timeListNullable = v.isoTime({ array: true, nullable: true });

// =============================================================================
// DATETIME FILTER TYPES
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

export type DateTimeFilterSchema<S extends V.Schema> = V.Union<
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

export type DateTimeListFilterSchema<S extends V.Schema> = V.Union<
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
// DATETIME UPDATE TYPES
// =============================================================================

export type DateTimeUpdateSchema<S extends V.Schema> = V.Union<
  readonly [V.ShorthandUpdate<S>, V.Object<{ set: S }, { partial: false }>]
>;

export type DateTimeListUpdateSchema<S extends V.Schema> = V.Union<
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
// DATE FILTER TYPES
// =============================================================================

type DateFilterBase<S extends V.Schema> = {
  equals: S;
  in: V.IsoDate<{ array: true }>;
  notIn: V.IsoDate<{ array: true }>;
  lt: V.IsoDate;
  lte: V.IsoDate;
  gt: V.IsoDate;
  gte: V.IsoDate;
};

export type DateFilterSchema<S extends V.Schema> = V.Union<
  readonly [
    V.ShorthandFilter<S>,
    V.Object<
      DateFilterBase<S> & {
        not: V.Union<
          readonly [V.ShorthandFilter<S>, V.Object<DateFilterBase<S>>]
        >;
      }
    >,
  ]
>;

type DateListFilterBase<S extends V.Schema> = {
  equals: S;
  has: V.IsoDate;
  hasEvery: V.IsoDate<{ array: true }>;
  hasSome: V.IsoDate<{ array: true }>;
  isEmpty: V.Boolean;
};

export type DateListFilterSchema<S extends V.Schema> = V.Union<
  readonly [
    V.ShorthandFilter<S>,
    V.Object<
      DateListFilterBase<S> & {
        not: V.Union<
          readonly [V.ShorthandFilter<S>, V.Object<DateListFilterBase<S>>]
        >;
      }
    >,
  ]
>;

// =============================================================================
// DATE UPDATE TYPES
// =============================================================================

export type DateUpdateSchema<S extends V.Schema> = V.Union<
  readonly [V.ShorthandUpdate<S>, V.Object<{ set: S }, { partial: false }>]
>;

export type DateListUpdateSchema<S extends V.Schema> = V.Union<
  readonly [
    V.ShorthandUpdate<S>,
    V.Object<{
      set: S;
      push: V.Union<
        readonly [V.ShorthandArray<V.IsoDate>, V.IsoDate<{ array: true }>]
      >;
      unshift: V.Union<
        readonly [V.ShorthandArray<V.IsoDate>, V.IsoDate<{ array: true }>]
      >;
    }>,
  ]
>;

// =============================================================================
// TIME FILTER TYPES
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

export type TimeFilterSchema<S extends V.Schema> = V.Union<
  readonly [
    V.ShorthandFilter<S>,
    V.Object<
      TimeFilterBase<S> & {
        not: V.Union<
          readonly [V.ShorthandFilter<S>, V.Object<TimeFilterBase<S>>]
        >;
      }
    >,
  ]
>;

type TimeListFilterBase<S extends V.Schema> = {
  equals: S;
  has: V.IsoTime;
  hasEvery: V.IsoTime<{ array: true }>;
  hasSome: V.IsoTime<{ array: true }>;
  isEmpty: V.Boolean;
};

export type TimeListFilterSchema<S extends V.Schema> = V.Union<
  readonly [
    V.ShorthandFilter<S>,
    V.Object<
      TimeListFilterBase<S> & {
        not: V.Union<
          readonly [V.ShorthandFilter<S>, V.Object<TimeListFilterBase<S>>]
        >;
      }
    >,
  ]
>;

// =============================================================================
// TIME UPDATE TYPES
// =============================================================================

export type TimeUpdateSchema<S extends V.Schema> = V.Union<
  readonly [V.ShorthandUpdate<S>, V.Object<{ set: S }, { partial: false }>]
>;

export type TimeListUpdateSchema<S extends V.Schema> = V.Union<
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
// DATETIME SCHEMA BUILDERS
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
    shorthandFilter(schema),
    filter.extend({
      not: v.union([shorthandFilter(schema), filter]),
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
    shorthandFilter(schema),
    filter.extend({ not: v.union([shorthandFilter(schema), filter]) }),
  ]);
};

const buildDateTimeUpdateSchema = <S extends V.Schema>(
  schema: S
): DateTimeUpdateSchema<S> =>
  v.union([
    shorthandUpdate(schema),
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
    shorthandUpdate(schema),
    v.object({
      set: schema,
      push: v.union([shorthandArray(datetimeBase), datetimeList]),
      unshift: v.union([shorthandArray(datetimeBase), datetimeList]),
    }),
  ]);

export interface DateTimeSchemas<F extends FieldState<"datetime">> {
  base: F["base"];
  create: BaseIsoTimestampSchema<F>;
  update: F["array"] extends true
    ? DateTimeListUpdateSchema<F["base"]>
    : DateTimeUpdateSchema<F["base"]>;
  filter: F["array"] extends true
    ? DateTimeListFilterSchema<F["base"]>
    : DateTimeFilterSchema<F["base"]>;
}

export const buildDateTimeSchema = <F extends FieldState<"datetime">>(
  state: F
): DateTimeSchemas<F> => {
  return {
    base: state.base as F["base"],
    create: v.isoTimestamp(state),
    update: state.array
      ? buildDateTimeListUpdateSchema(state.base)
      : buildDateTimeUpdateSchema(state.base),
    filter: state.array
      ? buildDateTimeListFilterSchema(state.base)
      : buildDateTimeFilterSchema(state.base),
  } as DateTimeSchemas<F>;
};

export type InferDateTimeInput<
  F extends FieldState<"datetime">,
  Type extends keyof DateTimeSchemas<F>,
> = InferInput<DateTimeSchemas<F>[Type]>;

export type InferDateTimeOutput<
  F extends FieldState<"datetime">,
  Type extends keyof DateTimeSchemas<F>,
> = InferOutput<DateTimeSchemas<F>[Type]>;

// =============================================================================
// DATE SCHEMA BUILDERS
// =============================================================================

const dateFilterBase = v.object({
  in: dateList,
  notIn: dateList,
  lt: dateBase,
  lte: dateBase,
  gt: dateBase,
  gte: dateBase,
});

const buildDateFilterSchema = <S extends V.Schema>(
  schema: S
): DateFilterSchema<S> => {
  const filter = dateFilterBase.extend({
    equals: schema,
  });
  return v.union([
    shorthandFilter(schema),
    filter.extend({
      not: v.union([shorthandFilter(schema), filter]),
    }),
  ]);
};

const dateListFilterBase = v.object({
  has: dateBase,
  hasEvery: dateList,
  hasSome: dateList,
  isEmpty: v.boolean(),
});

const buildDateListFilterSchema = <S extends V.Schema>(
  schema: S
): DateListFilterSchema<S> => {
  const filter = dateListFilterBase.extend({
    equals: schema,
  });
  return v.union([
    shorthandFilter(schema),
    filter.extend({ not: v.union([shorthandFilter(schema), filter]) }),
  ]);
};

const buildDateUpdateSchema = <S extends V.Schema>(
  schema: S
): DateUpdateSchema<S> =>
  v.union([
    shorthandUpdate(schema),
    v.object(
      {
        set: schema,
      },
      { partial: false }
    ),
  ]);

const buildDateListUpdateSchema = <S extends V.Schema>(
  schema: S
): DateListUpdateSchema<S> =>
  v.union([
    shorthandUpdate(schema),
    v.object({
      set: schema,
      push: v.union([shorthandArray(dateBase), dateList]),
      unshift: v.union([shorthandArray(dateBase), dateList]),
    }),
  ]);

export interface DateSchemas<F extends FieldState<"date">> {
  base: F["base"];
  create: BaseIsoDateSchema<F>;
  update: F["array"] extends true
    ? DateListUpdateSchema<F["base"]>
    : DateUpdateSchema<F["base"]>;
  filter: F["array"] extends true
    ? DateListFilterSchema<F["base"]>
    : DateFilterSchema<F["base"]>;
}

export const buildDateSchema = <F extends FieldState<"date">>(
  state: F
): DateSchemas<F> => {
  return {
    base: state.base as F["base"],
    create: v.isoDate(state),
    update: state.array
      ? buildDateListUpdateSchema(state.base)
      : buildDateUpdateSchema(state.base),
    filter: state.array
      ? buildDateListFilterSchema(state.base)
      : buildDateFilterSchema(state.base),
  } as DateSchemas<F>;
};

export type InferDateInput<
  F extends FieldState<"date">,
  Type extends keyof DateSchemas<F>,
> = InferInput<DateSchemas<F>[Type]>;

export type InferDateOutput<
  F extends FieldState<"date">,
  Type extends keyof DateSchemas<F>,
> = InferOutput<DateSchemas<F>[Type]>;

// =============================================================================
// TIME SCHEMA BUILDERS
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
  return v.union([
    shorthandFilter(schema),
    filter.extend({
      not: v.union([shorthandFilter(schema), filter]),
    }),
  ]);
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
  return v.union([
    shorthandFilter(schema),
    filter.extend({ not: v.union([shorthandFilter(schema), filter]) }),
  ]);
};

const buildTimeUpdateSchema = <S extends V.Schema>(
  schema: S
): TimeUpdateSchema<S> =>
  v.union([
    shorthandUpdate(schema),
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
    shorthandUpdate(schema),
    v.object({
      set: schema,
      push: v.union([shorthandArray(timeBase), timeList]),
      unshift: v.union([shorthandArray(timeBase), timeList]),
    }),
  ]);

export interface TimeSchemas<F extends FieldState<"time">> {
  base: F["base"];
  create: BaseIsoTimeSchema<F>;
  update: F["array"] extends true
    ? TimeListUpdateSchema<F["base"]>
    : TimeUpdateSchema<F["base"]>;
  filter: F["array"] extends true
    ? TimeListFilterSchema<F["base"]>
    : TimeFilterSchema<F["base"]>;
}

export const buildTimeSchema = <F extends FieldState<"time">>(
  state: F
): TimeSchemas<F> => {
  return {
    base: state.base as F["base"],
    create: v.isoTime(state),
    update: state.array
      ? buildTimeListUpdateSchema(state.base)
      : buildTimeUpdateSchema(state.base),
    filter: state.array
      ? buildTimeListFilterSchema(state.base)
      : buildTimeFilterSchema(state.base),
  } as TimeSchemas<F>;
};

export type InferTimeInput<
  F extends FieldState<"time">,
  Type extends keyof TimeSchemas<F>,
> = InferInput<TimeSchemas<F>[Type]>;

export type InferTimeOutput<
  F extends FieldState<"time">,
  Type extends keyof TimeSchemas<F>,
> = InferOutput<TimeSchemas<F>[Type]>;
