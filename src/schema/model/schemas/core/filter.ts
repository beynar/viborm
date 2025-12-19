// Filter schema factories
import {
  object,
  optional,
  type ObjectSchema,
  type InferInput,
  type OptionalSchema,
} from "valibot";
import type { ModelState } from "../../model";
import type { SchemaEntries } from "../types";
import {
  forEachScalarField,
  forEachRelation,
  forEachUniqueField,
  forEachCompoundConstraint,
  forEachCompoundId,
} from "../utils";
import type { Field } from "../../../fields/base";

// =============================================================================
// SCALAR FILTER
// =============================================================================

/** Scalar filter schema - each scalar field's filter, all optional */
export type ScalarFilterSchema<T extends ModelState> = ObjectSchema<
  {
    [K in keyof T["scalars"]]: OptionalSchema<
      T["scalars"][K]["~"]["schemas"]["filter"],
      undefined
    >;
  },
  undefined
>;

/** Input type for scalar filter */
export type ScalarFilterInput<T extends ModelState> = InferInput<
  ScalarFilterSchema<T>
>;

export const getScalarFilter = <T extends ModelState>(state: T) => {
  const entries: SchemaEntries = {};
  forEachScalarField(state, (name, field) => {
    entries[name] = optional(field["~"].schemas.filter);
  });
  return object(entries) as ScalarFilterSchema<T>;
};

// =============================================================================
// UNIQUE FILTER
// =============================================================================

/** Unique filter schema - only id/unique fields with base schema */
export type UniqueFilterSchema<T extends ModelState> = ObjectSchema<
  {
    [K in keyof T["uniques"]]: OptionalSchema<
      T["uniques"][K]["~"]["schemas"]["base"],
      undefined
    >;
  },
  undefined
>;

/** Input type for unique filter */
export type UniqueFilterInput<T extends ModelState> = InferInput<
  UniqueFilterSchema<T>
>;

export const getUniqueFilter = <T extends ModelState>(state: T) => {
  const entries: SchemaEntries = {};
  forEachUniqueField(state, (name, unique) => {
    entries[name] = optional(unique["~"].schemas.base);
  });
  return object(entries) as UniqueFilterSchema<T>;
};

// =============================================================================
// RELATION FILTER
// =============================================================================

/** Relation filter schema - each relation's filter, all optional */
export type RelationFilterSchema<T extends ModelState> = ObjectSchema<
  {
    [K in keyof T["relations"]]: OptionalSchema<
      T["relations"][K]["~"]["schemas"]["filter"],
      undefined
    >;
  },
  undefined
>;

/** Input type for relation filter */
export type RelationFilterInput<T extends ModelState> = InferInput<
  RelationFilterSchema<T>
>;

export const getRelationFilter = <T extends ModelState>(
  state: T
): RelationFilterSchema<T> => {
  const entries: SchemaEntries = {};
  forEachRelation(state, (name, relation) => {
    entries[name] = optional(relation["~"].schemas.filter);
  });
  return object(entries) as RelationFilterSchema<T>;
};

// =============================================================================
// COMPOUND CONSTRAINT FILTER
// =============================================================================

/**
 * Helper type to build the inner object schema for a compound constraint's fields
 */
type CompoundFieldsSchema<Fields extends Record<string, Field>> = ObjectSchema<
  {
    [K in keyof Fields]: Fields[K]["~"]["schemas"]["base"];
  },
  undefined
>;

/**
 * Compound ID filter schema - maps compound key name to optional object of field base schemas
 */
export type CompoundIdFilterSchema<T extends ModelState> =
  T["compoundId"] extends Record<string, Record<string, Field>>
    ? ObjectSchema<
        {
          [K in keyof T["compoundId"]]: OptionalSchema<
            CompoundFieldsSchema<T["compoundId"][K]>,
            undefined
          >;
        },
        undefined
      >
    : ObjectSchema<{}, undefined>;

/**
 * Combined compound constraint filter schema
 */
export type CompoundConstraintFilterSchema<T extends ModelState> = ObjectSchema<
  (T["compoundId"] extends Record<string, Record<string, Field>>
    ? {
        [K in keyof T["compoundId"]]: OptionalSchema<
          CompoundFieldsSchema<T["compoundId"][K]>,
          undefined
        >;
      }
    : {}) &
    (T["compoundUniques"] extends Record<string, Record<string, Field>>
      ? {
          [K in keyof T["compoundUniques"]]: OptionalSchema<
            CompoundFieldsSchema<T["compoundUniques"][K]>,
            undefined
          >;
        }
      : {}),
  undefined
>;

/** Input type for compound constraint filter */
export type CompoundConstraintFilterInput<T extends ModelState> =
  (T["compoundId"] extends Record<string, Record<string, Field>>
    ? {
        [K in keyof T["compoundId"]]?: {
          [F in keyof T["compoundId"][K]]?: InferInput<
            T["compoundId"][K][F]["~"]["schemas"]["base"]
          >;
        };
      }
    : {}) &
    (T["compoundUniques"] extends Record<string, Record<string, Field>>
      ? {
          [K in keyof T["compoundUniques"]]?: {
            [F in keyof T["compoundUniques"][K]]?: InferInput<
              T["compoundUniques"][K][F]["~"]["schemas"]["base"]
            >;
          };
        }
      : {});

/**
 * Build compound constraint filter schema
 * Creates an object schema where each compound key maps to an optional object of field base schemas
 */
export const getCompoundConstraintFilter = <T extends ModelState>(
  state: T
): ObjectSchema<any, any> => {
  const entries: SchemaEntries = {};

  forEachCompoundConstraint(state, (keyName, fields) => {
    const fieldSchemas: SchemaEntries = {};
    for (const [fieldName, field] of Object.entries(fields)) {
      fieldSchemas[fieldName] = field["~"].schemas.base;
    }
    entries[keyName] = optional(object(fieldSchemas));
  });

  return object(entries) as CompoundConstraintFilterSchema<T>;
};

export const getCompoundIdFilter = <T extends ModelState>(
  state: T
): CompoundIdFilterSchema<T> => {
  const entries: SchemaEntries = {};
  forEachCompoundId(state, (keyName, fields) => {
    const fieldSchemas: SchemaEntries = {};
    for (const [fieldName, field] of Object.entries(fields)) {
      fieldSchemas[fieldName] = field["~"].schemas.base;
    }
    entries[keyName] = optional(object(fieldSchemas));
  });
  return object(entries) as CompoundIdFilterSchema<T>;
};
