// Aggregate operation args schema factories

import type { AnyModel } from "@schema/model";
import type { NumericScalarKeys, ScalarKeys } from "@schema/model/helper";
import v, { type V } from "../../primitives/v";
import type { CoreSchemas } from "../core";
import { type SortOrderSchema, sortOrderSchema } from "../core/orderby";
import type { ScalarSchemas } from "../index";
import {
  type PaginationSkipSchema,
  type PaginationTakeSchema,
  paginationSkip,
  paginationTake,
} from "./pagination";

// =============================================================================
// AGGREGATE SCALAR SCHEMAS
// =============================================================================

/**
 * Build aggregate scalar schemas (for _count, _avg, _sum, _min, _max)
 * Following Prisma's API:
 * - _count: can be `true` or object with `_all` + all scalar names
 * - _avg, _sum: only numeric scalars (int, float, decimal, bigint)
 * - _min, _max: all comparable types (all scalars)
 */
type OptionalBoolean = V.Boolean<{ optional: true }>;

/**
 * Count keys include "_all" plus all scalar names
 */
type ModelStateOf<M extends AnyModel> = M["~"]["state"];

export type CountScalarKeys<M extends AnyModel> =
  | "_all"
  | ScalarKeys<ModelStateOf<M>["scalars"]>;

/**
 * Aggregate scalar schemas with proper typing
 */
export type AggregateScalarSchemas<M extends AnyModel> = {
  /** Count can include _all and any scalar */
  count: V.FromKeys<CountScalarKeys<M>[], OptionalBoolean>;
  /** Avg only works on numeric scalars */
  avg: V.FromKeys<
    NumericScalarKeys<ModelStateOf<M>["scalars"]>[],
    OptionalBoolean
  >;
  /** Sum only works on numeric scalars */
  sum: V.FromKeys<
    NumericScalarKeys<ModelStateOf<M>["scalars"]>[],
    OptionalBoolean
  >;
  /** Min works on all comparable types (all scalars) */
  min: V.FromKeys<ScalarKeys<ModelStateOf<M>["scalars"]>[], OptionalBoolean>;
  /** Max works on all comparable types (all scalars) */
  max: V.FromKeys<ScalarKeys<ModelStateOf<M>["scalars"]>[], OptionalBoolean>;
};

