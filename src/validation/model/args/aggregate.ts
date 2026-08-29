// Aggregate operation args schema factories

import type { AnyModel } from "@schema/model";
import type {
  DecimalListScalarKeys,
  NonPointScalarKeys,
  NumericScalarKeys,
  PointScalarKeys,
  ScalarKeys,
} from "@schema/model/helper";
import type { ScalarState } from "@schema/scalars/common";
import type { DecimalDescriptor } from "@validation/primitives/decimal-codec";
import { scopeOperands } from "@validation/primitives/operand";
import v, { type V } from "../../primitives/v";
import type { InferInput, InferOutput, VibSchema } from "../../types";
import type { CoreSchemas } from "../core";
import {
  type DecimalListOrderByRefusalSchema,
  decimalListOrderByRefusalSchema,
  isOrderableScalarState,
  type OrderableScalarKeys,
  type SortOrderSchema,
  sortOrderSchema,
} from "../core/orderby";
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
 * - _avg, _sum: only numeric scalars (int, number, decimal, bigint)
 * - _min, _max: scalar columns, never list containers
 */
type OptionalBoolean = V.Boolean<{ optional: true }>;
type AggregateValueRefusalSchema = VibSchema<never, never>;

const SUMMABLE_SCALAR_TYPES = ["int", "number", "decimal", "bigint"];

/**
 * Whether `_sum` and `_avg` mean anything for this scalar.
 *
 * Numeric KIND is not enough on its own: a `s.decimal({...}).array()` is a
 * container — one JSON document per row on every provider that has one at all —
 * and there is no column-wide addition of documents to ask for. Plan 5.3 names
 * the shape: "the current aggregate/order builders must exclude list states
 * rather than sorting JSON or admitting `_sum` by scalar kind alone". Admitting
 * it by kind is what left a decimal list offering `_sum` with a `v.number()`
 * operand — the one operand shape this scalar exists to remove.
 *
 * `_count` remains available because a count of non-null containers is a row
 * count like any other. Value aggregates never order or combine list
 * containers.
 */
const isSummableScalar = (state: ScalarState): boolean =>
  state.array !== true && SUMMABLE_SCALAR_TYPES.includes(state.type);

/**
 * Count keys include "_all" plus all scalar names
 */
type ModelStateOf<M extends AnyModel> = M["~"]["state"];

type AggregateScalarKeys<M extends AnyModel> = Exclude<
  NonPointScalarKeys<ModelStateOf<M>["scalars"]>,
  ListScalarKeys<M>
>;

export type CountScalarKeys<M extends AnyModel> =
  | "_all"
  | ScalarKeys<ModelStateOf<M>["scalars"]>;

type ListAggregateEntries<M extends AnyModel> = V.FromKeys<
  ListScalarKeys<M>[],
  AggregateValueRefusalSchema
>["entries"];

type PointAggregateEntries<M extends AnyModel> = V.FromKeys<
  PointScalarKeys<ModelStateOf<M>["scalars"]>[],
  AggregateValueRefusalSchema
>["entries"];

type AggregateValueSchema<M extends AnyModel, K extends string> = V.Object<
  V.FromKeys<K[], OptionalBoolean>["entries"] &
    ListAggregateEntries<M> &
    PointAggregateEntries<M>
>;

/**
 * Aggregate scalar schemas with proper typing
 */
export type AggregateScalarSchemas<M extends AnyModel> = {
  /** Count can include _all and any scalar */
  count: V.FromKeys<CountScalarKeys<M>[], OptionalBoolean>;
  /** Avg only works on numeric scalars */
  avg: AggregateValueSchema<M, NumericScalarKeys<ModelStateOf<M>["scalars"]>>;
  /** Sum only works on numeric scalars */
  sum: AggregateValueSchema<M, NumericScalarKeys<ModelStateOf<M>["scalars"]>>;
  /** Min works on scalar columns, not list containers */
  min: AggregateValueSchema<M, AggregateScalarKeys<M>>;
  /** Max works on scalar columns, not list containers */
  max: AggregateValueSchema<M, AggregateScalarKeys<M>>;
};

