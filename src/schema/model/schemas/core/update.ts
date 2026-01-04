// Update schema factories

import v from "@validation";
import type { ModelState } from "../../model";

// =============================================================================
// SCALAR UPDATE
// =============================================================================

/**
 * Build scalar update schema - all scalar fields for update input (all optional)
 */
export const getScalarUpdate = <T extends ModelState>(state: T) => {
  return v.fromObject<T["scalars"], "~.schemas.update">(
    state.scalars,
    "~.schemas.update"
  );
};

// =============================================================================
// RELATION UPDATE
// =============================================================================

/**
 * Build relation update schema - combines all relation update inputs
 */
export const getRelationUpdate = <T extends ModelState>(state: T) => {
  return v.fromObject<T["relations"], "~.schemas.update">(
    state.relations,
    "~.schemas.update"
  );
};

// =============================================================================
// FULL UPDATE SCHEMA
// =============================================================================

/**
 * Build full update schema - scalar + relation updates (all optional)
 */
export const getUpdateSchema = <T extends ModelState>(state: T) => {
  const scalarUpdate = v.fromObject<T["scalars"], "~.schemas.update">(
    state.scalars,
    "~.schemas.update"
  );
  const relationUpdate = v.fromObject<T["relations"], "~.schemas.update">(
    state.relations,
    "~.schemas.update"
  );
  return scalarUpdate.extend(relationUpdate.entries);
};