export const getAggregateScalarSchemas = <M extends AnyModel>(
  model: M
): AggregateScalarSchemas<M> => {
  const state = model["~"].state;
  const countKeys: string[] = ["_all"];
  const numericKeys: string[] = [];
  const minMaxKeys: string[] = [];

  for (const name of Object.keys(state.scalars)) {
    const scalar = state.scalars[name];
    if (!scalar) {
      continue;
    }
    const scalarType = scalar["~"].state.type;

    // Count can include all scalars
    countKeys.push(name);

    // Avg/Sum only for numeric types
    if (["int", "float", "decimal", "bigint"].includes(scalarType)) {
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
  } as AggregateScalarSchemas<M>;
};

// =============================================================================
// COUNT ARGS
// =============================================================================

/**
 * Count args following Prisma's API:
 * - where: filter records before counting
 * - orderBy: order records before cursor/take/skip pagination
 * - cursor: cursor-based pagination
 * - take: limit number of records
 * - skip: skip number of records
 * - select: which scalars to count (including _all for total count)
 */
export type CountArgs<
  M extends AnyModel,
  F extends ScalarSchemas<M>,
> = V.Object<
  {
    where: CoreSchemas<M, F>["where"];
    orderBy: V.Union<
      readonly [
        CoreSchemas<M, F>["orderBy"],
        V.Array<CoreSchemas<M, F>["orderBy"]>,
      ]
    >;
    cursor: CoreSchemas<M, F>["whereUnique"];
    take: PaginationTakeSchema;
    skip: PaginationSkipSchema;
    select: AggregateScalarSchemas<M>["count"];
  },
  { optional: true }
>;

export const getCountArgs = <M extends AnyModel, F extends ScalarSchemas<M>>(
  model: M,
  core: CoreSchemas<M, F>
): CountArgs<M, F> => {
  const aggSchemas = getAggregateScalarSchemas(model);

  return v.object(
    {
      where: v.lazyRef(() => core.where),
      orderBy: v.lazyRef(() => v.union([core.orderBy, v.array(core.orderBy)])),
      cursor: v.lazyRef(() => core.whereUnique),
      take: paginationTake(),
      skip: paginationSkip(),
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
  F extends ScalarSchemas<M>,
> = V.Object<{
  where: CoreSchemas<M, F>["where"];
  orderBy: V.Union<
    readonly [
      CoreSchemas<M, F>["orderBy"],
      V.Array<CoreSchemas<M, F>["orderBy"]>,
    ]
  >;
  cursor: CoreSchemas<M, F>["whereUnique"];
  take: PaginationTakeSchema;
  skip: PaginationSkipSchema;
  _count: V.Union<
    readonly [V.Literal<true>, AggregateScalarSchemas<M>["count"]]
  >;
  _avg: AggregateScalarSchemas<M>["avg"];
  _sum: AggregateScalarSchemas<M>["sum"];
  _min: AggregateScalarSchemas<M>["min"];
  _max: AggregateScalarSchemas<M>["max"];
}>;
export const getAggregateArgs = <
  M extends AnyModel,
  F extends ScalarSchemas<M>,
  C extends CoreSchemas<M, F> = CoreSchemas<M, F>,
>(
  model: M,
  core: C
): AggregateArgs<M, F> => {
  const aggSchemas = getAggregateScalarSchemas(model);

  return v.object({
    where: v.lazyRef(() => core.where),
    orderBy: v.lazyRef(() => v.union([core.orderBy, v.array(core.orderBy)])),
    cursor: v.lazyRef(() => core.whereUnique),
    take: paginationTake(),
    skip: paginationSkip(),
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
 * - Direct scalar filters (for scalars in `by`): { country: "USA" } / { country: { in: ["USA", "UK"] } }
 * - Aggregate values: { profileViews: { _avg: { gt: 100 } }, id: { _count: { gte: 5 } } }
 *
 * For each scalar key, we accept either:
 * - the scalar's regular filter schema (same as WHERE), OR
 * - an aggregate filter object with _count/_avg/_sum/_min/_max.
 */
type NumericFilterOps = V.Object<
  {
    equals: V.Number<{ nullable: true }>;
    in: V.Array<V.Number>;
    notIn: V.Array<V.Number>;
    gt: V.Number;
    gte: V.Number;
    lt: V.Number;
    lte: V.Number;
    not: V.Number<{ nullable: true }>;
  },
  { optional: true }
>;

export type HavingAggregateScalarSchema = V.Object<
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
    readonly [HavingAggregateScalarSchema, ScalarFilterEntries<F>[K]]
  >;
};

/**
 * Boolean combinators, mirroring Prisma's `<Model>ScalarWhereWithAggregatesInput`
 * and viborm's own `WhereSchema`: `AND`/`NOT` take an object or an array, `OR`
 * takes an array. Thunks defer the self-reference (same recursion device the
 * where schema uses).
 */
export type HavingLogicalEntries<F extends ScalarFilterBundle> = {
  AND: () => V.Optional<
    V.Union<readonly [HavingSchema<F>, V.Array<HavingSchema<F>>]>
  >;
  OR: () => V.Optional<V.Array<HavingSchema<F>>>;
  NOT: () => V.Optional<
    V.Union<readonly [HavingSchema<F>, V.Array<HavingSchema<F>>]>
  >;
};

export type HavingSchema<F extends ScalarFilterBundle> = V.Object<
  HavingLogicalEntries<F> & HavingSchemaEntries<F>,
  { optional: true }
>;

const numericFilterOps = v.object(
  {
    // equals/not accept null so aggregates over all-null groups (e.g. _min)
    // can be filtered with IS NULL / IS NOT NULL semantics
    equals: v.number({ nullable: true }),
    in: v.array(v.number()),
    notIn: v.array(v.number()),
    gt: v.number(),
    gte: v.number(),
    lt: v.number(),
    lte: v.number(),
    not: v.number({ nullable: true }),
  },
  { optional: true }
);

const havingScalarSchema = v.object(
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
  scalarSchemas: F
): HavingSchema<F> => {
  const entries: Record<string, V.Schema> = {};

  for (const [name, schemas] of Object.entries(scalarSchemas.scalars)) {
    // `having` reuses the model's own (shared, interned) scalar filter, which
    // accepts a field reference in comparison positions. Prisma excludes field
    // references from having/groupBy — a HAVING operand is an aggregate over a
    // group, not a column of one row — so re-close the reused schema here
    // instead of inheriting the operand by accident.
    entries[name] = v.union([
      havingScalarSchema,
      v.noFieldRef(schemas.filter, "'having'"),
    ]) as V.Schema;
  }

  // AND/OR/NOT recurse into the same schema through thunks — `.extend` returns
  // a NEW schema, so the thunks must close over the FINAL `havingSchema` const
  // (identical device to `getWhereSchema`, scalar entries last so a scalar
  // literally named `AND` still wins, exactly as it does in `where`). The engine
  // already builds all three combinators (`groupby-having.ts:17-36`); these
  // entries are what makes them reachable instead of dying on the strict-object
  // "Unknown key: OR".
  const havingSchema = v
    .object(
      {
        AND: () => v.optional(v.union([havingSchema, v.array(havingSchema)])),
        OR: () => v.optional(v.array(havingSchema)),
        NOT: () => v.optional(v.union([havingSchema, v.array(havingSchema)])),
      },
      { optional: true }
    )
    .extend(entries) as unknown as HavingSchema<F>;

  return havingSchema;
};

// =============================================================================
// GROUP BY ORDER BY
// =============================================================================

/**
 * GroupBy orderBy follows Prisma's shape: grouped scalar fields (membership
 * in `by` is enforced at query time) plus aggregate orderings like
 * { _count: { field: "desc" } }, with `_all` supported for _count.
 */
type OrderDirectionSchema = V.Enum<["asc", "desc"]>;

export type GroupByOrderBySchema<M extends AnyModel> = V.Object<
  V.FromKeys<
    ScalarKeys<ModelStateOf<M>["scalars"]>[],
    SortOrderSchema
  >["entries"] & {
    _count: V.FromKeys<CountScalarKeys<M>[], OrderDirectionSchema>;
    _avg: V.FromKeys<
      NumericScalarKeys<ModelStateOf<M>["scalars"]>[],
      OrderDirectionSchema
    >;
    _sum: V.FromKeys<
      NumericScalarKeys<ModelStateOf<M>["scalars"]>[],
      OrderDirectionSchema
    >;
    _min: V.FromKeys<
      ScalarKeys<ModelStateOf<M>["scalars"]>[],
      OrderDirectionSchema
    >;
    _max: V.FromKeys<
      ScalarKeys<ModelStateOf<M>["scalars"]>[],
      OrderDirectionSchema
    >;
  }
>;

const orderDirection = v.enum(["asc", "desc"]);

export const getGroupByOrderBySchema = <M extends AnyModel>(
  model: M
): GroupByOrderBySchema<M> => {
  const state = model["~"].state;
  const scalarKeys: string[] = [];
  const numericKeys: string[] = [];

  for (const name of Object.keys(state.scalars)) {
    const scalar = state.scalars[name];
    if (!scalar) {
      continue;
    }
    scalarKeys.push(name);
    if (
      ["int", "float", "decimal", "bigint"].includes(scalar["~"].state.type)
    ) {
      numericKeys.push(name);
    }
  }

  return v.object({
    ...v.fromKeys(scalarKeys, sortOrderSchema).entries,
    _count: v.fromKeys(["_all", ...scalarKeys], orderDirection),
    _avg: v.fromKeys(numericKeys, orderDirection),
    _sum: v.fromKeys(numericKeys, orderDirection),
    _min: v.fromKeys(scalarKeys, orderDirection),
    _max: v.fromKeys(scalarKeys, orderDirection),
  }) as GroupByOrderBySchema<M>;
};

// =============================================================================
// GROUP BY ARGS
// =============================================================================

/**
 * GroupBy args: { by, where?, having?, orderBy?, take?, skip?, _count?, _avg?, _sum?, _min?, _max? }
 */
type GroupByScalarKeys<M extends AnyModel> = ScalarKeys<
  ModelStateOf<M>["scalars"]
>;

type EnumOfScalarMap<M extends AnyModel> = V.Enum<GroupByScalarKeys<M>[]>;

export type GroupByArgs<
  M extends AnyModel,
  F extends ScalarSchemas<M>,
> = V.Object<
  {
    by: V.Union<readonly [EnumOfScalarMap<M>, V.Array<EnumOfScalarMap<M>>]>;
    where: CoreSchemas<M, F>["where"];
    having: HavingSchema<F>;
    orderBy: V.Union<
      readonly [GroupByOrderBySchema<M>, V.Array<GroupByOrderBySchema<M>>]
    >;
    take: PaginationTakeSchema;
    skip: PaginationSkipSchema;
    _count: V.Union<
      readonly [V.Literal<true>, AggregateScalarSchemas<M>["count"]]
    >;
    _avg: AggregateScalarSchemas<M>["avg"];
    _sum: AggregateScalarSchemas<M>["sum"];
    _min: AggregateScalarSchemas<M>["min"];
    _max: AggregateScalarSchemas<M>["max"];
  },
  {
    atLeast: ["by"];
  }
>;

export const getGroupByArgs = <M extends AnyModel, F extends ScalarSchemas<M>>(
  model: M,
  fieldSchemas: F,
  core: CoreSchemas<M, F>
): GroupByArgs<M, F> => {
  const state = model["~"].state;
  // Build "by" schema - array of scalar names or single scalar
  const scalarKeys = Object.keys(state.scalars) as ScalarKeys<
    ModelStateOf<M>["scalars"]
  >[];

  // Use enum for scalar names for proper type inference
  const scalarSchema = v.enum(scalarKeys);

  const aggSchemas = getAggregateScalarSchemas(model);
  const havingSchema = getHavingSchema(fieldSchemas);
  const orderBySchema = getGroupByOrderBySchema(model);

  return v.object(
    {
      by: v.union([scalarSchema, v.array(scalarSchema)]),
      where: v.lazyRef(() => core.where),
      having: havingSchema,
      orderBy: v.union([orderBySchema, v.array(orderBySchema)]),
      take: paginationTake(),
      skip: paginationSkip(),
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
