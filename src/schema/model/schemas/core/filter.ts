// Filter schema factories

import { object, optional, type ObjectSchema } from "valibot";
import type { ModelState } from "../../model";
import type { SchemaEntries } from "../types";
import { forEachScalarField, forEachRelation } from "../utils";

/**
 * Build scalar filter schema - combines all scalar field filters
 */
export const getScalarFilter = <T extends ModelState>(
  state: T
): ObjectSchema<any, any> => {
  const entries: SchemaEntries = {};

  forEachScalarField(state, (name, field) => {
    entries[name] = optional(field["~"].schemas.filter);
  });

  return object(entries);
};

/**
 * Build unique filter schema - only fields marked as id or unique
 */
export const getUniqueFilter = <T extends ModelState>(
  state: T
): ObjectSchema<any, any> => {
  const entries: SchemaEntries = {};

  forEachScalarField(state, (name, field) => {
    const fieldState = field["~"].state;
    if (fieldState.isId || fieldState.isUnique) {
      entries[name] = optional(field["~"].schemas.base);
    }
  });

  return object(entries);
};

/**
 * Build relation filter schema - combines all relation filters
 */
export const getRelationFilter = <T extends ModelState>(
  state: T
): ObjectSchema<any, any> => {
  const entries: SchemaEntries = {};

  forEachRelation(state, (name, relation) => {
    entries[name] = optional(relation["~"].schemas.filter);
  });

  return object(entries);
};
