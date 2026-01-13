// Aggregate operation args schema factories

import type {
  NumericFieldKeys,
  ScalarFieldKeys,
  StringKeyOf,
} from "@schema/model/helper";
import v, { type V } from "@validation";
import type { ModelState } from "../../model";
import type { CoreSchemas } from "../core";
import { forEachScalarField } from "../utils";

// =============================================================================
// AGGREGATE FIELD SCHEMAS
// =============================================================================

/**
 * Build aggregate field schemas (for _count, _avg, _sum, _min, _max)
 * Following Prisma's API:
 * - _count: can be `true` or object with `_all` + all scalar field names
 * - _avg, _sum: only numeric fields (int, float, decimal, bigint)
 * - _min, _max: all comparable types (all scalars)
 */
type OptionalBoolean = V.Boolean<{ optional: true }>;

/**
 * Count keys include "_all" plus all scalar field names
 */
export type CountFieldKeys<T extends ModelState> =
  | "_all"
  | ScalarFieldKeys<T["scalars"]>;

/**
 * Aggregate field schemas with proper typing
 */
export type AggregateFieldSchemas<T extends ModelState> = {
  /** Count can include _all and any scalar field */
  count: V.FromKeys<CountFieldKeys<T>[], OptionalBoolean>;
  /** Avg only works on numeric fields */
  avg: V.FromKeys<NumericFieldKeys<T["scalars"]>[], OptionalBoolean>;
  /** Sum only works on numeric fields */
  sum: V.FromKeys<NumericFieldKeys<T["scalars"]>[], OptionalBoolean>;
  /** Min works on all comparable types (all scalars) */
  min: V.FromKeys<ScalarFieldKeys<T["scalars"]>[], OptionalBoolean>;
  /** Max works on all comparable types (all scalars) */
  max: V.FromKeys<ScalarFieldKeys<T["scalars"]>[], OptionalBoolean>;
};

export const getAggregateFieldSchemas = <T extends ModelState>(
  state: T
): AggregateFieldSchemas<T> => {
  const countKeys: string[] = ["_all"];
  const numericKeys: string[] = [];
  const minMaxKeys: string[] = [];

  forEachScalarField(state, (name, field) => {
    const fieldType = field["~"].state.type;

    // Count can include all fields
    countKeys.push(name);

    // Avg/Sum only for numeric types
    if (["int", "float", "decimal", "bigint"].includes(fieldType)) {
      numericKeys.push(name);
    }

    // Min/Max for all comparable types
    minMaxKeys.push(name);
  });

  const booleanOptional = v.boolean({ optional: true });

  return {
    count: v.fromKeys(countKeys, booleanOptional),
    avg: v.fromKeys(numericKeys, booleanOptional),
    sum: v.fromKeys(numericKeys, booleanOptional),
    min: v.fromKeys(minMaxKeys, booleanOptional),
    max: v.fromKeys(minMaxKeys, booleanOptional),
  } as AggregateFieldSchemas<T>;
};

// =============================================================================
// COUNT ARGS
// =============================================================================

/**
 * Count args following Prisma's API:
 * - where: filter records before counting
 * - cursor: cursor-based pagination
 * - take: limit number of records
 * - skip: skip number of records
 * - select: which fields to count (including _all for total count)
 */
export type CountArgs<T extends ModelState> = V.Object<
  {
    where: CoreSchemas<T>["where"];
    cursor: CoreSchemas<T>["whereUnique"];
    take: V.Number;
    skip: V.Number;
    select: AggregateFieldSchemas<T>["count"];
  },
  { optional: true }
>;

export const getCountArgs = <T extends ModelState>(
  state: T,
  core: CoreSchemas<T>
): CountArgs<T> => {
  const aggSchemas = getAggregateFieldSchemas(state);

  return v.object(
    {
      where: core.where,
      cursor: core.whereUnique,
      take: v.number(),
      skip: v.number(),
      select: aggSchemas.count,
    },
    { optional: true }
  ) as CountArgs<T>;
};

// =============================================================================
// AGGREGATE ARGS
// =============================================================================

/**
 * Aggregate args: { where?, orderBy?, cursor?, take?, skip?, _count?, _avg?, _sum?, _min?, _max? }
 */

export type AggregateArgs<T extends ModelState> = V.Object<{
  where: CoreSchemas<T>["where"];
  orderBy: V.Union<
    readonly [CoreSchemas<T>["orderBy"], V.Array<CoreSchemas<T>["orderBy"]>]
  >;
  cursor: CoreSchemas<T>["whereUnique"];
  take: V.Number;
  skip: V.Number;
  _count: V.Union<
    readonly [V.Literal<true>, AggregateFieldSchemas<T>["count"]]
  >;
  _avg: AggregateFieldSchemas<T>["avg"];
  _sum: AggregateFieldSchemas<T>["sum"];
  _min: AggregateFieldSchemas<T>["min"];
  _max: AggregateFieldSchemas<T>["max"];
}>;
export const getAggregateArgs = <
  T extends ModelState,
  C extends CoreSchemas<T> = CoreSchemas<T>,
