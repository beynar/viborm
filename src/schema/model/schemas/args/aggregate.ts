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
} from "valibot";
import type { ModelState } from "../../model";
import type { CoreSchemas, SchemaEntries } from "../types";
import { forEachScalarField } from "../utils";

/**
 * Build aggregate field schemas (for _count, _avg, _sum, _min, _max)
 */
export const getAggregateFieldSchemas = <T extends ModelState>(state: T) => {
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

/**
 * Count args: { where?, cursor?, take?, skip? }
 */
export const getCountArgs = (core: CoreSchemas): ObjectSchema<any, any> => {
  return object({
    where: optional(core.where),
    cursor: optional(core.whereUnique),
    take: optional(number()),
    skip: optional(number()),
  });
};

/**
 * Aggregate args: { where?, _count?, _avg?, _sum?, _min?, _max? }
 */
export const getAggregateArgs = <T extends ModelState>(
  state: T,
  core: CoreSchemas
): ObjectSchema<any, any> => {
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
  });
};

/**
 * GroupBy args: { by, where?, having?, orderBy?, take?, skip? }
 */
export const getGroupByArgs = <T extends ModelState>(
  state: T,
  core: CoreSchemas
): ObjectSchema<any, any> => {
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
  });
};
