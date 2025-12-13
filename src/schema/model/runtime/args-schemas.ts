// Args Schema Builders
// Builds runtime ArkType schemas for query operation arguments
// Note: Exported functions use Type without generic since these are runtime schemas

import { type, Type } from "arktype";
import type { Model } from "../model";
import type { CoreSchemas } from "./index";

// =============================================================================
// INTERNAL SCHEMA HELPERS (unique to args, not duplicated from core)
// =============================================================================

/**
 * Creates a distinct schema for field name array
 */
const buildDistinctSchema = (model: Model<any>): Type => {
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
const buildBySchema = (model: Model<any>): Type => {
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
const buildCountAggregateSchema = (model: Model<any>): Type => {
  const shape: Record<string, string> = { "_all?": "true" };

  for (const [name] of model["~"].fieldMap) {
    shape[name + "?"] = "true";
  }

  return type("true").or(type(shape));
};

/**
 * Builds an avg/sum aggregate input schema (only numeric fields)
 */
const buildNumericAggregateSchema = (model: Model<any>): Type => {
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
const buildMinMaxAggregateSchema = (model: Model<any>): Type => {
  const shape: Record<string, string> = {};

  for (const [name] of model["~"].fieldMap) {
    shape[name + "?"] = "true";
  }

  return type(shape);
};

// =============================================================================
// HAVING AGGREGATE FILTER SCHEMAS
// =============================================================================

/**
 * Static schema for aggregate filter operations (same for all models)
 * Used in having clauses: { _count: { id: { gt: 5 } } }
 */
const havingAggregateFilterSchema = type({
  "equals?": "number",
  "not?": "number | null",
  "gt?": "number",
  "gte?": "number",
  "lt?": "number",
  "lte?": "number",
  "in?": "number[]",
  "notIn?": "number[]",
});

/**
 * Builds a count having schema for having clause
 * Allows filtering on count aggregates: { id: { gt: 5 }, _all: { gte: 10 } }
 */
const buildCountHavingSchema = (model: Model<any>): Type => {
  const shape: Record<string, Type> = {};

  for (const [name] of model["~"].fieldMap) {
    shape[name + "?"] = havingAggregateFilterSchema;
  }
  shape["_all?"] = havingAggregateFilterSchema;

  return type(shape);
};

/**
 * Builds a numeric having schema for having clause (_avg, _sum)
 */
const buildNumericHavingSchema = (model: Model<any>): Type => {
  const shape: Record<string, Type> = {};

  for (const [name, field] of model["~"].fieldMap) {
    const fieldType = field["~"].state.type;
    if (["int", "float", "decimal", "bigint"].includes(fieldType)) {
      shape[name + "?"] = havingAggregateFilterSchema;
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
const buildMinMaxHavingSchema = (model: Model<any>): Type => {
  const shape: Record<string, Type> = {};

  for (const [name] of model["~"].fieldMap) {
    shape[name + "?"] = havingAggregateFilterSchema;
  }

  return type(shape);
};

/**
 * Builds a full having schema with scalar filters + aggregate filters
 */
const buildHavingSchema = (model: Model<any>): Type => {
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
 * Uses pre-built core schemas to avoid redundant building
 */
export const buildFindManyArgsSchema = (
  model: Model<any>,
  core: CoreSchemas
): Type => {
  const distinctSchema = buildDistinctSchema(model);

  return type({
    "where?": core.where,
    "orderBy?": core.orderBy.or(core.orderBy.array()),
    "cursor?": core.whereUnique,
    "take?": "number",
    "skip?": "number",
    "select?": core.selectNested,
    "include?": core.includeNested,
    "distinct?": distinctSchema,
  });
};

/**
 * Builds a findFirst args schema (same as findMany)
 */
export const buildFindFirstArgsSchema = (
  model: Model<any>,
  core: CoreSchemas
): Type => {
  return buildFindManyArgsSchema(model, core);
};

/**
 * Builds a findUnique args schema
 */
export const buildFindUniqueArgsSchema = (core: CoreSchemas): Type =>
  type({
    where: core.whereUnique,
    "select?": core.selectNested,
    "include?": core.includeNested,
  });

/**
 * Builds a count args schema - like Prisma's count operation
 * Supports where, cursor, take, skip, orderBy, and select for field-specific counts
 */
export const buildCountArgsSchema = (
  model: Model<any>,
  core: CoreSchemas
): Type => {
  // Build count select schema: { _all?: boolean, [fieldName]?: boolean }
  const countSelectShape: Record<string, Type | string> = {
    "_all?": "boolean",
  };
  for (const [name] of model["~"].fieldMap) {
    countSelectShape[name + "?"] = "boolean";
  }
  const countSelectSchema = type(countSelectShape);

  return type({
    "where?": core.where,
    "orderBy?": core.orderBy.or(core.orderBy.array()),
    "cursor?": core.whereUnique,
    "take?": "number",
    "skip?": "number",
    "select?": countSelectSchema,
  });
};

/**
 * Builds an exist args schema - lightweight check if records exist
 */
export const buildExistArgsSchema = (core: CoreSchemas): Type =>
  type({
    "where?": core.where,
  });

/**
 * Builds an aggregate args schema with full runtime validation
 */
export const buildAggregateArgsSchema = (
  model: Model<any>,
  core: CoreSchemas
): Type => {
  const countSchema = buildCountAggregateSchema(model);
  const numericSchema = buildNumericAggregateSchema(model);
  const minMaxSchema = buildMinMaxAggregateSchema(model);

  return type({
    "where?": core.where,
    "orderBy?": core.orderBy.or(core.orderBy.array()),
    "cursor?": core.whereUnique,
    "take?": "number",
    "skip?": "number",
    "_count?": countSchema,
    "_avg?": numericSchema,
    "_sum?": numericSchema,
    "_min?": minMaxSchema,
    "_max?": minMaxSchema,
  });
};

/**
 * Builds a groupBy args schema with full runtime validation
 */
export const buildGroupByArgsSchema = (
  model: Model<any>,
  core: CoreSchemas
): Type => {
  // Having with full aggregate filter support

  return type({
    "where?": core.where,
    "orderBy?": core.orderBy.or(core.orderBy.array()),
    by: buildBySchema(model),
    "having?": buildHavingSchema(model),
    "take?": "number",
    "skip?": "number",
    "_count?": buildCountAggregateSchema(model),
    "_avg?": buildNumericAggregateSchema(model),
    "_sum?": buildNumericAggregateSchema(model),
    "_min?": buildMinMaxAggregateSchema(model),
    "_max?": buildMinMaxAggregateSchema(model),
  });
};
