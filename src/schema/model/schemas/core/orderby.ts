// OrderBy schema factories

import {
  object,
  optional,
  union,
  literal,
  type ObjectSchema,
  type OptionalSchema,
  type InferInput,
} from "valibot";
import type { ModelState } from "../../model";
import type { SchemaEntries } from "../types";
import { forEachScalarField } from "../utils";

// =============================================================================
// SORT ORDER
// =============================================================================

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

/** Sort order type */
export type SortOrderInput = InferInput<typeof sortOrderSchema>;

// =============================================================================
// ORDER BY SCHEMA
// =============================================================================

/** OrderBy schema - sort direction for each scalar field */
export type OrderBySchema<T extends ModelState> = ObjectSchema<
  {
    [K in keyof T["scalars"]]: OptionalSchema<
      typeof sortOrderSchema,
      undefined
    >;
  },
  undefined
>;

/** Input type for orderBy */
export type OrderByInput<T extends ModelState> = InferInput<OrderBySchema<T>>;

/**
 * Build orderBy schema - sort direction for each scalar field
 */
export const getOrderBySchema = <T extends ModelState>(
  state: T
): OrderBySchema<T> => {
  const entries: SchemaEntries = {};

  forEachScalarField(state, (name) => {
    entries[name] = optional(sortOrderSchema);
  });

  return object(entries) as OrderBySchema<T>;
};
