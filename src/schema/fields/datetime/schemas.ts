// Temporal Field Schemas (datetime, date, time)
// Factory pattern for temporal field variants following the string/boolean schema structure

import {
  array,
  boolean,
  nullable,
  object,
  optional,
  partial,
  union,
  InferInput,
  NullableSchema,
  ArraySchema,
  pipe,
  string,
  isoTimestamp,
  isoDate,
  isoTime,
  date,
  InferOutput,
  transform,
} from "valibot";
import {
  AnySchema,
  extend,
  FieldState,
  SchemaWithDefault,
  shorthandFilter,
  shorthandUpdate,
  createWithDefault,
} from "../common";

// =============================================================================
// TEMPORAL TYPE UNION
// =============================================================================

export type TemporalFieldType = "datetime" | "date" | "time";

// =============================================================================
// BASE TYPES
// =============================================================================

// DateTime: full ISO timestamp "2023-12-15T10:30:00.000Z"
export const datetimeBase = union([
  pipe(
    date(),
    transform((v) => v.toISOString())
  ),
  pipe(string(), isoTimestamp()),
]);
export const datetimeNullable = nullable(datetimeBase);
export const datetimeList = array(datetimeBase);
export const datetimeListNullable = nullable(datetimeList);

// Date: ISO date only "2023-12-15"
export const dateBase = union([
  pipe(
    date(),
    transform((v) => v.toISOString().split("T")[0])
  ),
  pipe(string(), isoDate()),
]);
export const dateNullable = nullable(dateBase);
export const dateList = array(dateBase);
export const dateListNullable = nullable(dateList);

// Time: ISO time only "10:30:00"
export const timeBase = pipe(string(), isoTime());
export const timeNullable = nullable(timeBase);
export const timeList = array(timeBase);
export const timeListNullable = nullable(timeList);

// =============================================================================
// GENERIC TEMPORAL FILTER FACTORIES
// =============================================================================

const createTemporalFilterBase = <B extends AnySchema, L extends AnySchema>(
  base: B,
  list: L
) =>
  partial(
    object({
      equals: base,
      in: list,
      notIn: list,
      lt: base,
      lte: base,
      gt: base,
      gte: base,
    })
  );

const createTemporalArrayFilterBase = <
  B extends AnySchema,
  L extends AnySchema
>(
  base: B,
  list: L
) =>
  partial(
    object({
      equals: list,
      has: base,
      hasEvery: list,
      hasSome: list,
      isEmpty: boolean(),
    })
  );

const createTemporalFilter = <B extends AnySchema, L extends AnySchema>(
  base: B,
  list: L
) => {
  const filterBase = createTemporalFilterBase(base, list);
  return union([
    shorthandFilter(base),
    extend(filterBase, {
      not: optional(union([shorthandFilter(base), filterBase])),
    }),
  ]);
};

const createTemporalNullableFilter = <B extends AnySchema, L extends AnySchema>(
  base: B,
  list: L
) => {
  const nullableBase = nullable(base);
  const filterBase = createTemporalFilterBase(nullableBase, list);
  return union([
    shorthandFilter(nullableBase),
    extend(filterBase, {
      not: optional(union([shorthandFilter(nullableBase), filterBase])),
    }),
  ]);
};

const createTemporalListFilter = <B extends AnySchema, L extends AnySchema>(
  base: B,
  list: L
) => {
  const filterBase = createTemporalArrayFilterBase(base, list);
  return union([
    shorthandFilter(list),
    extend(filterBase, {
      not: optional(union([shorthandFilter(list), filterBase])),
    }),
  ]);
};

const createTemporalListNullableFilter = <
  B extends AnySchema,
  L extends AnySchema
>(
  base: B,
  list: L
) => {
  const nullableList = nullable(list);
  const filterBase = createTemporalArrayFilterBase(base, nullableList);
  return union([
    shorthandFilter(nullableList),
    extend(filterBase, {
      not: optional(union([shorthandFilter(nullableList), filterBase])),
    }),
  ]);
};

