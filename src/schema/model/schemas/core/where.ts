// Where schema factories

import {
  object,
  optional,
  partial,
  array,
  union,
  lazy,
  type ObjectSchema,
  type BaseSchema,
} from "valibot";
import type { ModelState } from "../../model";
import { isField } from "../../../fields/base";
import type { SchemaEntries } from "../types";
import { forEachScalarField, forEachRelation } from "../utils";

/**
 * Generate compound key name from field names
 */
export const generateCompoundKeyName = (fields: readonly string[]): string =>
  fields.join("_");

/**
 * Build full where schema - scalar + relation filters + AND/OR/NOT
 */
export const getWhereSchema = <T extends ModelState>(
  state: T
): BaseSchema<any, any, any> => {
  const scalarEntries: SchemaEntries = {};
  const relationEntries: SchemaEntries = {};

  forEachScalarField(state, (name, field) => {
    scalarEntries[name] = optional(field["~"].schemas.filter);
  });

  forEachRelation(state, (name, relation) => {
    relationEntries[name] = optional(relation["~"].schemas.filter);
  });

  // Use lazy for recursive AND/OR/NOT
  const whereSchema: BaseSchema<any, any, any> = lazy(() =>
    partial(
      object({
        ...scalarEntries,
        ...relationEntries,
        AND: optional(
          union([lazy(() => whereSchema), array(lazy(() => whereSchema))])
        ),
        OR: optional(array(lazy(() => whereSchema))),
        NOT: optional(
          union([lazy(() => whereSchema), array(lazy(() => whereSchema))])
        ),
      })
    )
  );

  return whereSchema;
};

/**
 * Build whereUnique schema - unique fields + compound constraints
 */
export const getWhereUniqueSchema = <T extends ModelState>(
  state: T
): ObjectSchema<any, any> => {
  const entries: SchemaEntries = {};

  // Add single-field unique constraints
  forEachScalarField(state, (name, field) => {
    const fieldState = field["~"].state;
    if (fieldState.isId || fieldState.isUnique) {
      entries[name] = optional(field["~"].schemas.base);
    }
  });

  // Add compound ID
  if (state.compoundId?.fields && state.compoundId.fields.length > 0) {
    const keyName =
      state.compoundId.name ?? generateCompoundKeyName(state.compoundId.fields);
    const compoundEntries: SchemaEntries = {};

    for (const fieldName of state.compoundId.fields) {
      const field = state.fields[fieldName];
      if (field && isField(field)) {
        compoundEntries[fieldName] = field["~"].schemas.base;
      }
    }

    entries[keyName] = optional(object(compoundEntries));
  }

  // Add compound uniques
  if (state.compoundUniques && state.compoundUniques.length > 0) {
    for (const constraint of state.compoundUniques) {
      if (!constraint.fields || constraint.fields.length === 0) continue;

      const keyName =
        constraint.name ?? generateCompoundKeyName(constraint.fields);
      // Skip if already added (same as compound ID)
      if (keyName in entries) continue;

      const compoundEntries: SchemaEntries = {};
      for (const fieldName of constraint.fields) {
        const field = state.fields[fieldName];
        if (field && isField(field)) {
          compoundEntries[fieldName] = field["~"].schemas.base;
        }
      }

      entries[keyName] = optional(object(compoundEntries));
    }
  }

  return object(entries);
};