export const getAggregateScalarSchemas = <M extends AnyModel>(
  model: M
): AggregateScalarSchemas<M> => {
  const state = model["~"].state;
  const countKeys: string[] = ["_all"];
  const numericKeys: string[] = [];
  const minMaxKeys: string[] = [];
  const listKeys: string[] = [];
  const pointKeys: string[] = [];

  for (const name of Object.keys(state.scalars)) {
    const scalar = state.scalars[name]!;

    // Count can include all scalars
    countKeys.push(name);

    // Avg/Sum only for numeric types
    if (isSummableScalar(scalar["~"].state)) {
      numericKeys.push(name);
    }

    // Value aggregates never compare list containers.
    if (
      scalar["~"].state.array !== true &&
      scalar["~"].state.type !== "point"
    ) {
      minMaxKeys.push(name);
    }
    if (scalar["~"].state.array === true) listKeys.push(name);
    if (scalar["~"].state.type === "point") pointKeys.push(name);
  }

  const booleanOptional = v.boolean({ optional: true });
  const projection = (aggregate: "_avg" | "_sum" | "_min" | "_max") =>
    v.fromKeys(
      listKeys,
      v.refused(
        `A list cannot be projected by '${aggregate}'; only '_count' is supported.`
      )
    );
  const pointProjection = (aggregate: "_avg" | "_sum" | "_min" | "_max") =>
    v.fromKeys(
      pointKeys,
      v.refused(
        `A GeoPoint cannot be projected by '${aggregate}'; use a distance projection or '_count'.`
      )
    );

  return {
    count: v.fromKeys(countKeys, booleanOptional),
    avg: v.object({
      ...v.fromKeys(numericKeys, booleanOptional).entries,
      ...projection("_avg").entries,
      ...pointProjection("_avg").entries,
    }),
    sum: v.object({
      ...v.fromKeys(numericKeys, booleanOptional).entries,
      ...projection("_sum").entries,
      ...pointProjection("_sum").entries,
    }),
    min: v.object({
      ...v.fromKeys(minMaxKeys, booleanOptional).entries,
      ...projection("_min").entries,
      ...pointProjection("_min").entries,
    }),
    max: v.object({
      ...v.fromKeys(minMaxKeys, booleanOptional).entries,
      ...projection("_max").entries,
      ...pointProjection("_max").entries,
    }),
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
// EXIST ARGS
// =============================================================================

/** Existence asks only whether any row matches one optional filter. */
export type ExistArgs<
  M extends AnyModel,
  F extends ScalarSchemas<M>,
> = V.Object<{ where: CoreSchemas<M, F>["where"] }, { optional: true }>;

export const getExistArgs = <M extends AnyModel, F extends ScalarSchemas<M>>(
  core: CoreSchemas<M, F>
): ExistArgs<M, F> =>
  v.object(
    {
      where: v.lazyRef(() => core.where),
    },
    { optional: true }
  );

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
/**
 * One aggregate's comparison operators, over whatever operand the aggregate
 * answers in. `equals`/`not` accept null so aggregates over all-null groups
 * (e.g. `_min`) can be filtered with IS NULL / IS NOT NULL semantics.
 */
type AggregateFilterOps<O extends V.Schema, N extends V.Schema> = V.Object<
  {
    equals: N;
    in: V.Array<O>;
    notIn: V.Array<O>;
    gt: O;
    gte: O;
    lt: O;
    lte: O;
    not: N;
  },
  { optional: true }
>;

type NumericFilterOps = AggregateFilterOps<
  V.Number,
  V.Number<{
    nullable: true;
  }>
>;

/**
 * A decimal aggregate's operands are DECIMALS, not doubles.
 *
 * `having: { amount: { _sum: { gt: x } } }` compares against a value the
 * database computed exactly; typing `x` as a JavaScript number puts the
 * comparison back through 53 bits of mantissa, which is the one thing this
 * scalar exists to avoid. The descriptor each operand is validated against is a
 * runtime fact (the field's own, widened for `_sum`); at the type level a
 * decimal operand is the same accepted family everywhere.
 */
type DecimalFilterOps = AggregateFilterOps<
  V.Decimal,
  V.Decimal<{
    nullable: true;
  }>
>;

/**
 * `_count` is a ROW COUNT on every scalar — an integer that has nothing to do
 * with the column's domain — so it keeps the numeric operand while the four
 * value aggregates take the column's own.
 */
export type HavingAggregateScalarSchema<
  Ops extends V.Schema = NumericFilterOps,
> = V.Object<
  {
    _count: NumericFilterOps;
    _avg: Ops;
    _sum: Ops;
    _min: Ops;
    _max: Ops;
  },
  { optional: true }
>;

type ListHavingAggregateScalarSchema = V.Object<
  {
    _count: NumericFilterOps;
    _avg: AggregateValueRefusalSchema;
    _sum: AggregateValueRefusalSchema;
    _min: AggregateValueRefusalSchema;
    _max: AggregateValueRefusalSchema;
  },
  { optional: true }
>;

type ListScalarKeys<M extends AnyModel> = {
  [K in keyof ModelStateOf<M>["scalars"]]: ModelStateOf<M>["scalars"][K] extends {
    "~": { state: { array: true } };
  }
    ? K
    : never;
}[keyof ModelStateOf<M>["scalars"]] &
  string;

/** The scalar keys of `M` whose declared type is `decimal`. */
type DecimalScalarKeys<M extends AnyModel> = {
  [K in keyof ModelStateOf<M>["scalars"]]: ModelStateOf<M>["scalars"][K] extends {
    "~": { state: { type: "decimal" } };
  }
    ? K
    : never;
}[keyof ModelStateOf<M>["scalars"]];

type HavingAggregateOf<M extends AnyModel, K> = K extends DecimalScalarKeys<M>
  ? HavingAggregateScalarSchema<DecimalFilterOps>
  : HavingAggregateScalarSchema;

type ScalarFilterBundle = {
  scalars: Record<string, { filter: V.Schema }>;
};

type ScalarFilterEntries<F extends ScalarFilterBundle> = V.FromObject<
  F["scalars"],
  "filter"
>["entries"];

/**
 * A list has one having object arm. Its shorthand array stays untouched; its
 * filter-object member receives the aggregate entries directly. A separate
 * union arm would let a forbidden aggregate key escape beside a real filter
 * key from the other arm.
 */
type WithListHavingAggregates<Value, Aggregates> =
  Value extends readonly unknown[]
    ? Value
    : Value extends object
      ? Value & Aggregates
      : Value;

type ListHavingFilterSchema<S extends V.Schema> = VibSchema<
  WithListHavingAggregates<
    InferInput<S>,
    InferInput<ListHavingAggregateScalarSchema>
  >,
  WithListHavingAggregates<
    InferOutput<S>,
    InferOutput<ListHavingAggregateScalarSchema>
  >
>;

type HavingScalarSchema<
  M extends AnyModel,
  K,
  S extends V.Schema,
> = K extends ListScalarKeys<M>
  ? ListHavingFilterSchema<S>
  : V.Union<readonly [HavingAggregateOf<M, K>, S]>;

export type HavingSchemaEntries<
  M extends AnyModel,
  F extends ScalarFilterBundle,
> = {
  [K in keyof ScalarFilterEntries<F>]: K extends PointScalarKeys<
    ModelStateOf<M>["scalars"]
  >
    ? AggregateValueRefusalSchema
    : ScalarFilterEntries<F>[K] extends infer S extends V.Schema
      ? HavingScalarSchema<M, K, S>
      : never;
};

/**
 * Boolean combinators, mirroring Prisma's `<Model>ScalarWhereWithAggregatesInput`
 * and viborm's own `WhereSchema`: `AND`/`NOT` take an object or an array, `OR`
 * takes an array. Thunks defer the self-reference (same recursion device the
 * where schema uses).
 */
export type HavingLogicalEntries<
  M extends AnyModel,
  F extends ScalarFilterBundle,
> = {
  AND: () => V.Optional<
    V.Union<readonly [HavingSchema<M, F>, V.Array<HavingSchema<M, F>>]>
  >;
  OR: () => V.Optional<V.Array<HavingSchema<M, F>>>;
  NOT: () => V.Optional<
    V.Union<readonly [HavingSchema<M, F>, V.Array<HavingSchema<M, F>>]>
  >;
};

export type HavingSchema<
  M extends AnyModel,
  F extends ScalarFilterBundle,
> = V.Object<
  HavingLogicalEntries<M, F> & HavingSchemaEntries<M, F>,
  { optional: true }
>;

const buildAggregateFilterOps = (
  operand: () => V.Schema,
  nullableOperand: () => V.Schema
) =>
  v.object(
    {
      // equals/not accept null so aggregates over all-null groups (e.g. _min)
      // can be filtered with IS NULL / IS NOT NULL semantics
      equals: nullableOperand(),
      in: v.array(operand()),
      notIn: v.array(operand()),
      gt: operand(),
      gte: operand(),
      lt: operand(),
      lte: operand(),
      not: nullableOperand(),
    },
    { optional: true }
  );

const numericFilterOps = buildAggregateFilterOps(
  () => v.number(),
  () => v.number({ nullable: true })
);

type RuntimeListFilterSchema = V.Union<
  readonly [V.Schema, V.Object<Record<string, V.Schema>>]
>;

const isRuntimeListFilterSchema = (
  schema: V.Schema
): schema is RuntimeListFilterSchema => {
  if (schema.type !== "union") return false;
  const options = Reflect.get(schema, "options");
  if (!Array.isArray(options) || options.length !== 2) return false;
  const filter = options[1];
  return (
    typeof filter === "object" &&
    filter !== null &&
    Reflect.get(filter, "type") === "object"
  );
};

const listHavingSchema = (filter: V.Schema): V.Schema => {
  const refusal = (aggregate: "_avg" | "_sum" | "_min" | "_max") =>
    v.refused(
      `A list cannot use '${aggregate}' in having; only '_count' is supported.`
    );
  const aggregateEntries = {
    _count: numericFilterOps,
    _avg: refusal("_avg"),
    _sum: refusal("_sum"),
    _min: refusal("_min"),
    _max: refusal("_max"),
  };

  if (!isRuntimeListFilterSchema(filter)) {
    return v.refused(
      "The list filter schema cannot be used in having because its trusted shape is unavailable."
    );
  }

  return v.noOperandExpression(
    v.union([filter.options[0], filter.options[1].extend(aggregateEntries)]),
    "'having'"
  );
};

/**
 * The domain a `_sum` operand is VALIDATED in: the field's SCALE and the
 * definition grammar's widest legal precision.
 *
 * A sum of a `precision: 10` column over a million rows is a legitimate answer
 * sixteen digits wide, so an operand compared against it cannot be held to one
 * row's precision — that is the plan's "`_sum` is not incorrectly rejected for
 * exceeding the field's storage precision", asked from the operand side. The
 * scale is NOT widened: every summed value carries the field's scale, so an
 * operand at a different one is a different number on a coefficient dialect.
 *
 * Provider-independent HERE and provider-bounded at the bind, deliberately:
 * which provider this model will be bound to is not knowable when its schemas
 * are built, and the practical ceiling is a provider fact. This descriptor
 * still obeys the one public descriptor invariant; the tighter domain — and
 * the refusal for an operand past it — has one owner,
 * the adapter's aggregate operand admission, reached by the query engine with
 * the exact coefficient in hand. This states the shape of the operand; that
 * states what a database can answer about.
 */
const sumOperandDomain = (
  descriptor: DecimalDescriptor
): DecimalDescriptor => ({
  precision: Number.MAX_SAFE_INTEGER,
  scale: descriptor.scale,
});

/**
 * The aggregate filter object for ONE scalar, in that scalar's own domain.
 *
 * Non-decimal scalars keep the shared numeric operand — an `_avg` of ints is a
 * fraction and an `_avg` of floats is a float, both of which a JavaScript
 * number names exactly as well as anything else. A decimal is the case where
 * the number is a lossy name for the value, so its four value aggregates take
 * decimal operands built from the field's descriptor.
 */
const havingAggregateSchema = (state: ScalarState | undefined) => {
  const descriptor = state?.type === "decimal" ? state.decimal : undefined;
  if (!descriptor) {
    return v.object(
      {
        _count: numericFilterOps,
        _avg: numericFilterOps,
        _sum: numericFilterOps,
        _min: numericFilterOps,
        _max: numericFilterOps,
      },
      { optional: true }
    );
  }
  const fieldOps = buildAggregateFilterOps(
    () => v.decimal({ decimal: descriptor }),
    () => v.decimal({ decimal: descriptor, nullable: true })
  );
  const widened = sumOperandDomain(descriptor);
  return v.object(
    {
      _count: numericFilterOps,
      _avg: fieldOps,
      _sum: buildAggregateFilterOps(
        () => v.decimal({ decimal: widened }),
        () => v.decimal({ decimal: widened, nullable: true })
      ),
      _min: fieldOps,
      _max: fieldOps,
    },
    { optional: true }
  );
};

export function getHavingSchema<
  M extends AnyModel,
  F extends ScalarFilterBundle,
>(model: M, scalarSchemas: F): HavingSchema<M, F>;
export function getHavingSchema(
  model: AnyModel,
  scalarSchemas: ScalarFilterBundle
): V.Schema {
  const entries: Record<string, V.Schema> = {};

  for (const [name, schemas] of Object.entries(scalarSchemas.scalars)) {
    // `having` reuses the model's own (shared, interned) scalar filter, which
    // accepts a field reference, an SQL fragment and the callback that returns
    // one in comparison positions. Prisma excludes field references from
    // having/groupBy — a HAVING operand is an aggregate over a group, not a
    // column of one row — and a fragment is out for the same reason, so re-close
    // the reused schema here instead of inheriting the operand by accident.
    const state = model["~"].state.scalars[name]?.["~"].state;
    if (state?.type === "point") {
      entries[name] = v.refused("A GeoPoint cannot be used in 'having'.");
      continue;
    }
    entries[name] =
      state?.array === true
        ? listHavingSchema(schemas.filter)
        : v.union([
            havingAggregateSchema(state),
            v.noOperandExpression(schemas.filter, "'having'"),
          ]);
  }

  // AND/OR/NOT recurse into the same schema through thunks — `.extend` returns
  // a NEW schema, so the thunks must close over the FINAL `havingSchema` const
  // (identical device to `getWhereSchema`, scalar entries last so a scalar
  // literally named `AND` still wins, exactly as it does in `where`). The engine
  // already builds all three combinators (`groupby-having.ts:17-36`); these
  // entries are what makes them reachable instead of dying on the strict-object
  // "Unknown key: OR".
  const havingSchema: V.Schema = v
    .object(
      {
        AND: () => v.optional(v.union([havingSchema, v.array(havingSchema)])),
        OR: () => v.optional(v.array(havingSchema)),
        NOT: () => v.optional(v.union([havingSchema, v.array(havingSchema)])),
      },
      { optional: true }
    )
    .extend(entries);

  // Scoped to the model like a `where` is, so an operand CALLBACK resolves here
  // too and is then refused by name ("… is not supported in 'having'") instead
  // of by the generic out-of-scope message. Acceptance is unchanged: what the
  // callback returns is exactly what the closure above rejects.
  return scopeOperands(havingSchema, model);
}

// =============================================================================
// GROUP BY ORDER BY
// =============================================================================

/**
 * GroupBy orderBy follows Prisma's shape: grouped scalar fields (membership
 * in `by` is enforced at query time) plus aggregate orderings like
 * { _count: { field: "desc" } }, with `_all` supported for _count.
 */
type OrderDirectionSchema = V.Enum<["asc", "desc"]>;

type GroupAggregateOrderSchema<M extends AnyModel, K extends string> = V.Object<
  V.FromKeys<K[], OrderDirectionSchema>["entries"] &
    ListAggregateEntries<M> &
    PointAggregateEntries<M>
>;

export type GroupByOrderBySchema<M extends AnyModel> = V.Object<
  V.FromKeys<OrderableScalarKeys<M>[], SortOrderSchema>["entries"] &
    V.FromKeys<
      DecimalListScalarKeys<ModelStateOf<M>["scalars"]>[],
      DecimalListOrderByRefusalSchema
    >["entries"] & {
      _count: V.FromKeys<CountScalarKeys<M>[], OrderDirectionSchema>;
      _avg: GroupAggregateOrderSchema<
        M,
        NumericScalarKeys<ModelStateOf<M>["scalars"]>
      >;
      _sum: GroupAggregateOrderSchema<
        M,
        NumericScalarKeys<ModelStateOf<M>["scalars"]>
      >;
      _min: GroupAggregateOrderSchema<M, AggregateScalarKeys<M>>;
      _max: GroupAggregateOrderSchema<M, AggregateScalarKeys<M>>;
    }
>;

const orderDirection = v.enum(["asc", "desc"]);

export const getGroupByOrderBySchema = <M extends AnyModel>(
  model: M
): GroupByOrderBySchema<M> => {
  const state = model["~"].state;
  const allScalarKeys: string[] = [];
  const scalarKeys: string[] = [];
  const decimalListKeys: string[] = [];
  const listKeys: string[] = [];
  const numericKeys: string[] = [];
  const aggregateKeys: string[] = [];
  const pointKeys: string[] = [];

  for (const name of Object.keys(state.scalars)) {
    const scalar = state.scalars[name]!;
    allScalarKeys.push(name);
    if (scalar["~"].state.array === true) listKeys.push(name);
    if (scalar["~"].state.type === "point") {
      pointKeys.push(name);
    } else if (isOrderableScalarState(scalar["~"].state)) {
      scalarKeys.push(name);
    } else {
      decimalListKeys.push(name);
    }
    if (isSummableScalar(scalar["~"].state)) {
      numericKeys.push(name);
    }
    if (
      scalar["~"].state.array !== true &&
      scalar["~"].state.type !== "point"
    ) {
      aggregateKeys.push(name);
    }
  }

  const aggregateOrder = (
    aggregate: "_avg" | "_sum" | "_min" | "_max",
    keys: string[]
  ) =>
    v.object({
      ...v.fromKeys(keys, orderDirection).entries,
      ...v.fromKeys(
        listKeys,
        v.refused(
          `A list cannot be ordered by '${aggregate}'; only '_count' is supported.`
        )
      ).entries,
      ...v.fromKeys(
        pointKeys,
        v.refused(
          `A GeoPoint cannot be ordered by '${aggregate}'; use '_distance' or '_count'.`
        )
      ).entries,
    });

  return v.object({
    ...v.fromKeys(scalarKeys, sortOrderSchema).entries,
    ...v.fromKeys(decimalListKeys, decimalListOrderByRefusalSchema).entries,
    _count: v.fromKeys(["_all", ...allScalarKeys], orderDirection),
    _avg: aggregateOrder("_avg", numericKeys),
    _sum: aggregateOrder("_sum", numericKeys),
    _min: aggregateOrder("_min", aggregateKeys),
    _max: aggregateOrder("_max", aggregateKeys),
  }) as GroupByOrderBySchema<M>;
};

// =============================================================================
// GROUP BY ARGS
// =============================================================================

/**
 * GroupBy args: { by, where?, having?, orderBy?, take?, skip?, _count?, _avg?, _sum?, _min?, _max? }
 */
type GroupByScalarKeys<M extends AnyModel> = NonPointScalarKeys<
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
    having: HavingSchema<M, F>;
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
  const scalarKeys = Object.keys(state.scalars).filter(
    (field) => state.scalars[field]!["~"].state.type !== "point"
  ) as GroupByScalarKeys<M>[];

  // Use enum for scalar names for proper type inference
  const scalarSchema = v.enum(scalarKeys);

  const aggSchemas = getAggregateScalarSchemas(model);
  const havingSchema = getHavingSchema(model, fieldSchemas);
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
