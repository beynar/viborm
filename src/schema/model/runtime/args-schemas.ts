// Args Schema Builders
// Builds runtime ArkType schemas for query operation arguments

import { type, Type } from "arktype";
import type { Model } from "../model";
import type {
  FieldRecord,
  ModelFindManyArgs,
  ModelFindFirstArgs,
  ModelFindUniqueArgs,
  ModelCountArgs,
  ModelExistArgs,
  ModelAggregateArgs,
  ModelGroupByArgs,
} from "../types";

// =============================================================================
// INTERNAL SCHEMA HELPERS
// =============================================================================

/**
 * Creates a sort order input schema
 * Accepts: "asc" | "desc" | { sort: "asc" | "desc", nulls?: "first" | "last" }
 */
const createSortOrderInputSchema = () =>
  type("'asc' | 'desc'").or(
    type({
      sort: "'asc' | 'desc'",
      "nulls?": "'first' | 'last'",
    })
  );

/**
 * Builds an orderBy schema from model fields
 */
const buildOrderBySchemaInternal = <TFields extends FieldRecord>(
  model: Model<TFields>
): Type => {
  const shape: Record<string, Type> = {};
  const sortOrderInput = createSortOrderInputSchema();

  for (const [name] of model["~"].fieldMap) {
    shape[name + "?"] = sortOrderInput;
  }

  return type(shape);
};

/**
 * Builds a where schema from model fields (simplified for operation args)
 */
const buildWhereSchemaInternal = <TFields extends FieldRecord>(
  model: Model<TFields>
): Type => {
  const shape: Record<string, Type> = {};

  for (const [name, field] of model["~"].fieldMap) {
    shape[name + "?"] = field["~"].schemas.filter;
  }

  return type(shape);
};

/**
 * Builds a whereUnique schema from model fields
 */
const buildWhereUniqueSchemaInternal = <TFields extends FieldRecord>(
  model: Model<TFields>
): Type => {
  const shape: Record<string, Type> = {};
  const uniqueFieldNames: string[] = [];

  for (const [name, field] of model["~"].fieldMap) {
    const state = field["~"].state;
    if (state.isId || state.isUnique) {
      shape[name + "?"] = field["~"].schemas.base;
      uniqueFieldNames.push(name);
    }
  }

  if (uniqueFieldNames.length === 0) {
    return type(shape);
  }

  // Add runtime validation: at least one unique field must be provided
  const baseSchema = type(shape);
  return baseSchema.narrow((data, ctx) => {
    const hasUniqueField = uniqueFieldNames.some(
      (name) =>
        data &&
        typeof data === "object" &&
        name in data &&
        (data as Record<string, unknown>)[name] !== undefined
    );
    if (!hasUniqueField) {
      return ctx.mustBe(
        `an object with at least one of: ${uniqueFieldNames.join(", ")}`
      );
    }
    return true;
  });
};

/**
 * Builds a select schema from model fields
 */
const buildSelectSchemaInternal = <TFields extends FieldRecord>(
  model: Model<TFields>
): Type => {
  const shape: Record<string, string> = {};

  for (const [name] of model["~"].fieldMap) {
    shape[name + "?"] = "boolean";
  }

  for (const [name] of model["~"].relations) {
    shape[name + "?"] = "boolean";
  }

  return type(shape);
};

/**
 * Builds an include schema for relations
 */
const buildIncludeSchemaInternal = <TFields extends FieldRecord>(
  model: Model<TFields>
): Type => {
  const shape: Record<string, string> = {};

  for (const [name] of model["~"].relations) {
    shape[name + "?"] = "boolean";
  }

  return type(shape);
};

/**
 * Creates a distinct schema for field name array
 */
const buildDistinctSchema = <TFields extends FieldRecord>(
  model: Model<TFields>
): Type => {
  const fieldNames = Array.from(model["~"].fieldMap.keys());

  if (fieldNames.length === 0) {
    return type("string[]");
  }

  // Create array of string schema (exact field names validated at runtime)
  return type("string[]").narrow((arr, ctx) => {
    const invalid = arr.filter((name) => !fieldNames.includes(name));
    if (invalid.length > 0) {
      return ctx.mustBe(`one of: ${fieldNames.join(", ")}`);
    }
    return true;
  });
};

