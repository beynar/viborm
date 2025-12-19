// Aggregate operation args schema factories

import {
  object,
  optional,
  boolean,
  number,
  array,
  union,
  literal,
  string,
  type ObjectSchema,
  type OptionalSchema,
  type NumberSchema,
  type ArraySchema,
  type UnionSchema,
  type LiteralSchema,
  type StringSchema,
  type BooleanSchema,
  type InferInput,
} from "valibot";
import type { ModelState } from "../../model";
import type { CoreSchemas, SchemaEntries } from "../types";
import { forEachScalarField } from "../utils";
import type { WhereSchema, WhereUniqueSchema, OrderBySchema } from "../core";

// =============================================================================
// AGGREGATE FIELD SCHEMAS
// =============================================================================

/** Aggregate field schemas for _count, _avg, _sum, _min, _max */
export interface AggregateFieldSchemas {
  count: ObjectSchema<any, any>;
  avg: ObjectSchema<any, any>;
  sum: ObjectSchema<any, any>;
  min: ObjectSchema<any, any>;
  max: ObjectSchema<any, any>;
}

/**
 * Build aggregate field schemas (for _count, _avg, _sum, _min, _max)
 */
export const getAggregateFieldSchemas = <T extends ModelState>(
  state: T
): AggregateFieldSchemas => {
  const countEntries: SchemaEntries = { _all: optional(boolean()) };
  const numericEntries: SchemaEntries = {};
  const minMaxEntries: SchemaEntries = {};

  forEachScalarField(state, (name, field) => {
    const fieldType = field["~"].state.type;

    // Count can include all fields
    countEntries[name] = optional(boolean());

    // Avg/Sum only for numeric types
    if (["int", "float", "decimal", "bigint"].includes(fieldType)) {
      numericEntries[name] = optional(boolean());
    }

    // Min/Max for all comparable types
    minMaxEntries[name] = optional(boolean());
  });

  return {
    count: object(countEntries),
    avg: object(numericEntries),
    sum: object(numericEntries),
    min: object(minMaxEntries),
    max: object(minMaxEntries),
  };
};

// =============================================================================
// COUNT ARGS
// =============================================================================

/** Count args schema: { where?, cursor?, take?, skip? } */
export type CountArgsSchema<T extends ModelState> = ObjectSchema<
  {
    where: OptionalSchema<WhereSchema<T>, undefined>;
    cursor: OptionalSchema<WhereUniqueSchema<T>, undefined>;
    take: OptionalSchema<NumberSchema<undefined>, undefined>;
    skip: OptionalSchema<NumberSchema<undefined>, undefined>;
  },
  undefined
>;

/** Input type for count args */
export type CountArgsInput<T extends ModelState> = InferInput<
  CountArgsSchema<T>
>;

/**
 * Count args: { where?, cursor?, take?, skip? }
 */
export const getCountArgs = <T extends ModelState>(
  core: CoreSchemas<T>
): CountArgsSchema<T> => {
  return object({
    where: optional(core.where),
    cursor: optional(core.whereUnique),
    take: optional(number()),
    skip: optional(number()),
  }) as CountArgsSchema<T>;
};

// =============================================================================
// AGGREGATE ARGS
// =============================================================================

/** Aggregate args schema: { where?, orderBy?, cursor?, take?, skip?, _count?, _avg?, _sum?, _min?, _max? } */
export type AggregateArgsSchema<T extends ModelState> = ObjectSchema<
  {
    where: OptionalSchema<WhereSchema<T>, undefined>;
    orderBy: OptionalSchema<
      UnionSchema<
        [OrderBySchema<T>, ArraySchema<OrderBySchema<T>, undefined>],
        undefined
      >,
      undefined
    >;
    cursor: OptionalSchema<WhereUniqueSchema<T>, undefined>;
    take: OptionalSchema<NumberSchema<undefined>, undefined>;
    skip: OptionalSchema<NumberSchema<undefined>, undefined>;
    _count: OptionalSchema<
      UnionSchema<
        [LiteralSchema<true, undefined>, ObjectSchema<any, any>],
        undefined
      >,
      undefined
    >;
    _avg: OptionalSchema<ObjectSchema<any, any>, undefined>;
    _sum: OptionalSchema<ObjectSchema<any, any>, undefined>;
    _min: OptionalSchema<ObjectSchema<any, any>, undefined>;
    _max: OptionalSchema<ObjectSchema<any, any>, undefined>;
  },
  undefined
