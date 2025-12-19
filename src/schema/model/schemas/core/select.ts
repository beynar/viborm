// Select and include schema factories

import {
  object,
  optional,
  boolean,
  strictObject,
  type ObjectSchema,
  type OptionalSchema,
  type BooleanSchema,
  type InferInput,
} from "valibot";
import type { ModelState } from "../../model";
import type { SchemaEntries } from "../types";
import { forEachScalarField, forEachRelation } from "../utils";

// =============================================================================
// SELECT SCHEMA
// =============================================================================

/** Select schema - boolean selection for each scalar field, nested select for relations */
export type SelectSchema<T extends ModelState> = ObjectSchema<
  {
    [K in keyof T["scalars"]]: OptionalSchema<
      BooleanSchema<undefined>,
      undefined
    >;
  } & {
    [K in keyof T["relations"]]: OptionalSchema<
      T["relations"][K]["~"]["schemas"]["select"],
      undefined
    >;
  },
  undefined
>;

/** Input type for select */
export type SelectInput<T extends ModelState> = InferInput<SelectSchema<T>>;

/**
 * Build select schema - boolean selection for each scalar field, nested select for relations
 */
export const getSelectSchema = <T extends ModelState>(
  state: T
): SelectSchema<T> => {
  const entries: SchemaEntries = {};

  // Scalar fields: simple boolean
  forEachScalarField(state, (name) => {
    entries[name] = optional(boolean());
  });

  // Relations: use relation's select schema (supports boolean or nested)
  forEachRelation(state, (name, relation) => {
    entries[name] = optional(relation["~"].schemas.select);
  });

  return strictObject(entries) as unknown as SelectSchema<T>;
};

// =============================================================================
// INCLUDE SCHEMA
// =============================================================================

/** Include schema - nested include for each relation */
export type IncludeSchema<T extends ModelState> = ObjectSchema<
  {
    [K in keyof T["relations"]]: OptionalSchema<
      T["relations"][K]["~"]["schemas"]["include"],
      undefined
    >;
  },
  undefined
>;

/** Input type for include */
export type IncludeInput<T extends ModelState> = InferInput<IncludeSchema<T>>;

/**
 * Build include schema - nested include for each relation
 */
export const getIncludeSchema = <T extends ModelState>(
  state: T
): IncludeSchema<T> => {
  const entries: SchemaEntries = {};

  // Relations: use relation's include schema (supports boolean or nested with where/orderBy/etc.)
  forEachRelation(state, (name, relation) => {
    entries[name] = optional(relation["~"].schemas.include);
  });

  return strictObject(entries) as unknown as IncludeSchema<T>;
};