/**
 * Creates a "by" schema for groupBy (single field or array of fields)
 */
const buildBySchema = <TFields extends FieldRecord>(
  model: Model<TFields>
): Type => {
  const fieldNames = Array.from(model["~"].fieldMap.keys());

  if (fieldNames.length === 0) {
    return type("string").or(type("string[]"));
  }

  // Create schema that accepts single field name or array of field names
  const singleField = type("string").narrow((s, ctx) => {
    if (fieldNames.includes(s)) return true;
    return ctx.mustBe(`one of: ${fieldNames.join(", ")}`);
  });
  const fieldArray = type("string[]").narrow((arr, ctx) => {
    const invalid = arr.filter((name) => !fieldNames.includes(name));
    if (invalid.length > 0) {
      return ctx.mustBe(`array of: ${fieldNames.join(", ")}`);
    }
    return true;
  });

  return singleField.or(fieldArray);
};

// =============================================================================
// AGGREGATE SCHEMA HELPERS
// =============================================================================

/**
 * Builds a count aggregate input schema
 * Accepts: true | { fieldName?: true, _all?: true }
 */
const buildCountAggregateSchema = <TFields extends FieldRecord>(
  model: Model<TFields>
): Type => {
  const shape: Record<string, string> = { "_all?": "true" };

  for (const [name] of model["~"].fieldMap) {
    shape[name + "?"] = "true";
  }

  return type("true").or(type(shape));
};

/**
 * Builds an avg/sum aggregate input schema (only numeric fields)
 */
const buildNumericAggregateSchema = <TFields extends FieldRecord>(
  model: Model<TFields>
): Type => {
  const shape: Record<string, string> = {};

  for (const [name, field] of model["~"].fieldMap) {
    const fieldType = field["~"].state.type;
    if (["int", "float", "decimal", "bigint"].includes(fieldType)) {
      shape[name + "?"] = "true";
    }
  }

  // If no numeric fields, return never-matching schema
  if (Object.keys(shape).length === 0) {
    return type("never");
  }

  return type(shape);
};

/**
 * Builds a min/max aggregate input schema (all comparable fields)
 */
const buildMinMaxAggregateSchema = <TFields extends FieldRecord>(
  model: Model<TFields>
): Type => {
  const shape: Record<string, string> = {};

  for (const [name] of model["~"].fieldMap) {
    shape[name + "?"] = "true";
  }

  return type(shape);
};

// =============================================================================
// HAVING AGGREGATE FILTER SCHEMAS
// =============================================================================

// Cached having aggregate filter schema to prevent recursion
let havingAggregateFilterSchema: Type | null = null;

/**
 * Builds a having aggregate filter schema
 * Allows filtering on aggregate values like { _count: { id: { gt: 5 } } }
 */
const buildHavingAggregateFilterSchema = (): Type => {
  if (havingAggregateFilterSchema) {
    return havingAggregateFilterSchema;
  }

  // Note: `not` should accept number OR nested filter, but this causes recursion
  // For simplicity, we just accept number for `not`
  havingAggregateFilterSchema = type({
    "equals?": "number",
    "not?": "number | null",
    "gt?": "number",
    "gte?": "number",
    "lt?": "number",
    "lte?": "number",
    "in?": "number[]",
    "notIn?": "number[]",
  });

  return havingAggregateFilterSchema;
};

/**
 * Builds a count having schema for having clause
 * Allows filtering on count aggregates: { id: { gt: 5 }, _all: { gte: 10 } }
 */
const buildCountHavingSchema = <TFields extends FieldRecord>(
  model: Model<TFields>
): Type => {
  const shape: Record<string, Type> = {};
  const aggregateFilter = buildHavingAggregateFilterSchema();

  for (const [name] of model["~"].fieldMap) {
    shape[name + "?"] = aggregateFilter;
  }
  shape["_all?"] = aggregateFilter;

  return type(shape);
};

