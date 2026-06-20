// Aggregate operation args schema factories

import type {
  NumericFieldKeys,
  ScalarFieldKeys,
} from "@schema/model/helper";
import type { AnyModel } from "@schema/model";
import v, { type V } from "@validation";
import type { FieldSchemas } from "../index";
import type { CoreSchemas } from "../core";

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
type ModelStateOf<M extends AnyModel> = M["~"]["state"];

export type CountFieldKeys<M extends AnyModel> =
  | "_all"
  | ScalarFieldKeys<ModelStateOf<M>["scalars"]>;

/**
 * Aggregate field schemas with proper typing
 */
export type AggregateFieldSchemas<M extends AnyModel> = {
  /** Count can include _all and any scalar field */
  count: V.FromKeys<CountFieldKeys<M>[], OptionalBoolean>;
  /** Avg only works on numeric fields */
  avg: V.FromKeys<NumericFieldKeys<ModelStateOf<M>["scalars"]>[], OptionalBoolean>;
  /** Sum only works on numeric fields */
  sum: V.FromKeys<NumericFieldKeys<ModelStateOf<M>["scalars"]>[], OptionalBoolean>;
  /** Min works on all comparable types (all scalars) */
  min: V.FromKeys<ScalarFieldKeys<ModelStateOf<M>["scalars"]>[], OptionalBoolean>;
  /** Max works on all comparable types (all scalars) */
  max: V.FromKeys<ScalarFieldKeys<ModelStateOf<M>["scalars"]>[], OptionalBoolean>;
};

export const getAggregateFieldSchemas = <M extends AnyModel>(
  model: M,
): AggregateFieldSchemas<M> => {
  const state = model["~"].state;
  const countKeys: string[] = ["_all"];
  const numericKeys: string[] = [];
  const minMaxKeys: string[] = [];

  for (const name of Object.keys(state.scalars)) {
    const field = state.scalars[name];
    if (!field) {
      continue;
    }
    const fieldType = field["~"].state.type;

    // Count can include all fields
    countKeys.push(name);

    // Avg/Sum only for numeric types
    if (["int", "float", "decimal", "bigint"].includes(fieldType)) {
      numericKeys.push(name);
    }

    // Min/Max for all comparable types
    minMaxKeys.push(name);
  }

  const booleanOptional = v.boolean({ optional: true });

  return {
    count: v.fromKeys(countKeys, booleanOptional),
    avg: v.fromKeys(numericKeys, booleanOptional),
    sum: v.fromKeys(numericKeys, booleanOptional),
    min: v.fromKeys(minMaxKeys, booleanOptional),
    max: v.fromKeys(minMaxKeys, booleanOptional),
  } as AggregateFieldSchemas<M>;
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
export type CountArgs<
  M extends AnyModel,
  F extends FieldSchemas<M>,
> = V.Object<
  {
    where: CoreSchemas<M, F>["where"];
    cursor: CoreSchemas<M, F>["whereUnique"];
    take: V.Number;
    skip: V.Number;
    select: AggregateFieldSchemas<M>["count"];
  },
  { optional: true }
>;

export const getCountArgs = <
  M extends AnyModel,
  F extends FieldSchemas<M>,
>(
  model: M,
  core: CoreSchemas<M, F>
): CountArgs<M, F> => {
  const aggSchemas = getAggregateFieldSchemas(model);

  return v.object(
    {
      where: core.where,
      cursor: core.whereUnique,
      take: v.number(),
      skip: v.number(),
      select: aggSchemas.count,
    },
    { optional: true }
  ) as CountArgs<M, F>;
};

// =============================================================================
// AGGREGATE ARGS
// =============================================================================

/**
 * Aggregate args: { where?, orderBy?, cursor?, take?, skip?, _count?, _avg?, _sum?, _min?, _max? }
 */

export type AggregateArgs<
  M extends AnyModel,
  F extends FieldSchemas<M>,
> = V.Object<{
  where: CoreSchemas<M, F>["where"];
  orderBy: V.Union<
    readonly [CoreSchemas<M, F>["orderBy"], V.Array<CoreSchemas<M, F>["orderBy"]>]
  >;
  cursor: CoreSchemas<M, F>["whereUnique"];
  take: V.Number;
  skip: V.Number;
  _count: V.Union<
    readonly [V.Literal<true>, AggregateFieldSchemas<M>["count"]]
  >;
  _avg: AggregateFieldSchemas<M>["avg"];
  _sum: AggregateFieldSchemas<M>["sum"];
  _min: AggregateFieldSchemas<M>["min"];
  _max: AggregateFieldSchemas<M>["max"];
}>;
export const getAggregateArgs = <
  M extends AnyModel,
  F extends FieldSchemas<M>,
  C extends CoreSchemas<M, F> = CoreSchemas<M, F>,
>(
  model: M,
  core: C
): AggregateArgs<M, F> => {
  const aggSchemas = getAggregateFieldSchemas(model);

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
  }) as AggregateArgs<M, F>;
};

