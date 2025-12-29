import type { ModelState } from "../../model";
import v from "../../../../validation";

// =============================================================================
// SCALAR CREATE
// =============================================================================

/**
 * Build scalar create schema - all scalar fields for create input
 */
export const getScalarCreate = <T extends ModelState>(state: T) => {
  return v.fromObject<T["scalars"], "~.schemas.create", { partial: false }>(
    state.scalars,
    "~.schemas.create",
    { partial: false }
  );
};

/**
 * Build relation create schema - combines all relation create inputs
 */
export const getRelationCreate = <T extends ModelState>(state: T) => {
  return v.fromObject<T["relations"], "~.schemas.create">(
    state.relations,
    "~.schemas.create"
  );
};

/**
 * Build full create schema - scalar + relation creates
 */
export const getCreateSchema = <T extends ModelState>(state: T) => {
  const scalarCreate = v.fromObject<
    T["scalars"],
    "~.schemas.create",
    { partial: false }
  >(state.scalars, "~.schemas.create", {
    partial: false,
  });
  const relationCreate = v.fromObject<
    T["relations"],
    "~.schemas.create",
    { partial: false }
  >(state.relations, "~.schemas.create", {
    partial: false,
  });
  return scalarCreate.extend(relationCreate.entries);
};
