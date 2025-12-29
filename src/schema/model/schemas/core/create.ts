import type { ModelState } from "../../model";
import v from "../../../../validation";

// =============================================================================
// SCALAR CREATE
// =============================================================================

/**
 * Build scalar create schema - all scalar fields for create input
 */
export const getScalarCreate = <T extends ModelState>(state: T) => {
  return v.fromObject(state.scalars, "~.schemas.create", { partial: false });
};

/**
 * Build relation create schema - combines all relation create inputs
 */
export const getRelationCreate = <T extends ModelState>(state: T) => {
  return v.fromObject(state.relations, "~.schemas.create", { partial: false });
};

/**
 * Build full create schema - scalar + relation creates
 */
export const getCreateSchema = <T extends ModelState>(state: T) => {
  const scalarCreate = v.fromObject(state.scalars, "~.schemas.create", {
    partial: false,
  });
  const relationCreate = v.fromObject(state.relations, "~.schemas.create", {
    partial: false,
  });
  return scalarCreate.extend(relationCreate.entries);
};
