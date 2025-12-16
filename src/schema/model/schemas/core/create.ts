// Create schema factories

import { object, optional, type ObjectSchema } from "valibot";
import type { ModelState } from "../../model";
import type { SchemaEntries } from "../types";
import { forEachScalarField, forEachRelation } from "../utils";

/**
 * Build scalar create schema - all scalar fields for create input
 */
export const getScalarCreate = <T extends ModelState>(
  state: T
): ObjectSchema<any, any> => {
  const entries: SchemaEntries = {};

  forEachScalarField(state, (name, field) => {
    const fieldState = field["~"].state;
    // Fields with defaults, auto-generate, or nullable are optional
    const isOptional =
      fieldState.hasDefault ||
      fieldState.autoGenerate !== undefined ||
      fieldState.nullable;

    if (isOptional) {
      entries[name] = optional(field["~"].schemas.create);
    } else {
      entries[name] = field["~"].schemas.create;
    }
  });

  return object(entries);
};

/**
 * Build relation create schema - combines all relation create inputs
 */
export const getRelationCreate = <T extends ModelState>(
  state: T
): ObjectSchema<any, any> => {
  const entries: SchemaEntries = {};

  forEachRelation(state, (name, relation) => {
    entries[name] = optional(relation["~"].schemas.create);
  });

  return object(entries);
};

/**
 * Build full create schema - scalar + relation creates
 */
export const getCreateSchema = <T extends ModelState>(
  state: T
): ObjectSchema<any, any> => {
  const entries: SchemaEntries = {};

  // Scalar fields
  forEachScalarField(state, (name, field) => {
    const fieldState = field["~"].state;
    const isOptional =
      fieldState.hasDefault ||
      fieldState.autoGenerate !== undefined ||
      fieldState.nullable;

    if (isOptional) {
      entries[name] = optional(field["~"].schemas.create);
    } else {
      entries[name] = field["~"].schemas.create;
    }
  });

  // Relation creates (all optional)
  forEachRelation(state, (name, relation) => {
    entries[name] = optional(relation["~"].schemas.create);
  });

  return object(entries);
};
