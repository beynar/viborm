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
  type OptionalSchema,
  type InferInput,
  UnionSchema,
  ArraySchema,
} from "valibot";
import type { ModelState } from "../../model";
import type { Field } from "../../../fields/base";
import type { SchemaEntries } from "../types";
import {
  forEachScalarField,
  forEachRelation,
  forEachUniqueField,
} from "../utils";
import { getCompoundConstraintFilter } from "./filter";

// =============================================================================
// WHERE SCHEMA
// =============================================================================

/** Where schema - scalar + relation filters + AND/OR/NOT */

type BaseWhereSchema<T extends ModelState> = {
  [K in keyof T["scalars"]]: OptionalSchema<
    T["scalars"][K]["~"]["schemas"]["filter"],
    undefined
  >;
} & {
  [K in keyof T["relations"]]: OptionalSchema<
    T["relations"][K]["~"]["schemas"]["filter"],
    undefined
  >;
};

export type WhereSchema<T extends ModelState> = ObjectSchema<
  BaseWhereSchema<T>,
  undefined
>;

/** Input type for where */
export type WhereInput<T extends ModelState> = InferInput<WhereSchema<T>>;

/**
 * Build full where schema - scalar + relation filters + AND/OR/NOT
 */
export const getWhereSchema = <T extends ModelState>(state: T) => {
  // Use lazy for recursive AND/OR/NOT
  const whereSchema: BaseSchema<any, any, any> = lazy(() => {
    const scalarEntries: SchemaEntries = {};
    const relationEntries: SchemaEntries = {};

    forEachScalarField(state, (name, field) => {
      scalarEntries[name] = optional(field["~"].schemas.filter);
    });

    forEachRelation(state, (name, relation) => {
      relationEntries[name] = optional(relation["~"].schemas.filter);
    });

    return partial(
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
    );
  });

  return whereSchema as WhereSchema<T>;
};

// =============================================================================
// WHERE UNIQUE SCHEMA
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

/** WhereUnique schema - unique fields + compound constraints */
export type WhereUniqueSchema<T extends ModelState> = ObjectSchema<
  // Single-field uniques
  {
    [K in keyof T["uniques"]]: OptionalSchema<
      T["uniques"][K]["~"]["schemas"]["base"],
      undefined
    >;
  } & (T["compoundId"] extends Record<string, Record<string, Field>> // Compound ID
    ? {
        [K in keyof T["compoundId"]]: OptionalSchema<
          CompoundFieldsSchema<T["compoundId"][K]>,
          undefined
        >;
      }
    : {}) &
    // Compound uniques
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

/** Input type for whereUnique */
export type WhereUniqueInput<T extends ModelState> =
  // Single-field uniques
  {
    [K in keyof T["uniques"]]?: InferInput<
      T["uniques"][K]["~"]["schemas"]["base"]
    >;
  } & (T["compoundId"] extends Record<string, Record<string, Field>> // Compound ID
    ? {
        [K in keyof T["compoundId"]]?: {
          [F in keyof T["compoundId"][K]]: InferInput<
            T["compoundId"][K][F]["~"]["schemas"]["base"]
          >;
        };
      }
    : {}) &
    // Compound uniques
    (T["compoundUniques"] extends Record<string, Record<string, Field>>
      ? {
          [K in keyof T["compoundUniques"]]?: {
            [F in keyof T["compoundUniques"][K]]: InferInput<
              T["compoundUniques"][K][F]["~"]["schemas"]["base"]
            >;
          };
        }
      : {});

/**
 * Build whereUnique schema - unique fields + compound constraints
 * Combines single-field uniques with compound ID and compound uniques
 */
export const getWhereUniqueSchema = <T extends ModelState>(
  state: T
): WhereUniqueSchema<T> => {
  const entries: SchemaEntries = {};

  // Add single-field unique constraints
  forEachUniqueField(state, (name, field) => {
    entries[name] = optional(field["~"].schemas.base);
  });

  // Add compound constraints (ID + uniques) using the compound filter helpers
  const compoundConstraintFilter = getCompoundConstraintFilter(state);

  // Merge compound constraint entries into our entries
  const compoundEntries = compoundConstraintFilter.entries as SchemaEntries;
  for (const [key, schema] of Object.entries(compoundEntries)) {
    // Skip if already added (same key as single-field unique)
    if (!(key in entries)) {
      entries[key] = schema;
    }
  }

  return object(entries) as WhereUniqueSchema<T>;
};