>;

/** Input type for aggregate args */
export type AggregateArgsInput<T extends ModelState> = InferInput<
  AggregateArgsSchema<T>
>;

/**
 * Aggregate args: { where?, _count?, _avg?, _sum?, _min?, _max? }
 */
export const getAggregateArgs = <T extends ModelState>(
  state: T,
  core: CoreSchemas<T>
): AggregateArgsSchema<T> => {
  const aggSchemas = getAggregateFieldSchemas(state);

  return object({
    where: optional(core.where),
    orderBy: optional(union([core.orderBy, array(core.orderBy)])),
    cursor: optional(core.whereUnique),
    take: optional(number()),
    skip: optional(number()),
    _count: optional(union([literal(true), aggSchemas.count])),
    _avg: optional(aggSchemas.avg),
    _sum: optional(aggSchemas.sum),
    _min: optional(aggSchemas.min),
    _max: optional(aggSchemas.max),
  }) as AggregateArgsSchema<T>;
};

// =============================================================================
// GROUP BY ARGS
// =============================================================================

/** GroupBy args schema: { by, where?, having?, orderBy?, take?, skip?, _count?, _avg?, _sum?, _min?, _max? } */
export type GroupByArgsSchema<T extends ModelState> = ObjectSchema<
  {
    by: UnionSchema<
      [
        StringSchema<undefined>,
        ArraySchema<StringSchema<undefined>, undefined>
      ],
      undefined
    >;
    where: OptionalSchema<WhereSchema<T>, undefined>;
    having: OptionalSchema<WhereSchema<T>, undefined>;
    orderBy: OptionalSchema<
      UnionSchema<
        [OrderBySchema<T>, ArraySchema<OrderBySchema<T>, undefined>],
        undefined
      >,
      undefined
    >;
    take: OptionalSchema<NumberSchema<undefined>, undefined>;
    skip: OptionalSchema<NumberSchema<undefined>, undefined>;
    _count: OptionalSchema<
      UnionSchema<
        [LiteralSchema<true, undefined>, ObjectSchema<any, any>],
        undefined
      >,
      undefined
    >;
    _avg: OptionalSchema<ObjectSchema<any, any>, undefined>;
    _sum: OptionalSchema<ObjectSchema<any, any>, undefined>;
    _min: OptionalSchema<ObjectSchema<any, any>, undefined>;
    _max: OptionalSchema<ObjectSchema<any, any>, undefined>;
  },
  undefined
>;

/** Input type for groupBy args */
export type GroupByArgsInput<T extends ModelState> = InferInput<
  GroupByArgsSchema<T>
>;

/**
 * GroupBy args: { by, where?, having?, orderBy?, take?, skip? }
 */
export const getGroupByArgs = <T extends ModelState>(
  state: T,
  core: CoreSchemas<T>
): GroupByArgsSchema<T> => {
  // Build "by" schema - array of scalar field names or single field
  const fieldNames: string[] = [];
  forEachScalarField(state, (name) => {
    fieldNames.push(name);
  });

  // Use string for runtime - field names are validated at type level
  const fieldSchema = string();

  const aggSchemas = getAggregateFieldSchemas(state);

  return object({
    by: union([fieldSchema, array(fieldSchema)]),
    where: optional(core.where),
    having: optional(core.where), // Simplified - could be more specific
    orderBy: optional(union([core.orderBy, array(core.orderBy)])),
    take: optional(number()),
    skip: optional(number()),
    _count: optional(union([literal(true), aggSchemas.count])),
    _avg: optional(aggSchemas.avg),
    _sum: optional(aggSchemas.sum),
    _min: optional(aggSchemas.min),
    _max: optional(aggSchemas.max),
  }) as GroupByArgsSchema<T>;
};