>(
  state: T,
  core: C
): AggregateArgs<T> => {
  const aggSchemas = getAggregateFieldSchemas(state);

  return v.object({
    where: core.where,
    orderBy: v.union([core.orderBy, v.array(core.orderBy)]),
    cursor: core.whereUnique,
    take: v.number(),
    skip: v.number(),
    _count: v.union([v.literal(true), aggSchemas.count]),
    _avg: aggSchemas.avg,
    _sum: aggSchemas.sum,
    _min: aggSchemas.min,
    _max: aggSchemas.max,
  }) as AggregateArgs<T>;
};

// =============================================================================
// GROUP BY HAVING SCHEMA
// =============================================================================

/**
 * Having schema for groupBy follows Prisma's pattern.
 *
 * Allows filtering on aggregate values like:
 * { profileViews: { _avg: { gt: 100 } }, name: { _count: { gte: 5 } } }
 *
 * Each field can have aggregate operators: _count, _avg, _sum, _min, _max
 * Each aggregate operator accepts numeric comparison operators.
 */
type NumericFilterOps = V.Object<
  {
    equals: V.Number;
    gt: V.Number;
    gte: V.Number;
    lt: V.Number;
    lte: V.Number;
    not: V.Number;
  },
  { optional: true }
>;

export type HavingFieldSchema = V.Object<
  {
    _count: NumericFilterOps;
    _avg: NumericFilterOps;
    _sum: NumericFilterOps;
    _min: NumericFilterOps;
    _max: NumericFilterOps;
  },
  { optional: true }
>;

export type HavingSchema<T extends ModelState> = V.Object<
  V.FromKeys<ScalarFieldKeys<T["scalars"]>[], HavingFieldSchema>["entries"],
  { optional: true }
>;

const numericFilterOps = v.object(
  {
    equals: v.number(),
    gt: v.number(),
    gte: v.number(),
    lt: v.number(),
    lte: v.number(),
    not: v.number(),
  },
  { optional: true }
);

const havingFieldSchema = v.object(
  {
    _count: numericFilterOps,
    _avg: numericFilterOps,
    _sum: numericFilterOps,
    _min: numericFilterOps,
    _max: numericFilterOps,
  },
  { optional: true }
);

export const getHavingSchema = <T extends ModelState>(
  state: T
): HavingSchema<T> => {
  const scalarKeys = Object.keys(state.scalars);
  return v.fromKeys(scalarKeys, havingFieldSchema, {
    optional: true,
  }) as HavingSchema<T>;
};

// =============================================================================
// GROUP BY ARGS
// =============================================================================

/**
 * GroupBy args: { by, where?, having?, orderBy?, take?, skip?, _count?, _avg?, _sum?, _min?, _max? }
 */
type EnumOfFields<T extends ModelState> = V.Enum<StringKeyOf<T["fields"]>[]>;

export type GroupByArgs<T extends ModelState> = V.Object<
  {
    by: V.Union<readonly [EnumOfFields<T>, V.Array<EnumOfFields<T>>]>;
    where: CoreSchemas<T>["where"];
    having: HavingSchema<T>;
    orderBy: V.Union<
      readonly [CoreSchemas<T>["orderBy"], V.Array<CoreSchemas<T>["orderBy"]>]
    >;
    take: V.Number;
    skip: V.Number;
    _count: V.Union<
      readonly [V.Literal<true>, AggregateFieldSchemas<T>["count"]]
    >;
    _avg: AggregateFieldSchemas<T>["avg"];
    _sum: AggregateFieldSchemas<T>["sum"];
    _min: AggregateFieldSchemas<T>["min"];
    _max: AggregateFieldSchemas<T>["max"];
  },
  {
    atLeast: ["by"];
  }
>;

export const getGroupByArgs = <T extends ModelState>(
  state: T,
  core: CoreSchemas<T>
): GroupByArgs<T> => {
  // Build "by" schema - array of scalar field names or single field
  const scalarKeys = Object.keys(state.scalars) as StringKeyOf<T["scalars"]>[];

  // Use enum for field names for proper type inference
  const fieldSchema = v.enum(scalarKeys);

  const aggSchemas = getAggregateFieldSchemas(state);
  const havingSchema = getHavingSchema(state);

  return v.object(
    {
      by: v.union([fieldSchema, v.array(fieldSchema)]),
      where: core.where,
      having: havingSchema,
      orderBy: v.union([core.orderBy, v.array(core.orderBy)]),
      take: v.number(),
      skip: v.number(),
      _count: v.union([v.literal(true), aggSchemas.count]),
      _avg: aggSchemas.avg,
      _sum: aggSchemas.sum,
      _min: aggSchemas.min,
      _max: aggSchemas.max,
    },
    {
      atLeast: ["by"],
    }
  ) as GroupByArgs<T>;
};
