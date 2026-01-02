// Aggregate operation args schema factories

import type { ModelState } from "../../model";
import type { CoreSchemas } from "../types";
import type { StringKeyOf } from "@schema/model/helper";
import v from "../../../../validation";
import { forEachScalarField } from "../utils";

// =============================================================================
// AGGREGATE FIELD SCHEMAS
// =============================================================================

/**
 * Build aggregate field schemas (for _count, _avg, _sum, _min, _max)
 */
export const getAggregateFieldSchemas = <T extends ModelState>(state: T) => {
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
export const getCountArgs = <T extends ModelState>(core: CoreSchemas<T>) => {
  return v.object({
    where: v.optional(core.where),
    cursor: v.optional(core.whereUnique),
    take: v.number({ optional: true }),
    skip: v.number({ optional: true }),
  });
};

// =============================================================================
// AGGREGATE ARGS
// =============================================================================

/**
 * Aggregate args: { where?, orderBy?, cursor?, take?, skip?, _count?, _avg?, _sum?, _min?, _max? }
 */
export const getAggregateArgs = <T extends ModelState>(
  state: T,
  core: CoreSchemas<T>
) => {
  const aggSchemas = getAggregateFieldSchemas(state);

  return v.object({
    where: v.optional(core.where),
    orderBy: v.optional(v.union([core.orderBy, v.array(core.orderBy)])),
    cursor: v.optional(core.whereUnique),
    take: v.number({ optional: true }),
    skip: v.number({ optional: true }),
    _count: v.optional(v.union([v.literal(true), aggSchemas.count])),
    _avg: v.optional(aggSchemas.avg),
    _sum: v.optional(aggSchemas.sum),
    _min: v.optional(aggSchemas.min),
    _max: v.optional(aggSchemas.max),
  });
};

// =============================================================================
// GROUP BY ARGS
// =============================================================================

/**
 * GroupBy args: { by, where?, having?, orderBy?, take?, skip?, _count?, _avg?, _sum?, _min?, _max? }
 */
export const getGroupByArgs = <T extends ModelState>(
  state: T,
  core: CoreSchemas<T>
) => {
  // Build "by" schema - array of scalar field names or single field
  const scalarKeys = Object.keys(state.scalars) as StringKeyOf<T["scalars"]>[];

  // Use enum for field names for proper type inference
  const fieldSchema = v.enum(scalarKeys);

  const aggSchemas = getAggregateFieldSchemas(state);

  return v.object(
    {
      by: v.union([fieldSchema, v.array(fieldSchema)]),
      where: v.optional(core.where),
      having: v.optional(core.where), // Simplified - could be more specific
      orderBy: v.optional(v.union([core.orderBy, v.array(core.orderBy)])),
      take: v.number({ optional: true }),
      skip: v.number({ optional: true }),
      _count: v.optional(v.union([v.literal(true), aggSchemas.count])),
      _avg: v.optional(aggSchemas.avg),
      _sum: v.optional(aggSchemas.sum),
      _min: v.optional(aggSchemas.min),
      _max: v.optional(aggSchemas.max),
    },
    {
      atLeast: ["by"],
    }
  );
};
