// Select and include schema factories

import type { ModelState } from "../../model";
import type { StringKeyOf } from "@schema/model/helper";
import v from "../../../../validation";

// =============================================================================
// SELECT SCHEMA
// =============================================================================

/**
 * Build select schema - boolean selection for each scalar field, nested select for relations
 */
export const getSelectSchema = <T extends ModelState>(state: T) => {
  // Scalar fields: simple boolean selection
  const scalarKeys = Object.keys(state.scalars) as StringKeyOf<T["scalars"]>[];
  const scalarEntries = v.fromKeys(scalarKeys, v.boolean({ optional: true }));

  // Relations: use relation's select schema (supports boolean or nested)
  const relationEntries = v.fromObject(state.relations, "~.schemas.select", {
    optional: true,
  });

  return v.object({
    ...scalarEntries.entries,
    ...relationEntries.entries,
  });
};

// =============================================================================
// INCLUDE SCHEMA
// =============================================================================

/**
 * Build include schema - nested include for each relation
 */
export const getIncludeSchema = <T extends ModelState>(state: T) => {
  // Relations: use relation's include schema (supports boolean or nested with where/orderBy/etc.)
  const relationEntries = v.fromObject(state.relations, "~.schemas.include", {
    optional: true,
  });

  return v.object({
    ...relationEntries.entries,
  });
};
