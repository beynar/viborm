// Create schema factories

import {
  object,
  optional,
  strictObject,
  type ObjectSchema,
  type OptionalSchema,
  type InferInput,
} from "valibot";
import type { ModelState } from "../../model";
import type { SchemaEntries } from "../types";
import { forEachScalarField, forEachRelation } from "../utils";
import v from "../../../../validation";

// =============================================================================
// SCALAR CREATE
// =============================================================================

/** Scalar create schema - each scalar field's create schema */
export type ScalarCreateSchema<T extends ModelState> = ObjectSchema<
  {
    [K in keyof T["scalars"]]: T["scalars"][K]["~"]["schemas"]["create"];
  },
  undefined
>;

/** Input type for scalar create */
export type ScalarCreateInput<T extends ModelState> = InferInput<
  ScalarCreateSchema<T>
>;

/**
 * Build scalar create schema - all scalar fields for create input
 */
export const getScalarCreate = <T extends ModelState>(
  state: T
): ScalarCreateSchema<T> => {
  const entries: SchemaEntries = {};
  forEachScalarField(state, (name, field) => {
    entries[name] = field["~"].schemas.create;
  });
  return strictObject(entries) as unknown as ScalarCreateSchema<T>;
};

// =============================================================================
// RELATION CREATE
// =============================================================================

/** Relation create schema - each relation's create schema, all optional */
export type RelationCreateSchema<T extends ModelState> = ObjectSchema<
  {
    [K in keyof T["relations"]]: OptionalSchema<
      T["relations"][K]["~"]["schemas"]["create"],
      undefined
    >;
  },
  undefined
>;

/** Input type for relation create */
export type RelationCreateInput<T extends ModelState> = InferInput<
  RelationCreateSchema<T>
>;

/**
 * Build relation create schema - combines all relation create inputs
 */
export const getRelationCreate = <T extends ModelState>(
  state: T
): RelationCreateSchema<T> => {
  const entries: SchemaEntries = {};
  forEachRelation(state, (name, relation) => {
    entries[name] = optional(relation["~"].schemas.create);
  });
  return strictObject(entries) as unknown as RelationCreateSchema<T>;
};

// =============================================================================
// FULL CREATE SCHEMA
// =============================================================================

/** Full create schema - scalar + relation creates */
export type CreateSchema<T extends ModelState> = ObjectSchema<
  {
    [K in keyof T["scalars"]]: T["scalars"][K]["~"]["schemas"]["create"];
  } & {
    [K in keyof T["relations"]]: OptionalSchema<
      T["relations"][K]["~"]["schemas"]["create"],
      undefined
    >;
  },
  undefined
>;

/** Input type for full create */
export type CreateInput<T extends ModelState> = InferInput<CreateSchema<T>>;

/**
 * Build full create schema - scalar + relation creates
 */
export const getCreateSchema = <T extends ModelState>(
  state: T
): CreateSchema<T> => {
  const entries: {
    [K in keyof T["scalars"]]: T["scalars"][K]["~"]["schemas"]["create"];
  } & {
    [K in keyof T["relations"]]: T["relations"][K]["~"]["schemas"]["create"];
  } = {};

  // Scalar fields - use their create schema directly
  forEachScalarField(state, (name, field) => {
    entries[name] = field["~"].schemas.create;
  });

  // Relation creates (all optional)
  forEachRelation(state, (name, relation) => {
    entries[name] = relation["~"].schemas.create;
  });

  return v.object(entries) as unknown as CreateSchema<T>;
};
