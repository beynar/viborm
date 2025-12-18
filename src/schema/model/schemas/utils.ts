// Utility functions for model schema factories

import { object, type ObjectSchema } from "valibot";
import type { ModelState } from "../model";
import { isField, type Field } from "../../fields/base";
import type { AnyRelation } from "../../relation/relation";

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
 * Check if a relation is to-one (oneToOne or manyToOne)
 */
export const isToOne = (relation: AnyRelation): boolean => {
  const type = relation["~"].state.type;
  return type === "oneToOne" || type === "manyToOne";
};