/**
 * Builds a numeric having schema for having clause (_avg, _sum)
 */
const buildNumericHavingSchema = <TFields extends FieldRecord>(
  model: Model<TFields>
): Type => {
  const shape: Record<string, Type> = {};
  const aggregateFilter = buildHavingAggregateFilterSchema();

  for (const [name, field] of model["~"].fieldMap) {
    const fieldType = field["~"].state.type;
    if (["int", "float", "decimal", "bigint"].includes(fieldType)) {
      shape[name + "?"] = aggregateFilter;
    }
  }

  if (Object.keys(shape).length === 0) {
    return type({});
  }

  return type(shape);
};

/**
 * Builds a min/max having schema for having clause
 */
const buildMinMaxHavingSchema = <TFields extends FieldRecord>(
  model: Model<TFields>
): Type => {
  const shape: Record<string, Type> = {};
  const aggregateFilter = buildHavingAggregateFilterSchema();

  for (const [name] of model["~"].fieldMap) {
    shape[name + "?"] = aggregateFilter;
  }

  return type(shape);
};

/**
 * Builds a full having schema with scalar filters + aggregate filters
 */
const buildHavingSchema = <TFields extends FieldRecord>(
  model: Model<TFields>
): Type => {
  const shape: Record<string, Type> = {};

  // Scalar field filters
  for (const [name, field] of model["~"].fieldMap) {
    shape[name + "?"] = field["~"].schemas.filter;
  }

  // Aggregate filters
  shape["_count?"] = buildCountHavingSchema(model);
  shape["_avg?"] = buildNumericHavingSchema(model);
  shape["_sum?"] = buildNumericHavingSchema(model);
  shape["_min?"] = buildMinMaxHavingSchema(model);
  shape["_max?"] = buildMinMaxHavingSchema(model);

  return type(shape);
};

// =============================================================================
// OPERATION SCHEMA BUILDERS
// =============================================================================

/**
 * Builds a findMany args schema with full runtime validation
 */
export const buildFindManyArgsSchema = <TFields extends FieldRecord>(
  model: Model<TFields>
): Type<ModelFindManyArgs<TFields>> => {
  const whereSchema = buildWhereSchemaInternal(model);
  const orderBySchema = buildOrderBySchemaInternal(model);
  const cursorSchema = buildWhereUniqueSchemaInternal(model);
  const selectSchema = buildSelectSchemaInternal(model);
  const includeSchema = buildIncludeSchemaInternal(model);
  const distinctSchema = buildDistinctSchema(model);

  // Build shape with all optional fields
  const shape: Record<string, Type | string> = {
    "where?": whereSchema,
    "orderBy?": orderBySchema.or(orderBySchema.array()),
    "cursor?": cursorSchema,
    "take?": "number",
    "skip?": "number",
    "select?": selectSchema,
    "include?": includeSchema,
    "distinct?": distinctSchema,
  };

  return type(shape as Record<string, Type>) as unknown as Type<
    ModelFindManyArgs<TFields>
  >;
};

/**
 * Builds a findFirst args schema (same as findMany)
 */
export const buildFindFirstArgsSchema = <TFields extends FieldRecord>(
  model: Model<TFields>
): Type<ModelFindFirstArgs<TFields>> => {
  return buildFindManyArgsSchema(model) as unknown as Type<
    ModelFindFirstArgs<TFields>
  >;
};

/**
 * Builds a findUnique args schema with full runtime validation
 */
export const buildFindUniqueArgsSchema = <TFields extends FieldRecord>(
  model: Model<TFields>
): Type<ModelFindUniqueArgs<TFields>> => {
  const whereUniqueSchema = buildWhereUniqueSchemaInternal(model);
  const selectSchema = buildSelectSchemaInternal(model);
  const includeSchema = buildIncludeSchemaInternal(model);

  const shape: Record<string, Type> = {
    where: whereUniqueSchema,
    "select?": selectSchema,
    "include?": includeSchema,
  };

  return type(shape) as unknown as Type<ModelFindUniqueArgs<TFields>>;
};