// =============================================================================
// GROUP BY HAVING SCHEMA
// =============================================================================

/**
 * Having schema for groupBy follows Prisma's pattern.
 *
 * Allows filtering on:
 * - Direct field filters (for fields in `by`): { country: "USA" } / { country: { in: ["USA", "UK"] } }
 * - Aggregate values: { profileViews: { _avg: { gt: 100 } }, id: { _count: { gte: 5 } } }
 *
 * For each scalar field key, we accept either:
 * - the field's regular filter schema (same as WHERE), OR
 * - an aggregate filter object with _count/_avg/_sum/_min/_max.
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

export type HavingAggregateFieldSchema = V.Object<
  {
    _count: NumericFilterOps;
    _avg: NumericFilterOps;
    _sum: NumericFilterOps;
    _min: NumericFilterOps;
    _max: NumericFilterOps;
  },
  { optional: true }
>;

type ScalarFilterBundle = {
  scalars: Record<string, { filter: V.Schema }>;
};

type ScalarFilterEntries<F extends ScalarFilterBundle> = V.FromObject<
  F["scalars"],
  "filter"
>["entries"];

export type HavingSchemaEntries<F extends ScalarFilterBundle> = {
  [K in keyof ScalarFilterEntries<F>]: V.Union<
    readonly [HavingAggregateFieldSchema, ScalarFilterEntries<F>[K]]
  >;
};

export type HavingSchema<F extends ScalarFilterBundle> = V.Object<
  HavingSchemaEntries<F>,
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

export const getHavingSchema = <F extends ScalarFilterBundle>(
  fieldSchemas: F,
): HavingSchema<F> => {
  const entries: Record<string, unknown> = {};

  for (const [name, schemas] of Object.entries(fieldSchemas.scalars)) {
    entries[name] = v.union([havingFieldSchema, schemas.filter]);
  }

  return v.object(entries, { optional: true }) as HavingSchema<F>;
};

// =============================================================================
// GROUP BY ARGS
// =============================================================================

/**
 * GroupBy args: { by, where?, having?, orderBy?, take?, skip?, _count?, _avg?, _sum?, _min?, _max? }
 */
type GroupByFieldKeys<M extends AnyModel> = ScalarFieldKeys<
  ModelStateOf<M>["scalars"]
>;

type EnumOfScalarFields<M extends AnyModel> = V.Enum<GroupByFieldKeys<M>[]>;

export type GroupByArgs<
  M extends AnyModel,
  F extends FieldSchemas<M>,
> = V.Object<
  {
    by: V.Union<
      readonly [EnumOfScalarFields<M>, V.Array<EnumOfScalarFields<M>>]
    >;
    where: CoreSchemas<M, F>["where"];
    having: HavingSchema<F>;
    orderBy: V.Union<
      readonly [CoreSchemas<M, F>["orderBy"], V.Array<CoreSchemas<M, F>["orderBy"]>]
    >;
    take: V.Number;
    skip: V.Number;
    _count: V.Union<
      readonly [V.Literal<true>, AggregateFieldSchemas<M>["count"]]
    >;
    _avg: AggregateFieldSchemas<M>["avg"];
    _sum: AggregateFieldSchemas<M>["sum"];
    _min: AggregateFieldSchemas<M>["min"];
    _max: AggregateFieldSchemas<M>["max"];
  },
  {
    atLeast: ["by"];
  }
>;

export const getGroupByArgs = <
  M extends AnyModel,
  F extends FieldSchemas<M>,
>(
  model: M,
  fieldSchemas: F,
  core: CoreSchemas<M, F>
): GroupByArgs<M, F> => {
  const state = model["~"].state;
  // Build "by" schema - array of scalar field names or single field
  const scalarKeys = Object.keys(state.scalars) as ScalarFieldKeys<
    ModelStateOf<M>["scalars"]
  >[];

  // Use enum for field names for proper type inference
  const fieldSchema = v.enum(scalarKeys);

  const aggSchemas = getAggregateFieldSchemas(model);
  const havingSchema = getHavingSchema(fieldSchemas);

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
  ) as GroupByArgs<M, F>;
};
