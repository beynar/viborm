// Where schema factories

import type { ModelState } from "../../model";
import v, { VibSchema } from "../../../../validation";
import { getCompoundConstraintFilter } from "./filter";

// =============================================================================
// WHERE SCHEMA
// =============================================================================

/**
 * Build full where schema - scalar + relation filters + AND/OR/NOT
 * Uses thunks for recursive self-references
 */
export const getWhereSchema = <T extends ModelState>(state: T) => {
  // Build scalar and relation filter entries
  const scalarFilter = v.fromObject(state.scalars, "~.schemas.filter");
  const relationFilter = v.fromObject(state.relations, "~.schemas.filter");

  // Create the recursive where schema with AND/OR/NOT using thunks
  const whereSchema: VibSchema<any, any> = v.object({
    ...scalarFilter.entries,
    ...relationFilter.entries,
    // Recursive AND/OR/NOT using thunks
    AND: () => v.optional(v.union([whereSchema, v.array(whereSchema)])),
    OR: () => v.optional(v.array(whereSchema)),
    NOT: () => v.optional(v.union([whereSchema, v.array(whereSchema)])),
  });

  return whereSchema;
};

// =============================================================================
// WHERE UNIQUE SCHEMA
// =============================================================================

/**
 * Build whereUnique schema - unique fields + compound constraints
 * Combines single-field uniques with compound ID and compound uniques
 */
export const getWhereUniqueSchema = <T extends ModelState>(state: T) => {
  // Single-field unique constraints
  const uniqueFilter = v.fromObject(state.uniques, "~.schemas.base");

  // Add compound constraints (ID + uniques) using the compound filter helpers
  const compoundConstraintFilter = getCompoundConstraintFilter(state);

  return v.object({
    ...uniqueFilter.entries,
    ...compoundConstraintFilter.entries,
  });
};
