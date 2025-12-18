// OrderBy schema factories

import { object, optional, union, literal, type ObjectSchema } from "valibot";
import type { ModelState } from "../../model";
import type { SchemaEntries } from "../types";
import { forEachScalarField } from "../utils";

/**
 * Sort order schema for orderBy
 */
export const sortOrderSchema = union([
  literal("asc"),
  literal("desc"),
  object({
    sort: union([literal("asc"), literal("desc")]),
    nulls: optional(union([literal("first"), literal("last")])),
  }),
]);

/**
 * Build orderBy schema - sort direction for each scalar field
 */
export const getOrderBySchema = <T extends ModelState>(
  state: T
): ObjectSchema<any, any> => {
  const entries: SchemaEntries = {};

  forEachScalarField(state, (name) => {
    entries[name] = optional(sortOrderSchema);
  });

  return object(entries);
};

