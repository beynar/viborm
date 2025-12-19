// Utility functions for model schema factories

import { object, type ObjectSchema } from "valibot";
import type { ModelState } from "../model";
import { isField, type Field } from "../../fields/base";
import type { AnyRelation } from "../../relation/relation";
import { CompoundConstraint } from "../helper";

/**
 * Merge two object schemas into one
 */
export const merge = <
  A extends ObjectSchema<any, any>,
  B extends ObjectSchema<any, any>
>(
  a: A,
  b: B
): ObjectSchema<A["entries"] & B["entries"], any> => {
  return object({
    ...a.entries,
    ...b.entries,
  });
};

/**
 * Iterate over scalar fields only (excludes relations)
 */
export const forEachScalarField = (
  state: ModelState,
  fn: (name: string, field: Field) => void
): void => {
  for (const [name, field] of Object.entries(state.scalars)) {
    fn(name, field);
  }
};

/**
 * Iterate over relations only (excludes scalar fields)
 */
export const forEachRelation = (
  state: ModelState,
  fn: (name: string, relation: AnyRelation) => void
): void => {
  for (const [name, relation] of Object.entries(state.relations)) {
    fn(name, relation);
  }
};

export const forEachUniqueField = (
  state: ModelState,
  fn: (name: string, unique: Field) => void
): void => {
  for (const [name, unique] of Object.entries(state.uniques)) {
    fn(name, unique);
  }
};

/**
 * Iterate over compound ID constraint (if it exists)
 * Calls fn with the compound key name and the record of fields
 */
export const forEachCompoundId = (
  state: ModelState,
  fn: (keyName: string, fields: Record<string, Field>) => void
): void => {
  if (state.compoundId) {
    for (const [keyName, fields] of Object.entries(state.compoundId)) {
      fn(keyName, fields);
    }
  }
};

/**
 * Iterate over compound unique constraints (if they exist)
 * Calls fn with each compound key name and its record of fields
 */
export const forEachCompoundUnique = (
  state: ModelState,
  fn: (keyName: string, fields: Record<string, Field>) => void
): void => {
  if (state.compoundUniques) {
    for (const [keyName, fields] of Object.entries(state.compoundUniques)) {
      fn(keyName, fields);
    }
  }
};

/**
 * Iterate over all compound constraints (both ID and uniques)
 * Calls fn with each compound key name and its record of fields
 */
export const forEachCompoundConstraint = (
  state: ModelState,
  fn: (keyName: string, fields: Record<string, Field>) => void
): void => {
  forEachCompoundId(state, fn);
  forEachCompoundUnique(state, fn);
};

/**
 * Check if a relation is to-one (oneToOne or manyToOne)
 */
export const isToOne = (relation: AnyRelation): boolean => {
  const type = relation["~"].state.type;
  return type === "oneToOne" || type === "manyToOne";
};