// =============================================================================
// GENERIC TEMPORAL UPDATE FACTORIES
// =============================================================================

const temporalUpdateFactory = <S extends AnySchema>(base: S) =>
  union([shorthandUpdate(base), object({ set: base })]);

const temporalNullableUpdateFactory = <S extends AnySchema>(base: S) =>
  union([shorthandUpdate(nullable(base)), object({ set: nullable(base) })]);

const temporalListUpdateFactory = <S extends AnySchema>(base: S) =>
  union([
    shorthandUpdate(array(base)),
    partial(
      object({
        set: array(base),
        push: union([base, array(base)]),
        unshift: union([base, array(base)]),
      })
    ),
  ]);

const temporalListNullableUpdateFactory = <S extends AnySchema>(base: S) =>
  union([
    shorthandUpdate(nullable(array(base))),
    partial(
      object({
        set: nullable(array(base)),
        push: union([base, array(base)]),
        unshift: union([base, array(base)]),
      })
    ),
  ]);

// =============================================================================
// DATETIME FILTERS (using generic factories)
// =============================================================================

const datetimeFilter = createTemporalFilter(datetimeBase, datetimeList);
const datetimeNullableFilter = createTemporalNullableFilter(
  datetimeBase,
  datetimeList
);
const datetimeListFilter = createTemporalListFilter(datetimeBase, datetimeList);
const datetimeListNullableFilter = createTemporalListNullableFilter(
  datetimeBase,
  datetimeList
);

// =============================================================================
// DATE FILTERS (using generic factories)
// =============================================================================

const dateFilter = createTemporalFilter(dateBase, dateList);
const dateNullableFilter = createTemporalNullableFilter(dateBase, dateList);
const dateListFilter = createTemporalListFilter(dateBase, dateList);
const dateListNullableFilter = createTemporalListNullableFilter(
  dateBase,
  dateList
);

// =============================================================================
// TIME FILTERS (using generic factories)
// =============================================================================

const timeFilter = createTemporalFilter(timeBase, timeList);
const timeNullableFilter = createTemporalNullableFilter(timeBase, timeList);
const timeListFilter = createTemporalListFilter(timeBase, timeList);
const timeListNullableFilter = createTemporalListNullableFilter(
  timeBase,
  timeList
);

// =============================================================================
// GENERIC TEMPORAL SCHEMA TYPES
// =============================================================================

type TemporalSchemas<F extends FieldState<TemporalFieldType>, Filter> = {
  base: F["base"];
  filter: Filter;
  create: SchemaWithDefault<F>;
  update: ReturnType<typeof temporalUpdateFactory<F["base"]>>;
};

type TemporalNullableSchemas<
  F extends FieldState<TemporalFieldType>,
  Filter
> = {
  base: NullableSchema<F["base"], undefined>;
  filter: Filter;
  create: SchemaWithDefault<F>;
  update: ReturnType<typeof temporalNullableUpdateFactory<F["base"]>>;
};

type TemporalListSchemas<F extends FieldState<TemporalFieldType>, Filter> = {
  base: ArraySchema<F["base"], undefined>;
  filter: Filter;
  create: SchemaWithDefault<F>;
  update: ReturnType<typeof temporalListUpdateFactory<F["base"]>>;
};

type TemporalListNullableSchemas<
  F extends FieldState<TemporalFieldType>,
  Filter
> = {
  base: NullableSchema<ArraySchema<F["base"], undefined>, undefined>;
  filter: Filter;
  create: SchemaWithDefault<F>;
  update: ReturnType<typeof temporalListNullableUpdateFactory<F["base"]>>;
};

// =============================================================================
// DATETIME SCHEMA BUILDERS
// =============================================================================

type DateTimeSchemas<F extends FieldState<"datetime">> = TemporalSchemas<
  F,
  typeof datetimeFilter
>;
type DateTimeNullableSchemas<F extends FieldState<"datetime">> =
  TemporalNullableSchemas<F, typeof datetimeNullableFilter>;
