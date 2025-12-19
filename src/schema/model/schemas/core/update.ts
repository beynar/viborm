// Update schema factories

import {
  object,
  optional,
  type ObjectSchema,
  type OptionalSchema,
  type InferInput,
} from "valibot";
import type { ModelState } from "../../model";
import type { SchemaEntries } from "../types";
import { forEachScalarField, forEachRelation } from "../utils";

// =============================================================================
// SCALAR UPDATE
// =============================================================================

/** Scalar update schema - each scalar field's update schema, all optional */
export type ScalarUpdateSchema<T extends ModelState> = ObjectSchema<
  {
    [K in keyof T["scalars"]]: OptionalSchema<
      T["scalars"][K]["~"]["schemas"]["update"],
      undefined
    >;
  },
  undefined
>;

/** Input type for scalar update */
export type ScalarUpdateInput<T extends ModelState> = InferInput<
  ScalarUpdateSchema<T>
>;

/**
 * Build scalar update schema - all scalar fields for update input (all optional)
 */
export const getScalarUpdate = <T extends ModelState>(
  state: T
): ScalarUpdateSchema<T> => {
  const entries: SchemaEntries = {};

  forEachScalarField(state, (name, field) => {
    entries[name] = optional(field["~"].schemas.update);
  });

  return object(entries) as ScalarUpdateSchema<T>;
};

// =============================================================================
// RELATION UPDATE
// =============================================================================

/** Relation update schema - each relation's update schema, all optional */
export type RelationUpdateSchema<T extends ModelState> = ObjectSchema<
  {
    [K in keyof T["relations"]]: OptionalSchema<
      T["relations"][K]["~"]["schemas"]["update"],
      undefined
    >;
  },
  undefined
>;

/** Input type for relation update */
export type RelationUpdateInput<T extends ModelState> = InferInput<
  RelationUpdateSchema<T>
>;

/**
 * Build relation update schema - combines all relation update inputs
 */
export const getRelationUpdate = <T extends ModelState>(
  state: T
): RelationUpdateSchema<T> => {
  const entries: SchemaEntries = {};

  forEachRelation(state, (name, relation) => {
    entries[name] = optional(relation["~"].schemas.update);
  });

  return object(entries) as RelationUpdateSchema<T>;
};

// =============================================================================
// FULL UPDATE SCHEMA
// =============================================================================

/** Full update schema - scalar + relation updates (all optional) */
export type UpdateSchema<T extends ModelState> = ObjectSchema<
  {
    [K in keyof T["scalars"]]: OptionalSchema<
      T["scalars"][K]["~"]["schemas"]["update"],
      undefined
    >;
  } & {
    [K in keyof T["relations"]]: OptionalSchema<
      T["relations"][K]["~"]["schemas"]["update"],
      undefined
    >;
  },
  undefined
>;

/** Input type for full update */
export type UpdateInput<T extends ModelState> = InferInput<UpdateSchema<T>>;

/**
 * Build full update schema - scalar + relation updates (all optional)
 */
export const getUpdateSchema = <T extends ModelState>(
  state: T
): UpdateSchema<T> => {
  const entries: SchemaEntries = {};

  // Scalar updates
  forEachScalarField(state, (name, field) => {
    entries[name] = optional(field["~"].schemas.update);
  });

  // Relation updates
  forEachRelation(state, (name, relation) => {
    entries[name] = optional(relation["~"].schemas.update);
  });

  return object(entries) as UpdateSchema<T>;
};