/**
 * Builds a count args schema - like Prisma's count operation
 * Supports where, cursor, take, skip, orderBy, and select for field-specific counts
 */
export const buildCountArgsSchema = <TFields extends FieldRecord>(
  model: Model<TFields>
): Type<ModelCountArgs<TFields>> => {
  const whereSchema = buildWhereSchemaInternal(model);
  const whereUniqueSchema = buildWhereUniqueSchemaInternal(model);
  const orderBySchema = buildOrderBySchemaInternal(model);

  // Build count select schema: { _all?: boolean, [fieldName]?: boolean }
  const countSelectShape: Record<string, Type | string> = {
    "_all?": "boolean",
  };
  for (const [name] of model["~"].fieldMap) {
    countSelectShape[name + "?"] = "boolean";
  }
  const countSelectSchema = type(countSelectShape);

  const shape: Record<string, Type | string> = {
    "where?": whereSchema,
    "orderBy?": orderBySchema.or(orderBySchema.array()),
    "cursor?": whereUniqueSchema,
    "take?": "number",
    "skip?": "number",
    "select?": countSelectSchema,
  };

  return type(shape) as unknown as Type<ModelCountArgs<TFields>>;
};

/**
 * Builds an exist args schema - lightweight check if records exist
 * Returns boolean instead of count for efficiency
 */
export const buildExistArgsSchema = <TFields extends FieldRecord>(
  model: Model<TFields>
): Type<ModelExistArgs<TFields>> => {
  const whereSchema = buildWhereSchemaInternal(model);

  const shape: Record<string, Type> = {
    "where?": whereSchema,
  };

  return type(shape) as unknown as Type<ModelExistArgs<TFields>>;
};

/**
 * Builds an aggregate args schema with full runtime validation
 */
export const buildAggregateArgsSchema = <TFields extends FieldRecord>(
  model: Model<TFields>
): Type<ModelAggregateArgs<TFields>> => {
  const whereSchema = buildWhereSchemaInternal(model);
  const orderBySchema = buildOrderBySchemaInternal(model);
  const cursorSchema = buildWhereUniqueSchemaInternal(model);
  const countSchema = buildCountAggregateSchema(model);
  const numericSchema = buildNumericAggregateSchema(model);
  const minMaxSchema = buildMinMaxAggregateSchema(model);

  const shape: Record<string, Type | string> = {
    "where?": whereSchema,
    "orderBy?": orderBySchema.or(orderBySchema.array()),
    "cursor?": cursorSchema,
    "take?": "number",
    "skip?": "number",
    "_count?": countSchema,
    "_avg?": numericSchema,
    "_sum?": numericSchema,
    "_min?": minMaxSchema,
    "_max?": minMaxSchema,
  };

  return type(shape as Record<string, Type>) as unknown as Type<
    ModelAggregateArgs<TFields>
  >;
};

/**
 * Builds a groupBy args schema with full runtime validation
 */
export const buildGroupByArgsSchema = <TFields extends FieldRecord>(
  model: Model<TFields>
): Type<ModelGroupByArgs<TFields>> => {
  const whereSchema = buildWhereSchemaInternal(model);
  const orderBySchema = buildOrderBySchemaInternal(model);
  const bySchema = buildBySchema(model);
  const countSchema = buildCountAggregateSchema(model);
  const numericSchema = buildNumericAggregateSchema(model);
  const minMaxSchema = buildMinMaxAggregateSchema(model);

  // Having with full aggregate filter support
  const havingSchema = buildHavingSchema(model);

  const shape: Record<string, Type | string> = {
    "where?": whereSchema,
    "orderBy?": orderBySchema.or(orderBySchema.array()),
    by: bySchema,
    "having?": havingSchema,
    "take?": "number",
    "skip?": "number",
    "_count?": countSchema,
    "_avg?": numericSchema,
    "_sum?": numericSchema,
    "_min?": minMaxSchema,
    "_max?": minMaxSchema,
  };

  return type(shape as Record<string, Type>) as unknown as Type<
    ModelGroupByArgs<TFields>
  >;
};