type DateTimeListSchemas<F extends FieldState<"datetime">> =
  TemporalListSchemas<F, typeof datetimeListFilter>;
type DateTimeListNullableSchemas<F extends FieldState<"datetime">> =
  TemporalListNullableSchemas<F, typeof datetimeListNullableFilter>;

export const datetimeSchemas = <const F extends FieldState<"datetime">>(f: F) =>
  ({
    base: f.base,
    filter: datetimeFilter,
    create: createWithDefault(f, f.base),
    update: temporalUpdateFactory(f.base),
  } as unknown as DateTimeSchemas<F>);

export const datetimeNullableSchemas = <F extends FieldState<"datetime">>(
  f: F
) =>
  ({
    base: nullable(f.base),
    filter: datetimeNullableFilter,
    create: createWithDefault(f, nullable(f.base)),
    update: temporalNullableUpdateFactory(f.base),
  } as unknown as DateTimeNullableSchemas<F>);

export const datetimeListSchemas = <F extends FieldState<"datetime">>(f: F) =>
  ({
    base: array(f.base),
    filter: datetimeListFilter,
    create: createWithDefault(f, array(f.base)),
    update: temporalListUpdateFactory(f.base),
  } as unknown as DateTimeListSchemas<F>);

export const datetimeListNullableSchemas = <F extends FieldState<"datetime">>(
  f: F
) =>
  ({
    base: nullable(array(f.base)),
    filter: datetimeListNullableFilter,
    create: createWithDefault(f, nullable(array(f.base))),
    update: temporalListNullableUpdateFactory(f.base),
  } as unknown as DateTimeListNullableSchemas<F>);

export type InferDateTimeSchemas<F extends FieldState<"datetime">> =
  F["array"] extends true
    ? F["nullable"] extends true
      ? DateTimeListNullableSchemas<F>
      : DateTimeListSchemas<F>
    : F["nullable"] extends true
    ? DateTimeNullableSchemas<F>
    : DateTimeSchemas<F>;

export const getFieldDateTimeSchemas = <F extends FieldState<"datetime">>(
  f: F
) =>
  (f.array
    ? f.nullable
      ? datetimeListNullableSchemas(f)
      : datetimeListSchemas(f)
    : f.nullable
    ? datetimeNullableSchemas(f)
    : datetimeSchemas(f)) as InferDateTimeSchemas<F>;

export type InferDateTimeInput<
  F extends FieldState<"datetime">,
  Type extends "create" | "update" | "filter" | "base"
> = InferInput<InferDateTimeSchemas<F>[Type]>;

// =============================================================================
// DATE SCHEMA BUILDERS
// =============================================================================

type DateSchemas<F extends FieldState<"date">> = TemporalSchemas<
  F,
  typeof dateFilter
>;
type DateNullableSchemas<F extends FieldState<"date">> =
  TemporalNullableSchemas<F, typeof dateNullableFilter>;
type DateListSchemas<F extends FieldState<"date">> = TemporalListSchemas<
  F,
  typeof dateListFilter
>;
type DateListNullableSchemas<F extends FieldState<"date">> =
  TemporalListNullableSchemas<F, typeof dateListNullableFilter>;

export const dateSchemas = <const F extends FieldState<"date">>(f: F) =>
  ({
    base: f.base,
    filter: dateFilter,
    create: createWithDefault(f, f.base),
    update: temporalUpdateFactory(f.base),
  } as unknown as DateSchemas<F>);

export const dateNullableSchemas = <F extends FieldState<"date">>(f: F) =>
  ({
    base: nullable(f.base),
    filter: dateNullableFilter,
    create: createWithDefault(f, nullable(f.base)),
    update: temporalNullableUpdateFactory(f.base),
  } as unknown as DateNullableSchemas<F>);

export const dateListSchemas = <F extends FieldState<"date">>(f: F) =>
  ({
    base: array(f.base),
    filter: dateListFilter,
    create: createWithDefault(f, array(f.base)),
    update: temporalListUpdateFactory(f.base),
  } as unknown as DateListSchemas<F>);

