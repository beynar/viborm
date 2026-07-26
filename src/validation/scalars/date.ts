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

const dateBase = v.isoDate();
const dateList = v.isoDate({ array: true });

// =============================================================================
// FILTER TYPES
// =============================================================================

/** Comparison operand: a literal, or a field reference to another date column. */
type DateOperand<S extends V.Schema> = V.FieldRefOr<"date", S>;

type DateFilterBase<S extends V.Schema> = {
  equals: DateOperand<S>;
  in: V.IsoDate<{ array: true }>;
  notIn: V.IsoDate<{ array: true }>;
  lt: DateOperand<V.IsoDate>;
  lte: DateOperand<V.IsoDate>;
  gt: DateOperand<V.IsoDate>;
  gte: DateOperand<V.IsoDate>;
};

type DateFilterSchema<S extends V.Schema> = NegatableFilterSchema<
  DateOperand<S>,
  DateFilterBase<S>
>;

type DateListFilterBase<S extends V.Schema> = {
  equals: S;
  has: V.IsoDate;
  hasEvery: V.IsoDate<{ array: true }>;
  hasSome: V.IsoDate<{ array: true }>;
  isEmpty: V.Boolean;
};

type DateListFilterSchema<S extends V.Schema> = NegatableFilterSchema<
  S,
  DateListFilterBase<S>
>;

// =============================================================================
// UPDATE TYPES
// =============================================================================

type DateUpdateSchema<S extends V.Schema> = V.Union<
  readonly [V.ShorthandUpdate<S>, V.Object<{ set: S }, { partial: false }>]
>;

type DateListUpdateSchema<S extends V.Schema> = V.Union<
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
// SCHEMA BUILDERS
// =============================================================================

const dateFilterBase = v.object({
  in: dateList,
  notIn: dateList,
  lt: v.fieldRefOr("date", dateBase),
  lte: v.fieldRefOr("date", dateBase),
  gt: v.fieldRefOr("date", dateBase),
  gte: v.fieldRefOr("date", dateBase),
});

const buildDateFilterSchema = <S extends V.Schema>(
  schema: S
): DateFilterSchema<S> => {
  const operand = v.fieldRefOr("date", schema);
  const filter = dateFilterBase.extend({
    equals: operand,
  });
  return buildNegatableFilterSchema<DateOperand<S>, DateFilterBase<S>>(
    filter,
    operand
  );
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
  return buildNegatableFilterSchema<S, DateListFilterBase<S>>(filter, schema);
};

const buildDateUpdateSchema = <S extends V.Schema>(
  schema: S
): DateUpdateSchema<S> =>
  v.union([
    v.shorthandUpdate(schema),
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
    v.shorthandUpdate(schema),
    v.object({
      set: schema,
      push: v.union([v.shorthandArray(dateBase), dateList]),
      unshift: v.union([v.shorthandArray(dateBase), dateList]),
    }),
  ]);

export interface DateSchemas<F extends ScalarState<"date">> {
  base: F["base"];
  create: V.IsoDate<F>;
  update: F["array"] extends true
    ? DateListUpdateSchema<F["base"]>
    : DateUpdateSchema<F["base"]>;
  filter: F["array"] extends true
    ? DateListFilterSchema<F["base"]>
    : DateFilterSchema<F["base"]>;
}

const internFilter = createScalarInterner<unknown>();
const internUpdate = createScalarInterner<unknown>();

export const buildDateSchema = <F extends ScalarState<"date">>(
  state: F
): DateSchemas<F> => {
  const key = scalarInternKey(state);
  return {
    base: state.base as F["base"],
    create: v.isoDate(state),
    update: internUpdate(key, () =>
      state.array
        ? buildDateListUpdateSchema(state.base)
        : buildDateUpdateSchema(state.base)
    ) as never,
    filter: internFilter(key, () =>
      state.array
        ? buildDateListFilterSchema(state.base)
        : buildDateFilterSchema(state.base)
    ) as never,
  } as DateSchemas<F>;
};
