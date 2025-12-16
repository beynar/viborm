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
  for (const [name, fieldOrRelation] of Object.entries(state.fields)) {
    if (isField(fieldOrRelation)) {
      fn(name, fieldOrRelation);
    }
  }
};

/**
 * Iterate over relations only (excludes scalar fields)
 */
export const forEachRelation = (
  state: ModelState,
  fn: (name: string, relation: AnyRelation) => void
): void => {
  for (const [name, fieldOrRelation] of Object.entries(state.fields)) {
    if (!isField(fieldOrRelation)) {
      fn(name, fieldOrRelation as AnyRelation);
    }
  }
};

/**
 * Check if a relation is to-one (oneToOne or manyToOne)
 */
export const isToOne = (relation: AnyRelation): boolean => {
  const type = relation["~"].state.type;
  return type === "oneToOne" || type === "manyToOne";
};