export const dateListNullableSchemas = <F extends FieldState<"date">>(f: F) =>
  ({
    base: nullable(array(f.base)),
    filter: dateListNullableFilter,
    create: createWithDefault(f, nullable(array(f.base))),
    update: temporalListNullableUpdateFactory(f.base),
  } as unknown as DateListNullableSchemas<F>);

export type InferDateSchemas<F extends FieldState<"date">> =
  F["array"] extends true
    ? F["nullable"] extends true
      ? DateListNullableSchemas<F>
      : DateListSchemas<F>
    : F["nullable"] extends true
    ? DateNullableSchemas<F>
    : DateSchemas<F>;

export const getFieldDateSchemas = <F extends FieldState<"date">>(f: F) =>
  (f.array
    ? f.nullable
      ? dateListNullableSchemas(f)
      : dateListSchemas(f)
    : f.nullable
    ? dateNullableSchemas(f)
    : dateSchemas(f)) as InferDateSchemas<F>;

export type InferDateInput<
  F extends FieldState<"date">,
  Type extends "create" | "update" | "filter" | "base"
> = InferInput<InferDateSchemas<F>[Type]>;

// =============================================================================
// TIME SCHEMA BUILDERS
// =============================================================================

type TimeSchemas<F extends FieldState<"time">> = TemporalSchemas<
  F,
  typeof timeFilter
>;
type TimeNullableSchemas<F extends FieldState<"time">> =
  TemporalNullableSchemas<F, typeof timeNullableFilter>;
type TimeListSchemas<F extends FieldState<"time">> = TemporalListSchemas<
  F,
  typeof timeListFilter
>;
type TimeListNullableSchemas<F extends FieldState<"time">> =
  TemporalListNullableSchemas<F, typeof timeListNullableFilter>;

export const timeSchemas = <const F extends FieldState<"time">>(f: F) =>
  ({
    base: f.base,
    filter: timeFilter,
    create: createWithDefault(f, f.base),
    update: temporalUpdateFactory(f.base),
  } as unknown as TimeSchemas<F>);

export const timeNullableSchemas = <F extends FieldState<"time">>(f: F) =>
  ({
    base: nullable(f.base),
    filter: timeNullableFilter,
    create: createWithDefault(f, nullable(f.base)),
    update: temporalNullableUpdateFactory(f.base),
  } as unknown as TimeNullableSchemas<F>);

export const timeListSchemas = <F extends FieldState<"time">>(f: F) =>
  ({
    base: array(f.base),
    filter: timeListFilter,
    create: createWithDefault(f, array(f.base)),
    update: temporalListUpdateFactory(f.base),
  } as unknown as TimeListSchemas<F>);

export const timeListNullableSchemas = <F extends FieldState<"time">>(f: F) =>
  ({
    base: nullable(array(f.base)),
    filter: timeListNullableFilter,
    create: createWithDefault(f, nullable(array(f.base))),
    update: temporalListNullableUpdateFactory(f.base),
  } as unknown as TimeListNullableSchemas<F>);

export type InferTimeSchemas<F extends FieldState<"time">> =
  F["array"] extends true
    ? F["nullable"] extends true
      ? TimeListNullableSchemas<F>
      : TimeListSchemas<F>
    : F["nullable"] extends true
    ? TimeNullableSchemas<F>
    : TimeSchemas<F>;

export const getFieldTimeSchemas = <F extends FieldState<"time">>(f: F) =>
  (f.array
    ? f.nullable
      ? timeListNullableSchemas(f)
      : timeListSchemas(f)
    : f.nullable
    ? timeNullableSchemas(f)
    : timeSchemas(f)) as InferTimeSchemas<F>;

export type InferTimeInput<
  F extends FieldState<"time">,
  Type extends "create" | "update" | "filter" | "base"
> = InferInput<InferTimeSchemas<F>[Type]>;
