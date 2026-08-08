// Update schema factories

import type { AnyModel } from "@schema/model";
import v, { type V } from "../../primitives/v";
import type { ScalarSchemas } from "../index";

// =============================================================================
// SCALAR UPDATE
// =============================================================================

/**
 * Build scalar update schema - all scalar fields for update input (all optional)
 */
export type ScalarUpdateSchema<
  M extends AnyModel,
  F extends ScalarSchemas<M>,
> = V.FromObject<F["scalars"], "update">;
export const getScalarUpdate = <M extends AnyModel, F extends ScalarSchemas<M>>(
  fieldSchemas: F
): ScalarUpdateSchema<M, F> => {
  return v.fromObject<F["scalars"], "update">(fieldSchemas.scalars, "update");
};

// =============================================================================
// RELATION UPDATE
// =============================================================================

/**
 * Build relation update schema - combines all relation update inputs
 */
export type RelationUpdateSchema<
  M extends AnyModel,
  F extends ScalarSchemas<M>,
> = V.FromObject<F["relations"], "update">;
export const getRelationUpdate = <
  M extends AnyModel,
  F extends ScalarSchemas<M>,
>(
  fieldSchemas: F
): RelationUpdateSchema<M, F> => {
  return v.fromObject<F["relations"], "update">(
    fieldSchemas.relations,
    "update"
  );
};

// =============================================================================
// FULL UPDATE SCHEMA
// =============================================================================

/**
 * Build full update schema - scalar + relation updates (all optional)
 */
export type UpdateSchema<
  M extends AnyModel,
  F extends ScalarSchemas<M>,
> = V.Object<
  ScalarUpdateSchema<M, F>["entries"] &
    RelationUpdateSchema<M, F>["entries"] &
    V.FromObject<F["polymorphic"], "update">["entries"]
>;
export const getUpdateSchema = <M extends AnyModel, F extends ScalarSchemas<M>>(
  fieldSchemas: F
): UpdateSchema<M, F> => {
  const scalarUpdate = v.fromObject<F["scalars"], "update">(
    fieldSchemas.scalars,
    "update"
  );
  const relationUpdate = v.fromObject<F["relations"], "update">(
    fieldSchemas.relations,
    "update"
  );
  const polymorphicUpdate = v.fromObject<F["polymorphic"], "update">(
    fieldSchemas.polymorphic,
    "update"
  );
  return scalarUpdate
    .extend(relationUpdate.entries)
    .extend(polymorphicUpdate.entries);
};
