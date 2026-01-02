import {
  FieldState,
  shorthandFilter,
  shorthandUpdate,
  shorthandArray,
} from "../common";
import v, {
  BaseIsoTimestampSchema,
  BaseIsoDateSchema,
  BaseIsoTimeSchema,
  InferInput,
  InferOutput,
  VibSchema,
} from "@validation";

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
// FILTER SCHEMAS
// =============================================================================

const datetimeFilterBase = v.object({
  in: datetimeList,
  notIn: datetimeList,
  lt: datetimeBase,
  lte: datetimeBase,
  gt: datetimeBase,
  gte: datetimeBase,
});

const buildDateTimeFilterSchema = <S extends VibSchema>(schema: S) => {
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

const buildDateTimeListFilterSchema = <S extends VibSchema>(schema: S) => {
  const filter = datetimeListFilterBase.extend({
    equals: schema,
  });
  return v.union([
    shorthandFilter(schema),
    filter.extend({ not: v.union([shorthandFilter(schema), filter]) }),
  ]);
};

const buildDateTimeUpdateSchema = <S extends VibSchema>(schema: S) =>
  v.union([
    shorthandUpdate(schema),
    v.object(
      {
        set: schema,
      },
      { partial: false }
    ),
  ]);

const buildDateTimeListUpdateSchema = <S extends VibSchema>(schema: S) =>
  v.union([
    shorthandUpdate(schema),
    v.object({
      set: schema,
      push: v.union([shorthandArray(datetimeBase), datetimeList]),
      unshift: v.union([shorthandArray(datetimeBase), datetimeList]),
    }),
  ]);

export const buildDateTimeSchema = <F extends FieldState<"datetime">>(
  state: F
) => {
  return {
    base: state.base,
    create: v.isoTimestamp(state),
    update: state.array
      ? buildDateTimeListUpdateSchema(state.base)
      : buildDateTimeUpdateSchema(state.base),
    filter: state.array
      ? buildDateTimeListFilterSchema(state.base)
      : buildDateTimeFilterSchema(state.base),
  } as DateTimeSchemas<F>;
};

export type DateTimeSchemas<F extends FieldState<"datetime">> = {
  base: F["base"];
  create: BaseIsoTimestampSchema<F>;
  update: F["array"] extends true
    ? ReturnType<typeof buildDateTimeListUpdateSchema<F["base"]>>
    : ReturnType<typeof buildDateTimeUpdateSchema<F["base"]>>;
  filter: F["array"] extends true
    ? ReturnType<typeof buildDateTimeListFilterSchema<F["base"]>>
    : ReturnType<typeof buildDateTimeFilterSchema<F["base"]>>;
};

export type InferDateTimeInput<
  F extends FieldState<"datetime">,
  Type extends "create" | "update" | "filter" | "base"
> = InferInput<DateTimeSchemas<F>[Type]>;

export type InferDateTimeOutput<
  F extends FieldState<"datetime">,
  Type extends "create" | "update" | "filter" | "base"
> = InferOutput<DateTimeSchemas<F>[Type]>;

// =============================================================================
// DATE SCHEMA BUILDER (ISO date: YYYY-MM-DD)
// =============================================================================

const dateFilterBase = v.object({
  in: dateList,
  notIn: dateList,
  lt: dateBase,
  lte: dateBase,
  gt: dateBase,
  gte: dateBase,
});

const buildDateFilterSchema = <S extends VibSchema>(schema: S) => {
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

const buildDateListFilterSchema = <S extends VibSchema>(schema: S) => {
  const filter = dateListFilterBase.extend({
    equals: schema,
  });
  return v.union([
    shorthandFilter(schema),
    filter.extend({ not: v.union([shorthandFilter(schema), filter]) }),
  ]);
};

const buildDateUpdateSchema = <S extends VibSchema>(schema: S) =>
  v.union([
    shorthandUpdate(schema),
    v.object(
      {
        set: schema,
      },
      { partial: false }
    ),
  ]);

const buildDateListUpdateSchema = <S extends VibSchema>(schema: S) =>
  v.union([
    shorthandUpdate(schema),
    v.object({
      set: schema,
      push: v.union([shorthandArray(dateBase), dateList]),
      unshift: v.union([shorthandArray(dateBase), dateList]),
    }),
  ]);

export const buildDateSchema = <F extends FieldState<"date">>(state: F) => {
  return {
    base: state.base,
    create: v.isoDate(state),
    update: state.array
      ? buildDateListUpdateSchema(state.base)
      : buildDateUpdateSchema(state.base),
    filter: state.array
      ? buildDateListFilterSchema(state.base)
      : buildDateFilterSchema(state.base),
  } as DateSchemas<F>;
};

export type DateSchemas<F extends FieldState<"date">> = {
  base: F["base"];
  create: BaseIsoDateSchema<F>;
  update: F["array"] extends true
    ? ReturnType<typeof buildDateListUpdateSchema<F["base"]>>
    : ReturnType<typeof buildDateUpdateSchema<F["base"]>>;
  filter: F["array"] extends true
    ? ReturnType<typeof buildDateListFilterSchema<F["base"]>>
    : ReturnType<typeof buildDateFilterSchema<F["base"]>>;
};

export type InferDateInput<
  F extends FieldState<"date">,
  Type extends "create" | "update" | "filter" | "base"
> = InferInput<DateSchemas<F>[Type]>;

export type InferDateOutput<
  F extends FieldState<"date">,
  Type extends "create" | "update" | "filter" | "base"
> = InferOutput<DateSchemas<F>[Type]>;

// =============================================================================
// TIME SCHEMA BUILDER (ISO time: HH:mm:ss)
// =============================================================================

const timeFilterBase = v.object({
  in: timeList,
  notIn: timeList,
  lt: timeBase,
  lte: timeBase,
  gt: timeBase,
  gte: timeBase,
});

const buildTimeFilterSchema = <S extends VibSchema>(schema: S) => {
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

const buildTimeListFilterSchema = <S extends VibSchema>(schema: S) => {
  const filter = timeListFilterBase.extend({
    equals: schema,
  });
  return v.union([
    shorthandFilter(schema),
    filter.extend({ not: v.union([shorthandFilter(schema), filter]) }),
  ]);
};

const buildTimeUpdateSchema = <S extends VibSchema>(schema: S) =>
  v.union([
    shorthandUpdate(schema),
    v.object(
      {
        set: schema,
      },
      { partial: false }
    ),
  ]);

const buildTimeListUpdateSchema = <S extends VibSchema>(schema: S) =>
  v.union([
    shorthandUpdate(schema),
    v.object({
      set: schema,
      push: v.union([shorthandArray(timeBase), timeList]),
      unshift: v.union([shorthandArray(timeBase), timeList]),
    }),
  ]);

export const buildTimeSchema = <F extends FieldState<"time">>(state: F) => {
  return {
    base: state.base,
    create: v.isoTime(state),
    update: state.array
      ? buildTimeListUpdateSchema(state.base)
      : buildTimeUpdateSchema(state.base),
    filter: state.array
      ? buildTimeListFilterSchema(state.base)
      : buildTimeFilterSchema(state.base),
  } as TimeSchemas<F>;
};

export type TimeSchemas<F extends FieldState<"time">> = {
  base: F["base"];
  create: BaseIsoTimeSchema<F>;
  update: F["array"] extends true
    ? ReturnType<typeof buildTimeListUpdateSchema<F["base"]>>
    : ReturnType<typeof buildTimeUpdateSchema<F["base"]>>;
  filter: F["array"] extends true
    ? ReturnType<typeof buildTimeListFilterSchema<F["base"]>>
    : ReturnType<typeof buildTimeFilterSchema<F["base"]>>;
};

export type InferTimeInput<
  F extends FieldState<"time">,
  Type extends "create" | "update" | "filter" | "base"
> = InferInput<TimeSchemas<F>[Type]>;

export type InferTimeOutput<
  F extends FieldState<"time">,
  Type extends "create" | "update" | "filter" | "base"
> = InferOutput<TimeSchemas<F>[Type]>;
