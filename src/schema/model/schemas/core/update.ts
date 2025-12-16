// Update schema factories

import { object, optional, type ObjectSchema } from "valibot";
import type { ModelState } from "../../model";
import type { SchemaEntries } from "../types";
import { forEachScalarField, forEachRelation } from "../utils";

/**
 * Build scalar update schema - all scalar fields for update input (all optional)
 */
export const getScalarUpdate = <T extends ModelState>(
  state: T
): ObjectSchema<any, any> => {
  const entries: SchemaEntries = {};

  forEachScalarField(state, (name, field) => {
    entries[name] = optional(field["~"].schemas.update);
  });

  return object(entries);
};

/**
 * Build relation update schema - combines all relation update inputs
 */
export const getRelationUpdate = <T extends ModelState>(
  state: T
): ObjectSchema<any, any> => {
  const entries: SchemaEntries = {};

  forEachRelation(state, (name, relation) => {
    entries[name] = optional(relation["~"].schemas.update);
  });

  return object(entries);
};

/**
 * Build full update schema - scalar + relation updates (all optional)
 */
export const getUpdateSchema = <T extends ModelState>(
  state: T
): ObjectSchema<any, any> => {
  const entries: SchemaEntries = {};

  // Scalar updates
  forEachScalarField(state, (name, field) => {
    entries[name] = optional(field["~"].schemas.update);
  });

  // Relation updates
  forEachRelation(state, (name, relation) => {
    entries[name] = optional(relation["~"].schemas.update);
  });

  return object(entries);
};
