// Aggregate operation args schema factories

import type { StringKeyOf } from "@schema/model/helper";
import v, { type V } from "@validation";
import type { ModelState } from "../../model";
import type { CoreSchemas } from "../core";
import { forEachScalarField } from "../utils";

// =============================================================================
// AGGREGATE FIELD SCHEMAS
// =============================================================================

/**
 * Build aggregate field schemas (for _count, _avg, _sum, _min, _max)
 */
type OptionalBoolean = V.Boolean<{ optional: true }>;

// TODO this is not typed properly
export type AggregateFieldSchemas<T extends ModelState> = {
  count: V.FromKeys<string[], OptionalBoolean>;
  avg: V.FromKeys<StringKeyOf<T["scalars"]>[], OptionalBoolean>;
  sum: V.FromKeys<StringKeyOf<T["scalars"]>[], OptionalBoolean>;
  min: V.FromKeys<StringKeyOf<T["scalars"]>[], OptionalBoolean>;
  max: V.FromKeys<StringKeyOf<T["scalars"]>[], OptionalBoolean>;
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
  };
};

// =============================================================================
// COUNT ARGS
// =============================================================================

/**
 * Count args: { where?, cursor?, take?, skip? }
 */
export type CountArgs<T extends ModelState> = V.Object<
  {
    where: CoreSchemas<T>["where"];
    cursor: CoreSchemas<T>["whereUnique"];
    take: V.Number;
    skip: V.Number;
  },
  { optional: true }
>;
export const getCountArgs = <T extends ModelState>(
  core: CoreSchemas<T>
): CountArgs<T> => {
  return v.object(
    {
      where: core.where,
      cursor: core.whereUnique,
      take: v.number(),
      skip: v.number(),
    },
    { optional: true }
  );
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
  });
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
    having: CoreSchemas<T>["where"];
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

  return v.object(
    {
      by: v.union([fieldSchema, v.array(fieldSchema)]),
      where: core.where,
      having: core.where, // Simplified - could be more specific
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
  );
};
