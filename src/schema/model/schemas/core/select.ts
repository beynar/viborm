// Select and include schema factories

import { object, optional, boolean, type ObjectSchema } from "valibot";
import type { ModelState } from "../../model";
import type { SchemaEntries } from "../types";
import { forEachScalarField, forEachRelation } from "../utils";

/**
 * Build select schema - boolean selection for each scalar field
 */
export const getSelectSchema = <T extends ModelState>(
  state: T
): ObjectSchema<any, any> => {
  const entries: SchemaEntries = {};

  forEachScalarField(state, (name) => {
    entries[name] = optional(boolean());
  });

  // Also add relations to select
  forEachRelation(state, (name) => {
    entries[name] = optional(boolean());
  });

  return object(entries);
};

/**
 * Build include schema - boolean inclusion for each relation
 */
export const getIncludeSchema = <T extends ModelState>(
  state: T
): ObjectSchema<any, any> => {
  const entries: SchemaEntries = {};

  forEachRelation(state, (name) => {
    entries[name] = optional(boolean());
  });

  return object(entries);
};

